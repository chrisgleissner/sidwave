// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Resource optimisation: music-preserving steps first (verified by the register trace), lossy steps only on request.

import YAML from "yaml";
import { parseSidwave, type ParsedSidwave } from "../sidwave.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { arrangeSidwave } from "../sidwaveCompiler.js";
import { compareTraces, measureScore, type ScoreMeasurement } from "./trace.js";
import { editKeys, layerHolders } from "./sids.js";
import { isObject, type AnyDoc, type RetargetChange } from "./types.js";

export interface Budget { cycles?: number; bytes?: number }
export interface Numbers { bytes: number; cycles: number; cyclesKind: "measured" | "estimated" }

export interface OptimiseCandidate {
  name: string;
  lossless: boolean;
  applied: boolean;
  /** Why a candidate was not applied. */
  reason?: string;
}

export interface OptimiseResult {
  changes: RetargetChange[];
  verdict: "ok" | "infeasible";
  before: Numbers;
  after: Numbers;
  candidates: OptimiseCandidate[];
  /** True when lossy steps exist that `allowChanges` would have applied. */
  lossyAvailable: boolean;
}

const numbers = (m: ScoreMeasurement): Numbers => ({ bytes: m.bytes, cycles: m.cycles.worst, cyclesKind: m.cycles.kind });
const met = (m: ScoreMeasurement, budget: Budget) =>
  (budget.bytes === undefined || m.bytes <= budget.bytes) && (budget.cycles === undefined || m.cycles.worst <= budget.cycles);

interface Built { text: string; parsed: ParsedSidwave; measurement: ScoreMeasurement }

function build(doc: AnyDoc, read?: SidwaveReadOptions): Built {
  const text = doc.toString();
  const parsed = parseSidwave(text, read);
  return { text, parsed, measurement: measureScore(parsed) };
}

const clone = (doc: AnyDoc): AnyDoc => YAML.parseDocument(doc.toString(), { version: "1.2" });

const COPY_KEYS = ["echo", "unison", "follow"];

/** Deletes a voice and its references in sections and timelines. Returns false when another voice depends on it. */
function removeVoice(doc: AnyDoc, parsed: ParsedSidwave, id: number): boolean {
  const js = doc.toJS() as any;
  const voices: any[] = js.voices ?? [];
  if (voices.some((voice) => isObject(voice) && COPY_KEYS.some((key) => isObject(voice[key]) && voice[key].voice === id))) return false;
  let at = -1;
  let seen = -1;
  voices.forEach((voice, i) => {
    if (isObject(voice) && voice.digi === undefined && parsed.voices[++seen]?.id === id) at = i;
  });
  if (at < 0) return false;
  doc.deleteIn(["voices", at]);
  for (const path of layerHolders(js)) {
    const field = String(path[path.length - 1]);
    if (field === "layers" || field === "levels") editKeys(doc, path, (key) => key === `v${id}`, (key) => key);
  }
  return true;
}

/** Number of calls per second changes with `speed`; `calls` steps keep their duration when scaled. */
function scaleCalls(doc: AnyDoc, factor: number): void {
  const js = doc.toJS() as any;
  for (const [name, inst] of Object.entries<any>(js.instruments ?? {})) {
    if (!isObject(inst)) continue;
    const tables: Array<[Array<string | number>, any[]]> = [];
    if (Array.isArray(inst.wavetable)) tables.push([["instruments", name, "wavetable"], inst.wavetable]);
    for (const key of ["pulsetable", "filtertable"]) {
      const table = inst[key];
      if (Array.isArray(table)) tables.push([["instruments", name, key], table]);
      else if (isObject(table) && Array.isArray(table.steps)) tables.push([["instruments", name, key, "steps"], table.steps]);
    }
    for (const [base, steps] of tables) {
      steps.forEach((step, i) => {
        if (isObject(step) && typeof step.calls === "number") doc.setIn([...base, i, "calls"], Math.max(1, Math.min(255, Math.round(step.calls * factor))));
      });
    }
  }
}

