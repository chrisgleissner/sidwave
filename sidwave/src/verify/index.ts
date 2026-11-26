// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createHash } from "node:crypto";
import type { EngineIdentity, SidEngine, SidEmulation } from "../engine/types.js";

export type Difference = { level: "T0" | "T1" | "A0"; category: "missing_write" | "extra_write" | "value" | "order" | "timing" | "length" | "pcm"; call?: number; cycle?: number; timeSeconds?: number; sid?: number; voice?: number; register?: number; expected?: number; observed?: number };
export type TraceComparison = { t0: { equal: boolean; calls: number; firstDifference?: Difference }; t1: { equal: boolean; maxOffsetCycles: number; toleranceCycles: number; firstDifference?: Difference }; horizon: { calls: number; cycles: number }; playPeriodCycles: number };
export type CompareOptions = { horizonCycles?: number; toleranceCycles?: number; burstGapCycles?: number };
export type VerifyResult = { level: "T0" | "T1" | "A0" | "none"; levels: { T0: "pass" | "fail"; T1: "pass" | "fail"; A0: "pass" | "fail" | "not evaluated"; A1: "not evaluated" }; horizon: { seconds: number; cycles: number; calls: number }; firstDifference?: Difference; engines: { trace: EngineIdentity; pcm?: EngineIdentity } };
const PAL = 985_248;
const DEFAULT_BURST_GAP = 2_000;
const DEFAULT_TOLERANCE = 0;
type W = { sid: number; reg: number; value: number; cycle: number; index: number };

