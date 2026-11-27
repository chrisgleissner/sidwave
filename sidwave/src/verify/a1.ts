// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EngineIdentity } from "../engine/types.js";

/**
 * A1: decides whether two PCM renders of a SID tune are materially the same music. It compares short windows of
 * the two renders and fails when windows that differ by more than calibrated thresholds cluster. Design and
 * calibration protocol: doc/plans/sidwave-standalone/research/a1-calibration-design.md.
 */

/**
 * Status of A1 from the held-out evaluation of the frozen rule file (data/verify/a1-heldout-report.json): "verified
 * within declared bounds" only when held-out false accepts and false rejects are both at most 5 %. Measured: 15.3 %
 * and 22.2 %, so A1 is "approximate".
 */
export const A1_STATUS: "approximate" | "verified within declared bounds" = "approximate";

export const A1_SAMPLE_RATE = 48_000;
export const A1_WINDOW = 1024;
export const A1_HOP = 512;
export const A1_BANDS = 48;
export const A1_BAND_RANGE_HZ = [40, 16_000] as const;
export const A1_FLOOR_DB = -60;
/** Lag search: +-12 steps of 96 samples (2 ms), i.e. +-24 ms, over the first 30 s. */
export const A1_LAG_STEP = 96;
export const A1_LAG_STEPS = 12;
export const A1_LAG_SECONDS = 30;
export const A1_SPAN_SECONDS = 2;
const MIN_DB = -120;

export interface A1Parameters {
  /** Mean band difference in dB above which a window is bad. */
  thetaSpec: number;
  /** Window level difference in dB above which a window is bad. */
  thetaLevel: number;
  /** Level gap in dB above the silence floor that makes one-sided sound a bad window. */
  sGap: number;
  /** Consecutive bad windows that fail the tune. */
  k: number;
  /** Bad windows within any 2 s span that fail the tune. */
  m: number;
}

/** Starting values from sidflow's ROM audit; engineering guesses, used until a rule file has been frozen. */
export const A1_STARTING_PARAMETERS: A1Parameters = { thetaSpec: 15, thetaLevel: 6, sGap: 10, k: 2, m: 3 };

export const A1_GRID = {
  thetaSpec: [6, 8, 10, 12, 15, 20],
  thetaLevel: [3, 4.5, 6, 9],
  sGap: [6, 10, 15],
  k: [2, 3, 4],
  m: [3, 5, 8],
} as const;

export type A1BadClass = "spectral" | "level" | "sound_in_silence" | "missing_sound" | "truncated";
export const A1_CLASSES: readonly A1BadClass[] = ["spectral", "level", "sound_in_silence", "missing_sound", "truncated"];
/** Window decision codes: 0 equal, then 1 + index into A1_CLASSES. */
const CODE_OK = 0;

export class A1Error extends Error {
  constructor(readonly code: "invalid_input" | "invalid_rules", message: string) {
    super(message);
    this.name = "A1Error";
  }
}

// ---------------------------------------------------------------------------------------------------------
// FFT

const HANN = new Float64Array(A1_WINDOW);
for (let i = 0; i < A1_WINDOW; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / A1_WINDOW);
const HANN_SUM = HANN.reduce((a, b) => a + b, 0);
const COS = new Float64Array(A1_WINDOW / 2);
const SIN = new Float64Array(A1_WINDOW / 2);
for (let i = 0; i < A1_WINDOW / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / A1_WINDOW);
  SIN[i] = -Math.sin((2 * Math.PI * i) / A1_WINDOW);
}
const BIT_REVERSE = new Uint16Array(A1_WINDOW);
for (let i = 0, bits = Math.log2(A1_WINDOW); i < A1_WINDOW; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  BIT_REVERSE[i] = r;
}

