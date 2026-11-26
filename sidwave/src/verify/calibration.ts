// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createHash } from "node:crypto";
import {
  A1_GRID, A1_HOP, A1_SAMPLE_RATE, decideWindows, tuneVerdict,
  type A1BadClass, type A1Parameters, type A1WindowStats,
} from "./a1.js";
import type { MutationLabel } from "./mutations.js";

/**
 * Pure parts of the A1 calibration protocol (design: a1-calibration-design.md, sections 6 and 7): the split of the
 * base tunes, parameter selection on the development set, error rates with Wilson intervals and the list of
 * misclassified cases. The long-running parts (rendering, caching, the worker pool) are in scripts/calibrate-a1.mjs.
 */

/** The side of a base tune: SHA-256(tune id) mod 10 < 7 is development, otherwise held out. */
export function splitSide(tuneId: string): "development" | "heldout" {
  const digest = createHash("sha256").update(tuneId).digest("hex");
  return Number(BigInt(`0x${digest}`) % 10n) < 7 ? "development" : "heldout";
}

export interface Rate {
  count: number;
  total: number;
  rate: number;
  /** Wilson 95 % interval. */
  low: number;
  high: number;
}

/** Wilson score interval at 95 %. For total 0 the interval is [0, 1]. */
export function rateOf(count: number, total: number): Rate {
  if (total === 0) return { count, total, rate: 0, low: 0, high: 1 };
  const z = 1.959964;
  const p = count / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { count, total, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface CorpusItem {
  tune: string;
  class: string;
  severity: string;
  label: MutationLabel;
  stats: A1WindowStats;
}

export interface Classification {
  item: CorpusItem;
  verdict: "pass" | "fail";
  firstBad?: { timeSeconds: number; class: A1BadClass };
  badWindows: number;
}

/** Runs the decision rules of `p` over one item. */
export function classify(item: CorpusItem, p: A1Parameters): Classification {
  const verdict = tuneVerdict(decideWindows(item.stats, p), p);
  return {
    item,
    verdict: verdict.verdict,
    badWindows: verdict.badWindows,
    ...(verdict.firstBadWindow === undefined ? {} : { firstBad: { timeSeconds: (verdict.firstBadWindow * A1_HOP) / A1_SAMPLE_RATE, class: verdict.firstBadClass! } }),
  };
}

export interface ScoreReport {
  parameters: A1Parameters;
  /** Material defects that pass. */
  falseAccept: Rate;
  /** Benign changes that fail. */
  falseReject: Rate;
  byClass: Record<string, { falseAccept?: Rate; falseReject?: Rate }>;
  /** Borderline items: how many passed. */
  borderline: { passed: number; total: number };
  misclassified: Array<{ tune: string; class: string; severity: string; label: MutationLabel; verdict: "pass" | "fail"; firstBad: string }>;
}

function describeFirst(c: Classification): string {
  return c.firstBad ? `${c.firstBad.timeSeconds.toFixed(3)} s (${c.firstBad.class})` : "no bad window";
}

/** Scores the items that carry a label M or B; X items are only counted. */
export function scoreItems(items: readonly CorpusItem[], p: A1Parameters): ScoreReport {
  let fa = 0, material = 0, fr = 0, benign = 0, xPassed = 0, xTotal = 0;
  const perClass: Record<string, { fa: number; m: number; fr: number; b: number }> = {};
  const misclassified: ScoreReport["misclassified"] = [];
  for (const item of items) {
    const c = classify(item, p);
    const slot = (perClass[item.class] ??= { fa: 0, m: 0, fr: 0, b: 0 });
    if (item.label === "X") {
      xTotal++;
      if (c.verdict === "pass") xPassed++;
      continue;
    }
    const wrong = item.label === "M" ? c.verdict === "pass" : c.verdict === "fail";
    if (item.label === "M") { material++; slot.m++; if (wrong) { fa++; slot.fa++; } }
    else { benign++; slot.b++; if (wrong) { fr++; slot.fr++; } }
    if (wrong) misclassified.push({ tune: item.tune, class: item.class, severity: item.severity, label: item.label, verdict: c.verdict, firstBad: describeFirst(c) });
  }
  const byClass: ScoreReport["byClass"] = {};
  for (const [name, v] of Object.entries(perClass)) {
    byClass[name] = { ...(v.m ? { falseAccept: rateOf(v.fa, v.m) } : {}), ...(v.b ? { falseReject: rateOf(v.fr, v.b) } : {}) };
  }
  return { parameters: p, falseAccept: rateOf(fa, material), falseReject: rateOf(fr, benign), byClass, borderline: { passed: xPassed, total: xTotal }, misclassified };
}

export function gridPoints(): A1Parameters[] {
  const points: A1Parameters[] = [];
  for (const thetaSpec of A1_GRID.thetaSpec) for (const thetaLevel of A1_GRID.thetaLevel) for (const sGap of A1_GRID.sGap) {
    for (const k of A1_GRID.k) for (const m of A1_GRID.m) points.push({ thetaSpec, thetaLevel, sGap, k, m });
  }
  return points;
}

/** The weight of a false accept relative to a false reject. */
export const FALSE_ACCEPT_WEIGHT = 3;

export function objective(report: Pick<ScoreReport, "falseAccept" | "falseReject">): number {
  return FALSE_ACCEPT_WEIGHT * report.falseAccept.rate + report.falseReject.rate;
}

/** Orders two parameter sets with equal objective: the one with the larger thetaSpec, thetaLevel, sGap, k, m (in that order) first. */
export function preferLarger(a: A1Parameters, b: A1Parameters): number {
  for (const key of ["thetaSpec", "thetaLevel", "sGap", "k", "m"] as const) if (a[key] !== b[key]) return b[key] - a[key];
  return 0;
}

export interface Selection {
  best: ScoreReport;
  evaluated: number;
  /** The best few grid points, for the report. */
  top: Array<{ parameters: A1Parameters; objective: number; falseAccept: number; falseReject: number }>;
}

/**
 * Grid search on the development items: minimise 3 FA + FR; ties go to the larger parameters. `onPoint` observes each
 * evaluated grid point (for progress logs).
 */
export function selectParameters(items: readonly CorpusItem[], onPoint?: (index: number, total: number) => void): Selection {
  const points = gridPoints();
  const scored = points.map((p, i) => {
    const report = scoreItems(items, p);
    onPoint?.(i + 1, points.length);
    return { report, value: objective(report) };
  });
  scored.sort((a, b) => a.value - b.value || preferLarger(a.report.parameters, b.report.parameters));
  return {
    best: scored[0]!.report,
    evaluated: scored.length,
    top: scored.slice(0, 5).map((s) => ({ parameters: s.report.parameters, objective: s.value, falseAccept: s.report.falseAccept.rate, falseReject: s.report.falseReject.rate })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Window statistics on disk

const STATS_MAGIC = 0x31415341;

/** Serialises window statistics (and the alignment) for the render cache. */
export function encodeStats(stats: A1WindowStats, lagMs: number): Buffer {
  const n = stats.windows;
  const out = Buffer.alloc(16 + n * 16 + n);
  out.writeUInt32LE(STATS_MAGIC, 0);
  out.writeUInt32LE(n, 4);
  out.writeFloatLE(lagMs, 8);
  let offset = 16;
  for (const array of [stats.dSpec, stats.dLevel, stats.levelReference, stats.levelCandidate]) {
    for (let i = 0; i < n; i++) { out.writeFloatLE(array[i]!, offset); offset += 4; }
  }
  for (let i = 0; i < n; i++) out[offset + i] = stats.truncated[i]!;
  return out;
}

export function decodeStats(buffer: Buffer): { stats: A1WindowStats; lagMs: number } {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== STATS_MAGIC) throw new Error("not an A1 statistics file");
  const n = buffer.readUInt32LE(4);
  if (buffer.length !== 16 + n * 17) throw new Error("A1 statistics file has the wrong size");
  const read = (slot: number) => {
    const array = new Float32Array(n);
    for (let i = 0; i < n; i++) array[i] = buffer.readFloatLE(16 + slot * n * 4 + i * 4);
    return array;
  };
  const truncated = new Uint8Array(buffer.subarray(16 + n * 16, 16 + n * 17));
  return { stats: { windows: n, dSpec: read(0), dLevel: read(1), levelReference: read(2), levelCandidate: read(3), truncated }, lagMs: buffer.readFloatLE(8) };
}

export interface CorpusManifest {
  bases: Array<{ id: string; sha256: string }>;
  mutations: Array<{ class: string; severity: string; label: string }>;
  horizonMaxSeconds: number;
  sampleRate: number;
}

/** SHA-256 of the canonical JSON of the manifest. */
export function manifestHash(manifest: CorpusManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
