// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Frame-state intermediate representation (IR) of a SID register trace, the input of SIDWave reconstruction.
//
// The trace is split into player calls with the shared `callGroups` rule of the verification module.
// Writes that do not belong to periodic calls (for example $D418 sample playback from an NMI) are removed
// first and reported as unsupported with their rate and share. For every call and every SID the IR holds
// the 25 write-only registers after the call, the set of registers written in the call and the in-call
// order of the writes to each voice's control register.

import { DEFAULT_BURST_GAP, VerifyError, callGroups, traceWrites, type TraceWrite } from "../verify/index.js";

/** Increment when the IR construction changes in a way that alters features; part of the corpus cache key. */
export const IR_CODE_VERSION = 2;

export type IrClock = "PAL" | "NTSC";

/** CPU clock frequency in Hz. */
export const IR_CLOCK_HZ: Record<IrClock, number> = { PAL: 985_248, NTSC: 1_022_727 };
/** Cycles per video frame: 63 x 312 on PAL, 65 x 263 on NTSC. */
export const IR_FRAME_CYCLES: Record<IrClock, number> = { PAL: 19_656, NTSC: 17_095 };
/** Number of write-only SID registers, $D400 to $D418. */
export const SID_REGISTER_COUNT = 25;

export interface IrSidState {
  /** The 25 write-only registers after the call; zero until written. Every call holds its own copy; do not mutate. */
  readonly regs: Uint8Array;
  /** Bit r is set when register r was written in the call. */
  readonly written: number;
  /** Values written to the control register of voice 1, 2 and 3 in this call, in write order. */
  control: [number[], number[], number[]];
}

export interface IrCall {
  index: number;
  /** Cycle, counted from engine start, of the first write of the call. */
  startCycle: number;
  /** Cycle of the last write of the call. */
  endCycle: number;
  /** Number of writes in the call, over all SIDs. */
  writes: number;
  /** One entry per SID, indexed by the zero-based SID number. */
  sids: IrSidState[];
}

export interface IrUnsupportedStream {
  sid: number;
  register: number;
  writes: number;
  /** Number of separate runs of dense writes. */
  runs: number;
  firstCycle: number;
  lastCycle: number;
  /** Writes per second over the whole horizon. */
  ratePerSecond: number;
}

export interface IrUnsupported {
  /** Writes removed from the call structure. */
  writes: number;
  /** writes divided by all writes inside the horizon (0 when there are none). */
  share: number;
  /** Writes per second over the whole horizon. */
  ratePerSecond: number;
  streams: IrUnsupportedStream[];
}

export interface IrJitter {
  /** A spacing counts as regular when it differs from the period by at most this many cycles. */
  toleranceCycles: number;
  /** Largest absolute deviation from the period among the regular spacings. */
  jitterCycles: number;
  /** Number of spacings between consecutive call starts outside the tolerance. */
  irregularSpacings: number;
  /** irregularSpacings divided by the number of spacings (0 when there is none). */
  irregularShare: number;
  /** Largest absolute deviation from the period among all spacings. */
  maxDeviationCycles: number;
}

export interface FrameIr {
  version: 1;
  clock: IrClock;
  clockHz: number;
  frameCycles: number;
  /** Last cycle that is part of the IR, counted from engine start. */
  horizonCycles: number;
  /** Seconds covered by the IR, from the origin cycle (0 when unknown) to the horizon. */
  seconds: number;
  sidCount: number;
  /** Writes inside the horizon, including the unsupported ones. */
  totalWrites: number;
  /** Writes inside the horizon to register offsets $19 to $1F, which no SID register implements. They are not part of the IR. */
  ignoredWrites: number;
  calls: IrCall[];
  /** Median spacing of call starts in cycles, 0 with fewer than two calls. */
  periodCycles: number;
  /** round(frameCycles / periodCycles), 0 with fewer than two calls. */
  callsPerFrame: number;
  /** frameCycles / periodCycles, 0 with fewer than two calls. */
  callsPerFrameExact: number;
  jitter: IrJitter;
  unsupported: IrUnsupported;
  warnings: string[];
}

export interface IrOptions {
  /** Default PAL. */
  clock?: IrClock;
  /** Records after this cycle are ignored. Default: no limit. */
  horizonCycles?: number;
  /** Cycle at which PCM starts; used for the length of the covered time only. Default 0. */
  originCycle?: number;
  /** Burst gap of the shared call grouping. Default 2,000 cycles. */
  burstGapCycles?: number;
  /** Number of SIDs. Default: highest SID in the trace plus one, at least one. */
  sidCount?: number;
  /** Writes to one register closer than this are dense. Default 1,000 cycles. */
  streamGapCycles?: number;
  /** A dense run of at least this many writes to one register is unsupported. Default 32. */
  streamMinWrites?: number;
  /** Tolerance of the call spacing in cycles. Default 1 percent of the period, at least 1. */
  jitterToleranceCycles?: number;
}

