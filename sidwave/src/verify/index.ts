// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createHash } from "node:crypto";
import { psidClock } from "../engine/libsidplayfp.js";
import type { EngineIdentity, SidClock, SidEngine, SidEmulation, SystemRoms } from "../engine/types.js";
import { A1_SAMPLE_RATE, A1_STATUS, compareAudioA1, type A1Result, type A1Rules } from "./a1.js";

export * from "./a1.js";

export type Difference = {
  level: "T0" | "T1" | "A0" | "A1";
  category:
    | "missing_write"
    | "extra_write"
    | "value"
    | "order"
    | "timing"
    | "length"
    | "pcm"
    | "empty_trace"
    | "audio";
  call?: number;
  /** Cycles from engine start. 0 for empty_trace, which has no write to point at. */
  cycle?: number;
  /** cycle divided by the clock frequency used for the comparison. */
  timeSeconds?: number;
  sid?: number;
  voice?: number;
  register?: number;
  expected?: number;
  observed?: number;
};

export type TraceComparison = {
  t0: { equal: boolean; calls: number; firstDifference?: Difference };
  t1: {
    equal: boolean;
    /** Largest absolute cycle offset between matching writes, up to the first order or value mismatch. */
    maxOffsetCycles: number;
    toleranceCycles: number;
    /** Observed first write cycle minus expected first write cycle. */
    firstWriteOffsetCycles: number;
    firstDifference?: Difference;
  };
  horizon: { calls: number; cycles: number };
  playPeriodCycles: number;
};

export type CompareOptions = {
  /** Last cycle, counted from engine start, that is compared. Default: the last write of either trace. */
  horizonCycles?: number;
  toleranceCycles?: number;
  burstGapCycles?: number;
  /** CPU clock for timeSeconds. Default PAL, 985,248 Hz. */
  clockHz?: number;
};

export type A1Details = Partial<Omit<A1Result, "verdict">> & {
  /** Calibration status of A1: "approximate" unless the held-out error rates were both at most 5 %. */
  status: typeof A1_STATUS;
  /** Why A1 was not evaluated: the engine, sample rate or ROMs differ from the conditions of the rule file. */
  reason?: string;
};

export type VerifyResult = {
  level: "T0" | "T1" | "A0" | "A1" | "none";
  levels: {
    T0: "pass" | "fail";
    T1: "pass" | "fail";
    A0: "pass" | "fail" | "not evaluated";
    A1: "pass" | "fail" | "not evaluated";
  };
  horizon: { seconds: number; cycles: number; calls: number };
  firstDifference?: Difference;
  a1?: A1Details;
  engines: { trace: EngineIdentity; pcm?: EngineIdentity; a1?: EngineIdentity };
};

