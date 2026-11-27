// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Shared back end of the MusicXML, GoatTracker and Furnace importers: monophonic note grids to SIDWave 1.3 text.

import yaml, { isMap, isScalar, isSeq } from "yaml";
import { SidwaveValidationError, midiToNoteName, parseSidwave } from "../sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg } from "../sidwaveCompiler.js";
import { InterchangeInputError } from "./errors.js";
import { IMPORT_DRUMS } from "./gm.js";

export class GridScoreError extends InterchangeInputError {
  constructor(message: string, yaml?: string) { super(message, yaml); this.name = "GridScoreError"; }
}

export interface GridCell {
  kind: "note" | "tie" | "rest";
  pitch?: number;
  /** One-letter kit key (see IMPORT_DRUMS) of a drum hit; only in a voice with `drum: true`. */
  drum?: string;
  /** SIDWave level 1..15 for this note; the voice's most common level is the voice level. */
  level?: number;
  /** Instrument name for this note; the voice's most common instrument is the voice default. */
  inst?: string;
  /** Glide to a pitch `to` semitones away over `frames` player calls. */
  bend?: { to: number; frames: number };
  /** Slide in register units per video frame (signed); resolved to a `bend` by `resolveMotion` once the length of the note is known. */
  slideRate?: number;
  /** Portamento in register units per video frame from the note of pitch `portaFrom`; resolved to `portamento` frames by `resolveMotion`. */
  portaRate?: number;
  portaFrom?: number;
  /** Glide from the previous note of the voice over `portamento` player calls without a new gate (`legato`). */
  portamento?: number;
  legato?: boolean;
  /** Player calls before the written end of the note at which the gate closes (SIDWave `gate_off`). */
  gateOff?: number;
  /** Per-note vibrato (SIDWave 1.3). */
  vibrato?: { depth: number; rate: number; delay?: number };
}
export interface GridVoice { name: string; role?: "bass"; drum?: boolean; cells: GridCell[] }
export interface GridBar { cells: number; /** SIDWave metre text such as "4/4". */ sig: string; tempo: number }
export interface GridScoreInput {
  title: string;
  author?: string;
  mode: "PAL" | "NTSC";
  /** Beats (quarter notes) per grid cell. */
  grid: number;
  bars: GridBar[];
  voices: GridVoice[];
  instruments: Record<string, Record<string, unknown>>;
  /** Comment lines at the top of the file (without the leading #). */
  header: string[];
  /** true: parse and compile the result; "parse": parse and arrange the score (every timing and pitch check of the compiler, without assembling the player; see `needsCompile`); false: no check. */
  validate: boolean | "parse";
  /** Player calls per video frame (SIDWave `speed`), default 1. */
  speed?: number;
  /** SIDs of a multi-SID score. Voices fill them three at a time in order. */
  sids?: Array<{ id: string; address: string }>;
  /** Extra top-level keys, for example `samples` of a score with digi drums. */
  extra?: Record<string, unknown>;
}

type Token = string | Record<string, unknown>;

function tokens(cells: GridCell[], voiceLevel: number, voiceInst: string | undefined): Token[] | string {
  const items: Token[] = cells.map((cell) => {
    if (cell.kind === "rest") return "-";
    if (cell.kind === "tie") return "~";
    const name = midiToNoteName(cell.pitch!);
    const level = cell.level !== undefined && cell.level !== voiceLevel ? cell.level : undefined;
    const inst = cell.inst !== undefined && cell.inst !== voiceInst ? cell.inst : undefined;
    if (level === undefined && !cell.bend && inst === undefined && cell.portamento === undefined && !cell.legato && cell.gateOff === undefined && !cell.vibrato) return name;
    return {
      note: name, ...(inst === undefined ? {} : { inst }), ...(level === undefined ? {} : { level }), ...(cell.bend ? { bend: cell.bend } : {}),
      ...(cell.legato ? { legato: true } : {}), ...(cell.portamento === undefined ? {} : { portamento: cell.portamento }),
      ...(cell.gateOff === undefined ? {} : { gate_off: cell.gateOff }), ...(cell.vibrato ? { vibrato: cell.vibrato } : {}),
    };
  });
  return items.every((item) => typeof item === "string") ? (items as string[]).join(" ") : items;
}

