// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Sample analysis for the MOD importer: each Amiga sample is described by a few measurements (periodicity, the strength of
// its first harmonics, its amplitude envelope, its length and the cycle length of its loop) and becomes a SIDWave waveform,
// an ADSR, a pitch correction and, for percussion, a drum.

import { createHash } from "node:crypto";
import type { ModSample } from "./mod.js";

/** Playback rate of a sample at period 428 (PAL Amiga: 7093789.2 / (2 x 428)). */
export const MOD_BASE_RATE = 8287;

export type SampleWaveform = "triangle" | "pulse" | "sawtooth" | "noise";

export interface SampleAnalysis {
  name: string;
  bytes: number;
  looped: boolean;
  seconds: number;
  /** Highest normalised autocorrelation of the analysed window (0 = noise, 1 = perfectly periodic). */
  periodicity: number;
  /** Period in sample points of the strongest periodicity, 0 when the sample is not periodic. */
  periodPoints: number;
  /** Length in sample points of one cycle of the looped section (may be fractional), 0 without a loop or a measurable pitch. */
  loopCycle: number;
  /** True for an audible loop whose cycle could not be measured reliably. */
  loopUnmeasured?: boolean;
  /** Amplitude of harmonics 2 to 6 relative to the first, when the sample is periodic. */
  harmonics: number[];
  zeroCrossings: number;
  waveform: SampleWaveform;
  pulseWidth?: number;
  adsr: [number, number, number, number];
  /** General MIDI percussion key when the sample is classified as percussion. */
  drum?: number;
  drumReason?: string;
}

const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
const DECAY_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];

function nearest(ms: number, table: number[]): number {
  let best = 0, bestError = Infinity;
  const target = Math.log(Math.max(1, ms));
  for (let i = 0; i < table.length; i++) {
    const e = Math.abs(Math.log(table[i]!) - target);
    if (e < bestError) { bestError = e; best = i; }
  }
  return best;
}

/** A pattern that matches one of the alternatives as a whole word: no letter before or after it (digits are allowed). */
const word = (alternatives: string): string => `(?<![a-z])(?:${alternatives})(?![a-z])`;

/**
 * Sample names that identify percussion, with the General MIDI key they stand for. First match wins. The compound names
 * hihat, hi-hat, tomtom and cymbal match anywhere in the name.
 */
const NAME_DRUMS: Array<[RegExp, number]> = ([
  [word("bd|kick|bassdrum|bass ?dr(?:um)?|bassd|bdrum"), 36],
  [word("sn|snare|sd|snr|rimshot|rim"), 38],
  [word("clap"), 39],
  [word("oh|open ?h(?:at)?|ohat"), 46],
  [`${word("hh|hat|chh|ch|h-h")}|hihat|hi-hat`, 42],
  [`${word("tom|tm")}|tomtom`, 45],
  [`${word("crash|cym|splash")}|cymbal`, 49],
] as Array<[string, number]>).map(([source, key]) => [new RegExp(source, "i"), key]);

export function drumFromName(name: string): number | undefined {
  for (const [re, key] of NAME_DRUMS) if (re.test(name)) return key;
  // "ride" is also an ordinary word, so it names a drum only without other words of three or more letters.
  const words: string[] = name.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.includes("ride") && words.every((w) => w.length < 3 || w === "ride" || w === "cymbal" || w === "bell")) return 49;
  return undefined;
}

/**
 * Normalised autocorrelation of `x` for the lags 2 to `maxLag` (entries 0 and 1 are 0). The energies of the two
 * overlapping parts come from prefix sums, so only the cross product is summed per lag.
 */
export function normalisedAutocorrelation(x: Float64Array, maxLag: number): number[] {
  const N = x.length;
  const r: number[] = new Array(maxLag + 1).fill(0);
  const energy = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) energy[i + 1] = energy[i]! + x[i]! * x[i]!;
  for (let lag = 2; lag <= maxLag; lag++) {
    let num = 0;
    for (let i = 0; i + lag < N; i++) num += x[i]! * x[i + lag]!;
    const e1 = energy[N - lag]!;
    const e2 = energy[N]! - energy[lag]!;
    r[lag] = e1 > 0 && e2 > 0 ? num / Math.sqrt(e1 * e2) : 0;
  }
  return r;
}

