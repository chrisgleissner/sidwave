// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// CheeseCutter 2.x import: a .ct song becomes a SIDWave 1.3 score plus a report. The decoding follows the behaviour of
// CheeseCutter's player (src/c64/player_v4.acme, GPL-2.0): the order lists, the sequence byte stream, the instrument
// table, the wave, pulse and filter programs. No code is copied; the rules below were derived by reading the player.

import { midiToNoteName } from "../sidwave.js";
import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { CT, CheeseCutterError, parseCheeseCutter, subtuneCount, type CtSong } from "./cheesecutter.js";
import { buildGridScore, needsCompile, resolveMotion, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";

export interface CheeseCutterImportOptions {
  title?: string;
  /** Subtune, 1-based. Default 1. */
  song?: number;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
  /** Longest import in ticks per voice. Default 100,000. */
  maxRows?: number;
  /** Ignore chord commands (the importer sets this itself when chord variants of the instruments exceed the SIDWave table limit). */
  chords?: boolean;
  /** Ignore vibrato commands (set by the importer when the vibrato variants exceed the 63 instruments of a score). */
  vibrato?: boolean;
}

export interface CheeseCutterImportReport {
  format: "cheesecutter";
  version: number;
  song: number;
  songs: number;
  multiplier: number;
  ticks: number;
  rowsPerBeat: number;
  bars: number;
  voices: Array<{ id: number; sequences: number; notes: number; octaveShifted: number; legato: number }>;
  instruments: Array<{ number: number; name: string; sidwave: string; notes: number; approximations: string[] }>;
  tempo: { initialSpeed: number; changes: number; changesNotAtBarLine: number; framesPerTickRange: [number, number]; clamped: number; alternatingSpeeds: boolean };
  loop: Array<{ voice: number; entry: number }>;
  commands: Record<string, number>;
  losses: string[];
  warnings: string[];
}
export interface CheeseCutterImportResult { yaml: string; report: CheeseCutterImportReport }

const COMMAND_NAMES = ["slide up", "slide down", "vibrato", "detune", "set ADSR", "low-fidelity vibrato", "set wave", "portamento", "stop portamento"];
const MAX_ENTRIES = 512;

const signed8 = (v: number): number => (v < 0x80 ? v : v - 256);
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);

/** One decoded sequence row. */
export interface CtRow {
  /** Note value as stored: 0 hold, 1 gate off, 2 gate on, 3.. a note (MIDI note = 12 + value + transposition). */
  note: number;
  tied: boolean;
  /** Command byte of the row, 0 for none. */
  cmd: number;
  instrument: number;
  /** Ticks the row lasts (duration nibble + 1). */
  ticks: number;
  /** Transposition in semitones that applies to the row. */
  trans: number;
}

/** Decodes the byte stream of one sequence as the player reads it. `state` carries the sticky duration and instrument across sequences. */
export function decodeSequence(image: Uint8Array, start: number, state: { duration: number; instrument: number }, out: CtRow[], trans: number): number {
  let pos = 0, tied = false, rows = 0;
  while (pos < CT.SEQ_BYTES) {
    const b = image[start + pos]!;
    if (b >= 0xc0) {
      if (b >= 0xf0) state.duration = b & 15; else state.instrument = b - 0xc0;
      pos++;
      continue;
    }
    let note: number, cmd = 0;
    if (b >= 0x5f) {
      if (b === 0x5f) { tied = true; pos++; continue; }
      note = b - 0x60;
      pos++;
      cmd = pos < CT.SEQ_BYTES ? image[start + pos]! : 0;
    } else note = b;
    pos++;
    out.push({ note, tied, cmd, instrument: state.instrument, ticks: state.duration + 1, trans });
    rows++;
    tied = false;
    if (pos >= CT.SEQ_BYTES || image[start + pos] === CT.END_MARK) break;
  }
  return rows;
}

interface Walked { rows: CtRow[]; sequences: number; loopEntry: number }

/** Expands the first pass of one order list into rows. */
function walkOrderList(song: CtSong, list: Uint8Array, maxRows: number, voice: number): Walked {
  const O = CT.OFS, image = song.image;
  const lo = song.pointers[O.sequenceLow]!, hi = song.pointers[O.sequenceHigh]!;
  const state = { duration: 0, instrument: 0 };
  const rows: CtRow[] = [];
  let trans = 0, sequences = 0, loopEntry = -1, ticks = 0;
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const t = list[i * 2]!, n = list[i * 2 + 1]!;
    if (t >= 0xf0) { loopEntry = Math.min(MAX_ENTRIES - 1, (((t & 7) << 8) | n) >> 1); break; }
    if (t > 0x80) trans = signed8((t - 0xa0) & 0xff);
    if (n >= CT.SEQUENCES) throw new CheeseCutterError(`voice ${voice + 1}, order list entry ${i}: sequence ${n} is above the limit of ${CT.SEQUENCES - 1}`);
    const at = image[lo + n]! | (image[hi + n]! << 8);
    const before = rows.length;
    decodeSequence(image, at, state, rows, trans);
    sequences++;
    for (let k = before; k < rows.length; k++) ticks += rows[k]!.ticks;
    if (ticks > maxRows) throw new CheeseCutterError(`the song has more than ${maxRows} ticks in voice ${voice + 1}`);
  }
  return { rows, sequences, loopEntry };
}