const mostCommon = <T>(values: T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Builds SIDWave 1.3 text from per-voice cells. Sections break at every tempo or metre change and after 4 bars. */
export function buildGridScore(input: GridScoreInput): string {
  const { bars, voices, grid } = input;
  const starts: number[] = [];
  let total = 0;
  for (const bar of bars) { starts.push(total); total += bar.cells; }
  const levelOf = voices.map((v) => mostCommon(v.cells.filter((c) => c.kind === "note" && c.level !== undefined).map((c) => c.level!)) ?? 15);
  const instOf = voices.map((v) => mostCommon(v.cells.filter((c) => c.kind === "note" && c.inst !== undefined).map((c) => c.inst!)));
  const kitOf = voices.map((v) => [...new Set(v.cells.filter((c) => c.drum).map((c) => c.drum!))].sort());
  const patternNames: Array<Map<string, string>> = voices.map(() => new Map());
  const patterns: Array<Record<string, unknown>> = voices.map(() => ({}));
  const timeline: Array<Record<string, unknown>> = [];
  const firstTempo = bars[0]!.tempo;
  const songSig = bars[0]!.sig;
  let sectionNo = 0;
  for (let b = 0; b < bars.length;) {
    const bar = bars[b]!;
    let count = 1;
    while (b + count < bars.length && count < 4 && bars[b + count]!.sig === bar.sig && bars[b + count]!.tempo === bar.tempo && bars[b + count]!.cells === bar.cells) count++;
    const first = starts[b]!;
    const last = starts[b + count - 1]! + bars[b + count - 1]!.cells;
    const layers: Record<string, string> = {};
    for (const [i, voice] of voices.entries()) {
      const slice = voice.cells.slice(first, last);
      if (slice.every((cell) => cell.kind === "rest")) { layers[`v${i + 1}`] = "-"; continue; }
      const encoded = voice.drum ? slice.map((cell) => (cell.kind === "note" ? cell.drum! : ".")).join("") : tokens(slice, levelOf[i]!, instOf[i]);
      const key = JSON.stringify([encoded, count]);
      let name = patternNames[i]!.get(key);
      if (!name) {
        name = `p${patternNames[i]!.size + 1}`;
        patternNames[i]!.set(key, name);
        patterns[i]![name] = voice.drum ? { length: grid, bars: count, drums: { kit: kitMap(kitOf[i]!), steps: encoded } } : { length: grid, bars: count, groove: encoded };
      }
      layers[`v${i + 1}`] = name;
    }
    sectionNo++;
    timeline.push({ section: `s${sectionNo}`, bars: count, ...(bar.sig !== songSig ? { meter: bar.sig } : {}), ...(bar.tempo !== firstTempo ? { tempo: bar.tempo } : {}), layers });
    b += count;
  }
  const voiceDefs = voices.map((v, i) => ({
    id: i + 1, name: v.name.slice(0, 40),
    ...(v.drum ? { role: "drums" } : { ...(instOf[i] ? { instrument: instOf[i] } : {}), ...(v.role ? { role: v.role } : {}) }),
    ...(levelOf[i] !== 15 ? { level: levelOf[i] } : {}), patterns: patterns[i],
  }));
  const doc: Record<string, unknown> = {
    sidwave: 1.3, title: input.title.slice(0, 80) || "Imported", ...(input.author ? { author: input.author.slice(0, 80) } : {}),
    tempo: firstTempo, mode: input.mode, ...(songSig === "4/4" ? {} : { meter: songSig === "3/4" ? 3 : songSig }),
    ...(input.speed && input.speed > 1 ? { speed: input.speed } : {}),
    ...(input.sids ? { sids: input.sids } : {}), ...(input.extra ?? {}),
    ...(Object.keys(input.instruments).length ? { instruments: input.instruments } : {}),
    voices: voiceDefs, timeline,
  };
  const document = new yaml.Document(doc);
  yaml.visit(document, {
    Pair(_key, pair) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      if (key !== "groove" && key !== "adsr" && key !== "bend" && key !== "vibrato") return;
      const flow = (node: unknown): void => {
        if (isSeq(node)) { node.flow = true; node.items.forEach(flow); } else if (isMap(node)) { node.flow = true; node.items.forEach((item) => flow(item.value)); }
      };
      flow(pair.value);
    },
  });
  const text = `${input.header.map((line) => `# ${line}`).join("\n")}\n${document.toString({ lineWidth: 0, flowCollectionPadding: false })}`;
  if (input.validate) {
    try { const parsed = parseSidwave(structuredClone(doc)); if (input.validate === true) compileSidwaveToPrg(parsed); else arrangeSidwave(parsed); } catch (error) {
      if (error instanceof SidwaveValidationError) throw new GridScoreError(`the imported score is not accepted by SIDWave (${error.message})`, text);
      throw error;
    }
  }
  return text;
}

