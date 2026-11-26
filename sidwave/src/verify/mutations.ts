// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { compileSidwaveToPrg } from "../sidwaveCompiler.js";
import {
  isModern, midiToNoteName, noteNameToMidi, parseLayerSequence, parseSidwave, patternBeats,
  type ParsedSidwave, type SidwavePattern,
} from "../sidwave.js";

/**
 * Score-level mutations for the A1 calibration corpus (design: a1-calibration-design.md, section 6). A mutation is
 * applied to the raw SIDWave document, never to audio, and the result goes through the production parser and
 * compiler, so every mutated tune is a real SID. Each mutation changes exactly the elements it names in
 * `targets`, expressed as paths into the parsed score.
 *
 * Grooves are edited in their normalised form (the array of tokens and note objects that the parser produces), so
 * the only change to a pattern is the targeted entry.
 */

export type MutationClass =
  | "wrong_note" | "octave_error" | "missing_note" | "extra_note" | "detune_voice" | "timing_shift" | "tempo_drift"
  | "gate_length" | "envelope" | "waveform" | "pulse_width" | "filter" | "sync_ring" | "missing_percussion"
  | "sound_in_silence" | "sections_swapped" | "loop_point" | "long_tune_defect" | "identical"
  | "refactor_rename_instrument" | "refactor_duplicate_pattern";

/** M: material, must fail. B: benign, must pass. X: borderline, reported but not scored. */
export type MutationLabel = "M" | "B" | "X";

export interface MutationKind {
  class: MutationClass;
  severity: string;
  label: MutationLabel;
}

const kinds = (c: MutationClass, entries: Array<[string, MutationLabel]>): MutationKind[] => entries.map(([severity, label]) => ({ class: c, severity, label }));

export const MUTATION_CATALOG: readonly MutationKind[] = [
  ...kinds("wrong_note", [["1", "M"], ["2", "M"]]),
  ...kinds("octave_error", [["12", "M"]]),
  ...kinds("missing_note", [["1", "M"]]),
  ...kinds("extra_note", [["1", "M"]]),
  ...kinds("detune_voice", [["3", "B"], ["8", "X"], ["25", "M"], ["50", "M"]]),
  ...kinds("timing_shift", [["1", "X"], ["3", "M"], ["6", "M"]]),
  ...kinds("tempo_drift", [["0.5", "X"], ["2", "M"]]),
  ...kinds("gate_length", [["frame", "X"], ["half", "M"]]),
  ...kinds("envelope", [["release", "X"], ["attack_decay", "M"]]),
  ...kinds("waveform", [["1", "M"]]),
  ...kinds("pulse_width", [["64", "X"], ["512", "M"]]),
  ...kinds("filter", [["5", "X"], ["40", "M"], ["off", "M"]]),
  ...kinds("sync_ring", [["off", "M"]]),
  ...kinds("missing_percussion", [["1", "M"]]),
  ...kinds("sound_in_silence", [["50ms", "M"]]),
  ...kinds("sections_swapped", [["1", "M"]]),
  ...kinds("loop_point", [["1", "M"]]),
  ...kinds("long_tune_defect", [["1", "M"]]),
  ...kinds("identical", [["recompile", "B"]]),
  ...kinds("refactor_rename_instrument", [["1", "B"]]),
  ...kinds("refactor_duplicate_pattern", [["1", "B"]]),
];

export interface MutationContext {
  /** Identifies the base tune; with the class and severity it seeds the choice of target. */
  tuneId: string;
  /** Targets whose pattern first plays after this many seconds are not chosen. Default: no limit. */
  horizonSeconds?: number;
}

export interface AppliedMutation extends MutationKind {
  description: string;
  /** Paths into the parsed score ($.voices[0].patterns.theme.groove[3]) that the mutation changes. */
  targets: string[];
  /** Seconds at which the first changed element plays, when it can be told. */
  firstUseSeconds?: number;
}

export type MutationOutcome =
  | { applied: true; document: Record<string, any>; mutation: AppliedMutation }
  | { applied: false; reason: string };

export type RawScore = Record<string, any>;

/** Parses YAML text into a plain document without shared references (aliases become independent copies). */
export function readRawScore(source: string | object): RawScore {
  const value = typeof source === "string" ? parseYaml(source) : source;
  return JSON.parse(JSON.stringify(value)) as RawScore;
}

/** Deterministic index in [0, n): SHA-256 of the key, first four bytes. */
export function seededIndex(key: string, n: number): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) % n;
}

