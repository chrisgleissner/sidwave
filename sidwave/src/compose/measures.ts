// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave } from "../sidwaveCompiler.js";
import { checkCounterpoint, type CounterpointReport, type TimedNote } from "./melody.js";

/**
 * Proxy measures of a compiled score: structure, variation and counterpoint rule violations. They count properties of
 * the notes; none of them measures musical quality.
 */

export interface VoiceNotes { slot: number; notes: TimedNote[] }

export interface ScoreMeasures {
  bars: number;
  sections: number;
  /** Voices that play notes (percussion excluded). */
  voices: number;
  leadNotes: number;
  /** Share of the lead's bars whose notes and rhythm equal an earlier bar of the lead. */
  repetitionRatio: number;
  /** Share of the lead's 3-interval windows whose interval pattern (or its inversion) occurs more than once. */
  motifRecurrence: number;
  /** Entropy in bits of the lead's pitch classes, weighted by duration. */
  pitchClassEntropy: number;
  /** Entropy in bits of the lead's melodic intervals, clamped to +-12 semitones. */
  intervalEntropy: number;
  /** Number of distinct note durations of the lead, in sixteenths of a beat. */
  distinctDurations: number;
  /** Entropy in bits of the lead's note durations. */
  rhythmEntropy: number;
  /** Counterpoint of the lead against the lowest voice on strong beats. */
  counterpoint: { sonorities: number; violations: number; byKind: Record<string, number>; contraryShare: number };
  /** The lead as pitch and beat-position pairs, for the distinctness measure across seeds. */
  leadSignature: string[];
}

function entropy(counts: Map<string | number, number>): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts.values()) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

