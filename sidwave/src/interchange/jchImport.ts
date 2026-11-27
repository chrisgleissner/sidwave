// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// JCH NewPlayer 20.G import: an editor image becomes a SIDWave 1.3 score plus a report. See doc/interchange.md.

import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { midiToNoteName } from "../sidwave.js";
import { GridScoreError, buildGridScore, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";
import { JchError, parseJch, type JchSong } from "./jch.js";
import { chooseRowsPerBeat, planBars } from "./modImport.js";

export interface JchImportOptions { title?: string; mode?: "PAL" | "NTSC"; validate?: boolean; maxRows?: number }
export interface JchImportReport {
  format: "jch";
  version: string;
  name: string;
  rows: number;
  rowsPerBeat: number;
  bars: number;
  tempo: { byte: number; groove: number[]; framesPerRow: [number, number]; changes: number };
  voices: Array<{ id: number; rows: number; notes: number; octaveShifted: number }>;
  instruments: Array<{ number: number; sidwave: string; notes: number; approximations: string[] }>;
  commands: Record<string, number>;
  losses: string[];
  warnings: string[];
}
export interface JchImportResult { yaml: string; report: JchImportReport; song: JchSong }

const CMD_NAMES: Record<number, string> = { 0: "slide up", 2: "slide down", 4: "instrument with wave pointer", 6: "vibrato", 8: "portamento", 9: "set AD and SR", 10: "set AD and SR (one shot)", 12: "wave pointer", 13: "filter or pulse pointer", 14: "speed", 15: "master volume" };
const cmdKind = (a: number): number => (a >= 0xe0 ? a >> 4 : a >= 0xc0 ? 12 : a >= 0xa0 ? 10 : a >= 0x90 ? 9 : a >= 0x80 ? 8 : a >= 0x60 ? 6 : a >= 0x40 ? 4 : a >= 0x20 ? 2 : 0);
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const reg = (midi: number): number => hz(midi) * 16777216 / 985248;
const wavePart = (c: number): { name?: string; ring: boolean; sync: boolean; test: boolean; gate: boolean } => {
  const bits = c & 0xf0;
  const names: Record<number, string> = { 0x10: "tri", 0x20: "saw", 0x40: "pulse", 0x30: "tri+saw", 0x50: "tri+pulse", 0x60: "saw+pulse", 0x70: "tri+saw+pulse" };
  const name = bits & 0x80 ? "noise" : names[bits];
  return { ...(name ? { name } : {}), ring: !!(c & 4), sync: !!(c & 2), test: !!(c & 8), gate: !!(c & 1) };
};

/** Imports a JCH NewPlayer 20.G editor image (PRG at $0F00 or an unpacked PSID). */
export function importJch(bytes: Uint8Array, options: JchImportOptions = {}): JchImportResult {
  const song = parseJch(bytes);
  const mode = options.mode ?? "PAL";
  const fps = sidwaveFrameRate(mode);
  const maxMidi = maxSidwaveMidi(mode);
  const maxRows = options.maxRows ?? 20_000;
  const losses: string[] = [];
  const warnings = [...song.warnings];
  const commands = new Map<string, number>();
  const count = (n: string): void => { commands.set(n, (commands.get(n) ?? 0) + 1); };
  interface Row { b0: number; note: number; trans: number }
  const channels: Row[][] = song.orderLists.map((list, v) => {
    const rows: Row[] = [];
    for (const e of list) for (const ev of song.sequences[e.sequence]!) {
      rows.push({ b0: ev.b0, note: ev.note, trans: e.transpose });
      if (rows.length > maxRows) throw new JchError(`voice ${v + 1} has more than ${maxRows} rows`);
    }
    return rows;
  });
  const R = Math.max(...channels.map((c) => c.length));
  if (R === 0) throw new JchError("the song has no rows");
  const lens = channels.map((c) => c.length).filter((n) => n > 0);
  if (new Set(lens).size > 1) losses.push(`The voices have ${channels.map((c) => c.length).join(", ")} rows; each voice loops on its own in the player, SIDWave plays one pass and pads the shorter voices with rests.`);

  // Tempo: a value of 2 or more lasts value + 1 frames; 0 and 1 read the break-speed (groove) table.
  const groove = song.groove.length === 2 ? [song.groove[1]!, song.groove[0]!] : song.groove;
  let speed = song.tempo, g = 0, changes = 0, grooved = false;
  const rowFrames: number[] = [];
  for (let r = 0; r < R; r++) {
    for (const ch of channels) {
      const row = ch[r];
      if (row && row.b0 >= 0xc0) {
        const c = row.b0 - 0xc0;
        if (c < 32 && song.commandA[c]! >> 4 === 0xe) { speed = song.commandB[c]!; changes++; g = 0; }
      }
    }
    if (speed < 2) grooved = true;
    const value = speed >= 2 ? speed : (groove.length ? groove[g++ % groove.length]! : 2);
    rowFrames.push(Math.max(1, value + 1));
  }
  if (grooved) losses.push("A groove (alternating row lengths) is played with the mean row length of its bar.");
  const rowSeconds = rowFrames.map((f) => f / fps);
  const rpb = chooseRowsPerBeat(rowSeconds);
  const plan = planBars(rowSeconds, rpb);
  const bars: GridBar[] = plan.bars.map((b) => ({ cells: b.rows, sig: `${b.beats}/4`, tempo: Math.round(Math.max(30, Math.min(220, 60 * b.beats / b.seconds)) * 10000) / 10000 }));
  const totalCells = bars.reduce((t, b) => t + b.cells, 0);

  // Notes.
  const usedInst = new Map<number, number>();
  const voices: GridVoice[] = [];
  const voiceReports: JchImportReport["voices"] = [];
  const instName = (n: number): string => `i${String(n).padStart(2, "0")}`;
  const pitchRange = new Map<number, { lo: number; hi: number }>();
  for (const [v, rows] of channels.entries()) {
    const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    let inst = 0, sounding = false, notes = 0, shifted = 0, prevMidi = -1;
    let last = -1;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      let cmd: { a: number; b: number } | undefined;
      if (row.b0 >= 0xa0 && row.b0 < 0xc0) inst = row.b0 & 0x1f;
      else if (row.b0 >= 0xc0) { const c = row.b0 - 0xc0; if (c < 32) cmd = { a: song.commandA[c]!, b: song.commandB[c]! }; }
      if (cmd) {
        const kind = cmdKind(cmd.a);
        if (kind !== 14) count(CMD_NAMES[kind] ?? `command ${cmd.a.toString(16)}`);
      }
      if (row.note >= 1 && row.note < 0x7e) {
        let pitch = 12 + row.note + row.trans;
        const orig = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== orig) shifted++;
        const cell: GridCell = { kind: "note", pitch, level: 15, inst: instName(inst) };
        const kind = cmd ? cmdKind(cmd.a) : -1;
        const frames = (rowFrames[r] ?? 5);
        if (row.b0 === 0x90 && sounding) cell.legato = true;
        if (kind === 8 && sounding && prevMidi >= 0) {
          const speedReg = ((cmd!.a & 15) << 8) | cmd!.b;
          const dist = Math.abs(reg(pitch) - reg(prevMidi));
          if (speedReg > 0) { cell.legato = true; cell.portamento = Math.max(1, Math.min(255, Math.ceil(dist / speedReg))); }
        } else if ((kind === 0 || kind === 2) && cmd) {
          const speedReg = ((cmd.a & 15) << 8) | cmd.b;
          let span = 0;
          for (let k = r; k < rows.length && !(k > r && rows[k]!.note < 0x7e); k++) span += rowFrames[k] ?? frames;
          span = Math.max(1, span - 1);
          const f0 = reg(pitch);
          const f1 = Math.max(1, kind === 0 ? f0 + speedReg * span : f0 - speedReg * span);
          const semis = Math.max(-12, Math.min(12, Math.round(12 * Math.log2(f1 / f0))));
          if (semis !== 0 && pitch + semis >= 12 && pitch + semis <= maxMidi) cell.bend = { to: semis, frames: Math.max(1, Math.min(255, span)) };
        } else if (kind === 6) {
          const x = cmd!.b >> 4, y = cmd!.b & 15;
          if (y > 0) cell.vibrato = { depth: Math.round(Math.max(0.1, Math.min(2.5, y * 0.15)) * 100) / 100, rate: Math.round(Math.min(12, 1 + x * 0.75) * 100) / 100 };
        }
        cells[r] = cell;
        last = r;
        notes++;
        sounding = true;
        prevMidi = pitch;
        usedInst.set(inst, (usedInst.get(inst) ?? 0) + 1);
        const range = pitchRange.get(inst) ?? { lo: pitch, hi: pitch };
        range.lo = Math.min(range.lo, pitch); range.hi = Math.max(range.hi, pitch);
        pitchRange.set(inst, range);
      } else if (row.note === 0) sounding = false;
      else if (row.note === 0x7e && sounding) cells[r] = { kind: "tie" };
      void last;
    }
    voices.push({ name: `Voice ${v + 1}`, cells });
    voiceReports.push({ id: v + 1, rows: rows.length, notes, octaveShifted: shifted });
  }
  const shiftedTotal = voiceReports.reduce((t, v) => t + v.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  for (const [name, n] of commands) {
    if (["vibrato", "portamento", "slide up", "slide down"].includes(name)) losses.push(`Command "${name}" (${n} uses) is imported approximately.`);
    else losses.push(`Command "${name}" (${n} uses) is not imported.`);
  }

  // Instruments.
  const defs: Record<string, Record<string, unknown>> = {};
  const instReports: JchImportReport["instruments"] = [];
  for (const [n, uses] of [...usedInst].sort((a, b) => a[0] - b[0])) {
    const { def, notes } = convertInstrument(song, n, pitchRange.get(n) ?? { lo: 48, hi: 48 }, maxMidi);
    defs[instName(n)] = def;
    instReports.push({ number: n, sidwave: instName(n), notes: uses, approximations: notes });
    for (const x of notes) losses.push(`Instrument ${n}: ${x}`);
  }
  if (instReports.length > 63) throw new JchError(`the song uses ${instReports.length} instruments; SIDWave allows 63`);
  const title = options.title ?? (song.name || "Imported JCH song");
  let yaml = "";
  for (const drop of ["", "bend", "vibrato", "portamento"] as const) {
    if (drop) {
      for (const v of voices) for (const c of v.cells) { delete (c as unknown as Record<string, unknown>)[drop]; if (drop === "portamento") { delete c.legato; } }
      losses.push(`SIDWave did not accept the ${drop === "bend" ? "slides" : drop === "vibrato" ? "vibratos" : "portamentos"} on this score; they are not imported.`);
    }
    try {
      yaml = buildGridScore({
        title, mode, grid: 1 / rpb, bars, voices, instruments: defs, validate: options.validate !== false,
        header: [`Imported from a JCH NewPlayer ${song.version} editor image by SIDWave.`, `One grid cell is one sequence row (${rpb} rows per beat); see the import report for what was approximated or dropped.`],
      });
      break;
    } catch (error) {
      if (!(error instanceof GridScoreError) || drop === "portamento") throw error;
    }
  }
  return {
    yaml, song,
    report: {
      format: "jch", version: song.version, name: song.name, rows: R, rowsPerBeat: rpb, bars: bars.length,
      tempo: { byte: song.tempo, groove: song.groove, framesPerRow: [Math.min(...rowFrames), Math.max(...rowFrames)], changes },
      voices: voiceReports, instruments: instReports, commands: Object.fromEntries(commands), losses: [...new Set(losses)], warnings,
    },
  };
}

