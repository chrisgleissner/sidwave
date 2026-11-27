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
import { leadingCalls, recoverScore, withGlobalTable, type LanguageExtension, type RecoveredScore, type RecoverOptions, type UnsupportedFeature } from "./recover.js";

/** What a user needs to know about a recovered score that does not fit one call period at 1 MHz. */
export const TURBO_MESSAGE = "does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers";

/** The score text with `cpu: turbo` added as a top-level field (a warning comment precedes it). */
export function withTurbo(text: string): string {
  return `${text.replace(/\n*$/, "\n")}# Warning: ${TURBO_MESSAGE}.\ncpu: turbo\n`;
}

/** The longest horizon when the caller gives none: the design's 180 s cap. */
export const DEFAULT_HORIZON_SECONDS = 180;

export interface ReconstructOptions {
  /** Subtune, 1-based as in the PSID header. Default: the header's start song. */
  song?: number;
  /** Horizon in seconds. Default 180. */
  seconds?: number;
  engine: SidEngine;
  title?: string;
  /**
   * "staged" (default): the recompiled score is traced for the first PROBE_SECONDS first; the retrace over the whole horizon
   * runs only when that probe is register-state exact or strict exact. "full": always trace the whole horizon.
   * Emulating both traces is most of the CPU time of a reconstruction, and a score that differs in the first seconds
   * rarely matches later.
   */
  verify?: "staged" | "full";
}

/** Seconds of the first, cheap verification trace of the recompiled score. */
export const PROBE_SECONDS = 10;

function recoverySummary(recovered: RecoveredScore): ReconstructReport["recovery"] {
  return {
    speed: recovered.speed, tempo: recovered.tempo, firstCall: recovered.firstCall, rows: recovered.rows,
    tuningCents: recovered.tuningCents, noteCount: recovered.noteCount, phantomNotes: recovered.phantomNotes, instrumentCount: recovered.instrumentCount,
    patternCount: recovered.patternCount, structure: recovered.structure, tuningEvidence: recovered.tuningEvidence,
    languageVersion: recovered.languageVersion, softStartOff: recovered.softStartOff,
  };
}

/** The calls of an IR that start within `seconds` of the call at `first` (the alignment point), together with the calls before it. */
export function trimIr(ir: FrameIr, first: number, seconds: number): FrameIr {
  const base = ir.calls[Math.min(first, ir.calls.length - 1)]?.startCycle ?? 0;
  const limit = base + seconds * ir.clockHz;
  let end = ir.calls.length;
  for (let i = Math.max(0, first); i < ir.calls.length; i++) if (ir.calls[i]!.startCycle > limit) { end = i; break; }
  return { ...ir, calls: ir.calls.slice(0, end) };
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
  /** Sum over the classes of the calls that differ in that class: a call that differs in two classes counts twice. */
  differingCalls: number;
  /** Number of compared calls with a difference in any class (each call counted once). Use "K of M calls differ" with this and comparedCalls. */
  callsWithDifference: number;
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
  /**
   * Present when the recovered score fails validation or compilation: a defect of the recovery (it must never return such a
   * score) or a language limit it did not respect. `field` is the path of the offending field when the message names one.
   */
  internalError?: { field?: string; message: string };
  /** How far the recompiled score was verified: the whole horizon, or only the first `probeSeconds` because the probe already differed. */
  verification?: { mode: "full" | "probe"; seconds: number };
  compile?: {
    ok: boolean;
    error?: string;
    /** The compiler's message when the recovered score needs more cycles per call than 1 MHz allows; the score was then compiled with `cpu: turbo`. */
    cycleBudgetExceeded?: string;
    /**
     * Present when the recovered score does not run at 1 MHz. The returned score text then carries `cpu: turbo` so that the
     * file compiles as it is; it needs Ultimate Turbo Registers on hardware. Such a result is never a strict match and is
     * left out of the A1 counts.
     */
    turboFallback?: { scoreIncludesTurbo: true; message: string };
  };
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
    differingCalls: differing, callsWithDifference: result.callsWithDifference, classes,
    ...(result.first ? { first: { class: result.first.class, call: result.first.call, timeSeconds: result.first.timeSeconds, voice: result.first.voice, register: result.first.register, expected: result.first.expected, observed: result.first.observed, detail: result.first.detail } } : {}),
    ...(result.callCountMismatch ? { callCountMismatch: result.callCountMismatch } : {}),
  };
}

