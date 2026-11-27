// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Structural analysis report of a score or a SID tune: key and mode, metre, form, motifs, voice use, techniques and
// resources. Every fact carries `basis`: "observed" (read from the register trace or the score) or "inferred" (the
// result of a model, with the method named). For a SID tune the notes come from the SIDWave reconstruction, so the
// musical facts are inferred; the technique, resource and register-range facts are observed in the trace.

import { SidwaveOperationError } from "../cliCore.js";
import { parseSidFile } from "../sidFile.js";
import { psidClock, type SidEngine } from "../engine/libsidplayfp.js";
import { IR_CLOCK_HZ, type FrameIr } from "../reconstruct/ir.js";
import { DEFAULT_HORIZON_SECONDS, irOfTrace, reconstructSid, type ReconstructReport } from "../reconstruct/reconstruct.js";
import { parseSidwave, type ParsedSidwave } from "../sidwave.js";
import { compileSidwaveBytes } from "../sidwaveOps.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { globalVoice, md5, memoEngine, noteName, sha256, voiceRegs, type Marked } from "./common.js";
import {
  analyzeForm, estimateKey, estimateMetre, mineMotifs, modelOfScore, round, voiceUse,
  type FormReport, type KeyEstimate, type Motif, type MetreEstimate, type VoiceUse,
} from "./music.js";
import { techniquesFromIr, techniquesFromScore, type Technique } from "./techniques.js";

export const ANALYSIS_SCHEMA = "sidwave-analysis/1";

export interface TraceVoiceFacts extends Marked {
  voice: number;
  /** Share of calls with the gate bit set. */
  gateShare: number;
  waveforms: string[];
  /** Lowest and highest frequency register value written while the gate was set, as Hz and nearest note name (no tuning correction). */
  frequencyRange?: { lowestHz: number; highestHz: number; lowest: string; highest: string };
}

export interface ResourceReport {
  /** Facts measured in the trace. */
  trace?: Marked & {
    calls: number;
    callsPerFrame: number;
    periodCycles: number;
    irregularShare: number;
    writes: number;
    /** Cycles from the first to the last SID write of a call: a lower bound of the player cost, because the engine does not report the CPU cycles between writes. */
    callSpanCycles: { min: number; median: number; p95: number; max: number };
    writesPerCall: { median: number; max: number };
    unsupportedWrites: number;
  };
  /** Memory of the tune from the PSID header. */
  memory?: Marked & { loadAddress: number; endAddress: number; bytes: number; initAddress: number; playAddress: number; sidCount: number; clock: string; models: string[] };
  /** Static facts from the compiler, for a score. */
  compiled?: Marked & { outputBytes: number; prgBytes: number; streamBytes: number; loadAddress: number; endAddress: number; worstCaseCyclesPerCall: number; sidCount: number };
}

export interface AnalysisReport {
  schema: typeof ANALYSIS_SCHEMA;
  source: { kind: "score" | "sid"; sha256: string; md5?: string; song?: number; title?: string; author?: string; released?: string };
  /** SID input: the horizon the trace covers. */
  horizon?: { seconds: number; calls: number; clock: string; song: number };
  /** SID input: how well the reconstruction reproduces the tune, which bounds the musical facts. */
  reconstruction?: { strictExact: boolean; registerStateExact: boolean; notes: number; instruments: number; differingCalls: number; basis: "observed" };
  key?: KeyEstimate;
  /** Absent when the reconstruction of a SID tune could not be parsed as a score (see limits). */
  metre?: MetreEstimate;
  form?: FormReport;
  motifs: Motif[];
  voices: Array<VoiceUse & { trace?: TraceVoiceFacts }>;
  techniques: Technique[];
  resources: ResourceReport;
  limits: string[];
}

export interface AnalyzeScoreOptions {
  read?: SidwaveReadOptions;
  /** With an engine the compiled score is traced as well, and techniques and resources are measured in the trace. */
  engine?: SidEngine;
  /** Horizon of the trace in seconds. Default: one pass of the score, at most 180. */
  seconds?: number;
}

