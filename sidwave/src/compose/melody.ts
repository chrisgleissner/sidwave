// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { barRhythm, type Slot } from "./rhythm.js";
import { nearest, pc, pick, scaleNotes, weighted, type Cadence, type Chord, type Key, type Random } from "./theory.js";

/** One note on a sixteenth grid. `at` counts cells from the start of the section; `midi` is null for a rest. */
export interface Note { at: number; dur: number; midi: number | null }

// ---------------------------------------------------------------------------------------------------------
// Motifs

/** A motif is a rhythm and the scale steps between its notes (the first step is 0). */
export interface Motif { steps: number[]; durs: number[] }

export type Development = "state" | "sequence" | "invert" | "fragment" | "augment" | "transpose" | "free";

const MOTIF_RHYTHMS: readonly number[][] = [[2, 2, 4], [4, 2, 2], [3, 1, 2, 2], [2, 2, 2, 2], [4, 4], [2, 2, 2, 2, 4], [3, 1, 4]];

export function makeMotif(random: Random, leaps: number): Motif {
  const durs = [...pick(random, MOTIF_RHYTHMS)];
  const steps = [0];
  for (let i = 1; i < durs.length; i++) {
    const step = weighted<number>(random, [[1, 3], [-1, 3], [2, 2 * leaps + 1], [-2, 2 * leaps + 1], [0, 1], [3, leaps], [-3, leaps]]);
    steps.push(step);
  }
  return { steps, durs };
}