const bump = (map: Map<string | number, number>, key: string | number, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/** The voices of an arranged score, with percussion removed, in physical slot order. */
export function pitchedVoices(doc: ParsedSidwave): { voices: VoiceNotes[]; framesPerBeat: number; meter: number } {
  const arrangement = arrangeSidwave(doc);
  const voices: VoiceNotes[] = [];
  arrangement.voices.forEach((voice, slot) => {
    const notes = voice.notes.filter((n) => !n.percussion && !n.hidden).map((n) => ({ start: n.start / arrangement.framesPerBeat, end: n.end / arrangement.framesPerBeat, midi: n.midi }));
    if (notes.length > 0) voices.push({ slot, notes });
  });
  return { voices, framesPerBeat: arrangement.framesPerBeat, meter: doc.song.meter };
}

/** Slots of voices that the composer marks as a counter line (the voice is named "Counter line"). */
function counterVoiceSlots(doc: ParsedSidwave): Set<number> {
  const out = new Set<number>();
  for (const voice of doc.voices) if (voice.name === "Counter line") { const slot = doc.voiceSlots.get(voice.id); if (slot !== undefined) out.add(slot); }
  return out;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/**
 * Measures a score. `windowBars` limits the variation and repetition measures (entropies, distinct durations, repetition,
 * motif recurrence, the signature) to the lead's first bars, so scores of different lengths are measured over the same
 * span; the counterpoint measure always covers the whole score and is a rate.
 */
export function measureScore(doc: ParsedSidwave, options: { windowBars?: number } = {}): ScoreMeasures {
  const { voices, meter, framesPerBeat } = pitchedVoices(doc);
  const empty: ScoreMeasures = {
    bars: doc.song.length_bars, sections: doc.timeline.length, voices: voices.length, leadNotes: 0, repetitionRatio: 0, motifRecurrence: 0,
    pitchClassEntropy: 0, intervalEntropy: 0, distinctDurations: 0, rhythmEntropy: 0,
    counterpoint: { sonorities: 0, violations: 0, byKind: {}, contraryShare: 0 }, leadSignature: [],
  };
  if (voices.length === 0) return empty;
  const ranked = [...voices].sort((a, b) => median(b.notes.map((n) => n.midi)) - median(a.notes.map((n) => n.midi)));
  const lead = ranked[0]!;
  const bass = ranked[ranked.length - 1]!;
  const windowEnd = options.windowBars === undefined ? Infinity : options.windowBars * meter;
  const notes = [...lead.notes].filter((n) => n.start < windowEnd - 1e-9).sort((a, b) => a.start - b.start);

  // Repetition: bars of the lead compared by their pitches and onsets relative to the bar.
  const bars = new Map<number, string[]>();
  for (const n of notes) {
    const bar = Math.floor(n.start / meter + 1e-9);
    const rel = Math.round((n.start - bar * meter) * 4);
    const list = bars.get(bar) ?? [];
    list.push(`${rel}:${n.midi}:${Math.round((n.end - n.start) * 4)}`);
    bars.set(bar, list);
  }
  const seen = new Set<string>();
  let repeated = 0;
  for (const [, list] of [...bars.entries()].sort((a, b) => a[0] - b[0])) {
    const key = list.join(",");
    if (seen.has(key)) repeated++;
    seen.add(key);
  }
  const repetitionRatio = bars.size === 0 ? 0 : repeated / bars.size;

  const intervals: number[] = [];
  for (let i = 1; i < notes.length; i++) intervals.push(notes[i]!.midi - notes[i - 1]!.midi);
  const windows = new Map<string, number>();
  const canonical = (w: number[]) => {
    const a = w.join(",");
    const b = w.map((x) => -x).join(",");
    return a <= b ? a : b;
  };
  let total = 0;
  for (let i = 0; i + 3 <= intervals.length; i++) {
    const w = intervals.slice(i, i + 3);
    if (w.every((x) => x === 0)) continue;
    total++;
    bump(windows, canonical(w));
  }
  let recurring = 0;
  for (const c of windows.values()) if (c > 1) recurring += c;
  const motifRecurrence = total === 0 ? 0 : recurring / total;

  const pcs = new Map<string | number, number>();
  const ivs = new Map<string | number, number>();
  const durs = new Map<string | number, number>();
  for (const n of notes) {
    bump(pcs, ((n.midi % 12) + 12) % 12, n.end - n.start);
    bump(durs, Math.round((n.end - n.start) * 4));
  }
  for (const i of intervals) bump(ivs, Math.max(-12, Math.min(12, i)));

  const endBeat = Math.max(...voices.flatMap((v) => v.notes.map((n) => n.end)));
  const strongEvery = meter === 3 ? 3 : 2;
  const byKind: Record<string, number> = {};
  let sonorities = 0;
  let violations = 0;
  let contrarySum = 0;
  let movingPairs = 0;
  // The outer voices, and the lead against an explicit counter line when the score has one.
  const counter = voices.find((v) => v !== lead && v !== bass && counterVoiceSlots(doc).has(v.slot));
  const pairs: Array<[VoiceNotes, VoiceNotes]> = [];
  if (lead !== bass) pairs.push([lead, bass]);
  if (counter) pairs.push([lead, counter]);
  for (const [upper, lower] of pairs) {
    const report: CounterpointReport = checkCounterpoint(upper.notes, lower.notes, strongEvery, endBeat, 0.75 / framesPerBeat);
    sonorities += report.sonorities;
    violations += report.violations.length;
    for (const v of report.violations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
    contrarySum += report.contraryShare * report.movingPairs;
    movingPairs += report.movingPairs;
  }
  return {
    ...empty,
    leadNotes: notes.length,
    repetitionRatio,
    motifRecurrence,
    pitchClassEntropy: entropy(pcs),
    intervalEntropy: entropy(ivs),
    distinctDurations: durs.size,
    rhythmEntropy: entropy(durs),
    counterpoint: { sonorities, violations, byKind, contraryShare: movingPairs === 0 ? 0 : contrarySum / movingPairs },
    leadSignature: notes.map((n) => `${Math.round(n.start * 4)}:${n.midi}`),
  };
}

/**
 * Inter-seed distinctness: the mean over all pairs of 1 minus the Jaccard similarity of the lead's 4-note windows
 * (pitch and onset), so two identical leads score 0 and two leads without a common window score 1.
 */
export function distinctness(signatures: readonly string[][]): number {
  const sets = signatures.map((s) => {
    const out = new Set<string>();
    for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4).join(">"));
    return out;
  });
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    let common = 0;
    for (const x of sets[i]!) if (sets[j]!.has(x)) common++;
    const union = sets[i]!.size + sets[j]!.size - common;
    sum += union === 0 ? 0 : 1 - common / union;
    pairs++;
  }
  return pairs === 0 ? 0 : sum / pairs;
}