function kitMap(letters: string[]): Record<string, string> {
  const byLetter = new Map(Object.values(IMPORT_DRUMS).map((d) => [d.letter, d.lib]));
  return Object.fromEntries(letters.map((letter) => [letter, `lib:${byLetter.get(letter)!}`]));
}

const SUPPORTED_SIGNATURES = new Set(["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "9/8", "12/8"]);
const SIGNATURES_BY_BEATS: Record<string, string> = { "2": "2/4", "3": "3/4", "4": "4/4", "5": "5/4", "3.5": "7/8", "4.5": "9/8", "6": "12/8" };
/** SIDWave metre text for a time signature, or undefined when no SIDWave metre has the same bar length. */
export function sidwaveMetre(numerator: number, denominator: number): { text: string; sidwave: string; beats: number } | undefined {
  const text = `${numerator}/${denominator}`;
  const beats = numerator * 4 / denominator;
  if (SUPPORTED_SIGNATURES.has(text)) return { text, sidwave: text, beats };
  const equal = SIGNATURES_BY_BEATS[String(beats)];
  return equal ? { text, sidwave: equal, beats } : undefined;
}

/** A note already quantised to grid cells (`e` exclusive). */
export interface QuantisedNote { s: number; e: number; pitch: number; vel: number; inst?: string }
export interface ReducedVoice { cells: GridCell[]; notes: number; droppedPolyphony: number; truncated: number; octaveShifted: number }

/**
 * Reduces possibly overlapping notes to one voice: the highest note wins, the lowest in a bass part; a held note stays
 * until a winning note starts. Pitches are moved by octaves into 12..maxMidi.
 */
export function reduceMonophonic(notes: QuantisedNote[], totalCells: number, bass: boolean, maxMidi: number): ReducedVoice {
  const out: ReducedVoice = { cells: Array.from({ length: totalCells }, () => ({ kind: "rest" as const })), notes: 0, droppedPolyphony: 0, truncated: 0, octaveShifted: 0 };
  const sorted = [...notes].sort((a, b) => a.s - b.s || a.pitch - b.pitch);
  const better = (a: QuantisedNote, b: QuantisedNote) => (bass ? a.pitch < b.pitch : a.pitch > b.pitch);
  let idx = 0;
  let current: QuantisedNote | undefined;
  const picks: QuantisedNote[] = [];
  for (let c = 0; c < totalCells; c++) {
    const starting: QuantisedNote[] = [];
    while (idx < sorted.length && sorted[idx]!.s === c) starting.push(sorted[idx++]!);
    if (current && current.e <= c) current = undefined;
    if (!current && starting.length === 0) continue;
    let best: QuantisedNote | undefined = current;
    for (const candidate of starting) {
      if (!best) best = candidate;
      else if (candidate.pitch === current?.pitch) best = candidate;
      else if (better(candidate, best)) best = candidate;
    }
    if (best === current) out.droppedPolyphony += starting.length;
    else {
      if (current && current.e > c) out.truncated++;
      out.droppedPolyphony += starting.length - 1;
      current = best!;
      picks.push(current);
    }
  }
  out.notes = picks.length;
  for (const [k, n] of picks.entries()) {
    const next = picks[k + 1];
    const end = Math.min(n.e, next ? next.s : n.e);
    let pitch = n.pitch;
    while (pitch < 12) pitch += 12;
    while (pitch > maxMidi) pitch -= 12;
    if (pitch !== n.pitch) out.octaveShifted++;
    out.cells[n.s] = { kind: "note", pitch, level: Math.max(1, Math.min(15, Math.round(15 * n.vel / 127))), ...(n.inst ? { inst: n.inst } : {}) };
    for (let c = n.s + 1; c < end; c++) out.cells[c] = { kind: "tie" };
  }
  return out;
}

/**
 * True when the compiler could reject the score for table size: the compiled player holds at most 255 wavetable, pulse and
 * filter steps over all instrument variants, and a voice that uses an instrument gets its own variant. When every voice
 * stays below that worst case, parsing the score is enough as a check and the (slower) compile is skipped.
 */
export function needsCompile(voices: GridVoice[], instruments: Record<string, Record<string, unknown>>): boolean {
  const size = (def: Record<string, unknown> | undefined, key: string): number => {
    const v = def?.[key];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps)) return (v as { steps: unknown[] }).steps.length;
    return 0;
  };
  const total = { wavetable: 0, pulsetable: 0, filtertable: 0 };
  for (const voice of voices) {
    const used = new Set<string>();
    for (const c of voice.cells) if (c.inst) used.add(c.inst);
    for (const name of used) for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += size(instruments[name], key);
  }
  return total.wavetable > 200 || total.pulsetable > 200 || total.filtertable > 200 || voices.reduce((n, v) => n + new Set(v.cells.map((c) => c.inst).filter(Boolean)).size, 0) > 50;
}