/** A motif transformation. `invert` mirrors the steps, `augment` doubles the durations (within `maxCells`), `fragment` keeps the head. */
export function transformMotif(motif: Motif, kind: Development, maxCells: number): Motif {
  switch (kind) {
    case "invert": return { steps: motif.steps.map((s) => (s === 0 ? 0 : -s)), durs: motif.durs };
    case "augment": {
      const durs = motif.durs.map((d) => d * 2);
      return durs.reduce((a, b) => a + b, 0) <= maxCells ? { steps: motif.steps, durs } : motif;
    }
    case "fragment": {
      const keep = Math.max(2, Math.ceil(motif.steps.length / 2));
      const durs = motif.durs.slice(0, keep);
      durs[keep - 1] = durs[keep - 1]! + motif.durs.slice(keep).reduce((a, b) => a + b, 0);
      return { steps: motif.steps.slice(0, keep), durs };
    }
    default: return motif;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Melody

export interface MelodyInput {
  random: Random;
  key: Key;
  /** One chord per harmonic slot of the section, `slotsPerBar` per bar. */
  chords: Chord[];
  slotsPerBar: number;
  bars: number;
  barCells: number;
  phraseBars: number;
  groove: string;
  syncopation: number;
  density: number;
  motif: Motif;
  /** The development of the motif in each bar of a phrase (cycled). */
  plan: readonly Development[];
  /** The cadence that ends each phrase of the section. */
  cadences: Cadence[];
  range: [number, number];
  /** 0..1 appetite for leaps. */
  leaps: number;
  /** Starting pitch for the first phrase, or undefined for the middle of the range. */
  start?: number;
  /** Direction of sequences: -1 falls, 1 rises. */
  sequenceStep: number;
}

export interface MelodyResult { notes: Note[]; snapped: number }

const CONTOURS: ReadonlyArray<(f: number) => number> = [
  (f) => Math.sin(Math.PI * f), // arch
  (f) => f, // rise
  (f) => 1 - f, // fall
  (f) => 0.5 + 0.5 * Math.sin(2 * Math.PI * f), // wave
];

export function composeMelody(input: MelodyInput): MelodyResult {
  const { random, key, chords, slotsPerBar, bars, barCells, phraseBars, range } = input;
  const slotCells = barCells / slotsPerBar;
  const pool = scaleNotes(key, range[0], range[1]);
  const chordAt = (cell: number) => chords[Math.min(chords.length - 1, Math.floor(cell / slotCells))]!;
  const chordTones = (cell: number) => {
    const c = chordAt(cell);
    const out: number[] = [];
    for (let n = range[0]; n <= range[1]; n++) if (c.pcs.includes(pc(n))) out.push(n);
    return out;
  };
  const stepsFrom = (from: number, steps: number): number => {
    const i = pool.indexOf(nearest(pool, from));
    return pool[Math.max(0, Math.min(pool.length - 1, i + steps))]!;
  };
  /** A note that sounds on any beat (it starts on one or is held across one) must be a chord tone. */
  const needsChordTone = (cell: number, dur: number) => Math.ceil(cell / 4) * 4 <= cell + dur - 1;
  const mid = Math.round((range[0] + range[1]) / 2);
  let cur = input.start ?? nearest(chordTones(0), mid);
  let lastInterval = 0;
  let snapped = 0;
  let motifStart = cur;
  const notes: Note[] = [];
  const phrases = Math.ceil(bars / phraseBars);
  const centre = (range[0] + range[1]) / 2;

  for (let phrase = 0; phrase < phrases; phrase++) {
    const shape = pick(random, CONTOURS);
    const amplitude = 4 + Math.floor(random() * 4);
    const base = Math.max(range[0] + 2, Math.min(range[1] - amplitude - 1, centre - amplitude / 2 + (random() - 0.5) * 4));
    const cadence = input.cadences[Math.min(phrase, input.cadences.length - 1)] ?? "authentic";
    const barsHere = Math.min(phraseBars, bars - phrase * phraseBars);
    for (let b = 0; b < barsHere; b++) {
      const bar = phrase * phraseBars + b;
      const origin = bar * barCells;
      const last = b === barsHere - 1;
      const kind = last ? "free" : input.plan[b % input.plan.length]!;
      const target = (cell: number) => base + amplitude * shape((b * barCells + cell) / (barsHere * barCells));
      const slots: Slot[] = [];
      const pitched: Array<number | undefined> = [];
      let filled = 0;
      if (kind !== "free" && kind !== "transpose") {
        const m = kind === "state" || kind === "sequence" ? input.motif : transformMotif(input.motif, kind, barCells / 2);
        let from = b === 0 ? stepsFrom(nearest(chordTones(origin), target(0)), 0) : cur;
        if (kind === "sequence") from = stepsFrom(motifStart, input.sequenceStep);
        if (kind === "state") motifStart = from;
        if (kind === "sequence") motifStart = from;
        let p = from;
        let at = 0;
        m.steps.forEach((step, i) => {
          p = i === 0 ? from : stepsFrom(p, step);
          const cell = at;
          if (needsChordTone(cell, m.durs[i]!) && !chordAt(origin + cell).pcs.includes(pc(p))) {
            const tones = chordTones(origin + cell);
            if (tones.length > 0) { p = nearest(tones, p); snapped++; }
          }
          slots.push({ at: cell, dur: m.durs[i]!, rest: false });
          pitched.push(p);
          at += m.durs[i]!;
        });
        filled = at;
      }
      const rhythm = barRhythm(random, { groove: input.groove, cells: barCells, cadence: last, syncopation: input.syncopation, density: input.density });
      // The motif fills the start of the bar; the groove supplies the notes after it, the first one starting where the motif ends.
      const rest = filled === 0 ? rhythm : rhythm.filter((s) => s.at + s.dur > filled);
      if (filled > 0 && rest.length > 0 && rest[0]!.at !== filled) {
        rest[0] = { at: filled, dur: rest[0]!.at + rest[0]!.dur - filled, rest: rest[0]!.rest };
      } else if (filled > 0 && rest.length === 0) {
        slots[slots.length - 1]!.dur += barCells - filled;
      }
      for (const s of rest) { slots.push(s); pitched.push(undefined); }
      slots.forEach((s, i) => {
        const cell = origin + s.at;
        if (s.rest) {
          notes.push({ at: cell, dur: s.dur, midi: null });
          return;
        }
        let midi: number | undefined = pitched[i];
        const isFinal = last && i === slots.length - 1;
        if (midi === undefined) {
          const strong = needsChordTone(s.at, s.dur);
          const tones = chordTones(cell);
          let options = strong || isFinal ? tones : [...new Set([...pool, ...tones])].sort((a, c) => a - c);
          if (isFinal) {
            const tonic = pc(key.tonic);
            const home = tones.filter((n) => pc(n) === tonic);
            const third = tones.filter((n) => pc(n) === chordAt(cell).pcs[1]);
            options = (cadence === "authentic" || cadence === "plagal") && home.length > 0 ? home
              : cadence === "deceptive" && third.length > 0 ? third : tones;
          }
          const reach = strong ? 9 : 5;
          const near = options.filter((n) => Math.abs(n - cur) <= reach);
          const use = near.length > 0 ? near : options;
          const aim = isFinal ? cur : target(s.at);
          midi = weighted(random, use.map((n) => {
            const distance = Math.abs(n - cur);
            let w = Math.exp(-Math.abs(n - aim) / 5);
            w *= distance === 0 ? 0.25 : distance <= 2 ? 3 : distance <= 4 ? 2 : 0.6 + input.leaps;
            if (Math.abs(lastInterval) > 4 && Math.sign(n - cur) === -Math.sign(lastInterval)) w *= 2;
            return [n, w] as const;
          }));
        }
        lastInterval = midi - cur;
        cur = midi;
        notes.push({ at: cell, dur: s.dur, midi });
      });
    }
  }
  return { notes, snapped };
}

/** Embellishes a melody for a repeat: a long weak-beat note gains an upper neighbour, a late phrase may rise an octave. */
export function varyMelody(random: Random, notes: Note[], key: Key, range: [number, number], amount: number): Note[] {
  const pool = scaleNotes(key, range[0], range[1] + 12);
  const out: Note[] = [];
  for (const n of notes) {
    // The neighbour sounds on the last two cells of the note, so it must not start on a beat.
    if (n.midi !== null && n.dur >= 4 && n.at % 4 === 0 && (n.dur - 2) % 4 === 2 && random() < amount) {
      const up = pool.find((p) => p > n.midi!) ?? n.midi + 2;
      out.push({ at: n.at, dur: n.dur - 2, midi: n.midi }, { at: n.at + n.dur - 2, dur: 2, midi: up });
    } else out.push({ ...n });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Counterpoint

/** A note in beats, used by the rule checker on notes from any source. */
export interface TimedNote { start: number; end: number; midi: number }

export type CounterpointKind = "parallel-fifth" | "parallel-octave" | "dissonance" | "voice-crossing";

export interface CounterpointViolation { kind: CounterpointKind; beat: number; detail: string }

export interface CounterpointReport {
  /** Strong-beat sonorities compared. */
  sonorities: number;
  violations: CounterpointViolation[];
  /** Pairs of consecutive strong beats in which both voices moved. */
  movingPairs: number;
  /** Share of those pairs in which the voices moved in opposite directions. */
  contraryShare: number;
}

/** The pitch sounding at `beat`; `notes` must be sorted by start (binary search for the last note starting at or before it). */
function soundingAt(notes: readonly TimedNote[], beat: number): number | undefined {
  let lo = 0;
  let hi = notes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid]!.start <= beat + 1e-9) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Notes of one voice do not overlap, but a short earlier note may end after a later one starts only by rounding; look back a little.
  for (let i = found; i >= 0 && i > found - 3; i--) if (beat < notes[i]!.end - 1e-9) return notes[i]!.midi;
  return undefined;
}

const CONSONANT = new Set([0, 3, 4, 7, 8, 9]);

/**
 * Checks two voices on every strong beat (every `strongEvery` beats from beat 0, up to `endBeat`): consonance of the
 * interval, no parallel fifths or octaves between consecutive strong beats, and no voice crossing. `upper` should be
 * the higher voice. A strong beat where either voice rests is skipped, and the pair of beats around it is not compared.
 * Notes taken from a compiled score start and end on whole player calls, so `sampleOffset` (a fraction of a call, in beats)
 * moves the point where the voices are read just after the beat.
 */
export function checkCounterpoint(upper: readonly TimedNote[], lower: readonly TimedNote[], strongEvery: number, endBeat: number, sampleOffset = 0): CounterpointReport {
  const violations: CounterpointViolation[] = [];
  const byStart = (a: TimedNote, b: TimedNote) => a.start - b.start;
  upper = [...upper].sort(byStart);
  lower = [...lower].sort(byStart);
  let sonorities = 0;
  let movingPairs = 0;
  let contrary = 0;
  let previous: { u: number; l: number } | undefined;
  for (let beat = 0; beat < endBeat - 1e-9; beat += strongEvery) {
    const u = soundingAt(upper, beat + sampleOffset);
    const l = soundingAt(lower, beat + sampleOffset);
    if (u === undefined || l === undefined) { previous = undefined; continue; }
    sonorities++;
    const interval = u - l;
    if (interval < 0) violations.push({ kind: "voice-crossing", beat, detail: `lower voice is ${-interval} semitones above` });
    else if (!CONSONANT.has(interval % 12)) violations.push({ kind: "dissonance", beat, detail: `interval of ${interval} semitones` });
    if (previous) {
      const pi = previous.u - previous.l;
      const moved = u !== previous.u && l !== previous.l;
      if (moved) {
        movingPairs++;
        if (Math.sign(u - previous.u) !== Math.sign(l - previous.l)) contrary++;
        if (interval >= 0 && pi >= 0 && interval % 12 === pi % 12) {
          if (interval % 12 === 7) violations.push({ kind: "parallel-fifth", beat, detail: `fifths ${previous.l}-${previous.u} to ${l}-${u}` });
          if (interval % 12 === 0) violations.push({ kind: "parallel-octave", beat, detail: `octaves ${previous.l}-${previous.u} to ${l}-${u}` });
        }
      }
    }
    previous = { u, l };
  }
  return { sonorities, violations, movingPairs, contraryShare: movingPairs === 0 ? 0 : contrary / movingPairs };
}

export interface CounterInput {
  random: Random;
  lead: readonly Note[];
  chords: Chord[];
  slotsPerBar: number;
  barCells: number;
  bars: number;
  /** Range of the counter voice. */
  range: [number, number];
  /** Previous strong-beat pair carried over from the section before, if any. */
  previous?: { lead: number; counter: number };
}

/** Per-cell pitch of a line in onset order: -1 where nothing sounds (a rest or a gap). */
export function cellPitches(notes: readonly Note[], total: number): Int16Array {
  const out = new Int16Array(total).fill(-1);
  for (const n of notes) {
    if (n.midi === null) continue;
    for (let c = Math.max(0, n.at); c < Math.min(total, n.at + n.dur); c++) out[c] = n.midi;
  }
  return out;
}

/**
 * A second line under the lead, one note per strong beat, built from chord tones. The choice at each beat rejects
 * a consonance violation, a crossing or a parallel fifth or octave when any candidate avoids them, and otherwise
 * prefers contrary motion and small leaps.
 */
export function composeCounterLine(input: CounterInput): Note[] {
  const { random, lead, chords, slotsPerBar, barCells, bars, range } = input;
  const step = barCells === 12 ? 12 : 8;
  const slotCells = barCells / slotsPerBar;
  const total = bars * barCells;
  const out: Note[] = [];
  const leadCells = cellPitches(lead, total);
  let prev = input.previous ? { u: input.previous.lead, l: input.previous.counter } : undefined;
  for (let cell = 0; cell < total; cell += step) {
    const u = leadCells[cell]! < 0 ? null : leadCells[cell]!;
    const dur = Math.min(step, total - cell);
    if (u === null) { out.push({ at: cell, dur, midi: null }); prev = undefined; continue; }
    const chord = chords[Math.min(chords.length - 1, Math.floor(cell / slotCells))]!;
    const final = cell + step >= total;
    const tones: number[] = [];
    for (let n = Math.max(range[0], u - 19); n <= Math.min(range[1], u - 3); n++) if (chord.pcs.includes(pc(n))) tones.push(n);
    const scored = tones.map((n) => {
      const interval = u - n;
      let cost = 0;
      if (!CONSONANT.has(interval % 12)) cost += 100;
      if (interval < 3) cost += 100;
      if (prev) {
        const moved = u !== prev.u && n !== prev.l;
        const pi = prev.u - prev.l;
        if (moved && interval % 12 === pi % 12 && (interval % 12 === 7 || interval % 12 === 0)) cost += 100;
        if (moved && Math.sign(u - prev.u) === Math.sign(n - prev.l)) cost += 4;
        if (moved && (interval % 12 === 7 || interval % 12 === 0) && Math.sign(u - prev.u) === Math.sign(n - prev.l)) cost += 6;
        cost += Math.abs(n - prev.l) > 7 ? 6 : Math.abs(n - prev.l) * 0.5;
      }
      if (interval % 12 === 0 || interval % 12 === 7) cost += final ? 0 : 2;
      if (final && n % 12 === chord.root) cost -= 3;
      return { n, cost: cost + random() * 0.5 };
    });
    scored.sort((a, b) => a.cost - b.cost || a.n - b.n);
    // When nothing fits in range, fall back to the chord tone nearest to a sixth under the lead.
    const midi = scored[0]?.n ?? nearest(rangeNotes(range), u - 9);
    out.push({ at: cell, dur, midi });
    prev = { u, l: midi };
  }
  return out;
}

function rangeNotes(range: [number, number]): number[] {
  return Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
}

/**
 * Adjusts the lead's strong-beat notes against a sounding bass pitch: where an onset on a strong beat would be dissonant
 * with the bass or would continue parallel fifths or octaves from the previous strong beat, it moves to the nearest chord
 * tone that avoids both. A note that started before the strong beat moves as a whole. `carry` is the last sonority of the
 * section before. Returns the number of notes changed and the last sonority.
 */
export function fitLeadToBass(lead: Note[], bassAt: (cell: number) => number | undefined, chordAt: (cell: number) => Chord,
  step: number, total: number, range: [number, number], carry?: { u: number; l: number }): { changed: number; last?: { u: number; l: number } } {
  let changed = 0;
  let prev = carry;
  let at = 0;
  for (let cell = 0; cell < total; cell += step) {
    // The lead is in onset order, so the note sounding at an increasing cell is found by moving a pointer forward.
    while (at < lead.length && lead[at]!.at + lead[at]!.dur <= cell) at++;
    const note = at < lead.length && lead[at]!.at <= cell ? lead[at] : undefined;
    const l = bassAt(cell);
    if (!note || note.midi === null || l === undefined) { prev = undefined; continue; }
    const bad = (u: number) => {
      const interval = u - l;
      if (interval < 0 || !CONSONANT.has(interval % 12)) return true;
      if (!prev) return false;
      const moved = u !== prev.u && l !== prev.l;
      const pi = prev.u - prev.l;
      return moved && interval % 12 === pi % 12 && (interval % 12 === 7 || interval % 12 === 0);
    };
    if (bad(note.midi)) {
      const chord = chordAt(cell);
      const options: number[] = [];
      for (let n = Math.max(range[0], note.midi - 7); n <= Math.min(range[1], note.midi + 7); n++) {
        if (chord.pcs.includes(pc(n)) && !bad(n)) options.push(n);
      }
      if (options.length > 0) {
        options.sort((a, b) => Math.abs(a - note.midi!) - Math.abs(b - note.midi!) || a - b);
        note.midi = options[0]!;
        changed++;
      }
    }
    prev = { u: note.midi, l };
  }
  return { changed, last: prev };
}
