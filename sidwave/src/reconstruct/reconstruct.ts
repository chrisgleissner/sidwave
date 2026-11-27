// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// reconstructSid: trace a SID tune, recover a SIDWave score, compile it, trace it again and compare the two
// traces call by call (F-diff).

import { parseSidFile, type SidFile } from "../sidFile.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes } from "../sidwaveOps.js";
import { psidClock, type SidEngine } from "../engine/libsidplayfp.js";
import { fdiff, REGISTER_CLASSES, type FDiffResult, type RegisterClass } from "./fdiff.js";
import { buildIr, type FrameIr, type IrClock } from "./ir.js";
import { isInitCall, recoverScore, type LanguageExtension, type RecoveredScore, type UnsupportedFeature } from "./recover.js";

/** The longest horizon when the caller gives none: the design's 180 s cap. */
export const DEFAULT_HORIZON_SECONDS = 180;

export interface ReconstructOptions {
  /** Subtune, 1-based as in the PSID header. Default: the header's start song. */
  song?: number;
  /** Horizon in seconds. Default 180. */
  seconds?: number;
  engine: SidEngine;
  title?: string;
}

export interface FDiffSummary {
  /** The alignment that gave the fewest differing calls: first compared call of the original and of the recompiled trace. */
  alignment: { expectedCall: number; observedCall: number };
  /** True when the alignment is the standard one: the init call of each trace skipped. Any other alignment is never a strict pass. */
  standardAlignment: boolean;
  /** False when the recovered score did not compile; the classes then count every compared call as differing. */
  compileOk: boolean;
  equal: boolean;
  comparedCalls: number;
  expectedCalls: number;
  observedCalls: number;
  differingCalls: number;
  classes: Record<RegisterClass, { differingCalls: number; matchShare: number; first?: { call: number; timeSeconds: number; voice?: number; register?: number; expected?: number; observed?: number } }>;
  first?: { class: RegisterClass; call: number; timeSeconds: number; voice?: number; register?: number; expected?: number; observed?: number; detail?: string };
  callCountMismatch?: { expected: number; observed: number };
}

export interface ReconstructReport {
  horizon: { seconds: number; cycles: number; calls: number; clock: IrClock; song: number };
  callRate: { periodCycles: number; callsPerFrame: number; callsPerFrameExact: number; irregularShare: number };
  unsupported: UnsupportedFeature[];
  /** F-diff of the complete IRs: register state, in-call control write order, call timing. */
  fdiff: FDiffSummary;
  /** F-diff of the register state after each call only: in-call control write order is ignored. A tune that does not rewrite the control register in every call still matches here. */
  fdiffState: FDiffSummary;
  /**
   * Strict verdict: the recovered score compiled, the standard alignment was used, the call counts match and the
   * complete F-diff (register state, in-call order of control writes, call timing) shows no difference. The exit code
   * of `sidwave reconstruct` follows this value.
   */
  strictExact: boolean;
  /**
   * Secondary, weaker value: the register state after every call matches in every class except call timing.
   * It ignores (1) the order and number of control-register writes inside a call, so a test-bit pulse ($09 then $41)
   * equals a single $41 write, although the two sound different, (2) which registers a call writes, and (3) the
   * cycle at which each call starts. Do not read it as audio equality.
   */
  registerStateExact: boolean;
  languageExtensions: LanguageExtension[];
  recovery: Pick<RecoveredScore, "speed" | "tempo" | "firstCall" | "rows" | "tuningCents" | "noteCount" | "phantomNotes" | "instrumentCount" | "patternCount" | "structure" | "tuningEvidence" | "languageVersion" | "softStartOff">;
  compile?: { ok: boolean; error?: string };
}

/** Wall time (ms) and process CPU time (ms) of the phases of reconstructSid. CPU time covers the whole process, so concurrent work in the same process is included. */
export interface ReconstructTimings {
  traceMs: number;
  irMs: number;
  recoverMs: number;
  compileMs: number;
  retraceMs: number;
  fdiffMs: number;
  totalMs: number;
  totalCpuMs: number;
}

