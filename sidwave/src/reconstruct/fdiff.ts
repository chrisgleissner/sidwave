// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// F-diff: call-by-call comparison of two frame-state IRs.
//
// The first call of each IR (or the calls named by `alignExpected` and `alignObserved`) are aligned, then
// call i of the expected IR is compared with call i of the observed IR. Differences are classified by
// register class. F-diff is a diagnostic for reconstruction and repair, not a verification level.
//
// Register classes:
//   pitch     frequency registers (low and high byte)
//   gate      control bit 0 (gate) and bit 3 (test); also any difference in the in-call order of control writes
//             that changes only these bits, which is how hard restart sequences differ
//   waveform  control bits 1, 2 and 4 to 7 (sync, ring, waveform select)
//   pulse     pulse width registers
//   adsr      attack/decay and sustain/release registers
//   filter    cutoff ($15, $16), resonance and routing ($17), filter mode and voice 3 off ($18 bits 4 to 7)
//   volume    $18 bits 0 to 3
//   timing    spacing of call starts and cumulative offset. A different number of calls is reported separately
//             as callCountMismatch and is not a class difference.

import { controlRegister, SID_REGISTER_COUNT, type FrameIr, type IrSidState } from "./ir.js";

export type RegisterClass = "pitch" | "gate" | "waveform" | "pulse" | "adsr" | "filter" | "volume" | "timing";

export const REGISTER_CLASSES: readonly RegisterClass[] = [
  "pitch",
  "gate",
  "waveform",
  "pulse",
  "adsr",
  "filter",
  "volume",
  "timing",
];

export interface FDiffDifference {
  class: RegisterClass;
  /** Index of the call, counted from the aligned first call. */
  call: number;
  /** Start cycle of the expected call (engine cycles); for a missing expected call, the start of the observed call. */
  cycle: number;
  /** Seconds from the aligned first expected call. */
  timeSeconds: number;
  sid?: number;
  /** 1 to 3 for voice registers; absent for global registers and timing. */
  voice?: number;
  register?: number;
  /** Register value masked to the class bits; for timing, the expected spacing, offset or call count in cycles. */
  expected?: number;
  observed?: number;
  /** Short explanation for differences that need one (in-call control order, call count, timing kind). */
  detail?: string;
}

export interface FDiffClassSummary {
  class: RegisterClass;
  comparedCalls: number;
  differingCalls: number;
  /** Share of compared calls without a difference of this class (1 when nothing was compared). */
  matchShare: number;
  first?: FDiffDifference;
}

export interface FDiffResult {
  /** True when every compared call matches in every class and both IRs have the same number of calls. */
  equal: boolean;
  alignment: {
    expectedCall: number;
    observedCall: number;
    compared: number;
    expectedCalls: number;
    observedCalls: number;
  };
  classes: Record<RegisterClass, FDiffClassSummary>;
  /** The first difference per class, SID and voice, ordered by cycle and then by class. */
  firsts: FDiffDifference[];
  /** The earliest difference. */
  first?: FDiffDifference;
  /** Set when the compared IRs have a different number of calls after alignment. Not counted in any class. */
  callCountMismatch?: { expected: number; observed: number };
  /** True when the call periods differ by more than the timing tolerance. */
  ratesDiffer: boolean;
  /**
   * Present when `ratesDiffer` is true or a timing difference exists: call i of one IR is then no longer the same
   * musical event as call i of the other, so differences in the other classes after the first timing difference
   * are unreliable. `firstTimingCall` is that call, when there is one.
   */
  note?: string;
  firstTimingCall?: number;
  /** Largest absolute offset of a call start from the aligned expected start, in cycles. */
  maxCumulativeOffsetCycles: number;
  /** Number of calls in which a register was written in one IR but not in the other, with equal resulting state. */
  writtenSetMismatchCalls: number;
  /** Number of compared calls with at least one difference in any class (a call that differs in two classes counts once). */
  callsWithDifference: number;
}

export interface FDiffOptions {
  /** Call of the expected IR that is aligned with `alignObserved`. Default 0. */
  alignExpected?: number;
  /** Call of the observed IR that is aligned with `alignExpected`. Default 0. */
  alignObserved?: number;
  /** Largest accepted difference of a call spacing in cycles. Default 1 percent of the expected period, at least 1. */
  timingToleranceCycles?: number;
  /** Largest accepted cumulative offset of a call start in cycles. Default half a frame of the expected clock. */
  cumulativeToleranceCycles?: number;
}

const CONTROL_GATE_BITS = 0x09;
const CONTROL_WAVEFORM_BITS = 0xf6;
const EMPTY_SID: IrSidState = {
  regs: new Uint8Array(SID_REGISTER_COUNT),
  written: 0,
  control: [[], [], []],
};