/** Longest cycle, in sample points, that the pitch of a loop is measured for. */
const MAX_CYCLE = 600;
/** A cycle with more sign changes than this is noise, and its length says nothing about a pitch. */
const MAX_SIGN_CHANGES_PER_CYCLE = 16;

/**
 * The period in a normalised autocorrelation: the shortest lag after the first negative value (so a slowly varying signal
 * does not count its own smoothness as a period) whose correlation is within 90 % of the best. `lag` is 0 when there is
 * none; `best` is the highest correlation after the first negative value.
 */
function shortestPeriod(r: number[]): { best: number; lag: number } {
  const first = r.findIndex((v) => v < 0);
  let best = 0;
  if (first < 0) return { best, lag: 0 };
  for (let lag = first; lag < r.length; lag++) if (r[lag]! > best) best = r[lag]!;
  for (let lag = first; lag < r.length; lag++) if (r[lag]! >= 0.9 * best && best > 0.3) return { best, lag };
  return { best, lag: 0 };
}

/** Share of the energy (without the mean) that one frequency must hold to count as a component of its own. */
const STRONG_BIN = 0.05;
/** Share of the energy that the harmonics of a cycle must hold in a loop of up to 600 points. */
const HARMONIC_SHARE = 0.85;
/** Correlation of one stretch of a long loop with itself one cycle later that counts as repeating. */
const REPEAT_CORRELATION = 0.8;

/**
 * Number of cycles in a short loop, from its discrete Fourier transform: the largest k for which bin k holds at least 5 %
 * of the energy without the mean, the multiples of k hold at least 85 %, and no other bin holds 5 % or more. The first
 * condition rejects chords, whose common cycle has no energy of its own; the last one rejects a k that skips a weaker
 * fundamental below a dominant harmonic. 0 when no k meets all three. O(length squared).
 */
function cyclesFromSpectrum(loop: Int8Array, mean: number): number {
  const L = loop.length;
  const cos = Float64Array.from({ length: L }, (_, i) => Math.cos(2 * Math.PI * i / L));
  const sin = Float64Array.from({ length: L }, (_, i) => Math.sin(2 * Math.PI * i / L));
  const half = Math.floor(L / 2);
  const power = new Float64Array(half + 1);
  let total = 0;
  for (let k = 1; k <= half; k++) {
    let re = 0, im = 0;
    for (let i = 0, a = 0; i < L; i++, a = (a + k) % L) { const v = loop[i]! - mean; re += v * cos[a]!; im += v * sin[a]!; }
    // Every bin below L / 2 has a mirror image above it.
    power[k] = (re * re + im * im) * (2 * k === L ? 1 : 2);
    total += power[k]!;
  }
  const strong: number[] = [];
  for (let k = 1; k <= half; k++) if (power[k]! >= STRONG_BIN * total) strong.push(k);
  for (let i = strong.length - 1; i >= 0; i--) {
    const k = strong[i]!;
    if (!strong.every((m) => m % k === 0)) continue;
    let sum = 0;
    for (let m = k; m <= half; m += k) sum += power[m]!;
    if (sum >= HARMONIC_SHARE * total) return k;
  }
  return 0;
}

/**
 * True when at least three quarters of up to 8 stretches of 2048 points, spread over the loop, correlate with themselves
 * at a lag within 4 % of `period`. This covers the parts of a long loop that the period was not measured from.
 */
function periodHolds(x: Float64Array, L: number, period: number): boolean {
  const windows = Math.min(8, Math.ceil(L / 2048));
  const reach = Math.max(1, Math.round(period * 0.04));
  const from = Math.max(2, Math.round(period) - reach), to = Math.round(period) + reach;
  let holding = 0;
  for (let w = 0; w < windows; w++) {
    const start = Math.floor(w * L / windows);
    for (let lag = from; lag <= to; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      for (let i = start; i < start + 2048; i++) { const p = x[i]!, q = x[i + lag]!; num += p * q; e1 += p * p; e2 += q * q; }
      if (num > 0 && num >= REPEAT_CORRELATION * Math.sqrt(e1 * e2)) { holding++; break; }
    }
  }
  return holding >= Math.ceil(0.75 * windows);
}

