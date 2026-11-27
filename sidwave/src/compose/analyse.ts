// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { SidwaveOperationError } from "../cliCore.js";
import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave } from "../sidwaveCompiler.js";
import type { Motif } from "./melody.js";
import { MODE_GRAMMAR, MODE_NAMES, pc, scalePcs, triad, type Chord, type Fn, type Key } from "./theory.js";

/**
 * Reads an existing score into the quantities the completion operations need: the timeline in bars and sixteenth cells,
 * each voice's notes with its role, the key, and chords inferred from the notes. Everything is read from the compiler's
 * arrangement, so any score format version is accepted as long as it has one timeline in a regular metre.
 */

/** A note with a pitch, in sixteenth cells. */
export interface Note { at: number; dur: number; midi: number }

export type VoiceRole = "lead" | "bass" | "harmony" | "drums";

export interface VoiceInfo {
  id: number;
  slot: number;
  role: VoiceRole;
  /** Pitched notes in sixteenth cells from the start of the score, sorted by onset. */
  notes: Note[];
  /** Voice-level instrument, or the instrument that most of its notes name. */
  instrument?: string;
  medianPitch: number;
  /** True when no timeline entry plays a pattern on this voice. */
  silent: boolean;
}

export interface EntryInfo {
  index: number;
  name?: string;
  startBar: number;
  bars: number;
  startCell: number;
  cells: number;
}

export interface Analysis {
  parsed: ParsedSidwave;
  meter: number;
  barCells: number;
  totalBars: number;
  totalCells: number;
  entries: EntryInfo[];
  voices: VoiceInfo[];
  key: Key;
  framesPerBeat: number;
}

const SILENT = new Set(["-", ".", "rest", ""]);
export const isSilentRef = (ref: string | undefined): boolean => ref === undefined || SILENT.has(ref.trim());

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  throw new SidwaveOperationError("validation", message, details);
};

/** The instrument named most often in a voice's patterns (`C3@lib:name` tokens or `inst:` fields). */
function dominantInstrument(patterns: unknown): string | undefined {
  const counts = new Map<string, number>();
  const text = JSON.stringify(patterns ?? {});
  for (const m of text.matchAll(/@([A-Za-z0-9_:.-]+)|"inst":"([^"]+)"/g)) {
    const name = m[1] ?? m[2]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [name, n] of counts) if (best === undefined || n > counts.get(best)!) best = name;
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 60;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function analyseScore(parsed: ParsedSidwave): Analysis {
  if (parsed.songs) fail("scores with several songs are not supported by the completion operations");
  const meter = parsed.song.meter;
  if (!Number.isInteger(meter) || meter < 2 || meter > 6) fail(`the completion operations need a whole number of beats per bar between 2 and 6, not ${meter}`);
  const entries: EntryInfo[] = [];
  let bar = 0;
  parsed.timeline.forEach((section, index) => {
    if (section.tempo !== undefined && section.tempo !== parsed.song.tempo) fail(`timeline entry ${index + 1} changes the tempo, which the completion operations do not support`, { entry: index + 1 });
    if (section.meter !== undefined && section.meter.beats !== meter) fail(`timeline entry ${index + 1} has its own metre, which the completion operations do not support`, { entry: index + 1 });
    entries.push({ index, ...(section.section ? { name: section.section } : {}), startBar: bar, bars: section.bars, startCell: bar * meter * 4, cells: section.bars * meter * 4 });
    bar += section.bars;
  });
  if (parsed.song.length_bars !== bar) fail("the score truncates or repeats its timeline (length_bars differs from the timeline); the completion operations need them equal");
  const arrangement = arrangeSidwave(parsed);
  const fpb = arrangement.framesPerBeat;
  const barCells = meter * 4;
  const slotToId = new Map<number, number>();
  for (const [id, slot] of parsed.voiceSlots) slotToId.set(slot, id);
  const voices: VoiceInfo[] = [];
  for (const voice of parsed.voices) {
    const slot = parsed.voiceSlots.get(voice.id)!;
    const raw = arrangement.voices[slot];
    const pitched: Note[] = [];
    let percussion = Boolean(voice.patterns && Object.values(voice.patterns).some((p) => "drums" in p));
    for (const n of raw?.notes ?? []) {
      if (n.hidden) continue;
      if (n.percussion) { percussion = true; continue; }
      const at = Math.round((n.start / fpb) * 4);
      pitched.push({ at, dur: Math.max(1, Math.round((n.end / fpb) * 4) - at), midi: n.midi });
    }
    pitched.sort((a, b) => a.at - b.at);
    const silent = parsed.timeline.every((section) => isSilentRef(section.layers[`v${voice.id}`]));
    voices.push({
      id: voice.id, slot, role: percussion ? "drums" : "harmony", notes: percussion ? [] : pitched,
      instrument: voice.instrument ?? dominantInstrument(voice.patterns), medianPitch: median(pitched.map((n) => n.midi)), silent,
    });
  }
  // Roles by register among the pitched voices that play: the highest is the lead, the lowest the bass.
  const pitchedVoices = voices.filter((v) => v.role !== "drums" && !v.silent && v.notes.length > 0).sort((a, b) => b.medianPitch - a.medianPitch);
  if (pitchedVoices.length > 0) pitchedVoices[0]!.role = "lead";
  if (pitchedVoices.length > 1) pitchedVoices[pitchedVoices.length - 1]!.role = "bass";
  return {
    parsed, meter, barCells, totalBars: bar, totalCells: bar * barCells, entries, voices,
    key: detectKey(pitchedVoices.flatMap((v) => v.notes), pitchedVoices.find((v) => v.role === "bass")?.notes ?? []), framesPerBeat: fpb,
  };
}

