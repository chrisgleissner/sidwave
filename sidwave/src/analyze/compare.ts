// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Comparison of two inputs, each a SIDWave score or a SID tune: F-diff of their register traces (also per voice), the
// verification ladder T0 to A1 (with the calibration status of A1), and for two scores the semantic diff of S4.

import { createLibsidplayfpEngine, psidClock, type SidEngine } from "../engine/libsidplayfp.js";
import { SidwaveOperationError } from "../cliCore.js";
import { diffSidwave, type ChangeClass, type SemanticChange } from "../format/sidwaveFormat.js";
import { REGISTER_CLASSES } from "../reconstruct/fdiff.js";
import { bestFdiff, irOfTrace, stateOnlyIr, type FDiffSummary } from "../reconstruct/reconstruct.js";
import { md5ForSonglengths, parseSidFile } from "../sidFile.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes } from "../sidwaveOps.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { verifyTunes, type LoadedTune, type VerifyLevel, type VerifyReport } from "../sidwaveTools.js";
import type { A1Rules } from "../verify/index.js";
import { memoEngine, restrictIrToVoice, sha256 } from "./common.js";

export type CompareInput =
  | { kind: "score"; text: string; source?: string; read?: SidwaveReadOptions }
  | { kind: "sid"; bytes: Uint8Array; source?: string };

export interface CompareOptions {
  /** Engine for the traces and the A0 renders (SIDLite). Default: a new one. */
  engine?: SidEngine;
  /** Engine for A1 (reSIDfp). Default: a new one. */
  a1Engine?: SidEngine;
  /** Horizon in seconds. Default: one pass of the first score, else 30; at most 180. */
  seconds?: number;
  song?: number;
  /** Weakest ladder level that counts as a pass; the ladder always runs up to it. Default A1. */
  level?: VerifyLevel;
  /** Skip the ladder. */
  noLadder?: boolean;
  rules?: A1Rules;
  roms?: import("../engine/types.js").SystemRoms;
  signal?: AbortSignal;
}

export interface CompareReport {
  schema: "sidwave-compare/1";
  a: { kind: "score" | "sid"; source: string; sha256: string; md5: string };
  b: { kind: "score" | "sid"; source: string; sha256: string; md5: string };
  horizon: { seconds: number; callsA: number; callsB: number; clock: string };
  /** True when the complete F-diff (register state, in-call control order, call timing) shows no difference. */
  equal: boolean;
  fdiff: FDiffSummary;
  /** F-diff of the register state after each call only. */
  fdiffState: FDiffSummary;
  /** F-diff restricted to one voice at a time (global voice numbers, 1-based): differing calls and the first difference. */
  voices: Array<{ voice: number; equal: boolean; differingCalls: number; first?: { class: string; call: number; timeSeconds: number; register?: number; expected?: number; observed?: number } }>;
  /** Verification ladder; absent with noLadder. */
  ladder?: VerifyReport & { notes: string[] };
  /** Both inputs are scores: the semantic diff of the two. */
  musical?: { compiledEqual: boolean; changes: number; byClass: Record<ChangeClass, number>; first: SemanticChange[] };
}

function prepare(input: CompareInput): LoadedTune & { durationSeconds?: number } {
  if (input.kind === "sid") {
    parseSidFile(input.bytes);
    return { source: input.source ?? "sid", kind: "sid", bytes: input.bytes, md5: md5ForSonglengths(input.bytes) };
  }
  const doc = parseSidwave(input.text, input.read ?? {});
  const compiled = compileSidwaveBytes(doc, { format: "sid" });
  const bytes = new Uint8Array(compiled.bytes);
  return { source: input.source ?? "score", kind: "score", bytes, md5: md5ForSonglengths(bytes), durationSeconds: compiled.summary.durationSeconds };
}

const MAX_SECONDS = 180;