/** SID frequency register value of a MIDI note (equal temperament, A4 = 440 Hz). */
export const registerOfMidi = (midi: number, mode: "PAL" | "NTSC"): number => (440 * 2 ** ((midi - 69) / 12) * 16777216) / (mode === "PAL" ? 985248 : 1022727);

/**
 * Target note of a slide that adds `perFrame` register units per video frame for `frames` frames to `pitch`, as a SIDWave
 * `bend` target. Undefined when the slide moves less than half a semitone (SIDWave bends to whole semitones).
 */
export function slideTarget(pitch: number, perFrame: number, frames: number, mode: "PAL" | "NTSC", maxMidi: number): number | undefined {
  if (!perFrame || frames < 1) return undefined;
  const from = registerOfMidi(pitch, mode), to = from + perFrame * frames;
  if (to <= 0) return maxMidi - pitch > 48 ? undefined : Math.max(12, pitch - 48);
  const semis = Math.max(-48, Math.min(48, Math.round(12 * Math.log2(to / from))));
  const target = Math.max(12, Math.min(maxMidi, pitch + semis));
  return target === pitch ? undefined : target;
}

/** Video frames a portamento of `perFrame` register units per frame needs from one note to the next (1..255). */
export function portamentoFrames(from: number, to: number, perFrame: number, mode: "PAL" | "NTSC"): number {
  if (perFrame <= 0) return 0;
  return Math.max(1, Math.min(255, Math.ceil(Math.abs(registerOfMidi(to, mode) - registerOfMidi(from, mode)) / perFrame)));
}

