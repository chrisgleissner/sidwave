// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SIDWave retargeting: PAL/NTSC, 6581/8580, SID count and resource budgets, with every change classified and measured.

import YAML from "yaml";
import { SidwaveValidationError, parseSidwave, type ParsedSidwave, type SidModel, type SystemMode } from "./sidwave.js";
import type { SidwaveReadOptions } from "./sidwavePcm.js";
import { formatSidwave } from "./format/sidwaveFormat.js";
import { compileSidwaveToPrg } from "./sidwaveCompiler.js";
import { retargetClock } from "./retarget/clock.js";
import { compareCutoffs, retargetModel, sourceModels, type CutoffDeviation } from "./retarget/model.js";
import { optimiseScore, type Budget, type Numbers, type OptimiseCandidate } from "./retarget/optimise.js";
import { retargetSids, type VoiceDecision } from "./retarget/sids.js";
import { compareTiming, measureScore, type ScoreMeasurement, type TimingComparison } from "./retarget/trace.js";
import { RetargetError, expandAliases, type RetargetChange } from "./retarget/types.js";

export { RetargetError } from "./retarget/types.js";
export type { ChangeClass, RetargetChange } from "./retarget/types.js";
export type { VoiceDecision } from "./retarget/sids.js";
export type { TimingComparison } from "./retarget/trace.js";
export type { CutoffDeviation } from "./retarget/model.js";
export type { OptimiseCandidate } from "./retarget/optimise.js";
export { compareTiming, compareTraces, measureScore } from "./retarget/trace.js";
export type { ScoreMeasurement, TraceDifference, TimingEvent } from "./retarget/trace.js";
export { convertCutoffUnits, cutoffRange, curveResolution } from "./retarget/model.js";
export { rankVoices } from "./retarget/sids.js";

export interface RetargetOptions {
  /** Video standard of the result. */
  clock?: "pal" | "ntsc" | "PAL" | "NTSC";
  /** SID model of every SID in the result. */
  model?: SidModel;
  /** Number of SIDs in the result. */
  sids?: number;
  /** Largest allowed worst-case cycles of one play call (measured on the bundled emulator). */
  budgetCycles?: number;
  /** Largest allowed PRG size in bytes. */
  budgetBytes?: number;
  /** Allow lossy optimisation steps when the music-preserving ones do not reach the budget. */
  allowChanges?: boolean;
  /** Options for reading sample files. */
  read?: SidwaveReadOptions;
}

export interface RetargetReport {
  /** `infeasible` when a budget could not be met; the text is then the best result reached. */
  verdict: "ok" | "infeasible";
  requested: { clock?: SystemMode; model?: SidModel; sids?: number; budgetCycles?: number; budgetBytes?: number; allowChanges: boolean };
  /** Rows of `changes` by class. `voicesDropped` counts the dropped voices, which are fewer than the rows of class dropped. Budget rows are not counted. */
  summary: { exact: number; approximate: number; dropped: number; voicesDropped: number };
  changes: RetargetChange[];
  /** What the register traces of source and result say about the clock step. */
  clock?: { from: SystemMode; to: SystemMode; timing: TimingComparison; basis: ScoreMeasurement["basis"] };
  model?: { from: SidModel[]; to: SidModel; cutoffs: CutoffDeviation | null };
  sids?: { from: number; to: number; voices: VoiceDecision[] };
  budget?: { cycles?: number; bytes?: number; candidates: OptimiseCandidate[]; lossyAvailable: boolean; best: Numbers };
  before: Numbers;
  after: Numbers;
  notes: string[];
}

export interface RetargetResult { text: string; report: RetargetReport }

function systemOf(value: string): SystemMode {
  const upper = value.toUpperCase();
  if (upper !== "PAL" && upper !== "NTSC") throw new RetargetError("input", `unknown clock "${value}"; use pal or ntsc`);
  return upper;
}

