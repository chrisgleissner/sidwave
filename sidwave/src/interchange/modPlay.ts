// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// MOD playback model for the importer and its quality measure: the sequence of rows that play (with position jumps, pattern
// breaks, pattern loops, pattern delays, speed and tempo) and the notes of each channel with the effects that apply to them.
// It does not render audio. One tick lasts 2.5 / BPM seconds (the ProTracker CIA tempo; 125 BPM is 50 ticks per second).

import { ModError, MOD_ROWS, periodToMidi, type ModSong } from "./mod.js";

export interface PlayedRow {
  order: number;
  pattern: number;
  row: number;
  /** Ticks per row (speed) and tempo in effect for this row, after the effects of the row itself. */
  speed: number;
  bpm: number;
  /** Extra repeats from a pattern delay (EEx). */
  delay: number;
  /** Duration in seconds and start time in seconds. */
  seconds: number;
  start: number;
}

export interface PlaySequence {
  rows: PlayedRow[];
  /** Index in `rows` that the song jumps back to when it loops, or -1 when it ends instead. */
  loopTo: number;
  end: "loop" | "end" | "stop";
  /** Total duration of the played rows in seconds. */
  seconds: number;
  /** Counts for the report. */
  patternLoops: number;
  patternDelays: number;
  jumps: number;
}

export const DEFAULT_SPEED = 6;
export const DEFAULT_BPM = 125;
export const tickSeconds = (bpm: number): number => 2.5 / bpm;

/** Expands the order list into the rows that play once, following B, D, E6x, EEx, F. Stops at the first repeated position. */
export function playRows(song: ModSong, maxRows: number): PlaySequence {
  const ch = song.channels;
  const rows: PlayedRow[] = [];
  const visited = new Map<number, number>();
  let order = 0, row = 0, speed = DEFAULT_SPEED, bpm = DEFAULT_BPM, start = 0;
  let loopTo = -1, end: PlaySequence["end"] = "end";
  let patternLoops = 0, patternDelays = 0, jumps = 0;
  const loopRow = new Int32Array(ch), loopCount = new Int32Array(ch);
  let enteredByFlow = true; // true for the first row and after a jump or order advance: the position is checked for repeats
  for (;;) {
    if (order >= song.songLength) { end = "end"; break; }
    const key = order * MOD_ROWS + row;
    if (enteredByFlow) {
      const seen = visited.get(key);
      if (seen !== undefined) { loopTo = seen; end = "loop"; break; }
    }
    if (!visited.has(key)) visited.set(key, rows.length);
    if (rows.length >= maxRows) throw new ModError(`the song has more than ${maxRows} rows before it repeats`);
    const patternNumber = song.orders[order]!;
    const pat = song.patterns[patternNumber];
    if (!pat) throw new ModError(`order ${order} names pattern ${patternNumber}, which is not in the file`);
    let jumpOrder = -1, breakRow = -1, delay = 0, stop = false;
    let loopJump = -1;
    for (let c = 0; c < ch; c++) {
      const i = row * ch + c;
      const eff = pat.effect[i]!, par = pat.param[i]!;
      if (eff === 0xf) { if (par === 0) stop = true; else if (par < 32) speed = par; else bpm = par; }
      else if (eff === 0xb) jumpOrder = par;
      else if (eff === 0xd) breakRow = (par >> 4) * 10 + (par & 15);
      else if (eff === 0xe) {
        const x = par & 15;
        switch (par >> 4) {
          case 0x6:
            if (x === 0) loopRow[c] = row;
            else {
              loopCount[c] = loopCount[c] === 0 ? x : loopCount[c]! - 1;
              if (loopCount[c]! > 0) { loopJump = loopRow[c]!; patternLoops++; }
            }
            break;
          case 0xe: delay = Math.max(delay, x); break;
          default: break;
        }
      }
    }
    const tickSec = tickSeconds(bpm);
    const seconds = speed * (1 + delay) * tickSec;
    if (delay) patternDelays++;
    rows.push({ order, pattern: patternNumber, row, speed, bpm, delay, seconds, start });
    start += seconds;
    if (stop) { end = "stop"; break; }
    // Where the song goes next. A jump or break takes precedence over a pattern loop in the same row.
    if (jumpOrder >= 0 || breakRow >= 0) {
      jumps++;
      const nextOrder = jumpOrder >= 0 ? jumpOrder : order + 1;
      const nextRow = breakRow >= 0 && breakRow < MOD_ROWS ? breakRow : 0;
      order = nextOrder; row = nextRow; enteredByFlow = true;
      for (let c = 0; c < ch; c++) { loopRow[c] = 0; loopCount[c] = 0; }
      if (jumpOrder >= song.songLength) { end = "end"; break; }
    } else if (loopJump >= 0) { row = loopJump; enteredByFlow = false; }
    else if (row + 1 < MOD_ROWS) { row++; enteredByFlow = false; }
    else { order++; row = 0; enteredByFlow = true; for (let c = 0; c < ch; c++) { loopRow[c] = 0; loopCount[c] = 0; } }
  }
  return { rows, loopTo, end, seconds: start, patternLoops, patternDelays, jumps };
}

