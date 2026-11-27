// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { pick, type Random } from "./theory.js";

/**
 * Rhythm of composer 2. A bar is a grid of sixteenths (16 cells in 4/4, 12 in 3/4). The groove tables below are data:
 * each entry is one way of dividing a bar into note durations in cells.
 */

export interface Slot { at: number; dur: number; rest: boolean }

export interface Groove {
  /** Duration patterns for a bar of 16 cells. */
  bar16: number[][];
  /** Duration patterns for a bar of 12 cells. */
  bar12: number[][];
  /** Share of weak onsets that become rests, before the density factor. */
  rests: number;
}

export const GROOVES: Record<string, Groove> = {
  straight: {
    bar16: [[4, 4, 4, 4], [2, 2, 4, 2, 2, 4], [4, 2, 2, 4, 4], [2, 2, 2, 2, 4, 4], [6, 2, 4, 4], [4, 4, 2, 2, 4]],
    bar12: [[4, 4, 4], [2, 2, 4, 4], [6, 2, 4], [4, 2, 2, 4]],
    rests: 0.08,
  },
  driving: {
    bar16: [[2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 4, 2, 2], [1, 1, 2, 2, 2, 2, 2, 4], [2, 2, 2, 2, 2, 2, 4], [2, 1, 1, 2, 2, 2, 2, 2, 2]],
    bar12: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 4], [1, 1, 2, 2, 2, 4]],
    rests: 0.1,
  },
  syncopated: {
    bar16: [[3, 3, 2, 3, 3, 2], [3, 3, 4, 2, 4], [2, 3, 3, 2, 3, 3], [4, 3, 3, 6], [3, 3, 2, 2, 2, 4]],
    bar12: [[3, 3, 3, 3], [3, 3, 6], [2, 3, 3, 4]],
    rests: 0.12,
  },
  shuffle: {
    bar16: [[3, 1, 3, 1, 3, 1, 3, 1], [3, 1, 3, 1, 4, 4], [3, 1, 3, 1, 3, 1, 4]],
    bar12: [[3, 1, 3, 1, 3, 1], [3, 1, 3, 1, 4]],
    rests: 0.06,
  },
  flowing: {
    bar16: [[2, 2, 2, 2, 2, 2, 4], [4, 2, 2, 2, 2, 4], [2, 2, 4, 2, 2, 2, 2], [6, 2, 2, 2, 2, 2]],
    bar12: [[2, 2, 2, 2, 4], [4, 2, 2, 4], [6, 2, 2, 2]],
    rests: 0.05,
  },
  sparse: {
    bar16: [[8, 8], [12, 4], [6, 6, 4], [8, 4, 4], [16]],
    bar12: [[12], [6, 6], [8, 4]],
    rests: 0.15,
  },
};

/** Bars that close a phrase end on a long note. */
const CADENCE16 = [[4, 4, 8], [2, 2, 4, 8], [2, 2, 2, 2, 8], [4, 2, 2, 8], [6, 2, 8]];
const CADENCE12 = [[4, 8], [2, 2, 8], [6, 6], [4, 2, 6]];

export interface BarRhythmOptions {
  groove: string;
  cells: number;
  cadence: boolean;
  /** 0..1 chance that an onset on beat 2 or 4 moves one cell earlier. */
  syncopation: number;
  /** 0..1 scale on the groove's rest share. */
  density: number;
}

export function barRhythm(random: Random, o: BarRhythmOptions): Slot[] {
  const groove = GROOVES[o.groove];
  if (!groove) throw new Error(`unknown groove "${o.groove}"`);
  const table = o.cadence ? (o.cells === 12 ? CADENCE12 : CADENCE16) : o.cells === 12 ? groove.bar12 : groove.bar16;
  const durations = pick(random, table);
  const slots: Slot[] = [];
  let at = 0;
  for (const dur of durations) {
    slots.push({ at, dur, rest: false });
    at += dur;
  }
  // Anticipation: an onset on beat 2 or 4 arrives a sixteenth early, so the previous note is one cell shorter.
  if (!o.cadence) {
    for (let i = 1; i < slots.length; i++) {
      const s = slots[i]!;
      const previous = slots[i - 1]!;
      if ((s.at === 4 || s.at === 12) && previous.dur >= 2 && random() < o.syncopation) {
        previous.dur -= 1;
        s.at -= 1;
        s.dur += 1;
      }
    }
  }
  for (let i = 1; i < slots.length - (o.cadence ? 1 : 0); i++) {
    const s = slots[i]!;
    if (s.at % 4 !== 0 && random() < groove.rests * o.density) s.rest = true;
  }
  return slots;
}

/** Bass cells: r root, R root an octave up, f fifth, t third, n approach tone to the next root, . rest, ~ tie. */
export const BASS_PATTERNS: Record<string, readonly string[]> = {
  pulse: ["r~r~r~r~r~r~r~r~", "r~r~r~R~r~r~r~R~"],
  rootfifth: ["r~~~f~~~r~~~f~~~", "r~~~r~~~f~~~r~~~"],
  octave: ["r~R~r~R~r~R~r~R~", "r~R~r~R~r~f~r~R~"],
  funk: ["r~.rr~.r~rR.r~f.", "r..rr~.r..rR~.f~"],
  walking: ["r~~~t~~~f~~~t~~~", "r~~~f~~~t~~~f~~~"],
  broken: ["r~f~R~f~r~f~R~f~", "r~t~f~t~r~t~f~t~"],
  sustained: ["r~~~~~~~~~~~~~~~", "r~~~~~~~r~~~~~~~"],
  driving: ["rrrrrrrrrrrrrrrr", "r~rrr~rrr~rrr~rr"],
};

/**
 * Drum steps per cell: k kick, s snare, h hat, . rest. Hits are at least two cells apart: the kick and snare tables run
 * six frames and the next attack needs a hard restart before it, which a one-cell gap does not leave at these tempos.
 */
export const DRUM_PATTERNS: Record<string, readonly string[]> = {
  backbeat: ["k.h.s.h.k.h.s.h.", "k.h.s.h.k.k.s.h."],
  fourfloor: ["k.h.k.h.k.h.k.h.", "k.h.s.k.h.k.s.h."],
  funk: ["k.h.s.h.k.k.s.h.", "k...s.h.k.h.s.k."],
  breakbeat: ["k.h.s.h.h.k.s.h.", "k...s.k.h.k.s.h."],
  halftime: ["k.h...h.s.h...h.", "k.h...h.s.h.k.h."],
  sparse: ["k.......h.......", "k...h...s...h..."],
  none: ["................"],
};

export const DRUM_FILLS: readonly string[] = ["k.h.s.h.s.s.s.s.", "k.k.s.s.k.s.s.s.", "k.h.k.h.s.s.k.s."];

export function cellString(pattern: string, cells: number): string {
  return pattern.length >= cells ? pattern.slice(0, cells) : pattern.padEnd(cells, ".");
}

/** Arpeggio voice triggers: x starts the chord arpeggio, ~ holds, . rests. */
export const ARP_PATTERNS: Record<string, readonly string[]> = {
  quarter: ["x~~~x~~~x~~~x~~~"],
  half: ["x~~~~~~~x~~~~~~~"],
  eighth: ["x~x~x~x~x~x~x~x~"],
  offbeat: ["x~~~~~x~x~~~~~x~", "x~~x~~x~x~~x~~x~"],
  whole: ["x~~~~~~~~~~~~~~~"],
  gated: ["x~~.x~~.x~~.x~~."],
};