const FPS = { PAL: 50.125, NTSC: 59.826 } as const;
const DRUM_NAME = /kick|snare|hat|tom|crash|drum|perc|ghost|^kk$|^sn$|^sq$|^sz$|^hc$|^ho$|^hx$/i;
const MIN_MIDI = 24;
const MAX_MIDI = 95;
const LONG_DEFECT_MIN_START = 60;

type Entry = string | Record<string, any>;

interface Site {
  voice: number;
  voiceId: number;
  pattern: string;
  index: number;
  firstUse: number;
}

interface Ctx {
  raw: RawScore;
  parsed: ParsedSidwave;
  key: string;
  horizon: number;
  /** pattern first use in seconds, by `${voiceId}:${pattern}` */
  firstUse: Map<string, number>;
  drumInstruments: Set<string>;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const grooveOf = (pattern: SidwavePattern | undefined): Entry[] | undefined => (pattern && "groove" in pattern ? (pattern.groove as Entry[]) : undefined);
const isRest = (e: Entry) => e === "-" || e === ".";
const noteOf = (e: Entry): string | undefined => (typeof e === "string" ? e : typeof e === "object" && !hasOwn(e, "chord") ? e.note : undefined);

function buildContext(raw: RawScore, context: MutationContext, kind: MutationKind, attempt: number): Ctx {
  const parsed = parseSidwave(JSON.parse(JSON.stringify(raw)));
  const drumInstruments = new Set<string>(Object.values((raw.kit ?? {}) as Record<string, string>).map(String));
  for (const name of Object.keys(parsed.instruments)) if (DRUM_NAME.test(name)) drumInstruments.add(name);
  const firstUse = firstUseSeconds(parsed);
  return { raw, parsed, key: `${context.tuneId}|${kind.class}|${kind.severity}${attempt === 0 ? "" : `|attempt${attempt}`}`, horizon: context.horizonSeconds ?? Infinity, firstUse, drumInstruments };
}

function barBeats(parsed: ParsedSidwave, sectionIndex: number): number {
  return parsed.timeline[sectionIndex]?.meter?.beats ?? parsed.song.meter;
}

/** Seconds at which each pattern first plays, `${voiceId}:${pattern}` -> seconds, from the section layers. */
function firstUseSeconds(parsed: ParsedSidwave): Map<string, number> {
  const out = new Map<string, number>();
  const secondsPerBeat = 60 / parsed.song.tempo;
  let beat = 0;
  parsed.timeline.forEach((section, i) => {
    const beats = barBeats(parsed, i);
    for (const voice of parsed.voices) {
      const ref = section.layers[`v${voice.id}`];
      const names = Object.keys(voice.patterns ?? {});
      if (ref === undefined || names.length === 0) continue;
      let offset = 0;
      for (const item of parseLayerSequence(ref, names, "$").items) {
        if (!item.pattern) { offset += beats; continue; }
        const key = `${voice.id}:${item.pattern}`;
        if (!out.has(key)) out.set(key, (beat + offset) * secondsPerBeat);
        const pattern = voice.patterns![item.pattern]!;
        offset += pattern.bars ? pattern.bars * beats : Math.max(beats, Math.ceil(patternBeats(pattern) / beats - 1e-9) * beats);
      }
    }
    beat += section.bars * beats;
  });
  return out;
}

function isDrumVoice(ctx: Ctx, voice: ParsedSidwave["voices"][number]): boolean {
  if (voice.role === "drums") return true;
  let notes = 0, drums = 0;
  for (const pattern of Object.values(voice.patterns ?? {})) {
    for (const e of grooveOf(pattern) ?? []) {
      if (isRest(e) || e === "~" || typeof e !== "object" || !("note" in e || "chord" in e)) { if (typeof e === "string" && noteNameToMidi(e) !== undefined) notes++; continue; }
      notes++;
      if (e.kitNote || (typeof e.inst === "string" && ctx.drumInstruments.has(e.inst))) drums++;
    }
  }
  return notes > 0 && drums * 2 >= notes;
}

function pitchedSites(ctx: Ctx, accept: (entry: Entry, groove: Entry[], index: number) => boolean = () => true): Site[] {
  const sites: Site[] = [];
  ctx.parsed.voices.forEach((voice, vi) => {
    if (isDrumVoice(ctx, voice)) return;
    for (const [name, pattern] of Object.entries(voice.patterns ?? {})) {
      const groove = grooveOf(pattern);
      const firstUse = ctx.firstUse.get(`${voice.id}:${name}`);
      if (!groove || firstUse === undefined || firstUse > ctx.horizon - 2) continue;
      groove.forEach((entry, index) => {
        if (accept(entry, groove, index)) sites.push({ voice: vi, voiceId: voice.id, pattern: name, index, firstUse });
      });
    }
  });
  return sites;
}

const isPitched = (ctx: Ctx, e: Entry): boolean => {
  if (typeof e === "string") return noteNameToMidi(e) !== undefined;
  if (typeof e !== "object" || hasOwn(e, "chord") || e.kitNote || typeof e.note !== "string" || noteNameToMidi(e.note) === undefined) return false;
  return !(typeof e.inst === "string" && ctx.drumInstruments.has(e.inst));
};

const pick = <T>(ctx: Ctx, items: T[]): T | undefined => (items.length ? items[seededIndex(ctx.key, items.length)] : undefined);

function pathOf(site: Site, index = site.index): string {
  return `$.voices[${site.voice}].patterns.${site.pattern}.groove[${index}]`;
}

/** The raw pattern object of a site, rewritten to hold the normalised groove (without motif, root or drums). */
function rewriteGroove(ctx: Ctx, site: Site, groove: Entry[]): void {
  const rawVoice = ctx.raw.voices[site.voice];
  const rawPattern = rawVoice.patterns[site.pattern];
  delete rawPattern.motif;
  delete rawPattern.root;
  delete rawPattern.drums;
  rawPattern.groove = groove;
}

const copyGroove = (ctx: Ctx, site: Site): Entry[] =>
  JSON.parse(JSON.stringify(grooveOf(ctx.parsed.voices[site.voice]!.patterns![site.pattern])));

const withNote = (e: Entry, note: string): Entry => (typeof e === "string" ? note : { ...e, note });

function fail(reason: string): MutationOutcome {
  return { applied: false, reason };
}

function done(ctx: Ctx, kind: MutationKind, description: string, targets: string[], firstUseSeconds?: number): MutationOutcome {
  return {
    applied: true,
    document: ctx.raw,
    mutation: { ...kind, description, targets, ...(firstUseSeconds === undefined ? {} : { firstUseSeconds }) },
  };
}

const signOf = (ctx: Ctx) => (seededIndex(`${ctx.key}|sign`, 2) === 0 ? 1 : -1);

/** Applies the same rewrite to the pitch of one pitched note: wrong note, octave error. */
function shiftNote(ctx: Ctx, kind: MutationKind, semitones: number, what: string, minStart = 0): MutationOutcome {
  const sites = pitchedSites(ctx, (e) => isPitched(ctx, e)).filter((s) => s.firstUse >= minStart);
  const usable = sites.filter((s) => {
    const midi = noteNameToMidi(noteOf(grooveOf(ctx.parsed.voices[s.voice]!.patterns![s.pattern])![s.index]!)!)!;
    return (midi + semitones >= MIN_MIDI && midi + semitones <= MAX_MIDI) || (midi - semitones >= MIN_MIDI && midi - semitones <= MAX_MIDI);
  });
  const site = pick(ctx, usable);
  if (!site) return fail("no pitched note in range");
  const groove = copyGroove(ctx, site);
  const old = noteOf(groove[site.index]!)!;
  const midi = noteNameToMidi(old)!;
  const delta = [signOf(ctx) * semitones, -signOf(ctx) * semitones].find((d) => midi + d >= MIN_MIDI && midi + d <= MAX_MIDI)!;
  const note = midiToNoteName(midi + delta);
  groove[site.index] = withNote(groove[site.index]!, note);
  rewriteGroove(ctx, site, groove);
  return done(ctx, kind, `${what}: ${old} to ${note} at ${site.pattern}[${site.index}]`, [pathOf(site)], site.firstUse);
}

function missingNote(ctx: Ctx, kind: MutationKind, minStart = 0): MutationOutcome {
  const site = pick(ctx, pitchedSites(ctx, (e) => isPitched(ctx, e) && (typeof e === "string" || e.len === undefined)).filter((s) => s.firstUse >= minStart));
  if (!site) return fail("no pitched note without its own length");
  const groove = copyGroove(ctx, site);
  const old = noteOf(groove[site.index]!);
  groove[site.index] = "-";
  rewriteGroove(ctx, site, groove);
  return done(ctx, kind, `missing note: ${old} replaced by a rest at ${site.pattern}[${site.index}]`, [pathOf(site)], site.firstUse);
}

function extraNote(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const sites = pitchedSites(ctx, (e, g, i) => isRest(e) && g.some((x, j) => j !== i && isPitched(ctx, x)));
  const site = pick(ctx, sites);
  if (!site) return fail("no rest next to a pitched note");
  const groove = copyGroove(ctx, site);
  let near = -1;
  for (let d = 1; d < groove.length && near < 0; d++) {
    for (const j of [site.index - d, site.index + d]) if (j >= 0 && j < groove.length && isPitched(ctx, groove[j]!) && typeof groove[j] === "string") { near = j; break; }
  }
  if (near < 0) return fail("no plain note near the rest");
  groove[site.index] = groove[near] as string;
  rewriteGroove(ctx, site, groove);
  return done(ctx, kind, `extra note: rest at ${site.pattern}[${site.index}] replaced by ${groove[near]}`, [pathOf(site)], site.firstUse);
}

const framesToBeats = (ctx: Ctx, frames: number) => (frames / FPS[ctx.parsed.song.mode]) * (ctx.parsed.song.tempo / 60);
const beatsToFrames = (ctx: Ctx, beats: number) => beats * (60 / ctx.parsed.song.tempo) * FPS[ctx.parsed.song.mode];

const asObject = (e: Entry): Record<string, any> => (typeof e === "string" ? { note: e } : { ...e });

function timingShift(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const frames = Number(kind.severity);
  const delay = framesToBeats(ctx, frames);
  const defaultLength = (site: Site) => ctx.parsed.voices[site.voice]!.patterns![site.pattern]!.length ?? 1;
  const sites = pitchedSites(ctx, (e, g, i) => i > 0 && isPitched(ctx, e) && isPitched(ctx, g[i - 1]!) && !(typeof e === "object" && (e.legato || e.glide || e.portamento || e.slide_from || e.bend)))
    .filter((s) => {
      const groove = grooveOf(ctx.parsed.voices[s.voice]!.patterns![s.pattern])!;
      const length = (e: Entry) => (typeof e === "object" && e.len !== undefined ? Number(e.len) : defaultLength(s));
      return beatsToFrames(ctx, length(groove[s.index]!)) - frames >= 4 && length(groove[s.index]!) - delay >= 1 / 64;
    });
  const site = pick(ctx, sites);
  if (!site) return fail("no note with a note before it that is long enough");
  const groove = copyGroove(ctx, site);
  const length = (e: Entry) => (typeof e === "object" && e.len !== undefined ? Number(e.len) : defaultLength(site));
  const before = asObject(groove[site.index - 1]!);
  const target = asObject(groove[site.index]!);
  const beforeLength = length(groove[site.index - 1]!);
  const targetLength = length(groove[site.index]!);
  before.len = Math.round((beforeLength + delay) * 1e6) / 1e6;
  target.len = beforeLength + targetLength - before.len;
  groove[site.index - 1] = before;
  groove[site.index] = target;
  rewriteGroove(ctx, site, groove);
  return done(ctx, kind, `timing shift: ${target.note} at ${site.pattern}[${site.index}] starts ${frames} frames later`,
    [pathOf(site, site.index - 1), pathOf(site)], site.firstUse);
}

function gateLength(ctx: Ctx, kind: MutationKind): MutationOutcome {
  if (!isModern(ctx.parsed)) return fail("gate_off needs SIDWave 1.2 or later");
  const sites = pitchedSites(ctx, (e) => isPitched(ctx, e) && !(typeof e === "object" && (e.gate_off !== undefined || e.legato || e.glide)))
    .filter((s) => {
      const pattern = ctx.parsed.voices[s.voice]!.patterns![s.pattern]!;
      const e = grooveOf(pattern)![s.index]!;
      return beatsToFrames(ctx, typeof e === "object" && e.len !== undefined ? Number(e.len) : pattern.length ?? 1) >= 8;
    });
  const site = pick(ctx, sites);
  if (!site) return fail("no note of at least 8 frames");
  const pattern = ctx.parsed.voices[site.voice]!.patterns![site.pattern]!;
  const groove = copyGroove(ctx, site);
  const entry = asObject(groove[site.index]!);
  const noteFrames = beatsToFrames(ctx, entry.len !== undefined ? Number(entry.len) : pattern.length ?? 1);
  entry.gate_off = kind.severity === "frame" ? 1 : Math.min(255, Math.floor(noteFrames / 2));
  groove[site.index] = entry;
  rewriteGroove(ctx, site, groove);
  return done(ctx, kind, `gate length: ${entry.note} at ${site.pattern}[${site.index}] released ${entry.gate_off} frames early`, [pathOf(site)], site.firstUse);
}

function tempoDrift(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const factor = 1 + (signOf(ctx) * Number(kind.severity)) / 100;
  const holder = ctx.raw.song && ctx.raw.tempo === undefined ? ctx.raw.song : ctx.raw;
  const tempo = Number(holder.tempo);
  if (!Number.isFinite(tempo)) return fail("the score has no tempo");
  const next = Math.round(tempo * factor * 1000) / 1000;
  if (next < 30 || next > 220) return fail("tempo out of range");
  holder.tempo = next;
  return done(ctx, kind, `tempo drift: ${tempo} to ${next}`, ["$.song.tempo"]);
}

function detuneVoice(ctx: Ctx, kind: MutationKind): MutationOutcome {
  if (!isModern(ctx.parsed)) return fail("voice detune needs SIDWave 1.2 or later");
  const voices = ctx.parsed.voices.map((v, i) => ({ v, i })).filter(({ v }) => !isDrumVoice(ctx, v) && ctx.raw.voices?.[0] !== undefined
    && [...ctx.firstUse.keys()].some((k) => k.startsWith(`${v.id}:`)));
  const chosen = pick(ctx, voices);
  if (!chosen) return fail("no pitched voice");
  const rawVoice = ctx.raw.voices[chosen.i];
  const old = Number(rawVoice.detune ?? 0);
  let next = old + signOf(ctx) * Number(kind.severity);
  if (Math.abs(next) > 100) next = old - signOf(ctx) * Number(kind.severity);
  rawVoice.detune = next;
  return done(ctx, kind, `detune: voice ${chosen.v.id} ${old} to ${next} cents`, [`$.voices[${chosen.i}].detune`]);
}

// --- instrument mutations -------------------------------------------------------------------------------

function usedInstruments(ctx: Ctx): Set<string> {
  const used = new Set<string>();
  for (const voice of ctx.parsed.voices) {
    if (![...ctx.firstUse.keys()].some((k) => k.startsWith(`${voice.id}:`))) continue;
    if (voice.instrument) used.add(voice.instrument);
    for (const pattern of Object.values(voice.patterns ?? {})) {
      for (const e of grooveOf(pattern) ?? []) if (typeof e === "object" && typeof e.inst === "string") used.add(e.inst);
    }
  }
  for (const name of Object.values((ctx.raw.kit ?? {}) as Record<string, string>)) used.add(String(name));
  return used;
}

function instrumentNames(ctx: Ctx, accept: (inst: Record<string, any>) => boolean): string[] {
  const used = usedInstruments(ctx);
  return Object.keys(ctx.raw.instruments ?? {}).filter((n) => used.has(n) && ctx.parsed.instruments[n] !== undefined && accept(ctx.raw.instruments[n])).sort();
}

const instrumentPath = (name: string) => `$.instruments.${name}`;

function envelope(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const names = instrumentNames(ctx, (i) => Array.isArray(i.adsr) && i.adsr.length === 4 && i.adsr.every((v: unknown) => Number.isInteger(v)));
  const name = pick(ctx, names);
  if (!name) return fail("no instrument with an ADSR");
  const adsr: number[] = ctx.raw.instruments[name].adsr;
  const old = [...adsr];
  const step = kind.severity === "release" ? 1 : 4;
  const slot = kind.severity === "release" ? 3 : seededIndex(`${ctx.key}|slot`, 2);
  const up = adsr[slot]! + step <= 15, down = adsr[slot]! - step >= 0;
  adsr[slot] = up && (signOf(ctx) > 0 || !down) ? adsr[slot]! + step : adsr[slot]! - step;
  if (!up && !down) return fail("no room to change the envelope");
  return done(ctx, kind, `envelope: ${name} adsr ${old.join(",")} to ${adsr.join(",")}`, [instrumentPath(name)]);
}

const WAVE_SWAP: Record<string, string> = { tri: "pulse", triangle: "pulse", pulse: "saw", saw: "tri", sawtooth: "tri" };

function waveform(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const name = pick(ctx, instrumentNames(ctx, (i) => typeof i.waveform === "string" && hasOwn(WAVE_SWAP, i.waveform) && !DRUM_NAME.test(String(i.waveform))));
  if (!name) return fail("no instrument with a pitched waveform");
  const inst = ctx.raw.instruments[name];
  const old = inst.waveform;
  inst.waveform = WAVE_SWAP[old];
  return done(ctx, kind, `waveform: ${name} ${old} to ${inst.waveform}`, [instrumentPath(name)]);
}

function firstSet(inst: Record<string, any>): Record<string, any> | undefined {
  const table = inst.pulsetable;
  const steps = Array.isArray(table) ? table : Array.isArray(table?.steps) ? table.steps : undefined;
  return steps?.find((s: any) => typeof s === "object" && Number.isFinite(Number(s.set)));
}

function pulseWidth(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const delta = Number(kind.severity);
  const names = instrumentNames(ctx, (i) => (i.waveform === "pulse" || i.waveform === undefined) && (Number.isFinite(Number(i.pulse_width)) || firstSet(i) !== undefined));
  const name = pick(ctx, names);
  if (!name) return fail("no pulse instrument with a pulse width");
  const inst = ctx.raw.instruments[name];
  const holder = Number.isFinite(Number(inst.pulse_width)) ? inst : firstSet(inst)!;
  const key = holder === inst ? "pulse_width" : "set";
  const original = Number(holder[key]);
  // A value up to 1 is a fraction of the period; work in register units.
  const old = original > 0 && original <= 1 ? Math.round(original * 4095) : original;
  const next = old + delta * signOf(ctx) >= 64 && old + delta * signOf(ctx) <= 4031 ? old + delta * signOf(ctx) : old - delta * signOf(ctx);
  if (next < 0 || next > 4095) return fail("pulse width out of range");
  holder[key] = next;
  return done(ctx, kind, `pulse width: ${name} ${old} to ${next}`, [instrumentPath(name)]);
}

function scaleCutoff(value: unknown, factor: number): string | number | undefined {
  if (typeof value === "number") return Math.max(0, Math.min(2047, Math.round(value * factor)));
  const m = typeof value === "string" ? /^([0-9.]+)\s*(kHz|Hz)$/i.exec(value.trim()) : null;
  if (!m) return undefined;
  const hz = Number(m[1]) * (m[2]!.toLowerCase() === "khz" ? 1000 : 1) * factor;
  return `${Math.round(hz)}Hz`;
}

function filterMutation(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const withTable = (i: Record<string, any>) => Array.isArray(i.filtertable) && i.filtertable.length > 0;
  const percent = kind.severity === "off" ? 0 : Number(kind.severity);
  const names = instrumentNames(ctx, (i) => withTable(i) && (kind.severity === "off" || scaleCutoff(i.filtertable[0]?.cutoff, 1) !== undefined));
  const name = pick(ctx, names);
  if (!name) return fail("no instrument with a filter table");
  const inst = ctx.raw.instruments[name];
  if (kind.severity === "off") {
    delete inst.filtertable;
    return done(ctx, kind, `filter off: ${name} loses its filter table`, [instrumentPath(name)]);
  }
  const old = inst.filtertable[0].cutoff;
  const factor = 1 + (signOf(ctx) * percent) / 100;
  const next = scaleCutoff(old, factor)!;
  inst.filtertable[0] = { ...inst.filtertable[0], cutoff: next };
  return done(ctx, kind, `filter cutoff: ${name} ${old} to ${next}`, [instrumentPath(name)]);
}

function syncRing(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const flagged = (i: Record<string, any>) => Array.isArray(i.wavetable) && i.wavetable.some((f: any) => f && (f.ring === true || f.sync === true) && Object.keys(f).some((k) => !["ring", "sync", "frames"].includes(k)));
  const name = pick(ctx, instrumentNames(ctx, flagged));
  if (!name) return fail("no instrument with ring or sync");
  const inst = ctx.raw.instruments[name];
  inst.wavetable = inst.wavetable.map((f: any) => {
    if (!f || (f.ring !== true && f.sync !== true)) return f;
    const { ring, sync, ...rest } = f;
    return rest;
  });
  return done(ctx, kind, `sync and ring removed from ${name}`, [instrumentPath(name)]);
}

function missingPercussion(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const voices = ctx.parsed.voices.filter((v) => isDrumVoice(ctx, v));
  const voice = pick(ctx, voices);
  if (!voice) return fail("no drum voice");
  const key = `v${voice.id}`;
  const targets: string[] = [];
  const mute = (layers: Record<string, any> | undefined) => {
    if (layers && typeof layers[key] === "string" && layers[key] !== "-") layers[key] = "-";
  };
  for (const section of Object.values((ctx.raw.sections ?? {}) as Record<string, any>)) mute(section?.layers);
  if (Array.isArray(ctx.raw.timeline)) for (const section of ctx.raw.timeline) if (section && typeof section === "object") mute(section.layers);
  ctx.parsed.timeline.forEach((section, i) => { if (section.layers[key] !== undefined && section.layers[key] !== "-") targets.push(`$.timeline[${i}].layers.${key}`); });
  if (!targets.length) return fail("the drum voice is not in the timeline");
  return done(ctx, kind, `missing percussion: voice ${voice.id} muted in ${targets.length} sections`, targets, 0);
}

function soundInSilence(ctx: Ctx, kind: MutationKind): MutationOutcome {
  if (!ctx.raw.instruments || typeof ctx.raw.instruments !== "object") return fail("the score declares no instruments");
  if (hasOwn(ctx.raw.instruments, "sw_burst")) return fail("the score already has an sw_burst instrument");
  const sites = pitchedSites(ctx, (e, g) => isRest(e) && g.length > 4).filter((s) => {
    const pattern = ctx.parsed.voices[s.voice]!.patterns![s.pattern]!;
    return beatsToFrames(ctx, pattern.length ?? 1) >= 5;
  });
  const site = pick(ctx, sites);
  if (!site) return fail("no rest of at least 5 frames");
  const pattern = ctx.parsed.voices[site.voice]!.patterns![site.pattern]!;
  const frames = beatsToFrames(ctx, pattern.length ?? 1);
  const groove = copyGroove(ctx, site);
  groove[site.index] = { note: "C6", inst: "sw_burst", gate_off: Math.max(0, Math.floor(frames - 2.5)) };
  rewriteGroove(ctx, site, groove);
  ctx.raw.instruments.sw_burst = { waveform: "noise", adsr: [0, 0, 15, 0] };
  return done(ctx, kind, `sound in silence: noise burst in the rest at ${site.pattern}[${site.index}]`, [pathOf(site), instrumentPath("sw_burst")], site.firstUse);
}

function sectionsSwapped(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const timeline = ctx.raw.timeline;
  if (!Array.isArray(timeline) || timeline.length < 2) return fail("the score has no timeline list");
  const secondsPerBeat = 60 / ctx.parsed.song.tempo;
  let beat = 0;
  const pairs: number[] = [];
  ctx.parsed.timeline.forEach((section, i) => {
    const next = ctx.parsed.timeline[i + 1];
    if (next && beat * secondsPerBeat < ctx.horizon - 4 && JSON.stringify(section.layers) !== JSON.stringify(next.layers) && section.bars === next.bars) pairs.push(i);
    beat += section.bars * barBeats(ctx.parsed, i);
  });
  if (ctx.parsed.timeline.length !== timeline.length) return fail("timeline entries are not one to one with sections");
  const i = pick(ctx, pairs);
  if (i === undefined) return fail("no two neighbouring sections of the same length with different layers");
  [timeline[i], timeline[i + 1]] = [timeline[i + 1], timeline[i]];
  return done(ctx, kind, `sections swapped: ${i + 1} and ${i + 2}`, [`$.timeline[${i}]`, `$.timeline[${i + 1}]`]);
}

function loopPoint(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const to = ctx.raw.loop_to;
  if (typeof to !== "number" || !Number.isInteger(to)) return fail("the score has no numeric loop_to");
  const next = to + 1 < ctx.parsed.song.length_bars ? to + 1 : to - 1;
  if (next < 0) return fail("no room to move the loop point");
  ctx.raw.loop_to = next;
  return done(ctx, kind, `loop point moved from bar ${to} to ${next}`, ["$.loopTo"]);
}

function renameInstrument(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const name = pick(ctx, instrumentNames(ctx, () => true).filter((n) => /^[A-Za-z0-9_]+$/.test(n)));
  if (!name) return fail("no instrument to rename");
  const renamed = `${name}_r`;
  if (hasOwn(ctx.raw.instruments, renamed)) return fail("renamed instrument exists");
  // Rename keys, string values equal to the name, and @name tokens in groove strings.
  const text = JSON.stringify(ctx.raw)
    .split(`"${name}"`).join(`"${renamed}"`)
    .replace(new RegExp(`@${name}(?![A-Za-z0-9_:])`, "g"), `@${renamed}`);
  const after = JSON.parse(text) as RawScore;
  for (const key of Object.keys(ctx.raw)) delete ctx.raw[key];
  Object.assign(ctx.raw, after);
  return done(ctx, kind, `refactor: instrument ${name} renamed to ${renamed}`, ["$.instruments", "$.voices"]);
}

function duplicatePattern(ctx: Ctx, kind: MutationKind): MutationOutcome {
  const sites = pitchedSites(ctx, (e) => isPitched(ctx, e));
  const site = pick(ctx, sites);
  if (!site) return fail("no pattern");
  const voice = ctx.raw.voices[site.voice];
  const copy = `${site.pattern}_dup`;
  if (hasOwn(voice.patterns, copy)) return fail("duplicate exists");
  voice.patterns[copy] = JSON.parse(JSON.stringify(voice.patterns[site.pattern]));
  const key = `v${site.voiceId}`;
  const replace = (layers: Record<string, any> | undefined) => {
    if (layers && typeof layers[key] === "string") {
      layers[key] = layers[key].replace(new RegExp(`(?<![A-Za-z0-9_])${site.pattern}(?![A-Za-z0-9_])`, "g"), copy);
    }
  };
  for (const section of Object.values((ctx.raw.sections ?? {}) as Record<string, any>)) replace(section?.layers);
  if (Array.isArray(ctx.raw.timeline)) for (const section of ctx.raw.timeline) if (section && typeof section === "object") replace(section.layers);
  const targets = [`$.voices[${site.voice}].patterns`];
  ctx.parsed.timeline.forEach((section, i) => { if (section.layers[key]?.includes(site.pattern)) targets.push(`$.timeline[${i}].layers.${key}`); });
  return done(ctx, kind, `refactor: pattern ${site.pattern} duplicated as ${copy} for voice ${site.voiceId}`, targets);
}

/**
 * Applies one mutation to a copy of `source`. Returns the mutated raw document and what changed, or the reason why
 * the mutation does not apply to this tune.
 */
export function mutateScore(source: string | object, kind: MutationKind, context: MutationContext): MutationOutcome {
  if (kind.class === "identical") {
    return { applied: true, document: readRawScore(source), mutation: { ...kind, description: "identical recompile", targets: [] } };
  }
  // A mutation can produce a score that the compiler refuses (a note out of range for an instrument, a player that
  // no longer fits the cycle budget). Another target is then drawn, up to MAX_ATTEMPTS times.
  let last: MutationOutcome = fail("no attempt");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = readRawScore(source);
    let ctx: Ctx;
    try {
      ctx = buildContext(raw, context, kind, attempt);
    } catch (error) {
      return fail(`the score does not parse: ${(error as Error).message}`);
    }
    const outcome = applyKind(ctx, kind);
    if (!outcome.applied) return attempt === 0 ? outcome : fail(`${last.applied ? "" : (last as { reason: string }).reason}; no variant compiles`);
    try {
      compileSidwaveToPrg(parseSidwave(JSON.parse(JSON.stringify(outcome.document))));
      return outcome;
    } catch (error) {
      last = fail(`the mutated score does not compile: ${(error as Error).message.slice(0, 120)}`);
    }
  }
  return last;
}

