// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// CheeseCutter 2.x song files (.ct): reader and writer for the container and the song model.
//
// A .ct file is the three bytes "CC2" followed by a zlib stream. The inflated data is a 64 KiB C64 memory image (the
// player, its tables and the sequences) followed by a trailer with version, clock, multiplier, SID model, the speeds of
// 32 subtunes, text fields and the three order lists of every subtune. The layout is read from CheeseCutter's loader
// (src/ct/base.d, GPL-2.0, no code copied). The image holds a copy of the player; this module never ships one. Exports
// take the player from a file the user supplies (see cheesecutterExport.ts).

import { deflateSync, inflateSync } from "node:zlib";
import { InterchangeInputError } from "./errors.js";

export class CheeseCutterError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "CheeseCutterError"; }
}

export const CT = {
  MAGIC: "CC2",
  IMAGE: 65536,
  SUBTUNES: 32,
  SEQUENCES: 128,
  SEQ_BYTES: 256,
  TRACK_BYTES: 1024,
  INSTRUMENTS: 48,
  /** Offsets into the 96-word pointer table at $0FA0 of the image. */
  PTR_TABLE: 0xfa0,
  PTR_COUNT: 96,
  OFS: {
    featureBits: 0, masterVolume: 1, editorActive: 2, songTable: 3, speedSettings: 4, instrumentDescriptions: 7, frequencyTable: 12, arpeggioFirst: 14, arpeggioSecond: 15,
    filterProgram: 16, pulseProgram: 17, instrumentTable: 18, orderListVoice1: 19, orderListVoice2: 20, orderListVoice3: 21, sequenceLow: 22, sequenceHigh: 23, commandTable: 24, speedTable: 26,
    chordNotes: 30, chordStarts: 32,
  },
  TITLE: 65536 + 256 + 5,
  INSTRUMENT_NAMES: 65536 + 256 + 5 + 160,
  SUBTUNE_DATA: 65536 + 256 + 5 + 160 + 2048,
  /** Smallest inflated size that holds every field the loader reads. */
  MIN_INFLATED: 65536 + 256 + 5 + 160 + 2048 + 32 * 3 * 1024,
  /**
   * CheeseCutter writes 300,000 bytes (every example song inflates to exactly that). The loader's 167,832 is only the initial
   * size of the buffer it passes to zlib, which grows as needed, so it is not a limit; anything above 400,000 is refused here.
   */
  MAX_INFLATED: 400_000,
  MAX_FILE: 1_000_000,
  END_MARK: 0xbf,
  TIE_MARK: 0x5f,
} as const;

export interface CtSong {
  /** File revision (CheeseCutter 2.x writes 12; revisions 6 and above load). */
  version: number;
  /** 0 PAL, 1 NTSC. */
  clock: number;
  /** Player calls per video frame (1..15). */
  multiplier: number;
  /** 0 6581, 1 8580. */
  sidModel: number;
  fppres: number;
  speeds: Uint8Array;
  highlight: number;
  highlightOffset: number;
  title: string; author: string; release: string; message: string;
  instrumentNames: string[];
  /** The full inflated 64 KiB memory image, player included. */
  image: Uint8Array;
  /** Pointer table entries ($0FA0, 96 words). */
  pointers: number[];
  /** Order lists: [subtune][voice] = 1024 bytes, 512 two-byte entries (transposition, sequence number). */
  orderLists: Uint8Array[][];
  /** Everything after the subtune data in the inflated stream (normally empty). */
  trailer: Uint8Array;
}

const text = (b: Uint8Array): string => Array.from(b, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? " " : "?")).join("").trimEnd();

/** Table location in the image: a pointer, a length, and a bounds check. */
export function tableAt(song: Pick<CtSong, "pointers" | "image">, index: number, length: number, what: string): number {
  const at = song.pointers[index]!;
  if (at + length > CT.IMAGE) throw new CheeseCutterError(`the ${what} table at $${at.toString(16)} does not fit in the memory image`);
  return at;
}

