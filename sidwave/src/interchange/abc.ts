// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Bounded reader of an ABC 2.1 subset: tune selection, information fields and music code, giving per-voice written bars.
// Section numbers refer to the ABC 2.1 standard. Every pass is one forward scan; every repetition count is bounded.

import { InterchangeInputError } from "./errors.js";

export class AbcImportError extends InterchangeInputError {
  constructor(message: string, yaml?: string) { super(message, yaml); this.name = "AbcImportError"; }
}

export const ABC_LIMITS = {
  inputBytes: 8 * 1024 * 1024,
  fileLines: 500_000,
  tuneLines: 100_000,
  fieldChars: 4096,
  voices: 64,
  chordTones: 32,
  /** Written notes and rests of one tune; each chord tone counts. */
  writtenTones: 200_000,
  writtenBars: 8192,
} as const;

export interface AbcMeter { num: number; den: number; /** Bar length in quarter-note beats. */ beats: number; compound: boolean; free: boolean }
export interface AbcTone { pitch: number; beats: number; tie: boolean; /** Written letter and octave, for ties that carry an accidental. */ written: string }
/** A note, chord or rest (no tones), or with `beats` 0 a change of tempo or metre inside a bar. */
export interface AbcEvent { tones: AbcTone[]; beats: number; tempo?: number; meter?: AbcMeter }
export interface AbcBar {
  events: AbcEvent[];
  /** Tempo (quarter notes per minute) and metre in effect at the first note of the bar. */
  tempo: number;
  meter: AbcMeter;
  startRepeat: boolean;
  /** Number of colons before the closing bar line; 0 when the bar does not end a repeat. */
  endRepeat: number;
  /** The closing bar line is a double or final bar. */
  sectionEnd: boolean;
  /** Pass numbers of a variant ending that starts at this bar. */
  ending?: number[];
}
export interface AbcVoice { id: string; bars: AbcBar[] }
export interface AbcTune {
  number: string;
  title?: string;
  composer?: string;
  tempo: number;
  meter: AbcMeter;
  voices: AbcVoice[];
  /** Skipped or unconnected content by kind. */
  skipped: Map<AbcSkip, number>;
}
export type AbcSkip = "chords" | "decorations" | "grace" | "annotations" | "lyrics" | "directives" | "slurs" | "ties" | "overlays" | "parts" | "charset";

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
/** Position of the major key on the circle of fifths. */
const FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
/** Signature of a mode relative to the major key on the same tonic; only three letters of a mode name count (3.1.14). */
const MODES: Record<string, number> = { maj: 0, ion: 0, mix: -1, dor: -2, min: -3, aeo: -3, phr: -4, loc: -5, lyd: 1 };
const CLEFS = /^(?:treble|alto|tenor|bass|perc|none)(?:[1-5])?([+-]8)?$/i;

const FIELD_LINE = /^([A-Za-z+]):(?![|:])(.*)$/;
const BLANK = /^[ \t]*$/;
const NOTE = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/y;
const LENGTH = /(\d*)(\/*)(\d*)/y;
const TUPLET = /\((\d{1,2})(?::(\d{0,2}))?(?::(\d{0,2}))?/y;
const ENDING = /(\d{1,2}(?:[-,]\d{1,2})*)/y;
const DECORATION = /![^!\s|[\]"]{0,64}!|\+[^+\s|[\]"]{0,64}\+/y;

/** The text before a `%` that is not escaped with a backslash. */
function stripComment(text: string): string {
  for (let at = text.indexOf("%"); at >= 0; at = text.indexOf("%", at + 1)) if (text[at - 1] !== "\\") return text.slice(0, at).trim();
  return text.trim();
}

export function decodeAbc(bytes: Uint8Array): { text: string; latin1: boolean } {
  if (bytes.length > ABC_LIMITS.inputBytes) throw new AbcImportError(`the ABC file has ${bytes.length} bytes; the limit is ${ABC_LIMITS.inputBytes}`);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), latin1: false }; } catch {
    // Files older than ABC 2.1 use Latin-1; only titles and other text differ.
    return { text: new TextDecoder("latin1").decode(bytes), latin1: true };
  }
}

interface TuneRange { number: string; start: number; end: number }

