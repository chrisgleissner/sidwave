// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// GoatTracker export: the first three voices of a score as a GTS5 song file (GoatTracker 2.77, gt2reloc).

import type { ParsedSidwave } from "../sidwave.js";
import { sidwaveFrameRate } from "../sidwaveCompiler.js";
import { exportEvents, type EventExportOptions, type ExportedInstrument, type ExportedNote } from "./events.js";
import { GT, writeGoatTracker, type GtInstrument } from "./goattracker.js";
import { InterchangeLimitError } from "./errors.js";

export interface GoatTrackerExportResult {
  bytes: Uint8Array;
  /** Player calls per pattern row. */
  ticksPerRow: number;
  /** Largest distance, in player calls, between a note start or end and its row. */
  maxTimingErrorCalls: number;
  rows: number;
  patterns: number;
  instruments: number;
  voices: number;
  losses: string[];
  warnings: string[];
}

const PATTERN_ROWS = 64;
const WAVE_BITS: Record<string, number> = { triangle: 0x10, tri: 0x10, saw: 0x20, pulse: 0x40, noise: 0x80 };

function waveByte(inst: ExportedInstrument): number {
  let byte = 0;
  for (const part of inst.waveform.split("+")) byte |= WAVE_BITS[part] ?? 0;
  if (byte === 0) byte = 0x40;
  if (inst.ring) byte |= 0x04;
  if (inst.sync) byte |= 0x02;
  return byte;
}

