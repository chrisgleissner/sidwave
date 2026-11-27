// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// ABC import: expands the repeats of each voice, places notes, ties, tempo and metre changes on a common timeline and
// writes the score through the shared grid score builder. The reader of the text is abc.ts.

import { AbcImportError, parseAbcTune, type AbcBar, type AbcMeter, type AbcSkip, type AbcVoice } from "./abc.js";
import { buildGridScore, reduceMonophonic, sidwaveMetre, type GridBar, type GridVoice, type QuantisedNote } from "./gridScore.js";
import { InterchangeInputError } from "./errors.js";
import { maxSidwaveMidi } from "../sidwaveCompiler.js";
import { SIDWAVE_TEMPO_RANGE } from "../sidwave.js";

export { AbcImportError } from "./abc.js";

export interface AbcOptions {
  title?: string;
  /** X: number of the tune; default: the first tune of the file. */
  song?: number;
  /** Quantisation grid in quarter-note beats. Default 0.25. */
  grid?: number;
  voices?: number;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
}
export interface AbcImportResult {
  yaml: string;
  report: { format: "abc"; tune: string; title?: string; voices: string[]; notes: number; bars: number; gridBeats: number; losses: string[] };
  losses: string[];
}

const MAX_EXPANDED_BARS = 8192;
const MAX_EXPANDED_TONES = 400_000;
const MAX_SCORE_BARS = 4096;
const MAX_CELLS = 400_000;
const EPSILON = 1e-6;

/**
 * Playback order of the bars of a voice. A repeat without `|:` starts after the previous repeat or double bar, or at the
 * start; a variant ending applies up to the next ending, repeat sign or double bar and plays on its passes only.
 */
function expandRepeats(bars: AbcBar[]): AbcBar[] {
  const endings: Array<number[] | undefined> = [];
  let open: number[] | undefined;
  for (const bar of bars) {
    if (bar.startRepeat) open = undefined;
    if (bar.ending) open = bar.ending;
    endings.push(open);
    if (bar.endRepeat || bar.sectionEnd) open = undefined;
  }
  // The highest pass named by the ending of a bar or by an ending that follows it in the same chain.
  const highest: number[] = [];
  for (let i = bars.length - 1; i >= 0; i--) highest[i] = endings[i] ? Math.max(highest[i + 1] ?? 0, ...endings[i]!) : 0;
  const out: AbcBar[] = [];
  let tones = 0;
  let start = 0, pass = 1;
  let explicit = false;
  for (let i = 0; i < bars.length;) {
    const bar = bars[i]!;
    if (bar.startRepeat) {
      if (i !== start) { start = i; pass = 1; }
      explicit = true;
    }
    const set = endings[i];
    if (set && !set.includes(pass)) { i++; continue; }
    out.push(bar);
    for (const event of bar.events) tones += Math.max(1, event.tones.length);
    if (out.length > MAX_EXPANDED_BARS || tones > MAX_EXPANDED_TONES) {
      throw new AbcImportError(`the expanded ABC repeats exceed ${MAX_EXPANDED_BARS} bars or ${MAX_EXPANDED_TONES} notes and rests`);
    }
    if (bar.endRepeat) {
      if (pass <= bar.endRepeat || highest[i]! > pass) { pass++; i = start; continue; }
      start = i + 1; pass = 1; explicit = false;
    } else if (bar.sectionEnd && (set ? pass > 1 : !explicit)) {
      start = i + 1; pass = 1; explicit = false;
    }
    i++;
  }
  return out;
}

interface Note { start: number; end: number; pitch: number; lane: number }
interface Change { at: number; tempo?: number; meter?: AbcMeter }
interface Timeline { id: string; notes: Note[]; changes: Change[]; firstBar: number; bars: number; end: number; lostTies: number }

const sameMeter = (a: AbcMeter, b: AbcMeter): boolean => a.num === b.num && a.den === b.den && a.free === b.free;