/** Tables with more than `minimum` steps: [path, step count] pairs. */
function tables(doc: AnyDoc, minimum: number): Array<{ path: Array<string | number>; steps: number; instrument: string; kind: string }> {
  const js = doc.toJS() as any;
  const found: Array<{ path: Array<string | number>; steps: number; instrument: string; kind: string }> = [];
  for (const [name, inst] of Object.entries<any>(js.instruments ?? {})) {
    if (!isObject(inst)) continue;
    for (const kind of ["wavetable", "pulsetable", "filtertable"]) {
      const table = inst[kind];
      const list = Array.isArray(table) ? table : isObject(table) && Array.isArray(table.steps) ? table.steps : undefined;
      if (list && list.length > minimum) found.push({ path: Array.isArray(table) ? ["instruments", name, kind] : ["instruments", name, kind, "steps"], steps: list.length, instrument: name, kind });
    }
  }
  return found.sort((a, b) => b.steps - a.steps || a.instrument.localeCompare(b.instrument) || a.kind.localeCompare(b.kind));
}

function shortenTable(doc: AnyDoc, entry: { path: Array<string | number>; steps: number; kind: string; instrument: string }): number {
  const keep = Math.ceil(entry.steps / 2);
  const node = doc.getIn(entry.path, true);
  if (!YAML.isSeq(node)) return entry.steps;
  node.items = node.items.slice(0, keep);
  // A loop index at or beyond the new end loops to the last step.
  const holderPath = entry.path.slice(0, entry.path[entry.path.length - 1] === "steps" ? -1 : entry.path.length);
  const loopPaths: Array<Array<string | number>> = [[...holderPath, "loop"], ["instruments", entry.instrument, "loop"]];
  for (const path of loopPaths) {
    const loop = doc.getIn(path);
    if (typeof loop === "number" && loop >= keep) doc.setIn(path, keep - 1);
  }
  return keep;
}

