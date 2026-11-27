// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { createHash } from "node:crypto";
import YAML from "yaml";
import { SidwaveOperationError } from "../cliCore.js";
import { midiToNoteName, noteNameToMidi, parseSidwave, type ParsedSidwave, type SidwaveDocument } from "../sidwave.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { analyseScore, extractMotif, inferChords, isSilentRef, type Analysis, type Note as PNote, type VoiceInfo } from "./analyse.js";
import { arpBar, bassBar, lineTokens } from "./compose.js";
import { composeCounterLine, composeMelody, makeMotif, type Note } from "./melody.js";
import { verifyProtected, type ProtectedReport, type ProtectedSpec } from "./protected.js";
import { ARP_PATTERNS, BASS_PATTERNS, DRUM_FILLS, DRUM_PATTERNS, cellString } from "./rhythm.js";
import { pc, progression, substream, type Cadence, type Chord, type Random } from "./theory.js";
import { DEVELOPMENT_PLANS } from "./profiles.js";

/**
 * Completion operations on an existing score: continue, harmonise, accompany and fill a missing section. Each works on a
 * copy of the document, adds patterns, voices and timeline entries, never rewrites a pattern or layer that already plays,
 * and refuses a target voice that is not free. The result is checked by tracing both scores (see protected.ts).
 */

export type CompleteOp = "continue" | "harmonise" | "accompany" | "fill-section";

export interface CompleteOptions {
  /** continue: bars to append. fill-section: bars of a section that is not yet in the timeline. */
  bars?: number;
  /** harmonise: the id of the melody voice. */
  voice?: number;
  /** harmonise: the free voice that receives the harmony. */
  target?: number;
  /** accompany: free voice for a bass line. */
  bass?: number;
  /** accompany: free voice for percussion. */
  drums?: number;
  /** fill-section: the section to fill or add. */
  section?: string;
  /** fill-section: insert a new section after this section. */
  after?: string;
  /** fill-section: insert a new section at this 1-based timeline position. */
  at?: number;
  seed?: number;
  /** harmonise: `arp` (chord arpeggio, default) or `line` (a counter line). */
  style?: "arp" | "line";
  /** Instrument of a new harmony or bass voice. */
  instrument?: string;
  /** Compare the protected material by tracing both scores (default true). */
  verify?: boolean;
  /** How `file:` sample sources are read (the command line passes a reader confined to the working directory and `--allow-dir`). */
  readOptions?: SidwaveReadOptions;
}

export interface CompleteResult {
  op: CompleteOp;
  /** The completed document. */
  score: SidwaveDocument;
  parsed: ParsedSidwave;
  /** Voices that received new notes. */
  targets: number[];
  /** Timeline entry (0-based) of the completed score that holds new material, or the entries for a new voice. */
  entries: number[];
  addedBars: number;
  protected?: ProtectedReport;
}

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  throw new SidwaveOperationError("validation", message, details);
};

