// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Furnace import (C64 SID subset): .fur modules become a SIDWave 1.3 score plus a report.

import { midiToNoteName } from "../sidwave.js";
import { maxSidwaveMidi } from "../sidwaveCompiler.js";
import { FurnaceError, parseFurnace, type FurInstrument, type FurSong } from "./furnace.js";
import { buildGridScore, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";

export interface FurnaceImportOptions { title?: string; mode?: "PAL" | "NTSC"; validate?: boolean; maxRows?: number }
export interface FurnaceImportReport {
  format: "furnace";
  version: number;
  chip: string;
  subsongs: number;
  rows: number;
  rowsPerBeat: number;
  bars: number;
  tickRate: number;
  ticksPerRow: number;
  voices: Array<{ id: number; notes: number; octaveShifted: number }>;
  instruments: Array<{ number: number; name: string; sidwave: string; notes: number; lost: string[] }>;
  effects: number;
  losses: string[];
  warnings: string[];
}
export interface FurnaceImportResult { yaml: string; report: FurnaceImportReport }

const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);
const WAVES: Record<number, string> = { 1: "tri", 2: "saw", 4: "pulse", 3: "tri+saw", 5: "tri+pulse", 6: "saw+pulse", 7: "tri+saw+pulse" };

function convertInstrument(ins: FurInstrument | undefined): { def: Record<string, unknown>; lost: string[] } {
  const lost: string[] = [];
  if (!ins || ins.type !== 3 || !ins.c64) {
    lost.push(ins ? `instrument type ${ins.type} is not a C64 instrument; a plain pulse instrument is used` : "the instrument does not exist; a plain pulse instrument is used");
    return { def: { waveform: "pulse", adsr: [0, 6, 8, 3] }, lost };
  }
  const c = ins.c64;
  const bits = c.flags1 & 0x0f;
  const waveform = bits & 8 ? "noise" : WAVES[bits & 7] ?? "pulse";
  const def: Record<string, unknown> = { waveform: waveform === "tri" ? "triangle" : waveform === "saw" ? "sawtooth" : waveform, adsr: [c.ad >> 4, c.ad & 15, c.sr >> 4, c.sr & 15] };
  if (bits & 4) def.pulse_width = Math.max(1, Math.min(4094, c.duty & 0xfff));
  if (c.flags2 & 0xc0) lost.push("ring modulation and hard sync flags are not imported");
  if (c.flags1 & 0x10 || c.cutoffRes) lost.push("the filter settings are not imported");
  const macro = (code: number) => ins.macros.find((m) => m.code === code && m.values.length > 0);
  const arp = macro(1), wave = macro(3), duty = macro(2);
  for (const m of ins.macros) if (![1, 2, 3].includes(m.code) && m.values.length) lost.push(`macro ${m.code} (volume, pitch, filter or extended) is not imported`);
  if (arp || wave) {
    const n = Math.min(255, Math.max(arp?.values.length ?? 0, wave?.values.length ?? 0));
    const speed = Math.min(255, (arp ?? wave)!.speed);
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
      const step: Record<string, unknown> = { frames: speed, gate: true };
      const w = wave ? wave.values[Math.min(i, wave.values.length - 1)]! & 15 : 0;
      if (w) step.wave = w & 8 ? "noise" : WAVES[w & 7] ?? "pulse";
      const a = arp ? arp.values[Math.min(i, arp.values.length - 1)]! : 0;
      if (a & 0x40000000) step.note = midiToNoteName(Math.max(12, Math.min(106, (a & 0xffffff) - 48)));
      else if (a !== 0) step.note = `${a < 0 ? "-" : "+"}${Math.min(60, Math.abs(a))}`;
      steps.push(step);
    }
    def.wavetable = steps;
    const loop = (arp ?? wave)!.loop;
    if (loop !== 255 && loop < n) def.loop = loop;
    lost.push("macro steps count Furnace ticks; SIDWave counts player calls (a different rate), and arpeggio and waveform macros of different lengths are held at their last value");
  }
  if (duty && bits & 4) {
    const steps = duty.values.slice(0, 255).map((v) => ({ set: Math.max(1, Math.min(4094, v & 0xfff)), frames: Math.min(255, duty.speed) }));
    def.pulsetable = { steps, ...(duty.loop !== 255 && duty.loop < steps.length ? { loop: duty.loop } : {}) };
  }
  return { def, lost };
}

