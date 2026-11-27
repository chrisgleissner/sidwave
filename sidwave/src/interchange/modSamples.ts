// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Sample analysis for the MOD importer: each Amiga sample is described by a few measurements (periodicity, the strength of
// its first harmonics, its amplitude envelope and its length) and becomes a SIDWave waveform, an ADSR and, for percussion, a drum.

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

/** Sample names that identify percussion, with the General MIDI key they stand for. First match wins. */
const NAME_DRUMS: Array<[RegExp, number]> = [
  [/(^|[^a-z])(bd|kick|bassdrum|bass ?dr(um)?|bassd|bdrum|bd\d)([^a-z]|$)|kick/i, 36],
  [/(^|[^a-z])(sn|snare|sd|snr|rimshot|rim)([^a-z]|$)|snare/i, 38],
  [/clap/i, 39],
  [/(^|[^a-z])(oh|open ?h(at)?|ohat)([^a-z]|$)/i, 46],
  [/(^|[^a-z])(hh|hat|hihat|hi-hat|chh|ch|h-h)([^a-z]|$)|hihat|hi-hat/i, 42],
  [/(^|[^a-z])(tom|tm)([^a-z]|$)|tomtom/i, 45],
  [/crash|cymbal|cym|ride|splash/i, 49],
];

export function drumFromName(name: string): number | undefined {
  for (const [re, key] of NAME_DRUMS) if (re.test(name)) return key;
  return undefined;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Analyses one sample. Reads at most 2048 points for the periodicity and the harmonics and every point once for the envelope. */
export function analyzeSample(s: ModSample): SampleAnalysis {
  const n = s.length;
  const seconds = n / MOD_BASE_RATE;
  const base: SampleAnalysis = {
    name: s.name, bytes: n, looped: s.looped, seconds, periodicity: 0, periodPoints: 0, harmonics: [], zeroCrossings: 0,
    waveform: "pulse", pulseWidth: 0.5, adsr: [0, 4, 10, 4],
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
  // Periodicity: normalised autocorrelation, shortest lag within 90 % of the best.
  const maxLag = Math.min(600, Math.floor(N / 3));
  const r: number[] = new Array(maxLag + 1).fill(0);
  let best = 0;
  for (let lag = 6; lag <= maxLag; lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < N; i++) { num += x[i]! * x[i + lag]!; e1 += x[i]! * x[i]!; e2 += x[i + lag]! * x[i + lag]!; }
    const v = e1 > 0 && e2 > 0 ? num / Math.sqrt(e1 * e2) : 0;
    r[lag] = v;
    if (v > best) best = v;
  }
  let lagBest = 0;
  for (let lag = 6; lag <= maxLag; lag++) if (r[lag]! >= 0.9 * best && r[lag]! > 0.3) { lagBest = lag; break; }
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
    result.drum = zeroCrossings > 0.35 ? (seconds < 0.12 ? 42 : seconds > 0.4 ? 49 : 46) : 38;
    result.drumReason = "short noise-like one-shot";
  } else if (!s.looped && decays && seconds <= 0.35 && periodic && lagBest >= 55) {
    result.drum = seconds < 0.2 ? 36 : 45;
    result.drumReason = "short low one-shot with a fast decay";
  }
  return result;
}