/** True when the bins within 3 % (at most 4 bins) of `cycles` hold at least 5 % of the energy of the loop. */
function hasFundamental(x: Float64Array, L: number, cycles: number): boolean {
  let total = 0;
  for (let i = 0; i < L; i++) total += x[i]! * x[i]!;
  const spread = Math.min(4, Math.floor(cycles * 0.03));
  let sum = 0;
  for (let k = cycles - spread; k <= cycles + spread; k++) {
    // The point (c, s) turns by one bin step per sample.
    const dc = Math.cos(2 * Math.PI * k / L), ds = Math.sin(2 * Math.PI * k / L);
    let re = 0, im = 0, c = 1, s = 0;
    for (let i = 0; i < L; i++) {
      re += x[i]! * c; im += x[i]! * s;
      const next = c * dc - s * ds;
      s = s * dc + c * ds; c = next;
    }
    sum += 2 * (re * re + im * im) / L;
  }
  return sum >= STRONG_BIN * total;
}

/**
 * Number of cycles in a loop above 600 points: the period comes from the autocorrelation of its first 2048 points and must
 * hold over the whole loop and carry energy of its own (a chord repeats at a period that none of its notes has). 0 otherwise.
 */
function cyclesFromAutocorrelation(loop: Int8Array, mean: number): number {
  const L = loop.length;
  // The loop without its mean, continued past its end far enough for every window and lag.
  const x = new Float64Array(L + 2048 + MAX_CYCLE + 32);
  for (let i = 0; i < x.length; i++) x[i] = loop[i % L]! - mean;
  const r = normalisedAutocorrelation(x.subarray(0, 2048), MAX_CYCLE);
  const { best, lag } = shortestPeriod(r);
  if (best < 0.55 || lag === 0) return 0;
  // The shortest lag may lie below the top of its peak, and an integer lag is too coarse for short cycles: climb to the top,
  // interpolate the peak, then follow it to 2, 4, 8, ... cycles.
  let period = lag;
  while (period < MAX_CYCLE && r[period + 1]! > r[period]!) period++;
  const reach = Math.max(1, Math.floor(period / 4));
  for (let m = 1; m * period + reach < MAX_CYCLE; m *= 2) {
    const centre = Math.round(m * period);
    let at = centre;
    for (let q = centre - reach; q <= centre + reach; q++) if (r[q]! > r[at]!) at = q;
    if (at <= 2 || at >= MAX_CYCLE) break;
    const curve = r[at - 1]! - 2 * r[at]! + r[at + 1]!;
    const shift = curve < 0 ? clamp((r[at - 1]! - r[at + 1]!) / (2 * curve), -0.5, 0.5) : 0;
    period = (at + shift) / m;
  }
  // The loop repeats exactly, so it holds a whole number of cycles.
  const cycles = Math.max(1, Math.round(L / period));
  return periodHolds(x, L, period) && hasFundamental(x, L, cycles) ? cycles : 0;
}

/**
 * Length in sample points of one cycle of a looped section, as it sounds when it repeats: the loop length divided by the
 * number of cycles in it. Returns 0 when there is no reliable value: silence, noise, a chord or other sound without one
 * dominant repetition, and a cycle above 600 points in a loop above 600 points.
 */
export function measureLoopCycle(loop: Int8Array): number {
  const L = loop.length;
  if (L < 4) return 0;
  let mean = 0;
  for (let i = 0; i < L; i++) mean += loop[i]!;
  mean /= L;
  let changes = 0;
  for (let i = 0; i < L; i++) if ((loop[i]! > mean) !== (loop[(i + 1) % L]! > mean)) changes++;
  if (changes === 0) return 0;
  const cycles = L > MAX_CYCLE ? cyclesFromAutocorrelation(loop, mean) : cyclesFromSpectrum(loop, mean);
  return cycles > 0 && changes <= MAX_SIGN_CHANGES_PER_CYCLE * cycles ? L / cycles : 0;
}

/** Root mean square around the mean of the points from `from` to `to`. */
function level(data: Int8Array, from: number, to: number): number {
  let sum = 0, squares = 0;
  for (let i = from; i < to; i++) { sum += data[i]!; squares += data[i]! * data[i]!; }
  const n = Math.max(1, to - from);
  return Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
}