/** Splits a file into its lines, file header and tunes. A tune ends at an empty line, the next X: or the end (2.2.1). */
export function scanAbc(text: string): { lines: string[]; fileHeader: string[]; tunes: TuneRange[] } {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > ABC_LIMITS.fileLines) throw new AbcImportError(`the ABC file has more than ${ABC_LIMITS.fileLines} lines`);
  let i = 0;
  while (i < lines.length && BLANK.test(lines[i]!)) i++;
  const first: string[] = [];
  while (i < lines.length && !BLANK.test(lines[i]!) && !lines[i]!.startsWith("X:")) first.push(lines[i++]!);
  const isHeader = (i >= lines.length || BLANK.test(lines[i]!)) && first.every((line) => line.startsWith("%") || FIELD_LINE.test(line));
  const tunes: TuneRange[] = [];
  let open: TuneRange | undefined;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (line.startsWith("X:")) {
      if (open) open.end = n;
      open = { number: stripComment(line.slice(2, 2 + ABC_LIMITS.fieldChars)), start: n, end: lines.length };
      tunes.push(open);
    } else if (open && BLANK.test(line)) { open.end = n; open = undefined; }
  }
  return { lines, fileHeader: isHeader ? first : [], tunes };
}

function integer(text: string, min: number, max: number, what: string): number {
  const value = /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= min && value <= max)) throw new AbcImportError(`${what} "${text}" is outside ${min}..${max}`);
  return value;
}

function parseMeter(text: string): AbcMeter {
  const make = (num: number, den: number, free = false): AbcMeter => ({ num, den, beats: num * 4 / den, compound: !free && den >= 8 && (num === 6 || num === 9 || num === 12), free });
  if (text === "" || text.toLowerCase() === "none") return make(4, 4, true);
  if (text === "C") return make(4, 4);
  if (text === "C|") return make(2, 2);
  const m = /^\(?(\d{1,2}(?:\+\d{1,2}){0,15})\)?\s*\/\s*(\d{1,2})$/.exec(text);
  if (!m) throw new AbcImportError(`invalid ABC metre "${text}"`);
  const num = m[1]!.split("+").reduce((sum, part) => sum + Number(part), 0);
  const den = Number(m[2]);
  if (num < 1 || ![1, 2, 4, 8, 16, 32].includes(den) || num * 4 / den > 32) throw new AbcImportError(`ABC metre "${text}" is outside the supported range`);
  return make(num, den);
}

/** The unit note length in quarter-note beats. */
function parseUnit(text: string): number {
  const m = /^(\d{1,3})(?:\s*\/\s*(\d{1,3}))?$/.exec(text);
  const top = Number(m?.[1]), bottom = Number(m?.[2] ?? 1);
  if (!m || !(top >= 1 && top <= 64 && bottom >= 1 && bottom <= 512)) throw new AbcImportError(`invalid ABC unit note length "${text}"`);
  return top * 4 / bottom;
}

/** Quarter notes per minute, or undefined for a tempo that is only a text such as "Andante" (3.1.8). */
function parseTempo(text: string, unit: number): number | undefined {
  const value = text.replace(/"[^"]*"/g, " ").trim();
  if (value === "") return undefined;
  const m = /^(?:((?:\d{1,3}\/\d{1,3}\s*){1,8}|C\d{0,3})\s*=\s*)?(\d{1,6}(?:\.\d{1,6})?)$/.exec(value);
  if (!m) throw new AbcImportError(`invalid ABC tempo "${text}"`);
  let beat = unit; // the deprecated forms Q:120 and Q:C3=40 count unit note lengths
  if (m[1]?.startsWith("C")) beat = unit * Number(m[1].slice(1) || 1);
  else if (m[1]) beat = m[1].trim().split(/\s+/).reduce((sum, part) => sum + parseUnit(part), 0);
  const bpm = beat * Number(m[2]);
  if (!(bpm >= 1 && bpm <= 100_000)) throw new AbcImportError(`ABC tempo "${text}" is outside the supported range`);
  return bpm;
}

/** Playback transposition of `octave=`, `transpose=` and a clef with +8 or -8 in K: and V: fields (4.6). */
function parseShift(tokens: string[]): number | undefined {
  let shift: number | undefined;
  for (const token of tokens) {
    const m = /^(octave|transpose)=([+-]?\d{1,2})$/.exec(token);
    const clef = CLEFS.exec(token.replace(/^clef=/, ""));
    if (m) shift = (shift ?? 0) + Number(m[2]) * (m[1] === "octave" ? 12 : 1);
    else if (clef?.[1]) shift = (shift ?? 0) + (clef[1] === "+8" ? 12 : -12);
  }
  return shift;
}