export interface AnalyzeSidOptions {
  engine: SidEngine;
  song?: number;
  seconds?: number;
  signal?: AbortSignal;
}

function declaredRoles(doc: ParsedSidwave): Map<number, string> {
  const roles = new Map<number, string>();
  for (const v of doc.voices) {
    const slot = doc.voiceSlots.get(v.id);
    if (v.role && slot !== undefined) roles.set(slot + 1, v.role);
  }
  return roles;
}

function percentile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}

const WAVE_NAMES: Array<[number, string]> = [[0x10, "triangle"], [0x20, "sawtooth"], [0x40, "pulse"], [0x80, "noise"]];

/** Per-voice register facts of a trace. */
export function traceVoiceFacts(ir: FrameIr): TraceVoiceFacts[] {
  const out: TraceVoiceFacts[] = [];
  for (let sid = 0; sid < ir.sidCount; sid++) {
    for (let voice = 0; voice < 3; voice++) {
      let gate = 0, lo = Infinity, hi = 0, waves = 0;
      for (const call of ir.calls) {
        const regs = call.sids[sid]?.regs;
        if (!regs) continue;
        const r = voiceRegs(regs, voice);
        if (r.control & 1) {
          gate++;
          waves |= r.control & 0xf0;
          if (r.freq > 0) { lo = Math.min(lo, r.freq); hi = Math.max(hi, r.freq); }
        }
      }
      const hz = (f: number) => (f * IR_CLOCK_HZ[ir.clock]) / 16_777_216;
      const midi = (f: number) => Math.round(69 + 12 * Math.log2(hz(f) / 440));
      out.push({
        basis: "observed", voice: globalVoice(sid, voice), gateShare: round(ir.calls.length ? gate / ir.calls.length : 0, 4),
        waveforms: WAVE_NAMES.filter(([bit]) => waves & bit).map(([, n]) => n),
        ...(Number.isFinite(lo) && hi > 0 ? { frequencyRange: { lowestHz: round(hz(lo), 2), highestHz: round(hz(hi), 2), lowest: noteName(midi(lo)), highest: noteName(midi(hi)) } } : {}),
      });
    }
  }
  return out;
}

/** Call-level resource figures of a trace. */
export function traceResources(ir: FrameIr): NonNullable<ResourceReport["trace"]> {
  const spans = ir.calls.map((c) => c.endCycle - c.startCycle).sort((a, b) => a - b);
  const writes = ir.calls.map((c) => c.writes).sort((a, b) => a - b);
  return {
    basis: "observed", calls: ir.calls.length, callsPerFrame: ir.callsPerFrame, periodCycles: ir.periodCycles, irregularShare: round(ir.jitter.irregularShare, 4),
    writes: ir.totalWrites,
    callSpanCycles: { min: spans[0] ?? 0, median: percentile(spans, 0.5), p95: percentile(spans, 0.95), max: spans[spans.length - 1] ?? 0 },
    writesPerCall: { median: percentile(writes, 0.5), max: writes[writes.length - 1] ?? 0 },
    unsupportedWrites: ir.unsupported.writes,
  };
}

function musicSections(doc: ParsedSidwave, basis: "observed" | "inferred") {
  const model = modelOfScore(doc);
  return {
    model,
    key: estimateKey(model.notes),
    metre: estimateMetre(model, basis),
    form: analyzeForm(model, basis),
    motifs: mineMotifs(model),
    voices: voiceUse(model, basis === "observed" ? declaredRoles(doc) : new Map()),
  };
}