/**
 * The cycle of the loop of a sample. A loop with a level below 4 (of 127) is silence. A loop below a tenth of the loudest
 * 256 points of the sample, or one under 16 points after 256 points or more, is a tail whose cycle says little about the
 * sound: it is not measured but reported.
 */
function loopPitch(s: ModSample): { loopCycle: number; loopUnmeasured?: boolean } {
  if (!s.looped) return { loopCycle: 0 };
  const loop = s.data.subarray(s.loopStart, s.loopStart + s.loopLength);
  const loopLevel = level(loop, 0, loop.length);
  if (loopLevel < 4) return { loopCycle: 0 };
  let peak = 0;
  for (let at = 0; at < s.data.length; at += 256) peak = Math.max(peak, level(s.data, at, Math.min(s.data.length, at + 256)));
  const tail = loopLevel < 0.1 * peak || (loop.length < 16 && s.loopStart >= 256);
  const loopCycle = tail ? 0 : measureLoopCycle(loop);
  return loopCycle > 0 ? { loopCycle } : { loopCycle, loopUnmeasured: true };
}

/** Recent analyses by sample content, oldest first. Bounded, because a long-running process imports many modules. */
const analysisCache = new Map<string, SampleAnalysis>();
const ANALYSIS_CACHE_LIMIT = 256;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Analyses one sample. Reads at most 2048 points for the periodicity and the harmonics, and every point a bounded number of
 * times for the envelope, the levels and the cycle of a loop (up to 8 stretches of 2048 points of a long loop).
 * A sample with the same name, loop and data as an earlier one gets a copy of that analysis.
 */
export function analyzeSample(s: ModSample): SampleAnalysis {
  const digest = createHash("sha1").update(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength)).digest("base64");
  const key = JSON.stringify([s.name, s.length, s.looped, s.loopStart, s.loopLength, digest]);
  let result = analysisCache.get(key);
  if (!result) {
    result = measureSample(s);
    if (analysisCache.size >= ANALYSIS_CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value!);
    analysisCache.set(key, result);
  }
  return structuredClone(result);
}

