// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { ParsedSidwave } from "../sidwave.js";
import { SIDWAVE_HARD_RESTART_FRAMES, compileSidwaveToPrg } from "../sidwaveCompiler.js";
import { traceDocument, type DocTrace } from "./trace.js";

/**
 * Verification that a completion left the protected material alone. Both scores are run on the register-write interpreter
 * of trace.ts and the SID register writes of each protected voice are compared call by call: the same registers, the same
 * values and the same order within the call. Voices that a completion targets are compared outside the cells it changes.
 */

export interface ProtectedSpec {
  /** Entry of the completed timeline for each original entry. */
  entryMap: number[];
  /** Original (voice, entry) cells that the completion changes; they are not compared. */
  excluded: ReadonlyArray<{ voice: number; entry: number }>;
  /**
   * Original (voice, entry) cells of a voice that plays in the cell and is followed by new material of the same voice. In
   * the last `guard` player calls of such a cell, both scores must write the voice's control register with the gate bit clear
   * in the same call (except that an appended score may clear it later in the last original entry, where the original's
   * gate-off can be its loop restart), and the comparison ends at that call. From there the writes belong to the hard restart of the next attack
   * (in the original, of the loop's first note): gate off, zero envelope, and the next note's frequency and pulse width, which
   * the player writes with the restart. Before that call all seven registers must be identical, so a difference in pitch
   * earlier in the guard is a failure.
   */
  guarded: ReadonlyArray<{ voice: number; entry: number }>;
  /**
   * `compared` (default): the calls after the end of the last original entry (the ring-out tail of a score with `end`) are
   * compared too. `unprotected`: new timeline entries follow the original ones, so the original tail no longer exists as
   * it was and is not compared; the report names it.
   */
  tail?: "compared" | "unprotected";
  /** True when a guarded cell is followed in the original by other material or by its loop, so the original's gate-off can be a restart. */
  gateMayMoveLater?: boolean;
}

export interface Mismatch { voice: number; entry: number; call: number; original: string; completed: string }

export interface ProtectedReport {
  identical: boolean;
  /** Voices of the original score that were compared. */
  voices: number[];
  cellsCompared: number;
  callsCompared: number;
  /** Length of the guard window at the end of a guarded cell: (longest hard restart in video frames + 1) x speed player calls. */
  guardCalls: number;
  guardedCells: number;
  excludedCells: number;
  /** Calls after the last original entry that were compared (0 when the score has no tail or the tail is unprotected). */
  tailCallsCompared: number;
  /** The calls after the last original entry that are not compared, with the reason. */
  unprotectedTail?: { fromCall: number; toCall: number; reason: string };
  /** The first differences, at most 10. */
  mismatches: Mismatch[];
}

/** Offset from $D400 of a voice's first register. */
function voiceRegisters(doc: ParsedSidwave, id: number): number {
  const slot = doc.voiceSlots.get(id)!;
  return doc.sids[Math.floor(slot / 3)]!.address - 0xd400 + (slot % 3) * 7;
}

