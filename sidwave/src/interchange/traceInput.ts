// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Register traces from other tools as inputs of reconstruction: the VICE `-sounddev dump` text (an exact trace of
// SID writes) and the table printed by siddump (an approximate trace, one row per frame). Also the VICE dump
// text as an export format. Mappings and losses: doc/interchange.md.
//
// A trace here has the layout of the engine's trace (`TraceResult.records`): four numbers per write, in the order
// SID index, register offset, value, cycle. Parsers are linear in the input size and bound the number of writes.

import { InterchangeUsageError } from "./errors.js";

export type TraceClock = "PAL" | "NTSC";

/** Largest number of SID writes an imported trace may hold; the same bound as the engine's trace. */
export const MAX_IMPORT_RECORDS = 4_194_304;
/** Largest number of lines a siddump table may have. */
export const MAX_SIDDUMP_ROWS = 1_000_000;
/** Cycles per video frame: 63 x 312 on PAL, 65 x 263 on NTSC. */
const FRAME_CYCLES: Record<TraceClock, number> = { PAL: 19_656, NTSC: 17_095 };
const CLOCK_HZ: Record<TraceClock, number> = { PAL: 985_248, NTSC: 1_022_727 };
/** Largest cycle delta between two writes of a VICE dump (about 4,000 seconds at 1 MHz). */
const MAX_DELTA = 2 ** 32;

export interface ImportedTrace {
  format: "vice-dump" | "siddump";
  /** Four values per write: SID index, register offset (0 to 24), value, cycle. */
  records: Float64Array;
  clock: TraceClock;
  /** Always 0: cycles count from the first cycle of the trace. */
  originCycle: number;
  /** Cycle after the last write, rounded up to a whole frame. */
  horizonCycles: number;
  /** Number of writes held in `records`. */
  count: number;
  /** Highest SID index plus one. */
  sidCount: number;
  /** Writes to register offsets 25 to 31, which no SID register implements. They are not in `records`. */
  ignoredWrites: number;
  /** True for siddump: values are sampled once per frame and the order and cycle of writes inside a frame are invented. */
  approximate: boolean;
  warnings: string[];
}

export interface TraceParseOptions {
  clock?: TraceClock;
  maxRecords?: number;
}

function finish(format: ImportedTrace["format"], records: number[], clock: TraceClock, ignored: number, approximate: boolean, warnings: string[]): ImportedTrace {
  const count = records.length / 4;
  let maxSid = -1;
  for (let i = 0; i < records.length; i += 4) if (records[i]! > maxSid) maxSid = records[i]!;
  const last = count ? records[records.length - 1]! : 0;
  const frame = FRAME_CYCLES[clock];
  return {
    format, records: Float64Array.from(records), clock, originCycle: 0, horizonCycles: Math.ceil((last + 1) / frame) * frame, count,
    sidCount: maxSid + 1, ignoredWrites: ignored, approximate, warnings,
  };
}

/**
 * Parses the text of VICE's `-sounddev dump`: one line per SID write, `<cycle delta> <register> <value>`, decimal,
 * separated by single spaces. The delta counts cycles since the previous write (since the start of the dump for the
 * first line). The register is the SID register offset, 0 to 31. VICE 3.10 does not record which chip was written
 * (checked with vsid on a two-SID tune: writes to $D404 and $D424 both appear as register 4), so every write is
 * attributed to SID 0 and a multi-SID tune appears as the merge of its chips.
 */
