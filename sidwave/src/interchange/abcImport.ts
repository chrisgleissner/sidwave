// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Bounded ABC 2.1 subset reader. Tokenisation, tune selection, timing and score construction are separate steps.
import { InterchangeInputError } from "./errors.js";
import { buildGridScore, reduceMonophonic, sidwaveMetre, type GridBar, type GridVoice, type QuantisedNote } from "./gridScore.js";
import { maxSidwaveMidi } from "../sidwaveCompiler.js";

export class AbcImportError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "AbcImportError"; }
}
export interface AbcOptions { title?: string; song?: number; grid?: number; voices?: number; mode?: "PAL" | "NTSC"; validate?: boolean }

type NoteAtom = {
  kind: "note";
  pitch: number;
  pitches?: number[];
  pitchDurations?: number[];
  tieKey?: string;
  duration: number;
  tie: boolean;
};
type RestAtom = { kind: "rest"; duration: number };
type Atom = NoteAtom | RestAtom;
type Bar = { atoms: Atom[]; repeatStart: boolean; repeatEnd: boolean; ending?: number };
type VoiceStream = {
  id: string;
  bars: Bar[];
  current: Bar;
  accidentals: Map<string, number>;
  tiedAtom?: NoteAtom;
  tupletFactor: number;
  tupletRemaining: number;
  broken?: number;
};
type Tune = { number: string; lines: string[] };
const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
const MAJOR_SIG: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  "G#": 8, "D#": 9, "A#": 10, "E#": 11, "B#": 12,
};
const MODE_SHIFT: Record<string, number> = {
  "": 0, major: 0, maj: 0, ionian: 0, ion: 0,
  minor: -3, min: -3, m: -3, aeolian: -3, aeo: -3,
  dorian: -2, dor: -2, phrygian: -4, phr: -4,
  lydian: 1, lyd: 1, mixolydian: -1, mix: -1, locrian: -5, loc: -5,
};
const TUPLET_TOKEN = /\((\d+)(?::(\d+))?(?::(\d+))?/y;
const ENDING_TOKEN = /\|\s*\[?([1-9])/y;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const NATURAL_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function pitchClass(name: string): number {
  const letter = name[0]!, accidental = name.slice(1);
  return ((NATURAL_PITCH[letter]! + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0)) % 12 + 12) % 12;
}

function parseKey(text: string): Map<string, number> {
  const match = /^([A-G])([#b]?)(?:\s*(major|maj|ionian|ion|minor|min|m|aeolian|aeo|dorian|dor|phrygian|phr|lydian|lyd|mixolydian|mix|locrian|loc))?(?:\s+.*)?$/i.exec(text.trim());
  if (!match) throw new AbcImportError(`invalid ABC key: ${text}`);
  const tonic = match[1]!.toUpperCase() + match[2]!;
  const modeText = (match[3] ?? "").toLowerCase();
  const shift = MODE_SHIFT[modeText];
  if (shift === undefined) throw new AbcImportError(`invalid ABC key mode: ${text}`);
  const tonicPitch = pitchClass(tonic);
  const majorPitch = ((tonicPitch - shift) % 12 + 12) % 12;
  const candidates = Object.entries(MAJOR_SIG).filter(([name, sf]) => pitchClass(name) === majorPitch && Math.abs(sf) <= 7)
    .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  // Prefer the written tonic's sharp/flat direction when enharmonic signatures exist.
  const wanted = tonic.includes("b") ? -1 : tonic.includes("#") ? 1 : 0;
  const chosen = candidates.find(([, sf]) => wanted === 0 || Math.sign(sf) === wanted) ?? candidates[0];
  if (!chosen) throw new AbcImportError(`unsupported ABC key: ${text}`);
  const sf = clamp(chosen[1], -7, 7);
  const result = new Map<string, number>();
  for (let i = 0; i < Math.abs(sf); i++) result.set((sf > 0 ? SHARP_ORDER : FLAT_ORDER)[i]!, sf > 0 ? 1 : -1);
  return result;
}

function parseFraction(text: string, what: string): number {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) throw new AbcImportError(`invalid ABC ${what}: ${text}`);
  const a = Number(m[1]), b = Number(m[2] ?? 1);
  if (a < 1 || b < 1 || a > 64 || b > 64) throw new AbcImportError(`ABC ${what} is outside supported bounds`);
  return a / b;
}

/** Split a file into tunes in one pass and select by the numeric X: field. */
function selectTune(source: string, requested: number): Tune {
  if (!Number.isInteger(requested) || requested < 1) throw new AbcImportError("ABC song selection must be a positive tune number");
  const tunes: Tune[] = [];
  let current: Tune | undefined;
  let lineStart = 0, lineCount = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const end = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, end).replace(/\r$/, "");
    if (++lineCount > 100_000) throw new AbcImportError("ABC input exceeds 100,000 lines");
    if (line.startsWith("X:")) {
      if (current) tunes.push(current);
      const number = line.slice(2).trim();
      if (!/^\d{1,9}$/.test(number)) throw new AbcImportError("invalid ABC X: tune number");
      current = { number: String(Number(number)), lines: [line] };
    } else if (current) current.lines.push(line);
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (current) tunes.push(current);
  const tune = tunes.find((item) => item.number === String(requested));
  if (!tune || !tune.lines.some((line) => /^K:\s*\S/.test(line))) throw new AbcImportError(`ABC tune ${requested} not found or missing K: header`);
  return tune;
}

function splitHeader(tune: Tune): { headers: Map<string, string>; body: string; unknownHeaders: number } {
  const headers = new Map<string, string>();
  const body: string[] = [];
  let unknownHeaders = 0;
  let started = false;
  for (const line of tune.lines) {
    const header = /^([A-Z]):\s*(.*)$/.exec(line);
    if (!started && header) {
      if (header[2]!.length > 4096) throw new AbcImportError("ABC header field exceeds 4096 characters");
      const key = header[1]!;
      if (["X", "T", "C", "M", "L", "Q", "K"].includes(key)) headers.set(key, header[2]!);
      else if (key === "V") { if (!headers.has("V")) headers.set(key, header[2]!); }
      else unknownHeaders++;
      if (key === "K") started = true;
    } else if (!started && line.startsWith("%%")) {
      unknownHeaders++;
    } else if (started) body.push(line);
  }
  if (!started) throw new AbcImportError("ABC tune is missing K: header");
  return { headers, body: body.join("\n"), unknownHeaders };
}

function makeBar(): Bar { return { atoms: [], repeatStart: false, repeatEnd: false }; }
function voiceFor(streams: Map<string, VoiceStream>, id: string): VoiceStream {
  if (!id || id.length > 64 || /[\[\]\r\n]/.test(id)) throw new AbcImportError("invalid ABC voice id");
  let stream = streams.get(id);
  if (!stream) {
    if (streams.size >= 64) throw new AbcImportError("ABC exceeds 64 voices");
    stream = { id, bars: [], current: makeBar(), accidentals: new Map(), tupletFactor: 1, tupletRemaining: 0 };
    streams.set(id, stream);
  }
  return stream;
}
function closeBar(stream: VoiceStream): void {
  if (stream.current.atoms.length || stream.current.repeatStart || stream.current.repeatEnd || stream.current.ending !== undefined) stream.bars.push(stream.current);
  stream.current = makeBar();
  stream.accidentals.clear();
  if (stream.bars.length > 8192) throw new AbcImportError("ABC exceeds 8192 written bars");
}

/** Consume one ABC length suffix, including fractional forms such as /, //, 3/2 and 3//. */
function readLength(source: string, at: number): { multiplier: number; end: number } {
  let i = at;
  let top = 1;
  const numeratorStart = i;
  while (i < source.length && /\d/.test(source[i]!)) {
    if (i - numeratorStart >= 4) throw new AbcImportError("ABC note length is outside supported bounds");
    i++;
  }
  if (i > numeratorStart) top = Number(source.slice(numeratorStart, i));
  if (source[i] !== "/") return { multiplier: top, end: i };
  let slashes = 0;
  while (source[i] === "/") { slashes++; i++; if (slashes > 10) throw new AbcImportError("ABC note length is outside supported bounds"); }
  const denominatorStart = i;
  while (i < source.length && /\d/.test(source[i]!)) {
    if (i - denominatorStart >= 4) throw new AbcImportError("ABC note length is outside supported bounds");
    i++;
  }
  const bottom = i > denominatorStart ? Number(source.slice(denominatorStart, i)) : 2 ** slashes;
  if (top < 1 || bottom < 1 || top > 1024 || bottom > 1024) throw new AbcImportError("ABC note length is outside supported bounds");
  return { multiplier: top / bottom, end: i };
}

function skipDelimited(body: string, start: number, close: string, kind: string): number {
  const end = body.indexOf(close, start + 1);
  if (end < 0) throw new AbcImportError(`unterminated ABC ${kind}`);
  if (end - start > 4096) throw new AbcImportError(`ABC ${kind} exceeds 4096 characters`);
  return end + 1;
}

function tokenizeBody(body: string, baseLength: number, beatsPerBar: number, key: Map<string, number>, losses: Map<string, number>, firstVoice: string): Map<string, VoiceStream> {
  const streams = new Map<string, VoiceStream>();
  let active = firstVoice;
  let current = voiceFor(streams, active);
  let atomCount = 0;
  let i = 0;
  const count = (name: string, by = 1) => losses.set(name, (losses.get(name) ?? 0) + by);
  const addDuration = (duration: number): void => {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 2048) throw new AbcImportError("ABC event duration is outside supported bounds");
  };
  const append = (atom: Atom, count = 1): void => {
    atomCount += count;
    if (atomCount > 400_000) throw new AbcImportError("ABC exceeds 400,000 note and rest events");
    current.current.atoms.push(atom);
  };
  while (i < body.length) {
    const c = body[i]!;
    if (c === "%") {
      if ((i === 0 || body[i - 1] === "\n") && body[i + 1] === "%") count("directives");
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (body.startsWith("[V:", i)) {
      const end = body.indexOf("]", i + 3);
      if (end < 0 || end - i > 80) throw new AbcImportError("invalid inline ABC voice");
      active = body.slice(i + 3, end).trim(); current = voiceFor(streams, active); i = end + 1; continue;
    }
    if (body.startsWith("[|", i)) { closeBar(current); i += 2; continue; }
    if (c === "[") {
      const end = body.indexOf("]", i + 1);
      if (end < 0 || end - i > 4096) throw new AbcImportError("unterminated or oversized ABC chord");
      const inside = body.slice(i + 1, end);
      if (/^[\^_=]*[A-Ga-g]/.test(inside)) {
        count("chords");
        const pitches: number[] = [];
        const durations: number[] = [];
        let j = i + 1;
        while (j < end) {
          while (j < end && /[\s,]/.test(body[j]!)) j++;
          if (j >= end) break;
          let accidental: number | undefined;
          if ("^=_".includes(body[j]!)) {
            accidental = body[j] === "^" ? 1 : body[j] === "_" ? -1 : 0; j++;
            if (body[j] === "^" || body[j] === "_") { accidental *= 2; j++; }
          }
          const letter = body[j]!;
          if (!/[A-Ga-g]/.test(letter)) { j++; continue; }
          j++;
          let octave = letter === letter.toLowerCase() ? 5 : 4;
          while (body[j] === "'" || body[j] === ",") { octave += body[j] === "'" ? 1 : -1; j++; }
          const length = readLength(body, j); j = length.end;
          const name = letter.toUpperCase();
          const pitch = (octave + 1) * 12 + STEP[name]! + (accidental ?? current.accidentals.get(name) ?? key.get(name) ?? 0);
          if (accidental !== undefined) current.accidentals.set(name, accidental);
          const duration = baseLength * length.multiplier * current.tupletFactor;
          addDuration(duration);
          pitches.push(pitch);
          durations.push(duration);
        }
        if (!pitches.length) throw new AbcImportError("ABC chord has no notes");
        const suffix = readLength(body, end + 1);
        i = suffix.end;
        const pitchDurations = durations.map((duration) => {
          const scaled = duration * suffix.multiplier;
          addDuration(scaled);
          return scaled;
        });
        const longest = pitchDurations.reduce((max, duration) => Math.max(max, duration), 0);
        append({ kind: "note", pitch: pitches[0]!, pitches, pitchDurations, duration: longest, tie: false }, pitches.length);
        if (current.tupletRemaining && --current.tupletRemaining === 0) current.tupletFactor = 1;
        continue;
      }
      // Inline fields are valid inside the body; their unsupported metadata is counted.
      count("directives"); i = end + 1; continue;
    }
    if (c === "(" && /\d/.test(body[i + 1] ?? "")) {
      TUPLET_TOKEN.lastIndex = i;
      const m = TUPLET_TOKEN.exec(body);
      if (!m || m[0].length > 32) throw new AbcImportError("invalid ABC tuplet");
      const p = Number(m[1]), q = Number(m[2] ?? (p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 3 : p)), r = Number(m[3] ?? p);
      if (p < 2 || p > 9 || q < 1 || q > 16 || r < 1 || r > 64) throw new AbcImportError("invalid ABC tuplet");
      current.tupletFactor = q / p; current.tupletRemaining = r; i += m[0].length; continue;
    }
    if (c === "!" || c === "+") { i = skipDelimited(body, i, c, "decoration"); count("decorations"); continue; }
    if (c === "{") { i = skipDelimited(body, i, "}", "grace group"); count("grace"); continue; }
    if (c === '"') { i = skipDelimited(body, i, '"', "lyric or annotation"); count("lyrics"); continue; }
    if (body.startsWith("|:", i)) { closeBar(current); current.current.repeatStart = true; i += 2; continue; }
    if (body.startsWith(":|", i)) {
      current.current.repeatEnd = true;
      closeBar(current);
      i += 2;
      if (body[i] === "[") i++;
      if (/[1-9]/.test(body[i] ?? "")) current.current.ending = Number(body[i++]);
      if (body[i] === "]") i++;
      continue;
    }
    if (c === "|") {
      ENDING_TOKEN.lastIndex = i;
      const ending = ENDING_TOKEN.exec(body);
      closeBar(current);
      if (ending) { current.current.ending = Number(ending[1]); i += ending[0].length; }
      else if (body.startsWith("||", i) || body.startsWith("|]", i) || body.startsWith("[|", i)) i += 2;
      else i++;
      continue;
    }
    if (c === ":") { i++; continue; }
    if (c === ">" || c === "<") {
      const previous = current.current.atoms[current.current.atoms.length - 1];
      if (!previous) throw new AbcImportError("ABC broken rhythm has no preceding note");
      let countMarks = 0;
      while (body[i + countMarks] === c) countMarks++;
      if (countMarks > 8) throw new AbcImportError("ABC broken rhythm is too long");
      const short = 1 / (2 ** countMarks);
      const long = 2 - short;
      previous.duration *= c === ">" ? long : short;
      addDuration(previous.duration);
      current.broken = c === ">" ? short : long;
      i += countMarks;
      continue;
    }
    if (c === "-") {
      if (!current.tiedAtom && current.current.atoms.length) {
        const last = current.current.atoms[current.current.atoms.length - 1]!;
        if (last.kind === "note") { current.tiedAtom = last; last.tie = true; }
        else count("ties");
      } else if (!current.tiedAtom) count("ties");
      i++; continue;
    }
    if (c === "Z") {
      let end = i + 1;
      while (/\d/.test(body[end] ?? "")) {
        if (end - i > 2) throw new AbcImportError("ABC multi-measure rest exceeds 64 bars");
        end++;
      }
      const countMeasures = end === i + 1 ? 1 : Number(body.slice(i + 1, end));
      if (countMeasures < 1 || countMeasures > 64) throw new AbcImportError("ABC multi-measure rest exceeds 64 bars");
      const dur = beatsPerBar * countMeasures;
      addDuration(dur); append({ kind: "rest", duration: dur }); i = end;
      continue;
    }
    if (c === "z" || c === "x" || c === "X") {
      const length = readLength(body, i + 1); const dur = baseLength * length.multiplier * current.tupletFactor;
      addDuration(dur); append({ kind: "rest", duration: dur }); i = length.end;
      if (current.tupletRemaining && --current.tupletRemaining === 0) current.tupletFactor = 1;
      current.broken = undefined; continue;
    }
    let accidental: number | undefined;
    if (c === "^" || c === "_" || c === "=") {
      accidental = c === "^" ? 1 : c === "_" ? -1 : 0; i++;
      if (body[i] === "^" || body[i] === "_") { accidental *= 2; i++; }
    }
    const letter = body[i]!;
    if (/[A-Ga-g]/.test(letter)) {
      i++;
      let octave = letter === letter.toLowerCase() ? 5 : 4;
      while (body[i] === "'" || body[i] === ",") { octave += body[i] === "'" ? 1 : -1; i++; }
      const length = readLength(body, i); i = length.end;
      const name = letter.toUpperCase();
      if (accidental !== undefined) current.accidentals.set(name, accidental);
      const pitch = (octave + 1) * 12 + STEP[name]! + (accidental ?? current.accidentals.get(name) ?? key.get(name) ?? 0);
      let duration = baseLength * length.multiplier * current.tupletFactor;
      if (current.broken !== undefined) { duration *= current.broken; current.broken = undefined; }
      addDuration(duration);
      const tieKey = `${letter.toUpperCase()}:${octave}`;
      if (current.tiedAtom !== undefined && current.tiedAtom.tieKey === tieKey) {
        addDuration(current.tiedAtom.duration + duration);
        current.tiedAtom.duration += duration;
        current.tiedAtom = undefined;
      } else {
        const atom: NoteAtom = { kind: "note", pitch, tieKey, duration, tie: false };
        append(atom);
        if (current.tiedAtom !== undefined) { count("ties"); current.tiedAtom = undefined; }
      }
      if (current.tupletRemaining && --current.tupletRemaining === 0) current.tupletFactor = 1;
      continue;
    }
    if (body.startsWith("V:", i)) {
      const end = body.indexOf("\n", i);
      const stop = end < 0 ? body.length : end;
      if (stop - i > 80) throw new AbcImportError("ABC voice declaration exceeds 80 characters");
      const value = body.slice(i + 2, stop).trim();
      active = value.split(/\s+/)[0] ?? "";
      current = voiceFor(streams, active);
      i = end < 0 ? body.length : end + 1;
      continue;
    }
    if (/[A-Za-z]:/.test(body.slice(i, i + 2))) {
      const end = body.indexOf("\n", i);
      if (body[i] === "w" || body[i] === "W") count("lyrics"); else count("directives");
      i = end < 0 ? body.length : end + 1; continue;
    }
    if (c === "(" || c === ")" || c === "~") { count("slurs"); i++; continue; }
    if (c === "&" || c === "$") { count("directives"); i++; continue; }
    if (c === "[") continue;
    throw new AbcImportError(`unexpected ABC character at offset ${i}`);
  }
  for (const stream of streams.values()) if (stream.tiedAtom) count("ties");
  for (const stream of streams.values()) if (stream.current.atoms.length) closeBar(stream);
  if (!streams.size || [...streams.values()].every((s) => s.bars.every((b) => b.atoms.every((a) => a.kind === "rest")))) throw new AbcImportError("ABC tune contains no pitched notes");
  return streams;
}

/** Expand each written repeat at most twice; ending bars 1 and 2 select their matching pass. */
function expandBars(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let start = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i]!.repeatStart) start = i;
    if (!bars[i]!.repeatEnd) continue;
    const end = i;
    for (let pass = 1; pass <= 2; pass++) {
      for (let j = start; j <= end; j++) {
        const bar = bars[j]!;
        if (bar.ending !== undefined && bar.ending !== pass) continue;
        out.push(bar);
        if (out.length > 8192) throw new AbcImportError("expanded ABC repeats exceed 8192 bars");
      }
    }
    start = end + 1;
  }
  for (let i = start; i < bars.length; i++) out.push(bars[i]!);
  if (out.length > 8192) throw new AbcImportError("expanded ABC repeats exceed 8192 bars");
  return out;
}

