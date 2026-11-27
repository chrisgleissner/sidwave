// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID Factory II song files (.sf2): reader and writer of the container, the header blocks, the order lists and the sequences.
//
// An .sf2 file is a C64 PRG: a two-byte load address, then a memory image that holds a 6502 driver and the song data at
// addresses the driver defines. The first word at the load address is 0x1337, followed by header blocks (id, size, data)
// that describe the driver, its tables and where the order lists and sequences are. The layout was read from SID Factory
// II's loader and data sources (SIDFactoryII/source/runtime/editor/driver/driver_info.cpp, datasources/datasource_orderlist.cpp
// and datasource_sequence.cpp; Chordian/sidfactory2, GPL-2.0, no code copied). This module contains no driver.

import { InterchangeInputError } from "./errors.js";

export class Sf2Error extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "Sf2Error"; }
}

export const SF2 = {
  ID: 0x1337,
  MAX_FILE: 1_000_000,
  HEADER: { Descriptor: 1, DriverCommon: 2, DriverTables: 3, InstrumentDescriptor: 4, MusicData: 5, End: 0xff },
  /** Table identifiers used by the SID Factory II drivers. */
  TABLE: { Commands: 0, Instruments: 1, Wave: 2, Pulse: 3, Filter: 4, HR: 5, Arp: 6, Tempo: 7, Init: 8 },
  SEQ_END: 0x7f,
  MAX_ORDER_ENTRIES: 256,
  MAX_SEQUENCE_EVENTS: 1024,
} as const;

export interface Sf2Table { type: number; id: number; name: string; layout: 0 | 1; address: number; columns: number; rows: number }
export interface Sf2Music {
  tracks: number; orderListPointersLow: number; orderListPointersHigh: number;
  sequenceCount: number; sequencePointersLow: number; sequencePointersHigh: number;
  orderListSize: number; orderList1: number; sequenceSize: number; sequence0: number;
  /** Where the six address fields that move when the editor relocates data sit in the header (for the writer). */
  fieldAddresses: { seqLo: number; seqHi: number; orderList1: number; sequence0: number };
}
export interface Sf2Driver { type: number; name: string; size: number; codeTop: number; codeSize: number; major: number; minor: number; revision: number }
export interface Sf2Common { init: number; stop: number; update: number }
export interface Sf2Song {
  loadAddress: number;
  /** Memory image; bytes outside the file are zero. */
  image: Uint8Array;
  /** One past the last byte of the file in the image. */
  end: number;
  driver: Sf2Driver;
  common: Sf2Common;
  tables: Sf2Table[];
  music: Sf2Music;
}

const printable = (bytes: number[]): string => bytes.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "")).join("").trim();