/** Analysis of a SIDWave score. Without an engine the score is analysed statically. */
export async function analyzeScore(text: string, options: AnalyzeScoreOptions = {}): Promise<AnalysisReport> {
  const doc = parseSidwave(text, options.read ?? {});
  const parts = musicSections(doc, "observed");
  const compiled = compileSidwaveBytes(doc, { format: "prg" });
  const s = compiled.summary;
  const report: AnalysisReport = {
    schema: ANALYSIS_SCHEMA,
    source: { kind: "score", sha256: sha256(text), title: doc.song.title, ...(doc.song.author ? { author: doc.song.author } : {}) },
    key: parts.key, metre: parts.metre, form: parts.form, motifs: parts.motifs, voices: parts.voices,
    techniques: techniquesFromScore(parts.model),
    resources: {
      compiled: {
        basis: "inferred", method: "static worst-case cycle bound of the SIDWave player computed by the compiler",
        outputBytes: s.outputBytes, prgBytes: s.prgBytes, streamBytes: s.streamBytes, loadAddress: s.loadAddress, endAddress: s.endAddress,
        worstCaseCyclesPerCall: s.worstCaseCyclesPerCall, sidCount: s.sidCount,
      },
    },
    limits: [
      "Key, metre, form, motifs and roles are inferred from the score by the named methods; they are not part of the score.",
      "Techniques are read from the instrument definitions; a technique that an instrument defines but the voices never trigger is not listed.",
    ],
  };
  if (options.engine) {
    const seconds = Math.min(options.seconds ?? s.durationSeconds, DEFAULT_HORIZON_SECONDS);
    const bytes = new Uint8Array(compileSidwaveBytes(doc, { format: "sid" }).bytes);
    const trace = await options.engine.trace({ sid: bytes, seconds, clock: doc.song.mode });
    const ir = irOfTrace(trace);
    const observed = techniquesFromIr(ir);
    const names = new Set(observed.map((t) => t.name));
    // Trace facts replace the score facts of the same technique; score-only techniques (not visible in a short trace) are kept.
    report.techniques = [...observed, ...report.techniques.filter((t) => !names.has(t.name))];
    report.resources.trace = traceResources(ir);
    const facts = new Map(traceVoiceFacts(ir).map((f) => [f.voice, f]));
    report.voices = report.voices.map((v) => ({ ...v, ...(facts.has(v.voice) ? { trace: facts.get(v.voice)! } : {}) }));
    report.horizon = { seconds, calls: ir.calls.length, clock: trace.clock, song: 1 };
  }
  return report;
}

/** Analysis of a SID tune: reconstruct it, then analyse the reconstruction together with the register trace. */
export async function analyzeSid(sidBytes: Uint8Array, options: AnalyzeSidOptions): Promise<AnalysisReport> {
  const file = parseSidFile(sidBytes);
  const song = options.song ?? file.startSong;
  if (!Number.isInteger(song) || song < 1 || song > file.songs) throw new SidwaveOperationError("input", `song ${song} is outside 1..${file.songs}`);
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const clock = psidClock(sidBytes) ?? "PAL";
  const engine = memoEngine(options.engine);
  const { score, report: rec } = await reconstructSid(sidBytes, { engine, song, seconds });
  // The trace of the original was cached by the reconstruction.
  const trace = await engine.trace({ sid: sidBytes, song, seconds, clock });
  const ir = irOfTrace(trace);
  let parts: ReturnType<typeof musicSections> | undefined;
  let musicError: string | undefined;
  try {
    parts = musicSections(parseSidwave(score), "inferred");
  } catch (error) {
    musicError = error instanceof Error ? error.message : String(error);
  }
  const facts = new Map(traceVoiceFacts(ir).map((f) => [f.voice, f]));
  const differing = rec.fdiff.differingCalls;
  const resources: ResourceReport = {
    trace: traceResources(ir),
    memory: {
      basis: "observed", loadAddress: file.loadAddress, endAddress: file.loadAddress + file.payload.length - 1, bytes: file.payload.length,
      initAddress: file.initAddress === 0 ? file.loadAddress : file.initAddress, playAddress: file.playAddress, sidCount: ir.sidCount, clock: file.clock, models: [...file.sidModels],
    },
  };
  return {
    schema: ANALYSIS_SCHEMA,
    source: { kind: "sid", sha256: sha256(sidBytes), md5: md5(sidBytes), song, title: file.name, author: file.author, released: file.released },
    horizon: { seconds, calls: ir.calls.length, clock: trace.clock, song },
    reconstruction: summariseReconstruction(rec, differing),
    ...(parts ? { key: parts.key, metre: parts.metre, form: parts.form } : {}),
    motifs: parts?.motifs ?? [],
    voices: voicesOf(parts?.voices ?? [], facts),
    techniques: techniquesFromIr(ir),
    resources,
    limits: [
      "Notes, key, metre, form, motifs and roles come from the SIDWave reconstruction of the tune within the horizon; they are inferred and are only as good as the reconstruction (see reconstruction).",
      "Techniques, voice register ranges and resources are observed in the register trace of the original tune within the horizon.",
      "The cycle figures are the span between the first and last SID write of a call; the engine does not report the CPU cycles of the player.",
      ...(musicError ? [`The reconstruction could not be used for musical facts (${musicError}); key, metre, form, motifs and voice roles are omitted.`] : []),
      ...(rec.unsupported.length ? [`The trace holds ${rec.unsupported.length} feature(s) the language cannot express (see sample playback and the reconstruction report); musical facts leave them out.`] : []),
    ],
  };
}