/** Notes in beats from the start of the tune; tied notes are joined after the repeats are expanded. */
function timeline(voice: AbcVoice, tempo: number, meter: AbcMeter): Timeline {
  const notes: Note[] = [];
  const changes: Change[] = [];
  const bars = expandRepeats(voice.bars);
  let at = 0, firstBar = 0, lostTies = 0;
  let tied = new Map<number, Note>();
  const change = (next: { tempo?: number; meter?: AbcMeter }): void => {
    if (next.tempo !== undefined && next.tempo !== tempo) { tempo = next.tempo; changes.push({ at, tempo }); }
    if (next.meter && !sameMeter(next.meter, meter)) { meter = next.meter; changes.push({ at, meter }); }
  };
  for (const [index, bar] of bars.entries()) {
    change(bar);
    for (const event of bar.events) {
      if (event.beats === 0) { change(event); continue; }
      const next = new Map<number, Note>();
      // Lane 0 is the highest note of a chord, so that it survives when the voices run out.
      const tones = event.tones.length > 1 ? [...event.tones].sort((a, b) => b.pitch - a.pitch) : event.tones;
      for (const [lane, tone] of tones.entries()) {
        let note = tied.get(tone.pitch);
        if (note) { tied.delete(tone.pitch); note.end = at + tone.beats; }
        else { note = { start: at, end: at + tone.beats, pitch: tone.pitch, lane }; notes.push(note); }
        if (tone.tie) next.set(tone.pitch, note);
      }
      lostTies += tied.size;
      tied = next;
      at += event.beats;
    }
    if (index === 0) firstBar = at;
  }
  lostTies += tied.size;
  const end = notes.reduce((max, note) => Math.max(max, note.end), at);
  return { id: voice.id, notes, changes, firstBar, bars: bars.length, end, lostTies };
}