/** A K: field: the accidentals by note letter (absent when the field only changes the clef) and the transposition. */
function parseKey(text: string): { accidentals?: Map<string, number>; shift?: number } {
  const accidentals = new Map<string, number>();
  const bad = (): never => { throw new AbcImportError(`invalid ABC key "${text}"`); };
  let rest = text;
  let hasKey = false;
  const tonic = /^([A-G])([#b]?)(?![A-Za-z]*=)/.exec(rest);
  if (/^(?:none\b|HP\b|Hp\b)/.test(rest)) {
    if (rest.startsWith("Hp")) accidentals.set("F", 1).set("C", 1).set("G", 0);
    hasKey = true;
    rest = rest.replace(/^(?:none|HP|Hp)/, "");
  } else if (tonic && !CLEFS.test(rest.split(/\s+/)[0]!)) {
    hasKey = true;
    rest = rest.slice(tonic[0].length).trimStart();
    const word = /^[A-Za-z]+(?![A-Za-z0-9=+-])/.exec(rest)?.[0];
    let mode = 0;
    let explicit = false;
    if (word !== undefined && !CLEFS.test(word)) {
      const name = word.toLowerCase();
      if (name === "exp") explicit = true;
      else mode = name === "m" ? -3 : MODES[name.slice(0, 3)] ?? bad();
      rest = rest.slice(word.length);
    }
    if (!explicit) {
      const fifths = FIFTHS[tonic[1]!]! + (tonic[2] === "#" ? 7 : tonic[2] === "b" ? -7 : 0) + mode;
      if (Math.abs(fifths) > 7) throw new AbcImportError(`ABC key "${text}" needs more than seven sharps or flats`);
      for (let i = 0; i < Math.abs(fifths); i++) accidentals.set(SHARP_ORDER[fifths > 0 ? i : 6 - i]!, Math.sign(fifths));
    }
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === "exp") { accidentals.clear(); continue; }
    if (/^(?:(?:\^\^|\^|__|_|=)[A-Ga-g])+$/.test(token)) {
      for (const m of token.matchAll(/(\^\^|\^|__|_|=)([A-Ga-g])/g)) accidentals.set(m[2]!.toUpperCase(), alteration(m[1]!));
      hasKey = true;
    } else if (!CLEFS.test(token) && !/^[A-Za-z]+=\S*$/.test(token)) bad();
  }
  const shift = parseShift(tokens);
  return { ...(hasKey ? { accidentals } : {}), ...(shift === undefined ? {} : { shift }) };
}

const alteration = (sign: string): number => (sign === "=" ? 0 : sign[0] === "^" ? sign.length : -sign.length);

interface VoiceState {
  id: string;
  bars: AbcBar[];
  bar: AbcBar;
  key: Map<string, number>;
  keyShift: number;
  voiceShift: number;
  unit: number;
  meter: AbcMeter;
  tempo: number;
  accidentals: Map<string, number>;
  /** The last note or rest, which `-` and broken rhythm refer to. */
  last?: AbcEvent | undefined;
  /** Pitches of the tied notes by written letter and octave, for the next note. */
  tied: Map<string, number>;
  tupletFactor: number;
  tupletLeft: number;
  broken?: number | undefined;
  /** Music after `&` up to the next bar line is skipped. */
  overlay: boolean;
}
interface Defaults { key: Map<string, number>; keyShift: number; unit: number; meter: AbcMeter; tempo: number }

const newBar = (): AbcBar => ({ events: [], tempo: 120, meter: parseMeter(""), startRepeat: false, endRepeat: 0, sectionEnd: false });

class TuneParser {
  readonly voices = new Map<string, VoiceState>();
  readonly skipped = new Map<AbcSkip, number>();
  private current: VoiceState | undefined;
  private firstVoice = "1";
  private tones = 0;
  private propagate: "not" | "octave" | "pitch" = "pitch";
  private readonly userSymbols = new Set([..."~HLMOPSTuv."]);
  private line = 0;

  constructor(private defaults: Defaults) {}

  skip(kind: AbcSkip, by = 1): void { this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + by); }
  private fail(message: string): never { throw new AbcImportError(this.line ? `line ${this.line}: ${message}` : message); }

  private voice(id: string): VoiceState {
    let v = this.voices.get(id);
    if (!v) {
      if (!/^[^\s[\]]{1,64}$/.test(id)) this.fail("invalid ABC voice id");
      if (this.voices.size >= ABC_LIMITS.voices) this.fail(`the tune has more than ${ABC_LIMITS.voices} voices`);
      v = { id, bars: [], bar: newBar(), ...this.defaults, voiceShift: 0, accidentals: new Map(), tied: new Map(), tupletFactor: 1, tupletLeft: 0, overlay: false };
      this.voices.set(id, v);
    }
    return v;
  }
  private active(): VoiceState { return (this.current ??= this.voice(this.firstVoice)); }

  declareVoice(value: string, header: boolean): void {
    const [id = "", ...properties] = value.replace(/"[^"]*"/g, '""').split(/\s+/);
    const v = this.voice(id);
    const shift = parseShift(properties);
    if (shift !== undefined) v.voiceShift = shift;
    if (!header) this.current = v;
    else if (this.voices.size === 1) this.firstVoice = id;
  }

  directive(text: string): void {
    const m = /^propagate-accidentals\s+(not|octave|pitch)\b/.exec(text);
    if (m) this.propagate = m[1] as "not" | "octave" | "pitch";
    else this.skip("directives");
  }

  userSymbol(value: string): void {
    const m = /^([H-Wh-w~])\s*=/.exec(value);
    if (m) this.userSymbols.add(m[1]!);
  }

  /** A field in the tune body, on its own line or inline. A field line before the first note and V: applies to every voice. */
  field(letter: string, value: string, inline: boolean): void {
    if (letter === "V") return this.declareVoice(value, false);
    if (letter === "K" || letter === "L" || letter === "M" || letter === "Q") {
      const all = !inline && this.current === undefined;
      const targets: VoiceState[] = all ? [...this.voices.values()] : [this.active()];
      const unit = targets[0]?.unit ?? this.defaults.unit;
      let change: Partial<Defaults> = {};
      if (letter === "L") change = { unit: parseUnit(value) };
      else if (letter === "M") change = { meter: parseMeter(value) };
      else if (letter === "Q") { const tempo = parseTempo(value, unit); if (tempo !== undefined) change = { tempo }; }
      else {
        const key = parseKey(value);
        change = { ...(key.accidentals ? { key: key.accidentals } : {}), ...(key.shift === undefined ? {} : { keyShift: key.shift }) };
        if (key.accidentals) for (const v of targets) v.accidentals.clear();
      }
      if (all) this.defaults = { ...this.defaults, ...change };
      for (const v of targets) {
        Object.assign(v, change);
        const meter = change.meter, tempo = change.tempo;
        if (v.bar.events.length && (meter || tempo !== undefined)) this.push(v, { tones: [], beats: 0, ...(meter ? { meter } : {}), ...(tempo === undefined ? {} : { tempo }) });
      }
      return;
    }
    if (letter === "I") return this.directive(value);
    if (letter === "U") this.userSymbol(value);
    this.skip(letter === "w" || letter === "W" ? "lyrics" : letter === "P" ? "parts" : "directives");
  }

  private push(v: VoiceState, event: AbcEvent): void {
    this.tones += Math.max(1, event.tones.length);
    if (this.tones > ABC_LIMITS.writtenTones) this.fail(`the tune has more than ${ABC_LIMITS.writtenTones} notes and rests`);
    if (!v.bar.events.length) { v.bar.tempo = v.tempo; v.bar.meter = v.meter; }
    v.bar.events.push(event);
  }

  /** Applies a pending broken rhythm and tuplet, checks the duration and appends the note, chord or rest. */
  private emit(v: VoiceState, event: AbcEvent, counted: boolean): void {
    let factor = 1;
    if (counted && v.broken !== undefined) { factor *= v.broken; v.broken = undefined; }
    if (counted && v.tupletLeft > 0) { factor *= v.tupletFactor; v.tupletLeft--; }
    scale(event, factor);
    for (const beats of [event.beats, ...event.tones.map((t) => t.beats)]) if (!(beats > 0 && beats <= 2048)) this.fail("an ABC note length is outside the supported range");
    v.last = counted ? event : undefined;
    if (v.overlay) return;
    v.tied.clear();
    this.push(v, event);
  }

  /** Length suffix: `3`, `/`, `//`, `3/2`, `/4` (4.3). */
  private readLength(text: string, at: number): { multiplier: number; end: number } {
    LENGTH.lastIndex = at;
    const [all, top, slashes, bottom] = LENGTH.exec(text)!;
    if (top!.length > 4 || bottom!.length > 4 || slashes!.length > 10) this.fail("an ABC note length is outside the supported range");
    const numerator = top ? Number(top) : 1;
    const denominator = !slashes ? 1 : bottom ? Number(bottom) * 2 ** (slashes.length - 1) : 2 ** slashes.length;
    if (!(numerator >= 1 && numerator <= 1024 && denominator >= 1 && denominator <= 1024)) this.fail("an ABC note length is outside the supported range");
    return { multiplier: numerator / denominator, end: at + all.length };
  }

  private readNote(v: VoiceState, text: string, at: number): { tone: AbcTone; end: number } {
    NOTE.lastIndex = at;
    const m = NOTE.exec(text);
    if (!m) this.fail(`an accidental is not followed by a note (column ${at + 1})`);
    const [all, sign, letter, marks] = m;
    if (marks!.length > 16) this.fail("too many octave marks");
    let octave = letter! >= "a" ? 5 : 4;
    for (const mark of marks!) octave += mark === "'" ? 1 : -1;
    const name = letter!.toUpperCase();
    const written = `${name}${octave}`;
    const scope = this.propagate === "octave" ? written : name;
    const shift = v.keyShift + v.voiceShift;
    let pitch: number;
    const natural = (octave + 1) * 12 + STEP[name]! + shift;
    if (sign !== undefined) {
      const alter = alteration(sign);
      if (this.propagate !== "not") v.accidentals.set(scope, alter);
      pitch = natural + alter;
    } else pitch = v.tied.get(written) ?? natural + (v.accidentals.get(scope) ?? v.key.get(name) ?? 0);
    const length = this.readLength(text, at + all.length);
    return { tone: { pitch, beats: v.unit * length.multiplier, tie: false, written }, end: length.end };
  }

  private tie(v: VoiceState, tones: AbcTone[]): void {
    if (v.overlay) return;
    for (const tone of tones) { tone.tie = true; v.tied.set(tone.written, tone.pitch); }
  }

  /** A chord `[CEG]2`: its length is that of the first note times the length after the bracket (4.17). */
  private chord(v: VoiceState, text: string, at: number): number {
    const tones: AbcTone[] = [];
    const ties: AbcTone[] = [];
    let i = at + 1;
    for (;;) {
      const c = text[i];
      if (c === undefined) this.fail("unterminated ABC chord");
      if (c === "]") break;
      if (c === " " || c === "\t" || c === ".") i++;
      else if (c === "-" && tones.length) { ties.push(tones[tones.length - 1]!); i++; }
      else if (c === '"') { i = this.annotation(text, i); }
      else if (c === "!" || c === "+") i = this.decoration(text, i);
      else if (c === "{") i = this.grace(text, i);
      else if (/[\^_=A-Ga-g]/.test(c)) {
        const note = this.readNote(v, text, i);
        tones.push(note.tone);
        if (tones.length > ABC_LIMITS.chordTones) this.fail(`an ABC chord has more than ${ABC_LIMITS.chordTones} notes`);
        i = note.end;
      } else if (this.userSymbols.has(c)) { this.skip("decorations"); i++; }
      else this.fail(`unexpected "${c}" in an ABC chord`);
    }
    if (!tones.length) this.fail("an ABC chord has no notes");
    const length = this.readLength(text, i + 1);
    for (const tone of tones) tone.beats *= length.multiplier;
    if (tones.length > 1) this.skip("chords");
    this.emit(v, { tones, beats: tones[0]!.beats }, true);
    this.tie(v, ties);
    return length.end;
  }

  private annotation(text: string, at: number): number {
    for (let end = text.indexOf('"', at + 1); end >= 0; end = text.indexOf('"', end + 1)) {
      if (text[end - 1] !== "\\") { this.skip("annotations"); return end + 1; }
    }
    return this.fail("unterminated ABC chord symbol or annotation");
  }

  private grace(text: string, at: number): number {
    const end = text.indexOf("}", at + 1);
    if (end < 0) this.fail("unterminated ABC grace group");
    this.skip("grace");
    return end + 1;
  }

  private decoration(text: string, at: number): number {
    DECORATION.lastIndex = at;
    const m = DECORATION.exec(text);
    if (m) { this.skip("decorations"); return at + m[0].length; }
    // A lone ! is the line break of older files (10.2.1).
    if (text[at] === "!") return at + 1;
    return this.fail("unterminated ABC decoration");
  }

  private closeBar(v: VoiceState, endRepeat: number, startRepeat: boolean, sectionEnd: boolean): void {
    v.accidentals.clear();
    v.overlay = false;
    let closed = v.bars[v.bars.length - 1];
    if (v.bar.events.length) {
      closed = v.bar;
      v.bars.push(closed);
      if (v.bars.length > ABC_LIMITS.writtenBars) this.fail(`the tune has more than ${ABC_LIMITS.writtenBars} written bars`);
      v.bar = newBar();
    }
    if (closed && endRepeat) closed.endRepeat = endRepeat;
    if (closed && sectionEnd) closed.sectionEnd = true;
    if (startRepeat) v.bar.startRepeat = true;
  }

  /** `[1`, `|1`, `:|2`, `[1,3` or `[1-3` (4.9, 4.10). */
  private ending(v: VoiceState, text: string, at: number): number {
    ENDING.lastIndex = at;
    const m = ENDING.exec(text);
    if (!m || m[0].length > 64) this.fail("invalid ABC variant ending");
    const passes = new Set<number>();
    for (const part of m[0].split(",")) {
      const [from = "", to = from, extra] = part.split("-");
      if (extra !== undefined) this.fail("invalid ABC variant ending");
      const low = integer(from, 1, 16, "ABC ending number");
      for (let n = low, high = integer(to, low, 16, "ABC ending number"); n <= high; n++) passes.add(n);
    }
    if (v.bar.events.length) this.closeBar(v, 0, false, false);
    v.bar.ending = [...passes];
    return at + m[0].length;
  }

  /** Any run of `|`, `:` and thick bars is one bar line (4.8). */
  private barLine(v: VoiceState, text: string, at: number): number {
    let i = at;
    let run = "";
    for (;;) {
      const c = text[i];
      if (c === "|" || c === ":" || c === "]") { run += c; i++; }
      else if (c === "[" && text[i + 1] === "|") { run += "[|"; i += 2; }
      else if (c === "." && text[i + 1] === "|") i++;
      else break;
      if (run.length > 32) this.fail("an ABC bar line is too long");
    }
    const before = /^:*/.exec(run)![0].length;
    const after = before === run.length ? 0 : /:*$/.exec(run)![0].length;
    const onlyColons = before === run.length;
    if (onlyColons && before < 2) this.fail('unexpected ":"');
    const endRepeat = onlyColons ? 1 : before;
    const startRepeat = onlyColons ? 1 : after;
    if (endRepeat > 8 || startRepeat > 8) this.fail("an ABC repeat is longer than nine passes");
    this.closeBar(v, endRepeat, startRepeat > 0, /\|\||\|\]|\[\|/.test(run));
    if (text[i] === "[" && /\d/.test(text[i + 1] ?? "")) return this.ending(v, text, i + 1);
    return /\d/.test(text[i] ?? "") ? this.ending(v, text, i) : i;
  }

  music(text: string, line: number): void {
    this.line = line;
    let i = 0;
    while (i < text.length) {
      const c = text[i]!;
      const next = text[i + 1] ?? "";
      if (c === " " || c === "\t" || c === "`" || c === "$") { i++; continue; }
      if (c === "%") return;
      if (c === "\\") {
        if (stripComment(text.slice(i + 1)) !== "") this.fail('"\\" is only valid at the end of a line');
        return;
      }
      if (c === "[" && /[A-Za-z]/.test(next) && text[i + 2] === ":" && text[i + 3] !== "|") {
        const end = text.indexOf("]", i + 3);
        if (end < 0 || end - i > 256) this.fail("unterminated ABC inline field");
        this.field(next, stripComment(text.slice(i + 3, end)), true);
        i = end + 1;
        continue;
      }
      const v = this.active();
      if (c === "[" && /\d/.test(next)) i = this.ending(v, text, i + 1);
      else if (c === "|" || c === ":" || c === "]" || (c === "[" && next === "|") || (c === "." && next === "|")) i = this.barLine(v, text, i);
      else if (c === "[") i = this.chord(v, text, i);
      else if (c === "(" && /\d/.test(next)) i = this.tuplet(v, text, i);
      else if (c === "(" || c === ")") { this.skip("slurs"); i++; }
      else if (c === "." && (next === "(" || next === "-" || next === ")")) i++;
      else if (c === "!" || c === "+") i = this.decoration(text, i);
      else if (c === "{") i = this.grace(text, i);
      else if (c === '"') i = this.annotation(text, i);
      else if (c === ">" || c === "<") i = this.brokenRhythm(v, text, i);
      else if (c === "-") {
        if (v.last?.tones.length) this.tie(v, v.last.tones); else this.skip("ties");
        i++;
      } else if (/[\^_=A-Ga-g]/.test(c)) {
        const note = this.readNote(v, text, i);
        this.emit(v, { tones: [note.tone], beats: note.tone.beats }, true);
        i = note.end;
      } else if (c === "z" || c === "x") {
        const length = this.readLength(text, i + 1);
        this.emit(v, { tones: [], beats: v.unit * length.multiplier }, true);
        i = length.end;
      } else if (c === "Z" || c === "X") {
        // Multi-measure rest (4.5).
        const digits = /^\d{0,4}/.exec(text.slice(i + 1, i + 6))![0];
        const measures = digits ? integer(digits, 1, 999, "ABC multi-measure rest") : 1;
        this.emit(v, { tones: [], beats: measures * v.meter.beats }, false);
        i += 1 + digits.length;
      } else if (c === "y") i = this.readLength(text, i + 1).end;
      else if (c === "&") { v.overlay = true; v.last = undefined; this.skip("overlays"); i++; }
      else if (this.userSymbols.has(c)) { this.skip("decorations"); i++; }
      else if ("#*;?@".includes(c)) { this.skip("directives"); i++; }
      else this.fail(`unexpected character ${JSON.stringify(c)} at column ${i + 1}`);
    }
  }

  /** `(p:q:r`: p notes in the time of q for the next r notes; q depends on the metre when it is not given (4.13). */
  private tuplet(v: VoiceState, text: string, at: number): number {
    TUPLET.lastIndex = at;
    const m = TUPLET.exec(text)!;
    const p = integer(m[1]!, 2, 99, "ABC tuplet");
    const n = v.meter.compound ? 3 : 2;
    const usual: Record<number, number> = { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 };
    if (!m[2] && p > 9) this.fail("an ABC tuplet above nine needs the form (p:q");
    const q = m[2] ? integer(m[2], 1, 99, "ABC tuplet") : usual[p] ?? n;
    const r = m[3] ? integer(m[3], 1, 99, "ABC tuplet") : p;
    v.tupletFactor = q / p;
    v.tupletLeft = r;
    return at + m[0].length;
  }

  /** `a>b` dots the first note and halves the second; `<` is the reverse (4.4). */
  private brokenRhythm(v: VoiceState, text: string, at: number): number {
    const mark = text[at]!;
    let marks = 1;
    while (marks <= 3 && text[at + marks] === mark) marks++;
    if (marks > 3) this.fail("an ABC broken rhythm has more than three marks");
    if (!v.last || v.broken !== undefined) this.fail("an ABC broken rhythm has no preceding note");
    const short = 1 / 2 ** marks;
    const long = 2 - short;
    scale(v.last, mark === ">" ? long : short);
    v.broken = mark === ">" ? short : long;
    return at + marks;
  }

  finish(): AbcVoice[] {
    const out: AbcVoice[] = [];
    for (const v of this.voices.values()) {
      if (v.broken !== undefined) throw new AbcImportError(`voice ${v.id}: an ABC broken rhythm has no following note`);
      this.closeBar(v, 0, false, false);
      if (v.bars.some((bar) => bar.events.some((event) => event.tones.length))) out.push({ id: v.id, bars: v.bars });
    }
    return out;
  }
}