/** Reads an .sf2 file. Every address and size that decoding later uses is checked here against the 64 KiB image. */
export function parseSf2(bytes: Uint8Array): Sf2Song {
  if (bytes.length > SF2.MAX_FILE) throw new Sf2Error(`the file has ${bytes.length} bytes; the limit is ${SF2.MAX_FILE}`);
  if (bytes.length < 8) throw new Sf2Error("the file is too short to be a SID Factory II song (a PRG with the id 0x1337 at its load address)");
  const load = bytes[0]! | (bytes[1]! << 8);
  if (load + bytes.length - 2 > 0x10000) throw new Sf2Error(`the file does not fit in memory at its load address $${load.toString(16)}`);
  const image = new Uint8Array(0x10000);
  image.set(bytes.subarray(2), load);
  const end = load + bytes.length - 2;
  const word = (a: number): number => image[a & 0xffff]! | (image[(a + 1) & 0xffff]! << 8);
  if (word(load) !== SF2.ID) throw new Sf2Error("not a SID Factory II song: the id 0x1337 is missing at the load address");
  let driver: Sf2Driver | undefined, common: Sf2Common | undefined, tables: Sf2Table[] | undefined, music: Sf2Music | undefined;
  let p = load + 2;
  const seen = new Set<number>();
  for (let guard = 0; guard < 32; guard++) {
    if (p + 1 >= end) throw new Sf2Error("the header blocks run past the end of the file (no end block 0xFF)");
    const id = image[p]!;
    if (id === SF2.HEADER.End) break;
    if (seen.has(id)) throw new Sf2Error(`header block ${id} appears twice`);
    seen.add(id);
    const size = image[p + 1]!;
    const q = p + 2, blockEnd = q + size;
    if (blockEnd > end) throw new Sf2Error(`header block ${id} runs past the end of the file`);
    const str = (a: number): { text: string; next: number } => {
      const chars: number[] = [];
      while (a < blockEnd && image[a] !== 0) chars.push(image[a++]!);
      if (a >= blockEnd) throw new Sf2Error(`header block ${id}: a text field is not terminated`);
      return { text: printable(chars), next: a + 1 };
    };
    if (id === SF2.HEADER.Descriptor) {
      const name = str(q + 3);
      let a = name.next;
      if (a + 6 > blockEnd) throw new Sf2Error("the descriptor block is too short");
      driver = { type: image[q]!, size: word(q + 1), name: name.text, codeTop: word(a), codeSize: word(a + 2), major: image[a + 4]!, minor: image[a + 5]!, revision: a + 6 < blockEnd ? image[a + 6]! : 0 };
    } else if (id === SF2.HEADER.DriverCommon) {
      if (size < 6) throw new Sf2Error("the driver common block is too short");
      common = { init: word(q), stop: word(q + 2), update: word(q + 4) };
    } else if (id === SF2.HEADER.DriverTables) {
      tables = [];
      let a = q;
      while (a < blockEnd) {
        const type = image[a]!;
        if (type === 0xff) break;
        const tid = image[a + 1]!;
        const name = str(a + 3);
        const b = name.next;
        if (b + 12 > blockEnd) throw new Sf2Error("a table definition runs past its header block");
        const t: Sf2Table = { type, id: tid, name: name.text, layout: image[b]! === 1 ? 1 : 0, address: word(b + 5), columns: word(b + 7), rows: word(b + 9) };
        if (t.columns * t.rows === 0 || t.address + t.columns * t.rows > 0x10000) throw new Sf2Error(`table ${tid} (${t.columns} x ${t.rows} at $${t.address.toString(16)}) does not fit in the image`);
        tables.push(t);
        a = b + 12;
        if (tables.length > 32) throw new Sf2Error("more than 32 tables");
      }
    } else if (id === SF2.HEADER.MusicData) {
      if (size < 18) throw new Sf2Error("the music data block is too short");
      music = {
        tracks: image[q]!, orderListPointersLow: word(q + 1), orderListPointersHigh: word(q + 3), sequenceCount: image[q + 5]!,
        sequencePointersLow: word(q + 6), sequencePointersHigh: word(q + 8), orderListSize: word(q + 10), orderList1: word(q + 12), sequenceSize: word(q + 14), sequence0: word(q + 16),
        fieldAddresses: { seqLo: q + 6, seqHi: q + 8, orderList1: q + 12, sequence0: q + 16 },
      };
    }
    p = blockEnd;
  }
  if (!driver || !common || !tables || !music) throw new Sf2Error("the file lacks a required header block (descriptor, driver common, tables or music data)");
  const need = (id: number): void => { if (!tables.some((t) => t.id === id)) throw new Sf2Error(`the driver defines no table ${id}`); };
  need(SF2.TABLE.Instruments); need(SF2.TABLE.Commands);
  if (music.tracks < 1 || music.tracks > 12) throw new Sf2Error(`the song has ${music.tracks} tracks; 1 to 12 are supported`);
  if (music.sequenceCount < 1 || music.sequenceCount > 128) throw new Sf2Error(`the song has ${music.sequenceCount} sequences; 1 to 128 are supported`);
  if (music.sequenceSize < 3 || music.sequenceSize > 256 || music.orderListSize < 3 || music.orderListSize > 256) throw new Sf2Error("the order list or sequence size is outside 3..256");
  for (const a of [music.orderListPointersLow, music.orderListPointersHigh]) if (a + music.tracks > 0x10000) throw new Sf2Error("the order list pointer tables are outside the image");
  for (const a of [music.sequencePointersLow, music.sequencePointersHigh]) if (a + music.sequenceCount > 0x10000) throw new Sf2Error("the sequence pointer tables are outside the image");
  if (!(common.init > 0 && common.update > 0)) throw new Sf2Error("the driver has no init or update address");
  const song: Sf2Song = { loadAddress: load, image, end, driver, common, tables, music };
  for (let t = 0; t < music.tracks; t++) {
    const a = orderListAddress(song, t);
    if (a + music.orderListSize > 0x10000) throw new Sf2Error(`the order list of track ${t + 1} at $${a.toString(16)} does not fit in the image`);
  }
  for (let s = 0; s < music.sequenceCount; s++) {
    const a = sequenceAddress(song, s);
    if (a + music.sequenceSize > 0x10000) throw new Sf2Error(`sequence ${s} at $${a.toString(16)} does not fit in the image`);
  }
  return song;
}

export function orderListAddress(song: Sf2Song, track: number): number {
  const m = song.music;
  return song.image[m.orderListPointersLow + track]! | (song.image[m.orderListPointersHigh + track]! << 8);
}
export function sequenceAddress(song: Sf2Song, n: number): number {
  const m = song.music;
  return song.image[m.sequencePointersLow + n]! | (song.image[m.sequencePointersHigh + n]! << 8);
}

export function tableOf(song: Sf2Song, id: number): Sf2Table | undefined { return song.tables.find((t) => t.id === id); }

/** One cell of a table (column-major tables store each column as a run of `rows` bytes). */
export function cell(song: Sf2Song, table: Sf2Table, row: number, column: number): number {
  const at = table.layout === 1 ? table.address + column * table.rows + row : table.address + row * table.columns + column;
  return song.image[at]!;
}
export function setCell(song: Sf2Song, table: Sf2Table, row: number, column: number, value: number): void {
  const at = table.layout === 1 ? table.address + column * table.rows + row : table.address + row * table.columns + column;
  song.image[at] = value & 0xff;
}