export interface ReconstructResult {
  score: string;
  report: ReconstructReport;
  /** The PSID of the recompiled score; absent when the score did not compile. */
  compiled?: Uint8Array;
  timings: ReconstructTimings;
}

export function summariseFdiff(result: FDiffResult, alignment: { expectedCall: number; observedCall: number }, standardAlignment = true): FDiffSummary {
  const classes = {} as FDiffSummary["classes"];
  let differing = 0;
  for (const c of REGISTER_CLASSES) {
    const s = result.classes[c];
    differing += s.differingCalls;
    classes[c] = {
      differingCalls: s.differingCalls,
      matchShare: s.matchShare,
      ...(s.first ? { first: { call: s.first.call, timeSeconds: s.first.timeSeconds, voice: s.first.voice, register: s.first.register, expected: s.first.expected, observed: s.first.observed } } : {}),
    };
  }
  return {
    alignment, standardAlignment, compileOk: true, equal: result.equal, comparedCalls: result.alignment.compared,
    expectedCalls: result.alignment.expectedCalls, observedCalls: result.alignment.observedCalls,
    differingCalls: differing, classes,
    ...(result.first ? { first: { class: result.first.class, call: result.first.call, timeSeconds: result.first.timeSeconds, voice: result.first.voice, register: result.first.register, expected: result.first.expected, observed: result.first.observed, detail: result.first.detail } } : {}),
    ...(result.callCountMismatch ? { callCountMismatch: result.callCountMismatch } : {}),
  };
}

/** F-diff of two IRs at the alignment (of three candidates) with the fewest differing calls. */
export function bestFdiff(expected: FrameIr, observed: FrameIr, firstExpected = 0): FDiffSummary {
  let best: FDiffSummary | undefined;
  const firstObserved = isInitCall(observed, 0) ? 1 : 0;
  // The first candidate skips the init call of each trace; the others cover tunes whose first call is not an init.
  const candidates: Array<readonly [number, number]> = [[firstExpected, firstObserved], [0, 0], [0, 1], [1, 0], [1, 1]];
  for (const [e, o] of candidates) {
    if (e >= expected.calls.length || o >= observed.calls.length) continue;
    const summary = summariseFdiff(fdiff(expected, observed, { alignExpected: e, alignObserved: o }), { expectedCall: e, observedCall: o }, e === candidates[0]![0] && o === candidates[0]![1]);
    const score = summary.differingCalls + (summary.callCountMismatch ? 1 : 0);
    const bestScore = best ? best.differingCalls + (best.callCountMismatch ? 1 : 0) : Infinity;
    if (score < bestScore) best = summary;
    // The standard alignment is the only one that can give a strict pass; when it already shows no difference the others cannot do better.
    if (best && best.differingCalls === 0 && !best.callCountMismatch && best.standardAlignment) break;
  }
  return best!;
}

/**
 * Builds the IR of a trace. SID indices without writes are removed (the engine numbers the chips of a tune
 * that was started with an explicit song selection from 1), so that the used chips are numbered 0, 1, ...
 */
/** The IR with the in-call control write sequences removed, so that only the register state after each call is compared. */
export function stateOnlyIr(ir: FrameIr): FrameIr {
  return { ...ir, calls: ir.calls.map((c) => ({ ...c, sids: c.sids.map((sid) => ({ ...sid, control: [[], [], []] as [number[], number[], number[]] })) })) };
}

export function irOfTrace(trace: { records: Float64Array; clock: IrClock; horizonCycles: number; originCycle: number }): FrameIr {
  const used = new Set<number>();
  for (let i = 0; i < trace.records.length; i += 4) used.add(trace.records[i]!);
  const order = [...used].sort((a, b) => a - b);
  let records = trace.records;
  if (order.some((sid, i) => sid !== i)) {
    records = Float64Array.from(trace.records);
    for (let i = 0; i < records.length; i += 4) records[i] = order.indexOf(records[i]!);
  }
  return buildIr(records, { clock: trace.clock, horizonCycles: trace.horizonCycles, originCycle: trace.originCycle });
}

