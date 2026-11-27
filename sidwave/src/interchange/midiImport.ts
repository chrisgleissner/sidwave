// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Standard MIDI File import: type 0 and 1 files become a SIDWave 1.3 score (YAML text) plus a report.

import yaml, { isMap, isScalar, isSeq } from "yaml";
import { SidwaveValidationError, midiToNoteName, parseSidwave } from "../sidwave.js";
import { compileSidwaveToPrg, maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { IMPORT_DRUMS, instrumentForProgram, type ImportInstrument } from "./gm.js";
import { MidiError, parseSmf, type MidiEvent, type SmfLimits } from "./smf.js";

export interface MidiImportOptions {
  title?: string;
  /** Quantisation grid in quarter-note beats. Default 0.25 (a sixteenth note in x/4 metres). */
  grid?: number;
  /** SIDWave voices to allocate, 1..3 (one SID). Default 3. */
  voices?: number;
  /** Import the percussion channel as a drum voice. Default true. */
  drums?: boolean;
  /** Import pitch bend that moves a note to another pitch as a SIDWave bend. Default true. */
  bend?: boolean;
  mode?: "PAL" | "NTSC";
  /** Compile the result to prove that SIDWave accepts it. Default true. */
  validate?: boolean;
  limits?: SmfLimits & { maxBars?: number; maxCells?: number };
}

export interface ImportedVoiceReport {
  id: number;
  role: "drums" | "bass" | "melodic";
  source: { track: number; channel: number; name?: string; program?: number };
  instrument?: string;
  notes: number;
  /** Notes of the source part that are not in the output because another note sounded at the same time (skyline rule). */
  droppedPolyphony: number;
  /** Notes cut short because a later note took over the voice. */
  truncated: number;
  /** Notes moved by octaves into the playable range. */
  octaveShifted: number;
  /** Notes that gained a SIDWave bend from pitch bend events. */
  bends: number;
  /** Source notes that carry pitch bend with no net pitch change (vibrato) and were not imported as bends. */
  bendsLost: number;
  /** Drum hits dropped: unknown percussion key, or another hit in the same cell had priority. */
  droppedHits?: number;
}

export interface ImportReport {
  format: 0 | 1 | 2;
  ppq: number;
  gridBeats: number;
  bars: number;
  voices: ImportedVoiceReport[];
  droppedParts: Array<{ track: number; channel: number; name?: string; notes: number; reason: string }>;
  /** Onset errors of every source note against the grid; `maxEndErrorTicks` is the largest error of a note end (note lengths are rounded to whole cells). */
  quantisation: { notes: number; moved: number; maxErrorTicks: number; meanErrorTicks: number; maxErrorMs: number; maxEndErrorTicks: number };
  tempoChanges: { total: number; atBarLine: number; movedToBarLine: number; clamped: number };
  timeSignatures: Array<{ bar: number; signature: string; sidwave: string }>;
  losses: string[];
  warnings: string[];
}

export interface MidiImportResult { yaml: string; report: ImportReport }

export class MidiImportError extends Error {
  constructor(message: string, readonly yaml?: string) { super(message); this.name = "MidiImportError"; }
}

const SIGNATURES_BY_BEATS: Record<string, string> = { "2": "2/4", "3": "3/4", "4": "4/4", "5": "5/4", "3.5": "7/8", "4.5": "9/8", "6": "12/8" };
const SUPPORTED = new Set(["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "9/8", "12/8"]);

interface Note { s: number; e: number; pitch: number; vel: number; startTick: number; endTick: number }
interface Part {
  track: number; channel: number; name?: string; program?: number; drum: boolean; notes: Note[];
  bends: Array<{ tick: number; value: number }>; rangeChanges: Array<{ tick: number; semitones: number }>;
}

function normaliseSignature(numerator: number, denominator: number): { text: string; sidwave: string; beats: number } {
  const text = `${numerator}/${denominator}`;
  const beats = numerator * 4 / denominator;
  if (SUPPORTED.has(text)) return { text, sidwave: text, beats };
  const equal = SIGNATURES_BY_BEATS[String(beats)];
  if (equal) return { text, sidwave: equal, beats };
  throw new MidiImportError(`the time signature ${text} (${beats} quarter notes per bar) has no SIDWave equivalent; supported: ${[...SUPPORTED].join(", ")}`);
}

/** Index of the last element with `tick <= t` in an array sorted by tick, or -1. */
function lastAtOrBefore(list: ReadonlyArray<{ tick: number }>, t: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]!.tick <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}


/** Imports a Standard MIDI File as SIDWave text. See doc/interchange.md for the allocation, quantisation and loss rules. */
export function importMidi(bytes: Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const grid = options.grid ?? 0.25;
  if (!(grid >= 1 / 48 && grid <= 4)) throw new RangeError("grid must be between 1/48 and 4 beats");
  const voiceLimit = options.voices ?? 3;
  if (!Number.isInteger(voiceLimit) || voiceLimit < 1 || voiceLimit > 3) throw new RangeError("voices must be 1, 2 or 3 (one SID)");
  const mode = options.mode ?? "PAL";
  const maxBars = options.limits?.maxBars ?? 2048;
  const maxCells = options.limits?.maxCells ?? 400_000;
  let smf;
  try { smf = parseSmf(bytes, options.limits); } catch (error) {
    if (error instanceof MidiError) throw new MidiImportError(error.message);
    throw error;
  }
  const ppq = smf.division;
  const cellTicks = ppq * grid;
  const losses: string[] = [];
  const warnings: string[] = [];

  // Meta events from every track, in tick order.
  const all = smf.tracks.flatMap((track, index) => track.map((event) => ({ event, track: index })));
  const tempos = all.filter((x) => x.event.type === "tempo").map((x) => x.event as Extract<MidiEvent, { type: "tempo" }>)
    .sort((a, b) => a.tick - b.tick);
  const sigs = all.filter((x) => x.event.type === "timeSignature").map((x) => x.event as Extract<MidiEvent, { type: "timeSignature" }>)
    .sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0) warnings.push("The file has no tempo event; 120 BPM is assumed.");
  const microsecondsAt = (tick: number): number => {
    const i = lastAtOrBefore(tempos, tick);
    return i < 0 ? 500_000 : tempos[i]!.microsecondsPerQuarter;
  };

  // Parts: notes per (track, channel).
  const parts = new Map<string, Part>();
  const open = new Map<string, { tick: number; vel: number }>();
  let lastTick = 0;
  const part = (track: number, channel: number): Part => {
    const key = `${track}:${channel}`;
    let entry = parts.get(key);
    if (!entry) { entry = { track, channel, drum: channel === 9, notes: [], bends: [], rangeChanges: [], program: undefined }; parts.set(key, entry); }
    return entry;
  };
  const trackNames = smf.tracks.map((track) => track.find((e) => e.type === "text" && e.kind === 0x03) as Extract<MidiEvent, { type: "text" }> | undefined);
  const close = (key: string, track: number, channel: number, note: number, tick: number) => {
    const started = open.get(key);
    if (!started) return;
    open.delete(key);
    part(track, channel).notes.push({ s: 0, e: 0, pitch: note, vel: started.vel, startTick: started.tick, endTick: Math.max(tick, started.tick) });
  };
  const rpnState = new Map<string, { msb: number; lsb: number }>();
  for (const [trackIndex, track] of smf.tracks.entries()) {
    for (const event of track) {
      lastTick = Math.max(lastTick, event.tick);
      if (event.type === "noteOn") {
        const key = `${trackIndex}:${event.channel}:${event.note}`;
        close(key, trackIndex, event.channel, event.note, event.tick);
        open.set(key, { tick: event.tick, vel: event.velocity });
        part(trackIndex, event.channel);
      } else if (event.type === "noteOff") {
        close(`${trackIndex}:${event.channel}:${event.note}`, trackIndex, event.channel, event.note, event.tick);
      } else if (event.type === "program") {
        const p = part(trackIndex, event.channel);
        p.program ??= event.program;
      } else if (event.type === "pitchBend") {
        part(trackIndex, event.channel).bends.push({ tick: event.tick, value: event.value });
      } else if (event.type === "controller") {
        const k = `${trackIndex}:${event.channel}`;
        const state = rpnState.get(k) ?? { msb: 127, lsb: 127 };
        if (event.controller === 101) state.msb = event.value;
        else if (event.controller === 100) state.lsb = event.value;
        else if (event.controller === 6 && state.msb === 0 && state.lsb === 0) part(trackIndex, event.channel).rangeChanges.push({ tick: event.tick, semitones: event.value });
        rpnState.set(k, state);
      }
    }
  }
  for (const [key, started] of [...open]) {
    const [t, c, n] = key.split(":").map(Number) as [number, number, number];
    close(key, t, c, n, lastTick);
    void started;
  }
  const withNotes = [...parts.values()].filter((p) => p.notes.length > 0);
  if (withNotes.length === 0) throw new MidiImportError("the MIDI file contains no notes");
  for (const p of withNotes) {
    const t = trackNames[p.track];
    if (t && !p.drum) p.name = t.text.trim().replace(/^v\d+\s+/, "") || undefined;
    p.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
    p.bends.sort((a, b) => a.tick - b.tick);
  }
  let endTick = 0;
  for (const p of withNotes) for (const n of p.notes) if (n.endTick > endTick) endTick = n.endTick;

  // Bars from the time signature map. A signature that does not start on a bar line takes effect at the next bar line.
  interface Bar { start: number; ticks: number; sig: ReturnType<typeof normaliseSignature>; cells: number; cellStart: number }
  const bars: Bar[] = [];
  const signatureReport: ImportReport["timeSignatures"] = [];
  let cursor = 0;
  let sigIndex = 0;
  let sig = normaliseSignature(4, 4);
  let cells = 0;
  while (cursor < endTick || bars.length === 0) {
    let changed = false;
    while (sigIndex < sigs.length && sigs[sigIndex]!.tick <= cursor) {
      const ev = sigs[sigIndex++]!;
      sig = normaliseSignature(ev.numerator, ev.denominator);
      changed = true;
      if (ev.tick !== cursor) warnings.push(`The time signature ${sig.text} at tick ${ev.tick} is not on a bar line; it starts at the next bar line (tick ${cursor}).`);
    }
    if (changed || bars.length === 0) signatureReport.push({ bar: bars.length + 1, signature: sig.text, sidwave: sig.sidwave });
    const perBar = sig.beats / grid;
    if (Math.abs(perBar - Math.round(perBar)) > 1e-9) throw new MidiImportError(`the grid of ${grid} beats does not divide a ${sig.text} bar (${sig.beats} beats); choose a grid such as 0.25, 0.125 or 0.5`);
    const ticks = sig.beats * ppq;
    bars.push({ start: cursor, ticks, sig, cells: Math.round(perBar), cellStart: cells });
    cells += Math.round(perBar);
    cursor += ticks;
    if (bars.length > maxBars) throw new MidiImportError(`the piece has more than ${maxBars} bars`);
    if (cells > maxCells) throw new MidiImportError(`the piece has more than ${maxCells} grid cells`);
  }
  const totalCells = cells;
  if (sigIndex < sigs.length && sigs.slice(sigIndex).some((s) => s.tick > cursor)) warnings.push("Time signature events after the last note are ignored.");
  if (signatureReport.some((s) => s.signature !== s.sidwave)) losses.push("A time signature without a SIDWave equivalent is written with a SIDWave metre of the same bar length.");

  const barIndexOf = (tick: number): number => {
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (bars[mid]!.start <= tick) lo = mid; else hi = mid - 1; }
    return lo;
  };
  let movedCount = 0, noteTotal = 0, errTicks = 0, errMax = 0, errMaxMs = 0;
  let endErrMax = 0;
  const cellOf = (tick: number, onset: boolean): number => {
    const bar = bars[barIndexOf(tick)]!;
    const local = (tick - bar.start) / cellTicks;
    const rounded = Math.round(local);
    const err = Math.abs(rounded - local) * cellTicks;
    if (onset) {
      noteTotal++;
      errTicks += err;
      if (err > 1e-6) movedCount++;
      errMax = Math.max(errMax, err);
      errMaxMs = Math.max(errMaxMs, err * microsecondsAt(tick) / ppq / 1000);
    } else endErrMax = Math.max(endErrMax, err);
    return Math.min(totalCells, bar.cellStart + rounded);
  };
  for (const p of withNotes) for (const n of p.notes) {
    n.s = cellOf(n.startTick, true);
    n.e = Math.max(n.s + 1, Math.min(totalCells, cellOf(n.endTick, false)));
    if (n.s >= totalCells) { n.s = totalCells - 1; n.e = totalCells; }
  }

  // Voice allocation.
  const rank = (p: Part): number => {
    let low = 127, high = 0;
    for (const n of p.notes) { if (n.pitch < low) low = n.pitch; if (n.pitch > high) high = n.pitch; }
    return p.notes.length * (1 + (high - low) / 12);
  };
  const droppedParts: ImportReport["droppedParts"] = [];
  const drumParts = withNotes.filter((p) => p.drum);
  const melodic = withNotes.filter((p) => !p.drum).sort((a, b) => rank(b) - rank(a) || a.track - b.track || a.channel - b.channel);
  const chosen: Part[] = [];
  const drumPart = drumParts.length ? drumParts.sort((a, b) => b.notes.length - a.notes.length)[0] : undefined;
  if (drumPart && options.drums !== false) chosen.push(drumPart);
  else if (drumPart) droppedParts.push({ track: drumPart.track, channel: drumPart.channel, notes: drumPart.notes.length, reason: "drums disabled" });
  for (const extra of drumParts.slice(1)) droppedParts.push({ track: extra.track, channel: extra.channel, name: extra.name, notes: extra.notes.length, reason: "only one drum voice is allocated" });
  for (const p of melodic) {
    if (chosen.length < voiceLimit) chosen.push(p);
    else droppedParts.push({ track: p.track, channel: p.channel, ...(p.name ? { name: p.name } : {}), notes: p.notes.length, reason: `all ${voiceLimit} voices are taken by parts with higher importance` });
  }
  // Voice order: melodic by importance, drums last (so v1 is the most important melody).
  chosen.sort((a, b) => Number(a.drum) - Number(b.drum));
  if (droppedParts.length) losses.push(`${droppedParts.reduce((n, d) => n + d.notes, 0)} notes of ${droppedParts.length} source part(s) do not fit in ${voiceLimit} voices and are not imported (${droppedParts.map((d) => `${d.name ?? `track ${d.track} channel ${d.channel}`}: ${d.notes} notes`).join('; ')}).`);

  const maxMidi = maxSidwaveMidi(mode);
  const fps = sidwaveFrameRate(mode);
  const instruments = new Map<string, ImportInstrument>();
  const voiceDefs: Array<Record<string, unknown>> = [];
  const voiceCells: Array<Array<{ pitch?: number; level?: number; bend?: { to: number; frames: number }; kind: "note" | "tie" | "rest"; drum?: string }>> = [];
  const voiceReports: ImportedVoiceReport[] = [];
  const bendDefault = options.bend !== false;

  for (const [index, p] of chosen.entries()) {
    const id = index + 1;
    const report: ImportedVoiceReport = {
      id, role: p.drum ? "drums" : "melodic", source: { track: p.track, channel: p.channel, ...(p.name ? { name: p.name } : {}), ...(p.program === undefined ? {} : { program: p.program }) },
      notes: 0, droppedPolyphony: 0, truncated: 0, octaveShifted: 0, bends: 0, bendsLost: 0,
    };
    const cellsOut: typeof voiceCells[number] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    if (p.drum) {
      report.droppedHits = 0;
      const byCell = new Map<number, Note[]>();
      for (const n of p.notes) (byCell.get(n.s) ?? byCell.set(n.s, []).get(n.s)!).push(n);
      for (const [cell, hits] of byCell) {
        const known = hits.filter((n) => IMPORT_DRUMS[n.pitch]);
        report.droppedHits += hits.length - known.length;
        if (!known.length) continue;
        known.sort((a, b) => IMPORT_DRUMS[b.pitch]!.priority - IMPORT_DRUMS[a.pitch]!.priority);
        report.droppedHits += known.length - 1;
        cellsOut[cell] = { kind: "note", drum: IMPORT_DRUMS[known[0]!.pitch]!.letter };
        report.notes++;
      }
      if (report.droppedHits) losses.push(`Drum voice: ${report.droppedHits} hits dropped (unknown percussion key, or lower priority than a simultaneous hit); drum velocity is not imported.`);
    } else {
      const sorted = [...p.notes].sort((a, b) => a.s - b.s || a.pitch - b.pitch);
      const median = [...p.notes].map((n) => n.pitch).sort((a, b) => a - b)[Math.floor(p.notes.length / 2)]!;
      const bass = median < 48;
      report.role = bass ? "bass" : "melodic";
      const better = (a: Note, b: Note) => bass ? a.pitch < b.pitch : a.pitch > b.pitch;
      let idx = 0;
      let current: Note | undefined;
      const selected = new Set<Note>();
      for (let c = 0; c < totalCells; c++) {
        const starting: Note[] = [];
        while (idx < sorted.length && sorted[idx]!.s === c) starting.push(sorted[idx++]!);
        if (current && current.e <= c) current = undefined;
        if (!current && starting.length === 0) continue;
        let best: Note | undefined = current;
        for (const candidate of starting) {
          if (!best) best = candidate;
          else if (candidate.pitch === current?.pitch) best = candidate;
          else if (best === current && better(candidate, best)) best = candidate;
          else if (best !== current && better(candidate, best)) best = candidate;
        }
        if (best === current) {
          report.droppedPolyphony += starting.length;
          cellsOut[c] = { kind: "tie" };
        } else {
          if (current && current.e > c) report.truncated++;
          report.droppedPolyphony += starting.length - 1;
          current = best!;
          selected.add(current);
          cellsOut[c] = { kind: "note", pitch: current.pitch };
        }
      }
      report.notes = selected.size;
      // Rebuild from the selections so that a note sounds for its quantised length, cut at the next selected note.
      const picks = [...selected].sort((a, b) => a.s - b.s);
      for (let c = 0; c < totalCells; c++) cellsOut[c] = { kind: "rest" };
      for (const [k, n] of picks.entries()) {
        const next = picks[k + 1];
        const end = Math.min(n.e, next ? next.s : n.e);
        let pitch = n.pitch;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) report.octaveShifted++;
        // Pitch bend: the state at the note start sets the written pitch; a later net change becomes a SIDWave bend.
        let bend: { to: number; frames: number } | undefined;
        const range = (tick: number) => { const i = lastAtOrBefore(p.rangeChanges, tick); return i < 0 ? 2 : p.rangeChanges[i]!.semitones; };
        const stateAt = (tick: number) => { const i = lastAtOrBefore(p.bends, tick); return ((i < 0 ? 8192 : p.bends[i]!.value) - 8192) / 8192 * range(tick); };
        // Bends are in tick order, so the ones inside the note are a contiguous slice found by binary search.
        const inside = p.bends.slice(lastAtOrBefore(p.bends, n.startTick) + 1, lastAtOrBefore(p.bends, n.endTick - 1) + 1);
        const begin = stateAt(n.startTick);
        if (bendDefault && (inside.length || Math.abs(begin) >= 0.5) && !p.drum) {
          const startShift = Math.round(begin);
          if (startShift !== 0) pitch = Math.max(12, Math.min(maxMidi, pitch + startShift));
          if (inside.length) {
            const finalSemis = (inside[inside.length - 1]!.value - 8192) / 8192 * range(inside[inside.length - 1]!.tick);
            const diff = Math.round(finalSemis - startShift);
            const seconds = (inside[inside.length - 1]!.tick - n.startTick) * microsecondsAt(n.startTick) / ppq / 1e6;
            const length = (end - n.s) * cellTicks * microsecondsAt(n.startTick) / ppq / 1e6;
            const frames = Math.max(1, Math.min(Math.floor(length * fps) - 2, Math.round(seconds * fps)));
            if (diff !== 0 && pitch + diff >= 12 && pitch + diff <= maxMidi && frames >= 1 && length * fps >= 5) { bend = { to: diff, frames }; report.bends++; }
            else report.bendsLost++;
          }
        } else if (inside.length) report.bendsLost++;
        cellsOut[n.s] = { kind: "note", pitch, level: Math.max(1, Math.min(15, Math.round(15 * n.vel / 127))), ...(bend ? { bend } : {}) };
        for (let c = n.s + 1; c < end; c++) cellsOut[c] = { kind: "tie" };
      }
      if (report.droppedPolyphony) losses.push(`Voice v${id}: ${report.droppedPolyphony} notes dropped because they sound together with another note (SID voices are monophonic).`);
      if (report.bendsLost) losses.push(`Voice v${id}: pitch bend on ${report.bendsLost} notes has no net pitch change (vibrato) or no room and is not imported.`);
      const instrument = instrumentForProgram(p.program ?? (bass ? 33 : undefined));
      instruments.set(instrument.name, instrument);
      report.instrument = instrument.name;
    }
    voiceReports.push(report);
    voiceCells.push(cellsOut);
  }

  // Quantisation and tempo summaries.
  const changes = tempos.length;
  let atBar = 0, moved = 0, clamped = 0;
  for (const t of tempos) {
    const bar = bars[barIndexOf(t.tick)]!;
    if (t.tick === bar.start) atBar++; else moved++;
  }
  const barTempo = (bar: Bar): number => {
    const raw = 6e7 / microsecondsAt(bar.start);
    const bpm = Math.round(raw * 100) / 100;
    const limited = Math.max(30, Math.min(220, bpm));
    if (limited !== bpm) clamped++;
    return limited;
  };
  if (moved) losses.push(`${moved} tempo change(s) fall inside a bar; SIDWave tempo changes at section starts, so each takes effect at the next bar line.`);

  // Voices, patterns and timeline.
  const patternsByVoice: Array<Map<string, string>> = voiceCells.map(() => new Map());
  const voicePatterns: Array<Record<string, unknown>> = voiceCells.map(() => ({}));
  const timeline: Array<Record<string, unknown>> = [];
  const firstTempo = barTempo(bars[0]!);
  const songSig = bars[0]!.sig.sidwave;
  const levelOf = chosen.map((p, i) => {
    if (p.drum) return 15;
    const counts = new Map<number, number>();
    for (const cell of voiceCells[i]!) if (cell.kind === "note" && cell.level !== undefined) counts.set(cell.level, (counts.get(cell.level) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 15;
  });
  const kitUsed = chosen.map((p, i) => new Set(p.drum ? voiceCells[i]!.filter((c) => c.drum).map((c) => c.drum!) : []));
  let sectionNo = 0;
  for (let b = 0; b < bars.length;) {
    const bar = bars[b]!;
    const tempo = barTempo(bar);
    let count = 1;
    while (b + count < bars.length && count < 4 && bars[b + count]!.sig.sidwave === bar.sig.sidwave && barTempo(bars[b + count]!) === tempo) count++;
    const first = bar.cellStart;
    const last = bars[b + count - 1]!.cellStart + bars[b + count - 1]!.cells;
    const layers: Record<string, string> = {};
    for (const [i, p] of chosen.entries()) {
      const slice = voiceCells[i]!.slice(first, last);
      if (slice.every((cell) => cell.kind === "rest")) { layers[`v${i + 1}`] = "-"; continue; }
      const encoded = p.drum ? drumSteps(slice) : grooveTokens(slice, levelOf[i]!);
      const key = JSON.stringify([encoded, count, p.drum ? [...kitUsed[i]!].sort() : 0]);
      let name = patternsByVoice[i]!.get(key);
      if (!name) {
        name = `p${patternsByVoice[i]!.size + 1}`;
        patternsByVoice[i]!.set(key, name);
        voicePatterns[i]![name] = p.drum
          ? { length: grid, bars: count, drums: { kit: kitMap([...kitUsed[i]!]), steps: encoded } }
          : { length: grid, bars: count, groove: encoded };
      }
      layers[`v${i + 1}`] = name;
    }
    sectionNo++;
    timeline.push({ section: `s${sectionNo}`, bars: count, ...(bar.sig.sidwave !== songSig ? { meter: bar.sig.sidwave } : {}),
      ...(tempo !== firstTempo ? { tempo } : {}), layers });
    b += count;
  }
  const title = options.title ?? trackNames.find((t) => t && t.text.trim())?.text.trim() ?? "Imported MIDI";
  for (const [i, p] of chosen.entries()) {
    const label = p.drum ? "Drums" : p.name ?? `Channel ${p.channel + 1}`;
    const report = voiceReports[i]!;
    voiceDefs.push({
      id: i + 1, name: label,
      ...(p.drum ? { role: "drums" } : { instrument: report.instrument, ...(report.role === "bass" ? { role: "bass" } : {}) }),
      ...(levelOf[i] !== 15 ? { level: levelOf[i] } : {}),
      patterns: voicePatterns[i],
    });
  }
  const doc: Record<string, unknown> = {
    sidwave: 1.3, title: title.slice(0, 80), tempo: firstTempo, mode, ...(songSig === "4/4" ? {} : { meter: songSig === "3/4" ? 3 : songSig }),
    ...(instruments.size ? { instruments: Object.fromEntries([...instruments.values()].map(({ name, ...rest }) => [name, rest])) } : {}),
    voices: voiceDefs, timeline,
  };
  const document = new yaml.Document(doc);
  yaml.visit(document, {
    Pair(_key, pair) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      if (key !== "groove" && key !== "adsr" && key !== "kit" && key !== "bend") return;
      const flow = (node: unknown): void => {
        if (isSeq(node)) { node.flow = true; node.items.forEach(flow); } else if (isMap(node)) { node.flow = true; node.items.forEach((item) => flow(item.value)); }
      };
      flow(pair.value);
    },
  });
  const text = `# Imported from a Standard MIDI File (format ${smf.format}, ${ppq} ticks per quarter note) by SIDWave.\n# Grid ${grid} beats; see the import report for what was dropped or moved.\n${document.toString({ lineWidth: 0, flowCollectionPadding: false })}`;

  if (options.validate !== false) {
    try { compileSidwaveToPrg(parseSidwave(text)); } catch (error) {
      if (error instanceof SidwaveValidationError) throw new MidiImportError(`the imported score is not accepted by SIDWave (${error.message}); try a coarser grid (--grid 0.5) or fewer voices`, text);
      throw error;
    }
  }
  let unread = 0;
  for (const track of smf.tracks) for (const e of track) if ((e.type === "controller" && ![101, 100, 6, 38].includes(e.controller)) || e.type === "other") unread++;
  if (unread) losses.push(`${unread} MIDI events (controllers other than the pitch bend range, aftertouch, SysEx and other meta events) are not imported.`);
  if (options.bend === false) losses.push("Pitch bend import is disabled.");
  return {
    yaml: text,
    report: {
      format: smf.format, ppq, gridBeats: grid, bars: bars.length, voices: voiceReports, droppedParts,
      quantisation: { notes: noteTotal, moved: movedCount, maxErrorTicks: Math.round(errMax * 1000) / 1000,
        meanErrorTicks: noteTotal ? Math.round(errTicks / noteTotal * 1000) / 1000 : 0, maxErrorMs: Math.round(errMaxMs * 1000) / 1000, maxEndErrorTicks: Math.round(endErrMax * 1000) / 1000 },
      tempoChanges: { total: changes, atBarLine: atBar, movedToBarLine: moved, clamped },
      timeSignatures: signatureReport, losses: [...new Set(losses)], warnings,
    },
  };
}

type Cell = { pitch?: number; level?: number; bend?: { to: number; frames: number }; kind: "note" | "tie" | "rest"; drum?: string };

function grooveTokens(cells: Cell[], voiceLevel: number): string | Array<string | Record<string, unknown>> {
  const items = cells.map((cell) => {
    if (cell.kind === "rest") return "-";
    if (cell.kind === "tie") return "~";
    const name = midiToNoteName(cell.pitch!);
    const level = cell.level !== undefined && cell.level !== voiceLevel ? cell.level : undefined;
    if (level === undefined && !cell.bend) return name;
    return { note: name, ...(level === undefined ? {} : { level }), ...(cell.bend ? { bend: cell.bend } : {}) };
  });
  return items.every((item) => typeof item === "string") ? items.join(" ") : items;
}

function drumSteps(cells: Cell[]): string {
  return cells.map((cell) => cell.kind === "note" ? cell.drum! : ".").join("");
}

function kitMap(letters: string[]): Record<string, string> {
  const byLetter = new Map(Object.values(IMPORT_DRUMS).map((d) => [d.letter, d.lib]));
  return Object.fromEntries(letters.sort().map((letter) => [letter, `lib:${byLetter.get(letter)!}`]));
}