/** Applies the edit to a copy of the document and builds it; the error message when it does not compile. */
function attempt(doc: AnyDoc, edit: (copy: AnyDoc) => boolean | void, read?: SidwaveReadOptions): { doc: AnyDoc; built: Built } | string {
  const copy = clone(doc);
  try {
    if (edit(copy) === false) return "the edit does not apply to this score";
    return { doc: copy, built: build(copy, read) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Brings the score within a byte and/or cycle budget. Steps that keep the register trace identical run first and are
 * kept only if the trace is identical and the result is smaller or cheaper. With `allowChanges`, lossy steps follow
 * in a fixed order (copy voices, multispeed, table length), each measured. Edits `doc` in place.
 */
export function optimiseScore(doc: AnyDoc, budget: Budget, options: { allowChanges?: boolean; read?: SidwaveReadOptions } = {}): OptimiseResult {
  const changes: RetargetChange[] = [];
  const candidates: OptimiseCandidate[] = [];
  const start = build(doc, options.read);
  const baseline = start.measurement;
  let current = start;
  const limit = (m: ScoreMeasurement) => `${budget.bytes !== undefined ? `${m.bytes} of ${budget.bytes} bytes` : ""}${budget.bytes !== undefined && budget.cycles !== undefined ? ", " : ""}${budget.cycles !== undefined ? `${m.cycles.worst} of ${budget.cycles} cycles` : ""}`;
  if (met(baseline, budget)) {
    changes.push({ step: "optimise", construct: "budget", class: "exact", summary: `the score is within the budget (${limit(baseline)}); nothing to optimise`, measured: { bytes: baseline.bytes, cycles: baseline.cycles.worst } });
    return { changes, verdict: "ok", before: numbers(baseline), after: numbers(baseline), candidates, lossyAvailable: false };
  }

  const accept = (name: string, next: { doc: AnyDoc; built: Built }, change: Omit<RetargetChange, "step" | "construct"> & { construct?: string }) => {
    doc.contents = next.doc.contents as any;
    current = next.built;
    changes.push({ step: "optimise", construct: name, ...change });
  };

  // Lossless candidates, in a fixed order. A candidate stays only when the trace equals the source trace.
  const lossless: Array<{ name: string; summary: string; edit: (copy: AnyDoc) => boolean | void }> = [
    {
      name: "enable-stream-subroutines", summary: "set sidwave: 1.2 so that identical stream runs are shared as subroutines",
      edit: (copy) => {
        const js = copy.toJS() as any;
        if (js.song !== undefined || js.sidwave === undefined || !["1", "1.0", "1.1"].includes(String(js.sidwave))) return false;
        copy.setIn(["sidwave"], 1.2);
      },
    },
    {
      name: "drop-unused-samples", summary: "remove digi sample definitions that no trigger or digi voice plays",
      edit: (copy) => {
        const js = copy.toJS() as any;
        const defs = js.samples?.defs;
        if (!isObject(defs)) return false;
        const parsed = parseSidwave(js);
        const used = new Set<string>([...(parsed.samples?.triggers ?? []).map((t) => t.name)]);
        // Names played by digi voices appear in their patterns; a sample the arrangement plays is recorded in its commands.
        const arrangement = arrangeSidwave(parsed);
        for (const command of arrangement.samples?.commands ?? []) if (command.name) used.add(command.name);
        const unused = Object.keys(defs).filter((name) => !used.has(name));
        if (!unused.length) return false;
        for (const name of unused) copy.deleteIn(["samples", "defs", name]);
      },
    },
    {
      name: "drop-silent-voices", summary: "remove voices that never sound a note",
      edit: (copy) => {
        const js = copy.toJS() as any;
        const parsed = parseSidwave(js);
        const arrangement = arrangeSidwave(parsed);
        const owners = new Set(parsed.sids.map((sid) => sid.filter?.owner).filter((id): id is number => id !== undefined));
        const silent = parsed.voices.filter((voice) => !voice.center && !owners.has(voice.id)
          && !(arrangement.voices[parsed.voiceSlots.get(voice.id)!]?.notes ?? []).some((note) => !note.hidden)).map((voice) => voice.id);
        let removed = 0;
        for (const id of silent.reverse()) if (removeVoice(copy, parsed, id)) removed++;
        return removed > 0;
      },
    },
  ];
  for (const step of lossless) {
    if (met(current.measurement, budget)) { candidates.push({ name: step.name, lossless: true, applied: false, reason: "budget already met" }); continue; }
    const result = attempt(doc, step.edit, options.read);
    if (typeof result === "string") { candidates.push({ name: step.name, lossless: true, applied: false, reason: result }); continue; }
    const difference = compareTraces(baseline, result.built.measurement);
    const identical = result.built.measurement.digest === baseline.digest;
    const smaller = result.built.measurement.bytes < current.measurement.bytes || result.built.measurement.cycles.worst < current.measurement.cycles.worst;
    if (!identical) { candidates.push({ name: step.name, lossless: true, applied: false, reason: `the register trace changes${difference ? ` (${difference.differing} of ${difference.compared} calls)` : ""}` }); continue; }
    if (!smaller) { candidates.push({ name: step.name, lossless: true, applied: false, reason: "no byte or cycle gain" }); continue; }
    const before = current.measurement;
    accept(step.name, result, {
      class: "exact", summary: `${step.summary}: ${before.bytes} to ${result.built.measurement.bytes} bytes, ${before.cycles.worst} to ${result.built.measurement.cycles.worst} cycles, ${result.built.measurement.basis} identical`,
      measured: { bytesBefore: before.bytes, bytesAfter: result.built.measurement.bytes, cyclesBefore: before.cycles.worst, cyclesAfter: result.built.measurement.cycles.worst, traceIdentical: true, basis: result.built.measurement.basis },
    });
    candidates.push({ name: step.name, lossless: true, applied: true });
  }

  // Lossy steps.
  let lossyAvailable = false;
  const lossy = (name: string, next: { doc: AnyDoc; built: Built }, summary: string, kind: "approximate" | "dropped", extra: Record<string, number | string | boolean | null> = {}) => {
    const before = current.measurement;
    const difference = compareTraces(baseline, next.built.measurement);
    accept(name, next, {
      class: kind, summary: `${summary}: ${before.bytes} to ${next.built.measurement.bytes} bytes, ${before.cycles.worst} to ${next.built.measurement.cycles.worst} cycles${difference ? `; ${difference.differing} of ${difference.compared} play calls now write different registers (${(difference.fraction * 100).toFixed(1)}%)` : ""}`,
      measured: {
        bytesBefore: before.bytes, bytesAfter: next.built.measurement.bytes, cyclesBefore: before.cycles.worst, cyclesAfter: next.built.measurement.cycles.worst,
        differingCalls: difference?.differing ?? null, comparedCalls: difference?.compared ?? null, ...extra,
      },
    });
  };
  const lossyPlan = (): boolean => {
    // 1. Copies (echo, unison, follow), least sounding first.
    const parsed = current.parsed;
    const arrangement = arrangeSidwave(parsed);
    const candidatesCopies = parsed.voices.filter((voice) => voice.echo || voice.unison || voice.follow).map((voice) => ({
      id: voice.id,
      seconds: (arrangement.voices[parsed.voiceSlots.get(voice.id)!]?.notes ?? []).reduce((sum, note) => sum + Math.max(0, note.end - note.start), 0) / arrangement.fps,
      kind: voice.echo ? "echo" : voice.unison ? "unison" : "follow",
    })).sort((a, b) => a.seconds - b.seconds || b.id - a.id);
    if (candidatesCopies.length) lossyAvailable = true;
    if (!options.allowChanges) return false;
    for (const copy of candidatesCopies) {
      if (met(current.measurement, budget)) return true;
      const result = attempt(doc, (d) => removeVoice(d, current.parsed, copy.id), options.read);
      if (typeof result === "string") { candidates.push({ name: `drop-copy-voice-${copy.id}`, lossless: false, applied: false, reason: result }); continue; }
      lossy(`drop-${copy.kind}-copy`, result, `${copy.kind} copy voice ${copy.id} dropped (${copy.seconds.toFixed(1)} s sounding)`, "dropped", { voice: copy.id });
      candidates.push({ name: `drop-copy-voice-${copy.id}`, lossless: false, applied: true });
    }
    // 2. Multispeed.
    while (!met(current.measurement, budget) && current.parsed.speed > 1) {
      lossyAvailable = true;
      const from = current.parsed.speed;
      const result = attempt(doc, (d) => { d.setIn(["speed"], from - 1); scaleCalls(d, (from - 1) / from); }, options.read);
      if (typeof result === "string") { candidates.push({ name: `reduce-speed-${from}`, lossless: false, applied: false, reason: result }); break; }
      lossy("reduce-multispeed", result, `speed ${from} reduced to ${from - 1} (${(from - 1) / from * 100}% of the calls per second)`, "approximate", { speedBefore: from, speedAfter: from - 1 });
      candidates.push({ name: `reduce-speed-${from}`, lossless: false, applied: true });
    }
    // 3. Tables, longest first, each cut to half its steps.
    for (let guard = 0; guard < 64 && !met(current.measurement, budget); guard++) {
      const next = tables(doc, 3)[0];
      if (!next) break;
      lossyAvailable = true;
      const result = attempt(doc, (d) => { shortenTable(d, next); }, options.read);
      if (typeof result === "string") { candidates.push({ name: `shorten-${next.instrument}.${next.kind}`, lossless: false, applied: false, reason: result }); break; }
      lossy("shorten-table", result, `${next.instrument}.${next.kind} cut from ${next.steps} to ${Math.ceil(next.steps / 2)} steps`, "approximate", { steps: next.steps });
      candidates.push({ name: `shorten-${next.instrument}.${next.kind}`, lossless: false, applied: true });
    }
    return met(current.measurement, budget);
  };
  if (!met(current.measurement, budget)) lossyPlan();
  if (!options.allowChanges && !met(current.measurement, budget)) {
    // Report which lossy steps exist without applying them.
    if (tables(doc, 3).length > 0 || current.parsed.speed > 1) lossyAvailable = true;
  }

  const ok = met(current.measurement, budget);
  const after = current.measurement;
  changes.push(ok
    ? { step: "optimise", construct: "budget", class: "exact", summary: `within the budget: ${limit(after)}`, measured: { bytes: after.bytes, cycles: after.cycles.worst } }
    : {
      step: "optimise", construct: "budget", class: "exact",
      summary: `infeasible: the best result is ${limit(after)}${options.allowChanges ? "" : lossyAvailable ? "; lossy steps exist and are applied only with --allow-changes" : ""}`,
      measured: { bytes: after.bytes, cycles: after.cycles.worst },
    });
  return { changes, verdict: ok ? "ok" : "infeasible", before: numbers(baseline), after: numbers(after), candidates, lossyAvailable };
}