export async function compare(a: CompareInput, b: CompareInput, options: CompareOptions = {}): Promise<CompareReport> {
  const left = prepare(a);
  const right = prepare(b);
  const engine = memoEngine(options.engine ?? createLibsidplayfpEngine({ emulation: "sidlite" }));
  const seconds = options.seconds ?? Math.max(0.1, Math.min(left.durationSeconds ?? right.durationSeconds ?? 30, MAX_SECONDS));
  if (!(seconds > 0) || seconds > MAX_SECONDS) throw new SidwaveOperationError("usage", `the horizon must be in (0, ${MAX_SECONDS}] seconds`);
  const clock = psidClock(left.bytes) ?? "PAL";
  const request = (bytes: Uint8Array) => ({ sid: bytes, seconds, clock, ...(options.song === undefined ? {} : { song: options.song }), ...(options.signal ? { signal: options.signal } : {}) });
  const [ta, tb] = await Promise.all([engine.trace(request(left.bytes)), engine.trace(request(right.bytes))]);
  const ira = irOfTrace(ta);
  const irb = irOfTrace(tb);
  const fd = bestFdiff(ira, irb);
  const fs = bestFdiff(stateOnlyIr(ira), stateOnlyIr(irb));
  const voices: CompareReport["voices"] = [];
  const voiceCount = Math.max(ira.sidCount, irb.sidCount) * 3;
  for (let v = 1; v <= voiceCount; v++) {
    const s = bestFdiff(restrictIrToVoice(ira, v), restrictIrToVoice(irb, v));
    voices.push({
      voice: v, equal: s.equal && !s.callCountMismatch, differingCalls: s.differingCalls,
      ...(s.first ? { first: { class: s.first.class, call: s.first.call, timeSeconds: s.first.timeSeconds, register: s.first.register, expected: s.first.expected, observed: s.first.observed } } : {}),
    });
  }
  const report: CompareReport = {
    schema: "sidwave-compare/1",
    a: { kind: left.kind, source: left.source, sha256: sha256(left.bytes), md5: left.md5 },
    b: { kind: right.kind, source: right.source, sha256: sha256(right.bytes), md5: right.md5 },
    horizon: { seconds, callsA: ira.calls.length, callsB: irb.calls.length, clock: ta.clock },
    equal: fd.equal && fd.standardAlignment && !fd.callCountMismatch,
    fdiff: fd, fdiffState: fs, voices,
  };
  if (!options.noLadder) {
    const ladder = await verifyTunes(left, right, {
      level: options.level ?? "A1", seconds, ...(options.song === undefined ? {} : { song: options.song }), clock,
      createEngine: (emulation) => (emulation === "sidlite" ? engine : options.a1Engine ?? createLibsidplayfpEngine({ emulation })),
      ...(options.rules ? { rules: options.rules } : {}), ...(options.roms ? { roms: options.roms } : {}), ...(options.signal ? { signal: options.signal } : {}),
    });
    const notes: string[] = [];
    if (left.kind !== right.kind || left.kind === "score") {
      notes.push("T0 and T1 compare the writes of one player: they are not applicable between a SIDWave-compiled score and another player, so a failure there is expected. The F-diff above is the diagnostic.");
    }
    if (ladder.a1?.reason) notes.push(`A1 was not evaluated: ${ladder.a1.reason}`);
    notes.push(`A1 calibration status: ${ladder.a1?.status ?? "approximate"}`);
    report.ladder = { ...ladder, notes };
  }
  if (a.kind === "score" && b.kind === "score") {
    const diff = diffSidwave(a.text, b.text, a.read);
    const byClass: Record<ChangeClass, number> = { formatting: 0, musical: 0, synthesis: 0, hardware: 0, structural: 0 };
    for (const c of diff.changes) byClass[c.class]++;
    report.musical = { compiledEqual: diff.compiledEqual, changes: diff.changes.length, byClass, first: diff.changes.slice(0, 20) };
  }
  return report;
}

/** The report as text for a terminal. */
export function formatCompare(r: CompareReport): string {
  const L: string[] = [];
  L.push(`a: ${r.a.source} (${r.a.kind}), b: ${r.b.source} (${r.b.kind})`);
  L.push(`Horizon: ${r.horizon.seconds} s, ${r.horizon.callsA} and ${r.horizon.callsB} player calls, ${r.horizon.clock}`);
  L.push(`F-diff: ${r.equal ? "equal" : "different"} (${r.fdiff.differingCalls} differing calls of ${r.fdiff.comparedCalls} compared; register state alone: ${r.fdiffState.differingCalls})`);
  for (const c of REGISTER_CLASSES) {
    const s = r.fdiff.classes[c];
    if (s.differingCalls) L.push(`  ${c}: ${s.differingCalls} differing calls, match ${(s.matchShare * 100).toFixed(1)}%${s.first ? `, first at call ${s.first.call} (${s.first.timeSeconds.toFixed(3)} s)` : ""}`);
  }
  if (r.fdiff.callCountMismatch) L.push(`  call count: ${r.fdiff.callCountMismatch.expected} against ${r.fdiff.callCountMismatch.observed}`);
  for (const v of r.voices) if (!v.equal) L.push(`  voice ${v.voice}: ${v.differingCalls} differing calls${v.first ? `, first ${v.first.class} at call ${v.first.call}` : ""}`);
  if (r.ladder) {
    const lad = r.ladder;
    L.push(`Ladder: highest level reached ${lad.level}, requested ${lad.requestedLevel}: ${lad.verdict}`);
    for (const lv of ["T0", "T1", "A0", "A1"] as const) L.push(`  ${lv}: ${lad.levels[lv]}`);
    if (lad.a1 && !lad.a1.reason && lad.a1.windows !== undefined) L.push(`  A1 (${lad.a1.status}): ${lad.a1.badWindows} of ${lad.a1.windows} windows differ`);
    for (const n of lad.notes) L.push(`  note: ${n}`);
  }
  if (r.musical) {
    const m = r.musical;
    L.push(`Musical diff: ${m.changes} changes (${Object.entries(m.byClass).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}), compiled output ${m.compiledEqual ? "identical" : "differs"}`);
    for (const c of m.first.slice(0, 10)) L.push(`  ${c.class} ${c.path}`);
  }
  return `${L.join("\n")}\n`;
}