export const DEFAULT_STREAM_GAP_CYCLES = 1_000;
export const DEFAULT_STREAM_MIN_WRITES = 32;

/** Register index of the control register of a zero-based voice. */
export function controlRegister(voice: number): number {
  return voice * 7 + 4;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Marks writes that belong to a dense run of at least `minWrites` writes to one register, each at most `gap`
 * cycles after the previous one. Limits of the rule: a sample player slower than about 985 writes per second
 * (gap 1,000 cycles) is not detected and stays in the call structure; a tight loop of 32 or more writes to one
 * register inside a single call (for example a register clearing or sweeping loop) is detected as a stream.
 */
function findStreams(
  writes: TraceWrite[],
  gap: number,
  minWrites: number,
  seconds: number,
): { dense: Uint8Array; streams: IrUnsupportedStream[] } {
  const dense = new Uint8Array(writes.length);
  const bySource = new Map<number, number[]>();
  writes.forEach((w, i) => {
    const key = w.sid * 32 + w.reg;
    const list = bySource.get(key);
    if (list) list.push(i);
    else bySource.set(key, [i]);
  });
  const streams: IrUnsupportedStream[] = [];
  for (const [key, list] of [...bySource].sort((a, b) => a[0] - b[0])) {
    let count = 0;
    let runs = 0;
    let first = Infinity;
    let last = -Infinity;
    let start = 0;
    const flush = (end: number): void => {
      if (end - start < minWrites) return;
      runs++;
      count += end - start;
      for (let k = start; k < end; k++) dense[list[k]] = 1;
      first = Math.min(first, writes[list[start]].cycle);
      last = Math.max(last, writes[list[end - 1]].cycle);
    };
    for (let k = 1; k < list.length; k++) {
      if (writes[list[k]].cycle - writes[list[k - 1]].cycle > gap) {
        flush(k);
        start = k;
      }
    }
    flush(list.length);
    if (count) {
      streams.push({
        sid: Math.floor(key / 32),
        register: key % 32,
        writes: count,
        runs,
        firstCycle: first,
        lastCycle: last,
        ratePerSecond: seconds > 0 ? count / seconds : 0,
      });
    }
  }
  return { dense, streams };
}

/** Builds the frame-state IR of a packed trace (four Float64 values per write: sid, register, value, cycle). */
export function buildIr(trace: Float64Array, options: IrOptions = {}): FrameIr {
  const clock = options.clock ?? "PAL";
  if (clock !== "PAL" && clock !== "NTSC") throw new RangeError(`clock must be PAL or NTSC, got ${String(clock)}`);
  const gap = options.burstGapCycles ?? DEFAULT_BURST_GAP;
  const streamGap = options.streamGapCycles ?? DEFAULT_STREAM_GAP_CYCLES;
  const streamMin = options.streamMinWrites ?? DEFAULT_STREAM_MIN_WRITES;
  if (!(gap >= 1) || !(streamGap >= 1) || !(streamMin >= 2)) {
    throw new RangeError("burstGapCycles and streamGapCycles must be at least 1 and streamMinWrites at least 2");
  }
  const clockHz = IR_CLOCK_HZ[clock];
  const frameCycles = IR_FRAME_CYCLES[clock];
  const origin = options.originCycle ?? 0;

  const limit = options.horizonCycles ?? Infinity;
  // The whole trace is validated first, so that an invalid record is never dropped silently. Tunes sometimes
  // write to $D419-$D41F; the trace holds these, but they are not registers of the SID, so they are ignored.
  if (trace.length % 4) throw new VerifyError("invalid_trace", "Trace must contain groups of four Float64 values");
  for (let i = 0; i < trace.length; i += 4) {
    const [sid, reg, value, cycle] = [trace[i], trace[i + 1], trace[i + 2], trace[i + 3]];
    const finite = Number.isFinite(sid) && Number.isFinite(reg) && Number.isFinite(value) && Number.isFinite(cycle);
    if (!finite || sid < 0 || reg < 0 || reg > 0x1f || value < 0 || value > 255 || cycle < 0) {
      throw new VerifyError("invalid_trace", `Invalid SID write at record ${i / 4}`);
    }
  }
  const wide: number[] = [];
  let ignoredWrites = 0;
  let dropped = false;
  for (let i = 0; i < trace.length; i += 4) {
    if (trace[i + 1] > 0x18) {
      dropped = true;
      if (trace[i + 3] <= limit) ignoredWrites++;
    } else {
      wide.push(trace[i], trace[i + 1], trace[i + 2], trace[i + 3]);
    }
  }
  const all = traceWrites(dropped ? Float64Array.from(wide) : trace);
  const inside = all.filter((w) => w.cycle <= limit);
  const lastCycle = inside.length ? inside[inside.length - 1].cycle : origin;
  const horizonCycles = options.horizonCycles ?? lastCycle;
  const seconds = Math.max(0, horizonCycles - origin) / clockHz;
  let sidCount = options.sidCount ?? 1;
  if (options.sidCount === undefined) for (const w of inside) sidCount = Math.max(sidCount, w.sid + 1);
  if (!Number.isInteger(sidCount) || sidCount < 1) throw new RangeError("sidCount must be a positive integer");
  for (const w of inside) {
    if (w.sid >= sidCount) throw new RangeError(`write to SID ${w.sid} but sidCount is ${sidCount}`);
  }

  const { dense, streams } = findStreams(inside, streamGap, streamMin, seconds);
  const periodic = inside.filter((_, i) => !dense[i]);
  const groups = callGroups(periodic, gap);

  const zero = (): Uint8Array => new Uint8Array(SID_REGISTER_COUNT);
  let current: Uint8Array[] = Array.from({ length: sidCount }, zero);
  const calls: IrCall[] = groups.map((group, index) => {
    const touched = new Map<number, { regs: Uint8Array; written: number; control: [number[], number[], number[]] }>();
    for (const w of group) {
      let state = touched.get(w.sid);
      if (!state) {
        state = { regs: current[w.sid].slice(), written: 0, control: [[], [], []] };
        touched.set(w.sid, state);
      }
      state.regs[w.reg] = w.value;
      state.written |= 1 << w.reg;
      for (let v = 0; v < 3; v++) if (w.reg === controlRegister(v)) state.control[v].push(w.value);
    }
    const sids: IrSidState[] = current.map((regs, sid) => touched.get(sid) ?? { regs: regs.slice(), written: 0, control: [[], [], []] });
    current = sids.map((s) => s.regs);
    return {
      index,
      startCycle: group[0].cycle,
      endCycle: group[group.length - 1].cycle,
      writes: group.length,
      sids,
    };
  });

  const spacings = calls.slice(1).map((c, i) => c.startCycle - calls[i].startCycle);
  const periodCycles = median(spacings);
  const tolerance = options.jitterToleranceCycles ?? Math.max(1, Math.round(periodCycles * 0.01));
  let jitterCycles = 0;
  let maxDeviationCycles = 0;
  let irregularSpacings = 0;
  for (const s of spacings) {
    const dev = Math.abs(s - periodCycles);
    maxDeviationCycles = Math.max(maxDeviationCycles, dev);
    if (dev > tolerance) irregularSpacings++;
    else jitterCycles = Math.max(jitterCycles, dev);
  }
  const unsupportedWrites = streams.reduce((n, s) => n + s.writes, 0);
  const warnings: string[] = [];
  if (!calls.length) warnings.push("no periodic call found");
  if (calls.length === 1 && periodic.length > 1000) {
    warnings.push("all writes merged into one call; the call period may be shorter than the burst gap");
  }
  if (calls.length >= 2 && periodCycles < 2 * gap) {
    warnings.push(`call period ${periodCycles} cycles is below twice the burst gap ${gap}; calls may be merged`);
  }
  return {
    version: 1,
    clock,
    clockHz,
    frameCycles,
    horizonCycles,
    seconds,
    sidCount,
    totalWrites: inside.length,
    ignoredWrites,
    calls,
    periodCycles,
    callsPerFrame: periodCycles ? Math.round(frameCycles / periodCycles) : 0,
    callsPerFrameExact: periodCycles ? frameCycles / periodCycles : 0,
    jitter: {
      toleranceCycles: tolerance,
      jitterCycles,
      irregularSpacings,
      irregularShare: spacings.length ? irregularSpacings / spacings.length : 0,
      maxDeviationCycles,
    },
    unsupported: {
      writes: unsupportedWrites,
      share: inside.length ? unsupportedWrites / inside.length : 0,
      ratePerSecond: seconds > 0 ? unsupportedWrites / seconds : 0,
      streams,
    },
    warnings,
  };
}