/** Reads a .ct file. Every pointer used later is checked here, so decoding cannot read outside the image. */
export function parseCheeseCutter(bytes: Uint8Array): CtSong {
  if (bytes.length > CT.MAX_FILE) throw new CheeseCutterError(`the file has ${bytes.length} bytes; the limit is ${CT.MAX_FILE}`);
  if (bytes.length < 4 || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!) !== CT.MAGIC) throw new CheeseCutterError("not a CheeseCutter 2.x song file (the magic CC2 is missing)");
  let d: Buffer;
  try { d = inflateSync(bytes.subarray(3), { maxOutputLength: CT.MAX_INFLATED }); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CheeseCutterError(code === "ERR_BUFFER_TOO_LARGE" ? `the song inflates to more than ${CT.MAX_INFLATED} bytes` : `the zlib stream is damaged (${(error as Error).message})`);
  }
  if (d.length < CT.MIN_INFLATED) throw new CheeseCutterError(`the song data has ${d.length} bytes; at least ${CT.MIN_INFLATED} are needed`);
  let o = CT.IMAGE;
  const version = d[o++]!;
  if (version < 6) throw new CheeseCutterError(`song revision ${version} is older than CheeseCutter 2.x supports (6 and above)`);
  if (version >= 128) throw new CheeseCutterError("stereo (2-SID, ccstereo) CheeseCutter songs are not supported yet (the song has revision 128 or above)");
  const clock = d[o++]!, multiplier = d[o++]!, sidModel = d[o++]!, fppres = d[o++]!;
  const speeds = Uint8Array.from(d.subarray(o, o + 32));
  o += 32;
  // The loader reads the two highlight bytes only for revisions above 10.
  let highlight = 4, highlightOffset = 0;
  if (version > 10) { highlight = d[o++]!; highlightOffset = d[o++]!; }
  if (multiplier < 1 || multiplier > 15) throw new CheeseCutterError(`the multiplier ${multiplier} is outside 1..15`);
  const image = Uint8Array.from(d.subarray(0, CT.IMAGE));
  const pointers: number[] = [];
  for (let i = 0; i < CT.PTR_COUNT; i++) pointers.push(image[CT.PTR_TABLE + i * 2]! | (image[CT.PTR_TABLE + i * 2 + 1]! << 8));
  const instrumentNames: string[] = [];
  for (let i = 0; i < CT.INSTRUMENTS; i++) instrumentNames.push(text(d.subarray(CT.INSTRUMENT_NAMES + i * 32, CT.INSTRUMENT_NAMES + i * 32 + 32)));
  const orderLists: Uint8Array[][] = [];
  for (let s = 0; s < CT.SUBTUNES; s++) {
    const voices: Uint8Array[] = [];
    for (let v = 0; v < 3; v++) { const at = CT.SUBTUNE_DATA + (s * 3 + v) * CT.TRACK_BYTES; voices.push(Uint8Array.from(d.subarray(at, at + CT.TRACK_BYTES))); }
    orderLists.push(voices);
  }
  const song: CtSong = {
    version, clock, multiplier, sidModel, fppres, speeds, highlight, highlightOffset,
    title: text(d.subarray(CT.TITLE, CT.TITLE + 32)), author: text(d.subarray(CT.TITLE + 32, CT.TITLE + 64)),
    release: text(d.subarray(CT.TITLE + 64, CT.TITLE + 96)), message: text(d.subarray(CT.TITLE + 96, CT.TITLE + 128)),
    instrumentNames, image, pointers, orderLists, trailer: Uint8Array.from(d.subarray(CT.SUBTUNE_DATA + CT.SUBTUNES * 3 * CT.TRACK_BYTES)),
  };
  // The tables the importer reads must lie inside the image.
  const O = CT.OFS;
  tableAt(song, O.sequenceLow, 128, "sequence low byte"); tableAt(song, O.sequenceHigh, 128, "sequence high byte");
  tableAt(song, O.arpeggioFirst, 512, "wave"); tableAt(song, O.instrumentTable, 512, "instrument"); tableAt(song, O.commandTable, 256, "command");
  tableAt(song, O.pulseProgram, 256, "pulse"); tableAt(song, O.filterProgram, 256, "filter"); tableAt(song, O.chordNotes, 128, "chord");
  for (let n = 0; n < CT.SEQUENCES; n++) {
    const p = image[song.pointers[O.sequenceLow]! + n]! | (image[song.pointers[O.sequenceHigh]! + n]! << 8);
    if (p + CT.SEQ_BYTES > CT.IMAGE) throw new CheeseCutterError(`sequence ${n} starts at $${p.toString(16)}, which leaves no room for 256 bytes in the image`);
  }
  return song;
}

/** Number of subtunes that hold data: the last one whose order lists differ from an empty list. */
export function subtuneCount(song: CtSong): number {
  for (let s = CT.SUBTUNES - 1; s >= 0; s--) {
    for (const voice of song.orderLists[s]!) if (voice[1] !== 0x00 || voice[2] !== 0xf0 || voice[3] !== 0x00) return s + 1;
  }
  return 0;
}

const pad = (value: string, n: number): Uint8Array => { const out = new Uint8Array(n).fill(0x20); for (let i = 0; i < Math.min(n, value.length); i++) out[i] = value.charCodeAt(i) & 0x7f; return out; };

/** Serialises a song. The inflated stream is 300,000 bytes, as CheeseCutter writes it. */
export function writeCheeseCutter(song: CtSong): Uint8Array {
  const d = new Uint8Array(300_000);
  d.set(song.image, 0);
  let o = CT.IMAGE;
  d[o++] = song.version; d[o++] = song.clock; d[o++] = song.multiplier; d[o++] = song.sidModel; d[o++] = song.fppres;
  d.set(song.speeds, o); o += 32;
  d[o++] = song.highlight; d[o++] = song.highlightOffset;
  d.set(pad(song.title, 32), CT.TITLE); d.set(pad(song.author, 32), CT.TITLE + 32);
  d.set(pad(song.release, 32), CT.TITLE + 64); d.set(pad(song.message, 32), CT.TITLE + 96);
  for (let i = 0; i < CT.INSTRUMENTS; i++) d.set(pad(song.instrumentNames[i] ?? "", 32), CT.INSTRUMENT_NAMES + i * 32);
  for (let s = 0; s < CT.SUBTUNES; s++) for (let v = 0; v < 3; v++) d.set(song.orderLists[s]![v]!, CT.SUBTUNE_DATA + (s * 3 + v) * CT.TRACK_BYTES);
  return Buffer.concat([Buffer.from(CT.MAGIC, "latin1"), deflateSync(d, { level: 9 })]);
}

/** An empty order list: transposition 0, sequence 0, then filler entries and a wrap marker is added by the caller. */
export function emptyOrderList(): Uint8Array {
  const b = new Uint8Array(CT.TRACK_BYTES);
  b[0] = 0xa0; b[1] = 0x00;
  for (let i = 2; i < b.length; i += 2) { b[i] = 0xf0; b[i + 1] = 0x00; }
  return b;
}
