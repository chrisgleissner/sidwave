// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Shared back end of the MusicXML, GoatTracker and Furnace importers: monophonic note grids to SIDWave 1.3 text.

import yaml, { isMap, isScalar, isSeq } from "yaml";
import { SidwaveValidationError, midiToNoteName, parseSidwave } from "../sidwave.js";
import { compileSidwaveToPrg } from "../sidwaveCompiler.js";
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
  validate: boolean;
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
    try { compileSidwaveToPrg(parseSidwave(text)); } catch (error) {
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