/** F-diff of two IRs at the alignment (of three candidates) with the fewest differing calls. */
export function bestFdiff(expected: FrameIr, observed: FrameIr, firstExpected = 0): FDiffSummary {
  let best: FDiffSummary | undefined;
  const firstObserved = leadingCalls(observed);
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
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const clock: IrClock = psidClock(sidBytes) ?? "PAL";
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const trace = await options.engine.trace({ sid: sidBytes, song, seconds, clock });
  const t1 = performance.now();
  const original = irOfTrace(trace);
  const t2 = performance.now();
  const addresses = [0xd400, file.secondSidAddress, file.thirdSidAddress];
  const sids: NonNullable<RecoverOptions["sids"]> = [];
  for (let i = 0; i < addresses.length && addresses[i] !== undefined; i++) {
    const model = String(file.sidModels[i]);
    sids.push({ address: addresses[i]!, ...(model === "6581" || model === "8580" ? { model } : {}) });
  }
  let recovered = recoverScore(original, { title: options.title, sids });
  const t3 = performance.now();
  const timings: ReconstructTimings = { traceMs: t1 - t0, irMs: t2 - t1, recoverMs: t3 - t2, compileMs: 0, retraceMs: 0, fdiffMs: 0, totalMs: 0, totalCpuMs: 0 };
  let compiledBytes: Uint8Array | undefined;
  let cycleBudgetExceeded: string | undefined;
  let scoreText = recovered.text;
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
    recovery: recoverySummary(recovered),
  };
  try {
    const staged = (options.verify ?? "staged") === "staged" && seconds > PROBE_SECONDS;
    const compare = async (bytes: Uint8Array, horizonSeconds: number, trim: boolean) => {
      const tr0 = performance.now();
      const trace = await options.engine.trace({ sid: bytes, seconds: trim ? horizonSeconds + 1 : horizonSeconds, clock });
      const recompiled = irOfTrace(trace);
      const first = leadingCalls(recompiled);
      const exp = trim ? trimIr(original, recovered.firstCall, horizonSeconds) : original;
      const obs = trim ? trimIr(recompiled, first, horizonSeconds) : recompiled;
      const fd = bestFdiff(exp, obs, recovered.firstCall);
      const state = fd.equal && fd.standardAlignment ? fd : bestFdiff(stateOnlyIr(exp), stateOnlyIr(obs), recovered.firstCall);
      timings.retraceMs += performance.now() - tr0;
      return { fd, state };
    };
    /** Compiles a candidate score and compares its trace (the probe horizon when staged). */
    const attempt = async (candidate: RecoveredScore) => {
      const tc0 = performance.now();
      let text = candidate.text;
      let exceeded: string | undefined;
      let compiled;
      try {
        compiled = compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true });
      } catch (error) {
        // The player needs more cycles per call than one call period holds at 1 MHz. The score is compiled for a faster CPU
        // (`cpu: turbo`) so that the F-diff can still show what else differs; the report says so and the result is never a strict pass at 1 MHz.
        if (!(error instanceof Error) || !/use cpu: turbo/.test(error.message)) throw error;
        text = withTurbo(candidate.text);
        compiled = compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true });
        exceeded = error.message;
      }
      const bytes = new Uint8Array(compiled.bytes);
      timings.compileMs += performance.now() - tc0;
      return { candidate, text, exceeded, bytes, result: await compare(bytes, staged ? PROBE_SECONDS : seconds, staged) };
    };
    let best = await attempt(recovered);
    // When filter or volume differ, a second candidate writes those registers from a global_table; the closer one is kept.
    if (best.result.fd.classes.filter.differingCalls + best.result.fd.classes.volume.differingCalls > 0) {
      const alternative = withGlobalTable(original, recovered);
      if (alternative) {
        try {
          const other = await attempt(alternative);
          const cost = (a: typeof best) => a.result.fd.differingCalls + (a.exceeded ? 1 : 0);
          if (cost(other) < cost(best) && (!other.exceeded || best.exceeded)) best = other;
        } catch (error) {
          // The alternative does not compile (memory, cycles): the first candidate stands.
          if (!(error instanceof Error)) throw error;
        }
      }
    }
    recovered = best.candidate;
    report.unsupported = recovered.unsupported;
    report.languageExtensions = recovered.extensions;
    report.recovery = recoverySummary(recovered);
    scoreText = best.text;
    cycleBudgetExceeded = best.exceeded;
    compiledBytes = best.bytes;
    let result = best.result;
    const stateExact = (r: typeof result) => r.state.standardAlignment && !r.state.callCountMismatch
      && REGISTER_CLASSES.every((c) => c === "timing" || r.state.classes[c].differingCalls === 0);
    let verifiedSeconds = seconds;
    if (staged) {
      if (stateExact(result) || (result.fd.equal && result.fd.standardAlignment)) result = await compare(best.bytes, seconds, false);
      else verifiedSeconds = PROBE_SECONDS;
    }
    const tc3 = performance.now();
    report.verification = { mode: verifiedSeconds === seconds ? "full" : "probe", seconds: verifiedSeconds };
    report.fdiff = result.fd;
    report.fdiffState = result.state;
    report.compile = {
      ok: true,
      ...(cycleBudgetExceeded ? { cycleBudgetExceeded, turboFallback: { scoreIncludesTurbo: true as const, message: TURBO_MESSAGE } } : {}),
    };
    timings.fdiffMs = performance.now() - tc3;
    report.strictExact = report.fdiff.equal && report.fdiff.standardAlignment && !report.fdiff.callCountMismatch && !cycleBudgetExceeded && verifiedSeconds === seconds;
    report.registerStateExact = stateExact(result) && verifiedSeconds === seconds;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.compile = { ok: false, error: message };
    if (/^Invalid SIDWAVE/.test(message)) report.internalError = { field: /^Invalid SIDWAVE at (\$[^:]*):/.exec(message)?.[1], message };
    report.fdiff = summariseFdiff(fdiff(original, original), { expectedCall: 0, observedCall: 0 });
    report.fdiff.equal = false;
    report.fdiff.compileOk = false;
    report.fdiff.differingCalls = report.fdiff.comparedCalls * REGISTER_CLASSES.length;
    report.fdiff.callsWithDifference = report.fdiff.comparedCalls;
    for (const c of REGISTER_CLASSES) report.fdiff.classes[c] = { differingCalls: report.fdiff.comparedCalls, matchShare: 0 };
    report.fdiffState = report.fdiff;
  }
  const cpu = process.cpuUsage(cpu0);
  timings.totalMs = performance.now() - t0;
  timings.totalCpuMs = (cpu.user + cpu.system) / 1000;
  return { score: scoreText, report, ...(compiledBytes ? { compiled: compiledBytes } : {}), timings };
}