export type A1VerifyOptions = {
  /** A reSIDfp engine. A1 is defined only for its 48 kHz mono renders under the conditions of the rule file. */
  engine: SidEngine;
  rules: A1Rules;
  /** Observation horizon of the audio comparison. Default: the verify horizon. */
  seconds?: number;
  /** ROM images for the render. When the rule file pins ROM hashes, all three must be supplied and match. */
  roms?: SystemRoms;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

const CLOCK_HZ = { PAL: 985_248, NTSC: 1_022_727 } as const;
/** Default burst gap of callGroups, in cycles. */
export const DEFAULT_BURST_GAP = 2_000;
const DEFAULT_TOLERANCE = 0;
export const MAX_VERIFY_SECONDS = 180;

/** One SID write of a trace: zero-based SID, register offset, value, cycle counted from engine start. */
export type TraceWrite = { sid: number; reg: number; value: number; cycle: number; index: number };
type W = TraceWrite;

/** Validates a packed trace (four Float64 values per write) and unpacks it. */
export function traceWrites(input: Float64Array): TraceWrite[] {
  return records(input);
}

function records(input: Float64Array): W[] {
  if (!(input instanceof Float64Array) || input.length % 4) {
    throw new VerifyError("invalid_trace", "Trace must contain groups of four Float64 values");
  }
  const out: W[] = [];
  for (let i = 0; i < input.length; i += 4) {
    const sid = input[i]!, reg = input[i + 1]!, value = input[i + 2]!, cycle = input[i + 3]!;
    const finite = Number.isFinite(sid) && Number.isFinite(reg) && Number.isFinite(value) && Number.isFinite(cycle);
    if (!finite || sid < 0 || reg < 0 || reg > 0x18 || value < 0 || value > 255 || cycle < 0) {
      throw new VerifyError("invalid_trace", `Invalid SID write at record ${i / 4}`);
    }
    out.push({ sid, reg, value, cycle, index: i / 4 });
  }
  return out;
}

function bursts(ws: W[], gap: number): W[][] {
  const out: W[][] = [];
  for (const w of ws) {
    const current = out[out.length - 1];
    if (!current || w.cycle - current[current.length - 1].cycle > gap) out.push([w]);
    else current.push(w);
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * Groups writes into player calls: writes closer than `gap` cycles form a burst, and bursts closer than
 * the larger of `gap` and half the median burst spacing form one call. Shared with the reconstruction IR.
 */
export function callGroups(ws: W[], gap: number): W[][] {
  const bs = bursts(ws, gap);
  const starts = bs.slice(1).map((burst, i) => burst[0].cycle - bs[i][0].cycle);
  const period = median(starts);
  if (!bs.length) return [];
  const threshold = period ? Math.max(gap, period * 0.5) : gap;
  const calls: W[][] = [[...bs[0]]];
  for (let i = 1; i < bs.length; i++) {
    if (bs[i][0].cycle - bs[i - 1][bs[i - 1].length - 1].cycle > threshold) calls.push([...bs[i]]);
    else calls[calls.length - 1].push(...bs[i]);
  }
  return calls;
}

function diff(
  clockHz: number,
  level: Difference["level"],
  category: Difference["category"],
  a?: W,
  b?: W,
  call?: number,
): Difference {
  const w = a ?? b;
  const d: Difference = { level, category };
  if (call !== undefined) d.call = call;
  if (w) {
    d.sid = w.sid;
    d.register = w.reg;
    if (w.reg <= 0x14) d.voice = Math.floor(w.reg / 7) + 1;
  }
  if (a) {
    d.expected = a.value;
    d.cycle = a.cycle;
  }
  if (b) {
    d.observed = b.value;
    d.cycle ??= b.cycle;
  }
  if (d.cycle !== undefined) d.timeSeconds = d.cycle / clockHz;
  return d;
}

export class VerifyError extends Error {
  constructor(
    readonly code: "invalid_trace" | "invalid_options" | "trace_limit" | "pcm_engine_required" | "unsupported_pcm_engine",
    message: string,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

export function compareTraces(
  expected: Float64Array,
  observed: Float64Array,
  options: CompareOptions = {},
): TraceComparison {
  const gap = options.burstGapCycles ?? DEFAULT_BURST_GAP;
  const tolerance = options.toleranceCycles ?? DEFAULT_TOLERANCE;
  const clockHz = options.clockHz ?? CLOCK_HZ.PAL;
  const badHorizon =
    options.horizonCycles !== undefined && (!Number.isFinite(options.horizonCycles) || options.horizonCycles <= 0);
  if (!Number.isFinite(gap) || gap < 1 || !Number.isFinite(tolerance) || tolerance < 0 || badHorizon) {
    throw new VerifyError("invalid_options", "Cycle options must be finite and nonnegative (horizon must be positive)");
  }
  if (!Number.isFinite(clockHz) || clockHz <= 0) {
    throw new VerifyError("invalid_options", "clockHz must be a positive number");
  }
  if (expected.length / 4 > 2_000_000 || observed.length / 4 > 2_000_000) {
    throw new VerifyError("trace_limit", "Trace comparison is limited to 2,000,000 writes per input");
  }
  const a = records(expected);
  const b = records(observed);
  // All cycles are counted from engine start. They are not rebased to each trace's first write,
  // so a tune that starts writing later than the reference is a timing difference.
  const horizonCycles =
    options.horizonCycles ?? Math.max(a[a.length - 1]?.cycle ?? 0, b[b.length - 1]?.cycle ?? 0);
  const aa = a.filter((w) => w.cycle <= horizonCycles);
  const bb = b.filter((w) => w.cycle <= horizonCycles);
  const ca = callGroups(aa, gap);
  const cb = callGroups(bb, gap);
  const starts = [...bursts(aa, gap), ...bursts(bb, gap)].map((c) => c[0].cycle).sort((x, y) => x - y);
  const period = median(starts.slice(1).map((x, i) => x - starts[i]));
  const n = Math.max(ca.length, cb.length);

  if (!aa.length || !bb.length) {
    // A trace without writes in the horizon proves nothing, whatever the other trace holds.
    const empty: Difference = { level: "T0", category: "empty_trace", cycle: 0, timeSeconds: 0 };
    return {
      t0: { equal: false, calls: n, firstDifference: empty },
      t1: {
        equal: false,
        maxOffsetCycles: 0,
        toleranceCycles: tolerance,
        firstWriteOffsetCycles: 0,
        firstDifference: { ...empty, level: "T1" },
      },
      horizon: { calls: n, cycles: horizonCycles },
      playPeriodCycles: period,
    };
  }

  let d0: Difference | undefined;
  for (let c = 0; c < n && !d0; c++) {
    const x = ca[c] ?? [];
    const y = cb[c] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const p = x[i];
      const q = y[i];
      if (!p) {
        d0 = diff(clockHz, "T0", "extra_write", undefined, q, c);
        break;
      }
      if (!q) {
        d0 = diff(clockHz, "T0", "missing_write", p, undefined, c);
        break;
      }
      if (p.sid !== q.sid || p.reg !== q.reg) {
        d0 = diff(clockHz, "T0", "order", p, q, c);
        break;
      }
      if (p.value !== q.value) {
        d0 = diff(clockHz, "T0", "value", p, q, c);
        break;
      }
    }
  }

  let maxOffsetCycles = 0;
  let d1: Difference | undefined;
  const m = Math.max(aa.length, bb.length);
  for (let i = 0; i < m; i++) {
    const p = aa[i];
    const q = bb[i];
    // Offsets keep accumulating after a timing difference, but the first difference found is never replaced.
    if (!p || !q) {
      const category = i === Math.min(aa.length, bb.length) ? "length" : p ? "missing_write" : "extra_write";
      d1 ??= diff(clockHz, "T1", category, p, q);
      break;
    }
    if (p.sid !== q.sid || p.reg !== q.reg) {
      d1 ??= diff(clockHz, "T1", "order", p, q);
      break;
    }
    if (p.value !== q.value) {
      d1 ??= diff(clockHz, "T1", "value", p, q);
      break;
    }
    const offset = Math.abs(p.cycle - q.cycle);
    maxOffsetCycles = Math.max(maxOffsetCycles, offset);
    if (offset > tolerance) d1 ??= diff(clockHz, "T1", "timing", p, q);
  }

  return {
    t0: { equal: !d0, calls: n, ...(d0 ? { firstDifference: d0 } : {}) },
    t1: {
      equal: !d1,
      maxOffsetCycles,
      toleranceCycles: tolerance,
      firstWriteOffsetCycles: bb[0].cycle - aa[0].cycle,
      ...(d1 ? { firstDifference: d1 } : {}),
    },
    horizon: { calls: n, cycles: horizonCycles },
    playPeriodCycles: period,
  };
}

function pcmHash(samples: Int16Array): string {
  return createHash("sha256")
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest("hex");
}

export async function verifySid(
  expected: Uint8Array,
  observed: Uint8Array,
  options: {
    engine: SidEngine;
    seconds: number;
    song?: number;
    toleranceCycles?: number;
    pcmEngine?: SidEngine;
    /** Clock for both tunes. Default: the clock flag of the expected tune's PSID header, else PAL. */
    clock?: SidClock;
    /** Evaluate A1 with this reSIDfp engine and rule set. */
    a1?: A1VerifyOptions;
    /** Largest trace per tune. Default and maximum 2,000,000 writes. */
    maxRecords?: number;
    signal?: AbortSignal;
  },
): Promise<VerifyResult> {
  const { engine, seconds, song, toleranceCycles = 0, pcmEngine, signal } = options;
  const maxRecords = options.maxRecords ?? 2_000_000;
  const abort = signal ? { signal } : {};
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_VERIFY_SECONDS) {
    throw new VerifyError("invalid_options", `seconds must be in (0, ${MAX_VERIFY_SECONDS}]`);
  }
  const clock = options.clock ?? psidClock(expected) ?? "PAL";
  const clockHz = CLOCK_HZ[clock];
  const [a, b] = await Promise.all([
    engine.trace({ sid: expected, seconds, song, clock, maxRecords, ...abort }),
    engine.trace({ sid: observed, seconds, song, clock, maxRecords, ...abort }),
  ]);
  const horizonCycles = Math.min(a.horizonCycles, b.horizonCycles);
  const cmp = compareTraces(a.records, b.records, { horizonCycles, toleranceCycles, clockHz });

  let A0: VerifyResult["levels"]["A0"] = "not evaluated";
  let audioDiff: Difference | undefined;
  let pcmIdentity: EngineIdentity | undefined;
  if (pcmEngine) {
    const [x, y] = await Promise.all([
      pcmEngine.render({ sid: expected, seconds, song, clock, ...abort }),
      pcmEngine.render({ sid: observed, seconds, song, clock, ...abort }),
    ]);
    const emulationOf = (identity: EngineIdentity & { emulation?: SidEmulation }) => identity.emulation;
    if (emulationOf(x.engine) !== "sidlite" || emulationOf(y.engine) !== "sidlite") {
      throw new VerifyError("unsupported_pcm_engine", "A0 requires SIDLite rendering");
    }
    pcmIdentity = x.engine;
    if (pcmHash(x.samples) === pcmHash(y.samples)) {
      A0 = "pass";
    } else {
      A0 = "fail";
      let i = 0;
      while (i < Math.min(x.samples.length, y.samples.length) && x.samples[i] === y.samples[i]) i++;
      // PCM starts at the origin cycle of the traces, so cycle and timeSeconds are counted from engine start
      // like the trace differences.
      const cycle = a.originCycle + Math.floor((i / (x.sampleRate * x.channels)) * clockHz);
      audioDiff = {
        level: "A0",
        category: "pcm",
        expected: x.samples[i],
        observed: y.samples[i],
        cycle,
        timeSeconds: cycle / clockHz,
      };
    }
  }

  let A1: VerifyResult["levels"]["A1"] = "not evaluated";
  let a1Details: A1Details | undefined;
  let a1Identity: EngineIdentity | undefined;
  let a1Diff: Difference | undefined;
  if (options.a1) {
    const outcome = await evaluateA1(expected, observed, options.a1, { seconds, song, clock, clockHz, originCycle: a.originCycle });
    A1 = outcome.level;
    a1Details = outcome.details;
    a1Identity = outcome.identity;
    a1Diff = outcome.difference;
  }

  const T0 = cmp.t0.equal ? "pass" : "fail";
  const T1 = cmp.t1.equal ? "pass" : "fail";
  const level = T0 === "pass" ? "T0" : T1 === "pass" ? "T1" : A0 === "pass" ? "A0" : A1 === "pass" ? "A1" : "none";
  const firstDifference = cmp.t0.firstDifference ?? cmp.t1.firstDifference ?? audioDiff ?? a1Diff;
  return {
    level,
    levels: { T0, T1, A0, A1 },
    horizon: { seconds, cycles: horizonCycles, calls: cmp.horizon.calls },
    ...(firstDifference ? { firstDifference } : {}),
    ...(a1Details ? { a1: a1Details } : {}),
    engines: { trace: a.engine, ...(pcmIdentity ? { pcm: pcmIdentity } : {}), ...(a1Identity ? { a1: a1Identity } : {}) },
  };
}

async function evaluateA1(
  expected: Uint8Array,
  observed: Uint8Array,
  a1: A1VerifyOptions,
  context: { seconds: number; song: number | undefined; clock: SidClock; clockHz: number; originCycle: number },
): Promise<{ level: VerifyResult["levels"]["A1"]; details: A1Details; identity?: EngineIdentity; difference?: Difference }> {
  const seconds = a1.seconds ?? context.seconds;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_VERIFY_SECONDS) {
    throw new VerifyError("invalid_options", `A1 seconds must be in (0, ${MAX_VERIFY_SECONDS}]`);
  }
  const conditions = a1.rules.conditions;
  if (conditions) {
    // The rule file pins the ROMs. Hash the ROMs the render will use; when none are supplied the engine would use
    // defaults whose identity is unknown, so A1 is not evaluated.
    for (const name of ["kernal", "basic", "chargen"] as const) {
      const image = a1.roms?.[name];
      if (!image) {
        return { level: "not evaluated", details: { status: A1_STATUS, reason: `The rule file pins the ${name} ROM and none was supplied, so the ROM in use is unknown; pass the pinned ROMs` } };
      }
      if (createHash("sha256").update(image).digest("hex") !== conditions.roms[name]) {
        return { level: "not evaluated", details: { status: A1_STATUS, reason: `The ${name} ROM differs from the ROM pinned in the A1 rule file` } };
      }
    }
  }
  const request = {
    seconds, song: context.song, clock: context.clock, sampleRate: A1_SAMPLE_RATE, channels: 1 as const,
    ...(a1.roms ? { roms: a1.roms } : {}), ...(a1.signal ? { signal: a1.signal } : {}),
  };
  const [x, y] = await Promise.all([
    a1.engine.render({ ...request, sid: expected, ...(a1.onProgress ? { onProgress: a1.onProgress } : {}) }),
    a1.engine.render({ ...request, sid: observed }),
  ]);
  const identity = x.engine;
  const pinned = conditions?.engine;
  const reason = identity.emulation !== "residfp"
    ? `A1 requires reSIDfp rendering, not ${identity.emulation}`
    : x.sampleRate !== A1_SAMPLE_RATE || x.channels !== 1
      ? `A1 requires ${A1_SAMPLE_RATE} Hz mono renders`
      : pinned && (identity.id !== pinned.id || identity.version !== pinned.version)
        ? `The engine ${identity.id} ${identity.version} differs from the pinned ${pinned.id} ${pinned.version}`
        : undefined;
  if (reason) return { level: "not evaluated", details: { status: A1_STATUS, reason }, identity };
  const result = compareAudioA1(x.samples, y.samples, a1.rules, { horizonSeconds: seconds });
  const { verdict, ...rest } = result;
  const details: A1Details = { status: A1_STATUS, ...rest };
  let difference: Difference | undefined;
  if (verdict === "fail" && result.firstBad) {
    const cycle = context.originCycle + Math.floor(result.firstBad.timeSeconds * context.clockHz);
    difference = { level: "A1", category: result.firstBad.class === "truncated" ? "length" : "audio", cycle, timeSeconds: cycle / context.clockHz };
  }
  return { level: verdict, details, identity, ...(difference ? { difference } : {}) };
}
