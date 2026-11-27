// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Operations on Songlengths files as text: lookup, verification against an HVSC tree, and a writer that edits the
// lines it changes and leaves every other byte of the file alone (comments, "; /path" lines, attributes, line
// breaks). Both formats are handled: Songlengths.md5 (key = MD5 of the whole file, durations with optional
// milliseconds) and the old Songlengths.txt (key = MD5 of the data and some header fields, whole seconds, optional
// (G)/(M)/(Z)/(B) attributes). See the HVSC Songlengths.faq.

import { existsSync } from "node:fs";
import { HvscError, DEFAULT_DATABASE_MAX_BYTES, fileOfHvscPath, isSidName, readBounded, walkSidFiles, hvscPathOf } from "./hvsc.js";
import { md5ForSonglengths } from "./sidFile.js";
import { legacyMd5ForSonglengths, parseDuration, scanSonglengths, type SonglengthsRawEntry } from "./songlengths.js";

export type SonglengthsFormat = "md5" | "txt";

/** Compares paths in HVSC order: case-insensitive first, then by original UTF-16 code units. */
export function hvscPathCompare(a: string, b: string): number {
  const compare = (left: string, right: string): number => {
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) if (left.charCodeAt(i) !== right.charCodeAt(i)) return left.charCodeAt(i)! < right.charCodeAt(i)! ? -1 : 1;
    return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
  };
  return compare(a.toUpperCase(), b.toUpperCase()) || compare(a, b);
}

/** The old format for a file named *.txt, else the new one. */
export function songlengthsFormatOf(path: string): SonglengthsFormat {
  return /\.txt$/i.test(path) ? "txt" : "md5";
}

/** The key of a SID file in a database of the given format. */
export function songlengthsKey(bytes: Uint8Array, format: SonglengthsFormat): string {
  return format === "txt" ? legacyMd5ForSonglengths(bytes) : md5ForSonglengths(bytes);
}

