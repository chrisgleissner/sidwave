// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Quality measure of a MOD import: the notes of the MOD (from its own playback model, with the timing effects applied) against
// the notes that SIDWave schedules for the imported score, after the voice reduction.

import { parseSidwave } from "../sidwave.js";
import { maxSidwaveMidi } from "../sidwaveCompiler.js";
import { exportEvents, type ExportedNote } from "./events.js";
import type { ModImportResult } from "./modImport.js";

export interface ModQuality {
  /** Notes of the kept channels in the MOD, notes in the imported score, and notes that match in pitch (or both percussion) and onset. */
  reference: number;
  imported: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  /** Absolute onset error of the matched notes in milliseconds. */
  onsetErrorMs: { mean: number; p95: number; max: number };
  /** Mean intersection over union of the sounding intervals of matched pitched notes (drum hits have no gate length to compare). */
  durationOverlap: number;
  /** Maximum onset difference for a match, in milliseconds. */
  toleranceMs: number;
  /** Recall over the notes of all channels, including those the voice reduction dropped. */
  recallAllChannels: number;
  voices: Array<{ voice: number; kind: "melodic" | "drums"; reference: number; imported: number; matched: number; f1: number }>;
}

const round = (v: number, digits = 4): number => Math.round(v * 10 ** digits) / 10 ** digits;

export function measureModQuality(result: ModImportResult, options: { toleranceMs?: number; transpose?: number; mode?: "PAL" | "NTSC" } = {}): ModQuality {
  const tolerance = (options.toleranceMs ?? 60) / 1000;
  const transpose = options.transpose ?? 0;
  const maxMidi = maxSidwaveMidi(options.mode ?? "PAL");
  const doc = parseSidwave(result.yaml);
  const events = exportEvents(doc);
  let refTotal = 0, impTotal = 0, matchedTotal = 0, allNotes = 0;
  const errors: number[] = [];
  let overlapSum = 0, overlapCount = 0;
  const voices: ModQuality["voices"] = [];
  for (const [vi, unit] of result.kept.entries()) {
    const impVoice = events.voices[vi];
    const imported: ExportedNote[] = impVoice ? [...impVoice.notes].sort((a, b) => a.on.time - b.on.time) : [];
    const drums = unit.kind === "drums";
    const ref = unit.channels.flatMap((c) => result.notes.get(c) ?? []).map((n) => {
      let pitch = n.midi + transpose;
      while (pitch < 12) pitch += 12;
      while (pitch > maxMidi) pitch -= 12;
      // A slide is written at its start pitch, but SIDWave reports the pitch the note reaches; either one counts as a match.
      return { on: n.startTime, off: n.endTime, pitch, alt: n.slide ? Math.max(12, Math.min(maxMidi, pitch + n.slide.semitones)) : undefined };
    }).sort((a, b) => a.on - b.on);
    const buckets = new Map<number, ExportedNote[]>();
    for (const n of imported) { const k = drums ? 0 : n.pitch; const list = buckets.get(k); if (list) list.push(n); else buckets.set(k, [n]); }
    const pointer = new Map<number, number>();
    let matched = 0;
    for (const r of ref) {
      let key = drums ? 0 : r.pitch;
      let list = buckets.get(key);
      const reach = (l: ExportedNote[] | undefined, k: number): boolean => {
        if (!l) return false;
        let q = pointer.get(k) ?? 0;
        while (q < l.length && l[q]!.on.time < r.on - tolerance) q++;
        pointer.set(k, q);
        return q < l.length && Math.abs(l[q]!.on.time - r.on) <= tolerance;
      };
      if (!reach(list, key) && r.alt !== undefined && reach(buckets.get(r.alt), r.alt)) { key = r.alt; list = buckets.get(key); }
      if (!list) continue;
      let p = pointer.get(key) ?? 0;
      while (p < list.length && list[p]!.on.time < r.on - tolerance) p++;
      if (p < list.length && Math.abs(list[p]!.on.time - r.on) <= tolerance) {
        const n = list[p]!;
        matched++;
        errors.push(Math.abs(n.on.time - r.on) * 1000);
        if (!drums) {
          const off = n.off.time - (n.effects?.gateOffSeconds ?? 0);
          const inter = Math.max(0, Math.min(r.off, off) - Math.max(r.on, n.on.time));
          const union = Math.max(r.off, off) - Math.min(r.on, n.on.time);
          overlapSum += union > 0 ? inter / union : 1;
          overlapCount++;
        }
        pointer.set(key, p + 1);
      } else pointer.set(key, p);
    }
    refTotal += ref.length; impTotal += imported.length; matchedTotal += matched;
    const prec = imported.length ? matched / imported.length : 0, rec = ref.length ? matched / ref.length : 0;
    voices.push({ voice: vi + 1, kind: unit.kind, reference: ref.length, imported: imported.length, matched, f1: round(prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0) });
  }
  for (const list of result.notes.values()) allNotes += list.length;
  const precision = impTotal ? matchedTotal / impTotal : 0, recall = refTotal ? matchedTotal / refTotal : 0;
  errors.sort((a, b) => a - b);
  return {
    reference: refTotal, imported: impTotal, matched: matchedTotal, precision: round(precision), recall: round(recall),
    f1: round(precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0),
    onsetErrorMs: { mean: round(errors.length ? errors.reduce((t, v) => t + v, 0) / errors.length : 0, 2), p95: round(errors[Math.floor(errors.length * 0.95)] ?? 0, 2), max: round(errors[errors.length - 1] ?? 0, 2) },
    durationOverlap: round(overlapCount ? overlapSum / overlapCount : 0),
    toleranceMs: tolerance * 1000, recallAllChannels: round(allNotes ? matchedTotal / allNotes : 0), voices,
  };
}
