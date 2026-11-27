// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID-Wizard module files (`.swm` mono, `.sws` stereo) and instrument files (`.swi`): reader and writer.
// Written from the format description in SID-Wizard's `SWM-spec.src` and from reading the packer and player
// sources (SID-Wizard declares itself WTF-licensed in its README); no code is copied. Layout (all offsets after the 2-byte load address):
//
//   header, 64 bytes: "SWM1" or "SWMS", frame speed, ..., counts, driver type, tuning type, author text
//   sequences (orderlists):  [bytes ... terminator ($FE, or $FF and a position)] [size]      x sequence count
//   patterns:                [row bytes ... ] [size] [rows]                                  x pattern count
//   instruments:             [data ... ] [size] [8 name characters]                          x instrument count
//   chord table, tempo-program table (lengths in the header), subtune tempos (2 bytes per subtune)
//
// The file has no length field for the sequence and pattern areas, so the reader works backwards from the end,
// where the lengths are known, as the packer's depacker does.

import { InterchangeUsageError } from "./errors.js";

export class SwmError extends InterchangeUsageError {
  constructor(message: string) { super(message); this.name = "SwmError"; }
}

/** Largest accepted file: the C64 address space. */
export const SWM_MAX_BYTES = 65_536;
export const SWM_HEADER_BYTES = 64;
/** Reader limits: the theoretical limits of SWM-spec.src (PATT_MAX, INSTR_MAX, SUBTUNE_MAX) that other tools accept. */
export const SWM_MAX_PATTERNS = 127;
export const SWM_MAX_INSTRUMENTS = 62;
export const SWM_MAX_SEQUENCES = 48;
export const SWM_MAX_SUBTUNES = 32;
/** Writer limits: what the editor itself can hold (SWM-spec.src: maxptnamount=100, maxinstamount=37, maxsubtuneamount=8). */
export const SWM_WRITE_MAX_PATTERNS = 100;
export const SWM_WRITE_MAX_INSTRUMENTS = 37;
export const SWM_WRITE_MAX_SUBTUNES = 8;
export const SWM_MAX_ROWS = 255;
export const SWM_INSTRUMENT_FIXED = 16;
export const SWM_NAME_BYTES = 8;
/** Note column values. */
export const SWM_NOTE_MAX = 95;
export const SWM_PACKED_MIN = 0x70;
export const SWM_PACKED_MAX = 0x77;
export const SWM_NOTEFX = { portamento: 0x78, syncOn: 0x79, syncOff: 0x7a, ringOn: 0x7b, ringOff: 0x7c, gateOn: 0x7d, gateOff: 0x7e } as const;

export interface SwmRow {
  /** Note column without bit 7: 0 none, 1 to 95 note (1 is C-0), 96 to 111 vibrato, 120 to 126 note effects. */
  note: number;
  /** Instrument column (1 to 62), 63 legato, 64 to 127 small effect; undefined when the row has no second column. */
  inst?: number;
  /** Effect column: below 32 a big effect with `value`, otherwise a small effect. */
  fx?: number;
  value?: number;
}

export interface SwmPattern {
  /** Number of rows (the header of the block). */
  length: number;
  rows: SwmRow[];
}

export interface SwmInstrument {
  name: string;
  /** Data bytes without the size byte: 16 fixed bytes, then the three tables. */
  data: Uint8Array;
}

export interface SwmModule {
  kind: "swm" | "sws";
  loadAddress: number;
  /** Player calls per frame, 1 to 8. */
  speed: number;
  defaultPatternLength: number;
  /** Driver type byte (information only). */
  driver: number;
  /** 0: 440 Hz, 1: 432 Hz, 2: just intonation in C. */
  tuning: number;
  /** The raw 40-byte author field with trailing spaces and NULs removed. */
  author: string;
  /** Sequences in file order: three (SWM) or six (SWS) per subtune. */
  sequences: Uint8Array[];
  /** Index 0 is pattern 1. */
  patterns: SwmPattern[];
  /** Index 0 is instrument 1. */
  instruments: SwmInstrument[];
  chordTable: Uint8Array;
  tempoTable: Uint8Array;
  /** Per subtune: first and second funk tempo byte. */
  subtuneTempos: Array<[number, number]>;
  header: Uint8Array;
}

