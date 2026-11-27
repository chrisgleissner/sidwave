// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Quality metrics of `sidwave convert --verify`: the output is read back and compared note by note with a reference.

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type ExportedScore } from "./events.js";
import type { FormatDefinition } from "./formatTypes.js";
import type { ScorePlanResult } from "./scorePlan.js";

/** Agreement of two note lists. Every ratio is 0..1. */
export interface NoteAgreement {
  /** F1 of notes that match in pitch (drum hits: in drum identity) and onset time within the tolerance. */
  noteF1: number;
  precision: number;
  recall: number;
  /** F1 that ignores whether a note is a drum hit: only pitch and onset time count. */
  noteF1PitchOnly: number;
  /** F1 that also accepts a pitch that differs by whole octaves. `octaveShifted` counts these extra matches. */
  noteF1OctaveTolerant: number;
  octaveShifted: number;
  referenceNotes: number;
  outputNotes: number;
  onsetError: { meanMs: number; maxMs: number; matched: number };
  onsetToleranceMs: number;
  /** Mean over matched notes of (overlap of the two note intervals) / (union of the intervals). 1 when note ends agree. */
  durationOverlap: number;
  /** Share of matched notes whose output voice is the voice that most notes of the same reference voice went to (best mapping, invariant under a permutation of the voices). */
  voiceAgreement: number;
  /** Share of matched notes that stay in the voice with the same number. Unlike `voiceAgreement` it is not invariant under a permutation of the voices. */
  voiceAgreementIdentity: number;
  /** Matched drum hits whose output note is also a drum hit of the same kind, over the drum hits of the reference. 1 without drum hits. */
  drumIdentity: number;
}

export interface ConvertMetrics extends Partial<NoteAgreement> {
  /** False when the target cannot be read back, so no comparison is possible. */
  available: boolean;
  reason?: string;
  /** The reference of the numbers above: the score after the import, before reduction, all voices. */
  reference?: "score-after-import";
  durationSeconds?: { reference: number; output: number };
  voicesDropped?: number;
  instruments?: { used: number; mapped: number; unmapped: number };
  /** Agreement of the output with the notes of the source file itself (before the import), for sources that carry notes. */
  sourceVsOutput?: NoteAgreement & { source: string };
  /** F-diff of a reconstruct source. A1 is not computed by convert (see sidwave verify). */
  fdiff?: { equal: boolean; differingCalls: number; comparedCalls: number };
}

export interface Hit { time: number; end: number; pitch: number; voice: number; drum?: string }

export function hitsOf(score: ExportedScore): Hit[] {
  const out: Hit[] = [];
  for (const v of score.voices) for (const n of v.notes) out.push({ time: n.on.time, end: n.off.time, pitch: n.pitch, voice: v.index, ...(n.percussion ? { drum: n.drum ?? "drum" } : {}) });
  return out.sort((a, b) => a.time - b.time);
}

const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits;
const FRAME = 0.02;
const TOLERANCE_CAP = 0.1;

/**
 * Onset tolerance in seconds. A format without a grid gets one video frame (20 ms). A row-based target, or an importer
 * that quantises to a grid (MIDI, MusicXML: 0.25 beat by default), gets half a row or grid cell, at most 100 ms: rounding
 * a note start to the nearest row moves it by up to half a row (a sawtooth that does not accumulate), which is the
 * resolution of the format and not an error of the conversion.
 */
export function onsetTolerance(_reference: readonly Hit[], gridSeconds?: number): number {
  return gridSeconds ? Math.min(TOLERANCE_CAP, Math.max(FRAME, gridSeconds / 2 + 0.01)) : FRAME;
}

type Pair = [Hit, Hit];

/** Greedy matching per key of two time-sorted lists. */
function matchBy(ref: readonly Hit[], out: readonly Hit[], tol: number, key: (h: Hit) => string): { pairs: Pair[]; refLeft: Hit[]; outLeft: Hit[] } {
  const groups = new Map<string, Hit[]>();
  for (const h of out) { const k = key(h); const g = groups.get(k); if (g) g.push(h); else groups.set(k, [h]); }
  const next = new Map<string, number>();
  const used = new Set<Hit>();
  const pairs: Pair[] = [];
  const refLeft: Hit[] = [];
  for (const r of ref) {
    const k = key(r);
    const g = groups.get(k);
    let j = next.get(k) ?? 0;
    while (g && j < g.length && g[j]!.time < r.time - tol) j++;
    let m = j;
    while (g && m < g.length && g[m]!.time <= r.time + tol && used.has(g[m]!)) m++;
    if (g && m < g.length && Math.abs(g[m]!.time - r.time) <= tol) { used.add(g[m]!); pairs.push([r, g[m]!]); if (m === j) j++; } else refLeft.push(r);
    next.set(k, j);
  }
  return { pairs, refLeft, outLeft: out.filter((h) => !used.has(h)) };
}

const f1 = (matched: number, ref: number, out: number): { p: number; r: number; f: number } => {
  const p = out ? matched / out : ref ? 0 : 1;
  const r = ref ? matched / ref : 1;
  return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0 };
};

