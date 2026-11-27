// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// MusicXML import: uncompressed partwise files become a SIDWave 1.3 score plus a report.

import { maxSidwaveMidi } from "../sidwaveCompiler.js";
import { IMPORT_DRUMS, instrumentForProgram, type ImportInstrument } from "./gm.js";
import { InterchangeInputError } from "./errors.js";
import { buildGridScore, reduceMonophonic, sidwaveMetre, type GridBar, type GridCell, type GridVoice, type QuantisedNote } from "./gridScore.js";
import { child, childText, childrenOf, parseXml, type XmlLimits, type XmlNode } from "./xml.js";

export class MusicXmlImportError extends InterchangeInputError {
  constructor(message: string, yaml?: string) { super(message, yaml); this.name = "MusicXmlImportError"; }
}

export interface MusicXmlImportOptions {
  title?: string;
  /** Quantisation grid in quarter-note beats. Default 0.25. */
  grid?: number;
  /** SIDWave voices to allocate, 1..3. Default 3. */
  voices?: number;
  drums?: boolean;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
  limits?: XmlLimits & { maxBars?: number; maxCells?: number; maxInputBytes?: number };
}

export interface MusicXmlImportReport {
  format: "musicxml-partwise";
  version?: string;
  gridBeats: number;
  bars: number;
  voices: Array<{ id: number; role: "drums" | "bass" | "melodic"; part: string; name?: string; instrument?: string; notes: number; droppedPolyphony: number; truncated: number; octaveShifted: number; droppedHits?: number }>;
  droppedParts: Array<{ part: string; name?: string; notes: number; reason: string }>;
  quantisation: { notes: number; moved: number; maxErrorBeats: number; meanErrorBeats: number; maxEndErrorBeats: number };
  tempoChanges: { total: number; movedToBarLine: number; clamped: number };
  timeSignatures: Array<{ bar: number; signature: string; sidwave: string }>;
  skipped: { graceNotes: number; cueNotes: number; unpitchedOutsideDrumPart: number; repeats: boolean };
  losses: string[];
  warnings: string[];
}
export interface MusicXmlImportResult { yaml: string; report: MusicXmlImportReport }

interface RawNote { beat: number; end: number; pitch: number; vel: number; program?: number; unpitchedKey?: number; unpitched: boolean }
interface RawMeasure { start: number; beats: number; sig: { numerator: number; denominator: number }; tempos: Array<{ beat: number; bpm: number }> }
interface RawPart { id: string; name?: string; measures: RawMeasure[]; notes: RawNote[]; defaultProgram?: number }

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const num = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const BEAT_UNITS: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };

function metronomeBpm(node: XmlNode): number | undefined {
  const unit = BEAT_UNITS[childText(node, "beat-unit") ?? ""];
  const perMinute = num(childText(node, "per-minute"));
  if (unit === undefined || perMinute === undefined) return undefined;
  return perMinute * unit * (child(node, "beat-unit-dot") ? 1.5 : 1);
}