const wavePart = (wave: number): { name?: string; ring: boolean; sync: boolean; test: boolean; gate: boolean; lossy: boolean } => {
  const bits = wave & 0xf0;
  const names: Record<number, string> = { 0x10: "tri", 0x20: "saw", 0x40: "pulse", 0x30: "tri+saw", 0x50: "tri+pulse", 0x60: "saw+pulse", 0x70: "tri+saw+pulse" };
  const lossy = (bits & 0x80) !== 0 && (bits & 0x70) !== 0;
  const name = bits & 0x80 ? "noise" : names[bits];
  return { ...(name ? { name } : {}), ring: !!(wave & 4), sync: !!(wave & 2), test: !!(wave & 8), gate: !!(wave & 1), lossy };
};
const FILTER_TYPES: Record<number, string> = { 0x10: "lowpass", 0x20: "bandpass", 0x40: "highpass", 0x50: "lowpass+highpass", 0x60: "bandpass+highpass", 0x70: "all", 0x30: "lowpass" };

/*
 * TODO (SIDWave 1.5, branch feat/reconstruct-corpus-dev, not on main): the driver's own frequency table can be written as
 * `tuning.registers`, and the first frame of a note (the previous pitch while the restart waveform is written) as a
 * wavetable `reg` step. Both would remove the two largest remaining note disagreements. Emit them only when the target
 * version is 1.5, after that branch has merged; until then the importers write the equal-tempered pitch and skip the first frame.
 */