/** Compares two note lists. See NoteAgreement for the meaning of each value. */
export function compareHits(ref: readonly Hit[], out: readonly Hit[], tol: number): NoteAgreement {
  const identity = (h: Hit): string => (h.drum !== undefined ? `d:${h.drum}` : `p:${h.pitch}`);
  const exact = matchBy(ref, out, tol, identity);
  const pitchOnly = matchBy(ref, out, tol, (h) => `p:${h.pitch}`);
  const octave = matchBy(exact.refLeft, exact.outLeft, tol, (h) => `c:${((h.pitch % 12) + 12) % 12}`);
  const e = f1(exact.pairs.length, ref.length, out.length);
  const o = f1(exact.pairs.length + octave.pairs.length, ref.length, out.length);
  const po = f1(pitchOnly.pairs.length, ref.length, out.length);
  const errors = exact.pairs.map(([a, b]) => Math.abs(a.time - b.time) * 1000);
  const mean = errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : 0;
  let overlap = 0;
  for (const [a, b] of exact.pairs) {
    const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.time, b.time));
    const union = Math.max(a.end, b.end) - Math.min(a.time, b.time);
    overlap += union > 0 ? inter / union : 1;
  }
  // Voice agreement: map every reference voice to the output voice that received most of its matched notes.
  const counts = new Map<number, Map<number, number>>();
  for (const [a, b] of exact.pairs) { const m = counts.get(a.voice) ?? counts.set(a.voice, new Map()).get(a.voice)!; m.set(b.voice, (m.get(b.voice) ?? 0) + 1); }
  let agree = 0;
  for (const m of counts.values()) agree += Math.max(...m.values());
  const sameVoice = exact.pairs.filter(([a, b]) => a.voice === b.voice).length;
  const drumsRef = ref.filter((h) => h.drum !== undefined).length;
  const drumsMatched = exact.pairs.filter(([a]) => a.drum !== undefined).length;
  return {
    noteF1: round(e.f), precision: round(e.p), recall: round(e.r), noteF1PitchOnly: round(po.f), noteF1OctaveTolerant: round(o.f), octaveShifted: octave.pairs.length,
    referenceNotes: ref.length, outputNotes: out.length,
    onsetError: { meanMs: round(mean, 2), maxMs: round(errors.length ? Math.max(...errors) : 0, 2), matched: exact.pairs.length },
    onsetToleranceMs: round(tol * 1000, 1),
    durationOverlap: round(exact.pairs.length ? overlap / exact.pairs.length : ref.length ? 0 : 1),
    voiceAgreement: round(exact.pairs.length ? agree / exact.pairs.length : ref.length ? 0 : 1),
    voiceAgreementIdentity: round(exact.pairs.length ? sameVoice / exact.pairs.length : ref.length ? 0 : 1),
    drumIdentity: round(drumsRef ? drumsMatched / drumsRef : 1),
  };
}

export interface VerifyInput {
  target: FormatDefinition;
  source: FormatDefinition;
  sourceBytes: Uint8Array;
  output: Uint8Array;
  reference: ExportedScore;
  plan: ScorePlanResult;
  options: { mode?: "PAL" | "NTSC"; grid?: number; onsetToleranceSeconds?: number };
  parse: (yaml: string) => ParsedSidwave;
  writeReport: unknown;
}

/** Reads the output back with the target's importer and compares it with the reference (and with the source's own notes). */
export async function verifyOutput(input: VerifyInput): Promise<ConvertMetrics> {
  const { target, reference, plan } = input;
  const used = reference.instruments.length;
  const instruments = target.caps.instruments === "none" ? { used, mapped: 0, unmapped: used } : { used, mapped: used, unmapped: 0 };
  if (!target.read || target.readIsApproximate) {
    return { available: false, reason: target.read ? `reading ${target.id} is a reconstruct; use "sidwave verify" to compare compiled tunes` : `${target.id} cannot be read back`, voicesDropped: plan.dropped.length, instruments };
  }
  const read = await target.read(input.output, { name: `output.${target.id}`, validate: false, ...(input.options.mode ? { mode: input.options.mode } : {}), ...(input.options.grid === undefined ? {} : { grid: input.options.grid }) });
  const again = exportEvents(input.parse(read.yaml), { song: 0 });
  const ref = hitsOf(reference), out = hitsOf(again);
  const rowSeconds = (input.writeReport as { rowSeconds?: number } | undefined)?.rowSeconds;
  // An importer that quantises to a grid (MIDI, MusicXML) moves onsets by up to half a grid cell.
  const bpm = reference.tempoMap[0]?.bpm ?? 120;
  const gridSeconds = target.readQuantises ? (input.options.grid ?? 0.25) * 60 / bpm : undefined;
  const tol = input.options.onsetToleranceSeconds ?? onsetTolerance(ref, Math.max(rowSeconds ?? 0, gridSeconds ?? 0) || undefined);
  const metrics: ConvertMetrics = {
    available: true, reference: "score-after-import", ...compareHits(ref, out, tol),
    durationSeconds: { reference: round(reference.durationSeconds, 2), output: round(again.durationSeconds, 2) },
    voicesDropped: plan.dropped.length, instruments,
  };
  if (input.source.sourceNotes) {
    const notes = input.source.sourceNotes(input.sourceBytes);
    if (notes.length) metrics.sourceVsOutput = { source: `notes of the ${input.source.id} file`, ...compareHits(notes, out.map((h) => ({ ...h, drum: undefined })), onsetTolerance(notes, Math.max(rowSeconds ?? 0, gridSeconds ?? 0) || undefined)) };
  }
  return metrics;
}