/** Class of a voice register ($00 to $14 offset 0, 1, 2, 3, 5, 6; the control register is split by bits). */
export function registerClass(register: number): RegisterClass {
  if (register < 0 || register >= SID_REGISTER_COUNT) throw new RangeError(`register ${register} is outside $00-$18`);
  if (register === 0x18) return "volume";
  if (register >= 0x15) return "filter";
  switch (register % 7) {
    case 0:
    case 1:
      return "pitch";
    case 2:
    case 3:
      return "pulse";
    case 4:
      return "waveform";
    default:
      return "adsr";
  }
}

type Sink = (difference: Omit<FDiffDifference, "call" | "cycle" | "timeSeconds">) => void;

function compareSid(e: IrSidState, o: IrSidState, sid: number, sink: Record<RegisterClass, Sink>): void {
  for (let voice = 0; voice < 3; voice++) {
    const base = voice * 7;
    const v = voice + 1;
    for (const [cls, regs] of [
      ["pitch", [base, base + 1]],
      ["pulse", [base + 2, base + 3]],
      ["adsr", [base + 5, base + 6]],
    ] as const) {
      for (const r of regs) {
        if (e.regs[r] !== o.regs[r]) {
          sink[cls]({ class: cls, sid, voice: v, register: r, expected: e.regs[r], observed: o.regs[r] });
          break;
        }
      }
    }
    const c = controlRegister(voice);
    const gateE = e.regs[c] & CONTROL_GATE_BITS;
    const gateO = o.regs[c] & CONTROL_GATE_BITS;
    if (gateE !== gateO) {
      sink.gate({ class: "gate", sid, voice: v, register: c, expected: gateE, observed: gateO });
    }
    const waveE = e.regs[c] & CONTROL_WAVEFORM_BITS;
    const waveO = o.regs[c] & CONTROL_WAVEFORM_BITS;
    if (waveE !== waveO) {
      sink.waveform({ class: "waveform", sid, voice: v, register: c, expected: waveE, observed: waveO });
    }
    if (gateE === gateO && waveE === waveO) {
      // The sequence of control writes inside the call can differ while the final value is equal.
      const se = e.control[voice];
      const so = o.control[voice];
      const n = Math.max(se.length, so.length);
      for (let i = 0; i < n; i++) {
        if (se[i] === so[i]) continue;
        const xe = se[i];
        const xo = so[i];
        const bits = xe === undefined || xo === undefined ? CONTROL_GATE_BITS : xe ^ xo;
        const cls: RegisterClass = bits & CONTROL_GATE_BITS ? "gate" : "waveform";
        const mask = cls === "gate" ? CONTROL_GATE_BITS : CONTROL_WAVEFORM_BITS;
        sink[cls]({
          class: cls,
          sid,
          voice: v,
          register: c,
          expected: xe === undefined ? undefined : xe & mask,
          observed: xo === undefined ? undefined : xo & mask,
          detail: `in-call control write ${i + 1}: ${se.length} expected, ${so.length} observed`,
        });
        break;
      }
    }
  }
  for (const r of [0x15, 0x16, 0x17]) {
    if (e.regs[r] !== o.regs[r]) {
      sink.filter({ class: "filter", sid, register: r, expected: e.regs[r], observed: o.regs[r] });
      break;
    }
  }
  if ((e.regs[0x18] & 0xf0) !== (o.regs[0x18] & 0xf0)) {
    sink.filter({ class: "filter", sid, register: 0x18, expected: e.regs[0x18] & 0xf0, observed: o.regs[0x18] & 0xf0 });
  }
  if ((e.regs[0x18] & 0x0f) !== (o.regs[0x18] & 0x0f)) {
    sink.volume({ class: "volume", sid, register: 0x18, expected: e.regs[0x18] & 0x0f, observed: o.regs[0x18] & 0x0f });
  }
}

