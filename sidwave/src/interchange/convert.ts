// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The convert hub: detect, read, normalise, reduce (ScorePlan), write, and optionally verify by re-importing.

import { performance } from "node:perf_hooks";
import type { SidEmulation, SidEngine } from "../engine/types.js";
import { parseSidwave, type ParsedSidwave } from "../sidwave.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { UsageError } from "../cliCore.js";
import { InterchangeUsageError } from "./errors.js";
import { exportEvents, type ExportedScore } from "./events.js";
import { detectFormat, formatDefinitions, getFormat, resolveTarget, type Detection, type FormatDefinition } from "./registry.js";
import { groupLosses, maxSeverity, type Loss, type LossSeverity } from "./loss.js";
import { planScore, type ScorePlanResult } from "./scorePlan.js";

export interface ConvertOptions {
  /** Format id or alias of the input; default: detected. */
  from?: string;
  /** Format id or alias of the output, else taken from `outputName`. */
  to?: string;
  /** File names, used for extension hints and messages only. */
  inputName?: string;
  outputName?: string;
  /** Song, 1-based; default: the first song (a PSID: its start song). */
  song?: number;
  /** Voice limit; the smaller of it and the target's own limit applies. */
  voices?: number;
  grid?: number;
  mode?: "PAL" | "NTSC";
  title?: string;
  /** Seconds: the horizon of a reconstruct and the length of a WAV render. */
  seconds?: number;
  model?: "6581" | "8580";
  /** Re-import the output and compare it with the input score. */
  verify?: boolean;
  /** Onset tolerance of the verification, in seconds. Default 0.075. */
  onsetToleranceSeconds?: number;
  /** Options for reading a SIDWave score (sample files, imports). */
  readOptions?: SidwaveReadOptions;
  createEngine?: (emulation: SidEmulation) => SidEngine;
  signal?: AbortSignal;
  notice?: (message: string) => void;
}

export interface ConvertMetrics {
  /** False when the target cannot be read back, so no comparison is possible. */
  available: boolean;
  reason?: string;
  noteF1?: number;
  precision?: number;
  recall?: number;
  referenceNotes?: number;
  outputNotes?: number;
  /** Notes whose onset matches within the tolerance and whose pitch differs by whole octaves. */
  octaveShifted?: number;
  noteF1OctaveTolerant?: number;
  onsetError?: { meanMs: number; maxMs: number; matched: number };
  onsetToleranceMs?: number;
  voicesDropped?: number;
  instruments?: { used: number; mapped: number; unmapped: number };
  /** F-diff of a reconstruct source, when the input was a .sid. A1 is not computed by convert (see sidwave verify). */
  fdiff?: { equal: boolean; differingCalls: number; comparedCalls: number };
}

/** `eventsMs` is the event export that every exporter needs; the hub computes it once and hands it to the plan and the exporter, so it counts as a stage. */
export interface ConvertTimings { detectMs: number; readMs: number; parseMs: number; eventsMs: number; planMs: number; writeMs: number; verifyMs: number; totalMs: number; overheadMs: number }

export interface ConvertResult {
  from: string;
  to: string;
  detected: { format: string; confidence: number; by: string; candidates: Detection["candidates"]; warnings: string[]; viaFrom: boolean };
  chain: string[];
  /** The output file content. */
  output: Uint8Array;
  /** The intermediate score as SIDWave text. */
  score: string;
  /** Losses grouped by stage and code. */
  losses: Loss[];
  severity: LossSeverity;
  metrics?: ConvertMetrics;
  notices: string[];
  plan: Pick<ScorePlanResult, "voices" | "dropped" | "summary">;
  reports: { read?: unknown; write?: unknown };
  timings: ConvertTimings;
  /** Values the caller did not choose and the hub filled in. */
  defaults: Record<string, string | number>;
}

const now = (): number => performance.now();
const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits;