const MAX_ATTEMPTS = 8;

function applyKind(ctx: Ctx, kind: MutationKind): MutationOutcome {
  switch (kind.class) {
    case "wrong_note": return shiftNote(ctx, kind, Number(kind.severity), "wrong note");
    case "octave_error": return shiftNote(ctx, kind, 12, "octave error");
    case "missing_note": return missingNote(ctx, kind);
    case "extra_note": return extraNote(ctx, kind);
    case "detune_voice": return detuneVoice(ctx, kind);
    case "timing_shift": return timingShift(ctx, kind);
    case "tempo_drift": return tempoDrift(ctx, kind);
    case "gate_length": return gateLength(ctx, kind);
    case "envelope": return envelope(ctx, kind);
    case "waveform": return waveform(ctx, kind);
    case "pulse_width": return pulseWidth(ctx, kind);
    case "filter": return filterMutation(ctx, kind);
    case "sync_ring": return syncRing(ctx, kind);
    case "missing_percussion": return missingPercussion(ctx, kind);
    case "sound_in_silence": return soundInSilence(ctx, kind);
    case "sections_swapped": return sectionsSwapped(ctx, kind);
    case "loop_point": return loopPoint(ctx, kind);
    case "long_tune_defect": {
      if (ctx.parsed.timeline.reduce((n, s, i) => n + s.bars * barBeats(ctx.parsed, i), 0) * 60 / ctx.parsed.song.tempo < 90) return fail("the tune is shorter than 90 s");
      return shiftNote(ctx, kind, 1, "long-tune defect", LONG_DEFECT_MIN_START);
    }
    case "refactor_rename_instrument": return renameInstrument(ctx, kind);
    case "refactor_duplicate_pattern": return duplicatePattern(ctx, kind);
    case "identical": return fail("identical needs no mutation");
  }
}

/** Paths at which two parsed scores differ, as `$.a.b[0]` strings. Maps are compared by their entries. */
export function diffPaths(a: unknown, b: unknown, path = "$"): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b) ? [] : [path];
  if (a instanceof Map && b instanceof Map) {
    return [...new Set([...a.keys(), ...b.keys()])].flatMap((k) => diffPaths(a.get(k), b.get(k), `${path}.${String(k)}`));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [path];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffPaths(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((k) => diffPaths(x[k], y[k], `${path}.${k}`));
}
