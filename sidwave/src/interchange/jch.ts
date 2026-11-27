// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// JCH NewPlayer 20.G editor image reader. The image is what the JCH editor saves: a memory dump loaded at $0F00 that holds
// the player code, a table of pointers at $0FA0 and the song data. The same bytes are inside a PSID file whose load address
// is $0F00 (an unpacked rip). The layout is read from the published descriptions of the editor format (the pointer block,
// the 8-byte instrument record, the two-column wave table, the order list pairs and the sequence events); no player code
// and no converter source is used or reproduced.

import { InterchangeInputError } from "./errors.js";

export const JCH_LOAD = 0x0f00;
export const JCH_MAX_BYTES = 0x10000 + 0x200;

/** A malformed or unsupported JCH file. Classified as `input`. */
export class JchError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "JchError"; }
}

export interface JchEvent { /** Instrument, tie or command byte (`$80` none, `$90` tie, `$A0`-`$BF` instrument, `$C0`+ command). */ b0: number; /** `0` gate off, `1`-`$7D` note, `$7E` hold. */ note: number }
export interface JchOrderEntry { /** Transposition in semitones (the stored byte minus `$80`). */ transpose: number; sequence: number }
export interface JchInstrument { ad: number; sr: number; restart: number; filterSetting: number; filterPointer: number; pulsePointer: number; property: number; wavePointer: number }

export interface JchSong {
  version: string;
  name: string;
  /** Default tempo byte; below 2 the groove is used. */
  tempo: number;
  /** Break-speed table: the first entry of the filter table, up to four values. */
  groove: number[];
  instruments: JchInstrument[];
  waveNote: Uint8Array;
  waveCtrl: Uint8Array;
  pulse: Uint8Array;
  filter: Uint8Array;
  commandA: Uint8Array;
  commandB: Uint8Array;
  orderLists: JchOrderEntry[][];
  /** Sequences by index, as event lists up to the `$7F` end marker. Unreferenced sequences are empty. */
  sequences: JchEvent[][];
  warnings: string[];
}

function loadImage(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 0x80) throw new JchError("the file is too short for a JCH image");
  if (bytes.length > JCH_MAX_BYTES) throw new JchError(`the file is ${bytes.length} bytes; the limit is ${JCH_MAX_BYTES}`);
  const mem = new Uint8Array(0x10000);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  let load: number, data: Uint8Array;
  if (magic === "PSID" || magic === "RSID") {
    const offset = (bytes[6]! << 8) | bytes[7]!;
    if (offset < 0x76 || offset > bytes.length) throw new JchError("the SID header has a bad data offset");
    load = (bytes[8]! << 8) | bytes[9]!;
    data = bytes.subarray(offset);
    if (load === 0) { if (data.length < 2) throw new JchError("the SID file has no data"); load = data[0]! | (data[1]! << 8); data = data.subarray(2); }
  } else {
    load = bytes[0]! | (bytes[1]! << 8);
    data = bytes.subarray(2);
  }
  if (load !== JCH_LOAD) throw new JchError(`the load address is $${load.toString(16).toUpperCase().padStart(4, "0")}; an unpacked JCH image loads at $0F00 (packed or relocated tunes are not supported)`);
  if (load + data.length > 0x10000) throw new JchError("the data runs past $FFFF");
  mem.set(data, load);
  return mem;
}

/** True for a PRG or PSID with a plausible NewPlayer version mark at $0FEE, loaded at $0F00. */
export function looksLikeJch(bytes: Uint8Array): boolean {
  try {
    if (bytes.length < 0x100) return false;
    const mem = loadImage(bytes);
    return /^[0-9]{2}[0-9.][0-9A-Z]$/.test(String.fromCharCode(mem[0xfee]!, mem[0xfef]!, mem[0xff0]!, mem[0xff1]!));
  } catch { return false; }
}

const text = (mem: Uint8Array, at: number, n: number): string => {
  let out = "";
  for (let i = 0; i < n && at + i < 0x10000; i++) { const c = mem[at + i]!; if (c === 0) break; out += c >= 32 && c < 127 ? String.fromCharCode(c) : " "; }
  return out.replace(/\s+/g, " ").trim();
};