export function parseViceDump(input: Uint8Array | string, options: TraceParseOptions = {}): ImportedTrace {
  const bytes = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  const clock = options.clock ?? "PAL";
  const max = options.maxRecords ?? MAX_IMPORT_RECORDS;
  const out: number[] = [];
  let ignored = 0;
  let cycle = 0;
  let line = 1;
  const n = bytes.length;
  let i = 0;
  const fail = (what: string): never => { throw new InterchangeUsageError(`VICE dump line ${line}: ${what}`); };
  while (i < n) {
    const c = bytes[i]!;
    if (c === 10) { line++; i++; continue; }
    if (c === 13) { i++; continue; }
    // three unsigned decimal fields
    const fields = [0, 0, 0];
    for (let f = 0; f < 3; f++) {
      let digits = 0;
      let v = 0;
      while (i < n && bytes[i]! >= 48 && bytes[i]! <= 57) {
        v = v * 10 + (bytes[i]! - 48);
        if (++digits > 12) fail("number has more than 12 digits");
        i++;
      }
      if (digits === 0) fail(f === 0 ? "expected a cycle delta" : "expected a number");
      fields[f] = v;
      if (f < 2) { if (i >= n || bytes[i] !== 32) fail("expected a space between the three numbers"); i++; }
    }
    while (i < n && (bytes[i] === 13 || bytes[i] === 32)) i++;
    if (i < n && bytes[i] !== 10) fail("unexpected characters after the third number");
    const [delta, reg, value] = fields as [number, number, number];
    if (delta > MAX_DELTA) fail(`cycle delta ${delta} exceeds ${MAX_DELTA}`);
    if (reg > 31) fail(`register ${reg} is outside 0 to 31; VICE dumps carry no chip number`);
    if (value > 255) fail(`value ${value} is outside 0 to 255`);
    cycle += delta;
    if (reg > 24) { ignored++; continue; }
    if (out.length / 4 >= max) throw new InterchangeUsageError(`VICE dump has more than ${max} SID writes`);
    out.push(0, reg, value, cycle);
  }
  return finish("vice-dump", out, clock, ignored, false, []);
}

/**
 * Writes the register writes of a trace in the text format of `-sounddev dump`. Cycles must not decrease. The first
 * delta is the cycle of the first write, counted from the start of the trace. The format has no chip number, so a
 * trace with writes to more than one SID is refused.
 */
export function exportViceDump(records: ArrayLike<number>): string {
  if (records.length % 4) throw new InterchangeUsageError("a trace holds four numbers per write");
  const parts: string[] = [];
  let previous = 0;
  for (let i = 0; i < records.length; i += 4) {
    const sid = records[i]!, reg = records[i + 1]!, value = records[i + 2]!, cycle = records[i + 3]!;
    if (sid !== 0) throw new InterchangeUsageError(`write ${i / 4} goes to SID ${sid + 1}; the VICE dump format has no chip number, so only single-SID traces can be exported`);
    if (!(reg >= 0 && reg <= 31 && Number.isInteger(reg) && value >= 0 && value <= 255 && Number.isInteger(value))) {
      throw new InterchangeUsageError(`write ${i / 4} is not a SID register write that VICE dumps can hold`);
    }
    if (!(cycle >= previous) || !Number.isInteger(cycle)) throw new InterchangeUsageError(`write ${i / 4}: cycles must be whole numbers that do not decrease`);
    parts.push(`${cycle - previous} ${reg} ${value}\n`);
    previous = cycle;
  }
  return parts.join("");
}

const FILTER_NAMES: Record<string, number> = { Off: 0, Low: 1, Bnd: 2, "L+B": 3, Hi: 4, "L+H": 5, "B+H": 6, LBH: 7 };

/**
 * Parses the table printed by siddump (Lasse Oorni, V1.11): `| Frame | Freq Note/Abs WF ADSR Pul | ... | FCut RC Typ V |`.
 * Columns hold a value only when it changed; `.` fields keep the previous value. The result is one call per row at
 * `frame * frame cycles`; the writes of a row are the printed fields, in the order ADSR, frequency, pulse width,
 * control register for each voice, then the filter. Detected and not recoverable: the order of writes inside a frame,
 * gate pulses shorter than a frame, writes that leave the value unchanged, the filter's mode bit 7 ($D418 bit 7).
 */
