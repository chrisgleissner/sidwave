// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID Factory II import (driver 11.xx): an .sf2 song becomes a SIDWave 1.3 score plus a report. The file layout is in sf2.ts. The
// table semantics follow the driver notes of SID Factory II (dist/documentation/notes_driver11.txt, GPL-2.0) and
// were checked against the driver stored in each file (see doc/interchange.md). No code is copied.

import { midiToNoteName } from "../sidwave.js";
import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { SF2, Sf2Error, cell, parseSf2, readOrderList, readSequence, tableOf, type Sf2Event, type Sf2Song } from "./sf2.js";
import { buildGridScore, needsCompile, resolveMotion, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";

export interface Sf2ImportOptions {
  title?: string;
  /** Song, 1-based. Default 1. */
  song?: number;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
  /** Longest import in ticks per track. Default 100,000. */
  maxRows?: number;
  /** Ignore arpeggio commands (the importer sets this itself when the arpeggio variants exceed the SIDWave table limit). */
  arpeggios?: boolean;
  /** Ignore vibrato commands (set by the importer when the effect variants exceed the 63 instruments of a score). */
  vibrato?: boolean;
  /** Ignore "set local ADSR" commands (set by the importer when the effect variants exceed the 63 instruments of a score). */
  localAdsr?: boolean;
  /** Use a restart of zero frames for every instrument (the importer sets this itself when rows are too short for a two-frame restart). */
  softRestart?: boolean;
  /** Import pulse programs as the initial pulse width only (set by the importer when the pulse tables exceed the 255 steps of a score). */
  pulseTables?: boolean;
  /** Import no filter programs (set by the importer when the filter tables exceed the 255 steps of a score). */
  filterTables?: boolean;
}

export interface Sf2ImportReport {
  format: "sf2";
  driver: string;
  song: number;
  songs: number;
  ticks: number;
  rowsPerBeat: number;
  bars: number;
  voices: Array<{ id: number; sequences: number; notes: number; octaveShifted: number; legato: number }>;
  instruments: Array<{ number: number; sidwave: string; notes: number; approximations: string[] }>;
  tempo: { values: number[]; framesPerTickRange: [number, number]; alternating: boolean; clamped: number };
  loop: Array<{ voice: number; entry: number }>;
  commands: Record<string, number>;
  losses: string[];
  warnings: string[];
}
export interface Sf2ImportResult { yaml: string; report: Sf2ImportReport }

const COMMAND_NAMES = ["slide", "vibrato", "portamento", "arpeggio", "fret slide", "command 5", "command 6", "command 7", "set local ADSR", "set instrument ADSR", "filter program", "wave program", "pulse program", "tempo program", "main volume", "demo value"];
const signed = (v: number, bits: number): number => (v >= 1 << (bits - 1) ? v - (1 << bits) : v);
const wavePart = (wave: number): { name?: string; ring: boolean; sync: boolean; test: boolean; gate: boolean; lossy: boolean } => {
  const bits = wave & 0xf0;
  const names: Record<number, string> = { 0x10: "tri", 0x20: "saw", 0x40: "pulse", 0x30: "tri+saw", 0x50: "tri+pulse", 0x60: "saw+pulse", 0x70: "tri+saw+pulse" };
  const lossy = (bits & 0x80) !== 0 && (bits & 0x70) !== 0;
  const name = bits & 0x80 ? "noise" : names[bits];
  return { ...(name ? { name } : {}), ring: !!(wave & 4), sync: !!(wave & 2), test: !!(wave & 8), gate: !!(wave & 1), lossy };
};
const FILTER_TYPES: Record<number, string> = { 1: "lowpass", 2: "bandpass", 3: "lowpass", 4: "highpass", 5: "lowpass+highpass", 6: "bandpass+highpass", 7: "all" };

/** Driver 11 tables of a song, with the accessors the importer needs. */
export function driver11Tables(song: Sf2Song): Record<"cmd" | "instr" | "wave" | "pulse" | "filter" | "hr" | "arp" | "tempo" | "init", ReturnType<typeof tableOf>> {
  const T = SF2.TABLE;
  return { cmd: tableOf(song, T.Commands), instr: tableOf(song, T.Instruments), wave: tableOf(song, T.Wave), pulse: tableOf(song, T.Pulse), filter: tableOf(song, T.Filter), hr: tableOf(song, T.HR), arp: tableOf(song, T.Arp), tempo: tableOf(song, T.Tempo), init: tableOf(song, T.Init) };
}

/** An instrument is converted once per effect it is played with. */
export interface Sf2Variant { instrument: number; adsr?: [number, number]; arp?: { start: number; speed: number }; vibrato?: { depth: number; rate: number }; wave?: number }

/*
 * TODO (SIDWave 1.5): the driver's own frequency table can be written as `tuning.registers`, and the first frame of a note (the
 * previous pitch while the restart waveform is written) as a wavetable `reg` step. Both would remove the two largest remaining
 * note disagreements. Until then the importers write the equal-tempered pitch and skip the first frame.
 */
/** Converts one instrument of a driver 11 song. */
export function convertSf2Instrument(song: Sf2Song, number: number, variant: Sf2Variant, range: { low: number; high: number }, maxMidi: number, fps: number, softRestart = false, noPulseTable = false, noFilterTable = false): { def: Record<string, unknown>; notes: string[] } {
  const t = driver11Tables(song);
  const notes: string[] = [];
  const col = (c: number): number => cell(song, t.instr!, number, c);
  const ad = col(0), sr = col(1), flags = col(2), filterIdx = col(3), pulseIdx = col(4);
  const waveIdx = variant.wave ?? col(5);
  const def: Record<string, unknown> = { adsr: variant.adsr ? [variant.adsr[0] >> 4, variant.adsr[0] & 15, variant.adsr[1] >> 4, variant.adsr[1] & 15] : [ad >> 4, ad & 15, sr >> 4, sr & 15] };
  // Wave program, one row per frame; a row with semitones 0 takes the arpeggio value when a command set one.
  const wave = t.wave!;
  interface Frame { wave: number; semis: number; absolute: boolean }
  const frames: Frame[] = [];
  const seen = new Map<string, number>();
  let pos = waveIdx, loopStart = -1, arpPos = variant.arp ? variant.arp.start : -1, arpCount = 0, arpValue = 0;
  const arp = t.arp;
  const arpStep = (): void => {
    if (!arp || arpPos < 0) return;
    let v = cell(song, arp, arpPos, 0);
    for (let guard = 0; guard < 64 && v >= 0x70 && v < 0x80; guard++) { arpPos = variant.arp!.start + (v & 0x0f); v = cell(song, arp, arpPos, 0); }
    arpValue = v >= 0x70 ? 0 : v;
    arpPos = arpPos + 1 < arp.rows ? arpPos + 1 : arpPos;
  };
  if (arpPos >= 0) arpStep();
  let curWave = 0, curSemis = 0;
  // Oscillator reset (flag 0x10): the first frame of a note writes waveform 09 and the wave program starts on the second frame.
  if (flags & 0x10) frames.push({ wave: 0x09, semis: 0, absolute: false });
  for (let i = 0; i < 2048; i++) {
    const key = `${pos}:${arpPos}:${arpCount}:${arpValue}`;
    if (seen.has(key)) { loopStart = seen.get(key)!; break; }
    seen.set(key, frames.length);
    let row = pos;
    for (let guard = 0; guard < 8 && cell(song, wave, row, 0) === 0x7f; guard++) row = cell(song, wave, row, 1);
    const wf = cell(song, wave, row, 0), sm = cell(song, wave, row, 1);
    if (wf !== 0x7f && wf !== 0) curWave = wf;
    curSemis = sm;
    const jumpsOnSelf = cell(song, wave, Math.min(wave.rows - 1, row + 1), 0) === 0x7f && cell(song, wave, Math.min(wave.rows - 1, row + 1), 1) === row;
    frames.push({ wave: curWave, semis: sm >= 0x80 ? sm - 0x80 : sm === 0 && arpPos >= 0 ? arpValue : sm, absolute: sm >= 0x80 });
    pos = jumpsOnSelf ? row : Math.min(wave.rows - 1, row + 1);
    if (arpPos >= 0 && ++arpCount >= variant.arp!.speed + 1) { arpCount = 0; arpStep(); }
  }
  interface Run { wave: number; semis: number; absolute: boolean; calls: number }
  const runs: Run[] = [];
  const runStart: number[] = [];
  frames.forEach((f, i) => {
    const last = runs[runs.length - 1];
    if (last && last.wave === f.wave && last.semis === f.semis && last.absolute === f.absolute && i !== loopStart && last.calls < 255) last.calls++;
    else runs.push({ ...f, calls: 1 });
    runStart[i] = runs.length - 1;
  });
  let lossyNoise = 0, clamped = 0, baseWave: string | undefined;
  const steps: Array<Record<string, unknown>> = [];
  for (const r of runs) {
    let noteSpec: string | undefined;
    if (r.absolute) { const m = 12 + r.semis; if (m > maxMidi) clamped++; noteSpec = midiToNoteName(Math.min(maxMidi, m)); } else {
      const off = Math.max(12 - range.low, Math.min(maxMidi - range.high, r.semis));
      if (off !== r.semis) clamped++;
      noteSpec = off === 0 ? undefined : `+${off}`;
    }
    const wp = wavePart(r.wave);
    if (wp.lossy) lossyNoise++;
    if (wp.name && baseWave === undefined) baseWave = wp.name;
    steps.push({ ...(wp.name ? { wave: wp.name } : {}), ...(wp.ring ? { ring: true } : {}), ...(wp.sync ? { sync: true } : {}), ...(wp.test ? { test: true } : {}), gate: wp.gate, ...(noteSpec ? { note: noteSpec } : {}), frames: r.calls });
  }
  if (lossyNoise) notes.push(`${lossyNoise} wave table row(s) combine noise with another waveform; they use noise alone.`);
  if (clamped) notes.push(`${clamped} wave table pitch offset(s) would leave the playable range for the notes this song plays on the instrument; they are limited to the range.`);
  if (steps.length) {
    def.wavetable = steps;
    if (loopStart >= 0) {
      const idx = runStart[loopStart]!;
      const single = idx === runs.length - 1 && frames.length - loopStart <= runs[idx]!.calls;
      if (!single) def.loop = idx;
    }
    while (def.loop === undefined && steps.length >= 2) {
      const a = steps[steps.length - 2]!, b = steps[steps.length - 1]!;
      if (JSON.stringify({ ...a, frames: 0 }) !== JSON.stringify({ ...b, frames: 0 })) break;
      steps.pop();
    }
    const only = steps.length === 1 ? steps[0]! : undefined;
    if (only && !("note" in only) && only.gate === true && !only.ring && !only.sync && !only.test) delete def.wavetable;
  }
  def.waveform = baseWave === "tri" ? "triangle" : baseWave === "saw" ? "sawtooth" : baseWave === "noise" ? "noise" : baseWave ?? "pulse";

  // Pulse program: rows of three bytes (set 8X XX YY, add 0X XX YY, jump 7F -- XX).
  if (t.pulse && pulseIdx !== 0) {
    const p = t.pulse!;
    const out: Array<Record<string, unknown>> = [];
    const visited = new Map<number, number>();
    let r = pulseIdx, loop: number | undefined, initial: number | undefined;
    for (let guard = 0; guard < 80 && r < p.rows; guard++) {
      if (visited.has(r)) { loop = visited.get(r)!; break; }
      const b0 = cell(song, p, r, 0), b1 = cell(song, p, r, 1), b2 = cell(song, p, r, 2);
      visited.set(r, out.length);
      if (b0 === 0x7f) { if (b2 === r) break; r = b2; continue; }
      const value = ((b0 & 0x0f) << 8) | b1;
      if (b0 & 0x80) { if (initial === undefined) initial = value; out.push({ set: Math.max(1, Math.min(4094, value)), frames: Math.max(1, Math.min(255, b2)) }); } else out.push({ add: signed(value, 12), frames: Math.max(1, Math.min(255, b2)) });
      r++;
      if (out.length > 250) break;
    }
    if (out.length && noPulseTable) { if (initial !== undefined) def.pulse_width = Math.max(1, Math.min(4094, initial)); } else if (out.length) { def.pulsetable = { steps: out, ...(loop === undefined || loop >= out.length ? {} : { loop }) }; if (initial !== undefined) def.pulse_width = Math.max(1, Math.min(4094, initial)); }
  }
  // Filter program: set (X0.. with X > 8: passband, 12-bit cutoff, resonance and channel mask) and add rows.
  if (t.filter && (flags & 0x40) !== 0 && !noFilterTable) {
    const f = t.filter;
    const out: Array<Record<string, unknown>> = [];
    const visited = new Map<number, number>();
    let r = filterIdx, loop: number | undefined, type = "lowpass", resonance = 8, cutoff = 0, routed = 0;
    for (let guard = 0; guard < 80 && r < f.rows; guard++) {
      if (visited.has(r)) { loop = visited.get(r)!; break; }
      const b0 = cell(song, f, r, 0), b1 = cell(song, f, r, 1), b2 = cell(song, f, r, 2);
      visited.set(r, out.length);
      if (b0 === 0x7f) { if (b2 === r) break; r = b2; continue; }
      if (b0 >= 0x90) {
        type = FILTER_TYPES[(b0 >> 4) & 7] ?? "lowpass"; cutoff = Math.min(2047, (((b0 & 0x0f) << 8) | b1) >> 1); resonance = b2 >> 4; routed = b2 & 15;
        out.push({ cutoff, resonance, type, frames: 1 });
      } else { const add = signed(((b0 & 0x0f) << 8) | b1, 12) >> 1; if (add !== 0 || b2 > 0) out.push({ add, frames: Math.max(1, Math.min(255, b2)) }); }
      r++;
      if (out.length > 250) break;
    }
    if (out.length) { def.filtertable = { steps: out, ...(loop === undefined || loop >= out.length ? {} : { loop }) }; notes.push(`the filter program is global in SID Factory II${routed & 7 && (routed & 7) !== 7 ? " and routes a channel mask" : ""}; SIDWave routes only the voice of this instrument through the filter.`); }
  }
  if (variant.vibrato) def.vibrato = { ...variant.vibrato };
  // Hard restart: flag 0x80, ADSR from the HR table row in the low three bits of the flags.
  if (flags & 0x80 && t.hr && !softRestart) {
    const row = flags & 7;
    const hrAd = cell(song, t.hr, row, 0), hrSr = cell(song, t.hr, row, 1);
    def.hard_restart = { frames: 2, adsr: [hrAd >> 4, hrAd & 15, hrSr >> 4, hrSr & 15] };
  } else def.hard_restart = { frames: 0 };
  void fps;
  return { def, notes };
}

/** The `sids` list of a multi-SID score: $D400, $D420, ... in the order of the driver's tracks, three per SID. */
const sidList = (count: number): Array<{ id: string; address: string }> => Array.from({ length: count }, (_, n) => ({ id: `sid${n + 1}`, address: `$D${(0x400 + n * 0x20).toString(16).toUpperCase()}` }));

/** Imports one song of a driver 11 .sf2 file as SIDWave text. See doc/interchange.md for the mapping and losses. */
export function importSf2(bytes: Uint8Array, options: Sf2ImportOptions = {}): Sf2ImportResult {
  const song = parseSf2(bytes);
  if (song.driver.major !== 11 || song.driver.minor > 5) {
    throw new Sf2Error(`the song uses SID Factory II driver ${song.driver.major}.${String(song.driver.minor).padStart(2, "0")}; only drivers 11.00 to 11.05 (the default driver and its multi-SID variants) are supported so far. Drivers 12 to 16 and NP20 have other table layouts that are not decoded yet. To use the song now, export a .sid from SID Factory II and run "sidwave reconstruct song.sid".`);
  }
  const mode = options.mode ?? "PAL";
  const fps = sidwaveFrameRate(mode);
  const maxRows = options.maxRows ?? 100_000;
  const t = driver11Tables(song);
  if (!t.wave || !t.pulse || !t.filter || !t.hr || !t.tempo || !t.init || !t.arp) throw new Sf2Error("the driver lacks one of the tables of driver 11 (wave, pulse, filter, HR, arpeggio, tempo, init)");
  // Tracks 1-3 play SID 1, 4-6 SID 2 and so on (the 2, 3 and 4-SID drivers have 6, 9 and 12 tracks). Several songs in one
  // file (extra init table rows) are not read: no driver 11 file with more than one song is available to verify the layout.
  const songs = 1;
  if (song.music.tracks % 3 !== 0) throw new Sf2Error(`the song has ${song.music.tracks} tracks; the importer needs a multiple of three (three tracks per SID)`);
  const sidCount = song.music.tracks / 3;
  const songNumber = options.song ?? 1;
  if (!Number.isInteger(songNumber) || songNumber < 1) throw new RangeError("song must be a positive integer");
  if (songNumber > songs) throw new RangeError(`song ${songNumber} does not exist; the file has ${songs}`);
  const warnings: string[] = [], losses: string[] = [];
  const commands = new Map<string, number>();
  const count = (name: string): void => { commands.set(name, (commands.get(name) ?? 0) + 1); };

  // Tempo chain: the init table points to a tempo row; values run until 0x7F, then the chain repeats.
  const tempoRow = cell(song, t.init, songNumber - 1, 0);
  const chain: number[] = [];
  for (let r = tempoRow; r < t.tempo.rows && chain.length < 64; r++) { const v = cell(song, t.tempo, r, 0); if (v === 0x7f) break; chain.push(v); }
  if (chain.length === 0) throw new Sf2Error(`the init table points to tempo row ${tempoRow}, which holds no tempo value`);

  // Rows per track: order list entries in order, one event per tick.
  interface Placed { tick: number; ev: Sf2Event; trans: number; instrument: number }
  const placed: Placed[][] = [];
  const reports: Array<{ sequences: number; loop: number }> = [];
  for (let v = 0; v < song.music.tracks; v++) {
    const ol = readOrderList(song, v);
    const rows: Placed[] = [];
    let tick = 0, instrument = 0;
    for (const e of ol.entries) {
      if (e.sequence >= song.music.sequenceCount) throw new Sf2Error(`track ${v + 1}: sequence ${e.sequence} is above the number of sequences (${song.music.sequenceCount})`);
      for (const ev of readSequence(song, e.sequence)) {
        if (ev.instrument !== 0x80 && ev.instrument !== 0x90) instrument = ev.instrument & 0x1f;
        rows.push({ tick: tick++, ev, trans: e.transposition, instrument });
      }
      if (tick > maxRows) throw new Sf2Error(`the song has more than ${maxRows} ticks in track ${v + 1}`);
    }
    placed.push(rows);
    reports.push({ sequences: ol.entries.length, loop: ol.loop });
  }
  const lengths = placed.map((r) => r.length);
  const totalTicks = Math.max(...lengths);
  if (totalTicks === 0) throw new Sf2Error("the song has no events");
  if (new Set(lengths).size > 1) losses.push(`The tracks have ${lengths.join(", ")} ticks in their first pass; shorter tracks are padded with rests.`);
  const loops = reports.flatMap((r, v) => (r.loop >= 0 ? [{ voice: v + 1, entry: r.loop }] : []));
  if (loops.some((l) => l.entry !== 0)) losses.push("A track loops back to an order list position other than the start; SIDWave loops the whole score, so the intro plays again on each pass.");

  const framesPerTick: number[] = [];
  for (let k = 0; k < totalTicks; k++) framesPerTick.push(chain[k % chain.length]! + 1);
  const minT = Math.min(...framesPerTick), maxT = Math.max(...framesPerTick);
  const alternating = chain.length > 1 && minT !== maxT;
  if (alternating) losses.push("The tempo table holds several values; each bar takes the mean row length, so rows are within a frame of their true start.");
  const bpmOf = (f: number, rpb: number): number => 60 * fps / (rpb * f);
  let rowsPerBeat = 4;
  for (const candidate of [4, 2, 8, 1]) if (bpmOf(minT, candidate) <= 220 && bpmOf(maxT, candidate) >= 30) { rowsPerBeat = candidate; break; }
  const barRows = 4 * rowsPerBeat;
  const barCount = Math.ceil(totalTicks / barRows);
  if (barCount > 2048) throw new Sf2Error(`the song has ${barCount} bars; the limit is 2048`);
  const totalCells = barCount * barRows;
  const bars: GridBar[] = [];
  let clamped = 0;
  for (let b = 0; b < barCount; b++) {
    let sum = 0, n = 0;
    for (let k = b * barRows; k < Math.min(totalTicks, (b + 1) * barRows); k++) { sum += framesPerTick[k]!; n++; }
    const raw = bpmOf(n ? sum / n : framesPerTick[totalTicks - 1]!, rowsPerBeat);
    const bpm = Math.round(Math.max(30, Math.min(220, raw)) * 10000) / 10000;
    if (bpm !== Math.round(raw * 10000) / 10000) clamped++;
    bars.push({ cells: barRows, sig: "4/4", tempo: bpm });
  }
  if (clamped) losses.push(`${clamped} bar(s) have a row length outside the SIDWave tempo range of 30 to 220 BPM and are clamped.`);

  const maxMidi = maxSidwaveMidi(mode);
  interface Variant extends Sf2Variant { uses: number; name: string; low: number; high: number; key: string }
  const variants = new Map<string, Variant>();
  const variantOf = (v: Sf2Variant, pitch: number): Variant => {
    const key = JSON.stringify(v);
    let x = variants.get(key);
    if (!x) {
      const suffix = `${v.adsr ? `_e${variants.size}` : ""}${v.arp ? `_a${v.arp.start}s${v.arp.speed}` : ""}${v.vibrato ? `_v${variants.size}` : ""}${v.wave !== undefined ? `_w${v.wave}` : ""}`;
      x = { ...v, uses: 0, name: `i${String(v.instrument).padStart(2, "0")}${suffix}`, low: pitch, high: pitch, key };
      variants.set(key, x);
    }
    x.uses++; x.low = Math.min(x.low, pitch); x.high = Math.max(x.high, pitch);
    return x;
  };
  const cmdOf = (index: number): { type: number; xx: number; yy: number } => ({ type: cell(song, t.cmd!, index, 0), xx: cell(song, t.cmd!, index, 1), yy: cell(song, t.cmd!, index, 2) });
  const vibratoOf = (xx: number, yy: number): { depth: number; rate: number } | undefined => {
    // XX is the frequency (calls per half swing), YY the amplitude divider: a smaller value is a stronger vibrato.
    if (xx < 1) return undefined;
    const depth = 0.5 * Math.min(12, 8 / (1 + yy));
    return { depth: Math.max(0.03, Math.min(6, Math.round(depth * 100) / 100)), rate: Math.max(0.2, Math.min(12, Math.round((fps / (2 * xx)) * 100) / 100)) };
  };
  const frameStart: number[] = [0];
  for (const f of framesPerTick) frameStart.push(frameStart[frameStart.length - 1]! + f);
  const voices: GridVoice[] = [];
  const voiceReports: Sf2ImportReport["voices"] = [];
  for (let v = 0; v < song.music.tracks; v++) {
    const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    let sounding = false, lastPitch = -1, notes = 0, shifted = 0, legatoNotes = 0, lastInstrument = 0;
    let arp: Sf2Variant["arp"], vib: Sf2Variant["vibrato"], wave: number | undefined, local: [number, number] | undefined;
    let slide: number | undefined, porta: number | undefined;
    /** Slide or portamento of the note started at `pitch`; resolved to SIDWave `bend` and `portamento` when the grid is final. */
    const motion = (_tick: number, pitch: number, from: number): Partial<GridCell> => {
      if (porta !== undefined && from >= 0 && from !== pitch) return { portaRate: porta, portaFrom: from };
      if (slide !== undefined) return { slideRate: slide };
      return {};
    };
    const setMotion = (c: { type: number; xx: number; yy: number }): void => {
      const value = (c.xx << 8) | c.yy;
      if (c.type === 0) slide = value >= 0x8000 ? value - 0x10000 : value;
      else if (c.type === 2) { porta = value >= 0x8000 || value === 0 ? undefined : value; slide = undefined; }
      else if (c.type === 1) slide = undefined;
    };
    for (const { tick, ev, trans, instrument } of placed[v]!) {
      if (tick >= totalCells) break;
      const cmd = ev.command !== 0x80 ? cmdOf(ev.command) : undefined;
      if (cmd) {
        const imported = cmd.type === 0 || cmd.type === 2 || (cmd.type === 8 && options.localAdsr !== false) || (cmd.type === 1 && options.vibrato !== false) || (cmd.type === 3 && options.arpeggios !== false) || cmd.type === 0xb;
        if (!imported) count(COMMAND_NAMES[cmd.type] ?? `command ${cmd.type}`);
      }
      const apply = (pitch: number): boolean => {
        if (!cmd) return false;
        if (cmd.type === 1 && options.vibrato !== false) { vib = vibratoOf(cmd.xx, cmd.yy); return true; }
        if (cmd.type === 3 && options.arpeggios !== false) { arp = { start: cmd.yy, speed: cmd.xx }; return true; }
        if (cmd.type === 0xb) { wave = cmd.yy; return true; }
        if (cmd.type === 8 && options.localAdsr !== false) { local = [cmd.xx, cmd.yy]; return true; }
        void pitch;
        return false;
      };
      if (ev.note >= 1 && ev.note <= 0x6f) {
        if (ev.instrument !== 0x80 && ev.instrument !== 0x90) wave = undefined;
        if (!ev.tied || !sounding) local = undefined;
        let pitch = 12 + ev.note + trans;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) shifted++;
        slide = undefined;
        const changed = apply(pitch);
        if (cmd) setMotion(cmd);
        const moving = porta !== undefined || slide !== undefined;
        if (ev.tied && sounding && pitch === lastPitch && !changed && !cmd) cells[tick] = { kind: "tie" };
        else {
          const legato = ev.tied && sounding;
          if (legato) legatoNotes++;
          const variant = variantOf({ instrument, ...(local ? { adsr: local } : {}), ...(arp ? { arp } : {}), ...(vib ? { vibrato: vib } : {}), ...(wave !== undefined ? { wave } : {}) }, pitch);
          cells[tick] = { kind: "note", pitch, level: 15, inst: variant.name, ...(legato ? { legato: true } : {}), ...(moving ? motion(tick, pitch, lastPitch) : {}) };
          notes++;
        }
        sounding = true; lastPitch = pitch; lastInstrument = instrument;
      } else if (ev.note === 0) sounding = false;
      else if (ev.note === 0x7e) {
        if (sounding && cmd && (cmd.type === 0 || cmd.type === 2 || cmd.type === 1)) setMotion(cmd);
        const hold: Partial<GridCell> = sounding && cmd && cmd.type === 0 ? motion(tick, lastPitch, -1) : {};
        if (sounding && cmd && (apply(lastPitch) || hold.slideRate !== undefined)) {
          const variant = variantOf({ instrument: lastInstrument, ...(local ? { adsr: local } : {}), ...(arp ? { arp } : {}), ...(vib ? { vibrato: vib } : {}), ...(wave !== undefined ? { wave } : {}) }, lastPitch);
          cells[tick] = { kind: "note", pitch: lastPitch, level: 15, inst: variant.name, legato: true, ...hold };
          legatoNotes++;
        } else if (sounding) cells[tick] = { kind: "tie" };
      }
    }
    voices.push({ name: `Track ${v + 1}`, cells });
    voiceReports.push({ id: v + 1, sequences: reports[v]!.sequences, notes, octaveShifted: shifted, legato: legatoNotes });
  }
  const shiftedTotal = voiceReports.reduce((n, x) => n + x.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  for (const [name, n] of commands) losses.push(`Command "${name}" (${n} uses) is not imported.`);

  const defs: Record<string, Record<string, unknown>> = {};
  const renames = new Map<string, string>();
  const instReports: Sf2ImportReport["instruments"] = [];
  for (const x of [...variants.values()].sort((a, b) => a.instrument - b.instrument || a.name.localeCompare(b.name))) {
    if (x.instrument >= (t.instr!.rows)) throw new Sf2Error(`instrument ${x.instrument} is above the number of instruments (${t.instr!.rows})`);
    const converted = convertSf2Instrument(song, x.instrument, x, { low: x.low, high: x.high }, maxMidi, fps, options.softRestart === true, options.pulseTables === false, options.filterTables === false);
    const json = JSON.stringify(converted.def);
    const same = Object.entries(defs).find(([, d]) => JSON.stringify(d) === json);
    if (same) { renames.set(x.name, same[0]); continue; }
    defs[x.name] = converted.def;
    instReports.push({ number: x.instrument, sidwave: x.name, notes: x.uses, approximations: converted.notes });
    for (const note of converted.notes) losses.push(`Instrument ${x.instrument}: ${note}`);
  }
  if (instReports.length > 63) {
    if (options.localAdsr !== false && [...variants.values()].some((x) => x.adsr)) {
      const again = importSf2(bytes, { ...options, localAdsr: false });
      again.report.losses.unshift(`Set-local-ADSR commands are not imported: with them the song needs ${instReports.length} instruments and SIDWave allows 63.`);
      return again;
    }
    if (options.arpeggios !== false && [...variants.values()].some((x) => x.arp)) {
      const again = importSf2(bytes, { ...options, arpeggios: false });
      again.report.losses.unshift(`Arpeggio commands are not imported: with them the song needs ${instReports.length} instruments and SIDWave allows 63.`);
      return again;
    }
    if (options.vibrato !== false && [...variants.values()].some((x) => x.vibrato)) {
      const again = importSf2(bytes, { ...options, vibrato: false });
      again.report.losses.unshift(`Vibrato commands are not imported: with them the song needs ${instReports.length} instruments and SIDWave allows 63.`);
      return again;
    }
    throw new Sf2Error(`the song uses ${instReports.length} instruments (counting effect variants); SIDWave allows 63`);
  }
  if (renames.size) for (const voice of voices) for (const c of voice.cells) if (c.inst && renames.has(c.inst)) c.inst = renames.get(c.inst)!;
  const resolved = resolveMotion(voices, frameStart, defs, mode, maxMidi);
  if (resolved.pitchedBends) losses.push(`${resolved.pitchedBends} slide(s) are not imported because SIDWave cannot bend a note of an instrument whose wavetable sets pitches.`);
  if (resolved.tooSmall) losses.push(`${resolved.tooSmall} slide(s) move the pitch by less than half a semitone and are not imported.`);
  losses.push("The first frame of a note, main volume and the global filter are approximated.");

  const title = options.title ?? "Imported SID Factory II song";
  let yaml: string;
  try { yaml = buildGridScore({
    title, mode, grid: 1 / rowsPerBeat, bars, voices, instruments: defs,
    header: [`Imported from a SID Factory II song file (driver ${song.driver.major}.${song.driver.minor}.${song.driver.revision}) by SIDWave.`, `One grid cell is one sequence row (${rowsPerBeat} rows per beat); see the import report for what was approximated or dropped.`],
    validate: options.validate === false ? false : needsCompile(voices, defs) ? true : "parse", ...(sidCount > 1 ? { sids: sidList(sidCount) } : {}),
  }); } catch (error) {
    if (error instanceof Error && /exceeds 255 steps/.test(error.message) && options.arpeggios !== false && [...variants.values()].some((x) => x.arp)) {
      const again = importSf2(bytes, { ...options, arpeggios: false });
      again.report.losses.unshift("Arpeggio commands are not imported: the arpeggio variants of the instruments exceed the 255 wavetable steps SIDWave allows in one score.");
      return again;
    }
    if (error instanceof Error && /pulsetable data exceeds/.test(error.message) && options.pulseTables !== false) {
      const again = importSf2(bytes, { ...options, pulseTables: false });
      again.report.losses.unshift("Pulse programs are not imported (only the initial pulse width): their steps exceed the 255 pulse steps SIDWave allows in one score.");
      return again;
    }
    if (error instanceof Error && /filtertable data exceeds/.test(error.message) && options.filterTables !== false) {
      const again = importSf2(bytes, { ...options, filterTables: false });
      again.report.losses.unshift("Filter programs are not imported: their steps exceed the 255 filter steps SIDWave allows in one score.");
      return again;
    }
    if (error instanceof Error && /hard restart/.test(error.message) && options.softRestart !== true) {
      const again = importSf2(bytes, { ...options, softRestart: true });
      again.report.losses.unshift("The rows are too short for a two-frame hard restart in SIDWave; every instrument is imported with a restart of zero frames.");
      return again;
    }
    throw error;
  }
  return {
    yaml,
    report: {
      format: "sf2", driver: `${song.driver.major}.${String(song.driver.minor).padStart(2, "0")}.${String(song.driver.revision).padStart(2, "0")}`, song: songNumber, songs, ticks: totalTicks, rowsPerBeat, bars: barCount,
      voices: voiceReports, instruments: instReports, tempo: { values: chain, framesPerTickRange: [minT, maxT], alternating, clamped }, loop: loops, commands: Object.fromEntries(commands), losses: [...new Set(losses)], warnings,
    },
  };
}
