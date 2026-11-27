// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

/** Pitch material of composer 2: seeded random source, modes, triads and the functional chord grammar. */

/** Mulberry32, the same 32-bit sequence as the version 1 generator, with its own state. */
export type Random = () => number;

export function randomSource(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), state | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Derives an independent stream for a named purpose, so adding a feature never shifts another feature's draws. */
export function substream(seed: number, label: string): Random {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  return randomSource(h);
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

export function weighted<T>(random: Random, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let x = random() * total;
  for (const [item, w] of items) {
    x -= w;
    if (x < 0) return item;
  }
  return items[items.length - 1]![0];
}

export const pc = (midi: number): number => ((midi % 12) + 12) % 12;

export type ModeName = "major" | "minor" | "dorian" | "mixolydian" | "lydian" | "phrygian";
export const MODE_NAMES: readonly ModeName[] = ["major", "minor", "dorian", "mixolydian", "lydian", "phrygian"];

export const MODE_SCALES: Record<ModeName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

export type Fn = "T" | "P" | "D";

/** Scale degrees (0 based) that serve each harmonic function. Every listed triad is major or minor, never diminished. */
interface Grammar { T: readonly number[]; P: readonly number[]; D: readonly number[]; raiseDominant: boolean }

export const MODE_GRAMMAR: Record<ModeName, Grammar> = {
  major: { T: [0, 5, 2], P: [3, 1], D: [4], raiseDominant: false },
  minor: { T: [0, 5, 2], P: [3, 5], D: [4, 6], raiseDominant: true },
  dorian: { T: [0, 2], P: [3, 1], D: [6, 4], raiseDominant: false },
  mixolydian: { T: [0, 5], P: [3, 1], D: [6, 4], raiseDominant: false },
  lydian: { T: [0, 5, 2], P: [1], D: [4], raiseDominant: false },
  phrygian: { T: [0, 2, 5], P: [3], D: [1, 6], raiseDominant: false },
};

export interface Key { tonic: number; mode: ModeName }

export interface Chord {
  /** Pitch class of the root. */
  root: number;
  /** Pitch classes of root, third and fifth. */
  pcs: [number, number, number];
  minor: boolean;
  fn: Fn;
  /** Roman numeral relative to the key it was built in. */
  name: string;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

export function scalePcs(key: Key): number[] {
  return MODE_SCALES[key.mode].map((s) => pc(key.tonic + s));
}

export function triad(key: Key, degree: number, fn: Fn): Chord {
  const scale = MODE_SCALES[key.mode];
  const at = (d: number) => scale[d % 7]! + 12 * Math.floor(d / 7);
  const root = at(degree);
  let third = at(degree + 2);
  const fifth = at(degree + 4);
  if (fifth - root !== 7 || (third - root !== 3 && third - root !== 4)) {
    // A diminished or augmented triad; the grammar never asks for one.
    throw new Error(`degree ${degree + 1} of ${key.mode} is not a major or minor triad`);
  }
  if (fn === "D" && MODE_GRAMMAR[key.mode].raiseDominant && degree === 4 && third - root === 3) third += 1;
  const minor = third - root === 3;
  return {
    root: pc(key.tonic + root), pcs: [pc(key.tonic + root), pc(key.tonic + third), pc(key.tonic + fifth)], minor, fn,
    name: minor ? ROMAN[degree]!.toLowerCase() : ROMAN[degree]!,
  };
}

export type Cadence = "authentic" | "half" | "plagal" | "deceptive";

const NEXT: Record<Fn, ReadonlyArray<readonly [Fn, number]>> = {
  T: [["T", 2], ["P", 5], ["D", 2]],
  P: [["P", 2], ["D", 8]],
  D: [["T", 10]],
};

function chordOf(random: Random, key: Key, fn: Fn, previous?: Chord): Chord {
  const degrees = MODE_GRAMMAR[key.mode][fn];
  const options = degrees.map((d, i) => [d, i === 0 ? 4 : 2] as const);
  let degree = weighted(random, options);
  if (previous && degrees.length > 1) {
    const same = triad(key, degree, fn);
    if (same.root === previous.root && same.minor === previous.minor) degree = degrees.find((d) => d !== degree) ?? degree;
  }
  return triad(key, degree, fn);
}

/**
 * A chord progression of `slots` chords from the functional grammar: tonic, predominant and dominant, with the last two
 * slots fixed by the cadence. A single slot takes the cadential chord alone.
 */
export function progression(random: Random, key: Key, slots: number, cadence: Cadence): Chord[] {
  const out: Chord[] = [];
  const g = MODE_GRAMMAR[key.mode];
  const free = Math.max(0, slots - 2);
  let fn: Fn = "T";
  for (let i = 0; i < free; i++) {
    out.push(i === 0 ? triad(key, g.T[0]!, "T") : chordOf(random, key, fn, out[out.length - 1]));
    fn = weighted(random, NEXT[out[out.length - 1]!.fn]);
    // A predominant or dominant must still be able to reach the cadence.
    if (i === free - 1 && fn === "T" && (cadence === "authentic" || cadence === "deceptive")) fn = "P";
  }
  const last = (f: Fn, degree?: number) => (degree === undefined ? chordOf(random, key, f, out[out.length - 1]) : triad(key, degree, f));
  const cadenceChords: Chord[] = cadence === "authentic" ? [last("D"), triad(key, g.T[0]!, "T")]
    : cadence === "half" ? [last(random() < 0.6 ? "P" : "T"), last("D")]
      : cadence === "plagal" ? [last("P"), triad(key, g.T[0]!, "T")]
        : [last("D"), triad(key, g.T[Math.min(1, g.T.length - 1)]!, "T")];
  const tail = slots === 1 ? [cadenceChords[1]!] : cadenceChords;
  return [...out, ...tail];
}

/** The key of a section relative to the home key. */
export type KeyPlan = "home" | "dominant" | "subdominant" | "relative";

export function relatedKey(home: Key, plan: KeyPlan): Key {
  if (plan === "home") return home;
  if (plan === "dominant") return { tonic: pc(home.tonic + 7), mode: home.mode };
  if (plan === "subdominant") return { tonic: pc(home.tonic + 5), mode: home.mode };
  const minorish = home.mode === "minor" || home.mode === "dorian" || home.mode === "phrygian";
  return minorish ? { tonic: pc(home.tonic + 3), mode: "major" } : { tonic: pc(home.tonic + 9), mode: "minor" };
}

/** MIDI notes of the key's scale in [low, high], ascending. */
export function scaleNotes(key: Key, low: number, high: number): number[] {
  const set = new Set(scalePcs(key));
  const out: number[] = [];
  for (let n = low; n <= high; n++) if (set.has(pc(n))) out.push(n);
  return out;
}

export function nearest(candidates: readonly number[], target: number): number {
  let best = candidates[0]!;
  for (const c of candidates) if (Math.abs(c - target) < Math.abs(best - target)) best = c;
  return best;
}