function entryFrames(doc: ParsedSidwave, framesPerSecond: number): Array<[number, number]> {
  const fpb = (framesPerSecond * 60) / doc.song.tempo;
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

/** Index of the first difference between the writes of a voice in call `ia` of `a` and call `ib` of `b`, or -1; `limit` registers from the voice's first. */
function firstDifference(a: DocTrace, ia: number, b: DocTrace, ib: number, lo: number, limit: number): number {
  let pa = a.starts[ia]!;
  const ea = a.starts[ia + 1]!;
  let pb = b.starts[ib]!;
  const eb = b.starts[ib + 1]!;
  const hi = lo + limit;
  let index = 0;
  for (;;) {
    let wa = -1;
    while (pa < ea) { const e = a.writes[pa++]!; const off = e >> 8; if (off >= lo && off < hi) { wa = e; break; } }
    let wb = -1;
    while (pb < eb) { const e = b.writes[pb++]!; const off = e >> 8; if (off >= lo && off < hi) { wb = e; break; } }
    if (wa !== wb) return index;
    if (wa < 0) return -1;
    index++;
  }
}

function describe(trace: DocTrace, call: number, lo: number): string {
  const out: string[] = [];
  for (let i = trace.starts[call]!; i < trace.starts[call + 1]!; i++) {
    const e = trace.writes[i]!;
    if ((e >> 8) >= lo && (e >> 8) < lo + 7) out.push(`${(e >> 8) - lo}=${e & 255}`);
  }
  return out.join(",");
}

/** First call in [from, to) in which the voice's control register is written with the gate bit clear, or `to`. */
function gateOffCall(trace: DocTrace, from: number, to: number, lo: number): number {
  for (let call = Math.max(0, from); call < to; call++) {
    for (let i = trace.starts[call]!; i < trace.starts[call + 1]!; i++) {
      const e = trace.writes[i]!;
      if ((e >> 8) === lo + 4 && (e & 1) === 0) return call;
    }
  }
  return to;
}

const cache = new Map<string, DocTrace>();

/**
 * Compares the register writes of the protected voices. `originalKey` (a content hash of the original document) lets repeated
 * operations on the same score reuse the original's trace. The completed score is compiled once and traced only as far as
 * the protected cells and the tail reach in it.
 */
export function verifyProtected(original: ParsedSidwave, completed: ParsedSidwave, spec: ProtectedSpec, originalKey?: string): ProtectedReport {
  let a = originalKey === undefined ? undefined : cache.get(originalKey);
  if (!a) {
    a = traceDocument(original);
    if (originalKey !== undefined) {
      if (cache.size >= 4) cache.delete(cache.keys().next().value!);
      cache.set(originalKey, a);
    }
  }
  const framesA = entryFrames(original, a.compile.framesPerSecond);
  const lastEntry = framesA.length - 1;
  const lastA = framesA[lastEntry]![1];
  const tailLength = a.callCount - lastA;
  const tailCompared = (spec.tail ?? "compared") === "compared" && tailLength > 0;
  const guard = (longestRestart(original) + 1) * original.speed;
  const excluded = new Set(spec.excluded.map((c) => `${c.voice}:${c.entry}`));
  const guarded = new Set(spec.guarded.map((c) => `${c.voice}:${c.entry}`));
  const compiledB = compileSidwaveToPrg(completed);
  const framesB = entryFrames(completed, compiledB.framesPerSecond);
  const lastB = framesB[spec.entryMap[lastEntry]!]![1];
  const horizon = Math.max(...framesA.map((_, entry) => framesB[spec.entryMap[entry]!]![1]), tailCompared ? lastB + tailLength : 0);
  const b = traceDocument(completed, { compiled: compiledB, calls: horizon });
  const report: ProtectedReport = {
    identical: true, voices: original.voices.map((v) => v.id), cellsCompared: 0, callsCompared: 0, guardCalls: guard,
    guardedCells: guarded.size, excludedCells: excluded.size, tailCallsCompared: 0, mismatches: [],
  };
  if (!tailCompared && tailLength > 0) {
    report.unprotectedTail = {
      fromCall: lastA, toCall: a.callCount,
      reason: "new timeline entries follow the original ones, so the end hold and release of the original no longer follow its last entry",
    };
  }
  for (const voice of original.voices) {
    const lo = voiceRegisters(original, voice.id);
    if (lo !== voiceRegisters(completed, voice.id)) throw new Error(`voice ${voice.id} moved to another register block`);
    const fail = (entry: number, call: number, ia: number, ib: number) => {
      report.identical = false;
      if (report.mismatches.length < 10) report.mismatches.push({ voice: voice.id, entry, call, original: describe(a!, ia, lo), completed: describe(b, ib, lo) });
    };
    framesA.forEach(([from, to], entry) => {
      const key = `${voice.id}:${entry}`;
      if (excluded.has(key)) return;
      const target = framesB[spec.entryMap[entry]!]![0];
      const length = to - from;
      // In a guarded cell the comparison stops where a score clears the voice's gate inside the guard: from there the writes
      // belong to the hard restart of the next attack (gate off, zero envelope, the next note's frequency and pulse width).
      // Both scores must clear the gate in the same call, so a note that ends later or earlier fails. The exception is a
      // cell that the original follows with other material (an inserted section) or with its loop (an appended one): the
      // original's gate-off there can be the restart for that following attack, so the completed score may clear the gate
      // later, never earlier.
      let guardFrom = length;
      if (guarded.has(key)) {
        const gateA = gateOffCall(a!, to - guard, to, lo) - from;
        const gateB = gateOffCall(b, target + length - guard, target + length, lo) - target;
        guardFrom = Math.min(gateA, gateB);
        if (gateA !== gateB && !(spec.gateMayMoveLater === true && gateB > gateA)) {
          report.identical = false;
          if (report.mismatches.length < 10) report.mismatches.push({ voice: voice.id, entry, call: guardFrom, original: `gate off at call ${gateA}`, completed: `gate off at call ${gateB}` });
          return;
        }
      }
      report.cellsCompared++;
      for (let i = 0; i < Math.min(length, guardFrom); i++) {
        report.callsCompared++;
        if (firstDifference(a!, from + i, b, target + i, lo, 7) >= 0) { fail(entry, i, from + i, target + i); return; }
      }
    });
    if (tailCompared && !excluded.has(`${voice.id}:${lastEntry}`)) {
      for (let i = 0; i < tailLength; i++) {
        report.tailCallsCompared++;
        if (firstDifference(a, lastA + i, b, lastB + i, lo, 7) >= 0) { fail(lastEntry, lastA - framesA[lastEntry]![0] + i, lastA + i, lastB + i); break; }
      }
    }
  }
  return report;
}