/** Per-instrument conversion, shared with the tests. */
export function convertCtInstrument(song: CtSong, number: number, multiplier: number, range: { low: number; high: number }, maxMidi: number, chordStart?: number, vibrato?: { depth: number; rate: number }): { def: Record<string, unknown>; notes: string[] } {
  const O = CT.OFS, image = song.image;
  const inst = song.pointers[O.instrumentTable]!;
  const byte = (column: number): number => image[inst + column * CT.INSTRUMENTS + number]!;
  const arp1 = song.pointers[O.arpeggioFirst]!, arp2 = song.pointers[O.arpeggioSecond]!;
  const notes: string[] = [];
  const ad = byte(0), sr = byte(1), hrByte = byte(2), hrWave = byte(3), filterPtr = byte(4), pulsePtr = byte(5), hrSr = byte(6), wavePtr = byte(7);
  const def: Record<string, unknown> = { adsr: [ad >> 4, ad & 15, sr >> 4, sr & 15] };
  const m = multiplier;
  const frames = (calls: number): Record<string, number> => (m === 1 ? { frames: Math.min(255, calls) } : calls % m === 0 ? { frames: Math.min(255, calls / m) } : { calls: Math.min(255, calls) });

  // Wave table: simulate the player's wave program call by call, then merge equal runs.
  interface Frame { trans: number; wave: number; chord: number }
  const wavetime = hrByte & 0x0f;
  const calls: Frame[] = [];
  const seen = new Map<number, number>();
  const chordAt = song.pointers[O.chordNotes]!;
  let chordPos = chordStart === undefined ? -1 : chordStart, chordValue = 0;
  let pos = wavePtr, cnt = 0, trans = 0, wave = 0, loopStart = -1;
  // Unless the restart type is soft ($40), the first call of a note writes the restart waveform and skips the wave program.
  if ((hrByte & 0xc0) !== 0x40) calls.push({ trans: 0, wave: hrWave | 1, chord: 0 });
  for (let i = 0; i < 4096; i++) {
    const stateKey = (((pos << 8) | (cnt & 0xff)) * 256 + ((chordPos + 1) & 0xff)) * 256 + (chordValue & 0xff);
    if (seen.has(stateKey)) { loopStart = seen.get(stateKey)!; break; }
    seen.set(stateKey, calls.length);
    if (--cnt < 0) {
      cnt = wavetime;
      trans = image[arp1 + pos]!;
      const w = image[arp2 + pos]!;
      if (w >= 0x10) wave = w < 0xe0 ? w : w & 0x0f;
      const next = pos < 255 ? image[arp1 + pos + 1]! : 0x7e;
      if (next !== 0x7e) {
        pos = Math.min(255, pos + 1);
        if (next === 0x7f) pos = image[arp2 + pos]!;
        const w2 = image[arp2 + pos]!;
        if (w2 !== 0 && w2 < 0x10) cnt = w2;
      }
      if (chordPos >= 0 && chordPos < 128) {
        const c = image[chordAt + chordPos]!;
        chordValue = signed8(c < 0x40 ? c : c | 0x80);
        const after = chordPos + 1 < 128 ? image[chordAt + chordPos + 1]! : 0x80;
        chordPos = after >= 0x80 ? after & 0x7f : chordPos + 1;
      }
    }
    calls.push({ trans, wave, chord: chordValue });
  }
  const hasWave = true;
  let baseWave: string | undefined;
  if (hasWave) {
    interface Run { trans: number; wave: number; chord: number; calls: number }
    const runs: Run[] = [];
    const runStart: number[] = [];
    const boundary = loopStart;
    calls.forEach((c, i) => {
      const last = runs[runs.length - 1];
      if (last && last.trans === c.trans && last.wave === c.wave && last.chord === c.chord && i !== boundary && last.calls < 255) last.calls++;
      else { runs.push({ trans: c.trans, wave: c.wave, chord: c.chord, calls: 1 }); }
      runStart[i] = runs.length - 1;
    });
    let commandSteps = 0, lossyNoise = 0, clamped = 0;
    const steps: Array<Record<string, unknown>> = [];
    for (const r of runs) {
      let noteSpec: string | undefined;
      if (r.trans >= 0x80) {
        const absolute = 12 + (r.trans & 0x7f);
        if (absolute > maxMidi) clamped++;
        noteSpec = midiToNoteName(Math.min(maxMidi, absolute));
      } else if (r.trans >= 0x7e) { commandSteps++; noteSpec = undefined; } else {
        const want = r.trans + r.chord;
        const off = Math.max(12 - range.low, Math.min(maxMidi - range.high, want));
        if (off !== want) clamped++;
        noteSpec = off === 0 ? undefined : `${off < 0 ? "-" : "+"}${Math.abs(off)}`;
      }
      const wp = wavePart(r.wave);
      if (wp.lossy) lossyNoise++;
      if (wp.name && baseWave === undefined) baseWave = wp.name;
      steps.push({
        ...(wp.name ? { wave: wp.name } : {}), ...(wp.ring ? { ring: true } : {}), ...(wp.sync ? { sync: true } : {}), ...(wp.test ? { test: true } : {}),
        gate: wp.gate, ...(noteSpec ? { note: noteSpec } : {}), ...frames(r.calls),
      });
    }
    if (commandSteps) notes.push(`${commandSteps} wave table row(s) hold a jump or stop value as a pitch; they are played as no offset.`);
    if (lossyNoise) notes.push(`${lossyNoise} wave table row(s) combine noise with another waveform; they use noise alone.`);
    if (clamped) notes.push(`${clamped} wave table pitch offset(s) would leave the playable range for the notes this song plays on the instrument; they are limited to the range.`);
    if (steps.length > 0) {
      def.wavetable = steps;
      if (loopStart >= 0 && runs.length > 0) {
        const idx = runStart[loopStart]!;
        const onlyOne = idx === runs.length - 1 && runs.length > 0 && calls.length - loopStart <= runs[idx]!.calls;
        if (!onlyOne) def.loop = idx;
      }
      // A held last step that repeats the one before it adds nothing.
      while (def.loop === undefined && steps.length >= 2) {
        const a = steps[steps.length - 2]!, b = steps[steps.length - 1]!;
        const strip = (x: Record<string, unknown>): string => JSON.stringify({ ...x, frames: 0, calls: 0 });
        if (strip(a) !== strip(b)) break;
        steps.pop();
      }
    }
  }
  if (baseWave === undefined) { const first = wavePart(hrWave); baseWave = first.name; }
  def.waveform = baseWave === "tri" ? "triangle" : baseWave === "saw" ? "sawtooth" : baseWave === "noise" ? "noise" : baseWave ?? "pulse";
  const only = (def.wavetable as Array<Record<string, unknown>> | undefined)?.length === 1 ? (def.wavetable as Array<Record<string, unknown>>)[0]! : undefined;
  if (only && !("note" in only) && only.gate === true && !only.ring && !only.sync && !only.test) delete def.wavetable;

  // Pulse program.
  if (pulsePtr !== 0) {
    const pt = song.pointers[O.pulseProgram]!;
    if (pulsePtr & 0x80) def.pulse_width = Math.max(1, Math.min(4094, (pulsePtr & 0x0f) << 8));
    else {
      const steps: Array<Record<string, unknown>> = [];
      const visited = new Map<number, number>();
      let e = pulsePtr & 0x3f, loop: number | undefined, guard = 0;
      let initial: number | undefined;
      while (guard++ < 70) {
        if (visited.has(e)) { loop = visited.get(e)!; break; }
        const [d0, add, init, nxt] = [image[pt + e * 4]!, image[pt + e * 4 + 1]!, image[pt + e * 4 + 2]!, image[pt + e * 4 + 3]!];
        const duration = d0 & 0x7f, delta = (d0 & 0x80 ? -add : add) * m;
        visited.set(e, steps.length);
        if (init !== 0xff) {
          const width = ((init & 0x0f) << 8) | (init & 0xf0);
          if (initial === undefined) initial = width;
          steps.push({ set: Math.max(1, Math.min(4094, width + delta)), ...frames(1) });
          if (duration > 0) steps.push({ add: delta, ...frames(duration) });
        } else steps.push({ add: delta, ...frames(duration + 1) });
        if (nxt === 0x7f || steps.length > 250) break;
        e = nxt === 0 ? e + 1 : nxt;
        if (e > 63) break;
        if (e === 0) break;
      }
      if (steps.length) { def.pulsetable = { steps, ...(loop === undefined ? {} : { loop }) }; if (initial !== undefined) def.pulse_width = Math.max(1, Math.min(4094, initial)); }
    }
  }
  // Filter program (the filter is global in CheeseCutter; SIDWave routes the voice of the instrument).
  if (filterPtr !== 0) {
    const ft = song.pointers[O.filterProgram]!;
    const steps: Array<Record<string, unknown>> = [];
    const visited = new Map<number, number>();
    let e = filterPtr & 0x3f, loop: number | undefined, guard = 0;
    let type = "lowpass", resonance = 8, cutoff = 0;
    while (guard++ < 70) {
      if (visited.has(e)) { loop = visited.get(e)!; break; }
      const [d0, b1, init, nxt] = [image[ft + e * 4]!, image[ft + e * 4 + 1]!, image[ft + e * 4 + 2]!, image[ft + e * 4 + 3]!];
      visited.set(e, steps.length);
      if (d0 >= 0x80) {
        type = FILTER_TYPES[d0 & 0x70] ?? "lowpass"; resonance = b1 >> 4;
        if (init !== 0xff) cutoff = init << 3;
        steps.push({ cutoff, resonance, type, ...frames(1) });
      } else {
        if (init !== 0xff) { cutoff = init << 3; steps.push({ cutoff, resonance, type, ...frames(1) }); }
        const delta = signed8(b1) * 2 * m;
        if (d0 > 0 && delta !== 0) steps.push({ add: delta, ...frames(d0) });
        else if (d0 > 0) steps.push({ add: 0, ...frames(d0) });
      }
      if (nxt === 0x7f || steps.length > 250) break;
      e = nxt === 0 ? e + 1 : nxt;
      if (e > 63 || e === 0) break;
    }
    if (steps.length) { def.filtertable = { steps, ...(loop === undefined || loop >= steps.length ? {} : { loop }) }; notes.push("the filter program is global in CheeseCutter; SIDWave routes only the voice of this instrument through the filter."); }
  }
  if (vibrato) def.vibrato = { depth: vibrato.depth, rate: vibrato.rate };
  // Restart type: bit 7 hard restart with the AD of the first command table byte, bit 5 keeps AD; $40 soft restart; $00 three-frame restart.
  if (hrByte & 0x80) {
    const hrAd = image[song.pointers[O.commandTable]! + 0x40]!;
    const useAd = (hrByte & 0x20) === 0 ? hrAd : ad;
    def.hard_restart = { frames: 2, adsr: [useAd >> 4, useAd & 15, hrSr >> 4, hrSr & 15] };
  } else def.hard_restart = { frames: 0 };
  return { def, notes };
}

