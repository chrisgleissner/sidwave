// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// HVSC STIL (SID Tune Information List) parser and lookup. Format: HVSC DOCUMENTS/STIL.faq, section 4.
//
// A STIL file is Latin-1 text. An entry starts with a line that holds an HVSC path ("/MUSICIANS/X/Y.sid"). Its fields
// are NAME, AUTHOR, TITLE, ARTIST and COMMENT lines (the label right-aligned in 7 columns, then ": "), and a field
// continues on the following lines that are indented. A tune with several subtunes marks the subtune blocks with
// "(#n)" lines; fields before the first marker apply to the whole file. Lines that start with "#" are comments.
// Depends only on ./hvsc.js.

import { HvscError } from "./hvsc.js";

export type StilFieldKind = "NAME" | "AUTHOR" | "TITLE" | "ARTIST" | "COMMENT";

export interface StilField {
  kind: StilFieldKind;
  /** The field text; the lines of a field that continues over several lines are joined with "\n". */
  text: string;
  /** TITLE only: the album of a "[from Album]" suffix. */
  album?: string;
  /** TITLE only: the playing time of a "(m:ss-m:ss)" suffix. */
  timestamp?: string;
}

export interface StilBlock {
  /** 1-based subtune, or null for the fields that apply to the whole file. */
  subtune: number | null;
  fields: StilField[];
}

export interface StilEntry {
  /** HVSC path, for example "/MUSICIANS/H/Hubbard_Rob/Commando.sid". */
  path: string;
  /** 1-based line of the path line. */
  line: number;
  blocks: StilBlock[];
}

export interface StilDb {
  /** "83" from the header line "STIL v83 - ...", when there is one. */
  version?: string;
  entries: Map<string, StilEntry>;
  /** Lines the parser did not understand (at most 100). */
  warnings: string[];
}

export interface StilParseOptions {
  /** Largest text accepted, in characters (default 32 million). */
  maxChars?: number;
}

export const DEFAULT_STIL_MAX_CHARS = 32 * 1024 * 1024;
const FIELD_KINDS: Record<string, StilFieldKind> = { NAME: "NAME", AUTHOR: "AUTHOR", TITLE: "TITLE", ARTIST: "ARTIST", COMMENT: "COMMENT" };
const TIMESTAMP = /\s\((\d+:\d{2}(?:-\d+:\d{2})?(?:,\s*\d+:\d{2}(?:-\d+:\d{2})?)*)\)\s*$/;
const MAX_WARNINGS = 100;
const MAX_SUBTUNE = 256;

function titleParts(field: StilField): void {
  let text = field.text;
  const stamp = TIMESTAMP.exec(text);
  if (stamp) { field.timestamp = stamp[1]!; text = text.slice(0, stamp.index); }
  const from = text.lastIndexOf("[from ");
  if (from >= 0 && text.trimEnd().endsWith("]")) field.album = text.slice(from + 6, text.trimEnd().length - 1);
}

/** Parses STIL.txt. Never throws for malformed lines; those are listed in `warnings`. */
export function parseStil(text: string, options: StilParseOptions = {}): StilDb {
  const maxChars = options.maxChars ?? DEFAULT_STIL_MAX_CHARS;
  if (text.length > maxChars) throw new HvscError("too_large", `STIL text is ${text.length} characters, over the limit of ${maxChars}`);
  const db: StilDb = { entries: new Map(), warnings: [] };
  const warn = (line: number, message: string): void => { if (db.warnings.length < MAX_WARNINGS) db.warnings.push(`line ${line}: ${message}`); };
  const length = text.length;
  let pos = 0;
  let lineNo = 0;
  let entry: StilEntry | undefined;
  let block: StilBlock | undefined;
  let field: StilField | undefined;
  while (pos < length) {
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = length;
    let end = eol;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    const start = pos;
    pos = eol + 1;
    lineNo++;
    if (end === start) { field = undefined; continue; }
    const first = text.charCodeAt(start);
    if (first === 35) { // "#"
      if (db.version === undefined && lineNo < 20) {
        const version = /STIL v(\d+)/.exec(text.slice(start, end));
        if (version) db.version = version[1]!;
      }
      field = undefined;
      continue;
    }
    if (first === 47) { // "/"
      const path = text.slice(start, end).trimEnd();
      entry = { path, line: lineNo, blocks: [] };
      block = undefined;
      field = undefined;
      if (db.entries.has(path)) warn(lineNo, `duplicate entry ${path}; the first one is kept`);
      else db.entries.set(path, entry);
      continue;
    }
    if (entry === undefined) { warn(lineNo, "text before the first entry"); continue; }
    if (first === 40 && text.charCodeAt(start + 1) === 35) { // "(#"
      const close = text.indexOf(")", start);
      const number = close > 0 && close < end ? Number(text.slice(start + 2, close)) : NaN;
      if (!Number.isInteger(number) || number < 1 || number > MAX_SUBTUNE) { warn(lineNo, `bad subtune marker ${JSON.stringify(text.slice(start, end))}`); continue; }
      block = { subtune: number, fields: [] };
      entry.blocks.push(block);
      field = undefined;
      continue;
    }
    // A field line has the label within the first 8 characters, then a colon.
    let colon = -1;
    for (let i = start; i < end && i < start + 9; i++) if (text.charCodeAt(i) === 58) { colon = i; break; }
    if (colon > 0) {
      const kind = FIELD_KINDS[text.slice(start, colon).trim()];
      if (kind !== undefined) {
        if (block === undefined) { block = { subtune: null, fields: [] }; entry.blocks.push(block); }
        field = { kind, text: text.slice(colon + 1, end).trim() };
        block.fields.push(field);
        continue;
      }
    }
    if (field !== undefined && (first === 32 || first === 9)) {
      field.text += `\n${text.slice(start, end).trim()}`;
      continue;
    }
    warn(lineNo, `unrecognised line ${JSON.stringify(text.slice(start, Math.min(end, start + 40)))}`);
  }
  for (const found of db.entries.values()) {
    for (const b of found.blocks) for (const f of b.fields) if (f.kind === "TITLE") titleParts(f);
  }
  return db;
}

