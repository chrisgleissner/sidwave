// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID-Wizard export: a SIDWave score becomes a `.swm` module for the subset that the module format expresses:
// up to three pitched voices, notes with gate-off, instruments with waveform, ADSR and pulse width, a constant
// tempo. Everything else is listed in the result's `losses`. Mapping: doc/interchange.md.

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type ExportedInstrument, type ExportedScore } from "./events.js";
import { SWM_WRITE_MAX_INSTRUMENTS, SWM_WRITE_MAX_PATTERNS, defaultSwmHeader, SwmError, SWM_NOTEFX, writeSwm, writeSwi, type SwmInstrument, type SwmModule, type SwmPattern, type SwmRow } from "./swm.js";

export interface SwmExportOptions {
  /** Song of a document with `songs` (0-based). */
  song?: number;
  /** Rows per pattern: 16, 32 or 64. Default 32. */
  patternRows?: number;
  /** Voices chosen by the convert hub's ScorePlan, and its event export of the song. */
  voiceIds?: readonly number[];
  source?: ExportedScore;
}

export interface SwmExportResult {
  bytes: Uint8Array;
  report: {
    speed: number;
    callsPerRow: number;
    rows: number;
    patterns: number;
    instruments: Array<{ number: number; name: string; scoreInstrument: number }>;
    tracks: Array<{ voice: number; id: number; notes: number }>;
    losses: string[];
  };
}

const gcd = (a: number, b: number): number => { while (b) [a, b] = [b, a % b]; return a; };
const WAVE_BITS: Array<[string, number]> = [["tri", 0x10], ["saw", 0x20], ["pulse", 0x40], ["noise", 0x80]];

/** The SWM instrument for a score instrument: waveform, ADSR and pulse width; the first-frame test waveform and hard restart as in the editor's default. */
export function swmInstrumentFor(inst: ExportedInstrument, name: string): SwmInstrument {
  let wave = 0;
  for (const [part, bit] of WAVE_BITS) if (inst.waveform.includes(part)) wave |= bit;
  if (wave === 0) wave = 0x10;
  if (inst.ring) wave |= 4;
  if (inst.sync) wave |= 2;
  const wf = [wave | 1, 0, 0, 0xff];
  const pw = inst.pulseWidth !== undefined && wave & 0x40 ? [0x80 | ((inst.pulseWidth >> 8) & 0x0f), inst.pulseWidth & 0xff, 0, 0xff] : [0xff];
  const data = new Uint8Array(16 + wf.length + pw.length);
  data.set([0x1a, 0x0f, 0x00, (inst.adsr[0] << 4) | inst.adsr[1], (inst.adsr[2] << 4) | inst.adsr[3], 0, 0, 0, 1, 0, 16 + wf.length, data.length, 0, 0, 0, 0x09], 0);
  data.set(wf, 16);
  data.set(pw, 16 + wf.length);
  return { name: name.toUpperCase().replace(/[^\x20-\x7e]/g, "?").slice(0, 8), data };
}

