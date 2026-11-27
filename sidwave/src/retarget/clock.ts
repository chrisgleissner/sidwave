// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// PAL <-> NTSC retargeting: keeps the real duration of every frame-based construct, rounded to whole frames.

import type { ParsedSidwave, SystemMode } from "../sidwave.js";
import { isModern } from "../sidwave.js";
import { sidwaveFrameRate } from "../sidwaveCompiler.js";
import { digiPeriod } from "../sidwaveDigi.js";
import { isObject, pointer, type AnyDoc, type RetargetChange } from "./types.js";

const CLOCK_HZ: Record<SystemMode, number> = { PAL: 985248, NTSC: 1022727 };

interface Limits { min: number; max: number }

/**
 * Scales the frame counts of one score from the video standard `from` to `to` so that every construct keeps its
 * duration in seconds, as far as whole frames allow. Edits `doc` in place and returns one change per converted value.
 */
export function retargetClock(doc: AnyDoc, parsed: ParsedSidwave, from: SystemMode, to: SystemMode): RetargetChange[] {
  const changes: RetargetChange[] = [];
  const js = doc.toJS() as any;
  const ratio = sidwaveFrameRate(to) / sidwaveFrameRate(from);
  const modern = isModern(parsed);
  const speed = parsed.speed;
  /** Seconds of one unit: a video frame in a modern document, a player call for `calls` steps (and in a pre-1.2 document). */
  const seconds = (system: SystemMode, perCall: boolean) => 1 / (sidwaveFrameRate(system) * (perCall || !modern ? speed : 1));

  const rewrite = (path: Array<string | number>, value: number, limits: Limits, construct: string, perCall = false, floor = false, forced?: number): number => {
    let next = forced ?? (value === 0 && limits.min === 0 ? 0 : floor ? Math.floor(value * ratio) : Math.round(value * ratio));
    const clamped = next > limits.max || next < limits.min;
    next = Math.max(limits.min, Math.min(limits.max, next));
    const errorMs = Math.abs(next * seconds(to, perCall) - value * seconds(from, perCall)) * 1000;
    if (next !== value) doc.setIn(path, next);
    changes.push({
      step: "clock", construct, path: pointer(path), before: value, after: next, errorMs,
      class: errorMs < 1e-6 ? "exact" : "approximate",
      summary: `${construct} ${value} ${perCall ? "calls" : "frames"} (${(value * seconds(from, perCall) * 1000).toFixed(1)} ms) became ${next} (${(next * seconds(to, perCall) * 1000).toFixed(1)} ms)${clamped ? `, clamped to ${limits.max}` : ""}`,
      ...(clamped ? { measured: { clamped: true } } : {}),
    });
    return next;
  };

  // Glides, bends and slides must arrive within their note, so they round down: the note itself keeps its length in
  // frames to within one frame, and a glide that is one frame shorter always fits.
  const FRAMES: Limits = { min: 1, max: 255 };
  const DELAY: Limits = { min: 0, max: 255 };

  const effects = (fx: any, base: Array<string | number>) => {
    if (!isObject(fx)) return;
    if (isObject(fx.vibrato)) {
      if (typeof fx.vibrato.delay === "number") rewrite([...base, "vibrato", "delay"], fx.vibrato.delay, DELAY, "vibrato.delay");
      if (typeof fx.vibrato.fade === "number") rewrite([...base, "vibrato", "fade"], fx.vibrato.fade, FRAMES, "vibrato.fade");
    }
    if (isObject(fx.slide) && typeof fx.slide.speed === "number") rewrite([...base, "slide", "speed"], fx.slide.speed, FRAMES, "slide.speed", false, true);
    if (isObject(fx.filter_mod)) filterMod(fx.filter_mod, [...base, "filter_mod"]);
  };
  const filterMod = (mod: any, path: Array<string | number>) => {
    if (typeof mod.frames === "number") rewrite([...path, "frames"], mod.frames, { min: 1, max: 65535 }, "filter_mod.frames");
    if (typeof mod.sweep === "string") {
      const match = /^(\s*[+-]?\d+(?:\.\d+)?\s*over\s+)(\d+(?:\.\d+)?)(\s*frames?\s*)$/i.exec(mod.sweep);
      if (match) {
        const next = Math.max(1, Math.round(Number(match[2]) * ratio));
        const errorMs = Math.abs(next * seconds(to, false) - Number(match[2]) * seconds(from, false)) * 1000;
        doc.setIn([...path, "sweep"], `${match[1]}${next}${match[3]}`);
        changes.push({
          step: "clock", construct: "filter_mod.sweep", path: pointer([...path, "sweep"]), before: mod.sweep, after: `${match[1]}${next}${match[3]}`,
          errorMs, class: errorMs < 1e-6 ? "exact" : "approximate",
          summary: `filter_mod sweep over ${match[2]} frames became ${next} frames`,
        });
      }
    }
  };

  /**
   * Table steps are converted by cumulative time: each step length is rounded together with the rounding error that the
   * steps before it left over, so the table as a whole stays within one frame of its original duration instead of
   * drifting by half a frame per step. The report gives the total drift of each table.
   */
  const table = (steps: any[], base: Array<string | number>, kind: "wavetable" | "pulsetable" | "filtertable") => {
    let carry = 0;
    let sourceSeconds = 0;
    let targetSeconds = 0;
    let clampedAny = false;
    let counted = 0;
    steps.forEach((step, i) => {
      if (!isObject(step)) return;
      const at = [...base, i];
      const perCall = typeof step.calls === "number";
      const key = perCall ? "calls" : "frames";
      const explicit = typeof step[key] === "number";
      const length: number = explicit ? step[key] : 1;
      const ideal = length * seconds(from, perCall) + carry;
      const raw = Math.round(ideal / seconds(to, perCall));
      const chosen = Math.max(1, Math.min(255, raw));
      clampedAny = clampedAny || chosen !== raw;
      // After a clamp the missing time is not made up by the following steps; it shows in the table's drift.
      carry = chosen !== raw ? 0 : ideal - chosen * seconds(to, perCall);
      sourceSeconds += length * seconds(from, perCall);
      targetSeconds += chosen * seconds(to, perCall);
      counted++;
      if (explicit) {
        rewrite([...at, key], length, FRAMES, `${kind}.${key}`, perCall, false, chosen);
        if (chosen !== raw) {
          const last = changes[changes.length - 1]!;
          last.measured = { clamped: true };
          last.summary += `, clamped to ${chosen} (a table step holds at most 255 frames)`;
        }
      }
      else if (chosen !== 1) {
        doc.setIn([...at, "frames"], chosen);
        const errorMs = Math.abs(chosen * seconds(to, false) - seconds(from, false)) * 1000;
        changes.push({
          step: "clock", construct: `${kind}.implicit-frame`, path: pointer([...at, "frames"]), before: 1, after: chosen, class: "approximate", errorMs,
          summary: `${kind} step without a duration (one frame) became ${chosen} frames so that the table keeps its total duration`,
        });
      }
      // `add` is a delta per step unit: keep the total change of the step.
      if (typeof step.add === "number" && chosen !== length) {
        const add = Math.max(-2048, Math.min(2047, Math.round(step.add * length / chosen)));
        if (add !== step.add) {
          doc.setIn([...at, "add"], add);
          changes.push({
            step: "clock", construct: `${kind}.add`, path: pointer([...at, "add"]), before: step.add, after: add, class: "approximate",
            summary: `${kind} add ${step.add} per unit over ${length} became ${add} over ${chosen}, total ${step.add * length} became ${add * chosen}`,
            measured: { totalBefore: step.add * length, totalAfter: add * chosen },
          });
        }
      }
    });
    if (counted > 0) {
      const driftMs = Math.abs(targetSeconds - sourceSeconds) * 1000;
      changes.push({
        step: "clock", construct: `${kind}.drift`, path: pointer(base), errorMs: driftMs, class: driftMs < 1e-6 ? "exact" : "approximate",
        summary: `${kind} of ${counted} step(s): total duration ${(sourceSeconds * 1000).toFixed(1)} ms became ${(targetSeconds * 1000).toFixed(1)} ms, drift ${driftMs.toFixed(1)} ms${clampedAny ? " (a step reached the 255 frame limit)" : ""}`,
        measured: { steps: counted, driftMs: Number(driftMs.toFixed(3)), clamped: clampedAny },
      });
    }
  };
  const registerTable = (raw: any, base: Array<string | number>, kind: "pulsetable" | "filtertable") => {
    if (Array.isArray(raw)) table(raw, base, kind);
    else if (isObject(raw) && Array.isArray(raw.steps)) table(raw.steps, [...base, "steps"], kind);
  };

  const instrumentFields = (inst: any, base: Array<string | number>) => {
    if (typeof inst.portamento === "number" && inst.portamento > 0) rewrite([...base, "portamento"], inst.portamento, { min: 1, max: 255 }, "portamento", false, true);
    effects({ vibrato: inst.vibrato, slide: inst.slide }, base);
    if (Array.isArray(inst.wavetable)) table(inst.wavetable, [...base, "wavetable"], "wavetable");
    registerTable(inst.pulsetable, [...base, "pulsetable"], "pulsetable");
    registerTable(inst.filtertable, [...base, "filtertable"], "filtertable");
  };
  for (const [name, inst] of Object.entries<any>(js.instruments ?? {})) if (isObject(inst)) instrumentFields(inst, ["instruments", name]);

  let arps = 0;
  (js.voices ?? []).forEach((voice: any, v: number) => {
    if (!isObject(voice)) return;
    for (const key of ["echo", "follow"]) {
      if (isObject(voice[key]) && typeof voice[key].delay === "number") {
        rewrite(["voices", v, key, "delay"], voice[key].delay, { min: key === "echo" ? 1 : 0, max: 65535 }, `${key}.delay`);
      }
    }
    for (const [name, pattern] of Object.entries<any>(voice.patterns ?? {})) {
      if (!isObject(pattern)) continue;
      const base = ["voices", v, "patterns", name];
      if (typeof pattern.frame_rate === "number") rewrite([...base, "frame_rate"], pattern.frame_rate, { min: 1, max: 50 }, "frame_rate");
      effects(pattern.fx, [...base, "fx"]);
      (Array.isArray(pattern.groove) ? pattern.groove : typeof pattern.groove === "string" ? [pattern.groove] : []).forEach((entry: any, i: number) => {
        const at = [...base, "groove", i];
        if (typeof entry === "string") {
          arps += (entry.match(/\w+@arp\b/g) ?? []).length;
          return;
        }
        if (!isObject(entry)) return;
        if (typeof entry.portamento === "number" && entry.portamento > 0) rewrite([...at, "portamento"], entry.portamento, { min: 1, max: 255 }, "groove.portamento", false, true);
        if (isObject(entry.bend) && typeof entry.bend.frames === "number") rewrite([...at, "bend", "frames"], entry.bend.frames, FRAMES, "bend.frames", false, true);
        if (typeof entry.gate_off === "number" && entry.gate_off > 0) rewrite([...at, "gate_off"], entry.gate_off, DELAY, "gate_off");
        if (typeof entry.chord === "string" && typeof entry.speed === "number") rewrite([...at, "speed"], entry.speed, FRAMES, "chord.speed");
        effects({ vibrato: entry.vibrato }, at);
      });
    }
  });
  if (arps > 0) {
    changes.push({
      step: "clock", construct: "groove.@arp", class: "approximate",
      summary: `${arps} chord arpeggio token(s) of the form Cm7@arp play one chord tone per player call, so their tone rate changes from ${sidwaveFrameRate(from).toFixed(2)} to ${sidwaveFrameRate(to).toFixed(2)} tones per second; a rate fixed to the call cannot be converted`,
      measured: { tokens: arps, rateBefore: Number(sidwaveFrameRate(from).toFixed(2)), rateAfter: Number(sidwaveFrameRate(to).toFixed(2)) },
    });
  }

  for (const holder of [["global_fx"], ["song", "global_fx"]]) {
    const fx = holder.reduce((node: any, key) => node?.[key], js);
    if (isObject(fx?.reverb_sim) && typeof fx.reverb_sim.delay_frames === "number") {
      rewrite([...holder, "reverb_sim", "delay_frames"], fx.reverb_sim.delay_frames, { min: 1, max: 50 }, "reverb_sim.delay_frames");
    }
  }
  const sids = Array.isArray(js.sids) ? js.sids.map((sid: any, i: number) => [sid, ["sids", i]] as const)
    : Object.entries<any>(js.sids?.overrides ?? {}).map(([id, sid]) => [sid, ["sids", "overrides", id]] as const);
  for (const [sid, base] of sids) if (isObject(sid?.filter?.filter_mod)) filterMod(sid.filter.filter_mod, [...base, "filter", "filter_mod"]);

  if (speed > 1) {
    changes.push({
      step: "clock", construct: "speed", class: "approximate",
      summary: `speed ${speed} is kept: the player makes ${speed} calls per video frame, so calls per second change from ${(speed * sidwaveFrameRate(from)).toFixed(2)} to ${(speed * sidwaveFrameRate(to)).toFixed(2)}; frame-based durations were converted, call-based ones (calls steps) too`,
      measured: { callsPerSecondBefore: Number((speed * sidwaveFrameRate(from)).toFixed(2)), callsPerSecondAfter: Number((speed * sidwaveFrameRate(to)).toFixed(2)) },
    });
  }
  if (parsed.samples && parsed.samples.rate) {
    const rate = parsed.samples.rate;
    const achieved = (system: SystemMode) => CLOCK_HZ[system] / digiPeriod(CLOCK_HZ[system], rate, 0);
    const before = achieved(from);
    const after = achieved(to);
    changes.push({
      step: "clock", construct: "samples.rate", class: Math.abs(before - after) < 1e-9 ? "exact" : "approximate",
      summary: `digi sample rate ${rate} Hz is kept in Hz; the CIA2 timer period (whole cycles) gives ${before.toFixed(2)} Hz on ${from} and ${after.toFixed(2)} Hz on ${to}`,
      measured: { achievedBefore: Number(before.toFixed(2)), achievedAfter: Number(after.toFixed(2)), errorHz: Number(Math.abs(after - before).toFixed(3)) },
    });
  }

  // Declared mode.
  const modePath = isObject(js.song) ? ["song", "mode"] : ["mode"];
  const declared = modePath.reduce((node: any, key) => node?.[key], js);
  doc.setIn(modePath, to);
  changes.push({
    step: "clock", construct: "mode", class: "exact", path: pointer(modePath), before: declared ?? "PAL (default)", after: to,
    summary: `mode ${declared ?? "PAL (default)"} became ${to}; tempo stays in BPM and notes stay in pitch, the compiler maps both to the ${to} clock`,
  });
  return changes;
}
