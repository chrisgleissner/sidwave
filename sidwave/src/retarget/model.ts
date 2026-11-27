// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// 6581 <-> 8580 retargeting: filter cutoffs through the two nominal curves, combined waveforms and digis reported.

import type { ParsedSidwave, SidModel } from "../sidwave.js";
import { cutoffHz, parseHz, resolveCutoff } from "../sidwaveFilterModel.js";
import { isObject, pointer, type AnyDoc, type RetargetChange } from "./types.js";
import type { ScoreMeasurement } from "./trace.js";

const COMBINED = /^(?:tri\+pulse|tri\+saw|saw\+pulse|tri\+saw\+pulse)$/i;

/** Lowest and highest cutoff a model reaches over the register range. */
export function cutoffRange(model: SidModel): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let code = 0; code <= 2047; code++) {
    const hz = cutoffHz(code, model);
    min = Math.min(min, hz);
    max = Math.max(max, hz);
  }
  return { min, max };
}

/** Largest Hz step between a register code and its neighbours: the resolution of the curve at that code. */
export function curveResolution(code: number, model: SidModel): number {
  const here = cutoffHz(code, model);
  return Math.max(Math.abs(cutoffHz(Math.max(0, code - 1), model) - here), Math.abs(cutoffHz(Math.min(2047, code + 1), model) - here));
}

/** Register code of `model` closest to `hz`, as the compiler resolves a cutoff written in Hz. */
export function unitsForHz(hz: number, model: SidModel): number {
  return resolveCutoff(`${hz.toFixed(3)}Hz`, model, "$");
}

export interface ModelConversion {
  units: number;
  /** Hz of the source value and Hz that the target model gives for the converted value. */
  fromHz: number;
  toHz: number;
  /** The Hz is outside what the target model can reach, so the nearest end of its curve is used. */
  clamped: boolean;
  /** Resolution of the target curve at the converted code. */
  resolutionHz: number;
}

/** Converts a register-unit cutoff from one model's curve to the other's, keeping the cutoff frequency. */
export function convertCutoffUnits(units: number, from: SidModel, to: SidModel): ModelConversion {
  const fromHz = cutoffHz(units, from);
  const range = cutoffRange(to);
  const target = unitsForHz(fromHz, to);
  const toHz = cutoffHz(target, to);
  return {
    units: target, fromHz, toHz, resolutionHz: curveResolution(target, to),
    clamped: fromHz > range.max + 0.5 || fromHz < range.min - 0.5,
  };
}

/** Models declared by the SIDs of a parsed score; an undeclared model counts as 8580, which is how the compiler resolves it. */
export function sourceModels(parsed: ParsedSidwave): SidModel[] {
  return parsed.sids.map((sid) => sid.model ?? "8580");
}

/**
 * Retargets the score to `to`: sets the model of every SID, converts absolute cutoffs given in register units, and
 * reports what stays approximate. Edits `doc` in place.
 */