export function exportSwm(doc: ParsedSidwave, options: SwmExportOptions = {}): SwmExportResult {
  const ev = exportEvents(doc, { ...(options.song === undefined ? {} : { song: options.song }), ...(options.voiceIds ? { voiceIds: options.voiceIds } : {}), ...(options.source ? { source: options.source } : {}) });
  const losses: string[] = [];
  const frameRate = ev.mode === "PAL" ? 985_248 / 19_656 : 1_022_727 / 17_095;
  const speed = Math.round(ev.callRate / frameRate);
  if (speed < 1 || speed > 8 || Math.abs(ev.callRate - speed * frameRate) > 1e-6 * frameRate) throw new SwmError(`the score's player speed (${ev.callRate.toFixed(3)} calls per second) is not a whole number of calls per frame from 1 to 8`);
  const pitched = ev.voices.filter((v) => v.kind === "pitched" && v.notes.length > 0);
  const dropped = ev.voices.filter((v) => v.kind === "drums" && v.notes.length > 0);
  if (dropped.length) losses.push(`Drum voices (${dropped.map((v) => `v${v.id}`).join(", ")}) are not exported: SID-Wizard drums are instruments, which this export does not build from SIDWave kits.`);
  const voices = options.voiceIds ? pitched.slice(0, 3) : pitched.filter((v) => v.sid === 0).slice(0, 3);
  const others = pitched.filter((v) => !voices.includes(v));
  if (others.length) losses.push(`Voices ${others.map((v) => `v${v.id}`).join(", ")} are not exported: an SWM module has three tracks (one SID).`);
  if (voices.length === 0) throw new SwmError("the score has no pitched voice on the first SID to export");

  const call = (seconds: number): number => Math.round(seconds * ev.callRate);
  let g = 0;
  const total = call(ev.durationSeconds);
  g = gcd(g, total);
  for (const v of voices) for (const n of v.notes) { g = gcd(g, call(n.on.time)); g = gcd(g, call(n.off.time)); }
  if (g === 0) g = 1;
  let rowCalls = g;
  if (rowCalls > 127) { rowCalls = 127; while (g % rowCalls) rowCalls--; }
  const rowCount = Math.max(1, Math.ceil(total / rowCalls));
  if (rowCalls < 2) losses.push("Rows are one player call long (note starts and ends fall on odd calls): the module is correct but large and uses the fastest tempo.");

  // Instruments.
  const instrumentIndex = new Map<number, number>();
  const instruments: SwmInstrument[] = [];
  const instReport: SwmExportResult["report"]["instruments"] = [];
  const unexpressible = new Set<string>();
  for (const v of voices) for (const n of v.notes) {
    if (instrumentIndex.has(n.instrument)) continue;
    const src = ev.instruments.find((i) => i.index === n.instrument);
    if (!src) throw new SwmError(`note refers to unknown instrument ${n.instrument}`);
    if (instruments.length >= SWM_WRITE_MAX_INSTRUMENTS) throw new SwmError(`the score uses more than ${SWM_WRITE_MAX_INSTRUMENTS} instruments`);
    const label = src.name ?? `inst ${instruments.length + 1}`;
    const name = label.replace(/^lib:/, "").replace(/_/g, " ");
    if (src.vibrato) unexpressible.add(`${label}: vibrato`);
    if (src.arpeggio) unexpressible.add(`${label}: arpeggio`);
    if (src.slide) unexpressible.add(`${label}: slide`);
    if (src.tables.wave) unexpressible.add(`${label}: wavetable`);
    if (src.tables.pulse) unexpressible.add(`${label}: pulse table (the first pulse width is written)`);
    if (src.tables.filter || src.filterRouted) unexpressible.add(`${label}: filter`);
    instruments.push(swmInstrumentFor(src, name));
    instrumentIndex.set(n.instrument, instruments.length);
    instReport.push({ number: instruments.length, name: instruments[instruments.length - 1]!.name, scoreInstrument: n.instrument });
  }
  for (const u of unexpressible) losses.push(`Instrument ${u} is not exported.`);

  // Rows per track.
  const trackRows: SwmRow[][] = [0, 1, 2].map(() => Array.from({ length: rowCount }, () => ({ note: 0 })));
  const trackReport: SwmExportResult["report"]["tracks"] = [];
  let folded = 0, effectsLost = 0;
  voices.forEach((v, t) => {
    const rows = trackRows[t]!;
    const sorted = [...v.notes].sort((a, b) => a.on.time - b.on.time);
    sorted.forEach((n, k) => {
      const on = call(n.on.time) / rowCalls, off = call(n.off.time) / rowCalls;
      let pitch = n.pitch;
      while (pitch < 12) { pitch += 12; folded++; }
      while (pitch > 106) { pitch -= 12; folded++; }
      if (n.effects && (n.effects.bend || n.effects.chord || n.effects.legato || n.effects.gateOffSeconds !== undefined)) effectsLost++;
      if (on < rowCount) rows[on] = { note: pitch - 11, inst: instrumentIndex.get(n.instrument)! };
      const next = sorted[k + 1] ? call(sorted[k + 1]!.on.time) / rowCalls : Infinity;
      if (off < next && off < rowCount && off > on) rows[off] = { note: SWM_NOTEFX.gateOff };
    });
    trackReport.push({ voice: v.index + 1, id: v.id, notes: v.notes.length });
  });
  if (folded) losses.push(`${folded} notes lie outside the SID-Wizard range C-0 to A#7 (MIDI 12 to 106) and were moved by octaves.`);
  if (effectsLost) losses.push(`${effectsLost} notes carry bends, chord arpeggios, legato or an early gate-off that SID-Wizard rows of this export do not express.`);
  // Each part of what the module cannot hold is reported only when the score uses it.
  const velocities = new Set(voices.flatMap((v) => v.notes.map((n) => n.velocity))).size;
  if (velocities > 1) losses.push(`Note velocities (${velocities} distinct values) are not exported; the module plays at full volume.`);
  const copies = doc.voices.filter((v) => (v as { echo?: unknown; unison?: unknown; follow?: unknown }).echo || (v as { unison?: unknown }).unison || (v as { follow?: unknown }).follow).length;
  if (copies) losses.push(`${copies} voices are echo, unison or follow copies of another voice; the copies are not exported.`);
  if (ev.tempoMap.length > 1) losses.push(`${ev.tempoMap.length - 1} tempo changes are not exported; the module has one tempo.`);
  if (doc.swing) losses.push("Swing is not exported.");
  if (doc.sids.some((sid) => sid.filter) || doc.song.global_fx.filter_env) losses.push("The SID filter settings of the score are not exported.");

  // Patterns and orderlists.
  const P = options.patternRows ?? 32;
  if (![16, 32, 64].includes(P)) throw new RangeError("patternRows must be 16, 32 or 64");
  const chunks = Math.ceil(rowCount / P);
  if (chunks > 124) throw new SwmError(`the song needs ${chunks} patterns per track; an SWM orderlist holds 124. Use patternRows 64 or a shorter score`);
  const patterns: SwmPattern[] = [];
  const byKey = new Map<string, number>();
  const sequences: Uint8Array[] = [];
  for (let t = 0; t < 3; t++) {
    const order: number[] = [];
    if (t < voices.length) {
      for (let c = 0; c < chunks; c++) {
        const rows = trackRows[t]!.slice(c * P, (c + 1) * P);
        while (rows.length < P) rows.push({ note: 0 });
        const key = JSON.stringify(rows);
        let n = byKey.get(key);
        if (n === undefined) {
          if (patterns.length >= SWM_WRITE_MAX_PATTERNS) throw new SwmError(`the song needs more than ${SWM_WRITE_MAX_PATTERNS} distinct patterns`);
          patterns.push({ length: P, rows });
          n = patterns.length;
          byKey.set(key, n);
        }
        order.push(n);
      }
      order.push(0xff, 0x00);
    } else order.push(0xfe);
    sequences.push(Uint8Array.from(order));
  }
  const header = doc.song.title ? `${(ev.author ?? "").slice(0, 16)}:${ev.title.slice(0, 22)}` : ev.author ?? "";
  const module: SwmModule = {
    kind: "swm", loadAddress: 0x3333, speed, defaultPatternLength: P, driver: 0, tuning: 0, author: header.slice(0, 40),
    sequences, patterns, instruments, chordTable: Uint8Array.of(0x00, 0x7f), tempoTable: new Uint8Array(0),
    subtuneTempos: [[rowCalls | 0x80, rowCalls | 0x80]], header: defaultSwmHeader(),
  };
  const bytes = writeSwm(module);
  return { bytes, report: { speed, callsPerRow: rowCalls, rows: rowCount, patterns: patterns.length, instruments: instReport, tracks: trackReport, losses } };
}

/** Writes one score instrument as an `.swi` file. */
export function exportSwi(doc: ParsedSidwave, which: string | number, options: { song?: number } = {}): { bytes: Uint8Array; losses: string[] } {
  const ev = exportEvents(doc, { ...(options.song === undefined ? {} : { song: options.song }) });
  const src = ev.instruments.find((i) => (typeof which === "number" ? i.index === which : i.name === which || i.name === `lib:${which}`));
  if (!src) throw new SwmError(`the score has no instrument "${which}"; instruments used by notes: ${ev.instruments.map((i) => i.name ?? `#${i.index}`).join(", ") || "none"}`);
  const losses: string[] = [];
  if (src.vibrato) losses.push("vibrato"); if (src.arpeggio) losses.push("arpeggio"); if (src.slide) losses.push("slide");
  if (src.tables.wave) losses.push("wavetable"); if (src.tables.pulse) losses.push("pulse table"); if (src.tables.filter || src.filterRouted) losses.push("filter");
  return { bytes: writeSwi(swmInstrumentFor(src, (src.name ?? "inst").replace(/^lib:/, "").replace(/_/g, " "))), losses: losses.map((l) => `${l} is not exported`) };
}