const HEADER_AT = 2;

export function swmSubtuneCount(sequenceCount: number, kind: "swm" | "sws"): number {
  const per = kind === "sws" ? 6 : 3;
  return sequenceCount === 0 ? 1 : Math.floor((sequenceCount - 1) / per) + 1;
}

function text(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0)) end--;
  return Buffer.from(bytes.subarray(0, end)).toString("latin1").replace(/[\x00-\x1f]/g, "?");
}

/** Decodes the row bytes of one pattern. Throws when the bytes do not decode to exactly `length` rows. */
export function decodePatternRows(bytes: Uint8Array, length: number, label: string): SwmRow[] {
  const rows: SwmRow[] = [];
  let i = 0;
  const need = (): number => {
    if (i >= bytes.length) throw new SwmError(`${label}: a row is cut off at the end of the pattern data`);
    return bytes[i++]!;
  };
  while (i < bytes.length) {
    const b = need();
    if (b >= SWM_PACKED_MIN && b <= SWM_PACKED_MAX) {
      const n = b - SWM_PACKED_MIN + 2;
      for (let k = 0; k < n; k++) rows.push({ note: 0 });
    } else {
      const row: SwmRow = { note: b & 0x7f };
      if (b & 0x80) {
        const ins = need();
        row.inst = ins & 0x7f;
        if (ins & 0x80) {
          const fx = need();
          row.fx = fx;
          if (fx < 0x20) row.value = need();
        }
      }
      rows.push(row);
    }
    if (rows.length > SWM_MAX_ROWS + 8) throw new SwmError(`${label}: more than ${SWM_MAX_ROWS} rows`);
  }
  if (rows.length !== length) throw new SwmError(`${label}: the block says ${length} rows but its data holds ${rows.length}`);
  return rows;
}