/** The message of an input that cannot be classified, with the exact fix. */
export function ambiguityMessage(name: string, detection: Detection): string {
  if (detection.candidates.length === 0) {
    return `cannot tell the format of ${name}: no known format matches its content or extension. Pass --from <format>; run "sidwave formats" for the list.`;
  }
  const list = detection.candidates.map((c) => `${c.id} (${c.confidence})`).join(", ");
  const fixes = detection.candidates.slice(0, 3).map((c) => `--from ${c.id}`).join(" or ");
  return `cannot tell the format of ${name} with confidence: candidates ${list}. Pass ${fixes}.`;
}

export function inputFormat(bytes: Uint8Array, options: ConvertOptions): { format: FormatDefinition; detection: Detection; viaFrom: boolean } {
  const name = options.inputName ?? "the input";
  const detection = detectFormat(bytes, options.inputName);
  if (options.from !== undefined) {
    const format = getFormat(options.from);
    return { format, detection: { ...detection, warnings: [] }, viaFrom: true };
  }
  if (detection.ambiguous || !detection.best) throw new InterchangeUsageError(ambiguityMessage(name, detection));
  return { format: getFormat(detection.best.id), detection, viaFrom: false };
}

function parseScore(yaml: string, options: ConvertOptions): ParsedSidwave {
  return parseSidwave(yaml, options.readOptions ?? {});
}

/** Detects, reads, plans and writes in memory. Does not touch the file system. */
export async function convert(bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConvertResult> {
  const t0 = now();
  const notices: string[] = [];
  const notice = (message: string): void => { notices.push(message); options.notice?.(message); };
  const target = resolveTarget(options.to, options.outputName);
  if (!target.write) throw new UsageError(`${target.id} cannot be written; the target formats are ${writable()}`);
  const detectStart = now();
  const { format: source, detection, viaFrom } = inputFormat(bytes, options);
  const detectMs = now() - detectStart;
  if (!source.read) {
    throw new InterchangeUsageError(`${source.id} cannot be read: ${source.lossSummary}. The readable formats are ${readable()}`);
  }
  if (source.id === target.id && !(source.id === "sidwave" || source.id === "midi" || source.id === "musicxml" || source.id === "goattracker" || source.id === "furnace")) {
    throw new InterchangeUsageError(`the input and the output are both ${source.id}; nothing to convert`);
  }
  const songNumber = options.song;
  if (songNumber !== undefined && (!Number.isInteger(songNumber) || songNumber < 1)) throw new UsageError(`--song is 1-based; ${songNumber} is not a song number`);
  if (songNumber !== undefined && songNumber > 1 && !source.songs) throw new UsageError(`--song ${songNumber}: ${source.name} holds one song; --song is 1-based`);

  // Read.
  const readStart = now();
  const read = await source.read(bytes, {
    name: options.inputName ?? "input",
    ...(songNumber === undefined ? {} : { song: songNumber }),
    ...(options.grid === undefined ? {} : { grid: options.grid }), ...(options.voices === undefined ? {} : { voices: options.voices }),
    ...(options.mode ? { mode: options.mode } : {}), ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    ...(options.createEngine ? { createEngine: options.createEngine } : {}), ...(options.signal ? { signal: options.signal } : {}), notice,
  });
  const readMs = now() - readStart;

  // Normalise: the score must parse as SIDWave.
  const parseStart = now();
  const doc = parseScore(read.yaml, options);
  const parseMs = now() - parseStart;
  // The song to export: imported sources have one song (the chosen subsong is already read); a score picks by --song.
  const song0 = source.id === "sidwave" && songNumber !== undefined ? songNumber - 1 : 0;
  if (doc.songs ? song0 >= doc.songs.length : song0 !== 0) {
    throw new InterchangeUsageError(`--song ${songNumber} does not exist; ${options.inputName ?? "the score"} has ${doc.songs?.length ?? 1} song${(doc.songs?.length ?? 1) === 1 ? "" : "s"}`);
  }

  // Reduce to the target's capabilities.
  const eventsStart = now();
  const events: ExportedScore = rangeToUsage(() => exportEvents(doc, { song: song0 }));
  const eventsMs = now() - eventsStart;
  const planStart = now();
  const plan = planScore(doc, target.caps, { song: song0, ...(options.voices === undefined ? {} : { voices: options.voices }) }, events);
  const planMs = now() - planStart;

  // Write.
  const writeStart = now();
  const written = await target.write!({
    doc, yaml: read.yaml, plan, song: song0,
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }), ...(options.model ? { model: options.model } : {}),
    ...(options.createEngine ? { createEngine: options.createEngine } : {}), ...(options.signal ? { signal: options.signal } : {}),
  });
  const writeMs = now() - writeStart;
  const output = typeof written.bytes === "string" ? new Uint8Array(Buffer.from(written.bytes, "utf8")) : written.bytes;

  const all: Loss[] = [...read.losses, ...plan.losses, ...written.losses];
  const chain = [`read:${source.id}`, "normalise", `plan:${target.id}`, `write:${target.id}`];
  let metrics: ConvertMetrics | undefined;
  let verifyMs = 0;
  if (options.verify) {
    const verifyStart = now();
    metrics = await verifyOutput(target, output, events, plan, options);
    if (read.fdiff) metrics.fdiff = read.fdiff;
    verifyMs = now() - verifyStart;
    chain.push(`verify:${target.id}`);
  }
  const totalMs = now() - t0;
  const grouped = groupLosses(all);
  return {
    from: source.id, to: target.id,
    detected: {
      format: source.id, confidence: viaFrom ? 1 : detection.best?.confidence ?? 0, by: viaFrom ? "--from" : detection.best?.by ?? "magic",
      candidates: detection.candidates, warnings: detection.warnings, viaFrom,
    },
    chain, output, score: read.yaml, losses: grouped, severity: maxSeverity(grouped),
    ...(metrics ? { metrics } : {}), notices,
    plan: { voices: plan.voices, dropped: plan.dropped, summary: plan.summary },
    reports: { ...(read.report === undefined ? {} : { read: read.report }), ...(written.report === undefined ? {} : { write: written.report }) },
    timings: {
      detectMs: round(detectMs), readMs: round(readMs), parseMs: round(parseMs), eventsMs: round(eventsMs), planMs: round(planMs), writeMs: round(writeMs), verifyMs: round(verifyMs), totalMs: round(totalMs),
      overheadMs: round(totalMs - readMs - parseMs - eventsMs - writeMs - verifyMs),
    },
    defaults: defaultsOf(options, source, target),
  };
}