/** In-place radix-2 FFT of `re` and `im` (length a power of two, at most A1_WINDOW). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || n < 2 || (n & (n - 1)) !== 0 || n > A1_WINDOW) {
    throw new A1Error("invalid_input", `fft length must be a power of two from 2 to ${A1_WINDOW}`);
  }
  const shift = Math.log2(A1_WINDOW) - Math.log2(n);
  for (let i = 0; i < n; i++) {
    const j = BIT_REVERSE[i]! >> shift;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = A1_WINDOW / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]!;
        const wi = SIN[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Features

/** Overlap weight of every FFT bin with each band: bin i spans [(i - 0.5), (i + 0.5)] bin widths. */
const BAND_WEIGHTS: Array<{ first: number; weights: Float64Array }> = (() => {
  const binHz = A1_SAMPLE_RATE / A1_WINDOW;
  const edge = (k: number) => A1_BAND_RANGE_HZ[0] * Math.pow(A1_BAND_RANGE_HZ[1] / A1_BAND_RANGE_HZ[0], k / A1_BANDS);
  const bands: Array<{ first: number; weights: Float64Array }> = [];
  for (let b = 0; b < A1_BANDS; b++) {
    const lo = edge(b) / binHz;
    const hi = edge(b + 1) / binHz;
    const first = Math.max(1, Math.floor(lo + 0.5));
    const last = Math.min(A1_WINDOW / 2 - 1, Math.floor(hi + 0.5));
    const weights = new Float64Array(last - first + 1);
    for (let i = first; i <= last; i++) weights[i - first] = Math.max(0, Math.min(hi, i + 0.5) - Math.max(lo, i - 0.5));
    bands.push({ first, weights });
  }
  return bands;
})();

const toDb = (power: number) => (power > 1e-12 ? Math.max(MIN_DB, 10 * Math.log10(power)) : MIN_DB);

const HALF_WINDOW = A1_WINDOW / 2;
/** Highest FFT bin any band reads. */
const TOP_BIN = Math.max(...BAND_WEIGHTS.map(({ first, weights }) => first + weights.length - 1));
const packedRe = new Float64Array(HALF_WINDOW);
const packedIm = new Float64Array(HALF_WINDOW);
const binPower = new Float64Array(TOP_BIN + 1);

/**
 * Band energies in dBFS (a full-scale sine is -3 dBFS) of the window that starts at `start`. Samples outside the
 * signal read as zero. Writes A1_BANDS values to `out` at `offset` and returns the window RMS level in dBFS.
 *
 * The window is real, so its spectrum comes from one complex FFT of half the length: the even samples are the real
 * parts and the odd samples the imaginary parts, and the two spectra are separated afterwards. The squared magnitude
 * of each bin is formed directly instead of through `Math.hypot`, which is much slower.
 */
function windowFeatures(samples: Int16Array, start: number, out: Float32Array, offset: number): number {
  let sumSquares = 0;
  const inside = start >= 0 && start + A1_WINDOW <= samples.length;
  for (let j = 0; j < HALF_WINDOW; j++) {
    const i0 = start + 2 * j;
    const x0 = inside || (i0 >= 0 && i0 < samples.length) ? samples[i0]! / 32768 : 0;
    const x1 = inside || (i0 + 1 >= 0 && i0 + 1 < samples.length) ? samples[i0 + 1]! / 32768 : 0;
    sumSquares += x0 * x0 + x1 * x1;
    packedRe[j] = x0 * HANN[2 * j]!;
    packedIm[j] = x1 * HANN[2 * j + 1]!;
  }
  fft(packedRe, packedIm);
  const scale = (2 / HANN_SUM) ** 2 * 0.25;
  for (let k = 1; k <= TOP_BIN; k++) {
    const m = HALF_WINDOW - k;
    const a = packedRe[k]!, b = packedIm[k]!, c = packedRe[m]!, d = packedIm[m]!;
    const er = a + c, ei = b - d; // twice the even part
    const or = b + d, oi = c - a; // twice the odd part
    const wr = COS[k]!, wi = SIN[k]!;
    const re = er + wr * or - wi * oi;
    const im = ei + wr * oi + wi * or;
    binPower[k] = (re * re + im * im) * scale;
  }
  for (let b = 0; b < A1_BANDS; b++) {
    const { first, weights } = BAND_WEIGHTS[b]!;
    let power = 0;
    for (let j = 0; j < weights.length; j++) power += weights[j]! * 0.5 * binPower[first + j]!;
    out[offset + b] = toDb(power);
  }
  return toDb(sumSquares / A1_WINDOW);
}

export interface A1Features {
  /** Number of windows. */
  windows: number;
  /** windows x A1_BANDS band energies in dBFS. */
  bands: Float32Array;
  /** Window RMS level in dBFS. */
  level: Float32Array;
}

export function windowCount(sampleCount: number): number {
  return sampleCount < A1_WINDOW ? 0 : Math.floor((sampleCount - A1_WINDOW) / A1_HOP) + 1;
}

/** Features of `windows` windows at hop A1_HOP, the first starting at `offset` samples. */
export function extractFeatures(samples: Int16Array, windows: number, offset = 0, hop = A1_HOP): A1Features {
  const bands = new Float32Array(windows * A1_BANDS);
  const level = new Float32Array(windows);
  for (let w = 0; w < windows; w++) level[w] = windowFeatures(samples, offset + w * hop, bands, w * A1_BANDS);
  return { windows, bands, level };
}