export function parseSwm(input: Uint8Array): SwmModule {
  const b = input;
  if (b.length > SWM_MAX_BYTES) throw new SwmError(`SWM file has ${b.length} bytes; the limit is ${SWM_MAX_BYTES}`);
  if (b.length < HEADER_AT + SWM_HEADER_BYTES + 2) throw new SwmError("file is too short for an SWM header");
  const magic = Buffer.from(b.subarray(HEADER_AT, HEADER_AT + 4)).toString("latin1");
  if (magic !== "SWM1" && magic !== "SWMS") throw new SwmError(`not a SID-Wizard module: the identifier at offset 2 is "${magic.replace(/[^\x20-\x7e]/g, "?")}", expected SWM1 or SWMS`);
  const kind = magic === "SWMS" ? "sws" : "swm";
  const h = (n: number): number => b[HEADER_AT + n]!;
  const seqCount = h(12), ptnCount = h(13), insCount = h(14), chordLen = h(15), tempoLen = h(16);
  if (seqCount > SWM_MAX_SEQUENCES) throw new SwmError(`${seqCount} sequences; the limit is ${SWM_MAX_SEQUENCES}`);
  if (ptnCount > SWM_MAX_PATTERNS) throw new SwmError(`${ptnCount} patterns; the limit is ${SWM_MAX_PATTERNS}`);
  if (insCount > SWM_MAX_INSTRUMENTS) throw new SwmError(`${insCount} instruments; the limit is ${SWM_MAX_INSTRUMENTS}`);
  const subtunes = swmSubtuneCount(seqCount, kind);
  if (subtunes > SWM_MAX_SUBTUNES) throw new SwmError(`${subtunes} subtunes; the limit is ${SWM_MAX_SUBTUNES}`);
  const speed = h(4);
  if (speed < 1 || speed > 8) throw new SwmError(`frame speed ${speed} is outside 1 to 8`);

  let at = b.length; // one past the next byte to read, moving backwards
  const take = (n: number, what: string): Uint8Array => {
    if (n < 0 || at - n < HEADER_AT + SWM_HEADER_BYTES) throw new SwmError(`${what}: the data runs into the header (file is truncated or its counts are wrong)`);
    at -= n;
    return b.subarray(at, at + n);
  };
  const subtuneTempos: Array<[number, number]> = [];
  const tempoBytes = take(subtunes * 2, "subtune tempos");
  for (let i = 0; i < subtunes; i++) subtuneTempos.push([tempoBytes[i * 2]!, tempoBytes[i * 2 + 1]!]);
  const tempoTable = Uint8Array.from(take(tempoLen, "tempo programs"));
  const chordTable = Uint8Array.from(take(chordLen, "chord table"));

  const instruments: SwmInstrument[] = [];
  for (let i = insCount; i >= 1; i--) {
    const name = take(SWM_NAME_BYTES, `instrument ${i} name`);
    const sizeByte = take(1, `instrument ${i} size`)[0]!;
    if (sizeByte < SWM_INSTRUMENT_FIXED + 1) throw new SwmError(`instrument ${i}: size ${sizeByte} is smaller than the fixed part`);
    const data = take(sizeByte, `instrument ${i} data`);
    instruments[i - 1] = { name: text(name), data: Uint8Array.from(data) };
  }

  const patterns: SwmPattern[] = [];
  for (let i = ptnCount; i >= 1; i--) {
    const length = take(1, `pattern ${i} length`)[0]!;
    const size = take(1, `pattern ${i} size`)[0]!;
    if (size < 1) throw new SwmError(`pattern ${i}: size 0`);
    // The size byte counts the unpacked bytes plus the end mark, not the bytes in the file: a packed NOP byte
    // stands for several bytes. Walk backwards until that many unpacked bytes are covered. A byte of the packed
    // range is a packed NOP only after a zero byte or another packed byte (the packer guarantees that).
    const floor = HEADER_AT + SWM_HEADER_BYTES;
    let start = at, covered = 0;
    while (covered < size - 1) {
      if (start <= floor) throw new SwmError(`pattern ${i}: the data runs into the header (file is truncated or its counts are wrong)`);
      const byte = b[start - 1]!;
      const before = start - 2 >= floor ? b[start - 2]! : 0xff;
      covered += byte >= SWM_PACKED_MIN && byte <= SWM_PACKED_MAX && (before === 0 || (before >= SWM_PACKED_MIN && before <= SWM_PACKED_MAX)) ? byte - SWM_PACKED_MIN + 2 : 1;
      start--;
    }
    if (covered !== size - 1) throw new SwmError(`pattern ${i}: a packed run crosses the start of the pattern`);
    const data = b.subarray(start, at);
    at = start;
    patterns[i - 1] = { length, rows: decodePatternRows(data, length, `pattern ${i}`) };
  }

  const sequences: Uint8Array[] = [];
  for (let i = seqCount - 1; i >= 0; i--) {
    const size = take(1, `sequence ${i} size`)[0]!;
    if (size < 1) throw new SwmError(`sequence ${i}: size 0`);
    const data = Uint8Array.from(take(size, `sequence ${i} data`));
    const last = data[size - 1]!;
    const term = size >= 2 && data[size - 2] === 0xff ? "jump" : last === 0xfe ? "end" : undefined;
    if (!term) throw new SwmError(`sequence ${i}: does not end with $FE or $FF and a position`);
    sequences[i] = data;
  }
  if (at !== HEADER_AT + SWM_HEADER_BYTES) throw new SwmError(`the sequence, pattern and instrument areas leave ${at - HEADER_AT - SWM_HEADER_BYTES} unexplained bytes after the header`);

  return {
    kind, loadAddress: b[0]! | (b[1]! << 8), speed, defaultPatternLength: h(11), driver: h(19), tuning: h(20),
    author: text(b.subarray(HEADER_AT + 24, HEADER_AT + SWM_HEADER_BYTES)),
    sequences, patterns, instruments, chordTable, tempoTable, subtuneTempos, header: Uint8Array.from(b.subarray(HEADER_AT, HEADER_AT + SWM_HEADER_BYTES)),
  };
}