/** Voices of the reconstruction with their trace facts, plus the traced voices the reconstruction does not model (for example the second SID). */
function voicesOf(modelled: VoiceUse[], facts: Map<number, TraceVoiceFacts>): AnalysisReport["voices"] {
  const out: AnalysisReport["voices"] = modelled.map((v) => ({ ...v, ...(facts.has(v.voice) ? { trace: facts.get(v.voice)! } : {}) }));
  const have = new Set(modelled.map((v) => v.voice));
  for (const [voice, trace] of [...facts].sort((a, b) => a[0] - b[0])) {
    if (have.has(voice) || (trace.gateShare === 0 && !trace.frequencyRange)) continue;
    out.push({
      voice, sid: Math.floor((voice - 1) / 3), noteCount: 0, percussionCount: 0, notesPerSecond: 0, soundingShare: trace.gateShare,
      role: { basis: "inferred", method: "the reconstruction does not model this voice, so no role is derived", value: "unreconstructed" }, trace,
    });
  }
  return out.sort((a, b) => a.voice - b.voice);
}

function summariseReconstruction(rec: ReconstructReport, differing: number): NonNullable<AnalysisReport["reconstruction"]> {
  return { basis: "observed", strictExact: rec.strictExact, registerStateExact: rec.registerStateExact, notes: rec.recovery.noteCount, instruments: rec.recovery.instrumentCount, differingCalls: differing };
}

// ---- text ----------------------------------------------------------------------------------------------------------

const tag = (m: Marked): string => (m.basis === "observed" ? "[observed]" : `[inferred: ${m.method ?? "model"}]`);

