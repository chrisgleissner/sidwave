// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Player and editor identification with SIDId-style signatures. A signature file (sidid.cfg) is read at run time from
// a path the user gives; sidwave does not contain or ship one. The format is the one of SIDId by Cadaver:
//
//   PlayerName
//   A9 00 8D ?? ?? 4C END
//   A9 1F 8D 18 D4 AND 8D 04 D4 END
//
// A player has a name line and one or more signatures. A signature is a list of hexadecimal bytes, "??" for any
// byte, and "AND" (or "&&" in the newer file format) between fragments: the fragments must all be found, in order,
// each after the end of the one before it, with any number of bytes between them. "END" ends a signature; in the
// newer file format a signature is a line and "END" may be left out.
//
// The match runs over the C64 data of the tune (the part after the header and the load address), so a byte pattern
// cannot match inside the header. SIDId itself scans the whole file.

import { HvscError, latin1 } from "./hvsc.js";
import { parseSidFile } from "./sidFile.js";

export interface SidIdSignature {
  /** Fragments of bytes 0-255, with -1 for "??". */
  fragments: Int16Array[];
  /** Number of bytes that are not wildcards. */
  fixedBytes: number;
}

export interface SidIdPlayer {
  name: string;
  signatures: SidIdSignature[];
}

export interface SidIdDb {
  players: SidIdPlayer[];
  signatures: number;
}

export interface SidIdInfo {
  player: string;
  name?: string;
  author?: string;
  released?: string;
  comment?: string;
  reference?: string;
}

export type SidIdConfidence = "high" | "medium" | "low";

export interface SidIdMatch {
  /** Player name as written in the signature file (no spaces, may have a "Group/" prefix). */
  player: string;
  /** Offset of the first fragment in the C64 data, and the C64 address it has when loaded. */
  offset: number;
  address: number;
  /** Bytes that must match (wildcards not counted) in the signature that matched, and its fragment count. */
  fixedBytes: number;
  fragments: number;
  /** Number of the player's signatures that match. */
  signaturesMatched: number;
  confidence: SidIdConfidence;
  /** Details from the sidid.nfo of the signature file, when one was read. */
  info?: SidIdInfo;
}

export const DEFAULT_SIDID_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;

const isHexByte = (token: string): boolean => /^[0-9a-fA-F]{2}$/.test(token);

/** Parses sidid.cfg text. Lines that are not understood are skipped, as SIDId does. */
export function parseSidIdConfig(text: string, options: { maxBytes?: number } = {}): SidIdDb {
  const maxBytes = options.maxBytes ?? DEFAULT_SIDID_MAX_BYTES;
  if (text.length > maxBytes) throw new HvscError("too_large", `the SIDId signature file is ${text.length} bytes, over the limit of ${maxBytes}`);
  const db: SidIdDb = { players: [], signatures: 0 };
  let player: SidIdPlayer | undefined;
  let fragments: number[][] = [];
  let current: number[] = [];
  const finishFragment = (): void => { if (current.length > 0) { fragments.push(current); current = []; } };
  const finishSignature = (): void => {
    finishFragment();
    if (player !== undefined && fragments.length > 0) {
      const fixedBytes = fragments.reduce((sum, f) => sum + f.filter((b) => b >= 0).length, 0);
      if (fixedBytes > 0 && fragments.every((f) => f.some((b) => b >= 0))) {
        player.signatures.push({ fragments: fragments.map((f) => Int16Array.from(f)), fixedBytes });
        db.signatures++;
      }
    }
    fragments = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.split(/\s+/).filter((t) => t !== "");
    if (tokens.length === 0) { finishSignature(); continue; }
    const isSignatureToken = (t: string): boolean => isHexByte(t) || t === "??" || /^(?:end|and|&&)$/i.test(t);
    if (tokens.length === 1 && !isSignatureToken(tokens[0]!)) {
      finishSignature();
      player = { name: tokens[0]!, signatures: [] };
      db.players.push(player);
      continue;
    }
    for (const token of tokens) {
      if (isHexByte(token)) current.push(Number.parseInt(token, 16));
      else if (token === "??") current.push(-1);
      else if (/^(?:and|&&)$/i.test(token)) finishFragment();
      else if (/^end$/i.test(token)) finishSignature();
      // Any other token inside a signature line is ignored.
      if (current.length > MAX_SIGNATURE_BYTES) throw new HvscError("bad_format", `a signature of player ${player?.name ?? "?"} is longer than ${MAX_SIGNATURE_BYTES} bytes`);
    }
    finishSignature(); // the newer file format has no END
  }
  finishSignature();
  return db;
}

