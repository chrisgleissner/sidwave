// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// HVSC Songlengths.md5 parser. Depends only on Node builtins and ./sidFile.js.
//
// Format: "[Database]" header, "; /PATH/File.sid" comment lines, then
// "<32 hex md5>=m:ss[.SSS][(attrs)] m:ss ..." with one duration per subtune.

import { md5ForSonglengths } from "./sidFile.js";

export interface SonglengthsOptions {
  maxBytes?: number;
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

function parseInternal(text: string, maxBytes: number, paths?: Map<string, string[]>): SonglengthsDb {
  if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
    throw new SonglengthsError("too_large", `Songlengths text exceeds ${maxBytes} bytes`);
  }
  const db: SonglengthsDb = new Map();
  let lastPath = "";
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (line === "" || line.startsWith("[")) continue;
    if (line.startsWith(";")) {
      if (line.startsWith("; /")) lastPath = line.slice(1).trim();
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq < 0 ? "" : line.slice(0, eq).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(key)) continue; // other key=value settings in the file are not entries
    const durations: number[] = [];
    for (const token of line.slice(eq + 1).split(/\s+/).filter(Boolean)) {
      const d = parseDuration(token);
      if (d === undefined) throw new SonglengthsError("bad_line", `line ${lineNo}: bad duration ${JSON.stringify(token)}`);
      durations.push(d);
    }
    // A duplicate MD5 keeps the first entry; every path that carries the MD5 is recorded.
    if (!db.has(key)) db.set(key, durations);
    if (paths && lastPath) {
      const known = paths.get(key);
      if (known === undefined) paths.set(key, [lastPath]);
      else known.push(lastPath);
    }
  }
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
