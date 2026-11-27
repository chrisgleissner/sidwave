// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Musical analysis of a note list: key and mode, metre, form, motifs and voice use. Every function is linear or
// n log n in the number of notes (or bars). The note list comes from the production arranger
// (`arrangeSidwave`), so a score and a reconstructed tune are analysed by the same code.

import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave, type Arrangement } from "../sidwaveCompiler.js";
import { noteName, PITCH_CLASS_NAMES, type Basis, type Marked } from "./common.js";

export interface NoteEvent {
  /** Global voice number, 1-based over all SIDs. */
  voice: number;
  /** Start and end in player calls from the start of the song. */
  start: number;
  end: number;
  midi: number;
  /** Index into the instrument table of the arrangement. */
  inst: number;
  percussion: boolean;
  /** Index of the timeline section the note starts in. */
  section: number;
}

export interface ScoreModel {
  notes: NoteEvent[];
  /** Calls per second. */
  fps: number;
  /** Player calls per beat (quarter note) at the starting tempo. */
  framesPerBeat: number;
  tempo: number;
  /** Beats per bar of the song metre. */
  meterBeats: number;
  /** Start of every bar in calls, followed by the end of the last bar. */
  barStarts: number[];
  sections: Array<{ name: string; startFrame: number; endFrame: number; bars: number }>;
  totalFrames: number;
  /** First call of the loop, when the score declares `loop_to`. */
  loopFrame?: number;
  voiceCount: number;
  arrangement: Arrangement;
}

export function modelOfScore(doc: ParsedSidwave): ScoreModel {
  const arr = arrangeSidwave(doc);
  const clock = arr.clock;
  const frameAt = (beat: number) => (clock ? clock.frameAt(beat) : Math.round(beat * arr.framesPerBeat));
  const meter = doc.song.meter;
  const barStarts = clock ? clock.barStarts.map(frameAt) : Array.from({ length: doc.song.length_bars + 1 }, (_, i) => frameAt(i * meter));
  const sections: ScoreModel["sections"] = [];
  if (clock) {
    for (const { section, startBeat, endBeat } of clock.sections) {
      sections.push({ name: section.section ?? `section ${sections.length + 1}`, startFrame: frameAt(startBeat), endFrame: frameAt(endBeat), bars: section.bars });
    }
  } else {
    let bar = 0;
    for (let i = 0; bar < doc.song.length_bars; i++) {
      const section = doc.timeline[i % doc.timeline.length]!;
      const end = Math.min(bar + section.bars, doc.song.length_bars);
      sections.push({ name: section.section ?? `section ${i + 1}`, startFrame: barStarts[bar]!, endFrame: barStarts[end]!, bars: end - bar });
      bar = end;
    }
  }
  const sectionOf = (frame: number): number => {
    let lo = 0;
    let hi = sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sections[mid]!.startFrame <= frame) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const notes: NoteEvent[] = [];
  arr.voices.forEach((voice, v) => {
    for (const n of voice.notes) {
      if (n.hidden) continue;
      notes.push({ voice: v + 1, start: n.start, end: n.releaseFrame ?? n.end, midi: n.midi, inst: n.inst, percussion: !!n.percussion || (arr.instruments[n.inst]!.wave & 0xf0) === 0x80, section: sectionOf(n.start) });
    }
  });
  notes.sort((a, b) => a.start - b.start || a.voice - b.voice);
  return {
    notes, fps: arr.fps, framesPerBeat: arr.framesPerBeat, tempo: doc.song.tempo, meterBeats: meter, barStarts, sections,
    totalFrames: arr.totalFrames, ...(arr.clock?.loopFrame === undefined ? {} : { loopFrame: arr.clock.loopFrame }),
    voiceCount: arr.voices.length, arrangement: arr,
  };
}

// ---- key -----------------------------------------------------------------------------------------------------------

// Krumhansl and Kessler (1982) key profiles, as used by the Krumhansl-Schmuckler key-finding algorithm.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}

export interface KeyEstimate extends Marked {
  tonic: string;
  mode: "major" | "minor";
  /** Correlation of the pitch-class histogram with the winning key profile, -1 to 1. */
  correlation: number;
  /** Correlation of the winning key minus that of the best key of the other mode or a different tonic. */
  margin: number;
  /** high: correlation at least 0.75 and margin at least 0.05; medium: correlation at least 0.55; low otherwise. */
  confidence: "high" | "medium" | "low";
  runnerUp: { tonic: string; mode: "major" | "minor"; correlation: number };
  /** Pitch-class histogram, weights are note durations in calls. */
  histogram: number[];
  pitchedNotes: number;
}