export function retargetModel(doc: AnyDoc, parsed: ParsedSidwave, to: SidModel): RetargetChange[] {
  const changes: RetargetChange[] = [];
  const js = doc.toJS() as any;
  const sources = sourceModels(parsed);
  if (isObject(js.song)) {
    // A legacy document (song block) has no SID map and no filters: it cannot name a model and nothing depends on one.
    changes.push({
      step: "model", construct: "sids.model", class: "exact",
      summary: `the legacy document format has no sids or filter fields, so there is nothing to convert; it plays the same on a ${to}`,
    });
    return changes;
  }
  const declared = parsed.sids.some((sid) => sid.model !== undefined);
  const from = sources[0]!;
  if (new Set(sources).size > 1) {
    changes.push({
      step: "model", construct: "source-models", class: "approximate",
      summary: `the SIDs have different models (${sources.join(", ")}); register cutoffs of instruments, which all SIDs share, are converted from the model of the first SID (${from})`,
    });
  }

  // Cutoffs in register units.
  let converted = 0;
  let hzKept = 0;
  const convert = (path: Array<string | number>, value: unknown, construct: string) => {
    if (typeof value === "number") {
      if (from === to) return;
      const result = convertCutoffUnits(value, from, to);
      if (result.units !== value) doc.setIn(path, result.units);
      converted++;
      const errorHz = result.toHz - result.fromHz;
      changes.push({
        step: "model", construct, path: pointer(path), before: value, after: result.units,
        class: result.clamped || Math.abs(errorHz) > result.resolutionHz ? "approximate" : "exact",
        summary: `${construct} ${value} (${result.fromHz.toFixed(0)} Hz on the ${from}) became ${result.units} (${result.toHz.toFixed(0)} Hz on the ${to})${result.clamped ? `; the ${to} cannot reach ${result.fromHz.toFixed(0)} Hz, so the nearest end of its curve is used` : ""}`,
        measured: { fromHz: Math.round(result.fromHz), toHz: Math.round(result.toHz), errorHz: Math.round(Math.abs(errorHz)), resolutionHz: Math.round(result.resolutionHz), clamped: result.clamped },
      });
    } else if (typeof value === "string") {
      const hz = parseHz(value);
      if (hz === undefined) return;
      hzKept++;
      const range = cutoffRange(to);
      if (hz > range.max + 0.5 || hz < range.min - 0.5) {
        const used = hz > range.max ? range.max : range.min;
        changes.push({
          step: "model", construct, path: pointer(path), before: value, class: "approximate",
          summary: `${construct} ${value} is outside what the ${to} reaches (${range.min.toFixed(0)}-${range.max.toFixed(0)} Hz); the compiler uses ${used.toFixed(0)} Hz`,
          measured: { requestedHz: Math.round(hz), usedHz: Math.round(used), clamped: true },
        });
      }
    }
  };

  let deltas = 0;
  /**
   * A filter table: absolute cutoffs convert directly. An `add` step is converted by following the table's own
   * trajectory: the Hz reached after the step on the source curve is mapped to a register value of the target curve,
   * and the step becomes the difference to the previous target value. The Hz trajectory of one pass is then kept, and
   * rounding does not accumulate. A table that starts with an add has no known starting point and keeps its deltas.
   */
  const tableOf = (raw: any, base: Array<string | number>, sharedLoop: boolean) => {
    const steps = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.steps) ? raw.steps : undefined;
    const stepBase = Array.isArray(raw) ? base : [...base, "steps"];
    if (!steps) return;
    let source: number | undefined;
    let target: number | undefined;
    let converted = 0;
    let worstHz = 0;
    let worstRatio = 0;
    let clampHz = 0;
    let flattened = 0;
    const splits = new Map<number, Array<{ add: number; frames: number; key: string; plain?: boolean }>>();
    let clamped = false;
    steps.forEach((step: any, i: number) => {
      if (!isObject(step)) return;
      if (step.cutoff !== undefined) {
        convert([...stepBase, i, "cutoff"], step.cutoff, "filtertable.cutoff");
        const hz = typeof step.cutoff === "string" ? parseHz(step.cutoff) : undefined;
        if (typeof step.cutoff === "number") { source = step.cutoff; target = convertCutoffUnits(step.cutoff, from, to).units; }
        else if (hz !== undefined) { source = unitsForHz(hz, from); target = unitsForHz(hz, to); }
        else { source = undefined; target = undefined; }
      } else if (typeof step.add === "number") {
        if (source === undefined || target === undefined || from === to) { deltas++; return; }
        // `add` is applied on every frame (or call) of the step. Map the Hz at the start and at the end of the whole
        // step through the target curve and spread the code difference over the frames. A single integer add is used
        // when it ends within 3 % of the wanted frequency. Otherwise the step is split in two: r frames at a + sign
        // and the rest at a, which reaches the wanted code exactly.
        const key = typeof step.calls === "number" ? "calls" : "frames";
        const frames = typeof step.frames === "number" ? step.frames : typeof step.calls === "number" ? step.calls : 1;
        const endSource = Math.max(0, Math.min(2047, source + step.add * frames));
        const endHz = cutoffHz(endSource, from);
        const wanted = unitsForHz(endHz, to) - target;
        const clampCode = (code: number) => Math.max(0, Math.min(2047, code));
        let pieces: Array<{ add: number; frames: number }> = [{ add: Math.max(-2048, Math.min(2047, Math.round(wanted / frames))), frames }];
        const simpleEnd = cutoffHz(clampCode(target + pieces[0]!.add * frames), to);
        // A list-form table shares the instrument's `loop` with the wavetable and the pulse table, so it is never split.
        if (!sharedLoop && Math.abs(simpleEnd - endHz) > 0.03 * endHz && frames > 1) {
          const whole = Math.trunc(wanted / frames);
          const rest = wanted - whole * frames;
          const sign = Math.sign(rest);
          pieces = [{ add: whole + sign, frames: Math.abs(rest) }, { add: whole, frames: frames - Math.abs(rest) }].filter((piece) => piece.frames > 0);
        }
        // The real trajectory, frame by frame, against the source step.
        for (let k = 1; k <= frames; k++) {
          let code = target;
          let left = k;
          for (const piece of pieces) { const used = Math.min(left, piece.frames); code += piece.add * used; left -= used; }
          const sourceHz = cutoffHz(clampCode(source + step.add * k), from);
          const targetHz = cutoffHz(clampCode(code), to);
          worstHz = Math.max(worstHz, Math.abs(targetHz - sourceHz));
          worstRatio = Math.max(worstRatio, Math.abs(targetHz - sourceHz) / Math.max(sourceHz, 1));
        }
        const range = cutoffRange(to);
        if (endHz > range.max + 0.5 || endHz < range.min - 0.5) { clamped = true; clampHz = endHz > range.max ? range.max : range.min; }
        if (pieces.length === 2) {
          splits.set(i, pieces.map((piece, n) => n === 0 ? { ...piece, key } : { ...piece, key, plain: true }));
        } else {
          if (pieces[0]!.add === 0 && step.add !== 0) flattened++;
          if (pieces[0]!.add !== step.add) doc.setIn([...stepBase, i, "add"], pieces[0]!.add);
        }
        source = endSource;
        target = clampCode(target + pieces.reduce((sum, piece) => sum + piece.add * piece.frames, 0));
        converted++;
      }
    });
    if (splits.size > 0) {
      const current = (doc.getIn(stepBase, true) as any).toJSON() as any[];
      const rebuilt: any[] = [];
      const newIndex: number[] = [];
      current.forEach((step, i) => {
        newIndex[i] = rebuilt.length;
        const pieces = splits.get(i);
        if (!pieces) { rebuilt.push(step); return; }
        rebuilt.push({ ...step, add: pieces[0]!.add, [pieces[0]!.key]: pieces[0]!.frames });
        if (pieces[1]) rebuilt.push({ add: pieces[1].add, [pieces[1].key]: pieces[1].frames });
      });
      doc.setIn(stepBase, doc.createNode(rebuilt));
      // Only the table's own loop (object form) is remapped; a loop shared through the instrument is never moved.
      for (const path of Array.isArray(raw) ? [] : [[...base, "loop"]]) {
        const loop = doc.getIn(path);
        if (typeof loop === "number" && newIndex[loop] !== undefined) doc.setIn(path, newIndex[loop]);
      }
    }
    if (converted > 0) {
      changes.push({
        step: "model", construct: "filtertable.add", path: pointer(stepBase), class: "approximate",
        summary: `${converted} add step(s) of a filter table were recomputed from the frequencies at the start and end of each step on the ${to} curve; the largest difference along the converted steps is ${worstHz.toFixed(0)} Hz${clamped ? `, clamped at ${clampHz.toFixed(0)} Hz` : ` (${(worstRatio * 100).toFixed(1)} %)`}${splits.size ? `; ${splits.size} step(s) were split in two so that the integer add per frame reaches the wanted frequency` : ""}${flattened ? `; ${flattened} step(s) became add 0 because their change is below one register step per frame on the ${to} curve` : ""}; a loop that does not return to its start drifts differently`,
        measured: { steps: converted, worstHz: Math.round(worstHz), ...(clamped ? { clampHz: Math.round(clampHz) } : { worstPercent: Number((worstRatio * 100).toFixed(2)) }), flattened, split: splits.size, clamped },
      });
    }
  };
  for (const [name, inst] of Object.entries<any>(js.instruments ?? {})) {
    if (!isObject(inst)) continue;
    tableOf(inst.filtertable, ["instruments", name, "filtertable"], Array.isArray(inst.filtertable) && inst.loop !== undefined);
  }
  const envelopes: Array<[any, Array<string | number>]> = [
    [js.global_fx?.filter_env, ["global_fx", "filter_env"]],
    [js.song?.global_fx?.filter_env, ["song", "global_fx", "filter_env"]],
  ];
  const sidEntries = Array.isArray(js.sids) ? js.sids.map((sid: any, i: number) => [sid, ["sids", i]] as const)
    : Object.entries<any>(js.sids?.overrides ?? {}).map(([id, sid]) => [sid, ["sids", "overrides", id]] as const);
  for (const [sid, base] of sidEntries) {
    if (isObject(sid?.filter)) {
      envelopes.push([sid.filter.filter_env ?? (sid.filter.cutoff_base !== undefined ? sid.filter : undefined), sid.filter.filter_env ? [...base, "filter", "filter_env"] : [...base, "filter"]]);
      if (isObject(sid.filter.filter_env) && typeof sid.filter.filter_env.sweep === "number") deltas++;
    }
  }
  for (const [env, path] of envelopes) {
    if (!isObject(env)) continue;
    if (env.cutoff_base !== undefined) convert([...path, "cutoff_base"], env.cutoff_base, "filter_env.cutoff_base");
    if (typeof env.sweep === "number") deltas++;
  }
  const sectionFilters = (entries: any[]) => entries.filter(isObject).reduce((sum, entry) => sum + (isObject(entry.filter) ? Object.keys(entry.filter).length : 0), 0);
  deltas += sectionFilters(Object.values<any>(js.sections ?? {})) + sectionFilters(Array.isArray(js.timeline) ? js.timeline : []);
  if (hzKept > 0 && from !== to) {
    changes.push({
      step: "model", construct: "cutoff-hz", class: "exact",
      summary: `${hzKept} cutoff(s) written in Hz are kept; the compiler resolves them on the curve of the declared model`,
      measured: { count: hzKept },
    });
  }
  if (deltas > 0 && from !== to) {
    changes.push({
      step: "model", construct: "filter-deltas", class: "approximate",
      summary: `${deltas} filter sweep or offset value(s) are deltas in register units and are kept as written; the same delta spans a different frequency range on the ${to} curve (see the measured cutoff deviation)`,
      measured: { count: deltas },
    });
  }

  // Combined waveforms and the digi volume trick.
  if (from !== to) {
    const combined = new Set<string>();
    for (const [name, inst] of Object.entries<any>(js.instruments ?? {})) {
      if (!isObject(inst)) continue;
      const waves = [inst.waveform, inst.wave, ...(Array.isArray(inst.wavetable) ? inst.wavetable.map((step: any) => step?.wave) : [])];
      if (waves.some((wave) => typeof wave === "string" && COMBINED.test(wave))) combined.add(name);
    }
    for (const voice of js.voices ?? []) {
      if (isObject(voice) && typeof voice.waveform === "string" && COMBINED.test(voice.waveform)) combined.add(`voice ${voice.id ?? voice.name ?? "?"}`);
    }
    for (const name of [...combined].sort()) {
      changes.push({
        step: "model", construct: "combined-waveform", class: "approximate",
        summary: `${name} uses a combined waveform; combined waveforms are not the same on the ${from} and the ${to} (level, noise floor and pitch tracking differ) and cannot be measured without the chip`,
        measured: { instrument: name },
      });
    }
    if (parsed.samples || parsed.digiVoices?.length) {
      const names = [...(parsed.samples ? parsed.samples.defs.keys() : [])];
      changes.push({
        step: "model", construct: "digi-volume", class: "approximate",
        summary: `the CIA2 volume digis (${names.join(", ") || "digi voices"}) use the $D418 volume step trick, which is loud on a 6581 and much quieter on an 8580 without a DC offset; the level on the ${to} differs`,
        measured: { samples: names.join(",") },
      });
    }
  }

  // Declare the model.
  const ids = parsed.sids.map((sid) => sid.id);
  let setModel = 0;
  if (Array.isArray(js.sids)) {
    js.sids.forEach((sid: any, i: number) => { if (sid?.model !== to) { doc.setIn(["sids", i, "model"], to); setModel++; } });
  } else if (isObject(js.sids)) {
    for (const id of ids) if (js.sids.overrides?.[id]?.model !== to) { doc.setIn(["sids", "overrides", id, "model"], to); setModel++; }
  } else {
    doc.setIn(["sids"], doc.createNode([{ id: "sid1", address: "$D400", model: to }]));
    setModel = 1;
  }
  changes.push({
    step: "model", construct: "sids.model", class: "exact", before: declared ? sources.join(",") : "undeclared (8580 curve)", after: to,
    summary: `sids[].model is ${to} on ${ids.length} SID(s)${setModel === 0 ? " (already declared)" : ""}`,
  });
  return changes;
}