function scale(event: AbcEvent, factor: number): void {
  event.beats *= factor;
  for (const tone of event.tones) tone.beats *= factor;
}

/** Reads one tune: the first one, or the one whose X: number is `song`. */
export function parseAbcTune(bytes: Uint8Array, song?: number): AbcTune {
  if (song !== undefined && (!Number.isInteger(song) || song < 0)) throw new AbcImportError("the ABC tune number must be a whole number");
  const { text, latin1 } = decodeAbc(bytes);
  const { lines, fileHeader, tunes } = scanAbc(text);
  if (!tunes.length) throw new AbcImportError("the file has no ABC tune (a line that starts with X:)");
  const range = song === undefined ? tunes[0]! : tunes.find((t) => /^\d{1,9}$/.test(t.number) && Number(t.number) === song);
  if (!range) {
    const numbers = tunes.slice(0, 20).map((t) => t.number.slice(0, 12)).join(", ");
    throw new AbcImportError(`there is no ABC tune X:${song}; the file has X: ${numbers}${tunes.length > 20 ? `, ... (${tunes.length} tunes)` : ""}`);
  }
  if (!/^\d{0,9}$/.test(range.number)) throw new AbcImportError(`line ${range.start + 1}: invalid ABC tune number "${range.number.slice(0, 40)}"`);
  if (range.end - range.start > ABC_LIMITS.tuneLines) throw new AbcImportError(`the ABC tune has more than ${ABC_LIMITS.tuneLines} lines`);

  // Header: the fields of the file header, then those of the tune up to K:.
  const header: Array<{ letter: string; value: string; line: number }> = [];
  const directives: string[] = [];
  let body = -1;
  let inText = false;
  const headerLine = (line: string, number: number, inTune: boolean): boolean => {
    if (inText) { inText = !line.startsWith("%%endtext"); return false; }
    if (line.startsWith("%%begintext")) { inText = true; directives.push(line.slice(2)); return false; }
    if (line.startsWith("%%")) { directives.push(line.slice(2)); return false; }
    if (/^[ \t]*%/.test(line)) return false;
    const m = FIELD_LINE.exec(line);
    if (!m) throw new AbcImportError(`line ${number}: unexpected line in the ABC header (a field such as K: is expected)`);
    if (m[2]!.length > ABC_LIMITS.fieldChars) throw new AbcImportError(`line ${number}: an ABC field exceeds ${ABC_LIMITS.fieldChars} characters`);
    header.push({ letter: m[1]!, value: stripComment(m[2]!), line: number });
    return inTune && m[1] === "K";
  };
  if (fileHeader.length > ABC_LIMITS.tuneLines) throw new AbcImportError("the ABC file header is too long");
  for (const [n, line] of fileHeader.entries()) headerLine(line, n + 1, false);
  inText = false;
  for (let n = range.start; n < range.end && body < 0; n++) if (headerLine(lines[n]!, n + 1, true)) body = n + 1;
  if (body < 0) throw new AbcImportError(`ABC tune ${range.number} has no K: field, which ends the tune header`);

  // A later field overrides an earlier one, so the tune header overrides the file header.
  const values = new Map(header.map((field) => [field.letter, field.value]));
  const last = (letter: string): string | undefined => values.get(letter);
  const meter = parseMeter(last("M") ?? "");
  // Default unit note length (3.1.7).
  const unit = last("L") !== undefined ? parseUnit(last("L")!) : !meter.free && meter.num / meter.den < 0.75 ? 0.25 : 0.5;
  const tempo = (last("Q") === undefined ? undefined : parseTempo(last("Q")!, unit)) ?? 120;
  const key = parseKey(last("K")!);
  const defaults: Defaults = { key: key.accidentals ?? new Map(), keyShift: key.shift ?? 0, unit, meter, tempo };
  const parser = new TuneParser(defaults);
  for (const directive of directives) parser.directive(directive);
  let title: string | undefined, composer: string | undefined;
  for (const field of header) {
    if (field.letter === "T" && title === undefined) title = field.value;
    else if (field.letter === "C" && composer === undefined) composer = field.value;
    else if (field.letter === "V") parser.declareVoice(field.value, true);
    else if (field.letter === "I") parser.directive(field.value);
    else if (field.letter === "P") parser.skip("parts");
    else if (!"XTCMLQK+".includes(field.letter)) {
      if (field.letter === "U") parser.userSymbol(field.value);
      parser.skip(field.letter === "W" || field.letter === "w" ? "lyrics" : "directives");
    }
  }
  inText = false;
  for (let n = body; n < range.end; n++) {
    const line = lines[n]!;
    if (inText) { inText = !line.startsWith("%%endtext"); continue; }
    if (line.startsWith("%%")) { inText = line.startsWith("%%begintext"); parser.directive(line.slice(2)); continue; }
    const field = FIELD_LINE.exec(line);
    if (field) {
      if (field[2]!.length > ABC_LIMITS.fieldChars) throw new AbcImportError(`line ${n + 1}: an ABC field exceeds ${ABC_LIMITS.fieldChars} characters`);
      // `+:` continues the previous field, which in a tune body is lyrics or other text.
      if (field[1] !== "+") parser.field(field[1]!, stripComment(field[2]!), false);
    } else parser.music(line, n + 1);
  }
  const voices = parser.finish();
  if (latin1) parser.skip("charset");
  if (!voices.length) throw new AbcImportError(`ABC tune ${range.number} contains no notes`);
  return {
    number: range.number, ...(title ? { title } : {}), ...(composer ? { composer } : {}),
    tempo, meter, voices, skipped: parser.skipped,
  };
}
