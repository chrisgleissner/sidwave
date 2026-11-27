// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Technique detection. From a register trace (frame-state IR) every fact is observed: the detectors read register
// values and the order of control writes and apply fixed thresholds, which are listed in the evidence. From a score,
// techniques are read from the instrument definitions and are observed in the score. Each pass is linear in the
// number of calls (trace) or notes (score).

import { IR_CLOCK_HZ, type FrameIr } from "../reconstruct/ir.js";
import { isInitCall } from "../reconstruct/recover.js";
import type { Arrangement } from "../sidwaveCompiler.js";
import type { ScoreModel } from "./music.js";
import { round } from "./music.js";
import { globalVoice, voiceRegs, type Marked } from "./common.js";

export type TechniqueName =
  | "hard restart" | "arpeggio" | "vibrato" | "pitch slide" | "pulse width sweep" | "filter sweep" | "oscillator sync"
  | "ring modulation" | "test bit" | "noise" | "combined waveforms" | "multispeed" | "sample playback" | "wavetable program";

export interface Technique extends Marked {
  name: TechniqueName;
  source: "trace" | "score";
  /** Global voice numbers (1-based) that use the technique; empty for a tune-wide technique. */
  voices: number[];
  summary: string;
  evidence: Record<string, number | string | boolean | number[] | string[]>;
}

export const THRESHOLDS = {
  /** Calls of one gate-on run needed to look for arpeggio and vibrato. */
  arpeggioMinRun: 8,
  /** Distinct-value changes (after collapsing equal neighbours) needed in a run. */
  arpeggioMinSteps: 6,
  /** Share of steps whose frequency equals the frequency one period (of steps) earlier. */
  arpeggioPeriodMatch: 0.9,
  vibratoMinRun: 12,
  /** Largest frequency range of a vibrato run, as a ratio of the lowest frequency (about one semitone). */
  vibratoMaxRange: 0.06,
  vibratoMinReversals: 4,
  /** Largest coefficient of variation of the spacing of the reversals. */
  vibratoRegularity: 0.4,
  slideMinChanges: 6,
  sweepMinChanges: 8,
  sweepMinTotal: 64,
  /** Share of gate-on edges that must show the restart pattern, and the minimum number of edges. */
  hardRestartShare: 0.5,
  hardRestartMinEdges: 3,
  /** Calls before a gate-on edge in which the restart pattern is looked for. */
  hardRestartWindow: 3,
} as const;

interface Series {
  freq: Int32Array;
  pulse: Int32Array;
  ctl: Uint8Array;
  ad: Uint8Array;
  sr: Uint8Array;
}

function seriesOf(ir: FrameIr, sid: number, voice: number, from: number): Series {
  const n = Math.max(0, ir.calls.length - from);
  const s: Series = { freq: new Int32Array(n), pulse: new Int32Array(n), ctl: new Uint8Array(n), ad: new Uint8Array(n), sr: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const v = voiceRegs(ir.calls[from + i]!.sids[sid]?.regs ?? new Uint8Array(25), voice);
    s.freq[i] = v.freq; s.pulse[i] = v.pulse; s.ctl[i] = v.control; s.ad[i] = v.ad; s.sr[i] = v.sr;
  }
  return s;
}

/** Runs [start, end) of calls with the gate bit set. */
function gateRuns(ctl: Uint8Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < ctl.length; i++) {
    const on = (ctl[i]! & 1) !== 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start, i]); start = -1; }
  }
  if (start >= 0) runs.push([start, ctl.length]);
  return runs;
}

interface Sweep { changes: number; total: number }

/** Monotone segments of a series with at least `minChanges` changing calls and a total change of `minTotal`. */
function monotoneSweeps(values: ArrayLike<number>, from: number, to: number, minChanges: number, minTotal: number): Sweep[] {
  const out: Sweep[] = [];
  let sign = 0;
  let changes = 0;
  let total = 0;
  const flush = () => { if (changes >= minChanges && total >= minTotal) out.push({ changes, total }); changes = 0; total = 0; };
  for (let i = from + 1; i < to; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d === 0) continue;
    const s = d > 0 ? 1 : -1;
    if (s !== sign) { flush(); sign = s; }
    changes++;
    total += Math.abs(d);
  }
  flush();
  return out;
}

const mode = (values: number[]): number | undefined => {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && v < best!)) { best = v; bestN = n; }
  return best;
};