function records(input: Float64Array): W[] {
  if (!(input instanceof Float64Array) || input.length % 4) throw new VerifyError("invalid_trace", "Trace must contain groups of four Float64 values");
  const out: W[] = [];
  for (let i = 0; i < input.length; i += 4) {
    const [sid, reg, value, cycle] = input.subarray(i, i + 4);
    if (![sid, reg, value, cycle].every(Number.isFinite) || sid < 0 || reg < 0 || reg > 0x18 || value < 0 || value > 255 || cycle < 0) throw new VerifyError("invalid_trace", `Invalid SID write at record ${i / 4}`);
    out.push({ sid, reg, value, cycle, index: i / 4 });
  }
  return out;
}
function bursts(ws: W[], gap: number): W[][] {
  const out: W[][] = [];
  for (const w of ws) {
    const current = out[out.length - 1];
    if (!current || w.cycle - current[current.length - 1].cycle > gap) out.push([w]); else current.push(w);
  }
  return out;
}
function median(xs: number[]): number { if (!xs.length) return 0; xs.sort((a,b)=>a-b); const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; }
function callGroups(ws: W[], gap: number): W[][] {
  const bs = bursts(ws, gap);
  const starts = bs.slice(1).map(x => x[0].cycle - bs[bs.indexOf(x) - 1][0].cycle);
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
function diff(level: Difference["level"], category: Difference["category"], a?: W, b?: W, call?: number): Difference {
  const w = a ?? b;
  const d: Difference = { level, category };
  if (call !== undefined) d.call = call;
  if (w) { d.sid = w.sid; d.register = w.reg; if (w.reg <= 0x14) d.voice = Math.floor(w.reg / 7) + 1; }
  if (a) { d.expected = a.value; d.cycle = a.cycle; }
  if (b) { d.observed = b.value; d.cycle ??= b.cycle; }
  return d;
}
export class VerifyError extends Error {
  constructor(readonly code: "invalid_trace" | "invalid_options" | "trace_limit" | "pcm_engine_required" | "unsupported_pcm_engine", message: string) { super(message); this.name = "VerifyError"; }
}
export function compareTraces(expected: Float64Array, observed: Float64Array, options: CompareOptions = {}): TraceComparison {
  const gap = options.burstGapCycles ?? DEFAULT_BURST_GAP, tolerance = options.toleranceCycles ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(gap) || gap < 1 || !Number.isFinite(tolerance) || tolerance < 0 || (options.horizonCycles !== undefined && (!Number.isFinite(options.horizonCycles) || options.horizonCycles <= 0))) throw new VerifyError("invalid_options", "Cycle options must be finite and nonnegative (horizon must be positive)");
  if (expected.length / 4 > 2_000_000 || observed.length / 4 > 2_000_000) throw new VerifyError("trace_limit", "Trace comparison is limited to 2,000,000 writes per input");
  const a = records(expected), b = records(observed);
  const originA = a[0]?.cycle ?? 0, originB = b[0]?.cycle ?? 0;
  const horizonCycles = options.horizonCycles ?? Math.max((a[a.length - 1]?.cycle ?? originA) - originA, (b[b.length - 1]?.cycle ?? originB) - originB);
  const within = (ws: W[], origin: number) => ws.filter(w => w.cycle - origin <= horizonCycles);
  const aa = within(a, originA), bb = within(b, originB);
  const ca = callGroups(aa, gap), cb = callGroups(bb, gap);
  const starts = [...bursts(aa, gap), ...bursts(bb, gap)].map(c => c[0].cycle).sort((x,y)=>x-y);
  const period = median(starts.slice(1).map((x,i)=>x-starts[i]));
  const n = Math.max(ca.length, cb.length);
  let d0: Difference | undefined;
  for (let c = 0; c < n && !d0; c++) {
    const x = ca[c] ?? [], y = cb[c] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const p = x[i], q = y[i];
      if (!p) { d0 = diff("T0", "extra_write", undefined, q, c); break; }
      if (!q) { d0 = diff("T0", "missing_write", p, undefined, c); break; }
      if (p.sid !== q.sid || p.reg !== q.reg) { d0 = diff("T0", "order", p, q, c); break; }
      if (p.value !== q.value) { d0 = diff("T0", "value", p, q, c); break; }
    }
  }
  let maxOffsetCycles = 0, d1: Difference | undefined;
  const m = Math.max(aa.length, bb.length);
  for (let i = 0; i < m; i++) {
    const p = aa[i], q = bb[i];
    if (!p || !q) { d1 = diff("T1", i === Math.min(aa.length, bb.length) ? "length" : p ? "missing_write" : "extra_write", p, q); break; }
    if (p.sid !== q.sid || p.reg !== q.reg) { d1 = diff("T1", "order", p, q); break; }
    if (p.value !== q.value) { d1 = diff("T1", "value", p, q); break; }
    const offset = Math.abs((p.cycle - originA) - (q.cycle - originB)); maxOffsetCycles = Math.max(maxOffsetCycles, offset);
    if (offset > tolerance && !d1) d1 = { ...diff("T1", "timing", p, q), cycle: p.cycle, timeSeconds: (p.cycle - originA) / PAL };
  }
  return { t0: { equal: !d0, calls: n, ...(d0 ? { firstDifference: d0 } : {}) }, t1: { equal: !d1, maxOffsetCycles, toleranceCycles: tolerance, ...(d1 ? { firstDifference: d1 } : {}) }, horizon: { calls: n, cycles: horizonCycles }, playPeriodCycles: period };
}
export async function verifySid(expected: Uint8Array, observed: Uint8Array, options: { engine: SidEngine; seconds: number; song?: number; toleranceCycles?: number; pcmEngine?: SidEngine }): Promise<VerifyResult> {
  const { engine, seconds, song, toleranceCycles = 0, pcmEngine } = options;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new VerifyError("invalid_options", "seconds must be in (0, 60]");
  const clock = PAL;
  const [a, b] = await Promise.all([engine.trace({ sid: expected, seconds, song, maxRecords: 2_000_000 }), engine.trace({ sid: observed, seconds, song, maxRecords: 2_000_000 })]);
  const cmp = compareTraces(a.records, b.records, { horizonCycles: Math.min(a.cycles, b.cycles), toleranceCycles });
  let A0: VerifyResult["levels"]["A0"] = "not evaluated", audioDiff: Difference | undefined;
  let pcmIdentity: EngineIdentity | undefined;
  if (pcmEngine) {
    const [x, y] = await Promise.all([pcmEngine.render({ sid: expected, seconds, song }), pcmEngine.render({ sid: observed, seconds, song })]);
    if ((x.engine as EngineIdentity & { emulation?: SidEmulation }).emulation !== "sidlite" || (y.engine as EngineIdentity & { emulation?: SidEmulation }).emulation !== "sidlite") throw new VerifyError("unsupported_pcm_engine", "A0 requires SIDLite rendering");
    pcmIdentity = x.engine;
    const hx = createHash("sha256").update(Buffer.from(x.samples.buffer, x.samples.byteOffset, x.samples.byteLength)).digest("hex");
    const hy = createHash("sha256").update(Buffer.from(y.samples.buffer, y.samples.byteOffset, y.samples.byteLength)).digest("hex");
    if (hx === hy) A0 = "pass";
    else { A0 = "fail"; let i=0; while(i<Math.min(x.samples.length,y.samples.length)&&x.samples[i]===y.samples[i]) i++; audioDiff = { level:"A0", category:"pcm", expected:x.samples[i], observed:y.samples[i], cycle:Math.floor(i * clock / x.sampleRate), timeSeconds:i / x.sampleRate }; }
  }
  const T0 = cmp.t0.equal ? "pass" : "fail", T1 = cmp.t1.equal ? "pass" : "fail";
  const level = T0 === "pass" ? "T0" : T1 === "pass" ? "T1" : A0 === "pass" ? "A0" : "none";
  return { level, levels: { T0, T1, A0, A1: "not evaluated" }, horizon: { seconds, cycles: Math.min(a.cycles,b.cycles), calls: cmp.horizon.calls }, ...(cmp.t0.firstDifference ? { firstDifference: cmp.t0.firstDifference } : cmp.t1.firstDifference ? { firstDifference: cmp.t1.firstDifference } : audioDiff ? { firstDifference: audioDiff } : {}), engines: { trace: a.engine, ...(pcmIdentity ? { pcm: pcmIdentity } : {}) } };
}