/** Compares two IRs call by call. Both must use the same clock for the timing class to be meaningful. */
export function fdiff(expected: FrameIr, observed: FrameIr, options: FDiffOptions = {}): FDiffResult {
  const ea = options.alignExpected ?? 0;
  const oa = options.alignObserved ?? 0;
  if (!Number.isInteger(ea) || !Number.isInteger(oa) || ea < 0 || oa < 0) {
    throw new RangeError("alignExpected and alignObserved must be nonnegative integers");
  }
  const nE = Math.max(0, expected.calls.length - ea);
  const nO = Math.max(0, observed.calls.length - oa);
  const compared = Math.min(nE, nO);
  const timingTolerance = options.timingToleranceCycles ?? Math.max(1, Math.round(expected.periodCycles * 0.01));
  const cumulativeTolerance = options.cumulativeToleranceCycles ?? expected.frameCycles / 2;
  const sidCount = Math.max(expected.sidCount, observed.sidCount);
  const baseE = expected.calls[ea]?.startCycle ?? 0;
  const baseO = observed.calls[oa]?.startCycle ?? 0;

  const firsts = new Map<string, FDiffDifference>();
  const differing: Record<RegisterClass, Set<number>> = {
    pitch: new Set(),
    gate: new Set(),
    waveform: new Set(),
    pulse: new Set(),
    adsr: new Set(),
    filter: new Set(),
    volume: new Set(),
    timing: new Set(),
  };
  const classFirst: Partial<Record<RegisterClass, FDiffDifference>> = {};
  let maxOffset = 0;
  let writtenSetMismatchCalls = 0;
  let callsWithDifference = 0;

  for (let i = 0; i < compared; i++) {
    const ce = expected.calls[ea + i];
    const co = observed.calls[oa + i];
    let callDifferences = 0;
    const record = (cls: RegisterClass): Sink => (difference) => {
      callDifferences++;
      const full: FDiffDifference = {
        ...difference,
        class: cls,
        call: i,
        cycle: ce.startCycle,
        timeSeconds: (ce.startCycle - baseE) / expected.clockHz,
      };
      differing[cls].add(i);
      classFirst[cls] ??= full;
      const key = `${cls}/${difference.sid ?? "-"}/${difference.voice ?? "-"}`;
      if (!firsts.has(key)) firsts.set(key, full);
    };
    const sinks = Object.fromEntries(REGISTER_CLASSES.map((cls) => [cls, record(cls)])) as Record<RegisterClass, Sink>;
    let writtenMismatch = false;
    for (let sid = 0; sid < sidCount; sid++) {
      const e = ce.sids[sid] ?? EMPTY_SID;
      const o = co.sids[sid] ?? EMPTY_SID;
      if (e.written !== o.written) writtenMismatch = true;
      compareSid(e, o, sid, sinks);
    }
    if (writtenMismatch && callDifferences === 0) writtenSetMismatchCalls++;

    const offset = co.startCycle - baseO - (ce.startCycle - baseE);
    maxOffset = Math.max(maxOffset, Math.abs(offset));
    if (i > 0) {
      const spacingE = ce.startCycle - expected.calls[ea + i - 1].startCycle;
      const spacingO = co.startCycle - observed.calls[oa + i - 1].startCycle;
      if (Math.abs(spacingE - spacingO) > timingTolerance) {
        sinks.timing({ class: "timing", expected: spacingE, observed: spacingO, detail: "call spacing in cycles" });
      } else if (Math.abs(offset) > cumulativeTolerance) {
        sinks.timing({ class: "timing", expected: 0, observed: offset, detail: "cumulative call offset in cycles" });
      }
    }
    if (callDifferences > 0) callsWithDifference++;
  }

  const callCountMismatch = nE !== nO ? { expected: nE, observed: nO } : undefined;

  const classes = Object.fromEntries(
    REGISTER_CLASSES.map((cls) => {
      const n = differing[cls].size;
      const summary: FDiffClassSummary = {
        class: cls,
        comparedCalls: compared,
        differingCalls: n,
        matchShare: compared ? (compared - Math.min(n, compared)) / compared : 1,
        ...(classFirst[cls] ? { first: classFirst[cls] } : {}),
      };
      return [cls, summary];
    }),
  ) as Record<RegisterClass, FDiffClassSummary>;
  const ratesDiffer = Math.abs(expected.periodCycles - observed.periodCycles) > timingTolerance;
  const timingFirst = classFirst.timing;
  const note =
    ratesDiffer || timingFirst
      ? "call timing differs: per-class comparisons after the first timing difference are unreliable"
      : undefined;
  const order = (d: FDiffDifference): number => REGISTER_CLASSES.indexOf(d.class);
  const sorted = [...firsts.values()].sort((a, b) => a.cycle - b.cycle || order(a) - order(b));
  return {
    equal: sorted.length === 0 && !callCountMismatch,
    alignment: { expectedCall: ea, observedCall: oa, compared, expectedCalls: expected.calls.length, observedCalls: observed.calls.length },
    classes,
    firsts: sorted,
    ...(callCountMismatch ? { callCountMismatch } : {}),
    ratesDiffer,
    ...(note ? { note, ...(timingFirst ? { firstTimingCall: timingFirst.call } : {}) } : {}),
    ...(sorted.length ? { first: sorted[0] } : {}),
    maxCumulativeOffsetCycles: maxOffset,
    writtenSetMismatchCalls,
    callsWithDifference,
  };
}