/** The SIDWave metre of a written metre: the same bar length, two written bars, or 4/4. */
function scoreMeter(meter: AbcMeter): { sig: string; beats: number; approximated?: string } {
  const text = `${meter.num}/${meter.den}`;
  if (meter.free) return { sig: "4/4", beats: 4 };
  const mapped = sidwaveMetre(meter.num, meter.den) ?? sidwaveMetre(meter.num * 2, meter.den) ?? { sidwave: "4/4", beats: 4 };
  return { sig: mapped.sidwave, beats: mapped.beats, ...(mapped.sidwave === text ? {} : { approximated: text }) };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Imports one tune of an ABC file as SIDWave text. See doc/interchange.md. */
export function importAbc(bytes: Uint8Array, options: AbcOptions = {}): AbcImportResult {
  const grid = options.grid ?? 0.25;
  if (!(grid >= 1 / 48 && grid <= 4)) throw new AbcImportError("grid must be between 1/48 and 4 beats");
  const voiceLimit = options.voices ?? 3;
  if (!Number.isInteger(voiceLimit) || voiceLimit < 1 || voiceLimit > 3) throw new AbcImportError("voices must be 1, 2 or 3");
  const mode = options.mode ?? "PAL";
  const tune = parseAbcTune(bytes, options.song);
  const losses: string[] = [];
  const skip = (kind: AbcSkip, sentence: (n: number) => string): void => {
    const n = tune.skipped.get(kind);
    if (n) losses.push(sentence(n));
  };

  let expandedTones = 0;
  const voices = tune.voices.map((voice) => {
    const result = timeline(voice, tune.tempo, tune.meter);
    expandedTones += result.notes.length;
    if (expandedTones > MAX_EXPANDED_TONES) throw new AbcImportError(`the expanded ABC tune has more than ${MAX_EXPANDED_TONES} notes`);
    return result;
  });

  // A short first bar is a pickup: rest before it keeps the later bar lines on the bar lines of the score.
  const firstBar = voices.reduce((max, v) => Math.max(max, v.firstBar), 0);
  const opening = tune.voices[0]!.bars[0]!.meter;
  const pickup = !opening.free && firstBar < opening.beats - EPSILON && voices.some((v) => v.bars > 1);
  const pad = pickup ? scoreMeter(opening).beats - firstBar : 0;
  if (pickup) losses.push(`A pickup bar of ${round3(firstBar)} beats is preceded by ${round3(pad)} beats of rest so that the bar lines line up.`);
  const end = pad + voices.reduce((max, v) => Math.max(max, v.end), 0);
  if (!(end <= MAX_CELLS * grid)) throw new AbcImportError(`the ABC tune has more than ${MAX_CELLS} score grid cells`);

  // Bars of the score, with the tempo and metre in effect at each bar line.
  // A change at the first note applies to the first bar, before the rest that precedes a pickup.
  const changes = voices.flatMap((v) => v.changes).map((c) => ({ ...c, at: c.at > EPSILON ? c.at + pad : 0 })).sort((a, b) => a.at - b.at);
  const bars: GridBar[] = [];
  const approximated = new Set<string>();
  const limited = new Set<number>();
  let tempo = tune.tempo, meter = tune.meter;
  let next = 0, movedTempos = 0, movedMeters = 0, position = 0, totalCells = 0;
  while (position < end - EPSILON || !bars.length) {
    for (; next < changes.length && changes[next]!.at <= position + EPSILON; next++) {
      const change = changes[next]!;
      const late = change.at < position - EPSILON;
      if (change.tempo !== undefined) { tempo = change.tempo; if (late) movedTempos++; }
      if (change.meter) { meter = change.meter; if (late) movedMeters++; }
    }
    const mapped = scoreMeter(meter);
    if (mapped.approximated) approximated.add(`${mapped.approximated} time signature is approximated by ${mapped.sig}.`);
    const cells = Math.round(mapped.beats / grid);
    if (Math.abs(mapped.beats / grid - cells) > EPSILON || cells < 1) {
      throw new AbcImportError(`the grid of ${grid} beats does not divide a ${mapped.sig} bar (${mapped.beats} beats); choose a grid such as 0.25, 0.125 or 0.5`);
    }
    const bpm = Math.round(Math.max(SIDWAVE_TEMPO_RANGE.min, Math.min(SIDWAVE_TEMPO_RANGE.max, tempo)) * 100) / 100;
    if (Math.abs(bpm - tempo) > 0.005 + EPSILON) limited.add(tempo);
    bars.push({ cells, sig: mapped.sig, tempo: bpm });
    position += mapped.beats;
    totalCells += cells;
    if (bars.length > MAX_SCORE_BARS || totalCells > MAX_CELLS) throw new AbcImportError(`the ABC tune has more than ${MAX_SCORE_BARS} bars or ${MAX_CELLS} grid cells`);
  }

  // Voices: the first lane of every ABC voice, then the further chord lanes.
  const candidates = voices.flatMap((voice, index) => {
    const lanes: Note[][] = [];
    for (const note of voice.notes) (lanes[note.lane] ??= []).push(note);
    return lanes.flatMap((notes, lane) => (notes ? [{ voice, index, lane, notes }] : []));
  });
  candidates.sort((a, b) => a.lane - b.lane || a.index - b.index);
  const chosen = candidates.slice(0, voiceLimit).sort((a, b) => a.index - b.index || a.lane - b.lane);
  const dropped = candidates.slice(voiceLimit);
  const kept = new Set(chosen.map((c) => c.index));
  const droppedTones = dropped.filter((c) => kept.has(c.index)).reduce((n, c) => n + c.notes.length, 0);
  const droppedVoices = voices.length - kept.size;

  const maxMidi = maxSidwaveMidi(mode);
  let moved = 0, polyphony = 0, shifted = 0;
  const outputVoices: GridVoice[] = chosen.map(({ voice, lane, notes }) => {
    const quantised: QuantisedNote[] = notes.map((note) => {
      const from = (note.start + pad) / grid, to = (note.end + pad) / grid;
      const s = Math.max(0, Math.min(totalCells - 1, Math.round(from + EPSILON)));
      const e = Math.max(s + 1, Math.min(totalCells, Math.round(to + EPSILON)));
      if (Math.abs(from - s) > 1e-5 || Math.abs(to - e) > 1e-5) moved++;
      return { s, e, pitch: note.pitch, vel: 127 };
    });
    const reduced = reduceMonophonic(quantised, totalCells, false, maxMidi);
    polyphony += reduced.droppedPolyphony;
    shifted += reduced.octaveShifted;
    return { name: (lane === 0 ? voice.id : `${voice.id}-chord${lane + 1}`).slice(0, 40), cells: reduced.cells };
  });

  const title = options.title ?? tune.title ?? "Imported ABC";
  const lostTies = (tune.skipped.get("ties") ?? 0) + voices.reduce((n, v) => n + v.lostTies, 0);
  skip("chords", (n) => `${n} ABC chord(s) are reduced to simultaneous SID voice lanes.`);
  if (droppedTones) losses.push(`${droppedTones} ABC chord tone(s) are dropped because the score has ${voiceLimit} voice(s).`);
  if (droppedVoices) losses.push(`${droppedVoices} ABC voice(s) are not imported because the score has ${voiceLimit} voice(s).`);
  if (polyphony) losses.push(`${polyphony} notes dropped because they sound together with another note (SID voices are monophonic).`);
  if (shifted) losses.push(`${shifted} ABC notes are outside the SIDWave pitch range and were moved by octaves.`);
  if (moved) losses.push(`${moved} ABC note(s) are moved or resized to fit the score grid.`);
  if (lostTies) losses.push(`${lostTies} ABC tie(s) could not be connected and are skipped.`);
  losses.push(...approximated);
  if (limited.size) losses.push(`${limited.size} ABC tempo value(s) are limited to the SIDWave range of ${SIDWAVE_TEMPO_RANGE.min} to ${SIDWAVE_TEMPO_RANGE.max} BPM.`);
  if (movedTempos) losses.push(`${movedTempos} ABC tempo change(s) fall inside a bar and take effect at the next bar line.`);
  if (movedMeters) losses.push(`${movedMeters} ABC metre change(s) fall inside a score bar and take effect at the next bar line.`);
  skip("grace", (n) => `${n} ABC grace note group(s) are skipped.`);
  skip("decorations", (n) => `${n} ABC decoration(s) are skipped.`);
  skip("slurs", (n) => `${n} ABC slur mark(s) are skipped.`);
  skip("annotations", (n) => `${n} ABC chord symbol(s) or annotation(s) are skipped.`);
  skip("lyrics", (n) => `${n} ABC lyric line(s) are skipped.`);
  skip("directives", (n) => `${n} ABC directive(s) or unsupported field(s) are skipped.`);
  skip("overlays", (n) => `${n} ABC voice overlay(s) (&) are skipped.`);
  skip("parts", (n) => `${n} ABC part field(s) (P:) are ignored; the tune plays in written order.`);
  const longMetadata = [title, tune.composer].filter((value) => value !== undefined && value.length > 80).length;
  if (longMetadata) losses.push(`${longMetadata} ABC title or composer field(s) are truncated to 80 characters.`);
  skip("charset", () => "The file is not UTF-8 and is read as Latin-1.");

  let yaml: string;
  try {
    yaml = buildGridScore({
      title, ...(tune.composer ? { author: tune.composer } : {}), mode, grid, bars, voices: outputVoices, instruments: {},
      header: ["Imported from ABC notation (2.1 subset) by SIDWave.", `Grid ${grid} beats; see the import report for what was dropped or moved.`],
      validate: options.validate !== false,
    });
  } catch (error) {
    if (error instanceof InterchangeInputError) throw new AbcImportError(`${error.message}; try a coarser grid (--grid 0.5)`, error.yaml);
    throw error;
  }
  return {
    yaml, losses,
    report: {
      format: "abc", tune: tune.number, ...(tune.title ? { title: tune.title } : {}), voices: voices.map((v) => v.id),
      notes: expandedTones, bars: bars.length, gridBeats: grid, losses,
    },
  };
}
