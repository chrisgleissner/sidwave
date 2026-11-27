// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// GoatTracker import: GTS!, GTS2 and GTS3-GTS5 song files become a SIDWave 1.3 score plus a report. One import path:
// every version is first converted to the GTS5 model (goattracker.ts), as GoatTracker's own loader does.

import { midiToNoteName } from "../sidwave.js";
import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { InterchangeInputError } from "./errors.js";
import { GT, GoatTrackerError, parseGoatTracker, patternLength, type GtInstrument, type GtSong } from "./goattracker.js";
import { buildGridScore, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";

export interface GoatTrackerImportOptions {
  title?: string;
  /** Subsong, 1-based. Default 1. */
  song?: number;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
  /** Longest import in pattern rows per channel. Default 100,000. */
  maxRows?: number;
}

export interface GoatTrackerImportReport {
  format: "goattracker";
  magic: string;
  family: GtSong["family"];
  conversions: string[];
  song: number;
  songs: number;
  rows: number;
  rowsPerBeat: number;
  bars: number;
  voices: Array<{ id: number; channel: number; notes: number; octaveShifted: number; retriggeredTonePortamento: number }>;
  instruments: Array<{ number: number; name: string; sidwave: string; notes: number; approximations: string[] }>;
  tempo: { initialTicksPerRow: number; changes: number; changesNotAtBarLine: number; funkTempo: number; perChannelTempo: number; ticksPerRowRange: [number, number]; clamped: number };
  loop: { channel: number; entry: number }[];
  commands: Record<string, number>;
  losses: string[];
  warnings: string[];
}
export interface GoatTrackerImportResult { yaml: string; report: GoatTrackerImportReport }

const CMD_NAMES = ["", "portamento up", "portamento down", "tone portamento", "vibrato", "set AD", "set SR", "set waveform", "set wavetable pointer", "set pulse pointer",
  "set filter pointer", "set filter control", "set filter cutoff", "master volume", "funk tempo", "tempo"];

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);
const signed7 = (v: number): number => (v < 0x40 ? v : v - 128);
const signed8 = (v: number): number => (v < 0x80 ? v : v - 256);
const wavePart = (wave: number): { name?: string; ring: boolean; sync: boolean; test: boolean; gate: boolean; lossy: boolean } => {
  const bits = wave & 0xf0;
  const names: Record<number, string> = { 0x10: "tri", 0x20: "saw", 0x40: "pulse", 0x30: "tri+saw", 0x50: "tri+pulse", 0x60: "saw+pulse", 0x70: "tri+saw+pulse" };
  const lossy = (bits & 0x80) !== 0 && (bits & 0x70) !== 0;
  const name = bits & 0x80 ? "noise" : names[bits];
  return { ...(name ? { name } : {}), ring: !!(wave & 4), sync: !!(wave & 2), test: !!(wave & 8), gate: !!(wave & 1), lossy };
};
const FILTER_TYPES: Record<number, string> = { 0x10: "lowpass", 0x20: "bandpass", 0x40: "highpass", 0x50: "lowpass+highpass", 0x60: "bandpass+highpass", 0x70: "all", 0x30: "bandpass" };