export async function reconstructSid(sidBytes: Uint8Array, options: ReconstructOptions): Promise<ReconstructResult> {
  const file: SidFile = parseSidFile(sidBytes);
  const song = options.song ?? file.startSong;
  void file;
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const clock: IrClock = psidClock(sidBytes) ?? "PAL";
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const trace = await options.engine.trace({ sid: sidBytes, song, seconds, clock });
  const t1 = performance.now();
  const original = irOfTrace(trace);
  const t2 = performance.now();
  const recovered = recoverScore(original, { title: options.title });
  const t3 = performance.now();
  const timings: ReconstructTimings = { traceMs: t1 - t0, irMs: t2 - t1, recoverMs: t3 - t2, compileMs: 0, retraceMs: 0, fdiffMs: 0, totalMs: 0, totalCpuMs: 0 };
  let compiledBytes: Uint8Array | undefined;
  const report: ReconstructReport = {
    horizon: { seconds, cycles: trace.horizonCycles, calls: original.calls.length, clock: trace.clock, song },
    callRate: {
      periodCycles: original.periodCycles, callsPerFrame: original.callsPerFrame,
      callsPerFrameExact: original.callsPerFrameExact, irregularShare: original.jitter.irregularShare,
    },
    unsupported: recovered.unsupported,
    fdiff: undefined as unknown as FDiffSummary,
    fdiffState: undefined as unknown as FDiffSummary,
    strictExact: false,
    registerStateExact: false,
    languageExtensions: recovered.extensions,
    recovery: {
      speed: recovered.speed, tempo: recovered.tempo, firstCall: recovered.firstCall, rows: recovered.rows,
      tuningCents: recovered.tuningCents, noteCount: recovered.noteCount, phantomNotes: recovered.phantomNotes, instrumentCount: recovered.instrumentCount,
      patternCount: recovered.patternCount, structure: recovered.structure, tuningEvidence: recovered.tuningEvidence,
      languageVersion: recovered.languageVersion, softStartOff: recovered.softStartOff,
    },
  };
  try {
    const tc0 = performance.now();
    const compiled = compileSidwaveBytes(parseSidwave(recovered.text), { format: "sid", loop: true });
    compiledBytes = new Uint8Array(compiled.bytes);
    const tc1 = performance.now();
    const second = await options.engine.trace({ sid: compiledBytes, seconds, clock });
    const tc2 = performance.now();
    const recompiled = irOfTrace(second);
    const tc3 = performance.now();
    report.fdiff = bestFdiff(original, recompiled, recovered.firstCall);
    // When the complete F-diff is equal, the register-state F-diff (a weaker comparison of the same IRs) is equal too.
    report.fdiffState = report.fdiff.equal && report.fdiff.standardAlignment ? report.fdiff : bestFdiff(stateOnlyIr(original), stateOnlyIr(recompiled), recovered.firstCall);
    report.compile = { ok: true };
    timings.compileMs = tc1 - tc0;
    timings.retraceMs = tc2 - tc1;
    timings.irMs += tc3 - tc2;
    timings.fdiffMs = performance.now() - tc3;
    report.strictExact = report.fdiff.equal && report.fdiff.standardAlignment && !report.fdiff.callCountMismatch;
    report.registerStateExact = report.fdiffState.standardAlignment && !report.fdiffState.callCountMismatch
      && REGISTER_CLASSES.every((c) => c === "timing" || report.fdiffState.classes[c].differingCalls === 0);
  } catch (error) {
    report.compile = { ok: false, error: error instanceof Error ? error.message : String(error) };
    report.fdiff = summariseFdiff(fdiff(original, original), { expectedCall: 0, observedCall: 0 });
    report.fdiff.equal = false;
    report.fdiff.compileOk = false;
    report.fdiff.differingCalls = report.fdiff.comparedCalls * REGISTER_CLASSES.length;
    for (const c of REGISTER_CLASSES) report.fdiff.classes[c] = { differingCalls: report.fdiff.comparedCalls, matchShare: 0 };
    report.fdiffState = report.fdiff;
  }
  const cpu = process.cpuUsage(cpu0);
  timings.totalMs = performance.now() - t0;
  timings.totalCpuMs = (cpu.user + cpu.system) / 1000;
  return { score: recovered.text, report, ...(compiledBytes ? { compiled: compiledBytes } : {}), timings };
}