/** Encodes pattern rows with packed NOPs (runs of at least three NOP rows after the first become one byte). */
export function encodePatternRows(rows: readonly SwmRow[]): number[] {
  const out: number[] = [];
  let lastZero = false; // the last unpacked byte so far is a zero
  for (let i = 0; i < rows.length;) {
    const r = rows[i]!;
    if (r.note === 0 && r.inst === undefined) {
      let n = 1;
      while (i + n < rows.length && rows[i + n]!.note === 0 && rows[i + n]!.inst === undefined) n++;
      // The packer folds a NOP run into packed bytes (2 to 9 rows each) when the byte before it is a zero, which can be
      // the zero parameter of the previous row; otherwise the first NOP row is written as a zero byte.
      let rest = n;
      if (!(lastZero && out.length > 0)) { out.push(0); rest--; }
      while (rest >= 2) { const k = Math.min(rest, 9); out.push(SWM_PACKED_MIN + k - 2); rest -= k; }
      if (rest === 1) out.push(0);
      lastZero = true;
      i += n;
      continue;
    }
    if (r.inst === undefined) { out.push(r.note); lastZero = false; }
    else {
      out.push(r.note | 0x80);
      if (r.fx === undefined) { out.push(r.inst); lastZero = r.inst === 0; }
      else {
        out.push(r.inst | 0x80, r.fx);
        if (r.fx < 0x20) { out.push(r.value ?? 0); lastZero = (r.value ?? 0) === 0; } else lastZero = false;
      }
    }
    i++;
  }
  return out;
}

/** Bytes of a pattern before NOP packing: one to four per row. */
export function patternUnpackedBytes(rows: readonly SwmRow[]): number {
  let n = 0;
  for (const r of rows) n += 1 + (r.inst === undefined ? 0 : 1) + (r.fx === undefined ? 0 : r.fx < 0x20 ? 2 : 1);
  return n;
}

/** The header of a new module: the editor's defaults for the bytes the format leaves to settings. */
export function defaultSwmHeader(): Uint8Array {
  const h = new Uint8Array(SWM_HEADER_BYTES);
  h[5] = 4; h[6] = 1; h[7] = 1; h[8] = h[9] = h[10] = 0xff; h.fill(0x20, 24);
  return h;
}

export interface SwmWriteOptions {
  loadAddress?: number;
  /** `editor` (default) refuses what SID-Wizard itself cannot hold; `reader` allows the larger counts that the reader accepts, to reproduce files made by other tools. */
  limits?: "editor" | "reader";
}