/** Imports a GoatTracker song file as SIDWave text. See doc/interchange.md for the mapping and losses. */
export function importGoatTracker(bytes: Uint8Array, options: GoatTrackerImportOptions = {}): GoatTrackerImportResult {
  const song = parseGoatTracker(bytes);
  const mode = options.mode ?? "PAL";
  const fps = sidwaveFrameRate(mode);
  const maxRows = options.maxRows ?? 100_000;
  const songNumber = options.song ?? 1;
  if (!Number.isInteger(songNumber) || songNumber < 1) throw new RangeError("song must be a positive integer");
  if (song.songs.length === 0) throw new GoatTrackerError("the file has no songs");
  if (songNumber > song.songs.length) throw new RangeError(`song ${songNumber} does not exist; the file has ${song.songs.length}`);
  const lists = song.songs[songNumber - 1]!;
  const warnings: string[] = [];
  const losses: string[] = [];
  const commands = new Map<string, number>();
  const count = (name: string) => commands.set(name, (commands.get(name) ?? 0) + 1);

  // Expand the first pass of each channel's order list into rows.
  interface Row { note: number; inst: number; cmd: number; data: number; trans: number }
  const channels: Row[][] = [];
  const loops: GoatTrackerImportReport["loop"] = [];
  for (let c = 0; c < GT.MAX_CHN; c++) {
    const list = lists[c]!;
    const rows: Row[] = [];
    let trans = 0;
    let pos = 0;
    let loopEntry = -1;
    for (let guard = 0; guard < 100_000 && pos < list.length; guard++) {
      const entry = list[pos]!;
      if (entry === GT.LOOPSONG) { loopEntry = list[pos + 1] ?? 0; break; }
      if (entry >= GT.TRANSDOWN) { trans = entry - GT.TRANSUP; pos++; continue; }
      let repeat = 0;
      if (entry >= GT.REPEAT) { repeat = entry - GT.REPEAT; pos++; }
      const number = list[pos]!;
      if (number >= GT.MAX_PATT || number >= GT.REPEAT) throw new GoatTrackerError(`channel ${c + 1}: order list entry ${pos} is not a pattern (${number})`);
      const pattern = song.patterns[number];
      const length = patternLength(pattern);
      for (let play = 0; play <= repeat; play++) {
        for (let r = 0; r < length; r++) {
          rows.push(pattern ? { note: pattern[r * 4]!, inst: pattern[r * 4 + 1]!, cmd: pattern[r * 4 + 2]!, data: pattern[r * 4 + 3]!, trans }
            : { note: GT.REST, inst: 0, cmd: 0, data: 0, trans });
        }
        if (rows.length > maxRows) throw new GoatTrackerError(`the song has more than ${maxRows} rows in channel ${c + 1}`);
      }
      pos++;
    }
    if (loopEntry >= 0) loops.push({ channel: c + 1, entry: loopEntry });
    channels.push(rows);
  }
  let totalRows = 0;
  for (const c of channels) totalRows = Math.max(totalRows, c.length);
  if (totalRows === 0) throw new GoatTrackerError("the song has no rows");
  const lengths = channels.map((c) => c.length);
  if (new Set(lengths).size > 1) losses.push(`The channels have ${lengths.join(", ")} rows in their first pass; shorter channels are padded with rests.`);
  if (loops.some((l) => l.entry !== 0)) losses.push("The song loops back to a position other than the start; SIDWave loops the whole timeline, so the intro plays again on each pass.");

  // Tempo per row (ticks per row), global.
  const stl = song.ltable[GT.STBL]!, str = song.rtable[GT.STBL]!;
  const last = song.instruments[GT.MAX_INSTR - 1]!;
  let ticks = last.ad >= 2 && !last.ptr[GT.WTBL] ? last.ad : 6;
  const initialTicks = ticks;
  const funk = { l: 9, r: 6 };
  let funkOn = false;
  const rowTicks: number[] = [];
  let tempoChanges = 0, funkRows = 0, perChannel = 0;
  const changeRows: number[] = [];
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < GT.MAX_CHN; c++) {
      const row = channels[c]![r];
      if (!row) continue;
      if (row.cmd === GT.CMD_SETTEMPO) {
        const data = row.data;
        if (data >= 0x80) { perChannel++; count("tempo per channel"); continue; }
        const before = funkOn ? -1 : ticks;
        if (data >= 3) { ticks = data; funkOn = false; } else if (data === 2) { ticks = 3; funkOn = false; } else { funkOn = true; }
        if ((funkOn ? -1 : ticks) !== before) { tempoChanges++; changeRows.push(r); }
      } else if (row.cmd === GT.CMD_FUNKTEMPO) {
        if (row.data) { funk.l = stl[row.data - 1] ?? 9; funk.r = str[row.data - 1] ?? 6; }
        funkOn = true; tempoChanges++; changeRows.push(r);
      }
    }
    if (funkOn) { funkRows++; rowTicks.push(Math.max(1, (funk.l + funk.r) / 2)); } else rowTicks.push(ticks);
  }
  if (funkRows) losses.push(`Funk tempo (alternating row lengths of ${funk.l} and ${funk.r} ticks, ${funkRows} rows) is played with the average row length.`);
  if (perChannel) losses.push(`${perChannel} per-channel tempo commands (values 0x80 and above) are not imported; all channels follow the global tempo.`);

  // Rows per beat so that every bar tempo is within 30..220 BPM.
  const bpmOf = (t: number, rpb: number): number => 60 * fps / (rpb * t);
  let minT = Infinity, maxT = 0;
  for (const t of rowTicks) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
  let rowsPerBeat = 4;
  for (const candidate of [4, 2, 8, 1]) {
    if (bpmOf(minT, candidate) <= 220 && bpmOf(maxT, candidate) >= 30) { rowsPerBeat = candidate; break; }
  }
  const barRows = 4 * rowsPerBeat;
  const barCount = Math.ceil(totalRows / barRows);
  if (barCount > 2048) throw new GoatTrackerError(`the song has ${barCount} bars; the limit is 2048`);
  const totalCells = barCount * barRows;
  const bars: GridBar[] = [];
  let clamped = 0, notAtBar = 0;
  for (const r of changeRows) if (r % barRows !== 0) notAtBar++;
  for (let b = 0; b < barCount; b++) {
    const raw = bpmOf(rowTicks[Math.min(b * barRows, totalRows - 1)]!, rowsPerBeat);
    const bpm = Math.round(Math.max(30, Math.min(220, raw)) * 10000) / 10000;
    if (bpm !== Math.round(raw * 10000) / 10000) clamped++;
    bars.push({ cells: barRows, sig: "4/4", tempo: bpm });
  }
  if (notAtBar) losses.push(`${notAtBar} tempo change(s) are not on a bar line (${barRows} rows); SIDWave changes tempo at bar lines, so the rows in between keep the earlier row length.`);
  if (clamped) losses.push(`${clamped} bar(s) have a row length outside the SIDWave tempo range of 30 to 220 BPM and are clamped.`);

  // Instruments used by notes.
  const usedInstr = new Map<number, number>();
  const pitchRange = new Map<number, { low: number; high: number }>();
  const instrumentNames = new Map<number, string>();
  const maxMidi = maxSidwaveMidi(mode);
  const voices: GridVoice[] = [];
  const voiceReports: GoatTrackerImportReport["voices"] = [];
  for (let c = 0; c < GT.MAX_CHN; c++) {
    const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    let instr = 1;
    let sounding = false;
    let notes = 0, shifted = 0, toneporta = 0;
    for (let r = 0; r < totalRows; r++) {
      const row = channels[c]![r];
      if (!row) continue;
      if (row.inst) {
        if (row.inst >= GT.MAX_INSTR) throw new GoatTrackerError(`channel ${c + 1}, row ${r}: instrument ${row.inst} is above the limit of ${GT.MAX_INSTR - 1}`);
        instr = row.inst;
      }
      if (row.cmd) count(CMD_NAMES[row.cmd] ?? `command ${row.cmd}`);
      if (row.note <= GT.LASTNOTE && row.note >= GT.FIRSTNOTE) {
        let pitch = row.note - GT.FIRSTNOTE + row.trans + 12;
        if (row.cmd === GT.CMD_TONEPORTA) toneporta++;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) shifted++;
        const name = instrumentName(song, instr, instrumentNames);
        usedInstr.set(instr, (usedInstr.get(instr) ?? 0) + 1);
        const range = pitchRange.get(instr) ?? { low: pitch, high: pitch };
        range.low = Math.min(range.low, pitch); range.high = Math.max(range.high, pitch);
        pitchRange.set(instr, range);
        cells[r] = { kind: "note", pitch, level: 15, inst: name };
        notes++;
        sounding = true;
      } else if (row.note === GT.KEYOFF) sounding = false;
      else if (row.note === GT.REST || row.note === GT.KEYON) { if (sounding) cells[r] = { kind: "tie" }; }
    }
    voices.push({ name: `Channel ${c + 1}`, cells });
    voiceReports.push({ id: c + 1, channel: c + 1, notes, octaveShifted: shifted, retriggeredTonePortamento: toneporta });
  }
  // Ties only make sense after a note: a tie at the start of a channel (before any note) is a rest.
  const shiftedTotal = voiceReports.reduce((n, v) => n + v.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  const porta = voiceReports.reduce((n, v) => n + v.retriggeredTonePortamento, 0);
  if (porta) losses.push(`${porta} tone portamento notes are played as new notes (no glide).`);
  for (const [name, n] of commands) {
    if (name === "tempo" || name === "funk tempo" || name === "tempo per channel") continue;
    losses.push(`Pattern command "${name}" (${n} uses) is not imported.`);
  }

  // Instrument definitions.
  const defs: Record<string, Record<string, unknown>> = {};
  const instReports: GoatTrackerImportReport["instruments"] = [];
  for (const [number, uses] of [...usedInstr].sort((a, b) => a[0] - b[0])) {
    const converted = convertInstrument(song, number, fps, pitchRange.get(number)!, maxMidi);
    const name = instrumentNames.get(number)!;
    defs[name] = converted.def;
    instReports.push({ number, name: song.instruments[number]!.name, sidwave: name, notes: uses, approximations: converted.notes });
    for (const note of converted.notes) losses.push(`Instrument ${number}: ${note}`);
  }
  if (instReports.length > 63) throw new GoatTrackerError(`the song uses ${instReports.length} instruments; SIDWave allows 63`);

  const title = options.title ?? (song.name || "Imported GoatTracker song");
  const yaml = buildGridScore({
    title, ...(song.author ? { author: song.author } : {}), mode, grid: 1 / rowsPerBeat, bars, voices, instruments: defs,
    header: [`Imported from a ${song.family} song file (${song.magic}) by SIDWave.`, `One grid cell is one pattern row (${rowsPerBeat} rows per beat); see the import report for what was approximated or dropped.`,
      ...(song.copyright ? [`Copyright text of the source: ${song.copyright.replace(/[\r\n]/g, " ")}`] : [])],
    validate: options.validate !== false,
  });
  return {
    yaml,
    report: {
      format: "goattracker", magic: song.magic, family: song.family, conversions: song.conversions, song: songNumber, songs: song.songs.length,
      rows: totalRows, rowsPerBeat, bars: barCount, voices: voiceReports, instruments: instReports,
      tempo: { initialTicksPerRow: initialTicks, changes: tempoChanges, changesNotAtBarLine: notAtBar, funkTempo: funkRows, perChannelTempo: perChannel, ticksPerRowRange: [minT, maxT], clamped },
      loop: loops, commands: Object.fromEntries(commands), losses: [...new Set(losses)], warnings,
    },
  };
}

