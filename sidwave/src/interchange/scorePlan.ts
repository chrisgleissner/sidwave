// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// ScorePlan: the one place that reduces a score to what a target format can hold. Every exporter of the convert hub
// goes through it, so voice selection, tempo handling, loops and metadata are decided the same way for all targets.

import type { ParsedSidwave } from "../sidwave.js";
import { songDoc } from "../sidwaveSongs.js";
import { exportEvents, type EventExportOptions, type ExportedScore } from "./events.js";
import type { Loss } from "./loss.js";

/** What a target format can store. Used by the plan to decide what to reduce and what to report. */
export interface TargetCaps {
  /** Largest number of voices the target holds. Undefined: no limit. */
  maxVoices?: number;
  /**
   * How tempo is stored: `map` keeps a tempo map (ramps become steps), `grid` folds tempo into a fixed row length,
   * `none` stores no tempo (audio, compiled programs that play the score themselves keep exact timing).
   */
  tempo: "map" | "grid" | "none" | "exact";
  /** `native` keeps SID instrument parameters, `program` maps them to a General MIDI program, `none` has no instruments. */
  instruments: "native" | "program" | "none";
  /**
   * Glides, slides and vibrato: `exact` plays them, `partial` maps some to commands (the exporter reports what it
   * drops), `none` writes plain notes, so the plan reports them when the score uses them.
   */
  expression: "exact" | "partial" | "none";
  /** The target stores a loop point. */
  loop: boolean;
  /** The target stores the title and the author. */
  metadata: boolean;
}

export interface VoiceRank {
  id: number;
  name?: string;
  notes: number;
  /** Semitones between the lowest and the highest note, plus one. */
  range: number;
  /** notes x range: the order in which voices are kept. */
  weight: number;
  kept: boolean;
}

export interface PlanOptions {
  /** Song, 0-based. Default 0. */
  song?: number;
  /** Voice limit given by the user (`--voices`); the smaller of it and the target's limit applies. */
  voices?: number;
}

export interface ScorePlanResult {
  /** Options for the exporter: the selected song and, when voices were dropped or limited, the voices to write. */
  exportOptions: EventExportOptions;
  voices: VoiceRank[];
  dropped: number[];
  losses: Loss[];
  summary: {
    song: number;
    voicesWithNotes: number;
    sids: number;
    tempoEntries: number;
    tempoRamps: boolean;
    instruments: number;
    loop: boolean;
    durationSeconds: number;
  };
}

const pluralise = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Ranks the voices of the selected song by notes x pitch range, keeps the best ones up to the limit and reports what
 * is dropped or folded. The ranking is deterministic: ties keep the voice that comes first in the score.
 * `events` may be passed when the caller already has the event export of this song.
 */
export function planScore(doc: ParsedSidwave, caps: TargetCaps, options: PlanOptions = {}, events?: ExportedScore): ScorePlanResult {
  const song = options.song ?? 0;
  const score = events ?? exportEvents(doc, { song });
  const losses: Loss[] = [];
  const view = doc.songs ? songDoc(doc, song) : doc;

  const ranked: VoiceRank[] = score.voices.filter((v) => v.notes.length > 0).map((v) => {
    let low = Infinity, high = -Infinity;
    for (const n of v.notes) { low = Math.min(low, n.pitch); high = Math.max(high, n.pitch); }
    const range = high - low + 1;
    return { id: v.id, ...(v.name ? { name: v.name } : {}), notes: v.notes.length, range, weight: v.notes.length * range, kept: true };
  });
  const limits = [caps.maxVoices, options.voices].filter((n): n is number => n !== undefined);
  const limit = limits.length ? Math.min(...limits) : Infinity;
  let exportOptions: EventExportOptions = { song };
  const dropped: number[] = [];
  if (ranked.length > limit) {
    const order = [...ranked].sort((a, b) => b.weight - a.weight || ranked.indexOf(a) - ranked.indexOf(b));
    for (const v of order.slice(limit)) { v.kept = false; dropped.push(v.id); }
    const keep = ranked.filter((v) => v.kept).map((v) => v.id);
    exportOptions = { song, voiceIds: keep };
    const lostNotes = ranked.filter((v) => !v.kept).reduce((sum, v) => sum + v.notes, 0);
    losses.push({
      stage: "plan", code: "voices.dropped", severity: "lost", count: dropped.length, where: dropped.map((id) => `v${id}`).join(","),
      message: `${pluralise(dropped.length, "voice")} dropped to fit ${pluralise(limit, "voice")} (${lostNotes} notes): kept ${keep.map((id) => `v${id}`).join(", ")}, ranked by notes x pitch range.`,
    });
  } else if (caps.maxVoices !== undefined || options.voices !== undefined) {
    // The exporter takes the first voices of the first SID unless it is told which voices to write.
    exportOptions = { song, voiceIds: ranked.map((v) => v.id) };
  }

  const ramps = view.timeline.some((section) => typeof (section as { tempo?: unknown }).tempo === "object");
  const tempoEntries = score.tempoMap.length;
  if (caps.tempo === "grid" && tempoEntries > 1) {
    losses.push({ stage: "plan", code: "tempo.folded", severity: "approx", count: tempoEntries - 1,
      message: `${pluralise(tempoEntries - 1, "tempo change")} cannot be stored: the target has one tempo and the row grid carries the timing.` });
  }
  if (ramps) {
    const stored = caps.tempo === "map" || caps.tempo === "exact";
    losses.push({ stage: "plan", code: "tempo.ramp", severity: "approx", count: 1,
      message: stored ? "Tempo ramps are written as steps of constant tempo." : "Tempo ramps cannot be stored; the notes keep their times but not the tempo curve." });
  }
  if (caps.expression === "none") {
    const glides = score.voices.reduce((sum, v) => sum + v.notes.filter((n) => n.effects?.bend).length, 0);
    const shaped = score.instruments.filter((i) => i.vibrato || i.slide).length;
    if (glides + shaped > 0) {
      losses.push({ stage: "plan", code: "bend.dropped", severity: "lost", count: glides + shaped,
        message: `${glides} glides and ${pluralise(shaped, "instrument")} with vibrato or slides are written as plain notes.` });
    }
  }
  const loop = view.loopTo !== undefined;
  if (loop && !caps.loop) {
    losses.push({ stage: "plan", code: "loop.restart", severity: "approx", count: 1, message: `The loop point (bar ${view.loopTo}) is not stored; the target plays the song once.` });
  }
  if (!caps.metadata && (doc.song.title || doc.song.author)) {
    losses.push({ stage: "plan", code: "metadata.dropped", severity: "info", count: doc.song.author ? 2 : 1, message: "The title and the author are not stored in the target." });
  }
  return {
    exportOptions, voices: ranked, dropped, losses,
    summary: {
      song, voicesWithNotes: ranked.length, sids: doc.sids.length, tempoEntries, tempoRamps: ramps, instruments: score.instruments.length,
      loop, durationSeconds: score.durationSeconds,
    },
  };
}
