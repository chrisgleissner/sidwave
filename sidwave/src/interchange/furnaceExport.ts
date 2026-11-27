// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Furnace export: the first three voices of a score as a Furnace module (format version 228, C64 6581 chip).

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type EventExportOptions, type ExportedNote } from "./events.js";
import { InterchangeInputError } from "./errors.js";
import { CHIP_C64_6581, writeFurnace, type FurWriteInstrument, type FurWriteSong } from "./furnace.js";

export interface FurnaceExportResult {
  bytes: Uint8Array;
  ticksPerRow: number;
  tickRate: number;
  maxTimingErrorCalls: number;
  rows: number;
  patterns: number;
  instruments: number;
  voices: number;
  losses: string[];
  warnings: string[];
}

const PATTERN_ROWS = 64;
const BITS: Record<string, number> = { triangle: 1, tri: 1, saw: 2, pulse: 4, noise: 8 };

/** Exports one song of a score as a Furnace module. See doc/interchange.md for the mapping and losses. */
export function exportFurnace(doc: ParsedSidwave, options: EventExportOptions = {}): FurnaceExportResult {
  const score = exportEvents(doc, options);
  const losses = [...score.losses];
  const warnings: string[] = [];
  const fps = score.callRate;
  const voices = score.voices.filter((v) => v.sid === 0).slice(0, 3);
  if (voices.length === 0) throw new RangeError("the score has no voice on the first SID");
  if (score.voices.length > voices.length) losses.push(`Only the first three voices of the first SID are exported (the score has ${score.voices.length} voices).`);
  const frameOf = (seconds: number): number => Math.round(seconds * fps);
  const frames: number[] = [frameOf(score.durationSeconds)];
  for (const v of voices) for (const n of v.notes) frames.push(frameOf(n.on.time), frameOf(n.off.time));
  const errorOf = (t: number): number => { let m = 0; for (const f of frames) m = Math.max(m, Math.abs(f - t * Math.round(f / t))); return m; };
  let ticks = 3, best = Infinity;
  for (let t = 12; t >= 1; t--) { const e = errorOf(t); if (e <= 1) { ticks = t; best = e; break; } if (e < best) { best = e; ticks = t; } }
  if (best > 1) warnings.push(`No row length from 1 to 12 ticks fits every note start and end; ${ticks} ticks per row leaves an error of up to ${best} ticks.`);
  const rows = Math.max(1, Math.ceil(frameOf(score.durationSeconds) / ticks));
  if (rows > 256 * PATTERN_ROWS) throw new InterchangeInputError(`the score has ${rows} rows; a Furnace order list holds at most ${256 * PATTERN_ROWS}`);

  const exported = new Map(score.instruments.map((i) => [i.index, i]));
  const instMap = new Map<string, number>();
  const instruments: FurWriteInstrument[] = [];
  const instrumentFor = (note: ExportedNote): number => {
    const key = `${note.instrument}:${note.percussion ? note.drum ?? "" : ""}`;
    let id = instMap.get(key);
    if (id !== undefined) return id;
    const inst = exported.get(note.instrument);
    id = instruments.length;
    if (id >= 256) throw new InterchangeInputError("the score uses more than 256 instruments");
    instMap.set(key, id);
    let flags1 = 0;
    for (const part of (inst?.waveform ?? "pulse").split("+")) flags1 |= BITS[part] ?? 0;
    if (!(flags1 & 0x0f)) flags1 |= 4;
    instruments.push({
      name: (inst?.name ?? `inst ${note.instrument}`).replace(/^lib:/, "").slice(0, 40), flags1: flags1 & 0x0f,
      flags2: (inst?.ring ? 0x40 : 0) | (inst?.sync ? 0x80 : 0),
      ad: inst ? (inst.adsr[0] << 4) | inst.adsr[1] : 0x09, sr: inst ? (inst.adsr[2] << 4) | inst.adsr[3] : 0xa4,
      duty: Math.max(0, Math.min(4095, inst?.pulseWidth ?? 2048)),
      ...(inst?.arpeggio && inst.arpeggio.offsets.length > 1 ? { arp: { values: inst.arpeggio.offsets, speed: inst.arpeggio.callsPerStep } } : {}),
    });
    return id;
  };

  const channelRows: Array<Array<{ note: number; ins: number; vol: number }>> = [];
  let shifted = 0;
  for (const voice of voices) {
    const data = Array.from({ length: rows }, () => ({ note: -1, ins: -1, vol: -1 }));
    const notes = [...voice.notes].sort((a, b) => a.on.tick - b.on.tick || a.id - b.id);
    for (const [i, note] of notes.entries()) {
      const row = Math.min(rows - 1, Math.round(frameOf(note.on.time) / ticks));
      let pitch = note.pitch;
      while (pitch + 48 > 179) { pitch -= 12; shifted++; }
      if (data[row]!.note >= 0) { warnings.push(`Two notes fall on row ${row}; the later one is dropped.`); continue; }
      data[row] = { note: pitch + 48, ins: instrumentFor(note), vol: -1 };
      const next = notes[i + 1];
      const offRow = Math.min(rows - 1, Math.max(row + 1, Math.round(frameOf(note.off.time) / ticks)));
      const nextRow = next ? Math.round(frameOf(next.on.time) / ticks) : rows;
      if (offRow < nextRow && data[offRow]!.note < 0) data[offRow] = { note: 180, ins: -1, vol: -1 };
    }
    channelRows.push(data);
  }
  while (channelRows.length < 3) channelRows.push(Array.from({ length: rows }, () => ({ note: -1, ins: -1, vol: -1 })));
  if (shifted) losses.push(`${shifted} notes were moved down by octaves to fit the Furnace note range.`);
  losses.push("Filter, pulse width modulation, vibrato, slides, level and chip volume changes, wavetable steps (arpeggio is kept as a macro) and the hard restart settings are not exported.");
  losses.push("Rows are whole multiples of the row length; note starts and ends are moved to the nearest row.");

  const chunks = Math.ceil(rows / PATTERN_ROWS);
  const patterns: FurWriteSong["patterns"] = [[], [], []];
  const orders: number[][] = Array.from({ length: chunks }, () => []);
  for (let c = 0; c < 3; c++) {
    const seen = new Map<string, number>();
    for (let k = 0; k < chunks; k++) {
      const slice = channelRows[c]!.slice(k * PATTERN_ROWS, (k + 1) * PATTERN_ROWS);
      while (slice.length < PATTERN_ROWS) slice.push({ note: -1, ins: -1, vol: -1 });
      const key = JSON.stringify(slice);
      let id = seen.get(key);
      if (id === undefined) { id = patterns[c]!.length; patterns[c]!.push(slice); seen.set(key, id); }
      orders[k]![c] = id;
    }
  }
  const bytes = writeFurnace({ name: score.title, author: score.author ?? "", chip: CHIP_C64_6581, tickRate: fps, speed: ticks, patternLength: PATTERN_ROWS, orders, patterns, instruments });
  return { bytes, ticksPerRow: ticks, tickRate: fps, maxTimingErrorCalls: best, rows, patterns: patterns.reduce((n, p) => n + p.length, 0), instruments: instruments.length, voices: voices.length, losses: [...new Set(losses)], warnings };
}