/** A video frame has 63 x 312 = 19656 cycles on PAL and 65 x 263 = 17095 on NTSC. */
function cycleNote(message: string, from: SystemMode, to: SystemMode): string {
  const match = /needs up to (\d+) cycles per call at speed (\d+) \((\d+) available/.exec(message);
  const direction = to === "NTSC" ? "13 % fewer cycles per frame than PAL" : "more cycles per frame than NTSC";
  return `a frame has 19656 cycles per frame on PAL (63 x 312) and 17095 on NTSC (65 x 263), so ${to} has ${direction}; moving from ${from} to ${to}, the player ${match ? `needs up to ${match[1]} cycles per call at speed ${match[2]}, ${match[3]} are available` : "no longer fits the cycles of one call"}`;
}

function describe(error: unknown): string {
  return error instanceof SidwaveValidationError ? `${error.path}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

const numbersOf = (m: ScoreMeasurement): Numbers => ({ bytes: m.bytes, cycles: m.cycles.worst, cyclesKind: m.cycles.kind });

/**
 * Retargets a SIDWave score. The steps run in a fixed order (clock, model, SID count, budgets) and every step is
 * verified by compiling the score before and after. The result is a formatted, valid SIDWave score and a report that
 * classifies every change as exact, approximate or dropped. Deterministic: the same input and options give the same
 * text and report.
 */
export function retargetSidwave(text: string, options: RetargetOptions = {}): RetargetResult {
  const read = options.read;
  if (options.sids !== undefined && (!Number.isInteger(options.sids) || options.sids < 1)) throw new RetargetError("input", "the SID count must be a whole number of at least 1");
  for (const [name, value] of [["cycle budget", options.budgetCycles], ["byte budget", options.budgetBytes]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RetargetError("input", `the ${name} must be a positive number`);
  }
  let source: ParsedSidwave;
  let sourceDoc: YAML.Document<any>;
  try {
    source = parseSidwave(text, read);
    sourceDoc = YAML.parseDocument(text, { version: "1.2" });
    if (sourceDoc.errors.length) throw new SidwaveValidationError("$", sourceDoc.errors[0]!.message);
  } catch (error) {
    throw new RetargetError("input", describe(error));
  }
  const doc = sourceDoc;
  expandAliases(doc);
  const changes: RetargetChange[] = [];
  const notes: string[] = [];
  const guard = <T>(step: string, fn: () => T): T => {
    try { return fn(); } catch (error) {
      if (error instanceof RetargetError) throw error;
      throw new RetargetError("unsupported", `the ${step} step produced a score that does not compile: ${describe(error)}`);
    }
  };
  /** Parses and compiles the working document; with `trace`, also measures it on the emulator. */
  const rebuild = (step: string, trace: boolean) => guard(step, () => {
    const parsed = parseSidwave(doc.toString(), read);
    if (trace) return { parsed, measurement: measureScore(parsed) };
    compileSidwaveToPrg(parsed);
    return { parsed, measurement: undefined };
  });

  const report: RetargetReport = {
    verdict: "ok",
    requested: {
      ...(options.clock ? { clock: systemOf(options.clock) } : {}), ...(options.model ? { model: options.model } : {}),
      ...(options.sids !== undefined ? { sids: options.sids } : {}), ...(options.budgetCycles !== undefined ? { budgetCycles: options.budgetCycles } : {}),
      ...(options.budgetBytes !== undefined ? { budgetBytes: options.budgetBytes } : {}), allowChanges: options.allowChanges === true,
    },
    summary: { exact: 0, approximate: 0, dropped: 0, voicesDropped: 0 }, changes, before: { bytes: 0, cycles: 0, cyclesKind: "measured" }, after: { bytes: 0, cycles: 0, cyclesKind: "measured" }, notes,
  };
  if (options.model !== undefined && options.model !== "6581" && options.model !== "8580") throw new RetargetError("input", `unknown model "${String(options.model)}"; use 6581 or 8580`);

  const first = guard("source", () => measureScore(source));
  report.before = numbersOf(first);
  let parsed = source;
  let measurement: ScoreMeasurement | undefined = first;

  if (options.clock) {
    const to = systemOf(options.clock);
    const from = source.song.mode;
    if (to === from) {
      changes.push({ step: "clock", construct: "mode", class: "exact", summary: `the score is already written for ${to}; no change needed` });
    } else {
      changes.push(...retargetClock(doc, parsed, from, to));
      let next;
      try { next = rebuild("clock", true); } catch (error) {
        // The other clock leaves fewer cycles per call: a score that needed the stock CPU may need a turbo CPU there.
        if (!(error instanceof RetargetError) || !/cpu: turbo/.test(error.message) || parsed.cpu === "turbo") throw error;
        doc.setIn(["cpu"], "turbo");
        changes.push({
          step: "clock", construct: "cpu", class: "approximate", path: "/cpu", before: "stock", after: "turbo",
          summary: `${cycleNote(error.message, from, to)}; the score now declares cpu: turbo and needs a turbo-capable machine (U64 or C64 Ultimate turbo registers)`,
        });
        next = rebuild("clock", true);
      }
      const timing = compareTiming(first, next.measurement!);
      const seconds = (m: ScoreMeasurement) => m.durationSeconds;
      const kinds = Object.entries(timing.perKind);
      changes.push({
        step: "clock", construct: "timing", class: timing.worstMs < 1e-6 && timing.unpaired === 0 ? "exact" : "approximate", errorMs: timing.worstMs,
        summary: `measured on the ${next.measurement!.basis}, events matched by order within each voice and kind, only where the event counts are equal: ${kinds.map(([kind, k]) => `${kind} ${k.timing === "measured" ? `${k.paired} pairs, worst ${k.worstMs!.toFixed(1)} ms, 95th percentile ${k.p95Ms!.toFixed(1)} ms` : "timing: not measured"}${k.mismatches.length ? ` (${k.mismatches.length} voice(s) with different event counts, not measured: ${k.mismatches.slice(0, 4).map((m) => `voice ${m.voice + 1} ${m.before} vs ${m.after}`).join(", ")}${k.mismatches.length > 4 ? ", ..." : ""})` : ""}`).join("; ")}; duration ${first.durationSeconds.toFixed(2)} s became ${next.measurement!.durationSeconds.toFixed(2)} s`,
        measured: {
          worstMs: Number(timing.worstMs.toFixed(3)), meanMs: Number(timing.meanMs.toFixed(3)), paired: timing.paired, unmatched: timing.unpaired,
          ...Object.fromEntries(kinds.flatMap(([kind, k]) => [[`${kind}_worstMs`, k.worstMs === null ? null : Number(k.worstMs.toFixed(3))], [`${kind}_p95Ms`, k.p95Ms === null ? null : Number(k.p95Ms.toFixed(3))], [`${kind}_pairs`, k.paired], [`${kind}_unmatched`, k.unmatched], [`${kind}_timing`, k.timing]])),
        },
      });
      report.clock = { from, to, timing, basis: next.measurement!.basis };
      parsed = next.parsed;
      measurement = next.measurement;
    }
  }

  if (options.model) {
    const sources = sourceModels(parsed);
    const before = measurement ?? measureScore(parsed);
    changes.push(...guard("model", () => retargetModel(doc, parsed, options.model!)));
    const next = rebuild("model", true);
    const legacy = doc.has("song");
    const cutoffs = legacy ? null : compareCutoffs(before, next.measurement!, sources, options.model) ?? null;
    if (cutoffs && cutoffs.samples > 0 && sources.some((model) => model !== options.model)) {
      changes.push({
        step: "model", construct: "cutoff-trace", class: cutoffs.worstSteps <= 1 && cutoffs.worstHz < 1 ? "exact" : "approximate",
        summary: `measured over ${cutoffs.samples} filter cutoff writes of the register trace: worst deviation ${cutoffs.worstHz.toFixed(0)} Hz (${cutoffs.worstCents.toFixed(0)} cents), median ${cutoffs.medianCents.toFixed(0)} cents, ${cutoffs.worstSteps.toFixed(1)} register step(s) of the target curve at the worst point`,
        measured: { samples: cutoffs.samples, worstHz: Math.round(cutoffs.worstHz), worstCents: Math.round(cutoffs.worstCents), medianCents: Math.round(cutoffs.medianCents), worstSteps: Number(cutoffs.worstSteps.toFixed(2)) },
      });
    }
    report.model = { from: sources, to: options.model, cutoffs };
    parsed = next.parsed;
    measurement = next.measurement;
  }

  if (options.sids !== undefined) {
    const fromCount = parsed.sids.length;
    const snapshot = doc.toString();
    const run = (digis: "remap" | "drop") => {
      const result = guard("sids", () => retargetSids(doc, parsed, options.sids!, { digis }));
      try { return { result, built: rebuild("sids", false) }; } catch (error) {
        if (error instanceof RetargetError && digis === "remap" && (parsed.samples || parsed.digiVoices?.length) && options.sids! < fromCount) return error;
        throw error;
      }
    };
    let attempt = run("remap");
    if (attempt instanceof RetargetError) {
      doc.contents = YAML.parseDocument(snapshot, { version: "1.2" }).contents as any;
      notes.push(`The digi voices could not move to a remaining SID (${attempt.message}); they were dropped instead.`);
      attempt = run("drop") as Exclude<ReturnType<typeof run>, RetargetError>;
    }
    const { result, built } = attempt as { result: ReturnType<typeof retargetSids>; built: { parsed: ParsedSidwave; measurement: ScoreMeasurement | undefined } };
    changes.push(...result.changes);
    report.sids = { from: fromCount, to: Math.min(options.sids, fromCount), voices: result.voices };
    parsed = built.parsed;
    measurement = built.measurement;
  }

  if (options.budgetCycles !== undefined || options.budgetBytes !== undefined) {
    const budget: Budget = { ...(options.budgetCycles !== undefined ? { cycles: options.budgetCycles } : {}), ...(options.budgetBytes !== undefined ? { bytes: options.budgetBytes } : {}) };
    const result = guard("budget", () => optimiseScore(doc, budget, { allowChanges: options.allowChanges === true, read }));
    changes.push(...result.changes);
    report.budget = { ...budget, candidates: result.candidates, lossyAvailable: result.lossyAvailable, best: result.after };
    report.verdict = result.verdict;
    if (result.verdict === "infeasible") notes.push("The budget could not be met; the text is the best result reached and does not fit.");
    parsed = parseSidwave(doc.toString(), read);
    measurement = undefined;
  }

  const out = guard("format", () => {
    const formatted = formatSidwave(doc.toString());
    const reparsed = parseSidwave(formatted, read);
    if (!compileSidwaveToPrg(reparsed).prg.equals(compileSidwaveToPrg(parsed).prg)) throw new RetargetError("unsupported", "internal: formatting changed the compiled score");
    return { formatted };
  });
  report.after = numbersOf(measurement ?? guard("result", () => measureScore(parsed)));
  for (const change of changes) if (change.construct !== "budget") report.summary[change.class]++;
  report.summary.voicesDropped = report.sids?.voices.filter((voice) => voice.decision === "dropped").length ?? 0;
  if (report.summary.approximate + report.summary.dropped === 0) notes.push("The result plays the same as the source on the target; nothing was approximated or dropped.");
  return { text: out.formatted, report };
}

export type { SidwaveReadOptions };