/** Parses sidid.nfo: a player name at the line start, then indented "LABEL: value" lines with indented continuations. */
export function parseSidIdInfo(text: string, options: { maxBytes?: number } = {}): Map<string, SidIdInfo> {
  const maxBytes = options.maxBytes ?? DEFAULT_SIDID_MAX_BYTES;
  if (text.length > maxBytes) throw new HvscError("too_large", `the SIDId info file is ${text.length} bytes, over the limit of ${maxBytes}`);
  const infos = new Map<string, SidIdInfo>();
  let info: SidIdInfo | undefined;
  let key: keyof SidIdInfo | undefined;
  const labels: Record<string, keyof SidIdInfo> = { NAME: "name", AUTHOR: "author", RELEASED: "released", COMMENT: "comment", REFERENCE: "reference" };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") { key = undefined; continue; }
    if (!/^\s/.test(line)) { info = { player: line.trim() }; infos.set(info.player, info); key = undefined; continue; }
    if (info === undefined) continue;
    const field = /^\s*([A-Z]+):\s?(.*)$/.exec(line);
    const label = field ? labels[field[1]!] : undefined;
    if (field && label !== undefined) { key = label; (info as unknown as Record<string, string>)[label] = field[2]!.trim(); }
    else if (key !== undefined) (info as unknown as Record<string, string>)[key] += `\n${line.trim()}`;
  }
  return infos;
}

const COMMON_BYTES = new Set([0x00, 0x18, 0x20, 0x4c, 0x60, 0x85, 0x88, 0x8d, 0x99, 0x9d, 0xa0, 0xa2, 0xa5, 0xa9, 0xad, 0xb9, 0xbd, 0xc8, 0xc9, 0xca, 0xd0, 0xe8, 0xf0, 0xff]);

/** Offset of the first place `fragment` matches in `data` at or after `from`, or -1. */
function findFragment(data: Uint8Array, fragment: Int16Array, from: number): number {
  const length = fragment.length;
  // The search runs on one byte of the fragment; a byte that is rare in 6502 code gives fewer candidate positions.
  let anchor = -1;
  for (let i = 0; i < length; i++) {
    const b = fragment[i]!;
    if (b < 0) continue;
    if (anchor < 0) anchor = i;
    if (!COMMON_BYTES.has(b)) { anchor = i; break; }
  }
  const anchorByte = fragment[anchor]!;
  const last = data.length - length;
  let at = from + anchor;
  for (;;) {
    at = data.indexOf(anchorByte, at);
    if (at < 0) return -1;
    const start = at - anchor;
    if (start > last) return -1;
    let ok = true;
    for (let i = 0; i < length; i++) {
      const want = fragment[i]!;
      if (want >= 0 && data[start + i] !== want) { ok = false; break; }
    }
    if (ok) return start;
    at++;
  }
}

/** The offset where a signature matches in `data`, or -1. */
export function matchSignature(data: Uint8Array, signature: SidIdSignature): number {
  let from = 0;
  let first = -1;
  for (const fragment of signature.fragments) {
    const at = findFragment(data, fragment, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    from = at + fragment.length;
  }
  return first;
}

function confidenceOf(fixedBytes: number, signaturesMatched: number): SidIdConfidence {
  const level = fixedBytes >= 14 ? 2 : fixedBytes >= 8 ? 1 : 0;
  const bumped = Math.min(2, level + (signaturesMatched >= 2 ? 1 : 0));
  return bumped === 2 ? "high" : bumped === 1 ? "medium" : "low";
}

export interface IdentifyOptions {
  /** Report every player that matches (SIDId's multi-scan), not only the first in file order. */
  all?: boolean;
  /** Load address of `data`, for the address of a match. */
  loadAddress?: number;
  info?: Map<string, SidIdInfo>;
}

/**
 * Players whose signature matches `data` (the C64 data of a tune), in the order of the signature file. The first is the
 * answer SIDId gives; later ones (with `all`) are other routines found in the same tune, such as a sample player.
 */
export function identifyPlayerInData(data: Uint8Array, db: SidIdDb, options: IdentifyOptions = {}): SidIdMatch[] {
  const matches: SidIdMatch[] = [];
  for (const player of db.players) {
    let best: { offset: number; signature: SidIdSignature } | undefined;
    let matched = 0;
    for (const signature of player.signatures) {
      const offset = matchSignature(data, signature);
      if (offset < 0) continue;
      matched++;
      if (best === undefined || signature.fixedBytes > best.signature.fixedBytes) best = { offset, signature };
    }
    if (best === undefined) continue;
    const info = options.info?.get(player.name);
    matches.push({
      player: player.name, offset: best.offset, address: (options.loadAddress ?? 0) + best.offset,
      fixedBytes: best.signature.fixedBytes, fragments: best.signature.fragments.length, signaturesMatched: matched,
      confidence: confidenceOf(best.signature.fixedBytes, matched), ...(info === undefined ? {} : { info }),
    });
    if (!options.all) break;
  }
  return matches;
}

/** Identifies the player of a SID file given its bytes. Throws SidFileError when the bytes are not a SID file. */
export function identifySidPlayer(bytes: Uint8Array, db: SidIdDb, options: IdentifyOptions = {}): SidIdMatch[] {
  const file = parseSidFile(bytes);
  return identifyPlayerInData(file.payload, db, { ...options, loadAddress: file.loadAddress });
}

/** Parses the text of a signature file and the optional info file together. */
export function loadSidIdSignatures(cfg: Uint8Array, nfo?: Uint8Array): { db: SidIdDb; info?: Map<string, SidIdInfo> } {
  const db = parseSidIdConfig(latin1(cfg));
  if (db.signatures === 0) throw new HvscError("bad_format", "the SIDId signature file holds no signature; pass the sidid.cfg of SIDId (lines of hex bytes ending in END)");
  return { db, ...(nfo === undefined ? {} : { info: parseSidIdInfo(latin1(nfo)) }) };
}