/** Reads a JCH NewPlayer 20.G editor image (PRG at $0F00, or the same bytes in a PSID file). */
export function parseJch(bytes: Uint8Array): JchSong {
  const mem = loadImage(bytes);
  const w = (a: number): number => mem[a]! | (mem[a + 1]! << 8);
  const version = String.fromCharCode(mem[0xfee]!, mem[0xfef]!, mem[0xff0]!, mem[0xff1]!, mem[0xff2]!);
  if (!version.startsWith("20.G")) throw new JchError(`the version mark at $0FEE is "${version.replace(/[^ -~]/g, "?")}"; only JCH NewPlayer 20.G editor images are supported`);
  const base = {
    init: w(0xfa6), wave: w(0xfbc), filter: w(0xfc0), pulse: w(0xfc2), instruments: w(0xfc4), lists: [w(0xfc6), w(0xfc8), w(0xfca)],
    seqLo: w(0xfcc), seqHi: w(0xfce), commands: w(0xfd0),
  };
  const inRam = (a: number, size: number, what: string): void => {
    if (a < 0x1000 || a + size > 0xd000) throw new JchError(`the pointer to the ${what} ($${a.toString(16).toUpperCase()}) is outside the song data`);
  };
  inRam(base.init, 8, "init data"); inRam(base.wave, 512, "wave table"); inRam(base.filter, 256, "filter table"); inRam(base.pulse, 256, "pulse table");
  inRam(base.instruments, 256, "instrument table"); base.lists.forEach((a, i) => inRam(a, 4, `order list ${i + 1}`)); inRam(base.seqLo, 128, "sequence low table");
  inRam(base.seqHi, 128, "sequence high table"); inRam(base.commands, 64, "command table");
  const warnings: string[] = [];
  const instruments: JchInstrument[] = [];
  for (let i = 0; i < 32; i++) {
    const a = base.instruments + i * 8;
    instruments.push({ ad: mem[a]!, sr: mem[a + 1]!, restart: mem[a + 2]!, filterSetting: mem[a + 3]!, filterPointer: mem[a + 4]!, pulsePointer: mem[a + 5]!, property: mem[a + 6]!, wavePointer: mem[a + 7]! });
  }
  const groove: number[] = [];
  for (let i = 0; i < 4; i++) { const v = mem[base.filter + i]!; if (v === 0 && i > 0) break; groove.push(v); }
  const orderLists: JchOrderEntry[][] = base.lists.map((start, v) => {
    const list: JchOrderEntry[] = [];
    for (let i = 0; i < 0x200 && start + 2 * i + 1 < 0xd000; i++) {
      const t = mem[start + 2 * i]!;
      if (t >= 0xfe) break;
      list.push({ transpose: t - 0x80, sequence: mem[start + 2 * i + 1]! });
    }
    if (list.length === 0) warnings.push(`order list ${v + 1} is empty`);
    return list;
  });
  const used = new Set<number>();
  for (const l of orderLists) for (const e of l) used.add(e.sequence);
  for (const s of used) if (s >= 0x68) throw new JchError(`an order list names sequence ${s}; the editor has at most 104`);
  const sequences: JchEvent[][] = Array.from({ length: 0x68 }, () => []);
  for (const s of used) {
    const at = mem[base.seqLo + s]! | (mem[base.seqHi + s]! << 8);
    if (at < 0x1000 || at + 2 > 0xd000) throw new JchError(`sequence ${s} is at $${at.toString(16).toUpperCase()}, outside the song data`);
    const events: JchEvent[] = [];
    for (let i = 0; i < 128 && at + 2 * i + 1 < 0xd000; i++) {
      const b0 = mem[at + 2 * i]!;
      if (b0 === 0x7f) break;
      events.push({ b0, note: mem[at + 2 * i + 1]! });
    }
    sequences[s] = events;
  }
  return {
    version, name: text(mem, w(0xfa4) + 1, 30), tempo: mem[base.init + 6]!, groove, instruments,
    waveNote: Uint8Array.from(mem.subarray(base.wave, base.wave + 256)), waveCtrl: Uint8Array.from(mem.subarray(base.wave + 256, base.wave + 512)),
    pulse: Uint8Array.from(mem.subarray(base.pulse, base.pulse + 256)), filter: Uint8Array.from(mem.subarray(base.filter, base.filter + 256)),
    commandA: Uint8Array.from(mem.subarray(base.commands, base.commands + 32)), commandB: Uint8Array.from(mem.subarray(base.commands + 32, base.commands + 64)),
    orderLists, sequences, warnings,
  };
}