/** "m:ss" or, in the new format with a fraction, "m:ss.S", "m:ss.SS" or "m:ss.SSS" without trailing zeros. */
export function formatSonglength(ms: number, format: SonglengthsFormat = "md5"): string {
  if (!Number.isFinite(ms) || ms < 0) throw new HvscError("bad_value", `a song length must be zero or more milliseconds, not ${ms}`);
  const total = format === "txt" ? Math.round(ms / 1000) * 1000 : Math.round(ms);
  const seconds = Math.floor(total / 1000);
  const fraction = total % 1000;
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return fraction === 0 ? text : `${text}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
}

/**
 * Parses a list of song lengths separated by commas or spaces. Each is m:ss, m:ss.SSS, h:mm:ss or a number of
 * seconds ("237" or "237.5"). Returns milliseconds.
 */
export function parseSonglengthList(text: string): number[] {
  const tokens = text.split(/[\s,]+/).filter((token) => token !== "");
  if (tokens.length === 0) throw new HvscError("bad_value", "no song lengths given; pass one time per subtune, for example --times 3:57,1:02.5");
  if (tokens.length > 256) throw new HvscError("bad_value", `${tokens.length} song lengths given; a SID file has at most 256 subtunes`);
  return tokens.map((token) => {
    const ms = /^\d+(?:\.\d{1,3})?$/.test(token) ? Math.round(Number(token) * 1000) : parseDuration(token);
    if (ms === undefined) throw new HvscError("bad_value", `"${token}" is not a song length; use m:ss, m:ss.SSS or a number of seconds`);
    return ms;
  });
}

export interface SonglengthsLookupEntry {
  md5: string;
  path: string;
  line: number;
  /** Duration in ms per subtune. */
  durations: number[];
}

/** Every entry of the text with the given key (an MD5 can be listed for several paths). */
export function lookupSonglengthEntries(text: string, md5: string, maxBytes?: number): SonglengthsLookupEntry[] {
  const wanted = md5.toLowerCase();
  const found: SonglengthsLookupEntry[] = [];
  scanSonglengths(text, (entry) => {
    if (entry.md5 === wanted) found.push({ md5: entry.md5, path: entry.path, line: entry.line, durations: entry.durations });
  }, maxBytes === undefined ? {} : { maxBytes });
  return found;
}

// ---- verification -------------------------------------------------------------------------------------------------

export interface SonglengthsVerifyOptions {
  format?: SonglengthsFormat;
  /** Largest SID file read (default 66,000 bytes). */
  maxFileBytes?: number;
  /** Also list the SID files below the root that have no entry. */
  unlisted?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface SonglengthsVerifyReport {
  format: SonglengthsFormat;
  entries: number;
  /** Entries whose file exists and has the listed key. */
  ok: number;
  /** Entries without a "; /path" line above them. */
  noPath: Array<{ md5: string; line: number }>;
  missing: Array<{ path: string; md5: string; line: number }>;
  /** The file exists, but its key differs. `listedAs` is the path of another entry with the file's key, when there is one. */
  wrongMd5: Array<{ path: string; line: number; expected: string; actual: string; listedAs?: string }>;
  /** The file exists but cannot be read or parsed (old format only needs a valid header). */
  unreadable: Array<{ path: string; line: number; reason: string }>;
  /** The number of durations differs from the number of songs of the file. */
  subtuneMismatch: Array<{ path: string; line: number; songs: number; durations: number }>;
  unlistedFiles?: string[];
}

/** Checks every entry of a Songlengths text against the files below the HVSC root `root`. */
export function verifySonglengths(text: string, root: string, options: SonglengthsVerifyOptions = {}): SonglengthsVerifyReport {
  const format = options.format ?? "md5";
  const maxFileBytes = options.maxFileBytes ?? 0x10000 + 0x7c + 2;
  const entries: SonglengthsRawEntry[] = [];
  scanSonglengths(text, (entry) => { entries.push(entry); });
  const report: SonglengthsVerifyReport = {
    format, entries: entries.length, ok: 0, noPath: [], missing: [], wrongMd5: [], unreadable: [], subtuneMismatch: [],
  };
  const listed = new Set<string>();
  const pathOfKey = new Map<string, string>();
  for (const entry of entries) if (entry.path !== "" && !pathOfKey.has(entry.md5)) pathOfKey.set(entry.md5, entry.path);
  let done = 0;
  for (const entry of entries) {
    done++;
    if (options.onProgress && done % 2000 === 0) options.onProgress(done, entries.length);
    // An entry belongs to the path of the comment line directly above it; with another line between, it has no path.
    if (entry.path === "" || entry.commentStart < 0) { report.noPath.push({ md5: entry.md5, line: entry.line }); continue; }
    listed.add(entry.path);
    const file = fileOfHvscPath(root, entry.path);
    if (!existsSync(file)) { report.missing.push({ path: entry.path, md5: entry.md5, line: entry.line }); continue; }
    let bytes: Uint8Array;
    try { bytes = readBounded(file, maxFileBytes, entry.path); } catch (error) {
      report.unreadable.push({ path: entry.path, line: entry.line, reason: (error as Error).message });
      continue;
    }
    let actual: string;
    try { actual = songlengthsKey(bytes, format); } catch (error) {
      report.unreadable.push({ path: entry.path, line: entry.line, reason: (error as Error).message });
      continue;
    }
    if (actual !== entry.md5) {
      const listedAs = pathOfKey.get(actual);
      report.wrongMd5.push({ path: entry.path, line: entry.line, expected: entry.md5, actual, ...(listedAs === undefined ? {} : { listedAs }) });
      continue;
    }
    const songs = bytes.length >= 16 ? (bytes[14]! << 8) | bytes[15]! : 0;
    if (songs !== entry.durations.length) report.subtuneMismatch.push({ path: entry.path, line: entry.line, songs, durations: entry.durations.length });
    else report.ok++;
  }
  if (options.unlisted) {
    report.unlistedFiles = [];
    for (const file of walkSidFiles(root)) {
      const path = hvscPathOf(root, file);
      if (path !== undefined && !listed.has(path) && isSidName(path) && /^\/(DEMOS|GAMES|MUSICIANS)\//.test(path)) report.unlistedFiles.push(path);
    }
  }
  return report;
}

// ---- writer -------------------------------------------------------------------------------------------------------

export interface SonglengthsWrite {
  /** Key of the file in this database's format. */
  md5: string;
  /** Durations in ms, one per subtune. Optional with `fromMd5`, which keeps the existing durations. */
  durations?: number[];
  /** HVSC path ("/MUSICIANS/X/Y.sid") for a new entry or to find a stale entry of the same file. */
  path?: string;
  /** Key the entry had before the file was edited; the entry is re-keyed and keeps its durations unless `durations` is given. */
  fromMd5?: string;
}

export interface SonglengthsWriteResult {
  text: string;
  action: "updated" | "rekeyed" | "added" | "unchanged";
  /** The lines before and after, for a diff. `before` is empty for an added entry. */
  changes: Array<{ line: number; before: string; after: string; path: string }>;
}

function eolOf(text: string): string {
  const index = text.indexOf("\n");
  return index > 0 && text.charCodeAt(index - 1) === 13 ? "\r\n" : "\n";
}

const MD5_PATTERN = /^[0-9a-f]{32}$/;

function valueOf(durations: readonly number[], format: SonglengthsFormat, oldValue?: string): string {
  const oldTokens = oldValue === undefined ? [] : oldValue.split(/\s+/).filter((token) => token !== "");
  return durations.map((ms, index) => {
    const old = oldTokens[index];
    const attributes = format === "txt" && old !== undefined && old.indexOf("(") >= 0 ? old.slice(old.indexOf("(")) : "";
    return formatSonglength(ms, format) + attributes;
  }).join(" ");
}

/**
 * Adds or updates one entry and returns the new text. Only the changed or added lines differ from the input; the
 * line break style, comments and all other entries are kept byte for byte. An entry for an MD5 that is already
 * listed gets new durations in place (every path that lists it). An entry that has `fromMd5`, or the same path
 * with another key, is re-keyed in place. Otherwise a "; /path" line and an entry line are inserted in path
 * order (or at the end when no later path exists).
 */
export function writeSonglengthsEntry(text: string, write: SonglengthsWrite, format: SonglengthsFormat = "md5", maxBytes: number = DEFAULT_DATABASE_MAX_BYTES): SonglengthsWriteResult {
  const md5 = write.md5.toLowerCase();
  if (!MD5_PATTERN.test(md5)) throw new HvscError("bad_value", `${write.md5} is not a 32 digit MD5`);
  if (write.durations !== undefined && (write.durations.length === 0 || write.durations.length > 256)) throw new HvscError("bad_value", "a Songlengths entry holds 1 to 256 durations");
  const fromMd5 = write.fromMd5?.toLowerCase();
  if (fromMd5 !== undefined && !MD5_PATTERN.test(fromMd5)) throw new HvscError("bad_value", `${write.fromMd5} is not a 32 digit MD5`);
  const entries: SonglengthsRawEntry[] = [];
  scanSonglengths(text, (entry) => { entries.push(entry); }, { maxBytes });

  const edits: Array<{ start: number; end: number; replacement: string; entry?: SonglengthsRawEntry }> = [];
  let action: SonglengthsWriteResult["action"];
  const existing = entries.filter((entry) => entry.md5 === md5);
  const oldValue = (entry: SonglengthsRawEntry): string => text.slice(entry.valueStart, entry.lineEnd);
  if (existing.length > 0) {
    if (write.durations === undefined) throw new HvscError("usage", "this MD5 is already listed; give --times to change its song lengths");
    action = "updated";
    for (const entry of existing) edits.push({ start: entry.valueStart, end: entry.lineEnd, replacement: valueOf(write.durations, format, oldValue(entry)), entry });
  } else {
    const stale = (fromMd5 !== undefined ? entries.filter((entry) => entry.md5 === fromMd5) : [])
      .concat(fromMd5 === undefined && write.path !== undefined ? entries.filter((entry) => entry.path === write.path) : []);
    if (fromMd5 !== undefined && stale.length === 0) throw new HvscError("not_found", `no entry with the MD5 ${fromMd5} to carry over; check the value, or give --path and --times to add the entry`);
    if (stale.length > 0) {
      action = "rekeyed";
      for (const entry of stale) {
        const value = write.durations === undefined ? oldValue(entry) : valueOf(write.durations, format, oldValue(entry));
        edits.push({ start: entry.lineStart, end: entry.lineEnd, replacement: `${md5}=${value}`, entry });
      }
    } else {
      if (write.path === undefined) throw new HvscError("usage", "this MD5 is not listed; give the HVSC path of the file (--path /MUSICIANS/X/Y.sid, or --hvsc with a file below it) to add an entry");
      if (write.durations === undefined) throw new HvscError("usage", "a new entry needs its song lengths; give --times with one time per subtune");
      if (!/^\/[^\r\n]+$/.test(write.path)) throw new HvscError("bad_value", `the HVSC path ${write.path} must start with "/"`);
      action = "added";
      const eol = eolOf(text);
      const next = entries.find((entry) => entry.path !== "" && hvscPathCompare(entry.path, write.path!) > 0);
      const block = `; ${write.path}${eol}${md5}=${valueOf(write.durations, format)}${eol}`;
      if (next !== undefined) {
        const at = next.commentStart >= 0 ? next.commentStart : next.lineStart;
        edits.push({ start: at, end: at, replacement: block });
      } else {
        const at = text.length;
        edits.push({ start: at, end: at, replacement: (text.length > 0 && !text.endsWith("\n") ? eol : "") + block });
      }
    }
  }

  const changes: SonglengthsWriteResult["changes"] = [];
  let out = "";
  let cursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
    if (edit.entry) {
      const before = text.slice(edit.entry.lineStart, edit.entry.lineEnd);
      const after = edit.start === edit.entry.lineStart ? edit.replacement : `${text.slice(edit.entry.lineStart, edit.entry.valueStart)}${edit.replacement}`;
      changes.push({ line: edit.entry.line, before, after, path: edit.entry.path });
    } else changes.push({ line: 0, before: "", after: edit.replacement.replace(/\r?\n$/, ""), path: write.path ?? "" });
  }
  out += text.slice(cursor);
  if (out === text) action = "unchanged";
  return { text: out, action, changes };
}

/** The text of a Songlengths file given its path (bounded). */
export function readSonglengthsText(path: string, maxBytes = DEFAULT_DATABASE_MAX_BYTES): string {
  const bytes = readBounded(path, maxBytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}