/** Imports one subtune of a .ct song as SIDWave text. See doc/interchange.md for the mapping and losses. */
export function importCheeseCutter(bytes: Uint8Array, options: CheeseCutterImportOptions = {}): CheeseCutterImportResult {
  const song = parseCheeseCutter(bytes);
  const mode = options.mode ?? (song.clock === 0 ? "PAL" : "NTSC");
  const fps = sidwaveFrameRate(mode);
  const maxRows = options.maxRows ?? 100_000;
  const songs = subtuneCount(song);
  const songNumber = options.song ?? 1;
  if (!Number.isInteger(songNumber) || songNumber < 1) throw new RangeError("song must be a positive integer");
  if (songs === 0) throw new CheeseCutterError("the file has no subtune with data");
  if (songNumber > songs) throw new RangeError(`song ${songNumber} does not exist; the file has ${songs}`);
  const warnings: string[] = [], losses: string[] = [];
  const commands = new Map<string, number>();
  const count = (name: string): void => { commands.set(name, (commands.get(name) ?? 0) + 1); };
  const m = song.multiplier;
  if (m > 4) throw new CheeseCutterError(`the song runs the player ${m} times per frame; SIDWave supports up to 4`);

  const walked = song.orderLists[songNumber - 1]!.map((list, v) => walkOrderList(song, list, maxRows, v));
  const loops = walked.flatMap((w, v) => (w.loopEntry >= 0 ? [{ voice: v + 1, entry: w.loopEntry }] : []));
  if (loops.some((l) => l.entry !== 0)) losses.push("A voice loops back to an order list position other than the start; SIDWave loops the whole timeline, so the intro plays again on each pass.");

  // Ticks: each row starts at the tick after the previous row ends, per voice.
  interface Placed { tick: number; row: CtRow }
  const placed: Placed[][] = walked.map((w) => { const out: Placed[] = []; let t = 0; for (const row of w.rows) { out.push({ tick: t, row }); t += row.ticks; } return out; });
  const lengths = placed.map((p) => { const last = p[p.length - 1]; return last ? last.tick + last.row.ticks : 0; });
  const totalTicks = Math.max(...lengths);
  if (totalTicks === 0) throw new CheeseCutterError("the song has no rows");
  if (totalTicks > maxRows) throw new CheeseCutterError(`the song has more than ${maxRows} ticks`);
  if (new Set(lengths).size > 1) losses.push(`The voices have ${lengths.join(", ")} ticks in their first pass; shorter voices are padded with rests.`);

  // Speed per tick: the song speed, changed by speed commands ($F1..$FF); a speed below 2 reads the speed list from the chord table.
  const chord = song.pointers[CT.OFS.chordNotes]!;
  const speedCmds = new Map<number, number>();
  for (const voice of [2, 1, 0]) for (const p of placed[voice]!) if (p.row.cmd >= 0xf0 && (p.row.cmd & 15) !== 0) speedCmds.set(p.tick, p.row.cmd & 15);
  let speed = song.speeds[songNumber - 1]!, speedsub = 0;
  const initialSpeed = speed;
  const framesPerTick: number[] = [];
  let changes = 0, alternating = false;
  const changeTicks: number[] = [];
  const tickCalls = (): number => {
    if (speed >= 2) return speed + 1;
    alternating = true;
    let v = image(chord + speedsub);
    if (v >= 0x80) { speedsub = 0; v = image(chord); }
    speedsub++;
    return Math.max(2, v) + 1;
  };
  function image(at: number): number { return song.image[at]!; }
  for (let t = 0; t < totalTicks; t++) {
    const cmd = speedCmds.get(t);
    if (cmd !== undefined) {
      if (cmd !== speed) { changes++; changeTicks.push(t); }
      speed = cmd;
      if (cmd < 2) speedsub = 1;
    }
    framesPerTick.push(tickCalls());
  }
  if (alternating) losses.push("The song uses a speed below 2, which takes the row length from the chord table list; rows keep their individual lengths but the bar tempo is the nearest constant value per bar.");
  let minT = Infinity, maxT = 0;
  for (const f of framesPerTick) { if (f < minT) minT = f; if (f > maxT) maxT = f; }
  const bpmOf = (f: number, rpb: number): number => 60 * fps / (rpb * f);
  let rowsPerBeat = 4;
  for (const candidate of [4, 2, 8, 1]) if (bpmOf(minT, candidate) <= 220 && bpmOf(maxT, candidate) >= 30) { rowsPerBeat = candidate; break; }
  const barRows = 4 * rowsPerBeat;
  const barCount = Math.ceil(totalTicks / barRows);
  if (barCount > 2048) throw new CheeseCutterError(`the song has ${barCount} bars; the limit is 2048`);
  const totalCells = barCount * barRows;
  const bars: GridBar[] = [];
  let clamped = 0, notAtBar = 0;
  for (const t of changeTicks) if (t % barRows !== 0) notAtBar++;
  for (let b = 0; b < barCount; b++) {
    // The bar takes the mean row length of its ticks, so alternating speeds average out instead of following the first row.
    let sum = 0, n = 0;
    for (let t = b * barRows; t < Math.min(totalTicks, (b + 1) * barRows); t++) { sum += framesPerTick[t]!; n++; }
    const raw = bpmOf(n ? sum / n : framesPerTick[totalTicks - 1]!, rowsPerBeat);
    const bpm = Math.round(Math.max(30, Math.min(220, raw)) * 10000) / 10000;
    if (bpm !== Math.round(raw * 10000) / 10000) clamped++;
    bars.push({ cells: barRows, sig: "4/4", tempo: bpm });
  }
  if (notAtBar) losses.push(`${notAtBar} speed change(s) are not on a bar line (${barRows} rows); SIDWave changes tempo at bar lines, so the rows in between keep the earlier row length.`);
  if (clamped) losses.push(`${clamped} bar(s) have a row length outside the SIDWave tempo range of 30 to 220 BPM and are clamped.`);

  // Notes.
  const maxMidi = maxSidwaveMidi(mode);
  // An instrument is converted once per chord it is played with, because the chord table changes the wave program's pitches.
  interface Variant { inst: number; chord?: number; vib?: { depth: number; rate: number }; uses: number; name: string; low: number; high: number }
  const variants = new Map<string, Variant>();
  const chordIndexAt = song.pointers[CT.OFS.chordStarts]!;
  const variantOf = (inst: number, chord: number | undefined, vib: { depth: number; rate: number } | undefined, pitch: number): Variant => {
    const key = `${inst}:${chord ?? ""}:${vib ? `${vib.depth}/${vib.rate}` : ""}`;
    let v = variants.get(key);
    if (!v) {
      const base = slug(song.instrumentNames[inst] ?? "");
      const suffix = `${chord === undefined ? "" : `_c${chord}`}${vib ? `_v${variants.size}` : ""}`;
      v = { inst, ...(chord === undefined ? {} : { chord }), ...(vib ? { vib } : {}), uses: 0, name: `i${String(inst).padStart(2, "0")}${base ? `_${base}` : ""}${suffix}`, low: pitch, high: pitch };
      variants.set(key, v);
    }
    v.uses++; v.low = Math.min(v.low, pitch); v.high = Math.max(v.high, pitch);
    return v;
  };
  const voices: GridVoice[] = [];
  const voiceReports: CheeseCutterImportReport["voices"] = [];
  const O = CT.OFS;
  const cmdTable = song.pointers[O.commandTable]!;
  const callRate = fps * m;
  // Video frames from the start to each tick, for the length of a slide.
  const frameStart: number[] = [0];
  for (const f of framesPerTick) frameStart.push(frameStart[frameStart.length - 1]! + f);
  /** Speeds of slides and portamento are per player call; a frame has `m` calls. */
  const cmdParams = (cmd: number): { hi: number; lo: number } => ({ hi: image(cmdTable + 0x40 + cmd), lo: image(cmdTable + 0x80 + cmd) });
  const regOf = (midi: number): number => (440 * 2 ** ((midi - 69) / 12) * 16777216) / (mode === "PAL" ? 985248 : 1022727);
  /** Vibrato of command table entry `cmd` at `pitch`: triangle depth in semitones and rate in Hz, from the player's counters. */
  const vibratoOf = (cmd: number, pitch: number): { depth: number; rate: number } | undefined => {
    const c1 = image(cmdTable + cmd), c2 = image(cmdTable + 0x40 + cmd), c3 = image(cmdTable + 0x80 + cmd);
    let frq: number, depth: number;
    if (c1 === 2) { frq = (c3 >> 4) + 1; depth = frq / 2 ** ((c3 & 15) + 1); } else {
      frq = c2;
      depth = frq < 1 ? 0 : (c3 * 4 * (frq / 2)) / (regOf(pitch) * (2 ** (1 / 12) - 1));
    }
    if (frq < 1 || depth <= 0) return undefined;
    return { depth: Math.max(0.03, Math.min(6, Math.round(depth * 100) / 100)), rate: Math.max(0.2, Math.min(12, Math.round((callRate / (2 * frq)) * 100) / 100)) };
  };
  const useVibrato = options.vibrato !== false;
  const useChords = options.chords !== false;
  for (let v = 0; v < 3; v++) {
    const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    let sounding = false, lastPitch = -1, notes = 0, shifted = 0, legatoNotes = 0;
    let chord: number | undefined, vib: { depth: number; rate: number } | undefined, lastInstrument = 0;
    let slide: number | undefined, porta: number | undefined;
    /** Slide or portamento of the note started at `pitch`; resolved to SIDWave `bend` and `portamento` when the grid is final. */
    const motion = (_tick: number, pitch: number, from: number): Partial<GridCell> => {
      if (porta !== undefined && from >= 0 && from !== pitch) return { portaRate: porta, portaFrom: from };
      if (slide !== undefined) return { slideRate: slide };
      return {};
    };
    const setMotion = (type: number, row: CtRow): void => {
      const { hi, lo } = cmdParams(row.cmd);
      if (type === 0 || type === 1) { slide = (type === 0 ? 1 : -1) * ((hi << 8) | lo) * m; }
      else if (type === 7) { porta = (((hi & 15) << 8) | lo) * m; slide = undefined; }
      else if (type === 8) { porta = undefined; slide = undefined; }
      if (type === 2 || type === 5) slide = undefined;
    };
    const emit = (pitch: number, instrument: number): Variant => {
      const start = chord === undefined ? undefined : song.image[chordIndexAt + chord]!;
      return variantOf(instrument, start === undefined || start >= 0x80 ? undefined : start, vib, pitch);
    };
    for (const { tick, row } of placed[v]!) {
      const cmd1 = row.cmd !== 0 && row.cmd < 0x40 ? image(cmdTable + row.cmd) : -1;
      if (row.cmd !== 0) {
        if (row.cmd < 0x40) { if (!(useVibrato && (cmd1 === 2 || cmd1 === 5)) && !(cmd1 === 0 || cmd1 === 1 || cmd1 === 7 || cmd1 === 8)) count(COMMAND_NAMES[cmd1] ?? `command ${cmd1}`); }
        else if (row.cmd < 0x60) count("set pulse pointer");
        else if (row.cmd < 0x80) count("set filter pointer");
        else if (row.cmd < 0xa0) { if (!useChords || row.note === 1 || row.note === 2 || (row.note === 0 && !sounding)) count("chord on a row without a sounding note"); }
        else if (row.cmd < 0xb0) count("set attack");
        else if (row.cmd < 0xc0) count("set decay");
        else if (row.cmd < 0xd0) count("set sustain");
        else if (row.cmd < 0xe0) count("set release");
        else if (row.cmd < 0xf0) count("main volume");
        else if ((row.cmd & 15) === 0) count("sync");
      }
      const tickEnd = Math.min(totalCells, tick + row.ticks);
      if (tick >= totalCells) break;
      const chordCmd = useChords && row.cmd >= 0x80 && row.cmd < 0xa0;
      if (row.note >= 3) {
        slide = undefined;
        if (!row.tied) { chord = undefined; vib = undefined; }
        if (chordCmd) chord = row.cmd & 0x1f;
        let pitch = 12 + row.note + row.trans;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) shifted++;
        if (cmd1 >= 0) { if (useVibrato && (cmd1 === 2 || cmd1 === 5)) vib = vibratoOf(row.cmd, pitch); else if (cmd1 <= 1 || cmd1 === 7 || cmd1 === 8) vib = undefined; }
        if (cmd1 >= 0) setMotion(cmd1, row);
        const moving = porta !== undefined || slide !== undefined;
        if (row.tied && sounding && pitch === lastPitch && !chordCmd && cmd1 < 0) cells[tick] = { kind: "tie" };
        else {
          const legato = row.tied && sounding;
          if (legato) legatoNotes++;
          cells[tick] = { kind: "note", pitch, level: 15, inst: emit(pitch, row.instrument).name, ...(legato ? { legato: true } : {}), ...(moving ? motion(tick, pitch, lastPitch) : {}) };
          notes++;
        }
        sounding = true; lastPitch = pitch; lastInstrument = row.instrument;
      } else if (row.note === 1) sounding = false;
      else if (row.note === 0 && sounding && lastPitch >= 0 && (chordCmd || (cmd1 >= 0 && ((useVibrato && (cmd1 === 2 || cmd1 === 5)) || cmd1 <= 1 || cmd1 === 7 || cmd1 === 8)))) {
        // A command on a hold row changes the running note: play the same pitch again without a new attack, on the variant that has the effect.
        const before = `${chord}:${vib?.depth}:${vib?.rate}`;
        if (chordCmd) chord = row.cmd & 0x1f;
        if (cmd1 >= 0) { if (useVibrato && (cmd1 === 2 || cmd1 === 5)) vib = vibratoOf(row.cmd, lastPitch); else vib = undefined; }
        if (cmd1 === 0 || cmd1 === 1 || cmd1 === 7 || cmd1 === 8) setMotion(cmd1, row);
        const hold: Partial<GridCell> = cmd1 === 0 || cmd1 === 1 ? motion(tick, lastPitch, -1) : {};
        if (before !== `${chord}:${vib?.depth}:${vib?.rate}` || hold.slideRate !== undefined) {
          cells[tick] = { kind: "note", pitch: lastPitch, level: 15, inst: emit(lastPitch, lastInstrument).name, legato: true, ...hold };
          legatoNotes++;
        } else cells[tick] = { kind: "tie" };
      } else if (row.note === 2) { if (!sounding) count("gate on without a note"); } else if (sounding) cells[tick] = { kind: "tie" };
      for (let t = tick + 1; t < tickEnd; t++) if (sounding) cells[t] = { kind: "tie" };
    }
    voices.push({ name: `Voice ${v + 1}`, cells });
    voiceReports.push({ id: v + 1, sequences: walked[v]!.sequences, notes, octaveShifted: shifted, legato: legatoNotes });
  }
  const shiftedTotal = voiceReports.reduce((n, v) => n + v.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  for (const [name, n] of commands) losses.push(`Sequence command "${name}" (${n} uses) is not imported.`);
  if (m > 1) losses.push(`The song runs the player ${m} times per frame; wave, pulse and filter programs are converted to that rate, sequencing keeps the frame rate.`);

  const defs: Record<string, Record<string, unknown>> = {};
  const renames = new Map<string, string>();
  const instReports: CheeseCutterImportReport["instruments"] = [];
  for (const v of [...variants.values()].sort((a, b) => a.inst - b.inst || (a.chord ?? -1) - (b.chord ?? -1))) {
    if (v.inst >= CT.INSTRUMENTS) throw new CheeseCutterError(`instrument ${v.inst} is above the limit of ${CT.INSTRUMENTS - 1}`);
    const converted = convertCtInstrument(song, v.inst, m, { low: v.low, high: v.high }, maxMidi, v.chord, v.vib);
    const json = JSON.stringify(converted.def);
    const same = [...Object.entries(defs)].find(([, d]) => JSON.stringify(d) === json);
    if (same) { renames.set(v.name, same[0]); continue; }
    defs[v.name] = converted.def;
    instReports.push({ number: v.inst, name: song.instrumentNames[v.inst] ?? "", sidwave: v.name, notes: v.uses, approximations: converted.notes });
    for (const note of converted.notes) losses.push(`Instrument ${v.inst}: ${note}`);
  }
  if (instReports.length > 63) {
    if (options.vibrato !== false && [...variants.values()].some((x) => x.vib)) {
      const again = importCheeseCutter(bytes, { ...options, vibrato: false });
      again.report.losses.unshift("Vibrato commands are not imported: the vibrato variants of the instruments exceed the 63 instruments SIDWave allows in one score.");
      return again;
    }
    throw new CheeseCutterError(`the song uses ${instReports.length} instruments; SIDWave allows 63`);
  }
  losses.push("The waveform of the first frame of a note (the hard restart waveform), master volume, the exact frame offsets inside a row and the global filter are approximated.");

  if (renames.size) for (const voice of voices) for (const cell of voice.cells) if (cell.inst && renames.has(cell.inst)) cell.inst = renames.get(cell.inst)!;
  const resolved = resolveMotion(voices, frameStart, defs, mode, maxMidi);
  if (resolved.pitchedBends) losses.push(`${resolved.pitchedBends} slide(s) are not imported because SIDWave cannot bend a note of an instrument whose wavetable sets pitches.`);
  if (resolved.tooSmall) losses.push(`${resolved.tooSmall} slide(s) move the pitch by less than half a semitone and are not imported.`);
  const title = options.title ?? (song.title || "Imported CheeseCutter song");
  let yaml: string;
  try { yaml = buildGridScore({
    title, ...(song.author ? { author: song.author } : {}), mode, grid: 1 / rowsPerBeat, bars, voices, instruments: defs,
    header: [`Imported from a CheeseCutter 2.x song file (revision ${song.version}) by SIDWave.`, `One grid cell is one sequence row (${rowsPerBeat} rows per beat); see the import report for what was approximated or dropped.`,
      ...(song.release ? [`Release text of the source: ${song.release}`] : [])],
    validate: options.validate === false ? false : needsCompile(voices, defs) ? true : "parse", ...(m > 1 ? { speed: Math.min(4, m) } : {}),
  }); } catch (error) {
    if (error instanceof Error && /exceeds 255 steps/.test(error.message) && options.chords !== false && [...variants.values()].some((v) => v.chord !== undefined)) {
      const again = importCheeseCutter(bytes, { ...options, chords: false });
      again.report.losses.unshift("Chord commands are not imported: the chord variants of the instruments exceed the 255 wavetable steps SIDWave allows in one score.");
      return again;
    }
    throw error;
  }
  return {
    yaml,
    report: {
      format: "cheesecutter", version: song.version, song: songNumber, songs, multiplier: m, ticks: totalTicks, rowsPerBeat, bars: barCount, voices: voiceReports, instruments: instReports,
      tempo: { initialSpeed, changes, changesNotAtBarLine: notAtBar, framesPerTickRange: [minT, maxT], clamped, alternatingSpeeds: alternating },
      loop: loops, commands: Object.fromEntries(commands), losses: [...new Set(losses)], warnings,
    },
  };
}
