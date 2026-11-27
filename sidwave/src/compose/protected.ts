// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { ParsedSidwave } from "../sidwave.js";
import { SIDWAVE_HARD_RESTART_FRAMES } from "../sidwaveCompiler.js";
import { traceDocument, type DocTrace } from "./trace.js";

/**
 * Verification that a completion left the protected material alone. Both scores are run on the bundled 6502 interpreter
 * and the SID register writes of each protected voice are compared call by call: the same registers, the same values and
 * the same order within the call. Voices that a completion targets are compared outside the cells it changes.
 */

export interface ProtectedSpec {
  /** Entry of the completed timeline for each original entry. */
  entryMap: number[];
  /** Original (voice, entry) cells that the completion changes; they are not compared. */
  excluded: ReadonlyArray<{ voice: number; entry: number }>;
  /**
   * Original (voice, entry) cells followed by new material of the same voice. The last `guard` player calls of these cells
   * are not compared: the hard restart before the next attack is written there.
   */
  guarded: ReadonlyArray<{ voice: number; entry: number }>;
}

export interface Mismatch { voice: number; entry: number; call: number; original: string; completed: string }

export interface ProtectedReport {
  identical: boolean;
  /** Voices of the original score that were compared. */
  voices: number[];
  cellsCompared: number;
  callsCompared: number;
  /** Player calls left out at the end of each guarded cell: (longest hard restart in video frames + 1) x speed. */
  guardCalls: number;
  guardedCells: number;
  excludedCells: number;
  /** The first differences, at most 10. */
  mismatches: Mismatch[];
}

function voiceRegisters(doc: ParsedSidwave, id: number): [number, number] {
  const slot = doc.voiceSlots.get(id)!;
  const chip = doc.sids[Math.floor(slot / 3)]!;
  const base = chip.address - 0xd400 + (slot % 3) * 7;
  return [base, base + 7];
}

function signatures(trace: DocTrace, range: [number, number]): string[] {
  return trace.calls.map((call) => {
    let text = "";
    for (const [reg, value] of call.writes) if (reg >= range[0] && reg < range[1]) text += `${reg - range[0]}=${value},`;
    return text;
  });
}

function entryFrames(doc: ParsedSidwave, trace: DocTrace): Array<[number, number]> {
  const fpb = (trace.compile.framesPerSecond * 60) / doc.song.tempo;
  let beat = 0;
  return doc.timeline.map((section) => {
    const from = Math.round(beat * fpb + 1e-9);
    beat += section.bars * doc.song.meter;
    return [from, Math.round(beat * fpb + 1e-9)];
  });
}

function longestRestart(doc: ParsedSidwave): number {
  let longest = SIDWAVE_HARD_RESTART_FRAMES;
  for (const instrument of Object.values(doc.instruments)) {
    const frames = (instrument as { hard_restart?: { frames?: number } }).hard_restart?.frames;
    if (typeof frames === "number") longest = Math.max(longest, frames);
  }
  return longest;
}

export function verifyProtected(original: ParsedSidwave, completed: ParsedSidwave, spec: ProtectedSpec): ProtectedReport {
  const a = traceDocument(original);
  const b = traceDocument(completed);
  const framesA = entryFrames(original, a);
  const framesB = entryFrames(completed, b);
  const guard = (longestRestart(original) + 1) * original.speed;
  const excluded = new Set(spec.excluded.map((c) => `${c.voice}:${c.entry}`));
  const guarded = new Set(spec.guarded.map((c) => `${c.voice}:${c.entry}`));
  const report: ProtectedReport = {
    identical: true, voices: original.voices.map((v) => v.id), cellsCompared: 0, callsCompared: 0, guardCalls: guard,
    guardedCells: guarded.size, excludedCells: excluded.size, mismatches: [],
  };
  for (const voice of original.voices) {
    const sigA = signatures(a, voiceRegisters(original, voice.id));
    const sigB = signatures(b, voiceRegisters(completed, voice.id));
    framesA.forEach(([from, to], entry) => {
      const key = `${voice.id}:${entry}`;
      if (excluded.has(key)) return;
      const target = framesB[spec.entryMap[entry]!]![0];
      const length = to - from - (guarded.has(key) ? guard : 0);
      report.cellsCompared++;
      for (let i = 0; i < length; i++) {
        report.callsCompared++;
        const x = sigA[from + i] ?? "";
        const y = sigB[target + i] ?? "";
        if (x !== y) {
          report.identical = false;
          if (report.mismatches.length < 10) report.mismatches.push({ voice: voice.id, entry, call: i, original: x, completed: y });
          return;
        }
      }
    });
  }
  return report;
}