function convertInstrument(song: JchSong, n: number, range: { lo: number; hi: number }, maxMidi: number): { def: Record<string, unknown>; notes: string[] } {
  const inst = song.instruments[n]!;
  const notes: string[] = [];
  const def: Record<string, unknown> = { adsr: [inst.ad >> 4, inst.ad & 15, inst.sr >> 4, inst.sr & 15] };
  let base: string | undefined;
  const drum = (inst.restart & 0x40) !== 0;
  if (inst.restart & 0x0f) notes.push("the wave table dwell (low nibble of the restart byte) is ignored; each wave table row lasts one frame.");
  if ((inst.restart & 0xf0) !== 0x80) def.hard_restart = { frames: 0 };
  // Wave table: rows of (note, control); $7F jumps, $7E stops.
  const steps: Array<Record<string, unknown>> = [];
  const indexOf = new Map<number, number>();
  let loop: number | undefined;
  let clamped = 0;
  let k = inst.wavePointer;
  for (let guard = 0; guard < 128 && k < 256; guard++) {
    if (indexOf.has(k)) { loop = indexOf.get(k); break; }
    const note = song.waveNote[k]!, ctrl = song.waveCtrl[k]!;
    indexOf.set(k, steps.length);
    if (note === 0x7e) break;
    if (note === 0x7f) { loop = indexOf.get(ctrl); if (loop === undefined) notes.push("the wave table jumps outside the steps used; the jump is dropped."); break; }
    const w = wavePart(ctrl);
    let spec: string | undefined;
    if (note & 0x80) {
      const abs = drum ? Math.round(69 + 12 * Math.log2(Math.max(1, (note & 0x7f) * 256 * 985248 / 16777216) / 440)) : 12 + (note & 0x7f);
      const fit = Math.max(12, Math.min(maxMidi, abs));
      if (fit !== abs) clamped++;
      spec = midiToNoteName(fit);
    } else if (note !== 0 && note < 0x7e) {
      const off = Math.min(note, maxMidi - range.hi);
      if (off !== note) clamped++;
      if (off > 0) spec = `+${off}`;
    }
    steps.push({ ...(w.name ? { wave: w.name } : {}), ...(w.ring ? { ring: true } : {}), ...(w.sync ? { sync: true } : {}), ...(w.test ? { test: true } : {}), gate: w.gate, ...(spec ? { note: spec } : {}), frames: 1 });
    if (w.name && base === undefined) base = w.name;
    k++;
  }
  if (clamped) notes.push(`${clamped} wave table pitch offset(s) would leave the playable range for the notes this song plays on the instrument and are limited to it.`);
  if (steps.length) { def.wavetable = steps; if (loop !== undefined) def.loop = loop; } else notes.push("the instrument has no wave table.");
  def.waveform = base === "tri" ? "triangle" : base === "saw" ? "sawtooth" : base === "noise" ? "noise" : "pulse";
  if (base && !["tri", "saw", "noise", "pulse"].includes(base)) def.waveform = base;
  // Pulse table.
  if (inst.pulsePointer) {
    const ps: Array<Record<string, unknown>> = [];
    const idx = new Map<number, number>();
    let p = inst.pulsePointer, pl: number | undefined;
    for (let guard = 0; guard < 32 && p + 3 < 256; guard++) {
      if (idx.has(p)) { pl = idx.get(p); break; }
      idx.set(p, ps.length);
      const xx = song.pulse[p]!, yy = song.pulse[p + 1]!, zz = song.pulse[p + 2]!, qq = song.pulse[p + 3]!;
      if (xx !== 0xff) ps.push({ set: Math.max(1, Math.min(4094, ((xx & 0x0f) << 8) | (xx & 0xf0))) });
      if (yy > 0 && (zz & 0x7f) > 0) ps.push({ add: zz & 0x80 ? -yy : yy, frames: zz & 0x7f });
      if (qq === p) break;
      p = qq;
    }
    if (ps.length) {
      def.pulsetable = { steps: ps, ...(pl === undefined ? {} : { loop: pl }) };
      if (typeof ps[0]!.set === "number") def.pulse_width = ps[0]!.set;
    }
  }
  if (inst.filterSetting & 0xf0 || inst.filterPointer) notes.push("the filter (instrument filter setting and filter table) is not imported.");
  return { def, notes };
}