export function parseSiddump(input: Uint8Array | string, options: TraceParseOptions = {}): ImportedTrace {
  const text = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
  const clock = options.clock ?? "PAL";
  const max = options.maxRecords ?? MAX_IMPORT_RECORDS;
  const frameCycles = FRAME_CYCLES[clock];
  const out: number[] = [];
  const warnings: string[] = [];
  let rows = 0;
  let lastFrame = -1;
  let typeIndex = 0;
  let volume = 0;
  let lineNo = 0;
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    lineNo++;
    if (!line.startsWith("|") || line.includes("Frame")) continue;
    const cells = line.split("|");
    // "", frame, three voices, filter, [profiling], ""
    if (cells.length < 7) throw new InterchangeUsageError(`siddump line ${lineNo}: a row needs a frame column, three voice columns and the filter column`);
    if (++rows > MAX_SIDDUMP_ROWS) throw new InterchangeUsageError(`siddump table has more than ${MAX_SIDDUMP_ROWS} rows`);
    const frame = parseFrame(cells[1]!, lineNo);
    if (frame <= lastFrame) throw new InterchangeUsageError(`siddump line ${lineNo}: frame ${frame} does not follow frame ${lastFrame}`);
    lastFrame = frame;
    const base = frame * frameCycles;
    let k = 0;
    const put = (reg: number, value: number): void => {
      if (out.length / 4 >= max) throw new InterchangeUsageError(`siddump table yields more than ${max} SID writes`);
      out.push(0, reg, value & 255, base + 8 * k++);
    };
    for (let v = 0; v < 3; v++) {
      const s = cells[2 + v]!.slice(1);
      if (s.length < 26) throw new InterchangeUsageError(`siddump line ${lineNo}: voice ${v + 1} column is too short`);
      const freq = hex(s.slice(0, 4), 4, lineNo);
      const wave = hex(s.slice(14, 16), 2, lineNo);
      const adsr = hex(s.slice(17, 21), 4, lineNo);
      const pulse = hex(s.slice(22, 25), 3, lineNo);
      const o = v * 7;
      if (adsr !== undefined) { put(o + 5, adsr >> 8); put(o + 6, adsr); }
      if (freq !== undefined) { put(o, freq); put(o + 1, freq >> 8); }
      if (pulse !== undefined) { put(o + 2, pulse); put(o + 3, pulse >> 8); }
      if (wave !== undefined) put(o + 4, wave);
    }
    const f = cells[5]!.slice(1);
    if (f.length < 13) throw new InterchangeUsageError(`siddump line ${lineNo}: the filter column is too short`);
    const cutoff = hex(f.slice(0, 4), 4, lineNo);
    const ctrl = hex(f.slice(5, 7), 2, lineNo);
    const typeName = f.slice(8, 11).trim();
    const vol = hex(f.slice(12, 13), 1, lineNo);
    if (cutoff !== undefined) { put(21, (cutoff & 0xe0) >> 5); put(22, cutoff >> 8); }
    if (ctrl !== undefined) put(23, ctrl);
    let typeChanged = false;
    if (typeName !== "..." && typeName !== "") {
      const index = FILTER_NAMES[typeName];
      if (index === undefined) throw new InterchangeUsageError(`siddump line ${lineNo}: unknown filter type "${typeName}"`);
      typeIndex = index; typeChanged = true;
    }
    if (vol !== undefined) { volume = vol; typeChanged = true; }
    if (typeChanged) put(24, (typeIndex << 4) | volume);
  }
  if (rows === 0) throw new InterchangeUsageError("no siddump rows found; expected lines starting with | and a frame number");
  warnings.push("siddump prints one row per frame: the order and the cycles of writes inside a frame are invented, and gate pulses shorter than a frame are not visible.");
  return finish("siddump", out, clock, 0, true, warnings);
}

function parseFrame(cell: string, lineNo: number): number {
  const t = cell.trim();
  const plain = /^\d{1,9}$/.exec(t);
  if (plain) return Number(t);
  const timed = /^(\d+):(\d\d)\.(\d\d)$/.exec(t);
  if (timed) return Number(timed[1]) * 3000 + Number(timed[2]) * 50 + Number(timed[3]);
  throw new InterchangeUsageError(`siddump line ${lineNo}: "${t}" is not a frame number or a time`);
}

/** A hexadecimal field of fixed width; `undefined` for an unchanged ("...") field. */
function hex(field: string, width: number, lineNo: number): number | undefined {
  if (/^\.+$/.test(field)) return undefined;
  if (!/^[0-9A-Fa-f]+$/.test(field) || field.length !== width) throw new InterchangeUsageError(`siddump line ${lineNo}: "${field}" is not a ${width}-digit hexadecimal value`);
  return parseInt(field, 16);
}

export const TRACE_CLOCK_HZ = CLOCK_HZ;
export const TRACE_FRAME_CYCLES = FRAME_CYCLES;