/** Krumhansl-Schmuckler key finding on the duration-weighted pitch-class histogram of the pitched notes. */
export function estimateKey(notes: readonly NoteEvent[]): KeyEstimate | undefined {
  const histogram = new Array<number>(12).fill(0);
  let pitched = 0;
  for (const n of notes) {
    if (n.percussion) continue;
    histogram[((n.midi % 12) + 12) % 12]! += Math.max(1, n.end - n.start);
    pitched++;
  }
  if (pitched === 0) return undefined;
  const scores: Array<{ tonic: number; mode: "major" | "minor"; r: number }> = [];
  for (let t = 0; t < 12; t++) {
    const rotated = (profile: number[]) => Array.from({ length: 12 }, (_, i) => profile[(i - t + 12) % 12]!);
    scores.push({ tonic: t, mode: "major", r: correlation(histogram, rotated(MAJOR_PROFILE)) });
    scores.push({ tonic: t, mode: "minor", r: correlation(histogram, rotated(MINOR_PROFILE)) });
  }
  scores.sort((a, b) => b.r - a.r || a.tonic - b.tonic);
  const best = scores[0]!;
  const second = scores[1]!;
  const margin = best.r - second.r;
  return {
    basis: "inferred", method: "Krumhansl-Schmuckler key profiles correlated with the duration-weighted pitch-class histogram",
    tonic: PITCH_CLASS_NAMES[best.tonic]!, mode: best.mode, correlation: round(best.r, 4), margin: round(margin, 4),
    confidence: best.r >= 0.75 && margin >= 0.05 ? "high" : best.r >= 0.55 ? "medium" : "low",
    runnerUp: { tonic: PITCH_CLASS_NAMES[second.tonic]!, mode: second.mode, correlation: round(second.r, 4) },
    histogram: histogram.map((x) => round(x, 3)), pitchedNotes: pitched,
  };
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---- metre ---------------------------------------------------------------------------------------------------------

export interface MetreEstimate {
  /** From the score: the song metre and the tempo. For a reconstructed tune this is the metre the reconstruction assumed. */
  declared: Marked & { beatsPerBar: number; tempoBpm: number; framesPerBeat: number };
  /** From the onsets: the bar length in beats whose accent pattern repeats most strongly. */
  detected: Marked & { beatsPerBar: number; autocorrelation: Record<string, number>; agrees: boolean };
}

/** Autocorrelation of the number of note onsets per beat at lags of 3, 4 and 6 beats (bar length candidates). */
export function estimateMetre(model: ScoreModel, declaredBasis: "observed" | "inferred" = "observed"): MetreEstimate {
  const beats = Math.max(1, Math.ceil(model.totalFrames / model.framesPerBeat));
  const onsets = new Float64Array(beats);
  for (const n of model.notes) {
    if (n.percussion) continue;
    // A note up to an eighth of a beat before the beat line belongs to that beat (call rounding of the start).
    const b = Math.min(beats - 1, Math.floor(n.start / model.framesPerBeat + 0.125));
    // A note that is held for two beats or more carries more accent than a short one.
    onsets[b]! += 1 + (n.end - n.start >= 2 * model.framesPerBeat ? 0.5 : 0);
  }
  let mean = 0;
  for (let i = 0; i < beats; i++) mean += onsets[i]!;
  mean /= beats;
  let denom = 0;
  for (let i = 0; i < beats; i++) denom += (onsets[i]! - mean) ** 2;
  const autocorrelation: Record<string, number> = {};
  const r = (lag: number): number => {
    let sum = 0;
    if (denom > 0 && beats > lag) {
      for (let i = 0; i + lag < beats; i++) sum += (onsets[i]! - mean) * (onsets[i + lag]! - mean);
      sum /= denom;
    }
    return sum;
  };
  for (const lag of [3, 4, 6, 8, 12]) autocorrelation[String(lag)] = round(r(lag), 4);
  // Downbeat accent: the score starts on a bar line, so for a bar length L the beats at positions 0, L, 2L, ... carry
  // the downbeats. The accent of L is the mean onset strength at those beats divided by the mean over all beats.
  // The autocorrelation is reported as supporting evidence.
  const accent = (lag: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < beats; i += lag) { sum += onsets[i]!; n++; }
    return mean > 0 && n > 0 ? sum / n / mean : 0;
  };
  const accents: Record<string, number> = {};
  for (const lag of [3, 4, 6]) accents[String(lag)] = round(accent(lag), 4);
  let best = 4;
  // 4 wins ties: it is the most common bar length. 3 and 6 beats need a clearly stronger accent than 4.
  for (const lag of [3, 6]) if (accents[String(lag)]! > accents[String(best)]! * 1.1 + 0.02) best = lag;
  if (best === 6 && accents["3"]! * 1.05 >= accents["6"]!) best = 3;
  Object.assign(autocorrelation, Object.fromEntries(Object.entries(accents).map(([k, v]) => [`accent${k}`, v])));
  return {
    declared: { basis: declaredBasis, ...(declaredBasis === "inferred" ? { method: "the reconstruction assumes four beats per bar and fits the tempo to the player call rate" } : {}), beatsPerBar: model.meterBeats, tempoBpm: round(model.tempo, 3), framesPerBeat: round(model.framesPerBeat, 4) },
    detected: { basis: "inferred", method: "mean onset strength on the beats 0, L, 2L, ... relative to all beats, for L = 3, 4 and 6", beatsPerBar: best, autocorrelation, agrees: best === model.meterBeats },
  };
}