/** The report as text for a terminal. */
export function formatAnalysis(report: AnalysisReport): string {
  const L: string[] = [];
  const src = report.source;
  L.push(`${src.kind === "sid" ? "SID tune" : "Score"}${src.title ? ` "${src.title}"` : ""}${src.author ? ` by ${src.author}` : ""}, sha256 ${src.sha256.slice(0, 16)}`);
  if (report.horizon) L.push(`Horizon: ${report.horizon.seconds} s, ${report.horizon.calls} player calls, ${report.horizon.clock}, subtune ${report.horizon.song}`);
  if (report.reconstruction) {
    const r = report.reconstruction;
    L.push(`Reconstruction [observed]: strict ${r.strictExact ? "exact" : "not exact"}, register state ${r.registerStateExact ? "exact" : "differs"}, ${r.notes} notes, ${r.instruments} instruments`);
  }
  if (report.key) {
    const k = report.key;
    L.push(`Key ${tag(k)}: ${k.tonic} ${k.mode}, correlation ${k.correlation}, margin ${k.margin}, confidence ${k.confidence} (runner-up ${k.runnerUp.tonic} ${k.runnerUp.mode} ${k.runnerUp.correlation})`);
  } else L.push("Key: no pitched notes");
  const m = report.metre;
  if (m) {
    L.push(`Metre, declared ${tag(m.declared)}: ${m.declared.beatsPerBar} beats per bar at ${m.declared.tempoBpm} BPM`);
    L.push(`Metre, detected ${tag(m.detected)}: ${m.detected.beatsPerBar} beats per bar${m.detected.agrees ? " (agrees)" : " (differs)"}`);
  }
  const f = report.form;
  if (f) {
    L.push(`Form ${tag(f)}: ${f.barLabels.length} bars, ${f.distinctBars} distinct, ${Math.round(f.repeatShare * 100)}% repeat an earlier bar`);
    if (f.runs.length) L.push(`  bar labels: ${f.runs.length <= 40 ? f.runs.map((r) => (r.bars > 1 ? `${r.label}x${r.bars}` : r.label)).join(" ") : `${f.runs.slice(0, 40).map((r) => (r.bars > 1 ? `${r.label}x${r.bars}` : r.label)).join(" ")} ...`}`);
    for (const s of f.declaredSections) L.push(`  section "${s.name}" ${tag(s)}: bar ${s.startBar + 1}, ${s.bars} bars`);
    if (f.loop) L.push(`  loop ${tag(f.loop)}: from bar ${f.loop.startBar + 1}, period ${f.loop.periodBars} bars, ${f.loop.repeats} repeats`);
    if (f.declaredLoop) L.push(`  declared loop ${tag(f.declaredLoop)}: bar ${f.declaredLoop.startBar + 1}`);
  }
  L.push(`Motifs: ${report.motifs.length}`);
  for (const mo of report.motifs.slice(0, 8)) {
    L.push(`  ${mo.notes} notes, intervals ${mo.intervals.join(" ")}, rhythm ${mo.rhythm.join(" ")} calls, ${mo.occurrenceCount} times in voice ${mo.voices.join(",")} (first at bar ${mo.occurrences[0]!.bar + 1})`);
  }
  if (report.motifs.length) L.push(`  ${tag(report.motifs[0]!)}`);
  L.push("Voices:");
  for (const v of report.voices) {
    if (v.noteCount === 0 && !v.trace) continue;
    const range = v.range ? `${v.range.lowest}-${v.range.highest}` : "no pitched notes";
    L.push(`  voice ${v.voice}: role ${v.role.value} ${tag(v.role)}, ${v.noteCount} notes (${v.percussionCount} percussion), range ${range}, ${v.notesPerSecond} notes/s, sounding ${Math.round(v.soundingShare * 100)}%`);
    if (v.trace) L.push(`    trace [observed]: gate ${Math.round(v.trace.gateShare * 100)}% of calls, waveforms ${v.trace.waveforms.join("+") || "none"}${v.trace.frequencyRange ? `, ${v.trace.frequencyRange.lowest}-${v.trace.frequencyRange.highest}` : ""}`);
  }
  L.push(`Techniques: ${report.techniques.length}`);
  for (const t of report.techniques) {
    L.push(`  ${t.name} [observed, ${t.source}]${t.voices.length ? ` voices ${t.voices.join(",")}` : ""}: ${t.summary} ${JSON.stringify(t.evidence)}`);
  }
  L.push("Resources:");
  const r = report.resources;
  if (r.trace) L.push(`  trace [observed]: ${r.trace.calls} calls, ${r.trace.callsPerFrame} per frame, period ${r.trace.periodCycles} cycles, call span median ${r.trace.callSpanCycles.median} (p95 ${r.trace.callSpanCycles.p95}, max ${r.trace.callSpanCycles.max}) cycles, ${r.trace.writesPerCall.median} writes per call, ${r.trace.unsupportedWrites} non-periodic writes`);
  if (r.memory) L.push(`  memory [observed]: $${r.memory.loadAddress.toString(16).toUpperCase()}-$${r.memory.endAddress.toString(16).toUpperCase()} (${r.memory.bytes} bytes), init $${r.memory.initAddress.toString(16).toUpperCase()}, play $${r.memory.playAddress.toString(16).toUpperCase()}, ${r.memory.sidCount} SID, ${r.memory.clock}`);
  if (r.compiled) L.push(`  compiled ${tag(r.compiled)}: ${r.compiled.outputBytes} bytes, worst case ${r.compiled.worstCaseCyclesPerCall} cycles per call`);
  for (const l of report.limits) L.push(`Note: ${l}`);
  return `${L.join("\n")}\n`;
}