export function completeScore(input: string | SidwaveDocument, op: CompleteOp, options: CompleteOptions = {}): CompleteResult {
  const original: SidwaveDocument = typeof input === "string" ? (YAML.parse(input) as SidwaveDocument) : (structuredClone(input) as SidwaveDocument);
  if (!original || typeof original !== "object") fail("the score is not a SIDWave document");
  const raw = structuredClone(original);
  const parsed = parseSidwave(structuredClone(original), options.readOptions);
  const a = analyseScore(parsed);
  if (!Array.isArray(raw.timeline)) fail("the completion operations need a score with a timeline list");
  const ctx: Ctx = { a, raw, seed: options.seed ?? 1, used: new Set() };
  let result: { targets: number[]; entries: number[]; addedBars: number; spec: ProtectedSpec };
  switch (op) {
    case "continue": result = doContinue(ctx, options); break;
    case "harmonise": result = doHarmonise(ctx, options); break;
    case "accompany": result = doAccompany(ctx, options); break;
    case "fill-section": result = doFill(ctx, options); break;
    default: throw new SidwaveOperationError("usage", `unknown completion operation "${op as string}"`);
  }
  const completed = parseSidwave(structuredClone(raw), options.readOptions);
  const report = options.verify === false ? undefined : verifyProtected(parsed, completed, result.spec, createHash("sha1").update(JSON.stringify(original)).digest("hex"));
  if (report && !report.identical) {
    throw new SidwaveOperationError("validation", `the completion changed protected material (voice ${report.mismatches[0]!.voice}, timeline entry ${report.mismatches[0]!.entry + 1}); nothing was written`, { report });
  }
  return { op, score: raw, parsed: completed, targets: result.targets, entries: result.entries, addedBars: result.addedBars, ...(report ? { protected: report } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// Shared helpers

interface Ctx { a: Analysis; raw: SidwaveDocument; seed: number; used: Set<string> }

const name = (midi: number) => midiToNoteName(midi);

function voiceInfo(a: Analysis, id: number): VoiceInfo | undefined { return a.voices.find((v) => v.id === id); }

/** A voice id is free when no voice with that id plays and its physical slot exists in the SID map. */
function requireFree(a: Analysis, id: number | undefined, what: string): number {
  if (id === undefined || !Number.isInteger(id) || id < 1) throw new SidwaveOperationError("usage", `${what} needs a voice id`);
  const existing = voiceInfo(a, id);
  if (existing && !existing.silent) fail(`voice ${id} is not free: it plays in the score; ${what} refuses to overwrite it`, { voice: id });
  if (!existing && id > 3 * a.parsed.sids.length) fail(`voice ${id} does not exist in the SID map (${a.parsed.sids.length} SID${a.parsed.sids.length === 1 ? "" : "s"}, ${3 * a.parsed.sids.length} voices)`, { voice: id });
  return id;
}

function rawVoice(ctx: Ctx, id: number, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  const index = ctx.a.parsed.voices.findIndex((v) => v.id === id);
  const voices = (ctx.raw.voices ??= []) as unknown as Array<Record<string, unknown>>;
  if (index >= 0) return voices[index]!;
  const added = voices.find((v) => v.id === id);
  if (added) return added;
  const voice = { id, ...defaults, patterns: {} };
  voices.push(voice);
  return voice;
}

function addPattern(ctx: Ctx, id: number, tag: string, pattern: Record<string, unknown>, defaults: Record<string, unknown> = {}): string {
  const voice = rawVoice(ctx, id, defaults);
  const patterns = (voice.patterns ??= {}) as Record<string, unknown>;
  let n = 1;
  while (`${tag}${n}v${id}` in patterns || ctx.used.has(`${tag}${n}v${id}`)) n++;
  const patternName = `${tag}${n}v${id}`;
  patterns[patternName] = pattern;
  ctx.used.add(patternName);
  return patternName;
}

const groove = (tokens: string[]) => ({ length: 0.25, groove: tokens });

/** Nearest preceding timeline entry on which the voice plays, else the nearest following one. */
function referenceEntry(a: Analysis, voiceId: number, index: number): number | undefined {
  const plays = (i: number) => !isSilentRef(a.parsed.timeline[i]!.layers[`v${voiceId}`]);
  for (let i = Math.min(index, a.entries.length) - 1; i >= 0; i--) if (plays(i)) return i;
  for (let i = Math.max(index, 0); i < a.entries.length; i++) if (plays(i)) return i;
  return undefined;
}

function notesIn(v: VoiceInfo, from: number, to: number): PNote[] {
  // Notes are in onset order: binary search for the first note at or after `from`.
  let lo = 0;
  let hi = v.notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (v.notes[mid]!.at < from) lo = mid + 1; else hi = mid; }
  const out: PNote[] = [];
  for (let i = lo; i < v.notes.length && v.notes[i]!.at < to; i++) out.push(v.notes[i]!);
  return out;
}

/** One bar of onsets of a line as a pattern string for the bass and arpeggio token builders: `r` starts a note, `~` holds, `.` rests. */
function rhythmPattern(notes: readonly PNote[], barStart: number, cells: number, marker: string): string {
  const out = Array.from({ length: cells }, () => ".");
  for (const n of notes) {
    if (n.at < barStart || n.at >= barStart + cells) continue;
    const at = n.at - barStart;
    out[at] = marker;
    for (let i = 1; i < n.dur && at + i < cells; i++) out[at + i] = "~";
  }
  return out.join("");
}

function shiftToken(token: string, semitones: number): string {
  if (semitones === 0 || token === "-" || token === "~") return token;
  const [note, inst] = token.split("@");
  return `${name(noteNameToMidi(note!)! + semitones)}${inst ? `@${inst}` : ""}`;
}

function chordsFor(ctx: Ctx, random: Random, bars: number, cadence: Cadence): Chord[] {
  return progression(random, ctx.a.key, bars, cadence);
}

interface Material { tokens: Map<number, string[]>; drumsRef: Map<number, string> }

/**
 * New material for one timeline entry of `bars` bars: a melody for the lead, a bass line, chord-tone lines for the
 * other pitched voices, and the reference pattern again for percussion. Each voice takes its rhythm from the last bar of
 * its reference entry, its register and instrument from the score.
 */
function materialFor(ctx: Ctx, voices: VoiceInfo[], index: number, bars: number, cadence: Cadence, tag: string): Material {
  const a = ctx.a;
  const random = substream(ctx.seed, `${tag}:${index}`);
  const chords = chordsFor(ctx, random, bars, cadence);
  const out: Material = { tokens: new Map(), drumsRef: new Map() };
  const barCells = a.barCells;
  for (const voice of voices) {
    const ref = referenceEntry(a, voice.id, index);
    if (ref === undefined) continue;
    const entry = a.entries[ref]!;
    if (voice.role === "drums") { out.drumsRef.set(voice.id, a.parsed.timeline[ref]!.layers[`v${voice.id}`]!); continue; }
    const refNotes = notesIn(voice, entry.startCell, entry.startCell + entry.cells);
    const lastBar = entry.startCell + (entry.bars - 1) * barCells;
    if (voice.role === "lead") {
      const motif = extractMotif(refNotes, a.key, entry.startCell, barCells) ?? makeMotif(substream(ctx.seed, `${tag}:motif`), 0.4);
      const perBar = refNotes.length / entry.bars;
      const grooveName = perBar >= 8 ? "driving" : perBar >= 4 ? "straight" : "sparse";
      const phraseBars = Math.min(4, bars);
      const phrases = Math.ceil(bars / phraseBars);
      const cadences: Cadence[] = Array.from({ length: phrases }, (_, p) => (p < phrases - 1 ? "half" : cadence));
      const { notes } = composeMelody({
        random, key: a.key, chords, slotsPerBar: 1, bars, barCells, phraseBars, groove: grooveName, syncopation: 0.15, density: 0.5, motif,
        plan: DEVELOPMENT_PLANS.A!, cadences, range: [voice.medianPitch - 9, voice.medianPitch + 10], leaps: 0.4, sequenceStep: -1,
        start: refNotes.length > 0 ? refNotes[refNotes.length - 1]!.midi : undefined,
      });
      out.tokens.set(voice.id, Array.from({ length: bars }, (_, b) => lineTokens(notes, b * barCells, barCells)).flat());
      continue;
    }
    if (voice.role === "bass") {
      const pattern = rhythmPattern(notesIn(voice, lastBar, lastBar + barCells), lastBar, barCells, "r");
      const shift = Math.round((voice.medianPitch - 41.5) / 12) * 12;
      out.tokens.set(voice.id, Array.from({ length: bars }, (_, b) =>
        bassBar(pattern.includes("r") ? pattern : "r~~~~~~~r~~~~~~~", [chords[b]!], barCells, chords[b + 1]?.root ?? chords[0]!.root, a.key, b === bars - 1 && bars > 1, () => false)
          .map((t) => shiftToken(t, shift))).flat());
      continue;
    }
    // Other pitched voices: the rhythm of the reference's last bar over the new chords, on chord tones near the voice's register.
    const arp = voice.instrument?.match(/chip_arp_(major|minor)/) !== null && voice.instrument !== undefined;
    const rhythm = notesIn(voice, lastBar, lastBar + barCells);
    out.tokens.set(voice.id, Array.from({ length: bars }, (_, b) => {
      const chord = chords[b]!;
      if (arp) return arpBar(rhythmPattern(rhythm, lastBar, barCells, "x"), [chord], barCells);
      const cells = Array.from({ length: barCells }, () => "-");
      let k = 0;
      for (const n of rhythm) {
        const at = n.at - lastBar;
        const tone = chord.pcs[k++ % 3]!;
        let best = -1;
        for (let m = voice.medianPitch - 8; m <= voice.medianPitch + 8; m++) {
          if (pc(m) === tone && (best < 0 || Math.abs(m - voice.medianPitch) < Math.abs(best - voice.medianPitch))) best = m;
        }
        cells[at] = name(best);
        for (let i = 1; i < n.dur && at + i < barCells; i++) cells[at + i] = "~";
      }
      return cells;
    }).flat());
  }
  return out;
}

/** Voices that play somewhere in the score. */
const playing = (a: Analysis) => a.voices.filter((v) => !v.silent && (v.role === "drums" || v.notes.length > 0));

/** The last cell becomes a rest, so that the material after it starts after a rest as it did when the entry was silent. */
function endWithRest(tokens: string[]): string[] {
  const out = [...tokens];
  out[out.length - 1] = "-";
  return out;
}

/** The first cell becomes a rest for a voice that plays in the entry before: the note before it ends as it did, and the hard restart of the first new attack falls inside the rest. */
function startWithRest(tokens: string[]): string[] {
  const out = [...tokens];
  out[0] = "-";
  return out;
}

function applyMaterial(ctx: Ctx, entry: Record<string, unknown>, material: Material, tag: string, followed: boolean, previous: number): number[] {
  const layers = (entry.layers ??= {}) as Record<string, string>;
  const targets: number[] = [];
  for (const [id, tokens] of material.tokens) {
    const afterPlaying = previous >= 0 && !isSilentRef(ctx.a.parsed.timeline[previous]!.layers[`v${id}`]);
    let t = followed ? endWithRest(tokens) : tokens;
    if (afterPlaying) t = startWithRest(t);
    layers[`v${id}`] = addPattern(ctx, id, tag, groove(t));
    targets.push(id);
  }
  for (const [id, ref] of material.drumsRef) { layers[`v${id}`] = ref; targets.push(id); }
  return targets;
}

function uniqueSectionName(a: Analysis, base: string): string {
  const names = new Set(a.entries.map((e) => e.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// ---------------------------------------------------------------------------------------------------------
// Operations

type Outcome = { targets: number[]; entries: number[]; addedBars: number; spec: ProtectedSpec };

/** The (voice, entry) cells of the voices that play in the entry. */
function playsIn(a: Analysis, voices: number[], entry: number): Array<{ voice: number; entry: number }> {
  if (entry < 0) return [];
  return voices.filter((voice) => !isSilentRef(a.parsed.timeline[entry]!.layers[`v${voice}`])).map((voice) => ({ voice, entry }));
}

function identityMap(a: Analysis): number[] { return a.entries.map((_, i) => i); }

function doContinue(ctx: Ctx, o: CompleteOptions): Outcome {
  const { a, raw } = ctx;
  const bars = o.bars;
  if (bars === undefined || !Number.isInteger(bars) || bars < 1 || bars > 256) throw new SidwaveOperationError("usage", "continue needs --bars between 1 and 256");
  const index = a.entries.length;
  const voices = playing(a);
  if (voices.length === 0) fail("the score has no playing voice to continue");
  const material = materialFor(ctx, voices, index, bars, "authentic", "cont");
  const entry: Record<string, unknown> = { section: uniqueSectionName(a, "Continue"), bars, layers: {} };
  const targets = applyMaterial(ctx, entry, material, "cont", false, index - 1);
  (raw.timeline as unknown[]).push(entry);
  if (raw.length_bars !== undefined) raw.length_bars = a.totalBars + bars;
  return {
    targets, entries: [index], addedBars: bars,
    // The added entry follows the last one, so the original ring-out tail is not compared, and a voice that plays in the
    // last original entry and continues has its hard restart written in the end of that entry.
    spec: { entryMap: identityMap(a), excluded: [], guarded: playsIn(a, targets, index - 1), tail: "unprotected", gateMayMoveLater: true },
  };
}

function entriesPlaying(a: Analysis, voice: VoiceInfo): EntryRange[] {
  return a.entries.filter((e) => !isSilentRef(a.parsed.timeline[e.index]!.layers[`v${voice.id}`]));
}
type EntryRange = Analysis["entries"][number];

function doHarmonise(ctx: Ctx, o: CompleteOptions): Outcome {
  const { a } = ctx;
  const melody = o.voice === undefined ? undefined : voiceInfo(a, o.voice);
  if (!melody || melody.role === "drums" || melody.silent) throw new SidwaveOperationError("usage", `harmonise --voice needs a playing pitched voice, not ${o.voice}`);
  const target = requireFree(a, o.target, "harmonise --target");
  const style = o.style ?? "arp";
  const chords = inferChords(melody.notes, [], a.key, a.totalBars, a.barCells, 1);
  const median = melody.medianPitch;
  const dense = melody.notes.length / a.totalBars;
  const arpName = dense >= 6 ? "half" : dense >= 3 ? "quarter" : "eighth";
  const instrument = o.instrument ?? (style === "line" ? "lib:lead_pwm" : undefined);
  const layers: Array<[number, string]> = [];
  const cache = new Map<string, string>();
  for (const entry of entriesPlaying(a, melody)) {
    const entryChords = chords.slice(entry.startBar, entry.startBar + entry.bars);
    let tokens: string[];
    if (style === "line") {
      const lead: Note[] = notesIn(melody, entry.startCell, entry.startCell + entry.cells).map((n) => ({ at: n.at - entry.startCell, dur: n.dur, midi: n.midi }));
      const line = composeCounterLine({
        random: substream(ctx.seed, `harm:${entry.index}`), lead, chords: entryChords, slotsPerBar: 1, barCells: a.barCells, bars: entry.bars,
        range: [Math.max(36, median - 21), median - 3],
      });
      tokens = Array.from({ length: entry.bars }, (_, b) => lineTokens(line, b * a.barCells, a.barCells)).flat();
    } else {
      tokens = Array.from({ length: entry.bars }, (_, b) => arpBar(ARP_PATTERNS[arpName]![0]!, [entryChords[b]!], a.barCells)).flat();
    }
    const key = tokens.join(" ");
    let patternName = cache.get(key);
    if (!patternName) {
      patternName = addPattern(ctx, target, "harm", groove(tokens), { name: "Harmony", ...(instrument ? { instrument } : {}) });
      cache.set(key, patternName);
    }
    layers.push([entry.index, patternName]);
  }
  const rawEntries = ctx.raw.timeline as unknown as Array<Record<string, unknown>>;
  for (const [index, patternName] of layers) {
    const entry = rawEntries[index]!;
    if (typeof entry !== "object") fail(`timeline entry ${index + 1} is a reference; the completion operations need inline entries to add a voice`);
    ((entry.layers ??= {}) as Record<string, string>)[`v${target}`] = patternName;
  }
  return { targets: [target], entries: layers.map(([i]) => i), addedBars: 0, spec: { entryMap: identityMap(a), excluded: [], guarded: [] } };
}

function doAccompany(ctx: Ctx, o: CompleteOptions): Outcome {
  const { a } = ctx;
  if (o.bass === undefined && o.drums === undefined) throw new SidwaveOperationError("usage", "accompany needs --bass <voice> and/or --drums <voice>");
  const bassId = o.bass === undefined ? undefined : requireFree(a, o.bass, "accompany --bass");
  const drumsId = o.drums === undefined ? undefined : requireFree(a, o.drums, "accompany --drums");
  if (bassId !== undefined && bassId === drumsId) throw new SidwaveOperationError("usage", "accompany needs two different voices for bass and drums");
  const pitched = a.voices.filter((v) => v.role !== "drums" && !v.silent);
  const chords = inferChords(pitched.flatMap((v) => v.notes), [], a.key, a.totalBars, a.barCells, 1);
  const tempo = a.parsed.song.tempo;
  const bassName = tempo < 90 ? "sustained" : tempo < 110 ? "rootfifth" : tempo < 130 ? "pulse" : "driving";
  const drumName = tempo < 90 ? "sparse" : tempo < 110 ? "halftime" : tempo < 130 ? "backbeat" : "fourfloor";
  const rawEntries = ctx.raw.timeline as unknown as Array<Record<string, unknown>>;
  const entries: number[] = [];
  const cache = new Map<string, string>();
  const place = (index: number, id: number, tag: string, pattern: Record<string, unknown>, key: string, defaults: Record<string, unknown>) => {
    const entry = rawEntries[index]!;
    if (typeof entry !== "object") fail(`timeline entry ${index + 1} is a reference; the completion operations need inline entries to add a voice`);
    const cached = cache.get(`${id}:${key}`) ?? addPattern(ctx, id, tag, pattern, defaults);
    cache.set(`${id}:${key}`, cached);
    ((entry.layers ??= {}) as Record<string, string>)[`v${id}`] = cached;
  };
  for (const entry of a.entries) {
    const active = pitched.some((v) => !isSilentRef(a.parsed.timeline[entry.index]!.layers[`v${v.id}`]));
    if (!active) continue;
    entries.push(entry.index);
    if (bassId !== undefined) {
      const tokens = Array.from({ length: entry.bars }, (_, b) => {
        const bar = entry.startBar + b;
        return bassBar(BASS_PATTERNS[bassName]![0]!, [chords[bar]!], a.barCells, chords[bar + 1]?.root ?? chords[0]!.root, a.key, b === entry.bars - 1, () => false);
      }).flat();
      place(entry.index, bassId, "bass", groove(tokens), tokens.join(" "), { name: "Bass", instrument: o.instrument ?? "lib:bass_pluck" });
    }
    if (drumsId !== undefined) {
      const steps = Array.from({ length: entry.bars }, (_, b) =>
        b === entry.bars - 1 && drumName !== "sparse" && entry.index < a.entries.length - 1 ? cellString(DRUM_FILLS[0]!, a.barCells) : cellString(DRUM_PATTERNS[drumName]![0]!, a.barCells)).join("");
      place(entry.index, drumsId, "drum", { length: 0.25, drums: { kit: { k: "lib:kick", s: "lib:snare", h: "lib:hat" }, steps } }, steps, { name: "Percussion" });
    }
  }
  return { targets: [bassId, drumsId].filter((v): v is number => v !== undefined), entries, addedBars: 0, spec: { entryMap: identityMap(a), excluded: [], guarded: [] } };
}

function doFill(ctx: Ctx, o: CompleteOptions): Outcome {
  const { a, raw } = ctx;
  const section = o.section;
  if (!section) throw new SidwaveOperationError("usage", "fill-section needs --section <name>");
  const existing = a.entries.find((e) => e.name === section);
  const rawEntries = raw.timeline as unknown as Array<unknown>;
  let index: number;
  let bars: number;
  let entry: Record<string, unknown>;
  const voices = playing(a);
  if (existing) {
    const layers = a.parsed.timeline[existing.index]!.layers;
    if (Object.values(layers).some((ref) => !isSilentRef(ref))) fail(`section "${section}" is not empty; fill-section only fills an empty or missing section`, { section });
    index = existing.index;
    bars = existing.bars;
    const rawEntry = rawEntries[index];
    if (rawEntry && typeof rawEntry === "object" && !("use" in (rawEntry as object))) entry = rawEntry as Record<string, unknown>;
    else {
      const key = typeof rawEntry === "string" ? rawEntry : (rawEntry as { use?: string } | undefined)?.use;
      const defined = key !== undefined ? ((raw as { sections?: Record<string, unknown> }).sections?.[key]) : undefined;
      if (!defined || typeof defined !== "object") fail(`section "${section}" is a reference that cannot be edited in place`, { section });
      entry = defined as Record<string, unknown>;
    }
  } else {
    index = o.at !== undefined ? o.at - 1 : o.after !== undefined ? (a.entries.findIndex((e) => e.name === o.after) + 1) : a.entries.length;
    if (o.after !== undefined && index === 0) fail(`there is no section "${o.after}" to insert after`, { after: o.after });
    if (!Number.isInteger(index) || index < 0 || index > a.entries.length) throw new SidwaveOperationError("usage", `--at must be between 1 and ${a.entries.length + 1}`);
    bars = o.bars ?? a.entries[Math.max(0, index - 1)]?.bars ?? 4;
    if (!Number.isInteger(bars) || bars < 1 || bars > 256) throw new SidwaveOperationError("usage", "fill-section --bars must be between 1 and 256");
    entry = { section, bars, layers: {} };
    // Later sections move by `bars` bars. The player starts a note at the call nearest to its beat, so a move by a fractional
    // number of calls changes where notes fall and can change hard restarts; only a whole number of calls keeps them.
    const shiftCalls = bars * a.meter * a.framesPerBeat;
    if (index < a.entries.length && Math.abs(shiftCalls - Math.round(shiftCalls)) > 1e-6) {
      fail(`inserting ${bars} bars before "${a.entries[index]!.name ?? `entry ${index + 1}`}" would move later material by ${shiftCalls.toFixed(3)} player calls, which is not a whole number; the protected material would not keep its register output. Append the section (omit --at and --after) or choose another --bars`, { bars, shiftCalls });
    }
  }
  const cadence: Cadence = index < a.entries.length - (existing ? 1 : 0) ? "half" : "authentic";
  const material = materialFor(ctx, voices, index, bars, cadence, "fill");
  const targets = applyMaterial(ctx, entry, material, "fill", index < a.entries.length - (existing ? 0 : 0) && (existing ? index < a.entries.length - 1 : index < a.entries.length), index - 1);
  if (!existing) {
    rawEntries.splice(index, 0, entry);
    if (raw.length_bars !== undefined) raw.length_bars = a.totalBars + bars;
    const loop = (raw as { loop_to?: unknown }).loop_to;
    if (typeof loop === "number" && loop - 1 >= index) (raw as { loop_to?: number }).loop_to = loop + 1;
  }
  const entryMap = existing ? identityMap(a) : a.entries.map((e) => (e.index >= index ? e.index + 1 : e.index));
  return {
    targets, entries: [index], addedBars: existing ? 0 : bars,
    spec: {
      entryMap,
      excluded: existing ? targets.map((voice) => ({ voice, entry: index })) : [],
      guarded: playsIn(a, targets, index - 1),
      tail: !existing && index === a.entries.length ? "unprotected" : "compared",
      gateMayMoveLater: !existing,
    },
  };
}