// ---- form ----------------------------------------------------------------------------------------------------------

export interface FormReport {
  /** Sections as declared by the score timeline. */
  declaredSections: Array<Marked & { name: string; startBar: number; bars: number }>;
  /** Label of every bar: equal labels mean bars with the same notes at the same offsets in the same voices. */
  barLabels: string;
  /** Runs of equal labels. */
  runs: Array<{ label: string; startBar: number; bars: number }>;
  distinctBars: number;
  /** Labels that occur in more than one place and the bars they occur in. */
  repetitions: Array<{ label: string; bars: number[] }>;
  /** Share of bars that repeat an earlier bar exactly. */
  repeatShare: number;
  /** The longest periodic suffix of the bar sequence: from `startBar` the sequence repeats with period `periodBars`. */
  loop?: Marked & { startBar: number; periodBars: number; repeats: number };
  /** The bar the score declares as its loop point (`loop_to`). */
  declaredLoop?: Marked & { startBar: number };
  basis: Basis;
  method: string;
}

function labelOf(i: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return i < letters.length ? letters[i]! : `#${i}`;
}

/** Bar-by-bar repetition: label equal bars, find runs, repeated labels and the periodic tail (KMP failure function, linear). */
export function analyzeForm(model: ScoreModel, basis: Basis = "inferred"): FormReport {
  const bars = model.barStarts.length - 1;
  // Notes per bar: notes are sorted by start, bars by start frame, so one merge pass assigns them.
  // Offsets and lengths are compared in eighths of a beat: a tempo that is not a whole number of calls per beat moves
  // the same musical position by a call from bar to bar.
  const quantum = model.framesPerBeat / 8;
  const parts: string[][] = Array.from({ length: Math.max(0, bars) }, () => []);
  let bar = 0;
  for (const n of model.notes) {
    while (bar + 1 < bars && n.start >= model.barStarts[bar + 1]!) bar++;
    if (bar >= bars) break;
    parts[bar]!.push(`${Math.round((n.start - model.barStarts[bar]!) / quantum)}.${n.voice}.${n.midi}.${n.inst}.${Math.round((n.end - n.start) / (model.framesPerBeat / 2))}`);
  }
  const ids = new Map<string, number>();
  const sequence: number[] = parts.map((p) => {
    const key = p.join(",");
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    return id;
  });
  const runs: FormReport["runs"] = [];
  for (let i = 0; i < sequence.length; i++) {
    const label = labelOf(sequence[i]!);
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.bars++; else runs.push({ label, startBar: i, bars: 1 });
  }
  const where = new Map<number, number[]>();
  sequence.forEach((id, i) => { const l = where.get(id); if (l) l.push(i); else where.set(id, [i]); });
  const repetitions = [...where].filter(([, l]) => l.length > 1).map(([id, l]) => ({ label: labelOf(id), bars: l.slice(0, 64) }));
  const repeated = sequence.length - ids.size;
  let loop: FormReport["loop"];
  if (sequence.length >= 4) {
    // Longest suffix with a period p and at least two full periods: prefix function of the reversed sequence.
    const r = sequence.slice().reverse();
    const pi = new Int32Array(r.length);
    for (let i = 1, k = 0; i < r.length; i++) {
      while (k > 0 && r[i] !== r[k]) k = pi[k - 1]!;
      if (r[i] === r[k]) k++;
      pi[i] = k;
    }
    let bestLen = 0;
    let bestPeriod = 0;
    for (let i = 1; i < r.length; i++) {
      const length = i + 1;
      const period = length - pi[i]!;
      if (period * 2 <= length && length > bestLen) { bestLen = length; bestPeriod = period; }
    }
    // A loop must cover a meaningful part of the song, not just the last two equal bars.
    if (bestLen >= Math.max(4, Math.ceil(sequence.length * 0.25))) {
      const startBar = sequence.length - bestLen;
      loop = {
        basis: "inferred", method: "longest suffix of the bar sequence with at least two exact repetitions of one period (prefix function)",
        startBar, periodBars: bestPeriod, repeats: Math.floor(bestLen / bestPeriod),
      };
    }
  }
  const declaredLoop = model.loopFrame === undefined ? undefined : { basis, ...(basis === "inferred" ? { method: "loop point of the reconstructed score" } : {}), startBar: model.barStarts.findIndex((f) => f >= model.loopFrame!) };
  return {
    declaredSections: model.sections.map((s) => ({ basis, ...(basis === "inferred" ? { method: "section of the reconstructed score; the tune itself declares none" } : {}), name: s.name, startBar: model.barStarts.indexOf(s.startFrame), bars: s.bars })),
    barLabels: sequence.map(labelOf).join(""),
    runs, distinctBars: ids.size, repetitions, repeatShare: bars === 0 ? 0 : round(repeated / bars, 4), ...(loop ? { loop } : {}), ...(declaredLoop ? { declaredLoop } : {}),
    basis, method: "comparison of the notes of each bar (offset in eighths of a beat, length in half beats, voice, pitch, instrument)",
  };
}