export interface CutoffDeviation {
  /** Calls whose cutoff register was compared. */
  samples: number;
  worstHz: number;
  /** Worst deviation as a frequency ratio in cents. */
  worstCents: number;
  /** Median deviation in cents over the compared cutoff writes. */
  medianCents: number;
  /** Worst deviation as a fraction of the resolution of the target curve at that point (above 1: more than one register step). */
  worstSteps: number;
}

function cutoffTrack(measurement: ScoreMeasurement): Array<Map<number, number>> | undefined {
  if (!measurement.songs) return undefined;
  return measurement.songs.map((song) => {
    const fc = new Map<number, number>();
    const timeline = new Map<number, number>();
    song.changes.forEach((call, index) => {
      let touched = false;
      for (let i = 0; i < call.length; i += 2) {
        const address = call[i]!;
        const chip = song.sids.findIndex((base) => address >= base && address < base + 0x20);
        if (chip < 0) continue;
        const offset = address - song.sids[chip]!;
        if (offset === 0x15) { fc.set(chip, ((fc.get(chip) ?? 0) & 0x7f8) | (call[i + 1]! & 7)); touched = true; }
        if (offset === 0x16) { fc.set(chip, ((fc.get(chip) ?? 0) & 7) | (call[i + 1]! << 3)); touched = true; }
      }
      if (touched) for (const [chip, value] of fc) timeline.set(index * 16 + chip, value);
    });
    return timeline;
  });
}