/** Imports an uncompressed partwise MusicXML document as SIDWave text. See doc/interchange.md. */
export function importMusicXml(bytes: Uint8Array, options: MusicXmlImportOptions = {}): MusicXmlImportResult {
  const grid = options.grid ?? 0.25;
  if (!(grid >= 1 / 48 && grid <= 4)) throw new RangeError("grid must be between 1/48 and 4 beats");
  const voiceLimit = options.voices ?? 3;
  if (!Number.isInteger(voiceLimit) || voiceLimit < 1 || voiceLimit > 3) throw new RangeError("voices must be 1, 2 or 3 (one SID)");
  const mode = options.mode ?? "PAL";
  const maxBars = options.limits?.maxBars ?? 2048;
  const maxCells = options.limits?.maxCells ?? 400_000;
  const maxInput = options.limits?.maxInputBytes ?? 16 * 1024 * 1024;
  if (bytes.length > maxInput) throw new MusicXmlImportError(`the file has ${bytes.length} bytes; the limit is ${maxInput}`);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new MusicXmlImportError("compressed MusicXML (.mxl, a zip archive) is not supported; export an uncompressed .musicxml file from the notation program");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new MusicXmlImportError("the file is not UTF-8 text; MusicXML files are UTF-8 (UTF-16 is not supported)");
  }
  const root = parseXml(text, options.limits);
  if (root.name === "score-timewise") throw new MusicXmlImportError("score-timewise MusicXML is not supported; convert the file to partwise");
  if (root.name !== "score-partwise") throw new MusicXmlImportError(`the root element is <${root.name}>, not score-partwise`);
  const warnings: string[] = [];
  const losses: string[] = [];
  const skipped = { graceNotes: 0, cueNotes: 0, unpitchedOutsideDrumPart: 0, repeats: false };

  // Part list.
  const names = new Map<string, string>();
  const programs = new Map<string, Map<string, { program?: number; unpitched?: number }>>();
  const partList = child(root, "part-list");
  for (const sp of partList ? childrenOf(partList, "score-part") : []) {
    const id = sp.attrs.id ?? "";
    names.set(id, (childText(sp, "part-name") ?? "").trim());
    const map = new Map<string, { program?: number; unpitched?: number }>();
    for (const mi of childrenOf(sp, "midi-instrument")) {
      const program = num(childText(mi, "midi-program"));
      const unpitched = num(childText(mi, "midi-unpitched"));
      map.set(mi.attrs.id ?? "", { ...(program === undefined ? {} : { program: program - 1 }), ...(unpitched === undefined ? {} : { unpitched: unpitched - 1 }) });
    }
    programs.set(id, map);
  }

  // Parts. Positions are absolute quarter-note beats counted from the start of the part.
  const parts: RawPart[] = [];
  let totalNotes = 0;
  for (const partNode of childrenOf(root, "part")) {
    const id = partNode.attrs.id ?? `part${parts.length + 1}`;
    const instMap = programs.get(id) ?? new Map();
    const firstProgram = [...instMap.values()].find((v) => v.program !== undefined)?.program;
    const part: RawPart = { id, ...(names.get(id) ? { name: names.get(id)! } : {}), measures: [], notes: [], ...(firstProgram === undefined ? {} : { defaultProgram: firstProgram }) };
    let divisions = 1;
    let transpose = 0;
    let sig = { numerator: 4, denominator: 4 };
    let measureStart = 0;
    const open = new Map<number, RawNote>();
    for (const [mIndex, measure] of childrenOf(partNode, "measure").entries()) {
      const tempos: RawMeasure["tempos"] = [];
      let cursor = 0; // divisions
      let maxCursor = 0;
      let chordStart = 0;
      const firstNote = part.notes.length;
      for (const el of measure.children) {
        if (el.name === "attributes") {
          const d = num(childText(el, "divisions"));
          if (d !== undefined) { if (!(d > 0 && d <= 1_000_000)) throw new MusicXmlImportError(`invalid divisions ${d}`); divisions = d; }
          const time = child(el, "time");
          if (time) {
            const beats = childText(time, "beats");
            const type = num(childText(time, "beat-type"));
            if (beats === undefined || type === undefined || !/^\d+$/.test(beats)) throw new MusicXmlImportError(`measure ${mIndex + 1}: the time signature ${beats ?? "?"}/${type ?? "?"} (additive or free) is not supported`);
            sig = { numerator: Number(beats), denominator: type };
          }
          const tr = child(el, "transpose");
          if (tr) transpose = (num(childText(tr, "chromatic")) ?? 0) + 12 * (num(childText(tr, "octave-change")) ?? 0);
        } else if (el.name === "direction" || el.name === "sound") {
          const sound = el.name === "sound" ? el : child(el, "sound");
          const metronome = el.name === "direction" ? child(child(el, "direction-type") ?? el, "metronome") : undefined;
          const bpm = num(sound?.attrs.tempo) ?? (metronome ? metronomeBpm(metronome) : undefined);
          if (bpm !== undefined && bpm > 0) tempos.push({ beat: measureStart + cursor / divisions, bpm });
        } else if (el.name === "backup") {
          cursor -= num(childText(el, "duration")) ?? 0;
          if (cursor < 0) throw new MusicXmlImportError(`measure ${mIndex + 1}: a backup moves before the start of the measure`);
        } else if (el.name === "forward") {
          cursor += num(childText(el, "duration")) ?? 0;
          maxCursor = Math.max(maxCursor, cursor);
        } else if (el.name === "barline") {
          if (child(el, "repeat") || child(el, "ending")) skipped.repeats = true;
        } else if (el.name === "note") {
          const isChord = !!child(el, "chord");
          const duration = num(childText(el, "duration")) ?? 0;
          if (child(el, "grace")) { skipped.graceNotes++; continue; }
          const start = isChord ? chordStart : cursor;
          if (!isChord) chordStart = cursor;
          if (child(el, "cue")) skipped.cueNotes++;
          else {
            const pitch = child(el, "pitch");
            const unpitched = child(el, "unpitched");
            if (pitch || unpitched) {
              let midi = 0;
              if (pitch) {
                const step = STEP[childText(pitch, "step") ?? ""];
                const octave = num(childText(pitch, "octave"));
                if (step === undefined || octave === undefined) throw new MusicXmlImportError(`measure ${mIndex + 1}: a pitch has no valid step and octave`);
                midi = (octave + 1) * 12 + step + Math.round(num(childText(pitch, "alter")) ?? 0) + transpose;
              }
              const info = instMap.get(child(el, "instrument")?.attrs.id ?? "");
              const dyn = num(el.attrs.dynamics);
              const beat = measureStart + start / divisions;
              const end = measureStart + (start + duration) / divisions;
              const ties = childrenOf(el, "tie").map((t) => t.attrs.type);
              const previous = pitch && ties.includes("stop") ? open.get(midi) : undefined;
              let noteObj: RawNote;
              if (previous && Math.abs(previous.end - beat) < 1e-6) { previous.end = end; noteObj = previous; }
              else {
                noteObj = { beat, end, pitch: midi, vel: dyn === undefined ? 127 : Math.max(1, Math.min(127, Math.round(dyn * 0.9))), unpitched: !!unpitched,
                  ...(info?.program === undefined ? {} : { program: info.program }), ...(info?.unpitched === undefined ? {} : { unpitchedKey: info.unpitched }) };
                part.notes.push(noteObj);
                totalNotes++;
                if (totalNotes > 2_000_000) throw new MusicXmlImportError("the file has more than 2,000,000 notes");
              }
              if (pitch) { if (ties.includes("start")) open.set(midi, noteObj); else open.delete(midi); }
            }
          }
          if (!isChord) { cursor += duration; maxCursor = Math.max(maxCursor, cursor); }
        }
      }
      let beats = sig.numerator * 4 / sig.denominator;
      const content = maxCursor / divisions;
      if (mIndex === 0 && measure.attrs.implicit === "yes" && content > 0 && content < beats - 1e-9) {
        // A pickup measure is padded with a rest at its start so that the bars line up.
        const pad = beats - content;
        for (let i = firstNote; i < part.notes.length; i++) { part.notes[i]!.beat += pad; part.notes[i]!.end += pad; }
        warnings.push(`Measure 1 is a pickup of ${Math.round(content * 1000) / 1000} beats; it is padded with ${Math.round(pad * 1000) / 1000} beats of rest so that it fills a bar.`);
      } else if (mIndex > 0 && Math.abs(content - beats) > 1e-6 && content > 0 && mIndex < childrenOf(partNode, "measure").length - 1) {
        warnings.push(`Measure ${mIndex + 1} of part ${id} holds ${Math.round(content * 1000) / 1000} beats but the time signature gives ${beats}; later bars may be misaligned.`);
      }
      if (beats <= 0) beats = 4;
      part.measures.push({ start: measureStart, beats, sig: { ...sig }, tempos });
      measureStart += beats;
      if (part.measures.length > maxBars) throw new MusicXmlImportError(`the piece has more than ${maxBars} bars`);
    }
    if (part.measures.length) parts.push(part);
  }
  if (parts.length === 0) throw new MusicXmlImportError("the MusicXML file has no <part> with measures");
  const reference = parts.reduce((best, p) => (p.measures.length > best.measures.length ? p : best), parts[0]!);
  for (const p of parts) if (p.measures.length !== reference.measures.length) warnings.push(`Part ${p.id} has ${p.measures.length} measures; part ${reference.id} has ${reference.measures.length}. The longest part sets the bars.`);

  // Bars.
  const bars: GridBar[] = [];
  const barBeats: number[] = [];
  const signatureReport: MusicXmlImportReport["timeSignatures"] = [];
  const allTempos = parts.flatMap((p) => p.measures.flatMap((m) => m.tempos)).sort((a, b) => a.beat - b.beat);
  let movedTempos = 0, clamped = 0;
  let lastSig = "";
  let tempoIdx = 0;
  let tempoNow = 120;
  const tempoFor = (start: number): number => { // bar starts increase, so one forward pass over the sorted tempos suffices
    while (tempoIdx < allTempos.length && allTempos[tempoIdx]!.beat <= start + 1e-6) tempoNow = allTempos[tempoIdx++]!.bpm;
    return tempoNow;
  };
  for (const [i, m] of reference.measures.entries()) {
    const metre = sidwaveMetre(m.sig.numerator, m.sig.denominator);
    if (!metre) throw new MusicXmlImportError(`measure ${i + 1}: the time signature ${m.sig.numerator}/${m.sig.denominator} (${m.beats} quarter notes per bar) has no SIDWave equivalent`);
    const perBar = m.beats / grid;
    if (Math.abs(perBar - Math.round(perBar)) > 1e-9) throw new MusicXmlImportError(`the grid of ${grid} beats does not divide a ${metre.text} bar (${m.beats} beats); choose a grid such as 0.25, 0.125 or 0.5`);
    if (metre.text !== lastSig) { signatureReport.push({ bar: i + 1, signature: metre.text, sidwave: metre.sidwave }); lastSig = metre.text; }
    const raw = tempoFor(m.start);
    const bpm = Math.round(Math.max(30, Math.min(220, raw)) * 100) / 100;
    if (bpm !== Math.round(raw * 100) / 100) clamped++;
    bars.push({ cells: Math.round(perBar), sig: metre.sidwave, tempo: bpm });
    barBeats.push(m.start);
  }
  if (!allTempos.length) warnings.push("The file has no tempo; 120 BPM is assumed.");
  const startKeys = new Set(reference.measures.map((m) => Math.round(m.start * 1e6)));
  for (const t of allTempos) if (!startKeys.has(Math.round(t.beat * 1e6))) movedTempos++;
  if (movedTempos) losses.push(`${movedTempos} tempo change(s) fall inside a bar; SIDWave tempo changes at section starts, so each takes effect at the next bar line.`);
  const totalCells = bars.reduce((n, b) => n + b.cells, 0);
  if (totalCells > maxCells) throw new MusicXmlImportError(`the piece has more than ${maxCells} grid cells`);
  if (signatureReport.some((s) => s.signature !== s.sidwave)) losses.push("A time signature without a SIDWave equivalent is written with a SIDWave metre of the same bar length.");

  // Quantise and allocate.
  let moved = 0, noteTotal = 0, errSum = 0, errMax = 0, endErrMax = 0;
  const quantise = (n: RawNote): QuantisedNote & { unpitched: boolean; key?: number; program?: number } => {
    const sf = n.beat / grid, ef = n.end / grid;
    const s0 = Math.round(sf);
    noteTotal++;
    const err = Math.abs(s0 - sf) * grid;
    errSum += err; errMax = Math.max(errMax, err); if (err > 1e-9) moved++;
    endErrMax = Math.max(endErrMax, Math.abs(Math.round(ef) - ef) * grid);
    const s = Math.max(0, Math.min(totalCells - 1, s0));
    const e = Math.max(s + 1, Math.min(totalCells, Math.round(ef)));
    return { s, e, pitch: n.pitch, vel: n.vel, unpitched: n.unpitched, ...(n.unpitchedKey === undefined ? {} : { key: n.unpitchedKey }), ...(n.program === undefined ? {} : { program: n.program }) };
  };
  interface Q extends ReturnType<typeof quantise> {}
  const candidates = parts.map((p) => {
    const q: Q[] = p.notes.filter((n) => n.beat < totalCells * grid).map(quantise);
    const unpitched = q.filter((n) => n.unpitched).length;
    return { part: p, notes: q, drum: unpitched > q.length - unpitched, unpitched };
  }).filter((c) => c.notes.length > 0);
  if (candidates.length === 0) throw new MusicXmlImportError("the MusicXML file contains no notes");
  const rank = (c: typeof candidates[number]): number => {
    let low = 127, high = 0;
    for (const n of c.notes) { if (n.pitch < low) low = n.pitch; if (n.pitch > high) high = n.pitch; }
    return c.notes.length * (1 + Math.max(0, high - low) / 12);
  };
  const droppedParts: MusicXmlImportReport["droppedParts"] = [];
  const drumParts = candidates.filter((c) => c.drum).sort((a, b) => b.notes.length - a.notes.length);
  const melodic = candidates.filter((c) => !c.drum).sort((a, b) => rank(b) - rank(a));
  const chosen: typeof candidates = [];
  if (drumParts[0] && options.drums !== false) chosen.push(drumParts[0]);
  else if (drumParts[0]) droppedParts.push({ part: drumParts[0].part.id, notes: drumParts[0].notes.length, reason: "drums disabled" });
  for (const extra of drumParts.slice(1)) droppedParts.push({ part: extra.part.id, ...(extra.part.name ? { name: extra.part.name } : {}), notes: extra.notes.length, reason: "only one drum voice is allocated" });
  for (const c of melodic) {
    if (chosen.length < voiceLimit) chosen.push(c);
    else droppedParts.push({ part: c.part.id, ...(c.part.name ? { name: c.part.name } : {}), notes: c.notes.length, reason: `all ${voiceLimit} voices are taken by parts with higher importance` });
  }
  chosen.sort((a, b) => Number(a.drum) - Number(b.drum));
  if (droppedParts.length) losses.push(`${droppedParts.reduce((n, d) => n + d.notes, 0)} notes of ${droppedParts.length} part(s) do not fit in ${voiceLimit} voices and are not imported (${droppedParts.map((d) => `${d.name ?? d.part}: ${d.notes} notes`).join('; ')}).`);

  const maxMidi = maxSidwaveMidi(mode);
  const instruments = new Map<string, ImportInstrument>();
  const voices: GridVoice[] = [];
  const reports: MusicXmlImportReport["voices"] = [];
  for (const [index, c] of chosen.entries()) {
    const id = index + 1;
    const label = c.part.name || c.part.id;
    if (c.drum) {
      const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
      const byCell = new Map<number, Q[]>();
      for (const n of c.notes) (byCell.get(n.s) ?? byCell.set(n.s, []).get(n.s)!).push(n);
      let dropped = 0, notes = 0;
      for (const [cell, hits] of byCell) {
        const known = hits.filter((n) => n.unpitched && n.key !== undefined && IMPORT_DRUMS[n.key]);
        dropped += hits.length - known.length;
        if (!known.length) continue;
        known.sort((a, b) => IMPORT_DRUMS[b.key!]!.priority - IMPORT_DRUMS[a.key!]!.priority);
        dropped += known.length - 1;
        cells[cell] = { kind: "note", drum: IMPORT_DRUMS[known[0]!.key!]!.letter };
        notes++;
      }
      if (dropped) losses.push(`Drum voice: ${dropped} hits dropped (no General MIDI percussion key in the part list, an unknown key, or a lower priority than a simultaneous hit).`);
      voices.push({ name: label, drum: true, cells });
      reports.push({ id, role: "drums", part: c.part.id, ...(c.part.name ? { name: c.part.name } : {}), notes, droppedPolyphony: 0, truncated: 0, octaveShifted: 0, droppedHits: dropped });
      continue;
    }
    const pitched = c.notes.filter((n) => !n.unpitched);
    skipped.unpitchedOutsideDrumPart += c.notes.length - pitched.length;
    const median = pitched.map((n) => n.pitch).sort((a, b) => a - b)[Math.floor(pitched.length / 2)]!;
    const bass = median < 48;
    const defaultProgram = c.part.defaultProgram ?? (bass ? 33 : undefined);
    const withInst = pitched.map((n) => {
      const inst = instrumentForProgram(n.program ?? defaultProgram);
      instruments.set(inst.name, inst);
      return { ...n, inst: inst.name };
    });
    const reduced = reduceMonophonic(withInst, totalCells, bass, maxMidi);
    if (reduced.droppedPolyphony) losses.push(`Voice v${id}: ${reduced.droppedPolyphony} notes dropped because they sound together with another note (SID voices are monophonic).`);
    voices.push({ name: label, ...(bass ? { role: "bass" as const } : {}), cells: reduced.cells });
    reports.push({ id, role: bass ? "bass" : "melodic", part: c.part.id, ...(c.part.name ? { name: c.part.name } : {}), instrument: instrumentForProgram(defaultProgram).name,
      notes: reduced.notes, droppedPolyphony: reduced.droppedPolyphony, truncated: reduced.truncated, octaveShifted: reduced.octaveShifted });
  }
  if (skipped.unpitchedOutsideDrumPart) losses.push(`${skipped.unpitchedOutsideDrumPart} unpitched notes in pitched parts are not imported.`);
  if (skipped.graceNotes) losses.push(`${skipped.graceNotes} grace notes are not imported.`);
  if (skipped.cueNotes) losses.push(`${skipped.cueNotes} cue notes are not imported.`);
  if (skipped.repeats) losses.push("Repeat signs and endings are not expanded; the measures play once as written.");
  const markup = Buffer.from(bytes).toString("latin1");
  const unreadMarks = (markup.match(/<(?:dynamics|articulations|slur|ornaments|lyric|technical|fermata)\b/g) ?? []).length;
  if (unreadMarks) losses.push(`${unreadMarks} notation marks (dynamics marks, articulations, slurs, ornaments, lyrics, fermatas) are not imported; a note's \`dynamics\` attribute sets its level.`);
  const title = options.title ?? (childText(child(root, "work") ?? root, "work-title") || childText(root, "movement-title") || "Imported MusicXML");
  const composer = childrenOf(child(root, "identification") ?? root, "creator").find((c) => c.attrs.type === "composer")?.text.trim();
  let yaml: string;
  try {
    yaml = buildGridScore({
      title: title ?? "Imported MusicXML", ...(composer ? { author: composer } : {}), mode, grid, bars, voices,
      instruments: Object.fromEntries([...instruments.values()].map(({ name, ...rest }) => [name, rest])),
      header: ["Imported from MusicXML (partwise) by SIDWave.", `Grid ${grid} beats; see the import report for what was dropped or moved.`],
      validate: options.validate !== false,
    });
  } catch (error) {
    if (error instanceof InterchangeInputError && error.yaml) throw new MusicXmlImportError(`${error.message}; try a coarser grid (--grid 0.5) or fewer voices`, error.yaml);
    throw error;
  }
  return {
    yaml,
    report: {
      format: "musicxml-partwise", ...(root.attrs.version ? { version: root.attrs.version } : {}), gridBeats: grid, bars: bars.length, voices: reports, droppedParts,
      quantisation: { notes: noteTotal, moved, maxErrorBeats: Math.round(errMax * 1e6) / 1e6, meanErrorBeats: noteTotal ? Math.round(errSum / noteTotal * 1e6) / 1e6 : 0, maxEndErrorBeats: Math.round(endErrMax * 1e6) / 1e6 },
      tempoChanges: { total: allTempos.length, movedToBarLine: movedTempos, clamped },
      timeSignatures: signatureReport, skipped, losses: [...new Set(losses)], warnings,
    },
  };
}
export type { XmlNode };