function defaultsOf(options: ConvertOptions, source: FormatDefinition, target: FormatDefinition): Record<string, string | number> {
  const d: Record<string, string | number> = {};
  if (options.song === undefined) d.song = 1;
  if (options.voices === undefined) d.voices = target.caps.maxVoices ?? "all";
  if (options.grid === undefined && (source.id === "midi" || source.id === "musicxml")) d.grid = 0.25;
  if (options.mode === undefined) d.mode = "PAL";
  if (options.model === undefined && target.id === "wav") d.model = "6581";
  return d;
}

const writable = (): string => listIds((f) => f.write !== undefined);
const readable = (): string => listIds((f) => f.read !== undefined);
function listIds(pred: (f: FormatDefinition) => boolean): string { return formatDefinitions().filter(pred).map((f) => f.id).join(", "); }

function rangeToUsage<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof RangeError) throw new InterchangeUsageError(error.message);
    throw error;
  }
}

// ---- verification -------------------------------------------------------------------------------------------

interface Hit { time: number; pitch: number; drum?: boolean }

function noteList(score: ExportedScore): Hit[] {
  const out: Hit[] = [];
  for (const v of score.voices) for (const n of v.notes) out.push({ time: n.on.time, pitch: n.percussion ? -1 : n.pitch, ...(n.percussion ? { drum: true } : {}) });
  return out.sort((a, b) => a.time - b.time);
}

