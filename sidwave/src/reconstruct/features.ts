// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Feature extraction for the reconstruction corpus. Header features come from the PSID/RSID header, trace
// features from the frame-state IR. Both are reduced to coarse bins for the corpus selection.

import { songSpeed, type SidFile } from "../sidFile.js";
import { controlRegister, type FrameIr } from "./ir.js";

/** Increment when the meaning of any feature or bin changes; it is part of the corpus cache key. */
export const FEATURE_CODE_VERSION = 1;

export interface HeaderFeatures {
  magic: "PSID" | "RSID";
  /** Model of the first SID: "6581", "8580", "both" (the header allows either) or "unknown". */
  model: "6581" | "8580" | "both" | "unknown";
  clock: "PAL" | "NTSC" | "both" | "unknown";
  sidCount: 1 | 2 | 3;
  /** Speed flag of the subtune. */
  speed: "VBI" | "CIA";
}

export interface TraceFeatures {
  calls: number;
  seconds: number;
  callsPerFrame: number;
  callsPerFrameExact: number;
  /** Median number of writes in a call. */
  writesPerCall: number;
  /** Share of call spacings outside the jitter tolerance. */
  irregularShare: number;
  /** Control register writes with the sync bit and a waveform, with the ring bit and the triangle, and with the test bit. */
  syncWrites: number;
  ringWrites: number;
  testBitWrites: number;
  /** Number of control writes per waveform nibble ($10 triangle, $20 sawtooth, $40 pulse, $80 noise, sums for combinations). */
  waveformWrites: Record<number, number>;
  /** Per voice, the number of (call, SID) pairs in which the voice is routed through an active filter (routing set, a mode on), divided by the number of calls. */
  filterRoutedShare: [number, number, number];
  /** Number of calls with low-pass, band-pass and high-pass on. */
  filterModeCalls: { lp: number; bp: number; hp: number };
  /** Calls in which at least two filter modes are on at once. */
  filterMultiModeCalls: number;
  gateOns: number;
  hardRestarts: number;
  /** hardRestarts divided by gateOns (0 without gate-ons). */
  hardRestartRate: number;
  /** Distinct note programs, and per minute of the covered time. */
  notePrograms: { distinct: number; perMinute: number };
  /** Writes removed as non-periodic and their share of all writes. */
  sampleWrites: number;
  sampleShare: number;
  /** Seconds from the first call to the first window that is repeated later, or the whole covered time when none repeats. */
  introSeconds: number;
  repeats: boolean;
}

export interface Features {
  header?: HeaderFeatures;
  trace: TraceFeatures;
}