/** Techniques of a register trace. All facts are observed. */
export function techniquesFromIr(ir: FrameIr): Technique[] {
  const out: Technique[] = [];
  const from = isInitCall(ir, 0) ? 1 : 0;
  const callsPerSecond = ir.periodCycles > 0 ? IR_CLOCK_HZ[ir.clock] / ir.periodCycles : IR_CLOCK_HZ[ir.clock] / ir.frameCycles;
  const T = THRESHOLDS;
  const found = {
    hardRestart: new Map<number, { edges: number; pattern: number; test: number; adsr: number }>(),
    arpeggio: new Map<number, { runs: number; periods: number[]; steps: string[] }>(),
    vibrato: new Map<number, { runs: number; rates: number[]; depths: number[] }>(),
    slide: new Map<number, number>(),
    pulse: new Map<number, { sweeps: number; step: number[] }>(),
    sync: new Map<number, number>(), ring: new Map<number, number>(), test: new Map<number, number>(),
    noise: new Map<number, number>(), combined: new Map<number, number>(),
  };
  for (let sid = 0; sid < ir.sidCount; sid++) {
    for (let voice = 0; voice < 3; voice++) {
      const g = globalVoice(sid, voice);
      const s = seriesOf(ir, sid, voice, from);
      const n = s.ctl.length;
      if (n === 0) continue;
      // Bit uses: counted over calls.
      let syncCalls = 0, ringCalls = 0, testCalls = 0, noiseCalls = 0, combinedCalls = 0;
      for (let i = 0; i < n; i++) {
        const c = s.ctl[i]!;
        const wave = c >> 4;
        if (c & 2 && wave) syncCalls++;
        if (c & 4 && wave) ringCalls++;
        if (c & 8) testCalls++;
        if (wave === 8) noiseCalls++;
        if (wave && (wave & (wave - 1)) !== 0) combinedCalls++;
      }
      // Test bit also in the in-call control sequences.
      for (let i = 0; i < n; i++) {
        const seq = ir.calls[from + i]!.sids[sid]?.control[voice];
        if (seq && seq.some((x) => (x & 8) !== 0) && !(s.ctl[i]! & 8)) testCalls++;
      }
      if (syncCalls) found.sync.set(g, syncCalls);
      if (ringCalls) found.ring.set(g, ringCalls);
      if (testCalls) found.test.set(g, testCalls);
      if (noiseCalls) found.noise.set(g, noiseCalls);
      if (combinedCalls) found.combined.set(g, combinedCalls);

      const runs = gateRuns(s.ctl);
      // Hard restart: a gate-on edge soon after a gate-on run, with the test bit set or the ADSR changed on the way.
      let edges = 0, pattern = 0, test = 0, adsr = 0;
      for (let r = 1; r < runs.length; r++) {
        const k = runs[r]![0];
        const gap = k - runs[r - 1]![1];
        edges++;
        if (gap < 1 || gap > T.hardRestartWindow) continue;
        let hasTest = false;
        for (let j = Math.max(0, k - T.hardRestartWindow); j <= k; j++) {
          if (s.ctl[j]! & 8) hasTest = true;
          const seq = ir.calls[from + j]!.sids[sid]?.control[voice];
          if (seq && seq.some((x) => (x & 8) !== 0)) hasTest = true;
        }
        const hasAdsr = s.ad[k - 1] !== s.ad[k] || s.sr[k - 1] !== s.sr[k];
        if (hasTest) test++;
        if (hasAdsr) adsr++;
        if (hasTest || hasAdsr) pattern++;
      }
      if (edges) found.hardRestart.set(g, { edges, pattern, test, adsr });
      // Arpeggio, vibrato and slides inside gate-on runs.
      for (const [a, b] of runs) {
        const len = b - a;
        if (len >= T.arpeggioMinRun) {
          // The run with consecutive equal values collapsed: an arpeggio cycles through a few values in a fixed order,
          // however many calls each value lasts.
          const values: number[] = [];
          let lo = Infinity, hi = 0;
          for (let i = a; i < b; i++) {
            const f = s.freq[i]!;
            if (f > 0) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
            if (values.length === 0 || values[values.length - 1] !== f) values.push(f);
          }
          const distinct = new Set(values);
          if (values.length >= T.arpeggioMinSteps && distinct.size >= 2 && distinct.size <= 6 && (hi - lo) / lo > T.vibratoMaxRange) {
            for (let p = Math.max(2, distinct.size); p <= 6 && p * 2 <= values.length; p++) {
              let match = 0;
              for (let i = p; i < values.length; i++) if (values[i] === values[i - p]) match++;
              if (match / (values.length - p) >= T.arpeggioPeriodMatch) {
                const steps = values.slice(0, p).map((f) => (f > 0 && Number.isFinite(lo) ? Math.round(12 * Math.log2(f / lo)) : 0));
                const entry = found.arpeggio.get(g) ?? { runs: 0, periods: [], steps: [] };
                entry.runs++; entry.periods.push(p); entry.steps.push(steps.join(","));
                found.arpeggio.set(g, entry);
                break;
              }
            }
          }
        }
        if (len >= T.vibratoMinRun) {
          let lo = Infinity, hi = 0, reversals = 0, last = 0;
          const where: number[] = [];
          const distinct = new Set<number>();
          for (let i = a; i < b; i++) {
            const f = s.freq[i]!;
            distinct.add(f);
            if (f > 0) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
            if (i > a) {
              const d = f - s.freq[i - 1]!;
              if (d !== 0) {
                const sign = d > 0 ? 1 : -1;
                if (last !== 0 && sign !== last) { reversals++; where.push(i); }
                last = sign;
              }
            }
          }
          let regular = false;
          if (where.length >= 3) {
            const gaps = where.slice(1).map((x, i) => x - where[i]!);
            const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
            const sd = Math.sqrt(gaps.reduce((x, y) => x + (y - mean) ** 2, 0) / gaps.length);
            regular = mean > 0 && sd / mean <= T.vibratoRegularity;
          }
          if (distinct.size >= 3 && Number.isFinite(lo) && (hi - lo) / lo <= T.vibratoMaxRange && reversals >= T.vibratoMinReversals && regular) {
            const entry = found.vibrato.get(g) ?? { runs: 0, rates: [], depths: [] };
            entry.runs++;
            entry.rates.push((reversals / 2) / (len / callsPerSecond));
            entry.depths.push(1200 * Math.log2(hi / lo) / 2);
            found.vibrato.set(g, entry);
          }
        }
        const slides = monotoneSweeps(s.freq, a, b, T.slideMinChanges, 1);
        if (slides.length && !found.arpeggio.has(g) && distinctMonotone(s.freq, a, b)) found.slide.set(g, (found.slide.get(g) ?? 0) + slides.length);
      }
      // Pulse width sweeps while the pulse waveform is selected.
      const pulseCalls: number[] = [];
      for (let i = 0; i < n; i++) if (s.ctl[i]! & 0x40) pulseCalls.push(s.pulse[i]!);
      if (pulseCalls.length >= 2) {
        const sweeps = monotoneSweeps(pulseCalls, 0, pulseCalls.length, T.sweepMinChanges, T.sweepMinTotal);
        if (sweeps.length) found.pulse.set(g, { sweeps: sweeps.length, step: sweeps.map((w) => w.total / w.changes) });
      }
    }
  }
  const list = (m: Map<number, unknown>) => [...m.keys()].sort((a, b) => a - b);
  const hrVoices = [...found.hardRestart].filter(([, h]) => h.edges >= T.hardRestartMinEdges && h.pattern / h.edges >= T.hardRestartShare);
  if (hrVoices.length) {
    out.push({
      basis: "observed", source: "trace", name: "hard restart", voices: hrVoices.map(([g]) => g).sort((a, b) => a - b),
      summary: "a short gate-off gap before a note with the test bit set or the envelope registers changed",
      evidence: {
        gateOnEdges: hrVoices.reduce((x, [, h]) => x + h.edges, 0), edgesWithPattern: hrVoices.reduce((x, [, h]) => x + h.pattern, 0),
        edgesWithTestBit: hrVoices.reduce((x, [, h]) => x + h.test, 0), edgesWithEnvelopeChange: hrVoices.reduce((x, [, h]) => x + h.adsr, 0),
        window: T.hardRestartWindow,
      },
    });
  }
  if (found.arpeggio.size) {
    const periods = [...found.arpeggio.values()].flatMap((e) => e.periods);
    const steps = [...found.arpeggio.values()].flatMap((e) => e.steps);
    out.push({
      basis: "observed", source: "trace", name: "arpeggio", voices: list(found.arpeggio),
      summary: "the frequency cycles through a few values within one gate-on run",
      evidence: { runs: [...found.arpeggio.values()].reduce((x, e) => x + e.runs, 0), cycleSteps: mode(periods) ?? 0, example: mostCommon(steps) ?? "" },
    });
  }
  if (found.vibrato.size) {
    const rates = [...found.vibrato.values()].flatMap((e) => e.rates);
    const depths = [...found.vibrato.values()].flatMap((e) => e.depths);
    out.push({
      basis: "observed", source: "trace", name: "vibrato", voices: list(found.vibrato),
      summary: "the frequency oscillates regularly around the note by less than one semitone",
      evidence: { runs: [...found.vibrato.values()].reduce((x, e) => x + e.runs, 0), medianRateHz: round(median(rates), 2), medianDepthCents: round(median(depths), 1) },
    });
  }
  if (found.slide.size) {
    out.push({ basis: "observed", source: "trace", name: "pitch slide", voices: list(found.slide), summary: "the frequency moves in one direction over several calls", evidence: { slides: [...found.slide.values()].reduce((x, y) => x + y, 0) } });
  }
  if (found.pulse.size) {
    const steps = [...found.pulse.values()].flatMap((e) => e.step);
    out.push({
      basis: "observed", source: "trace", name: "pulse width sweep", voices: list(found.pulse), summary: "the pulse width moves monotonically over many calls",
      evidence: { sweeps: [...found.pulse.values()].reduce((x, e) => x + e.sweeps, 0), medianStepPerChange: round(median(steps), 2) },
    });
  }
  // Filter sweeps: the cutoff of each SID while the filter is routed and a filter mode is selected.
  const filterSids: number[] = [];
  let filterSweeps = 0;
  const routedVoices = new Set<number>();
  const modes = new Set<string>();
  let resonanceMax = 0;
  for (let sid = 0; sid < ir.sidCount; sid++) {
    const cutoff = new Int32Array(Math.max(0, ir.calls.length - from));
    const active: number[] = [];
    for (let i = 0; i < cutoff.length; i++) {
      const regs = ir.calls[from + i]!.sids[sid]?.regs;
      if (!regs) continue;
      const route = regs[0x17]! & 7;
      const filterMode = regs[0x18]! & 0x70;
      if (route && filterMode) {
        active.push((regs[0x15]! & 7) | (regs[0x16]! << 3));
        for (let v = 0; v < 3; v++) if (route & (1 << v)) routedVoices.add(globalVoice(sid, v));
        modes.add([filterMode & 0x10 ? "lowpass" : "", filterMode & 0x20 ? "bandpass" : "", filterMode & 0x40 ? "highpass" : ""].filter(Boolean).join("+"));
        resonanceMax = Math.max(resonanceMax, regs[0x17]! >> 4);
      }
    }
    if (active.length >= 2) {
      const sweeps = monotoneSweeps(active, 0, active.length, T.sweepMinChanges, T.sweepMinTotal);
      if (sweeps.length) { filterSids.push(sid + 1); filterSweeps += sweeps.length; }
    }
  }
  if (routedVoices.size) {
    out.push({
      basis: "observed", source: "trace", name: "filter sweep", voices: [...routedVoices].sort((a, b) => a - b),
      summary: filterSweeps ? "the filter cutoff moves monotonically over many calls while voices are routed through the filter" : "voices are routed through the filter; the cutoff does not sweep",
      evidence: { sweeps: filterSweeps, sids: filterSids, modes: [...modes].sort(), maxResonance: resonanceMax, swept: filterSweeps > 0 },
    });
  }
  const bit = (name: TechniqueName, m: Map<number, number>, summary: string) => {
    if (m.size) out.push({ basis: "observed", source: "trace", name, voices: list(m), summary, evidence: { calls: [...m.values()].reduce((x, y) => x + y, 0) } });
  };
  bit("oscillator sync", found.sync, "the sync bit is set while a waveform is selected");
  bit("ring modulation", found.ring, "the ring modulation bit is set while a waveform is selected");
  bit("test bit", found.test, "the test bit is set, which resets and holds the oscillator");
  bit("noise", found.noise, "the noise waveform is selected");
  bit("combined waveforms", found.combined, "more than one waveform bit is set at a time");
  if (ir.callsPerFrame >= 2) {
    out.push({ basis: "observed", source: "trace", name: "multispeed", voices: [], summary: "the player is called more than once per frame", evidence: { callsPerFrame: ir.callsPerFrame, callsPerFrameExact: round(ir.callsPerFrameExact, 4) } });
  }
  const samples = ir.unsupported.streams.filter((st) => st.register === 0x18);
  if (samples.length) {
    out.push({
      basis: "observed", source: "trace", name: "sample playback", voices: [], summary: "dense non-periodic writes to the volume register $D418 (digitised samples)",
      evidence: { streams: samples.length, writes: samples.reduce((x, st) => x + st.writes, 0), writesPerSecond: round(samples.reduce((x, st) => x + st.ratePerSecond, 0), 1), shareOfWrites: round(ir.unsupported.share, 4) },
    });
  }
  return out;
}