// ---- motifs --------------------------------------------------------------------------------------------------------

export interface Motif extends Marked {
  /** Semitone steps between consecutive notes. */
  intervals: number[];
  /** Inter-onset intervals between consecutive notes in eighths of a beat. */
  rhythm: number[];
  notes: number;
  occurrenceCount: number;
  /** First occurrences: voice, bar (0-based) and beat position in the bar. */
  occurrences: Array<{ voice: number; bar: number; beat: number }>;
  voices: number[];
}

export const MOTIF_LENGTHS = [8, 6, 5, 4] as const;
export const MOTIF_MIN_OCCURRENCES = 3;
export const MOTIF_LIMIT = 12;
const MOTIF_LOCATIONS = 12;

/** Exact n-gram mining of (interval, inter-onset interval) pairs per voice; hash tables, linear in notes times the number of lengths. */
export function mineMotifs(model: ScoreModel): Motif[] {
  const byVoice = new Map<number, NoteEvent[]>();
  for (const n of model.notes) {
    if (n.percussion) continue;
    let list = byVoice.get(n.voice);
    if (!list) byVoice.set(n.voice, (list = []));
    list.push(n);
  }
  const barOf = (frame: number): number => {
    let lo = 0;
    let hi = model.barStarts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (model.barStarts[mid]! <= frame) lo = mid; else hi = mid - 1;
    }
    return Math.max(0, lo);
  };
  const covered = new Set<string>();
  const result: Motif[] = [];
  const quantum = model.framesPerBeat / 8;
  for (const length of MOTIF_LENGTHS) {
    const groups = new Map<string, Array<{ voice: number; index: number }>>();
    for (const [voice, list] of byVoice) {
      if (list.length < length) continue;
      // Pair i describes the step from note i to note i+1.
      const pairs: string[] = new Array(list.length - 1);
      for (let i = 0; i + 1 < list.length; i++) pairs[i] = `${list[i + 1]!.midi - list[i]!.midi}:${Math.round((list[i + 1]!.start - list[i]!.start) / quantum)}`;
      for (let i = 0; i + length <= list.length; i++) {
        const key = pairs.slice(i, i + length - 1).join(" ");
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({ voice, index: i });
      }
    }
    const candidates: Array<{ key: string; places: Array<{ voice: number; index: number }> }> = [];
    for (const [key, places] of groups) {
      // Non-overlapping occurrences within a voice only.
      const kept: typeof places = [];
      const lastEnd = new Map<number, number>();
      for (const p of places) {
        if ((lastEnd.get(p.voice) ?? -1) >= p.index) continue;
        kept.push(p);
        lastEnd.set(p.voice, p.index + length - 1);
      }
      if (kept.length < MOTIF_MIN_OCCURRENCES) continue;
      const steps = key.split(" ").map((s) => s.split(":").map(Number) as [number, number]);
      // A run of one repeated pitch with one regular rhythm is a repeated note, not a motif.
      if (steps.every(([iv, r]) => iv === 0 && r === steps[0]![1])) continue;
      candidates.push({ key, places: kept });
    }
    candidates.sort((a, b) => b.places.length - a.places.length || (a.key < b.key ? -1 : 1));
    for (const c of candidates) {
      const inside = c.places.filter((p) => covered.has(`${p.voice}:${p.index}`)).length;
      if (inside / c.places.length >= 0.8) continue;
      const steps = c.key.split(" ").map((s) => s.split(":").map(Number) as [number, number]);
      for (const p of c.places) for (let k = 0; k < length; k++) covered.add(`${p.voice}:${p.index + k}`);
      result.push({
        basis: "inferred", method: "n-gram mining of (interval, inter-onset interval in eighths of a beat) pairs, at least 3 non-overlapping occurrences",
        intervals: steps.map((s) => s[0]), rhythm: steps.map((s) => s[1]), notes: length, occurrenceCount: c.places.length,
        occurrences: c.places.slice(0, MOTIF_LOCATIONS).map((p) => {
          const note = byVoice.get(p.voice)![p.index]!;
          const bar = barOf(note.start);
          return { voice: p.voice, bar, beat: round((note.start - model.barStarts[bar]!) / model.framesPerBeat, 3) };
        }),
        voices: [...new Set(c.places.map((p) => p.voice))].sort((a, b) => a - b),
      });
    }
  }
  result.sort((a, b) => b.occurrenceCount * b.notes - a.occurrenceCount * a.notes || b.notes - a.notes);
  return result.slice(0, MOTIF_LIMIT);
}