/** Greedy matching of two sorted note lists per key; returns matched pairs and the leftovers. */
function matchBy(ref: Hit[], out: Hit[], tol: number, key: (h: Hit) => number): { pairs: Array<[Hit, Hit]>; refLeft: Hit[]; outLeft: Hit[] } {
  const groups = new Map<number, Hit[]>();
  for (const h of out) { const k = key(h); const g = groups.get(k); if (g) g.push(h); else groups.set(k, [h]); }
  const pointer = new Map<number, number>();
  const used = new Set<Hit>();
  const pairs: Array<[Hit, Hit]> = [];
  const refLeft: Hit[] = [];
  for (const r of ref) {
    const g = groups.get(key(r));
    let j = pointer.get(key(r)) ?? 0;
    while (g && j < g.length && g[j]!.time < r.time - tol) j++;
    // g[j] is the first candidate not earlier than the window; skip used ones inside the window.
    let k = j;
    while (g && k < g.length && g[k]!.time <= r.time + tol && used.has(g[k]!)) k++;
    if (g && k < g.length && Math.abs(g[k]!.time - r.time) <= tol) { used.add(g[k]!); pairs.push([r, g[k]!]); if (k === j) j++; }
    else refLeft.push(r);
    pointer.set(key(r), j);
  }
  return { pairs, refLeft, outLeft: out.filter((h) => !used.has(h)) };
}

/** Note-level agreement of two scores: F1 on (pitch, onset within tolerance), onset error and octave shifts. */
export function compareNotes(reference: ExportedScore, output: ExportedScore, toleranceSeconds: number): Omit<ConvertMetrics, "available" | "voicesDropped" | "instruments" | "fdiff"> {
  const ref = noteList(reference), out = noteList(output);
  const exact = matchBy(ref, out, toleranceSeconds, (h) => h.pitch);
  // A drum hit of the reference is kept when any note starts at its time: trackers have no drum channel, so a hit
  // becomes a pitched note of a noise instrument, and only the pitch (a key of the drum kit) is not comparable.
  const drums = matchBy(exact.refLeft.filter((h) => h.drum), exact.outLeft, toleranceSeconds, () => 0);
  const refAfterDrums = exact.refLeft.filter((h) => !drums.pairs.some(([r]) => r === h));
  const outAfterDrums = exact.outLeft.filter((h) => !drums.pairs.some(([, o]) => o === h));
  const octave = matchBy(refAfterDrums, outAfterDrums, toleranceSeconds, (h) => (h.pitch < 0 ? -1 : h.pitch % 12));
  const f1Of = (matched: number): { p: number; r: number; f: number } => {
    const p = out.length ? matched / out.length : ref.length ? 0 : 1;
    const r = ref.length ? matched / ref.length : 1;
    return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0 };
  };
  const matchedPairs = [...exact.pairs, ...drums.pairs];
  const e = f1Of(matchedPairs.length);
  const o = f1Of(matchedPairs.length + octave.pairs.length);
  const errors = matchedPairs.map(([a, b]) => Math.abs(a.time - b.time) * 1000);
  const mean = errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : 0;
  return {
    noteF1: round(e.f), precision: round(e.p), recall: round(e.r), referenceNotes: ref.length, outputNotes: out.length,
    octaveShifted: octave.pairs.length, noteF1OctaveTolerant: round(o.f),
    onsetError: { meanMs: round(mean, 2), maxMs: round(errors.length ? Math.max(...errors) : 0, 2), matched: matchedPairs.length },
    onsetToleranceMs: round(toleranceSeconds * 1000, 1),
  };
}

async function verifyOutput(target: FormatDefinition, output: Uint8Array, reference: ExportedScore, plan: ScorePlanResult, options: ConvertOptions): Promise<ConvertMetrics> {
  const used = reference.instruments.length;
  const instruments = target.caps.instruments === "none" ? { used, mapped: 0, unmapped: used } : { used, mapped: used, unmapped: 0 };
  if (!target.read || target.readIsApproximate) {
    return { available: false, reason: target.read ? `reading ${target.id} is a reconstruct; use "sidwave verify" to compare compiled tunes` : `${target.id} cannot be read back`, voicesDropped: plan.dropped.length, instruments };
  }
  const read = await target.read(output, { name: `output.${target.id}`, validate: false, ...(options.mode ? { mode: options.mode } : {}), ...(options.grid === undefined ? {} : { grid: options.grid }) });
  const doc = parseScore(read.yaml, options);
  const again = exportEvents(doc, { song: 0 });
  return { available: true, ...compareNotes(reference, again, options.onsetToleranceSeconds ?? 0.075), voicesDropped: plan.dropped.length, instruments };
}