/** Serialises a module. Counts in the header are taken from the arrays. */
export function writeSwm(m: SwmModule, options: SwmWriteOptions = {}): Uint8Array {
  const load = options.loadAddress ?? m.loadAddress;
  const out: number[] = [load & 0xff, load >> 8];
  // Bytes the module does not model (editor settings, mute switches, obsolete fields) are kept from the header it was read with.
  const header = m.header.length === SWM_HEADER_BYTES ? Uint8Array.from(m.header) : defaultSwmHeader();
  header.set(Buffer.from(m.kind === "sws" ? "SWMS" : "SWM1", "latin1"), 0);
  header[4] = m.speed;
  header[11] = m.defaultPatternLength;
  header[12] = m.sequences.length;
  header[13] = m.patterns.length;
  header[14] = m.instruments.length;
  header[15] = m.chordTable.length;
  header[16] = m.tempoTable.length;
  header[19] = m.driver;
  header[20] = m.tuning;
  if (text(header.subarray(24)) !== m.author) { header.fill(0x20, 24); header.set(Buffer.from(m.author.slice(0, 40), "latin1"), 24); }
  const subtunes = swmSubtuneCount(m.sequences.length, m.kind);
  const wide = options.limits === "reader";
  if (m.sequences.length > SWM_MAX_SEQUENCES || m.patterns.length > (wide ? SWM_MAX_PATTERNS : SWM_WRITE_MAX_PATTERNS) || m.instruments.length > (wide ? SWM_MAX_INSTRUMENTS : SWM_WRITE_MAX_INSTRUMENTS) || subtunes > (wide ? SWM_MAX_SUBTUNES : SWM_WRITE_MAX_SUBTUNES)) {
    throw new SwmError(`the module exceeds the editor's limits (${SWM_WRITE_MAX_PATTERNS} patterns, ${SWM_WRITE_MAX_INSTRUMENTS} instruments, ${SWM_WRITE_MAX_SUBTUNES} subtunes)`);
  }
  out.push(...header);
  for (const s of m.sequences) { out.push(...s, s.length); }
  m.patterns.forEach((p, i) => {
    const bytes = encodePatternRows(p.rows);
    // The size byte counts the bytes of the unpacked pattern plus the end mark.
    const size = patternUnpackedBytes(p.rows) + 1;
    if (size > 255) throw new SwmError(`pattern ${i + 1} needs ${size} bytes unpacked; the format allows 255`);
    out.push(...bytes, size, p.length);
  });
  for (const ins of m.instruments) {
    out.push(...ins.data, ins.data.length, ...Buffer.from(ins.name.slice(0, SWM_NAME_BYTES).padEnd(SWM_NAME_BYTES, " "), "latin1"));
  }
  out.push(...m.chordTable, ...m.tempoTable);
  for (const [a, c] of m.subtuneTempos) out.push(a, c);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------------------
// Instruments

export interface SwiFile { loadAddress: number; instrument: SwmInstrument }

/** Parses an instrument file: load address, instrument data, size byte, 8 name characters. */
export function parseSwi(b: Uint8Array): SwiFile {
  if (b.length > 1024) throw new SwmError(`SWI file has ${b.length} bytes; the limit is 1024`);
  if (b.length < 2 + SWM_INSTRUMENT_FIXED + 1 + SWM_NAME_BYTES) throw new SwmError("file is too short for an SWI instrument");
  const nameAt = b.length - SWM_NAME_BYTES;
  const size = b[nameAt - 1]!;
  if (size < SWM_INSTRUMENT_FIXED + 1 || size !== nameAt - 1 - 2) throw new SwmError(`instrument size byte ${size} does not match the file length`);
  const data = Uint8Array.from(b.subarray(2, 2 + size));
  validateInstrument(data, "instrument");
  return { loadAddress: b[0]! | (b[1]! << 8), instrument: { name: text(b.subarray(nameAt)), data } };
}

export function writeSwi(instrument: SwmInstrument, loadAddress = 0x3333): Uint8Array {
  return Uint8Array.from([loadAddress & 0xff, loadAddress >> 8, ...instrument.data, instrument.data.length, ...Buffer.from(instrument.name.slice(0, SWM_NAME_BYTES).padEnd(SWM_NAME_BYTES, " "), "latin1")]);
}

export interface SwmTableRow { a: number; b: number; c: number }
export interface SwmInstrumentTables { wf: SwmTableRow[]; pw: SwmTableRow[]; filter: SwmTableRow[] }

/** Splits an instrument's three tables. Rows are three bytes; a table ends at a row that starts with $FF. */
export function instrumentTables(data: Uint8Array, label = "instrument"): SwmInstrumentTables {
  const pwAt = data[10]!, filtAt = data[11]!;
  const table = (from: number, to: number, name: string): SwmTableRow[] => {
    const rows: SwmTableRow[] = [];
    let i = from;
    while (i < to) {
      if (data[i] === 0xff) return rows;
      if (i + 3 > data.length) throw new SwmError(`${label}: the ${name} table is cut off`);
      rows.push({ a: data[i]!, b: data[i + 1]!, c: data[i + 2]! });
      i += 3;
    }
    return rows;
  };
  return { wf: table(SWM_INSTRUMENT_FIXED, pwAt, "waveform"), pw: table(pwAt, filtAt, "pulse"), filter: table(filtAt, data.length, "filter") };
}

function validateInstrument(data: Uint8Array, label: string): void {
  const pw = data[10]!, filt = data[11]!;
  if (pw < SWM_INSTRUMENT_FIXED || filt < pw || filt > data.length) throw new SwmError(`${label}: table pointers ${pw} and ${filt} are inconsistent with size ${data.length}`);
  instrumentTables(data, label);
}

/** Checks every instrument and pattern reference of a parsed module; used by the importer. */
export function validateModule(m: SwmModule): void {
  m.instruments.forEach((ins, i) => validateInstrument(ins.data, `instrument ${i + 1}`));
}