/** The key whose scale holds most of the duration-weighted notes; the tonic's weight and the bass break ties. */
export function detectKey(notes: readonly Note[], bass: readonly Note[]): Key {
  const weights = new Float64Array(12);
  for (const n of notes) weights[pc(n.midi)]! += n.dur;
  for (const n of bass) weights[pc(n.midi)]! += n.dur * 0.5;
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let best: Key = { tonic: 0, mode: "major" };
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of MODE_NAMES) {
      const key: Key = { tonic, mode };
      let inScale = 0;
      for (const p of scalePcs(key)) inScale += weights[p]!;
      const score = inScale / total + 0.05 * (weights[tonic]! / total) + 0.02 * (weights[pc(tonic + 7)]! / total);
      if (score > bestScore + 1e-12) { bestScore = score; best = key; }
    }
  }
  return best;
}

const CANDIDATE_CACHE = new Map<string, Chord[]>();

function candidates(key: Key): Chord[] {
  const id = `${key.tonic}:${key.mode}`;
  let list = CANDIDATE_CACHE.get(id);
  if (list) return list;
  list = [];
  const g = MODE_GRAMMAR[key.mode];
  for (let degree = 0; degree < 7; degree++) {
    const fns: Fn[] = degree === 4 && g.raiseDominant ? ["T", "D"] : ["T"];
    for (const fn of fns) {
      try { list.push(triad(key, degree, fn)); } catch { /* a diminished triad is not a candidate */ }
    }
  }
  CANDIDATE_CACHE.set(id, list);
  return list;
}

/**
 * One chord per bar (or per `slots` equal parts of a bar) of the whole score from the given notes: the diatonic major or
 * minor triad that holds the most weighted note duration. Notes on strong beats count double and `bass` notes count
 * double again. A part without notes repeats the chord before it.
 */
export function inferChords(notes: readonly Note[], bass: readonly Note[], key: Key, totalBars: number, barCells: number, slots = 1): Chord[] {
  const partCells = barCells / slots;
  const parts = totalBars * slots;
  const hist = Array.from({ length: parts }, () => new Float64Array(12));
  const bassHist = Array.from({ length: parts }, () => new Float64Array(12));
  const add = (list: readonly Note[], target: Float64Array[], factor: number) => {
    for (const n of list) {
      const first = Math.floor(n.at / partCells);
      const last = Math.min(parts - 1, Math.floor((n.at + n.dur - 1) / partCells));
      for (let part = first; part <= last; part++) {
        const from = Math.max(n.at, part * partCells);
        const to = Math.min(n.at + n.dur, (part + 1) * partCells);
        if (to > from) target[part]![pc(n.midi)]! += (to - from) * (n.at % 8 === 0 ? 2 : 1) * factor;
      }
    }
  };
  add(notes, hist, 1);
  add(bass, bassHist, 2);
  const list = candidates(key);
  const out: Chord[] = [];
  for (let part = 0; part < parts; part++) {
    const h = hist[part]!;
    const b = bassHist[part]!;
    let best: Chord | undefined;
    let bestScore = 0;
    for (const chord of list) {
      let score = 0;
      for (let p = 0; p < 12; p++) {
        const w = h[p]! + b[p]!;
        score += chord.pcs.includes(p) ? w : -0.5 * w;
      }
      score += 0.3 * b[chord.root]!;
      if (out.length > 0 && out[out.length - 1]!.root === chord.root) score += 0.01;
      if (score > bestScore || (best === undefined && score > 0)) { best = chord; bestScore = score; }
    }
    out.push(best ?? out[out.length - 1] ?? triad(key, 0, "T"));
  }
  return out;
}

/** A motif from the first notes of a line: scale steps between notes and their durations, at most five notes within half a bar. */
export function extractMotif(notes: readonly Note[], key: Key, from: number, barCells: number): Motif | undefined {
  const scale = new Set(scalePcs(key));
  const picked: Note[] = [];
  for (const n of notes) {
    if (n.at < from) continue;
    if (picked.length > 0 && n.at - picked[0]!.at >= barCells / 2) break;
    picked.push(n);
    if (picked.length === 5) break;
  }
  if (picked.length < 2) return undefined;
  const steps = [0];
  for (let i = 1; i < picked.length; i++) {
    // Count scale tones between the two pitches; a chromatic pitch counts as its lower neighbour.
    const a = picked[i - 1]!.midi;
    const b = picked[i]!.midi;
    let count = 0;
    for (let m = Math.min(a, b) + 1; m <= Math.max(a, b); m++) if (scale.has(pc(m))) count++;
    steps.push(Math.max(-3, Math.min(3, b >= a ? count : -count)));
  }
  const durs = picked.map((n, i) => (i === picked.length - 1 ? Math.min(n.dur, 8) : Math.max(1, picked[i + 1]!.at - n.at)));
  return { steps, durs };
}