/**
 * SIDWave rejects a bend on an instrument whose wavetable sets pitches. Removes those bends and returns how many were removed.
 * Call after the instrument names of the cells are final.
 */
export function dropBendsOnPitchTables(voices: GridVoice[], instruments: Record<string, Record<string, unknown>>): number {
  let dropped = 0;
  const pitched = (name: string): boolean => {
    const wt = instruments[name]?.wavetable;
    return Array.isArray(wt) && wt.some((step) => step && typeof step === "object" && "note" in step);
  };
  for (const voice of voices) for (const c of voice.cells) if (c.bend && (!c.inst || pitched(c.inst))) { delete c.bend; dropped++; }
  return dropped;
}

/**
 * Number of legato notes whose instrument differs from the one that is sounding. A SIDWave legato note keeps the sounding
 * instrument, so such a change (a tracker command on a continuing note) is not heard.
 */
export function ignoredInstrumentChanges(voices: GridVoice[]): number {
  let ignored = 0;
  for (const voice of voices) {
    let sounding: string | undefined;
    for (const c of voice.cells) {
      if (c.kind === "rest") sounding = undefined;
      else if (c.kind === "note") {
        if (c.legato && sounding !== undefined) { if (c.inst !== sounding) ignored++; } else sounding = c.inst;
      }
    }
  }
  return ignored;
}

/**
 * Turns slide and portamento rates into SIDWave `bend` and `portamento` once the grid is final. A bend or glide has to reach
 * its target while the note sounds, so its length is limited to the frames of the note (ties included) minus the two frames
 * of the hard restart and two more of margin (SIDWave requires the glide to end before the note does). `frameStart[k]` is the video frame at which tick k starts. Bends on instruments whose wavetable
 * sets pitches are dropped, because SIDWave rejects them. Returns the numbers of bends dropped for that reason.
 */
export function resolveMotion(voices: GridVoice[], frameStart: number[], instruments: Record<string, Record<string, unknown>>, mode: "PAL" | "NTSC", maxMidi: number): { pitchedBends: number; tooSmall: number } {
  const out = { pitchedBends: 0, tooSmall: 0 };
  const pitched = (name: string | undefined): boolean => {
    const wt = name ? instruments[name]?.wavetable : undefined;
    return Array.isArray(wt) && wt.some((step) => step && typeof step === "object" && "note" in step);
  };
  const ticks = frameStart.length - 1;
  for (const voice of voices) {
    const cells = voice.cells;
    // A legato note keeps the sounding instrument, so that is the instrument a bend on it plays on.
    let sounding: string | undefined;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (c.kind === "rest") sounding = undefined;
      else if (c.kind === "note" && !(c.legato && sounding !== undefined)) sounding = c.inst;
      if (c.slideRate === undefined && c.portaRate === undefined) continue;
      let j = i + 1;
      while (j < cells.length && cells[j]!.kind === "tie") j++;
      const duration = Math.min(255, frameStart[Math.min(j, ticks)]! - frameStart[Math.min(i, ticks)]! - 4);
      if (c.portaRate !== undefined && c.portaFrom !== undefined && duration >= 1) {
        const n = Math.min(portamentoFrames(c.portaFrom, c.pitch!, c.portaRate, mode), duration);
        if (n >= 1) c.portamento = n;
      } else if (c.slideRate !== undefined && duration >= 1) {
        const onPitchTable = pitched(c.inst) || pitched(sounding);
        const target = onPitchTable ? undefined : slideTarget(c.pitch!, c.slideRate, duration, mode, maxMidi);
        if (target !== undefined) c.bend = { to: target - c.pitch!, frames: duration };
        else if (onPitchTable) out.pitchedBends++; else out.tooSmall++;
      }
      delete c.slideRate; delete c.portaRate; delete c.portaFrom;
    }
  }
  return out;
}