/** Import ABC 2.1 notation through the shared quantised grid score path. */
function importAbcUnchecked(bytes: Uint8Array, options: AbcOptions): { yaml: string; report: unknown; losses: string[] } {
  if (bytes.length > 8 * 1024 * 1024) throw new AbcImportError("ABC input exceeds 8 MiB");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AbcImportError("ABC input is not valid UTF-8 text"); }
  if (source.length > 8 * 1024 * 1024) throw new AbcImportError("ABC input exceeds 8 MiB");
  const tune = selectTune(source, options.song ?? 1);
  if (tune.lines.length > 100_000) throw new AbcImportError("ABC tune exceeds 100,000 lines");
  const { headers, body, unknownHeaders } = splitHeader(tune);
  const grid = options.grid ?? 0.25;
  if (!(grid >= 1 / 48 && grid <= 4)) throw new AbcImportError("grid must be between 1/48 and 4 beats");
  const voiceLimit = options.voices ?? 3;
  if (!Number.isInteger(voiceLimit) || voiceLimit < 1 || voiceLimit > 3) throw new AbcImportError("voices must be 1, 2 or 3");
  const meterText = headers.get("M") ?? "4/4";
  const meterMatch = meterText === "C" ? ["", "4", "4"] : meterText === "C|" ? ["", "2", "2"] : /^(\d{1,2})\/(\d{1,2})$/.exec(meterText);
  if (!meterMatch) throw new AbcImportError(`invalid ABC metre: ${meterText}`);
  const numerator = Number(meterMatch[1]), denominator = Number(meterMatch[2]);
  if (numerator < 1 || denominator < 1 || denominator > 32 || (denominator & (denominator - 1)) !== 0) throw new AbcImportError(`invalid ABC metre: ${meterText}`);
  const beatsPerBar = numerator * 4 / denominator;
  if (!(beatsPerBar > 0 && beatsPerBar <= 32)) throw new AbcImportError("ABC metre exceeds supported bounds");
  const mappedMeter = sidwaveMetre(numerator, denominator);
  if (!mappedMeter) throw new AbcImportError(`ABC metre ${meterText} has no SIDWave metre with the same bar length`);
  const barCells = Math.max(1, Math.round(beatsPerBar / grid));
  const defaultLength = headers.get("L") ?? (beatsPerBar < 3 ? "1/16" : "1/8");
  const baseLength = parseFraction(defaultLength, "default note length") * 4;
  const keyText = headers.get("K") ?? "";
  const key = parseKey(keyText.split(/\s+/)[0]!);
  let bpm = 120;
  let roundedTempo = false;
  const tempo = headers.get("Q");
  if (tempo) {
    const qm = /^(?:(?:(\d+)\/(\d+)|(C\/*))\s*=\s*)?(\d+(?:\.\d+)?)$/i.exec(tempo.trim());
    if (!qm) throw new AbcImportError(`invalid ABC tempo: ${tempo}`);
    const noteBeats = qm[1] !== undefined
      ? Number(qm[1]) * 4 / Number(qm[2])
      : qm[3] !== undefined ? 4 / (2 ** (qm[3]!.length - 1)) : 1;
    bpm = Number(qm[4]) * noteBeats;
  }
  if (!(bpm >= 20 && bpm <= 400)) throw new AbcImportError("ABC tempo is outside 20..400 BPM");
  roundedTempo = !Number.isInteger(bpm);
  const losses = new Map<string, number>();
  if (unknownHeaders) losses.set("directives", unknownHeaders);
  if (mappedMeter.text !== mappedMeter.sidwave) losses.set("meter", 1);
  if (roundedTempo) losses.set("tempo", 1);
  const longMetadata = [options.title ?? headers.get("T"), headers.get("C")]
    .filter((value) => value !== undefined && value.length > 80).length;
  if (longMetadata) losses.set("metadata", longMetadata);
  const firstVoice = headers.get("V")?.trim().split(/\s+/)[0] || "1";
  const streams = tokenizeBody(body, baseLength, beatsPerBar, key, losses, firstVoice);
  const barsByVoice = new Map<string, Array<{ at: number; atoms: Atom[] }>>();
  let maxBeat = 0;
  for (const stream of streams.values()) {
    let at = 0; const expanded = expandBars(stream.bars); const timed = [];
    for (const bar of expanded) {
      const atoms = bar.atoms.filter((a) => !(a.kind === "rest" && a.duration === 0));
      timed.push({ at, atoms });
      const duration = atoms.reduce((sum, atom) => sum + atom.duration, 0);
      at += Math.max(beatsPerBar, duration);
      maxBeat = Math.max(maxBeat, at);
    }
    barsByVoice.set(stream.id, timed);
  }
  if (maxBeat > beatsPerBar * 8192) throw new AbcImportError("ABC exceeds 8192 bars of music");
  const totalCells = Math.max(barCells, Math.ceil(maxBeat / grid));
  const paddedCells = Math.ceil(totalCells / barCells) * barCells;
  if (paddedCells > 400_000) throw new AbcImportError("ABC exceeds 400,000 score grid cells");
  const bars: GridBar[] = [];
  const sidMeter = mappedMeter.sidwave;
  for (let cell = 0; cell < paddedCells; cell += barCells) bars.push({ cells: barCells, sig: sidMeter, tempo: Math.round(bpm) });
  const outputVoices: GridVoice[] = [];
  const maxMidi = maxSidwaveMidi(options.mode ?? "PAL");
  const ids = [...streams.keys()];
  let droppedVoices = 0, droppedChordTones = 0;
  for (const id of ids) {
    const barsForVoice = barsByVoice.get(id) ?? [];
    let laneCount = 1;
    for (const bar of barsForVoice) for (const atom of bar.atoms) {
      if (atom.kind === "note") laneCount = Math.max(laneCount, atom.pitches?.length ?? 1);
    }
    for (let lane = 0; lane < laneCount; lane++) {
      const raw: QuantisedNote[] = [];
      for (const bar of barsForVoice) {
        let cursor = bar.at;
        for (const atom of bar.atoms) {
          if (atom.kind === "note") {
            const pitches = atom.pitches ?? [atom.pitch];
            const pitch = pitches[lane];
            if (pitch !== undefined) {
              const duration = atom.pitchDurations?.[lane] ?? atom.duration;
              const startCells = cursor / grid, endCells = (cursor + duration) / grid;
              const start = Math.round(startCells), end = Math.max(start + 1, Math.round(endCells));
              if (Math.abs(startCells - start) > 1e-8 || Math.abs(endCells - end) > 1e-8) {
                losses.set("quantized", (losses.get("quantized") ?? 0) + 1);
              }
              raw.push({ s: start, e: end, pitch, vel: 127 });
            }
          }
          cursor += atom.duration;
        }
      }
      if (outputVoices.length >= voiceLimit) {
        if (lane > 0) droppedChordTones += raw.length;
        else droppedVoices++;
        continue;
      }
      const name = lane === 0 ? id : `${id}-chord${lane + 1}`;
      const reduced = reduceMonophonic(raw, paddedCells, false, maxMidi);
      outputVoices.push({ name: name.slice(0, 40), cells: reduced.cells });
      if (reduced.droppedPolyphony) losses.set("polyphony", (losses.get("polyphony") ?? 0) + reduced.droppedPolyphony);
      if (reduced.octaveShifted) losses.set("octave", (losses.get("octave") ?? 0) + reduced.octaveShifted);
    }
  }
  if (droppedVoices) losses.set("voices", droppedVoices);
  if (droppedChordTones) losses.set("chordTones", droppedChordTones);
  if (!rawHasNotes(barsByVoice)) throw new AbcImportError("ABC tune contains no pitched notes");
  const lossLines: string[] = [];
  for (const [type, count] of losses) {
    if (!count) continue;
    const labels: Record<string, string> = {
      chords: `${count} ABC chord(s) are reduced to simultaneous SID voice lanes.`,
      chordTones: `${count} ABC chord tone(s) are dropped because the score has only ${voiceLimit} voices.`,
      quantized: `${count} ABC note(s) are moved or resized to fit the score grid.`,
      decorations: `${count} ABC decoration(s) are skipped.`, grace: `${count} ABC grace note group(s) are skipped.`,
      lyrics: `${count} ABC lyric or annotation field(s) are skipped.`, directives: `${count} ABC directive(s) are skipped.`,
      slurs: `${count} ABC slur mark(s) are skipped.`, ties: `${count} ABC tie(s) could not be connected and are skipped.`,
      voices: `${count} ABC voice(s) are not imported because the score has ${voiceLimit} voices.`,
      polyphony: `${count} notes dropped because they sound together with another note (SID voices are monophonic).`,
      octave: `${count} ABC notes are outside the SIDWave pitch range and were moved by octaves.`,
      meter: `${mappedMeter.text} time signature is approximated by ${sidMeter} with the same bar length.`,
      tempo: `${count} ABC tempo value(s) are rounded to whole BPM for the score.`,
      metadata: `${count} ABC title or composer field(s) are truncated to 80 characters.`,
    };
    lossLines.push(labels[type] ?? `${count} ABC item(s) are skipped.`);
  }
  const yaml = buildGridScore({
    title: options.title ?? headers.get("T") ?? "Imported ABC",
    ...(headers.get("C") ? { author: headers.get("C") } : {}), mode: options.mode ?? "PAL", grid, bars, voices: outputVoices,
    instruments: {}, header: ["Imported from ABC notation (2.1 subset) by SIDWave."], validate: options.validate !== false,
  });
  let parsedNotes = 0;
  for (const voiceBars of barsByVoice.values()) for (const bar of voiceBars) for (const atom of bar.atoms) {
    if (atom.kind === "note") parsedNotes += atom.pitches?.length ?? 1;
  }
  return { yaml, losses: lossLines, report: { format: "abc", tune: tune.number, voices: ids, notes: parsedNotes, losses: lossLines } };
}
function rawHasNotes(bars: Map<string, Array<{ at: number; atoms: Atom[] }>>): boolean {
  for (const voice of bars.values()) for (const bar of voice) for (const atom of bar.atoms) if (atom.kind === "note") return true;
  return false;
}

/** Convert every parse/build failure to a typed interchange input error. */
export function importAbc(bytes: Uint8Array, options: AbcOptions = {}): { yaml: string; report: unknown; losses: string[] } {
  try {
    return importAbcUnchecked(bytes, options);
  } catch (error) {
    if (error instanceof AbcImportError) throw error;
    if (error instanceof InterchangeInputError) throw new AbcImportError(error.message);
    throw new AbcImportError(error instanceof Error ? error.message : "invalid ABC input");
  }
}