/** A note as the MOD plays it: a trigger, or a tone portamento to a new pitch (`glide`). */
export interface ModNote {
  channel: number;
  /** Index into the played rows where the note starts, and the ticks into that row (note delay, EDx). */
  row: number;
  delayTicks: number;
  /** Start and end in seconds. The end is the next note on the channel, a cut (ECx, volume 0) or the end of the song. */
  startTime: number;
  endTime: number;
  sample: number;
  midi: number;
  glide: boolean;
  /** Volume at the start (0..64) and the time-weighted mean over the note. */
  volume: number;
  meanVolume: number;
  /** Pitch movement: slide in whole semitones over `seconds`, or a tone portamento taking `seconds`. */
  slide: { semitones: number; seconds: number } | undefined;
  portamento: { seconds: number } | undefined;
  vibrato: { speed: number; depth: number; firstRow: number; rows: number; period: number } | undefined;
  arpeggio: { x: number; y: number; firstRow: number; rows: number } | undefined;
  tickSec: number;
  /** Row at which the note is cut (ECx or volume zero) and the tick within it; -1 when there is no cut. */
  cutRow: number;
  cutTick: number;
  silent: boolean;
}

export interface EffectTally { uses: number; mapped: number }
export interface ChannelNotes { channel: number; notes: ModNote[] }

export const EFFECT_NAMES: Record<string, string> = {
  "0": "0xy arpeggio", "1": "1xx portamento up", "2": "2xx portamento down", "3": "3xx tone portamento", "4": "4xy vibrato",
  "5": "5xy tone portamento and volume slide", "6": "6xy vibrato and volume slide", "7": "7xy tremolo", "8": "8xx set panning",
  "9": "9xx sample offset", A: "Axy volume slide", B: "Bxx position jump", C: "Cxx set volume", D: "Dxx pattern break", F: "Fxx speed or tempo",
  E1: "E1x fine portamento up", E2: "E2x fine portamento down", E3: "E3x glissando control", E4: "E4x vibrato waveform", E5: "E5x set finetune",
  E6: "E6x pattern loop", E7: "E7x tremolo waveform", E8: "E8x set panning", E9: "E9x retrigger note", EA: "EAx fine volume slide up",
  EB: "EBx fine volume slide down", EC: "ECx note cut", ED: "EDx note delay", EE: "EEx pattern delay", EF: "EFx invert loop",
};
export function effectKey(eff: number, par: number): string {
  return eff === 0xe ? `E${(par >> 4).toString(16).toUpperCase()}` : eff.toString(16).toUpperCase();
}

const PERIOD_LOW = 113, PERIOD_HIGH = 856;
const clampVol = (v: number): number => Math.max(0, Math.min(64, v));