function instrumentName(song: GtSong, number: number, names: Map<number, string>): string {
  let name = names.get(number);
  if (!name) {
    const base = slug(song.instruments[number]?.name ?? "");
    name = `i${String(number).padStart(2, "0")}${base ? `_${base}` : ""}`;
    names.set(number, name);
  }
  return name;
}

/** Table segment from a 1-based pointer to its 0xff jump entry (inclusive), as GoatTracker's gettablepartlen(). */
function segment(l: Uint8Array, start: number): { first: number; end: number; hasJump: boolean } {
  let e = start - 1;
  while (e < GT.MAX_TABLELEN && l[e] !== 0xff) e++;
  return { first: start - 1, end: Math.min(e, GT.MAX_TABLELEN - 1), hasJump: e < GT.MAX_TABLELEN };
}

function semitonesPerRegister(): number {
  // Frequency register units per semitone at C4 (PAL clock); used to express vibrato speeds in semitones.
  return 261.6256 * (2 ** (1 / 12) - 1) * 16777216 / 985248;
}

function convertInstrument(song: GtSong, number: number, fps: number, range: { low: number; high: number }, maxMidi: number): { def: Record<string, unknown>; notes: string[] } {
  const inst: GtInstrument = song.instruments[number]!;
  const notes: string[] = [];
  const def: Record<string, unknown> = { adsr: [inst.ad >> 4, inst.ad & 15, inst.sr >> 4, inst.sr & 15] };
  const wl = song.ltable[GT.WTBL]!, wr = song.rtable[GT.WTBL]!;
  const first = wavePart(inst.firstwave & 0x7f);
  let baseWave: string | undefined = first.name;
  // Wavetable.
  if (inst.ptr[GT.WTBL]) {
    const seg = segment(wl, inst.ptr[GT.WTBL]);
    const steps: Array<Record<string, unknown>> = [];
    const indexOf = new Map<number, number>();
    let lastNote: string | undefined;
    let commandSteps = 0, lossyNoise = 0, outside = 0, clampedOffsets = 0;
    for (let k = seg.first; k < seg.end; k++) {
      const left = wl[k]!, right = wr[k]!;
      let noteSpec: string | undefined = lastNote;
      if (right !== 0x80) {
        if (right < 0x80) {
          let off = signed7(right);
          const clampedOff = Math.max(12 - range.low, Math.min(maxMidi - range.high, off));
          if (clampedOff !== off) { off = clampedOff; clampedOffsets++; }
          noteSpec = off === 0 ? undefined : `${off < 0 ? "-" : "+"}${Math.abs(off)}`;
        } else {
          const absolute = 12 + (right & 0x7f);
          if (absolute > maxMidi) clampedOffsets++;
          noteSpec = midiToNoteName(Math.min(maxMidi, absolute));
        }
      }
      if (left <= 0x0f) {
        const delay = left;
        if (delay > 0) {
          if (steps.length) steps[steps.length - 1]!.frames = Math.min(255, (steps[steps.length - 1]!.frames as number) + delay);
          else steps.push({ frames: Math.min(255, delay) });
        }
        indexOf.set(k, steps.length);
        steps.push({ ...(noteSpec ? { note: noteSpec } : {}), frames: 1 });
        lastNote = noteSpec;
      } else if (left >= 0xf0 && left <= 0xfe) {
        commandSteps++;
        indexOf.set(k, steps.length);
        steps.push({ frames: 1 });
      } else {
        const w = wavePart(left < 0xe0 ? left : left & 0x0f);
        if (w.lossy) lossyNoise++;
        indexOf.set(k, steps.length);
        steps.push({
          ...(w.name ? { wave: w.name } : {}), ...(w.ring ? { ring: true } : {}), ...(w.sync ? { sync: true } : {}), ...(w.test ? { test: true } : {}),
          gate: w.gate, ...(noteSpec ? { note: noteSpec } : {}), frames: 1,
        });
        lastNote = noteSpec;
        if (w.name && baseWave === undefined) baseWave = w.name;
      }
      if (steps.length > 255) { notes.push("the wavetable has more than 255 steps and is cut."); break; }
    }
    if (commandSteps) notes.push(`${commandSteps} wavetable command step(s) (portamento, vibrato, register or pointer commands) are not imported; the step is a one-frame pause.`);
    if (lossyNoise) notes.push(`${lossyNoise} wavetable step(s) combine noise with another waveform; they use noise alone.`);
    if (clampedOffsets) notes.push(`${clampedOffsets} wavetable pitch offset(s) would leave the playable range for the notes this song plays on the instrument (${midiToNoteName(range.low)} to ${midiToNoteName(range.high)}); they are limited to the range.`);
    if (steps.length === 0) notes.push("the wavetable is empty.");
    else {
      def.wavetable = steps;
      if (seg.hasJump && wr[seg.end]) {
        const target = wr[seg.end]! - 1;
        if (target >= seg.first && target < seg.end && indexOf.has(target)) def.loop = indexOf.get(target)!;
        else outside++;
      }
      if (outside) notes.push("the wavetable jumps outside its own steps; the jump is not imported and the last step holds.");
    }
  } else notes.push("the instrument has no wavetable (GoatTracker never sets the pitch for such an instrument); it plays the note with its first waveform.");
  def.waveform = baseWave === "tri" ? "triangle" : baseWave === "saw" ? "sawtooth" : baseWave === "noise" ? "noise" : "pulse";
  if (baseWave && !["tri", "saw", "noise", "pulse"].includes(baseWave)) def.waveform = baseWave;
  // Pulse table.
  if (inst.ptr[GT.PTBL]) {
    const pl = song.ltable[GT.PTBL]!, pr = song.rtable[GT.PTBL]!;
    const seg = segment(pl, inst.ptr[GT.PTBL]);
    const steps: Array<Record<string, unknown>> = [];
    const indexOf = new Map<number, number>();
    for (let k = seg.first; k < seg.end; k++) {
      indexOf.set(k, steps.length);
      if (pl[k]! >= 0x80) {
        const value = ((pl[k]! & 0x0f) << 8) | pr[k]!;
        steps.push({ set: Math.max(1, Math.min(4094, value)) });
      } else if (pl[k]! > 0) steps.push({ add: signed8(pr[k]!), frames: pl[k]! });
    }
    if (steps.length) {
      const target = seg.hasJump && pr[seg.end] ? pr[seg.end]! - 1 : -1;
      const loop = indexOf.get(target);
      if (target >= 0 && loop === undefined) notes.push("the pulse table jumps outside its own steps; the jump is not imported.");
      def.pulsetable = { steps, ...(loop === undefined ? {} : { loop }) };
      const firstStep = steps[0]!;
      if (typeof firstStep.set === "number") def.pulse_width = firstStep.set;
    }
  }
  // Filter table.
  if (inst.ptr[GT.FTBL]) {
    const fl = song.ltable[GT.FTBL]!, fr = song.rtable[GT.FTBL]!;
    const seg = segment(fl, inst.ptr[GT.FTBL]);
    const steps: Array<Record<string, unknown>> = [];
    const indexOf = new Map<number, number>();
    let cutoff = 0, resonance = 8, type = "lowpass";
    let routedOther = false;
    for (let k = seg.first; k < seg.end; k++) {
      indexOf.set(k, steps.length);
      if (fl[k]! >= 0x80) {
        const t = FILTER_TYPES[fl[k]! & 0x70] ?? "lowpass";
        if ((fl[k]! & 0x70) === 0x30) notes.push("a filter step selects low-pass plus band-pass, which SIDWave has no name for; it uses band-pass.");
        type = t; resonance = fr[k]! >> 4;
        if ((fr[k]! & 7) !== 0 && (fr[k]! & 7) !== 1 && (fr[k]! & 7) !== 2 && (fr[k]! & 7) !== 4) routedOther = true;
        let step: Record<string, unknown>;
        if (k + 1 < seg.end && fl[k + 1] === 0x00) { cutoff = fr[k + 1]! << 3; indexOf.set(k + 1, steps.length); step = { cutoff, resonance, type }; k++; }
        else step = { cutoff, resonance, type };
        steps.push(step);
      } else if (fl[k]! === 0x00) { cutoff = fr[k]! << 3; steps.push({ cutoff, resonance, type }); }
      else steps.push({ add: signed8(fr[k]!) * 8, frames: fl[k]! });
    }
    if (steps.length) {
      const target = seg.hasJump && fr[seg.end] ? fr[seg.end]! - 1 : -1;
      const loop = indexOf.get(target);
      if (target >= 0 && loop === undefined) notes.push("the filter table jumps outside its own steps; the jump is not imported.");
      def.filtertable = { steps, ...(loop === undefined ? {} : { loop }) };
      if (routedOther) notes.push("the filter routing selects several voices; SIDWave routes the voice of this instrument only.");
    }
  }
  // Vibrato (speed table) and hard restart.
  if (inst.ptr[GT.STBL]) {
    const cmp = song.ltable[GT.STBL]![inst.ptr[GT.STBL] - 1]!, speed = song.rtable[GT.STBL]![inst.ptr[GT.STBL] - 1]!;
    const half = (cmp & 0x7f) / 2 + 1;
    const depth = cmp >= 0x80 ? half / 2 ** speed : speed * half / semitonesPerRegister();
    const rate = fps / (4 * half);
    if (depth > 0.01 && speed > 0) {
      const d = Math.max(0.03, Math.min(6, Math.round(depth * 100) / 100));
      const rt = Math.max(0.2, Math.min(12, Math.round(rate * 100) / 100));
      def.vibrato = { depth: d, rate: rt, ...(inst.vibdelay > 1 ? { delay: Math.min(255, inst.vibdelay) } : {}) };
      notes.push("vibrato is approximated by a triangle of the same speed and period, expressed in semitones at C4 (the GoatTracker vibrato depends on the note).");
    }
  }
  const g = inst.gatetimer & 0x3f;
  if (inst.gatetimer & 0x80) def.hard_restart = { frames: 0 };
  else if (g > 0) def.hard_restart = { frames: g, adsr: [0, 15, 0, 0] };
  return { def, notes };
}

export { InterchangeInputError };