// ---- voice use -----------------------------------------------------------------------------------------------------

export interface VoiceUse {
  voice: number;
  sid: number;
  noteCount: number;
  percussionCount: number;
  /** Lowest and highest pitched note. */
  range?: { lowest: string; highest: string; lowestMidi: number; highestMidi: number };
  medianMidi?: number;
  /** Notes per second over the song. */
  notesPerSecond: number;
  /** Share of the song during which a note of the voice sounds (gate held). */
  soundingShare: number;
  role: Marked & { value: string };
}

/** Per-voice statistics and a role from the pitch rank, the note length and the share of percussion. */
export function voiceUse(model: ScoreModel, declaredRoles: ReadonlyMap<number, string> = new Map()): VoiceUse[] {
  const byVoice = new Map<number, NoteEvent[]>();
  for (let v = 1; v <= model.voiceCount; v++) byVoice.set(v, []);
  for (const n of model.notes) byVoice.get(n.voice)!.push(n);
  const seconds = Math.max(model.totalFrames / model.fps, 1e-9);
  const medians = new Map<number, number>();
  for (const [v, list] of byVoice) {
    const pitched = list.filter((n) => !n.percussion).map((n) => n.midi).sort((a, b) => a - b);
    if (pitched.length) medians.set(v, pitched[pitched.length >> 1]!);
  }
  const ranked = [...medians].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([v]) => v);
  return [...byVoice].map(([voice, list]): VoiceUse => {
    const pitched = list.filter((n) => !n.percussion);
    const percussionCount = list.length - pitched.length;
    let sounding = 0;
    let longSum = 0;
    for (const n of list) { sounding += n.end - n.start; longSum += n.end - n.start; }
    const midis = pitched.map((n) => n.midi);
    const lowest = midis.length ? Math.min(...midis) : undefined;
    const highest = midis.length ? Math.max(...midis) : undefined;
    const meanLength = list.length ? longSum / list.length : 0;
    const declared = declaredRoles.get(voice);
    let role: VoiceUse["role"];
    if (declared) role = { basis: "observed", value: declared };
    else {
      const rank = ranked.indexOf(voice);
      let value = "unused";
      if (list.length === 0) value = "unused";
      else if (percussionCount > list.length / 2) value = "drums";
      else if (ranked.length > 1 && rank === 0) value = "bass";
      else if (meanLength >= 2 * model.framesPerBeat && sounding / model.totalFrames > 0.5) value = "pad";
      else if (ranked.length > 1 && rank === ranked.length - 1) value = "lead";
      else value = "accompaniment";
      role = { basis: "inferred", method: "pitch rank of the median note, note length and share of percussion", value };
    }
    return {
      voice, sid: Math.floor((voice - 1) / 3), noteCount: list.length, percussionCount,
      ...(lowest === undefined ? {} : { range: { lowest: noteName(lowest), highest: noteName(highest!), lowestMidi: lowest, highestMidi: highest! } }),
      ...(medians.has(voice) ? { medianMidi: medians.get(voice)! } : {}),
      notesPerSecond: round(list.length / seconds, 3), soundingShare: round(Math.min(1, sounding / Math.max(1, model.totalFrames)), 4), role,
    };
  });
}