/** Compares the cutoff registers of two traces call by call, in Hz on each score's own model curve. */
export function compareCutoffs(before: ScoreMeasurement, after: ScoreMeasurement, from: SidModel[], to: SidModel): CutoffDeviation | undefined {
  const a = cutoffTrack(before);
  const b = cutoffTrack(after);
  if (!a || !b) return undefined;
  const result: CutoffDeviation = { samples: 0, worstHz: 0, worstCents: 0, medianCents: 0, worstSteps: 0 };
  const cents: number[] = [];
  a.forEach((x, song) => {
    const y = b[song];
    if (!y) return;
    for (const [key, source] of x) {
      const target = y.get(key);
      if (target === undefined) continue;
      const chip = key % 16;
      const model = from[chip] ?? from[0] ?? "8580";
      const hzA = cutoffHz(source, model);
      const hzB = cutoffHz(target, to);
      result.samples++;
      result.worstHz = Math.max(result.worstHz, Math.abs(hzA - hzB));
      if (hzA > 0 && hzB > 0) {
        const c = Math.abs(1200 * Math.log2(hzB / hzA));
        cents.push(c);
        result.worstCents = Math.max(result.worstCents, c);
      }
      result.worstSteps = Math.max(result.worstSteps, Math.abs(hzA - hzB) / Math.max(1, curveResolution(target, to)));
    }
  });
  cents.sort((x, y) => x - y);
  result.medianCents = cents.length ? cents[Math.floor(cents.length / 2)]! : 0;
  return result;
}