function distinctMonotone(values: ArrayLike<number>, a: number, b: number): boolean {
  // A slide moves through many distinct values; a pitch step between notes does not.
  const seen = new Set<number>();
  for (let i = a; i < b; i++) seen.add(values[i]!);
  return seen.size >= 5;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && best !== undefined && v < best)) { best = v; bestN = n; }
  return best;
}

/** Techniques of a score, read from the instruments the voices use. All facts are observed in the score. */
export function techniquesFromScore(model: ScoreModel): Technique[] {
  const arr = model.arrangement;
  if (!arr) throw new Error("techniquesFromScore needs the arrangement of the compiler");
  const usedBy = new Map<number, Set<number>>();
  for (const n of model.notes) {
    let s = usedBy.get(n.inst);
    if (!s) usedBy.set(n.inst, (s = new Set()));
    s.add(n.voice);
  }
  const voicesOf = (pred: (i: Arrangement["instruments"][number]) => boolean): number[] => {
    const voices = new Set<number>();
    for (const [index, set] of usedBy) if (pred(arr.instruments[index]!)) for (const v of set) voices.add(v);
    return [...voices].sort((a, b) => a - b);
  };
  const out: Technique[] = [];
  const add = (name: TechniqueName, voices: number[], summary: string, evidence: Technique["evidence"] = {}) => {
    if (voices.length) out.push({ basis: "observed", source: "score", name, voices, summary, evidence });
  };
  add("hard restart", voicesOf((i) => !!i.restart && i.restart.frames > 0), "the instrument defines a hard restart before each note", { frames: Math.max(0, ...arr.instruments.map((i) => i.restart?.frames ?? 0)) });
  add("arpeggio", voicesOf((i) => i.arp.length > 1 || (i.wavetable ?? []).filter((s) => s.note !== undefined).length > 1), "the instrument cycles through note offsets");
  add("vibrato", voicesOf((i) => i.vibRate > 0), "the instrument has vibrato");
  add("pitch slide", voicesOf((i) => i.slideSemis !== 0), "the instrument slides in pitch");
  add("pulse width sweep", voicesOf((i) => !!i.pulsetable || i.pwStep !== 0), "the instrument sweeps the pulse width");
  add("filter sweep", voicesOf((i) => !!i.filtertable), "the instrument drives the filter cutoff from a table");
  add("oscillator sync", voicesOf((i) => !!i.sync || !!(i.wavetable ?? []).some((s) => s.sync)), "the instrument uses oscillator sync");
  add("ring modulation", voicesOf((i) => !!i.ring || !!(i.wavetable ?? []).some((s) => s.ring)), "the instrument uses ring modulation");
  add("noise", voicesOf((i) => (i.wave & 0xf0) === 0x80), "the instrument uses the noise waveform");
  add("combined waveforms", voicesOf((i) => { const w = i.wave >> 4; return w !== 0 && (w & (w - 1)) !== 0; }), "the instrument selects more than one waveform bit");
  add("wavetable program", voicesOf((i) => !!i.wavetable && i.wavetable.length > 0), "the instrument runs a wavetable of steps");
  if (arr.speed > 1) out.push({ basis: "observed", source: "score", name: "multispeed", voices: [], summary: "the score sets a player speed above 1", evidence: { speed: arr.speed } });
  if (arr.samples) out.push({ basis: "observed", source: "score", name: "sample playback", voices: [], summary: "the score plays digitised samples", evidence: {} });
  return out;
}