/** Imports a Furnace module (C64 chip only) as SIDWave text. See doc/interchange.md. */
export function importFurnace(bytes: Uint8Array, options: FurnaceImportOptions = {}): FurnaceImportResult {
  const song: FurSong = parseFurnace(bytes);
  const mode = options.mode ?? "PAL";
  const maxRows = options.maxRows ?? 100_000;
  const losses: string[] = [];
  const warnings: string[] = [];
  const total = song.ordersLength * song.patternLength;
  if (total > maxRows) throw new FurnaceError(`the song has ${total} rows per channel; the limit is ${maxRows}`);
  if (song.subsongs > 1) losses.push(`The module has ${song.subsongs} subsongs; only the first is imported.`);
  let effects = 0;
  const maxMidi = maxSidwaveMidi(mode);
  const rowsPerChannel: Array<Array<{ note?: number; ins?: number; vol?: number }>> = [];
  const noteRows = song.ordersLength * song.patternLength;
  for (let c = 0; c < 3; c++) {
    const rows: Array<{ note?: number; ins?: number; vol?: number }> = [];
    for (let o = 0; o < song.ordersLength; o++) {
      const pattern = song.patterns.get(c * 65536 + (song.orders[o]?.[c] ?? 0));
      for (let r = 0; r < song.patternLength; r++) {
        const cell = pattern?.get(r);
        if (cell) { effects += cell.effects; rows.push(cell); } else rows.push({});
      }
    }
    rowsPerChannel.push(rows);
  }
  if (effects) losses.push(`${effects} effect commands (speed changes, jumps, slides, vibrato, arpeggio, filter and others) are not imported; jumps are not followed.`);
  const avgSpeed = song.speeds.reduce((a, b) => a + b, 0) / song.speeds.length;
  if (new Set(song.speeds).size > 1) losses.push(`The speed pattern ${song.speeds.join(",")} is played with its average of ${avgSpeed} ticks per row.`);
  const rowSeconds = avgSpeed / song.tickRate;
  const bpmOf = (rpb: number): number => 60 / (rpb * rowSeconds);
  let rowsPerBeat = 4;
  for (const candidate of [4, 2, 8, 1]) if (bpmOf(candidate) <= 220 && bpmOf(candidate) >= 30) { rowsPerBeat = candidate; break; }
  const bpm = Math.round(Math.max(30, Math.min(220, bpmOf(rowsPerBeat))) * 10000) / 10000;
  if (bpm !== Math.round(bpmOf(rowsPerBeat) * 10000) / 10000) losses.push(`The row length is outside the SIDWave tempo range; the tempo is clamped to ${bpm} BPM.`);
  const barRows = 4 * rowsPerBeat;
  const barCount = Math.ceil(noteRows / barRows);
  const totalCells = barCount * barRows;
  const bars: GridBar[] = Array.from({ length: barCount }, () => ({ cells: barRows, sig: "4/4", tempo: bpm }));

  const names = new Map<number, string>();
  const uses = new Map<number, number>();
  const voices: GridVoice[] = [];
  const reports: FurnaceImportReport["voices"] = [];
  for (let c = 0; c < 3; c++) {
    const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
    let ins = 0, level = 15, sounding = false, notes = 0, shifted = 0;
    for (let r = 0; r < noteRows; r++) {
      const row = rowsPerChannel[c]![r]!;
      if (row.ins !== undefined) ins = row.ins;
      if (row.vol !== undefined) level = Math.max(1, Math.min(15, row.vol));
      if (row.note !== undefined && row.note < 180) {
        let pitch = row.note - 48;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) shifted++;
        let name = names.get(ins);
        if (!name) { name = `f${String(ins).padStart(2, "0")}${slug(song.instruments[ins]?.name ?? "") ? `_${slug(song.instruments[ins]!.name)}` : ""}`; names.set(ins, name); }
        uses.set(ins, (uses.get(ins) ?? 0) + 1);
        cells[r] = { kind: "note", pitch, level, inst: name };
        sounding = true;
        notes++;
      } else if (row.note !== undefined) sounding = false;
      else if (sounding) cells[r] = { kind: "tie" };
    }
    voices.push({ name: `Channel ${c + 1}`, cells });
    reports.push({ id: c + 1, notes, octaveShifted: shifted });
  }
  const shiftedTotal = reports.reduce((n, v) => n + v.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  const defs: Record<string, Record<string, unknown>> = {};
  const instReports: FurnaceImportReport["instruments"] = [];
  for (const [index, count] of [...uses].sort((a, b) => a[0] - b[0])) {
    const converted = convertInstrument(song.instruments[index]);
    defs[names.get(index)!] = converted.def;
    instReports.push({ number: index, name: song.instruments[index]?.name ?? "", sidwave: names.get(index)!, notes: count, lost: converted.lost });
    for (const l of converted.lost) losses.push(`Instrument ${index}: ${l}.`);
  }
  if (instReports.length > 63) throw new FurnaceError(`the song uses ${instReports.length} instruments; SIDWave allows 63`);
  losses.push("The volume column of a row sets the level of the following notes (0 to 15); panning, wavetables, samples and the song's patchbay are not imported.");
  if (voices.every((v) => v.cells.every((cell) => cell.kind === "rest"))) throw new FurnaceError("the module contains no notes on the C64 channels");
  const yaml = buildGridScore({
    title: options.title ?? (song.name || "Imported Furnace module"), ...(song.author ? { author: song.author } : {}), mode, grid: 1 / rowsPerBeat, bars, voices, instruments: defs,
    header: [`Imported from a Furnace module (format version ${song.version}, C64 chip) by SIDWave.`, `One grid cell is one pattern row (${rowsPerBeat} rows per beat); see the import report.`],
    validate: options.validate !== false,
  });
  return {
    yaml,
    report: {
      format: "furnace", version: song.version, chip: song.chips[0] === 0x47 ? "C64 (6581)" : "C64 (8580)", subsongs: song.subsongs, rows: noteRows, rowsPerBeat, bars: barCount,
      tickRate: song.tickRate, ticksPerRow: avgSpeed, voices: reports, instruments: instReports, effects, losses: [...new Set(losses)], warnings,
    },
  };
}