/**
 * Walks the played rows of every channel (or those in `only`) and returns its notes. Effects are counted in `tally`
 * (`uses`: occurrences, `mapped`: uses the notes carry on to the importer).
 */
export function collectNotes(song: ModSong, seq: PlaySequence, tallies?: Array<Map<string, EffectTally>>, only?: Set<number>): ChannelNotes[] {
  const ch = song.channels;
  const out: ChannelNotes[] = [];
  const total = seq.rows.length;
  for (let c = 0; c < ch; c++) {
    if (only && !only.has(c)) continue;
    const tally = tallies?.[c];
    const count = (key: string, mapped: boolean): void => {
      if (!tally) return;
      const t = tally.get(key) ?? { uses: 0, mapped: 0 };
      t.uses++; if (mapped) t.mapped++;
      tally.set(key, t);
    };
    const notes: ModNote[] = [];
    let sample = 0, volume = 0, period = 0, porta = 0, vibX = 0, vibY = 0;
    let cur: ModNote | undefined;
    let volSum = 0, volWeight = 0, slideSeconds = 0, slideFrom = 0;
    const close = (nextTime: number): void => {
      if (!cur) return;
      const cutTime = cur.cutRow >= 0 ? seq.rows[cur.cutRow]!.start + cur.cutTick * tickSeconds(seq.rows[cur.cutRow]!.bpm) : Infinity;
      cur.endTime = Math.max(cur.startTime, Math.min(nextTime, cutTime));
      cur.meanVolume = volWeight > 0 ? volSum / volWeight : cur.volume;
      if (slideSeconds > 0 && slideFrom > 0) {
        const semitones = Math.round(12 * Math.log2(slideFrom / period));
        if (semitones !== 0) cur.slide = { semitones, seconds: slideSeconds };
      }
      cur = undefined;
    };
    const start = (i: number, per: number, finetune: number, delayTicks: number, glide: boolean, portSeconds: number): void => {
      const pr = seq.rows[i]!;
      const tickSec = tickSeconds(pr.bpm);
      const startTime = pr.start + delayTicks * tickSec;
      close(startTime);
      period = Math.max(28, per);
      cur = {
        channel: c, row: i, delayTicks, startTime, endTime: seq.seconds, sample, midi: periodToMidi(period, finetune), glide, volume,
        meanVolume: volume, slide: undefined, portamento: portSeconds > 0 ? { seconds: portSeconds } : undefined, vibrato: undefined,
        arpeggio: undefined, tickSec, cutRow: -1, cutTick: -1, silent: sample === 0 || volume === 0,
      };
      notes.push(cur);
      volSum = 0; volWeight = 0; slideSeconds = 0; slideFrom = period;
    };
    for (let i = 0; i < total; i++) {
      const pr = seq.rows[i]!;
      const pat = song.patterns[pr.pattern]!;
      const idx = pr.row * ch + c;
      const per = pat.period[idx]!, smp = pat.sample[idx]!, eff = pat.effect[idx]!, par = pat.param[idx]!;
      const x = par >> 4, y = par & 15;
      const sub = eff === 0xe ? x : -1, subv = y;
      const tickSec = tickSeconds(pr.bpm);
      const ticksTotal = pr.speed * (1 + pr.delay);
      const key = effectKey(eff, par);
      if (smp !== 0 && smp <= song.samples.length) { sample = smp; volume = song.samples[smp - 1]!.volume; }
      if (eff === 0xc) volume = Math.min(64, par);
      const finetune = sample ? song.samples[sample - 1]!.finetune : 0;
      const isTone = (eff === 3 || eff === 5) && per !== 0;
      const delayed = sub === 0xd && subv > 0;
      if (eff === 3 && par !== 0) porta = par;
      if (per !== 0 && !isTone) {
        if (delayed && subv >= pr.speed) count("ED", false);
        else start(i, per, finetune, delayed ? subv : 0, false, 0);
      } else if (isTone && sample !== 0) {
        const alive = cur !== undefined && !cur.silent && !(cur.cutRow >= 0 && cur.cutRow < i);
        if (alive) {
          const target = Math.max(28, per);
          const rate = porta > 0 ? porta : 1;
          const ticks = Math.ceil(Math.abs(period - target) / rate);
          start(i, target, finetune, 0, true, ticks * tickSec);
        } else { start(i, per, finetune, 0, false, 0); count("3xx tone portamento without a sounding note (played as a note)", true); }
      }
      const c0 = cur as ModNote | undefined;
      const alive = c0 !== undefined && !c0.silent && !(c0.cutRow >= 0 && c0.cutRow < i);
      const rowStartVolume = volume;
      if (eff === 0 && par !== 0) {
        if (alive) { c0!.arpeggio = c0!.arpeggio ?? { x, y, firstRow: i, rows: 0 }; c0!.arpeggio.rows++; }
        count(key, alive);
      } else if (eff === 1 || eff === 2) {
        if (par !== 0) {
          if (alive) {
            period = Math.max(PERIOD_LOW, Math.min(PERIOD_HIGH, period + (eff === 1 ? -par : par) * (pr.speed - 1)));
            slideSeconds += (pr.speed - 1) * tickSec;
          }
          count(key, alive);
        }
      } else if (eff === 3 || eff === 5) {
        if (eff === 5) volume = clampVol(volume + (y ? -y : x) * (pr.speed - 1));
        count(key, alive);
      } else if (eff === 4 || eff === 6) {
        if (eff === 4) { if (x) vibX = x; if (y) vibY = y; }
        else volume = clampVol(volume + (y ? -y : x) * (pr.speed - 1));
        const usable = alive && vibX > 0 && vibY > 0;
        if (usable) { c0!.vibrato = c0!.vibrato ?? { speed: vibX, depth: vibY, firstRow: i, rows: 0, period }; c0!.vibrato.rows++; }
        count(key, usable);
      } else if (eff === 0xa) {
        if (par !== 0) {
          const dv = (y ? -y : x);
          const before = volume;
          volume = clampVol(volume + dv * (pr.speed - 1));
          if (volume === 0 && alive && c0!.cutRow < 0) { c0!.cutRow = i; c0!.cutTick = Math.max(1, Math.min(pr.speed, Math.ceil(before / -dv))); }
          count(key, alive);
        }
      } else if (eff === 0xc) {
        if (volume === 0 && alive && c0!.cutRow < 0) { c0!.cutRow = i; c0!.cutTick = 0; }
        count(key, alive || volume === 0);
      } else if (eff === 0xb || eff === 0xd || eff === 0xf) {
        count(key, true);
      } else if (eff === 0xe) {
        if (sub === 1 || sub === 2) {
          if (subv !== 0) { if (alive) { period = Math.max(PERIOD_LOW, Math.min(PERIOD_HIGH, period + (sub === 1 ? -subv : subv))); slideSeconds += tickSec; } count(key, alive); }
        } else if (sub === 0xa || sub === 0xb) {
          if (subv !== 0) {
            volume = clampVol(volume + (sub === 0xa ? subv : -subv));
            if (volume === 0 && alive && c0!.cutRow < 0) { c0!.cutRow = i; c0!.cutTick = 0; }
            count(key, alive);
          }
        } else if (sub === 0xc) {
          if (alive && subv < pr.speed && c0!.cutRow < 0) { c0!.cutRow = i; c0!.cutTick = subv; }
          count(key, alive);
        } else if (sub === 0xd) { if (subv !== 0) count(key, true); }
        else if (sub === 0x6 || sub === 0xe) count(key, true);
        else count(key, false);
      } else if (eff === 7 || eff === 8 || eff === 9) count(key, false);
      if (c0 && alive) {
        const weight = (c0.cutRow === i ? c0.cutTick : ticksTotal) * tickSec;
        volSum += (rowStartVolume + volume) / 2 * weight; volWeight += weight;
      }
    }
    close(seq.seconds);
    out.push({ channel: c, notes: notes.filter((n) => !n.silent) });
  }
  return out;
}