function measureSample(s: ModSample): SampleAnalysis {
  const n = s.length;
  const seconds = n / MOD_BASE_RATE;
  const base: SampleAnalysis = {
    name: s.name, bytes: n, looped: s.looped, seconds, periodicity: 0, periodPoints: 0, harmonics: [], zeroCrossings: 0,
    waveform: "pulse", pulseWidth: 0.5, adsr: [0, 4, 10, 4],
    ...loopPitch(s),
  };
  if (n < 32) {
    const drum = drumFromName(s.name);
    return { ...base, ...(drum ? { drum, drumReason: "name" } : {}) };
  }
  // Envelope: RMS of 16 blocks over the part that plays before the loop repeats (the whole sample when it does not loop).
  const span = s.looped ? Math.min(n, s.loopStart + s.loopLength) : n;
  const blocks = 16;
  const rms: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const from = Math.floor(b * span / blocks), to = Math.max(from + 1, Math.floor((b + 1) * span / blocks));
    let sum = 0;
    for (let i = from; i < to; i++) sum += s.data[i]! * s.data[i]!;
    rms.push(Math.sqrt(sum / (to - from)));
  }
  let peak = 0, peakBlock = 0;
  for (let b = 0; b < blocks; b++) if (rms[b]! > peak) { peak = rms[b]!; peakBlock = b; }
  const blockSeconds = span / blocks / MOD_BASE_RATE;
  // Analysis window: the loop (repeated to 2048 points when it is shorter) for a looped sample, otherwise 2048 points from a tenth in.
  let x: Float64Array;
  if (s.looped) {
    const len = Math.min(s.loopLength, 2048);
    const N0 = Math.max(len, Math.min(2048, len * Math.ceil(1024 / len)));
    x = new Float64Array(N0);
    for (let i = 0; i < N0; i++) x[i] = s.data[s.loopStart + (i % len)]!;
  } else {
    let w0 = Math.floor(n / 10);
    let w1 = Math.min(n, w0 + 2048);
    if (w1 - w0 < 64) { w0 = 0; w1 = Math.min(n, 2048); }
    x = new Float64Array(w1 - w0);
    for (let i = 0; i < x.length; i++) x[i] = s.data[w0 + i]!;
  }
  const N = x.length;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += x[i]!;
  mean /= N;
  let zc = 0;
  for (let i = 0; i < N; i++) { x[i] = x[i]! - mean; if (i > 0 && (x[i]! > 0) !== (x[i - 1]! > 0)) zc++; }
  const zeroCrossings = zc / N;
  // Periodicity: normalised autocorrelation.
  const maxLag = Math.min(MAX_CYCLE, Math.floor(N / 3));
  const { best, lag: lagBest } = shortestPeriod(normalisedAutocorrelation(x, maxLag));
  const periodic = best >= 0.55 && lagBest > 0;
  const harmonics: number[] = [];
  let waveform: SampleWaveform = "noise";
  let pulseWidth: number | undefined;
  if (periodic) {
    const periods = Math.max(1, Math.floor(N / lagBest));
    const M = periods * lagBest;
    const amp: number[] = [];
    for (let h = 1; h <= 6; h++) {
      let re = 0, im = 0;
      for (let i = 0; i < M; i++) { const a = 2 * Math.PI * h * i / lagBest; re += x[i]! * Math.cos(a); im -= x[i]! * Math.sin(a); }
      amp.push(Math.hypot(re, im) * 2 / M);
    }
    const h1 = Math.max(amp[0]!, 1e-9);
    for (let h = 1; h < 6; h++) harmonics.push(amp[h]! / h1);
    const [h2, h3] = harmonics as [number, number];
    if (h2 < 0.15 && h3 < 0.2) waveform = "triangle";
    else if (h2 < 0.2) { waveform = "pulse"; pulseWidth = 0.5; }
    else if (h2 >= 0.3 && h3 >= 0.2) waveform = "sawtooth";
    else { waveform = "pulse"; pulseWidth = 0.25; }
  }
  // ADSR from the envelope, the loop and the length.
  const attackMs = peakBlock * blockSeconds * 1000;
  const a = nearest(Math.max(2, attackMs), ATTACK_MS);
  let d: number, sus: number, rel: number;
  if (s.looped) {
    const loopFrom = Math.floor(s.loopStart * blocks / span);
    let loopSum = 0, loopCount = 0;
    for (let b = clamp(loopFrom, 0, blocks - 1); b < blocks; b++) { loopSum += rms[b]!; loopCount++; }
    const ratio = peak > 0 ? loopSum / loopCount / peak : 1;
    sus = clamp(Math.round(15 * ratio), 4, 15);
    const decayMs = Math.max(6, (s.loopStart / MOD_BASE_RATE) * 1000 - attackMs);
    d = nearest(decayMs, DECAY_MS);
    rel = 4;
  } else {
    sus = 0;
    let t10 = span / MOD_BASE_RATE;
    for (let b = peakBlock; b < blocks; b++) if (rms[b]! <= 0.1 * peak) { t10 = (b - peakBlock) * blockSeconds; break; }
    d = nearest(Math.max(6, t10 * 1000 * 2), DECAY_MS);
    rel = 3;
  }
  const result: SampleAnalysis = {
    ...base, periodicity: best, periodPoints: periodic ? lagBest : 0, harmonics, zeroCrossings, waveform,
    ...(pulseWidth === undefined ? { pulseWidth: undefined } : { pulseWidth }), adsr: [a, d, sus, rel],
  };
  if (result.pulseWidth === undefined) delete result.pulseWidth;
  // Percussion: by name, otherwise short one-shot samples that are noise-like, or short and low with a fast decay.
  const named = drumFromName(s.name);
  const tail = rms.slice(Math.floor(blocks * 3 / 4)).reduce((t, v) => t + v, 0) / (blocks / 4);
  const decays = peak > 0 && tail <= 0.25 * peak;
  if (named !== undefined) { result.drum = named; result.drumReason = "name"; }
  else if (!s.looped && decays && seconds <= 1.2 && !periodic) {
    result.drum = zeroCrossings > 0.35 ? (seconds < 0.12 ? 42 : seconds > 0.4 ? 49 : 46) : zeroCrossings < 0.15 ? (seconds < 0.4 ? 36 : 45) : 38;
    result.drumReason = "short noise-like one-shot";
  } else if (!s.looped && decays && seconds <= 0.35 && periodic && lagBest >= 55) {
    result.drum = seconds < 0.2 ? 36 : 45;
    result.drumReason = "short low one-shot with a fast decay";
  }
  return result;
}