/** Header features of a parsed PSID or RSID file and a 1-based subtune. */
export function headerFeatures(file: SidFile, subtune: number): HeaderFeatures {
  const model = file.sidModels[0];
  return {
    magic: file.magic,
    model: model === "6581+8580" ? "both" : model,
    clock: file.clock === "PAL+NTSC" ? "both" : file.clock,
    sidCount: file.thirdSidAddress !== undefined ? 3 : file.secondSidAddress !== undefined ? 2 : 1,
    speed: songSpeed(file, subtune),
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fnv(hash: number, value: number): number {
  return Math.imul(hash ^ (value & 0xffff), 0x01000193) >>> 0;
}

const M1 = 67_108_859;
const M2 = 67_108_837;
const B1 = 131;
const B2 = 137;

/** Seconds until the first window of calls that occurs again later, or the covered time when none does. */
function intro(ir: FrameIr): { seconds: number; repeats: boolean } {
  const n = ir.calls.length;
  const periodSeconds = ir.periodCycles / ir.clockHz;
  const w = Math.max(32, periodSeconds > 0 ? Math.round(2 / periodSeconds) : 32);
  const none = { seconds: ir.seconds, repeats: false };
  if (n < 2 * w) return none;
  const h = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let x = 0x811c9dc5;
    for (const s of ir.calls[i].sids) for (let r = 0; r < s.regs.length; r++) x = fnv(x, s.regs[r] + (r << 8));
    h[i] = x;
  }
  let p1 = 1;
  let p2 = 1;
  for (let k = 0; k < w - 1; k++) {
    p1 = (p1 * B1) % M1;
    p2 = (p2 * B2) % M2;
  }
  let a = 0;
  let b = 0;
  for (let k = 0; k < w; k++) {
    a = (a * B1 + (h[k] % M1)) % M1;
    b = (b * B2 + (h[k] % M2)) % M2;
  }
  const seen = new Map<number, number[]>();
  const distinct = (start: number): number => new Set(h.slice(start, start + w)).size;
  let best = -1;
  for (let i = 0; i + w <= n; i++) {
    const key = a * M2 + b;
    const earlier = seen.get(key);
    if (earlier) {
      for (const j of earlier) {
        if (h.slice(j, j + w).every((v, k) => v === h[i + k]) && distinct(i) >= 8) {
          if (best < 0 || j < best) best = j;
          break;
        }
      }
    }
    if (earlier) earlier.push(i);
    else seen.set(key, [i]);
    if (i + w < n) {
      a = (((a - ((h[i] % M1) * p1) % M1 + M1) % M1) * B1 + (h[i + w] % M1)) % M1;
      b = (((b - ((h[i] % M2) * p2) % M2 + M2) % M2) * B2 + (h[i + w] % M2)) % M2;
    }
  }
  if (best < 0) return none;
  return { seconds: (ir.calls[best].startCycle - ir.calls[0].startCycle) / ir.clockHz, repeats: true };
}

function popcount(v: number): number {
  let n = 0;
  for (let x = v; x; x >>= 1) n += x & 1;
  return n;
}

/** Trace features of an IR. */
export function traceFeatures(ir: FrameIr): TraceFeatures {
  const calls = ir.calls;
  const syncWritesRef = { sync: 0, ring: 0, test: 0 };
  const waveformWrites: Record<number, number> = {};
  const routed: [number, number, number] = [0, 0, 0];
  const modeCalls = { lp: 0, bp: 0, hp: 0 };
  let multi = 0;
  let gateOns = 0;
  let hardRestarts = 0;
  const programs = new Set<string>();

  for (const call of calls) {
    for (const sid of call.sids) {
      const mode = sid.regs[0x18] >> 4;
      const route = sid.regs[0x17] & 7;
      const modes = mode & 7;
      if (modes && route) {
        for (let v = 0; v < 3; v++) if (route & (1 << v)) routed[v]++;
      }
      if (mode & 1) modeCalls.lp++;
      if (mode & 2) modeCalls.bp++;
      if (mode & 4) modeCalls.hp++;
      if (popcount(modes) >= 2) multi++;
      for (let v = 0; v < 3; v++) {
        for (const value of sid.control[v]) {
          if (value & 0x02 && value & 0xf0) syncWritesRef.sync++;
          if (value & 0x04 && value & 0x10) syncWritesRef.ring++;
          if (value & 0x08) syncWritesRef.test++;
          const nibble = value >> 4;
          if (nibble) waveformWrites[nibble] = (waveformWrites[nibble] ?? 0) + 1;
        }
      }
    }
  }

  const sidCount = ir.sidCount;
  for (let s = 0; s < sidCount; s++) {
    for (let v = 0; v < 3; v++) {
      const c = controlRegister(v);
      let gate = false;
      let lastOff = -Infinity;
      let lastAdsr = -Infinity;
      let lastTest = -Infinity;
      const noteStarts: number[] = [];
      const noteEnds: number[] = [];
      for (let i = 0; i < calls.length; i++) {
        const sid = calls[i].sids[s];
        if (!sid) continue;
        for (const value of sid.control[v]) {
          if (value & 0x08) lastTest = i;
          const on = (value & 1) === 1;
          if (on && !gate) {
            gateOns++;
            if (i - lastOff <= 3 && (i - lastAdsr <= 3 || i - lastTest <= 3)) hardRestarts++;
            noteStarts.push(i);
          } else if (!on && gate) {
            lastOff = i;
            noteEnds.push(i);
          }
          gate = on;
        }
        // ADSR writes of this call count for later gate-ons only: setting the instrument in the call that
        // starts the note is not a hard restart.
        if (sid.written & ((1 << (c + 1)) | (1 << (c + 2)))) lastAdsr = i;
      }
      for (let k = 0; k < noteStarts.length; k++) {
        const first = noteStarts[k];
        const end = Math.min(noteEnds.find((e) => e >= first) ?? calls.length - 1, first + 63);
        const f0 = calls[first].sids[s].regs[c - 4] | (calls[first].sids[s].regs[c - 3] << 8);
        let hash = 0x811c9dc5;
        for (let i = first; i <= end; i++) {
          const r = calls[i].sids[s].regs;
          const f = r[c - 4] | (r[c - 3] << 8);
          const cents = f0 && f ? Math.round(1200 * Math.log2(f / f0)) : f === f0 ? 0 : 99_999;
          hash = fnv(hash, r[c]);
          hash = fnv(hash, r[c - 2] | ((r[c - 1] & 0x0f) << 8));
          hash = fnv(hash, r[c + 1]);
          hash = fnv(hash, r[c + 2]);
          hash = fnv(hash, cents);
        }
        programs.add(`${hash}:${end - first}`);
      }
    }
  }

  const spans = ir.seconds > 0 ? ir.seconds : 0;
  const { seconds: introSeconds, repeats } = intro(ir);
  const denominator = calls.length || 1;
  return {
    calls: calls.length,
    seconds: ir.seconds,
    callsPerFrame: ir.callsPerFrame,
    callsPerFrameExact: ir.callsPerFrameExact,
    writesPerCall: median(calls.map((c) => c.writes)),
    irregularShare: ir.jitter.irregularShare,
    syncWrites: syncWritesRef.sync,
    ringWrites: syncWritesRef.ring,
    testBitWrites: syncWritesRef.test,
    waveformWrites,
    filterRoutedShare: [routed[0] / denominator, routed[1] / denominator, routed[2] / denominator],
    filterModeCalls: modeCalls,
    filterMultiModeCalls: multi,
    gateOns,
    hardRestarts,
    hardRestartRate: gateOns ? hardRestarts / gateOns : 0,
    notePrograms: { distinct: programs.size, perMinute: spans > 0 ? programs.size / (spans / 60) : 0 },
    sampleWrites: ir.unsupported.writes,
    sampleShare: ir.unsupported.share,
    introSeconds,
    repeats,
  };
}

/** Header and trace features. */
export function extractFeatures(ir: FrameIr, header?: HeaderFeatures): Features {
  return { ...(header ? { header } : {}), trace: traceFeatures(ir) };
}

/** Minimum number of control writes for sync, ring, test-bit and waveform bins. */
export const MIN_BIN_WRITES = 3;

function waveBins(waveformWrites: Record<number, number>): string[] {
  const bins: string[] = [];
  const count = (pred: (nibble: number) => boolean): number =>
    Object.entries(waveformWrites).reduce((n, [nibble, c]) => (pred(Number(nibble)) ? n + c : n), 0);
  const single = (bit: number): number => count((n) => n === bit);
  if (single(1) >= MIN_BIN_WRITES) bins.push("wave:triangle");
  if (single(2) >= MIN_BIN_WRITES) bins.push("wave:sawtooth");
  if (single(4) >= MIN_BIN_WRITES) bins.push("wave:pulse");
  if (single(8) >= MIN_BIN_WRITES) bins.push("wave:noise");
  if (count((n) => popcount(n) >= 2) >= MIN_BIN_WRITES) bins.push("wave:combined");
  return bins;
}

/** Coarse bins of header and trace features, sorted. Thresholds are part of FEATURE_CODE_VERSION. */
export function featureBins(features: Features): string[] {
  const bins: string[] = [];
  const h = features.header;
  if (h) {
    bins.push(`magic:${h.magic}`, `model:${h.model}`, `clock:${h.clock}`, `sids:${h.sidCount}`, `speed:${h.speed.toLowerCase()}`);
  }
  const t = features.trace;
  const cpf = t.callsPerFrame;
  bins.push(cpf === 0 ? "cpf:slow" : cpf === 1 ? "cpf:1" : cpf === 2 ? "cpf:2" : cpf <= 4 ? "cpf:3-4" : "cpf:5+");
  bins.push(t.writesPerCall < 8 ? "wpc:low" : t.writesPerCall <= 24 ? "wpc:mid" : "wpc:high");
  if (t.syncWrites >= MIN_BIN_WRITES) bins.push("sync");
  if (t.ringWrites >= MIN_BIN_WRITES) bins.push("ring");
  if (t.testBitWrites >= MIN_BIN_WRITES) bins.push("testbit");
  t.filterRoutedShare.forEach((share, v) => {
    if (share >= 0.05) bins.push(`filter:v${v + 1}`);
  });
  const calls = Math.max(1, t.calls);
  if (t.filterModeCalls.lp / calls >= 0.05) bins.push("filter:lp");
  if (t.filterModeCalls.bp / calls >= 0.05) bins.push("filter:bp");
  if (t.filterModeCalls.hp / calls >= 0.05) bins.push("filter:hp");
  if (t.filterMultiModeCalls / calls >= 0.05) bins.push("filter:multimode");
  bins.push(...waveBins(t.waveformWrites));
  bins.push(
    t.gateOns < 4 || t.hardRestartRate < 0.05 ? "hr:none" : t.hardRestartRate <= 0.5 ? "hr:some" : "hr:most",
  );
  bins.push(
    t.notePrograms.perMinute < 20 ? "tables:low" : t.notePrograms.perMinute <= 120 ? "tables:mid" : "tables:high",
  );
  bins.push(t.sampleShare === 0 ? "sample:none" : t.sampleShare <= 0.2 ? "sample:some" : "sample:heavy");
  bins.push(t.introSeconds < 8 ? "intro:short" : t.introSeconds < 30 ? "intro:medium" : "intro:long");
  return bins.sort();
}
