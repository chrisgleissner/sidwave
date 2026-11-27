// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Structured losses of a conversion. The importers and exporters report losses as plain sentences; this module gives
// each sentence a stable code and a severity, so that the convert hub can group, count and gate on them.

export type LossStage = "read" | "plan" | "write" | "verify";
/** info: nothing musical is lost; approx: the result is close but not equal; lost: content is missing in the output. */
export type LossSeverity = "info" | "approx" | "lost";

export interface Loss {
  stage: LossStage;
  code: string;
  severity: LossSeverity;
  /** How many items the loss concerns (notes, voices, commands); 1 when the sentence names no number. */
  count: number;
  where?: string;
  message: string;
}

const SEVERITY_ORDER: Record<LossSeverity, number> = { info: 0, approx: 1, lost: 2 };

/** Ordered rules: the first matching pattern gives the code and severity of a sentence. */
const RULES: Array<[RegExp, string, LossSeverity]> = [
  [/only the first three voices|do not fit in \d+ voices/i, "voices.dropped", "lost"],
  [/tempo ramps/i, "tempo.ramp", "approx"],
  [/tempo change\(s\)|outside the sidwave tempo range|row length is outside/i, "tempo.quantised", "approx"],
  [/funk tempo|per-channel tempo|speed pattern/i, "tempo.simplified", "approx"],
  [/constant tempo and metre/i, "tempo.constant", "info"],
  [/time signature without/i, "meter.approximated", "approx"],
  [/subsongs; only the first/i, "song.unselected", "lost"],
  [/channels have .* rows|padded with rests/i, "rows.padded", "info"],
  [/loops back to a position/i, "loop.restart", "approx"],
  [/silent notes that only drive/i, "notes.hidden", "info"],
  [/digi sample/i, "samples.digi", "lost"],
  [/sound effects/i, "effects.sfx", "lost"],
  [/^filter, pulse width modulation/i, "instrument.simplified", "approx"],
  [/filter settings, cutoff sweeps|filter and resonance|filter settings and filter tables|filter settings are not|filter control/i, "filter.dropped", "lost"],
  [/pulse width modulation is described/i, "pulse.modulation", "info"],
  [/vibrato is not exported/i, "vibrato.dropped", "lost"],
  [/instrument slides are not exported/i, "slide.dropped", "lost"],
  [/wavetable steps/i, "wavetable.dropped", "lost"],
  [/glides and portamento/i, "glide.dropped", "lost"],
  [/pitch bend is not written|pitch bend, glides, slides and vibrato/i, "bend.not-written", "info"],
  [/pitches are the written notes/i, "pitch.written", "info"],
  [/vibrato fade and exact slide|pitch bend import is disabled/i, "bend.approximated", "approx"],
  [/pitch bend on \d+ notes|vibrato\) or no room/i, "bend.dropped", "lost"],
  [/tone portamento notes are played as new notes/i, "glide.dropped", "lost"],
  [/pattern command .* is not imported/i, "command.dropped", "lost"],
  [/effect commands .* are not imported/i, "command.dropped", "lost"],
  [/notes (are|were) (outside|moved).*octave|moved down by octaves|moved by octaves/i, "pitch.octave", "approx"],
  [/notes dropped because they sound together/i, "notes.polyphony", "lost"],
  [/hits dropped/i, "notes.drums", "lost"],
  [/unpitched notes/i, "notes.unpitched", "lost"],
  [/grace notes|cue notes/i, "notes.ornament", "lost"],
  [/repeat signs/i, "structure.repeats", "lost"],
  [/times per frame \(multispeed\)/i, "timing.multispeed", "approx"],
  [/rows are whole multiples|nearest row/i, "timing.row-grid", "approx"],
  [/durations are written in ticks/i, "notation.durations", "info"],
  [/controllers other than|dynamics marks/i, "expression.dropped", "lost"],
  [/adsr envelopes, waveforms|each instrument becomes a general midi|instruments come from the gm program/i, "instrument.mapped", "approx"],
  [/pulse width modulation, ring and sync|hard restart/i, "instrument.simplified", "approx"],
  [/instrument \d+:|^instrument .* not a c64 instrument|macro \d+/i, "instrument.simplified", "approx"],
  [/master volume|tick-0 waveform|exact frame timing/i, "timing.approximated", "approx"],
  [/volume column/i, "volume.dropped", "lost"],
  [/^gts[!2345]|conversion|converted/i, "format.upgraded", "info"],
  [/tempo.*(note|rows)/i, "tempo.quantised", "approx"],
];

/** Severity and code of one sentence reported by an importer or exporter. */
export function classifyLossText(text: string): { code: string; severity: LossSeverity } {
  for (const [pattern, code, severity] of RULES) if (pattern.test(text)) return { code, severity };
  return { code: "note", severity: "info" };
}

/** Wraps the sentences of an importer or exporter as structured losses of one stage. */
export function lossesFromText(stage: LossStage, texts: readonly string[]): Loss[] {
  return texts.map((message) => {
    const { code, severity } = classifyLossText(message);
    const number = /^(?:[A-Za-z ]*?:\s*)?(\d+)\s/.exec(message) ?? /\((\d+) uses?\)/.exec(message);
    return { stage, code, severity, count: number ? Number(number[1]) : 1, message };
  });
}

export function maxSeverity(losses: readonly Loss[]): LossSeverity {
  let best: LossSeverity = "info";
  for (const loss of losses) if (SEVERITY_ORDER[loss.severity] > SEVERITY_ORDER[best]) best = loss.severity;
  return best;
}

/** Groups by stage and code: counts add up, the severity is the highest one, messages are joined without repeats. */
export function groupLosses(losses: readonly Loss[]): Loss[] {
  const groups = new Map<string, Loss>();
  for (const loss of losses) {
    const key = `${loss.stage}\u0000${loss.code}`;
    const have = groups.get(key);
    if (!have) { groups.set(key, { ...loss }); continue; }
    have.count += loss.count;
    if (SEVERITY_ORDER[loss.severity] > SEVERITY_ORDER[have.severity]) have.severity = loss.severity;
    if (!have.message.split(" | ").includes(loss.message)) have.message += ` | ${loss.message}`;
    if (loss.where && !have.where?.split(",").includes(loss.where)) have.where = have.where ? `${have.where},${loss.where}` : loss.where;
  }
  return [...groups.values()];
}
