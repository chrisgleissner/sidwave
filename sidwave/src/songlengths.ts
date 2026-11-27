// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// HVSC Songlengths.md5 parser. Depends only on Node builtins and ./sidFile.js.
//
// Format: "[Database]" header, "; /PATH/File.sid" comment lines, then
// "<32 hex md5>=m:ss[.SSS][(attrs)] m:ss ..." with one duration per subtune.

import { createHash } from "node:crypto";
import { effectiveInitAddress, md5ForSonglengths, parseSidFile, songSpeed } from "./sidFile.js";

export interface SonglengthsOptions {
  maxBytes?: number;
}
export interface SonglengthsScanOptions extends SonglengthsOptions {
  /** Fill `SonglengthsRawEntry.path` (default true). Leaving it out saves the slice of every comment line. */
  withPaths?: boolean;
}
export type SonglengthsDb = Map<string, number[]>;

export class SonglengthsError extends Error {
  readonly code: "too_large" | "bad_line";
  constructor(code: "too_large" | "bad_line", message: string) {
    super(message);
    this.name = "SonglengthsError";
    this.code = code;
  }
}

export const DEFAULT_SONGLENGTHS_MAX_BYTES = 32 * 1024 * 1024;

/** Parses "m:ss", "m:ss.SSS" or "h:mm:ss[.SSS]" into milliseconds; a trailing "(attrs)" is ignored. */
export function parseDuration(token: string): number | undefined {
  const m = /^(?:(\d+):)?(\d+):(\d{1,2})(?:\.(\d{1,3}))?(?:\(.*\))?$/.exec(token);
  if (!m) return undefined;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const ms = m[4] === undefined ? 0 : Number(m[4].padEnd(3, "0"));
  return ((hours * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** One entry line of a Songlengths file, with the offsets that a format-preserving writer needs. */
export interface SonglengthsRawEntry {
  /** Lower-case 32 character MD5 key. */
  md5: string;
  /** Duration in ms per subtune; the (G)/(M)/(Z)/(B) attributes of the old format are dropped. */
  durations: number[];
  /** The path of the closest preceding "; /path" comment, or "" when there is none. */
  path: string;
  /** Start offset of the "; /path" line directly above the entry, or -1 when the entry has no such line. */
  commentStart: number;
  /** Start offset of the entry line (its key), and the offset of the first character after "=". */
  lineStart: number;
  valueStart: number;
  /** End offset of the entry line, without its line break. */
  lineEnd: number;
  /** 1-based line number. */
  line: number;
}

const isHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

/**
 * Parses one duration token `text.slice(start, end)` without allocating: the grammar of parseDuration, that is
 * [h:]m:ss[.S[S[S]]] followed by an optional "(attributes)". Returns -1 when the token is not a duration.
 */
function durationAt(text: string, start: number, end: number): number {
  let i = start;
  let a = 0;
  let digits = 0;
  while (i < end) { const c = text.charCodeAt(i); if (c < 48 || c > 57) break; a = a * 10 + (c - 48); digits++; i++; }
  if (digits === 0 || text.charCodeAt(i) !== 58) return -1;
  i++;
  let b = 0;
  let bDigits = 0;
  while (i < end) { const c = text.charCodeAt(i); if (c < 48 || c > 57) break; b = b * 10 + (c - 48); bDigits++; i++; }
  if (bDigits === 0) return -1;
  let hours = 0;
  let minutes = a;
  let seconds = b;
  if (text.charCodeAt(i) === 58) {
    hours = a;
    minutes = b;
    i++;
    seconds = 0;
    let sDigits = 0;
    while (i < end && sDigits < 3) { const c = text.charCodeAt(i); if (c < 48 || c > 57) break; seconds = seconds * 10 + (c - 48); sDigits++; i++; }
    if (sDigits === 0 || sDigits > 2) return -1;
  } else if (bDigits > 2) return -1;
  let ms = 0;
  if (i < end && text.charCodeAt(i) === 46) {
    i++;
    let n = 0;
    let scale = 100;
    while (i < end && n < 3) { const c = text.charCodeAt(i); if (c < 48 || c > 57) break; ms += (c - 48) * scale; scale /= 10; n++; i++; }
    if (n === 0) return -1;
  }
  // "(attributes)": any characters between the parentheses, as in the regular expression of parseDuration.
  if (i < end && (text.charCodeAt(i) !== 40 || end - i < 2 || text.charCodeAt(end - 1) !== 41)) return -1;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

function checkSize(text: string, maxBytes: number): void {
  if (text.length > maxBytes || (text.length * 3 > maxBytes && Buffer.byteLength(text) > maxBytes)) {
    throw new SonglengthsError("too_large", `Songlengths text exceeds ${maxBytes} bytes`);
  }
}

/**
 * Calls `onEntry` for every entry line, in file order. The same line grammar as parseSonglengths: "[...]" section
 * lines and other comments are skipped, a line is an entry when the text before its first "=" is 32 hex digits.
 */
export function scanSonglengths(text: string, onEntry: (entry: SonglengthsRawEntry) => void, options: SonglengthsScanOptions = {}): void {
  const withPaths = options.withPaths ?? true;
  checkSize(text, options.maxBytes ?? DEFAULT_SONGLENGTHS_MAX_BYTES);
  const length = text.length;
  let pos = 0;
  let lineNo = 0;
  let lastPath = "";
  let lastCommentStart = -1;
  let lastCommentLine = -1;
  while (pos < length) {
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = length;
    const lineStart = pos;
    const nextPos = eol + 1;
    lineNo++;
    let s = pos;
    let e = eol;
    while (s < e && text.charCodeAt(s) <= 32) s++;
    while (e > s && text.charCodeAt(e - 1) <= 32) e--;
    pos = nextPos;
    if (s === e) continue;
    const first = text.charCodeAt(s);
    if (first === 91) continue; // "[Database]"
    if (first === 59) {
      if (text.charCodeAt(s + 1) === 32 && text.charCodeAt(s + 2) === 47) {
        if (withPaths) lastPath = text.slice(s + 1, e).trim();
        lastCommentStart = lineStart;
        lastCommentLine = lineNo;
      }
      continue;
    }
    if (e - s < 33 || text.charCodeAt(s + 32) !== 61) continue;
    let upper = false;
    let valid = true;
    for (let k = s; k < s + 32; k++) {
      const c = text.charCodeAt(k);
      if (!isHex(c)) { valid = false; break; }
      if (c < 97 && c > 57) upper = true;
    }
    if (!valid) continue;
    const md5 = upper ? text.slice(s, s + 32).toLowerCase() : text.slice(s, s + 32);
    const durations: number[] = [];
    let i = s + 33;
    while (i < e) {
      while (i < e && text.charCodeAt(i) <= 32) i++;
      if (i >= e) break;
      let j = i;
      while (j < e && text.charCodeAt(j) > 32) j++;
      const ms = durationAt(text, i, j);
      if (ms < 0) throw new SonglengthsError("bad_line", `line ${lineNo}: bad duration ${JSON.stringify(text.slice(i, j))}`);
      durations.push(ms);
      i = j;
    }
    onEntry({
      md5, durations, path: lastPath, commentStart: lastCommentLine === lineNo - 1 ? lastCommentStart : -1,
      lineStart: s, valueStart: s + 33, lineEnd: e, line: lineNo,
    });
  }
}

function parseInternal(text: string, maxBytes: number, paths?: Map<string, string[]>): SonglengthsDb {
  const db: SonglengthsDb = new Map();
  scanSonglengths(text, (entry) => {
    // A duplicate MD5 keeps the first entry; every path that carries the MD5 is recorded.
    if (!db.has(entry.md5)) db.set(entry.md5, entry.durations);
    if (paths && entry.path) {
      const known = paths.get(entry.md5);
      if (known === undefined) paths.set(entry.md5, [entry.path]);
      else known.push(entry.path);
    }
  }, { maxBytes, withPaths: paths !== undefined });
  return db;
}

/** md5 -> duration in ms per subtune (index 0 = song 1). */
export function parseSonglengths(text: string, options: SonglengthsOptions = {}): SonglengthsDb {
  return parseInternal(text, options.maxBytes ?? DEFAULT_SONGLENGTHS_MAX_BYTES);
}

/** Like parseSonglengths, also returning md5 -> every "; /path" comment preceding an entry with that md5. */
export function parseSonglengthsWithPaths(
  text: string,
  options: SonglengthsOptions = {},
): { db: SonglengthsDb; paths: Map<string, string[]> } {
  const paths = new Map<string, string[]>();
  const db = parseInternal(text, options.maxBytes ?? DEFAULT_SONGLENGTHS_MAX_BYTES, paths);
  return { db, paths };
}

/** Duration in ms of a 1-based song, or undefined when the file or song is not in the database. */
export function lookupSonglength(db: SonglengthsDb, bytes: Uint8Array, song: number): number | undefined {
  if (!Number.isInteger(song) || song < 1) return undefined;
  return db.get(md5ForSonglengths(bytes))?.[song - 1];
}

/**
 * MD5 key of the old Songlengths.txt format (HVSC Songlengths.faq, "THE OLD FORMAT"; libsidplayfp PSID::createMD5):
 * the C64 data without its embedded load address, then init, play and the number of songs as 16 bit little-endian
 * words, one speed byte per song (0 for VBI, 60 for CIA) and the byte 2 when the clock flag says NTSC. The name,
 * author, released and flag fields do not take part, so editing them leaves this key unchanged.
 */
export function legacyMd5ForSonglengths(bytes: Uint8Array): string {
  const file = parseSidFile(bytes);
  const hash = createHash("md5");
  hash.update(file.payload);
  hash.update(Uint8Array.of(effectiveInitAddress(file) & 0xff, effectiveInitAddress(file) >> 8, file.playAddress & 0xff, file.playAddress >> 8, file.songs & 0xff, file.songs >> 8));
  const speeds = new Uint8Array(file.songs);
  for (let song = 1; song <= file.songs; song++) speeds[song - 1] = songSpeed(file, song) === "CIA" ? 60 : 0;
  hash.update(speeds);
  if (file.clock === "NTSC") hash.update(Uint8Array.of(2));
  return hash.digest("hex");
}