export interface Sf2OrderEntry { transposition: number; sequence: number }
export interface Sf2OrderList { entries: Sf2OrderEntry[]; /** Entry index the list loops back to, or -1 when it stops. */ loop: number }

/** Unpacks an order list: values below 0x80 are sequence numbers, 0x80 and above set the transposition (value & 0x7F) - 0x20, 0xFE ends the song, 0xFF is followed by the packed position to loop to. */
export function readOrderList(song: Sf2Song, track: number): Sf2OrderList {
  const at = orderListAddress(song, track);
  const d = song.image, size = song.music.orderListSize;
  const entries: Sf2OrderEntry[] = [];
  const entryAtPacked = new Map<number, number>();
  let trans = 0, loop = -1;
  for (let i = 0; i < size; i++) {
    const v = d[at + i]!;
    if (v === 0xfe) break;
    if (v === 0xff) {
      const target = d[at + i + 1]!;
      if (entryAtPacked.has(target)) loop = entryAtPacked.get(target)!;
      else if (target === i) loop = entries.length;
      else throw new Sf2Error(`track ${track + 1}: the order list loops to position ${target}, which does not hold an entry`);
      break;
    }
    if (v >= 0x80) { trans = (v & 0x7f) - 0x20; entryAtPacked.set(i, entries.length); continue; }
    if (!entryAtPacked.has(i)) entryAtPacked.set(i, entries.length);
    if (entries.length >= SF2.MAX_ORDER_ENTRIES) throw new Sf2Error(`track ${track + 1}: the order list has more than ${SF2.MAX_ORDER_ENTRIES} entries`);
    entries.push({ transposition: trans, sequence: v });
    if (i === size - 1) throw new Sf2Error(`track ${track + 1}: the order list has no end marker`);
  }
  if (entries.length === 0 && loop === -1) throw new Sf2Error(`track ${track + 1}: the order list is empty`);
  return { entries, loop };
}

/** An event of a sequence: `note` 0 off, 1..0x6F note, 0x7E gate on; instrument and command are 0x80 when unset. */
export interface Sf2Event { instrument: number; command: number; note: number; tied: boolean }

/** Unpacks a sequence into one event per tick. Durations expand into 0x7E (or 0x00 after a note off) events. */
export function readSequence(song: Sf2Song, n: number): Sf2Event[] {
  const at = sequenceAddress(song, n);
  if (at < 0x100) throw new Sf2Error(`sequence ${n} has no address (its pointer is $${at.toString(16)})`);
  const d = song.image, size = song.music.sequenceSize;
  const out: Sf2Event[] = [];
  let duration = 0;
  for (let i = 0; i < size;) {
    let v = d[at + i++]!;
    if (v === SF2.SEQ_END) return out;
    let command = 0x80, instrument = 0x80, tied = false;
    const need = (): number => { if (i >= size) throw new Sf2Error(`sequence ${n} has no end marker (0x7F)`); return d[at + i++]!; };
    if (v >= 0xc0) { command = v & 0x3f; v = need(); }
    if (v >= 0xa0) { instrument = v & 0x1f; v = need(); }
    if (v >= 0x80) { duration = v & 0x0f; tied = (v & 0x10) !== 0; v = need(); }
    if (v >= 0x80) throw new Sf2Error(`sequence ${n}: byte ${v.toString(16)} is not a note`);
    out.push({ instrument, command, note: v, tied });
    if (out.length + duration > SF2.MAX_SEQUENCE_EVENTS) throw new Sf2Error(`sequence ${n} has more than ${SF2.MAX_SEQUENCE_EVENTS} events`);
    for (let k = 0; k < duration; k++) out.push({ instrument: 0x80, command: 0x80, note: v !== 0 ? 0x7e : 0, tied: false });
  }
  throw new Sf2Error(`sequence ${n} has no end marker (0x7F)`);
}

/** Packs events (one per tick) into the sequence byte stream with the end marker. */
export function packSequence(events: Sf2Event[]): Uint8Array {
  const out: number[] = [];
  let lastDuration = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    let duration = 0;
    for (let j = i + 1; j < events.length && duration < 0x0f; j++) {
      const f = events[j]!;
      if (f.instrument !== 0x80 || f.command !== 0x80 || f.tied) break;
      if (e.note === 0 ? f.note !== 0 : f.note !== 0x7e) break;
      duration++;
    }
    if (e.command !== 0x80) out.push(0xc0 | e.command);
    if (e.instrument !== 0x80) out.push(0xa0 | e.instrument);
    if (lastDuration !== duration || e.tied) { out.push(0x80 | duration | (e.tied ? 0x10 : 0)); lastDuration = duration; }
    out.push(e.note);
    i += duration;
  }
  out.push(SF2.SEQ_END);
  return Uint8Array.from(out);
}

/** Serialises a song as a PRG: load address and the image from the load address to `end`. */
export function writeSf2(song: Sf2Song): Uint8Array {
  const out = new Uint8Array(2 + song.end - song.loadAddress);
  out[0] = song.loadAddress & 255; out[1] = song.loadAddress >> 8;
  out.set(song.image.subarray(song.loadAddress, song.end), 2);
  return out;
}