const lowerIndex = new WeakMap<StilDb, Map<string, StilEntry>>();

/** The entry of an HVSC path. The path is matched exactly first, then without regard to case. */
export function findStilEntry(db: StilDb, hvscPath: string): StilEntry | undefined {
  const wanted = hvscPath.startsWith("/") ? hvscPath : `/${hvscPath}`;
  const exact = db.entries.get(wanted);
  if (exact !== undefined) return exact;
  let index = lowerIndex.get(db);
  if (index === undefined) {
    index = new Map();
    for (const [path, found] of db.entries) { const key = path.toLowerCase(); if (!index.has(key)) index.set(key, found); }
    lowerIndex.set(db, index);
  }
  return index.get(wanted.toLowerCase());
}

export interface StilQueryResult {
  path: string;
  found: boolean;
  /** Fields that apply to the whole file. */
  global: StilField[];
  /** The subtune blocks, or only the requested one. */
  subtunes: Array<{ subtune: number; fields: StilField[] }>;
}

/** The entry of an HVSC path, split into the whole-file fields and the fields per subtune; `subtune` selects one. */
export function queryStil(db: StilDb, hvscPath: string, subtune?: number): StilQueryResult {
  const entry = findStilEntry(db, hvscPath);
  const result: StilQueryResult = { path: entry?.path ?? (hvscPath.startsWith("/") ? hvscPath : `/${hvscPath}`), found: entry !== undefined, global: [], subtunes: [] };
  if (entry === undefined) return result;
  for (const block of entry.blocks) {
    if (block.subtune === null) result.global.push(...block.fields);
    else if (subtune === undefined || block.subtune === subtune) result.subtunes.push({ subtune: block.subtune, fields: block.fields });
  }
  return result;
}

/** A readable listing of a query result, for the command line. */
export function formatStilQuery(result: StilQueryResult): string {
  const lines = [result.path];
  const show = (indent: string, fields: StilField[]): void => {
    for (const f of fields) lines.push(`${indent}${f.kind.padStart(7)}: ${f.text.split("\n").join(`\n${indent}         `)}`);
  };
  show("  ", result.global);
  for (const s of result.subtunes) { lines.push(`  (#${s.subtune})`); show("    ", s.fields); }
  if (result.global.length === 0 && result.subtunes.length === 0) lines.push("  (no fields)");
  return lines.join("\n");
}

/** Longest STIL entry copied into a manifest, in characters. */
export const STIL_MAX_CHARS = 16_384;

/** The STIL block of an HVSC path: the lines from the path line to the next path line. */
export function lookupStil(stilText: string, hvscPath: string): { path: string; text: string } | undefined {
  const wanted = hvscPath.startsWith("/") ? hvscPath : `/${hvscPath}`;
  const lines = stilText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === wanted);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("/") ) end++;
  const text = lines.slice(start + 1, end).join("\n").trim();
  return { path: wanted, text: text.length > STIL_MAX_CHARS ? `${text.slice(0, STIL_MAX_CHARS)}\n[truncated at ${STIL_MAX_CHARS} characters]` : text };
}