function fluxOf(features: A1Features): Float64Array {
  const flux = new Float64Array(features.windows);
  for (let w = 1; w < features.windows; w++) {
    let sum = 0;
    for (let b = 0; b < A1_BANDS; b++) {
      const now = Math.max(A1_FLOOR_DB, features.bands[w * A1_BANDS + b]!);
      const before = Math.max(A1_FLOOR_DB, features.bands[(w - 1) * A1_BANDS + b]!);
      if (now > before) sum += now - before;
    }
    flux[w] = sum;
  }
  return flux;
}

function pearson(a: Float64Array, b: Float64Array, shift: number): number {
  // Correlates a[t] with b[t + shift] over the overlap.
  const from = Math.max(0, -shift);
  const to = Math.min(a.length, b.length - shift);
  const n = to - from;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let t = from; t < to; t++) { sa += a[t]!; sb += b[t + shift]!; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let t = from; t < to; t++) {
    const da = a[t]! - ma, db = b[t + shift]! - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

export interface A1Reference {
  samples: Int16Array;
  /** Flux of the first A1_LAG_SECONDS at hop A1_LAG_STEP, used for the lag search. */
  flux?: Float64Array;
  /** The horizon in samples that `flux` was computed for. */
  fluxHorizon?: number;
  /** Features at hop A1_HOP and offset 0, per window count. */
  features?: A1Features;
}

function lagFlux(samples: Int16Array, horizonSamples: number): Float64Array {
  const limit = Math.min(samples.length, horizonSamples, A1_LAG_SECONDS * A1_SAMPLE_RATE);
  const count = limit < A1_WINDOW ? 0 : Math.floor((limit - A1_WINDOW) / A1_LAG_STEP) + 1;
  return fluxOf(extractFeatures(samples, count, 0, A1_LAG_STEP));
}

/**
 * The lag in samples, a multiple of A1_LAG_STEP within +-24 ms, that maximises the correlation of the spectral flux of
 * the first 30 s. A positive lag means the candidate is late. Ties go to the smaller absolute lag.
 */
export function findLag(reference: A1Reference, candidate: Int16Array, horizonSamples: number): number {
  if (reference.flux === undefined || reference.fluxHorizon !== horizonSamples) {
    reference.flux = lagFlux(reference.samples, horizonSamples);
    reference.fluxHorizon = horizonSamples;
  }
  const other = lagFlux(candidate, horizonSamples);
  let best = 0;
  let bestScore = pearson(reference.flux, other, 0);
  for (let step = 1; step <= A1_LAG_STEPS; step++) {
    for (const k of [step, -step]) {
      const score = pearson(reference.flux, other, k);
      if (score > bestScore + 1e-9) { best = k; bestScore = score; }
    }
  }
  return best * A1_LAG_STEP;
}

// ---------------------------------------------------------------------------------------------------------
// Window statistics, decisions, verdict

export interface A1WindowStats {
  windows: number;
  /** Mean absolute band difference in dB over bands where either window is above the floor; 0 when no band is. */
  dSpec: Float32Array;
  dLevel: Float32Array;
  levelReference: Float32Array;
  levelCandidate: Float32Array;
  /** 1 where either signal does not cover the whole window. */
  truncated: Uint8Array;
}

/** Window statistics that do not depend on the thresholds, so that a parameter search can reuse them. */
export function windowStats(reference: A1Features, candidate: A1Features, truncated: Uint8Array): A1WindowStats {
  const windows = reference.windows;
  const dSpec = new Float32Array(windows);
  const dLevel = new Float32Array(windows);
  for (let w = 0; w < windows; w++) {
    let sum = 0, n = 0;
    for (let b = 0; b < A1_BANDS; b++) {
      const x = reference.bands[w * A1_BANDS + b]!;
      const y = candidate.bands[w * A1_BANDS + b]!;
      if (Math.max(x, y) > A1_FLOOR_DB) { sum += Math.abs(x - y); n++; }
    }
    dSpec[w] = n ? sum / n : 0;
    dLevel[w] = Math.abs(reference.level[w]! - candidate.level[w]!);
  }
  return { windows, dSpec, dLevel, levelReference: reference.level, levelCandidate: candidate.level, truncated };
}

/** Per window decision code: 0 equal, otherwise 1 + the index of the class in A1_CLASSES. */
export function decideWindows(stats: A1WindowStats, p: Pick<A1Parameters, "thetaSpec" | "thetaLevel" | "sGap">): Uint8Array {
  const codes = new Uint8Array(stats.windows);
  for (let w = 0; w < stats.windows; w++) {
    if (stats.truncated[w]) { codes[w] = 1 + A1_CLASSES.indexOf("truncated"); continue; }
    const a = stats.levelReference[w]!;
    const b = stats.levelCandidate[w]!;
    const aQuiet = a < A1_FLOOR_DB;
    const bQuiet = b < A1_FLOOR_DB;
    if (aQuiet && bQuiet) continue;
    if (aQuiet && b > A1_FLOOR_DB + p.sGap) { codes[w] = 1 + A1_CLASSES.indexOf("sound_in_silence"); continue; }
    if (bQuiet && a > A1_FLOOR_DB + p.sGap) { codes[w] = 1 + A1_CLASSES.indexOf("missing_sound"); continue; }
    if (stats.dSpec[w]! > p.thetaSpec) codes[w] = 1 + A1_CLASSES.indexOf("spectral");
    else if (stats.dLevel[w]! > p.thetaLevel) codes[w] = 1 + A1_CLASSES.indexOf("level");
  }
  return codes;
}

export interface A1Verdict {
  verdict: "pass" | "fail";
  badWindows: number;
  badByClass: Record<A1BadClass, number>;
  /** Window index of the first window of the earliest cluster that triggers the verdict. */
  firstBadWindow?: number;
  firstBadClass?: A1BadClass;
}

/** Fail on `k` consecutive bad windows or `m` bad windows within any 2 s span. */
export function tuneVerdict(codes: Uint8Array, p: Pick<A1Parameters, "k" | "m">): A1Verdict {
  const badByClass = Object.fromEntries(A1_CLASSES.map((c) => [c, 0])) as Record<A1BadClass, number>;
  const bad: number[] = [];
  let run = 0;
  let runStart = -1;
  let trigger = Infinity;
  for (let w = 0; w < codes.length; w++) {
    if (codes[w] === CODE_OK) { run = 0; continue; }
    badByClass[A1_CLASSES[codes[w]! - 1]!]++;
    bad.push(w);
    if (run === 0) runStart = w;
    run++;
    if (run >= p.k && runStart < trigger) trigger = runStart;
  }
  const span = (A1_SPAN_SECONDS * A1_SAMPLE_RATE) / A1_HOP;
  for (let i = 0; i + p.m - 1 < bad.length; i++) {
    if (bad[i + p.m - 1]! - bad[i]! < span && bad[i]! < trigger) { trigger = bad[i]!; break; }
  }
  const verdict: A1Verdict = { verdict: trigger === Infinity ? "pass" : "fail", badWindows: bad.length, badByClass };
  if (trigger !== Infinity) {
    verdict.firstBadWindow = trigger;
    verdict.firstBadClass = A1_CLASSES[codes[trigger]! - 1]!;
  }
  return verdict;
}

// ---------------------------------------------------------------------------------------------------------
// Rule file

export interface A1RuleFile {
  schema: "sidwave-a1-rules/1";
  parameters: A1Parameters;
  conditions: {
    sampleRate: number;
    channels: 1;
    window: number;
    hop: number;
    bands: number;
    bandRangeHz: [number, number];
    floorDb: number;
    lagRangeMs: number;
    lagStepSamples: number;
    lagSeconds: number;
    spanSeconds: number;
    engine: EngineIdentity;
    roms: { kernal: string; basic: string; chargen: string };
  };
  [key: string]: unknown;
}

export interface A1Rules extends A1Parameters {
  /** SHA-256 of the rule file bytes, or "unfrozen" for parameters that were not read from a rule file. */
  sha256: string;
  conditions?: A1RuleFile["conditions"];
}

export const A1_UNFROZEN = "unfrozen";

export function unfrozenRules(parameters: A1Parameters = A1_STARTING_PARAMETERS): A1Rules {
  return { ...parameters, sha256: A1_UNFROZEN };
}

/** Parses rule file text. The hash covers the exact bytes. */
export function parseA1Rules(text: string): A1Rules {
  let file: A1RuleFile;
  try {
    file = JSON.parse(text) as A1RuleFile;
  } catch (error) {
    throw new A1Error("invalid_rules", `A1 rule file is not valid JSON: ${(error as Error).message}`);
  }
  const p = file?.parameters;
  const ok = file?.schema === "sidwave-a1-rules/1" && p && [p.thetaSpec, p.thetaLevel, p.sGap, p.k, p.m].every((v) => Number.isFinite(v) && v > 0)
    && Number.isInteger(p.k) && Number.isInteger(p.m) && file.conditions?.sampleRate === A1_SAMPLE_RATE;
  if (!ok) throw new A1Error("invalid_rules", "A1 rule file has no valid schema, parameters or conditions");
  return { ...p, sha256: createHash("sha256").update(text).digest("hex"), conditions: file.conditions };
}

export function defaultA1RulesPath(): URL {
  return new URL("../../data/verify/a1-rules.json", import.meta.url);
}

/** Loads the frozen rule file shipped with the package (or `path`). */
export function loadA1Rules(path?: string | URL): A1Rules {
  return parseA1Rules(readFileSync(path ?? defaultA1RulesPath(), "utf8"));
}

// ---------------------------------------------------------------------------------------------------------
// Comparison

export interface A1Options {
  sampleRate?: number;
  /** Observation horizon in seconds. Default: the longer of the two renders. */
  horizonSeconds?: number;
  /** Cached reference features and flux, reused across candidates. */
  reference?: A1Reference;
}

export interface A1Result {
  verdict: "pass" | "fail";
  lagMs: number;
  windows: number;
  badWindows: number;
  badByClass: Record<A1BadClass, number>;
  firstBad?: { timeSeconds: number; class: A1BadClass };
  horizonSeconds: number;
  /** True when a render ended before the horizon; the missing windows count as bad. */
  truncated: boolean;
  rulesSha256: string;
}

export interface A1Analysis {
  stats: A1WindowStats;
  lagSamples: number;
  horizonSeconds: number;
  truncated: boolean;
}

/** Everything that does not depend on the thresholds: window statistics and alignment. */
export function analyzeAudioA1(reference: Int16Array, candidate: Int16Array, options: A1Options = {}): A1Analysis {
  const sampleRate = options.sampleRate ?? A1_SAMPLE_RATE;
  if (sampleRate !== A1_SAMPLE_RATE) throw new A1Error("invalid_input", `A1 is defined for ${A1_SAMPLE_RATE} Hz renders, not ${sampleRate} Hz`);
  const horizonSeconds = options.horizonSeconds ?? Math.max(reference.length, candidate.length) / sampleRate;
  if (!(horizonSeconds > 0) || !Number.isFinite(horizonSeconds)) throw new A1Error("invalid_input", "horizon must be a positive number of seconds");
  const horizonSamples = Math.round(horizonSeconds * sampleRate);
  const windows = windowCount(horizonSamples);
  if (windows === 0) throw new A1Error("invalid_input", `the horizon must cover at least one ${A1_WINDOW}-sample window`);
  const ref = options.reference ?? { samples: reference };
  if (ref.samples !== reference) throw new A1Error("invalid_input", "the cached reference belongs to another signal");
  const truncated = new Uint8Array(windows);
  let anyTruncated = false;
  for (let w = 0; w < windows; w++) {
    const end = w * A1_HOP + A1_WINDOW;
    if (end > reference.length || end > candidate.length) { truncated[w] = 1; anyTruncated = true; }
  }
  const identical = reference.length === candidate.length && Buffer.compare(
    Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength),
    Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength)) === 0;
  const lagSamples = identical ? 0 : findLag(ref, candidate, horizonSamples);
  ref.features = ref.features?.windows === windows ? ref.features : extractFeatures(reference, windows);
  const candidateFeatures = identical ? ref.features : extractFeatures(candidate, windows, lagSamples);
  return { stats: windowStats(ref.features, candidateFeatures, truncated), lagSamples, horizonSeconds, truncated: anyTruncated };
}

/** The verdict of an analysis under the given rules. */
export function judgeAnalysis(analysis: A1Analysis, rules: A1Rules): A1Result {
  const codes = decideWindows(analysis.stats, rules);
  const verdict = tuneVerdict(codes, rules);
  return {
    verdict: verdict.verdict,
    lagMs: (analysis.lagSamples * 1000) / A1_SAMPLE_RATE,
    windows: analysis.stats.windows,
    badWindows: verdict.badWindows,
    badByClass: verdict.badByClass,
    ...(verdict.firstBadWindow === undefined ? {} : {
      firstBad: { timeSeconds: (verdict.firstBadWindow * A1_HOP) / A1_SAMPLE_RATE, class: verdict.firstBadClass! },
    }),
    horizonSeconds: analysis.horizonSeconds,
    truncated: analysis.truncated,
    rulesSha256: rules.sha256,
  };
}

/** Compares two 48 kHz mono Int16 renders. */
export function compareAudioA1(reference: Int16Array, candidate: Int16Array, rules: A1Rules, options: A1Options = {}): A1Result {
  return judgeAnalysis(analyzeAudioA1(reference, candidate, options), rules);
}