/** Exports one song of a score as GTS5. See doc/interchange.md for the mapping and losses. */
export function exportGoatTracker(doc: ParsedSidwave, options: EventExportOptions = {}): GoatTrackerExportResult {
  const score = exportEvents(doc, options);
  const losses = [...score.losses];
  const warnings: string[] = [];
  // GoatTracker plays one call per video frame; the call rate of a multispeed score (speed 2 to 4) does not apply.
  const fps = sidwaveFrameRate(score.mode);
  if (Math.abs(score.callRate - fps) > 0.01) losses.push(`The score calls its player ${Math.round(score.callRate / fps * 100) / 100} times per frame (multispeed); GoatTracker plays one call per frame, so note times are rounded to frames.`);
  const voices = options.voiceIds ? score.voices.slice(0, 3) : score.voices.filter((v) => v.sid === 0).slice(0, 3);
  if (!options.voiceIds && score.voices.length > voices.length) losses.push(`Only the first three voices of the first SID are exported (the score has ${score.voices.length} voices).`);
  if (voices.length === 0) throw new RangeError("the score has no voice on the first SID");
  const frameOf = (seconds: number): number => Math.round(seconds * fps);
  const frames: number[] = [];
  for (const v of voices) for (const n of v.notes) { frames.push(frameOf(n.on.time), frameOf(n.off.time)); }
  frames.push(frameOf(score.durationSeconds));

  // Row length: the largest tick count (3..12) at which every note start and end is within one call of a row.
  const errorOf = (t: number): number => { let m = 0; for (const f of frames) m = Math.max(m, Math.abs(f - t * Math.round(f / t))); return m; };
  let ticks = 3, best = Infinity;
  for (let t = 12; t >= 3; t--) { const e = errorOf(t); if (e <= 1) { ticks = t; best = e; break; } if (e < best) { best = e; ticks = t; } }
  if (best > 1) warnings.push(`No row length from 3 to 12 calls fits every note start and end; ${ticks} calls per row leaves an error of up to ${best} calls.`);
  const totalFrames = frameOf(score.durationSeconds);
  const rows = Math.max(1, Math.ceil(totalFrames / ticks));
  if (rows > 254 * PATTERN_ROWS) throw new InterchangeLimitError(`the score has ${rows} rows; a GoatTracker order list holds at most ${254 * PATTERN_ROWS}`);

  // Instruments.
  const instMap = new Map<string, number>();
  const instruments: GtInstrument[] = Array.from({ length: GT.MAX_INSTR }, () => ({ ad: 0, sr: 0, ptr: [0, 0, 0, 0] as GtInstrument["ptr"], vibdelay: 0, gatetimer: 0, firstwave: 0, name: "" }));
  const ltable = Array.from({ length: 4 }, () => new Uint8Array(GT.MAX_TABLELEN));
  const rtable = Array.from({ length: 4 }, () => new Uint8Array(GT.MAX_TABLELEN));
  let wlen = 0, plen = 0;
  const exported = new Map(score.instruments.map((i) => [i.index, i]));
  let usedFilter = false, usedVibrato = false, usedSlide = false, usedWavetable = false;
  const instrumentFor = (note: ExportedNote): number => {
    const key = `${note.instrument}:${note.percussion ? note.drum ?? "" : ""}`;
    let id = instMap.get(key);
    if (id !== undefined) return id;
    const inst = exported.get(note.instrument);
    id = instMap.size + 1;
    if (id >= GT.MAX_INSTR) throw new InterchangeLimitError(`the score uses more than ${GT.MAX_INSTR - 1} instruments`);
    instMap.set(key, id);
    const out = instruments[id]!;
    const wave = inst ? waveByte(inst) : 0x40;
    const gated = wave | 0x01;
    out.ad = inst ? (inst.adsr[0] << 4) | inst.adsr[1] : 0x09;
    out.sr = inst ? (inst.adsr[2] << 4) | inst.adsr[3] : 0xa4;
    out.name = (inst?.name ?? `inst ${note.instrument}`).replace(/^lib:/, "").slice(0, 15);
    out.gatetimer = 2;
    out.firstwave = 0x09;
    // Wavetable: one step per arpeggio tone (held for the tone's calls), then a jump back (arpeggio) or stop.
    const steps: Array<[number, number]> = [];
    let loopTo = -1;
    if (inst?.arpeggio && inst.arpeggio.offsets.length > 1) {
      loopTo = 0;
      for (const offset of inst.arpeggio.offsets) {
        steps.push([gated, offset & 0x7f]);
        if (inst.arpeggio.callsPerStep > 1) steps.push([Math.min(0x0f, inst.arpeggio.callsPerStep - 1), 0x80]);
      }
    } else steps.push([gated, 0x00]);
    if (wlen + steps.length + 1 > GT.MAX_TABLELEN) throw new InterchangeLimitError("the wavetables of the instruments do not fit the 255 entries of a GoatTracker table");
    out.ptr[GT.WTBL] = wlen + 1;
    for (const [l, r] of steps) { ltable[GT.WTBL]![wlen] = l; rtable[GT.WTBL]![wlen] = r; wlen++; }
    ltable[GT.WTBL]![wlen] = 0xff; rtable[GT.WTBL]![wlen] = loopTo >= 0 ? out.ptr[GT.WTBL] + loopTo : 0; wlen++;
    if (inst?.pulseWidth !== undefined && (wave & 0x40)) {
      const pw = Math.max(1, Math.min(4095, inst.pulseWidth));
      if (plen + 2 > GT.MAX_TABLELEN) throw new InterchangeLimitError("the pulse tables of the instruments do not fit the 255 entries of a GoatTracker table");
      out.ptr[GT.PTBL] = plen + 1;
      ltable[GT.PTBL]![plen] = 0x80 | (pw >> 8); rtable[GT.PTBL]![plen] = pw & 0xff; plen++;
      ltable[GT.PTBL]![plen] = 0xff; rtable[GT.PTBL]![plen] = 0; plen++;
    }
    if (inst?.tables.filter || inst?.filterRouted) usedFilter = true;
    if (inst?.vibrato) usedVibrato = true;
    if (inst?.slide) usedSlide = true;
    if (inst?.tables.wave) usedWavetable = true;
    return id;
  };

  // Rows per voice.
  const maxMidi = GT.LASTNOTE - GT.FIRSTNOTE + 12;
  let shifted = 0, glides = 0;
  const channelRows: Uint8Array[] = [];
  for (const [vi, voice] of voices.entries()) {
    const data = new Uint8Array(rows * 4);
    for (let r = 0; r < rows; r++) data[r * 4] = GT.REST;
    const notes = [...voice.notes].sort((a, b) => a.on.tick - b.on.tick || a.id - b.id);
    for (const [ni, note] of notes.entries()) {
      const row = Math.min(rows - 1, Math.round(frameOf(note.on.time) / ticks));
      let pitch = note.pitch;
      const original = pitch;
      while (pitch < 12) pitch += 12;
      while (pitch > maxMidi) pitch -= 12;
      if (pitch !== original) shifted++;
      if (note.effects?.bend) glides++;
      if (data[row * 4] !== GT.REST) { warnings.push(`Voice ${vi + 1}: two notes fall on row ${row}; the later one is dropped.`); continue; }
      data[row * 4] = pitch - 12 + GT.FIRSTNOTE;
      data[row * 4 + 1] = instrumentFor(note);
      const next = notes[ni + 1];
      const offRow = Math.min(rows - 1, Math.max(row + 1, Math.round(frameOf(note.off.time) / ticks)));
      const nextRow = next ? Math.round(frameOf(next.on.time) / ticks) : rows;
      if (offRow < nextRow && offRow < rows && data[offRow * 4] === GT.REST) data[offRow * 4] = GT.KEYOFF;
    }
    channelRows.push(data);
  }
  while (channelRows.length < 3) { const empty = new Uint8Array(rows * 4); for (let r = 0; r < rows; r++) empty[r * 4] = GT.REST; channelRows.push(empty); }
  channelRows[0]![2] = GT.CMD_SETTEMPO;
  channelRows[0]![3] = ticks;
  if (shifted) losses.push(`${shifted} notes are outside the GoatTracker range C0 to G#7 and were moved by octaves.`);
  if (glides) losses.push(`${glides} glides and portamento notes are exported as plain notes.`);
  if (usedFilter) losses.push("Filter settings and filter tables are not exported.");
  if (usedVibrato) losses.push("Vibrato is not exported.");
  if (usedSlide) losses.push("Instrument slides are not exported.");
  if (usedWavetable) losses.push("Wavetable steps of an instrument are not exported (the instrument plays its waveform; arpeggios are kept).");
  losses.push("Pulse width modulation, ring and sync partners, hard restart settings, level and chip volume changes are not exported; every instrument uses GoatTracker's default hard restart of 2 calls.");
  losses.push("Rows are whole multiples of the row length; note starts and ends are moved to the nearest row.");

  // Patterns and order lists (identical chunks share one pattern).
  const patterns: Uint8Array[] = [];
  const seen = new Map<string, number>();
  const lists: Uint8Array[] = [];
  const chunks = Math.ceil(rows / PATTERN_ROWS);
  for (const data of channelRows) {
    const order: number[] = [];
    for (let k = 0; k < chunks; k++) {
      const from = k * PATTERN_ROWS, to = Math.min(rows, from + PATTERN_ROWS);
      const chunk = new Uint8Array((to - from + 1) * 4);
      chunk.set(data.subarray(from * 4, to * 4));
      chunk[(to - from) * 4] = GT.ENDPATT;
      const key = Buffer.from(chunk).toString("latin1");
      let id = seen.get(key);
      if (id === undefined) {
        id = patterns.length;
        if (id >= GT.MAX_PATT) throw new InterchangeLimitError(`the score needs more than ${GT.MAX_PATT} patterns`);
        patterns.push(chunk);
        seen.set(key, id);
      }
      order.push(id);
    }
    if (order.length > GT.MAX_SONGLEN) throw new InterchangeLimitError("the order list is longer than GoatTracker allows");
    lists.push(Uint8Array.from([...order, GT.LOOPSONG, 0]));
  }
  const bytes = writeGoatTracker({ name: score.title, author: score.author ?? "", copyright: "", songs: [lists], instruments, ltable, rtable, patterns });
  return { bytes, ticksPerRow: ticks, maxTimingErrorCalls: best, rows, patterns: patterns.length, instruments: instMap.size, voices: voices.length, losses: [...new Set(losses)], warnings };
}
