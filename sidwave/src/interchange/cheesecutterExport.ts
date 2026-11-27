// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// CheeseCutter 2.x export: the first three voices of a score as a .ct song file. SIDWave does not contain
// CheeseCutter's player. The caller supplies it as `driver`: either a .ct file (its player and memory layout are reused and
// its song data is cleared) or the raw player binary of CheeseCutter (a PRG with load address $0E00). The output embeds that
// driver, so it is the driver file's licence (GPL-2.0) that applies to the .ct file, as for any song saved by CheeseCutter.

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type EventExportOptions, type ExportedInstrument, type ExportedNote, type ExportedWaveStep } from "./events.js";
import { InterchangeLimitError } from "./errors.js";
import { CT, CheeseCutterError, emptyOrderList, parseCheeseCutter, tableAt, writeCheeseCutter, type CtSong } from "./cheesecutter.js";

export interface CheeseCutterExportOptions extends EventExportOptions {
  /** Bytes of a CheeseCutter .ct file or of the raw player binary. Required. */
  driver: Uint8Array;
}

export interface CheeseCutterExportResult {
  bytes: Uint8Array;
  /** Video frames per row (the song speed is this value minus one). */
  framesPerRow: number;
  multiplier: number;
  maxTimingErrorFrames: number;
  rows: number;
  sequences: number;
  sequenceRows: number;
  instruments: number;
  voices: number;
  driver: "ct-file" | "player-binary";
  losses: string[];
  warnings: string[];
}

const WAVE_BITS: Record<string, number> = { triangle: 0x10, tri: 0x10, sawtooth: 0x20, saw: 0x20, pulse: 0x40, noise: 0x80 };
const INITIAL_SEQ = [0xf0, 0xf0, 0x60, 0x00, 0xbf];

function waveByte(inst: ExportedInstrument): number {
  let byte = 0;
  for (const part of inst.waveform.split("+")) byte |= WAVE_BITS[part] ?? 0;
  if (byte === 0) byte = 0x40;
  if (inst.ring) byte |= 0x04;
  if (inst.sync) byte |= 0x02;
  return byte;
}

/**
 * Wave rows of a wavetable program. A step is a row (note column: offset or absolute note; wave column: the waveform byte with the
 * gate bit). The player holds a row for one call unless the next row has a wave column of 1 to 15, which is a delay of that many
 * calls (plus the one of the delay row itself). The first call of every note writes the instrument's restart waveform at the
 * pitch of the note before, and the program starts on the next call. A first step with the gate on therefore gives up one call
 * to the restart waveform (`restart`); without that the whole program would play one call late. The pitch of that step is not
 * heard on the first call.
 */
function waveProgram(inst: ExportedInstrument, baseWave: number): { rows: Array<[number, number]>; loop?: number; restart?: number; lowered: boolean } | undefined {
  const steps = (inst.wavetable ?? []).map((step) => ({ ...step, calls: Math.max(1, step.calls) }));
  let loopStep = inst.waveLoop;
  const byteOf = (step: ExportedWaveStep): number => {
    let byte = 0;
    if (step.waveform) for (const part of step.waveform.split("+")) byte |= WAVE_BITS[part] ?? 0;
    if (byte === 0) byte = baseWave & 0xf0;
    if (step.ring ?? (!step.waveform && inst.ring)) byte |= 0x04;
    if (step.sync ?? (!step.waveform && inst.sync)) byte |= 0x02;
    if (step.test) byte |= 0x08;
    if (step.gate) byte |= 0x01;
    return byte;
  };
  let restart: number | undefined;
  const first = steps[0];
  if (first?.gate) {
    restart = byteOf(first);
    // A program that loops to its first step keeps its period: the call given to the restart moves to the end of the loop.
    if (loopStep === 0) steps.push({ ...first, calls: 1 });
    // A single step that is held forever stays in the program.
    if (loopStep === 0 || steps.length > 1 || first.calls > 1) {
      first.calls--;
      if (first.calls === 0) { steps.shift(); if (loopStep) loopStep--; }
    }
  }
  if (steps.length === 0) return undefined;
  const rows: Array<[number, number]> = [];
  const startOf: number[] = [];
  let lowered = false;
  for (const step of steps) {
    startOf.push(rows.length);
    const byte = byteOf(step);
    if (step.absolute === undefined && (step.offset ?? 0) < 0) lowered = true;
    const trans = step.absolute !== undefined ? 0x80 | Math.max(0, Math.min(0x5e, step.absolute - 12)) : Math.max(0, Math.min(0x5f, step.offset ?? 0));
    let remaining = step.calls;
    while (remaining > 0) {
      if (remaining === 1) { rows.push([trans, byte]); remaining = 0; } else if (remaining === 2) { rows.push([trans, byte], [trans, byte]); remaining = 0; } else {
        const delay = Math.min(15, remaining - 2);
        rows.push([trans, byte], [trans, delay]);
        remaining -= delay + 2;
      }
    }
    if (rows.length > 200) return undefined;
  }
  const loop = loopStep === undefined ? undefined : startOf[loopStep];
  return { rows, ...(loop === undefined ? {} : { loop }), ...(restart === undefined ? {} : { restart }), lowered };
}

/** Throws unless every area the export writes lies inside the memory image of the driver. */
function checkWritableTables(song: CtSong): void {
  const O = CT.OFS;
  for (const [index, length, what] of [[O.sequenceLow, 128, "sequence low byte"], [O.sequenceHigh, 128, "sequence high byte"], [O.arpeggioFirst, 512, "wave"], [O.instrumentTable, 512, "instrument"], [O.commandTable, 256, "command"],
    [O.pulseProgram, 256, "pulse"], [O.filterProgram, 256, "filter"], [O.chordNotes, 128, "chord"], [O.chordStarts, 32, "chord index"], [O.songTable, 256, "song"],
    [O.orderListVoice1, 1024, "track 1"], [O.orderListVoice2, 1024, "track 2"], [O.orderListVoice3, 1024, "track 3"], [O.editorActive, 1, "editor flag"]] as Array<[number, number, string]>) tableAt(song, index, length, what);
}

/** Turns the driver bytes into a song template: a parsed .ct file, or a memory image built around the raw player. */
export function driverTemplate(driver: Uint8Array): { song: CtSong; kind: "ct-file" | "player-binary" } {
  if (driver.length >= 3 && String.fromCharCode(driver[0]!, driver[1]!, driver[2]!) === CT.MAGIC) {
    const parsed = parseCheeseCutter(driver);
    checkWritableTables(parsed);
    return { song: parsed, kind: "ct-file" };
  }
  if (driver.length < 0x1000 || driver.length > CT.IMAGE) throw new CheeseCutterError(`the driver file has ${driver.length} bytes; it is neither a .ct file nor a CheeseCutter player binary`);
  if (driver[0] !== 0x00 || driver[1] !== 0x0e) throw new CheeseCutterError("the driver file is not a CheeseCutter player binary (a PRG with load address $0E00)");
  const image = new Uint8Array(CT.IMAGE);
  if (driver.length - 2 + 0x0e00 > CT.IMAGE) throw new CheeseCutterError("the player binary does not fit in the 64 KiB image");
  image.set(driver.subarray(2), 0x0e00);
  const pointers: number[] = [];
  for (let i = 0; i < CT.PTR_COUNT; i++) pointers.push(image[CT.PTR_TABLE + i * 2]! | (image[CT.PTR_TABLE + i * 2 + 1]! << 8));
  const song: CtSong = {
    version: 12, clock: 0, multiplier: 1, sidModel: 1, fppres: 0, speeds: new Uint8Array(32).fill(5), highlight: 4, highlightOffset: 0,
    title: "", author: "", release: "", message: "", instrumentNames: [], image, pointers,
    orderLists: Array.from({ length: CT.SUBTUNES }, () => [emptyOrderList(), emptyOrderList(), emptyOrderList()]), trailer: new Uint8Array(0),
  };
  const O = CT.OFS;
  checkWritableTables(song);
  for (let n = 0; n < CT.SEQUENCES; n++) {
    const p = image[pointers[O.sequenceLow]! + n]! | (image[pointers[O.sequenceHigh]! + n]! << 8);
    if (p + CT.SEQ_BYTES > CT.IMAGE || p === 0) throw new CheeseCutterError("the player binary does not contain the sequence pointer tables of a CheeseCutter 2.x player");
  }
  return { song, kind: "player-binary" };
}

/** Clears every song data area of the template image (sequences, tables, order lists) and keeps the player. */
function clearSongData(song: CtSong): void {
  const O = CT.OFS, im = song.image, p = song.pointers;
  for (let n = 0; n < CT.SEQUENCES; n++) {
    const at = im[p[O.sequenceLow]! + n]! | (im[p[O.sequenceHigh]! + n]! << 8);
    im.fill(0, at, at + CT.SEQ_BYTES);
    im.set(INITIAL_SEQ, at);
  }
  im.fill(0, p[O.arpeggioFirst]!, p[O.arpeggioFirst]! + 512);
  im.fill(0, p[O.instrumentTable]!, p[O.instrumentTable]! + 512);
  im.fill(0, p[O.commandTable]!, p[O.commandTable]! + 256);
  for (const index of [O.pulseProgram, O.filterProgram]) { im.fill(0, p[index]!, p[index]! + 256); im.set([0x7f, 0x00, 0xff, 0x7f], p[index]!); }
  im.fill(0, p[O.chordNotes]!, p[O.chordNotes]! + 128);
  im.fill(0, p[O.chordStarts]!, p[O.chordStarts]! + 32);
  im.fill(0, p[O.songTable]!, p[O.songTable]! + 256);
  song.orderLists = Array.from({ length: CT.SUBTUNES }, () => [emptyOrderList(), emptyOrderList(), emptyOrderList()]);
  song.speeds = new Uint8Array(32).fill(5);
  song.instrumentNames = [];
}

/** Exports one song of a score as a CheeseCutter 2.x file. See doc/interchange.md for the mapping and losses. */
export function exportCheeseCutter(doc: ParsedSidwave, options: CheeseCutterExportOptions): CheeseCutterExportResult {
  if (!options.driver || options.driver.length === 0) throw new RangeError("a CheeseCutter driver is required: pass a .ct file or the player binary (--driver <file>)");
  const { song, kind } = driverTemplate(options.driver);
  const score = exportEvents(doc, options);
  const losses = [...score.losses];
  const warnings: string[] = [];
  const O = CT.OFS, im = song.image, p = song.pointers;
  clearSongData(song);

  const frameRate = score.mode === "PAL" ? 985248 / 19656 : 1022727 / 17030;
  const multiplier = Math.max(1, Math.round(score.callRate / frameRate));
  if (multiplier > 4) throw new InterchangeLimitError(`the score runs the player ${multiplier} times per frame; CheeseCutter export supports up to 4`);
  const voices = score.voices.filter((v) => v.sid === 0).slice(0, 3);
  if (score.voices.length > voices.length) losses.push(`Only the first three voices of the first SID are exported (the score has ${score.voices.length} voices).`);
  if (voices.length === 0) throw new RangeError("the score has no voice on the first SID");
  const frameOf = (seconds: number): number => Math.round(seconds * frameRate);
  const frames: number[] = [];
  for (const v of voices) for (const n of v.notes) frames.push(frameOf(n.on.time), frameOf(n.off.time));
  frames.push(frameOf(score.durationSeconds));
  // Row length: the largest frame count from 3 to 12 at which every note start and end is within one frame of a row.
  const errorOf = (t: number): number => { let m = 0; for (const f of frames) m = Math.max(m, Math.abs(f - t * Math.round(f / t))); return m; };
  let rowFrames = 3, best = Infinity;
  for (let t = 12; t >= 3; t--) { const e = errorOf(t); if (e <= 1) { rowFrames = t; best = e; break; } if (e < best) { best = e; rowFrames = t; } }
  if (best > 1) warnings.push(`No row length from 3 to 12 frames fits every note start and end; ${rowFrames} frames per row leaves an error of up to ${best} frames.`);
  const totalRows0 = Math.max(1, Math.ceil(frameOf(score.durationSeconds) / rowFrames));

  // Instruments: one CheeseCutter instrument per score instrument (and drum kit entry).
  const exported = new Map(score.instruments.map((i) => [i.index, i]));
  const instMap = new Map<string, number>();
  const offsetColumn = im.subarray(p[O.arpeggioFirst]!, p[O.arpeggioFirst]! + 256), waveColumn = im.subarray(p[O.arpeggioSecond]!, p[O.arpeggioSecond]! + 256);
  const instTable = im.subarray(p[O.instrumentTable]!, p[O.instrumentTable]! + 512);
  let wlen = 1;
  let usedFilter = false, usedVibrato = false, usedSlide = false, usedPulseTable = false, wavetableDropped = 0, negativeOffsets = 0;
  const names: string[] = [];
  const instrumentFor = (note: ExportedNote): number => {
    const key = `${note.instrument}:${note.percussion ? note.drum ?? "" : ""}`;
    let id = instMap.get(key);
    if (id !== undefined) return id;
    const inst = exported.get(note.instrument);
    id = instMap.size;
    if (id >= CT.INSTRUMENTS) throw new InterchangeLimitError(`the score uses more than ${CT.INSTRUMENTS} instruments`);
    instMap.set(key, id);
    const wave = inst ? waveByte(inst) : 0x40;
    const ad = inst ? (inst.adsr[0] << 4) | inst.adsr[1] : 0x09;
    const sr = inst ? (inst.adsr[2] << 4) | inst.adsr[3] : 0xa4;
    const arp = inst?.arpeggio && inst.arpeggio.offsets.length > 1 ? inst.arpeggio : undefined;
    // Wave program. A wavetable of the instrument becomes wave rows (a step that holds for several calls is a row followed by a
    // delay row); otherwise one row per arpeggio tone with a jump back to the first, or a stop row after a single row.
    let program = !arp && inst?.wavetable ? waveProgram(inst, wave) : undefined;
    if (program && wlen + program.rows.length + 1 > 255) program = undefined;
    if (!arp && inst?.wavetable && !program) wavetableDropped++;
    const rows: Array<[number, number]> = program ? program.rows : [];
    if (program?.lowered || arp?.offsets.some((offset) => offset < 0)) negativeOffsets++;
    if (!program) {
      if (arp) for (const [k, offset] of arp.offsets.entries()) rows.push([Math.max(0, Math.min(0x5f, offset)), k === 0 ? wave | 1 : 0]);
      else rows.push([0x00, wave | 1]);
    }
    if (wlen + rows.length + 1 > 255) throw new InterchangeLimitError("the wave tables of the instruments do not fit the 255 rows of a CheeseCutter wave table");
    const start = wlen;
    for (const [trans, w] of rows) { offsetColumn[wlen] = trans; waveColumn[wlen] = w; wlen++; }
    if (program?.loop !== undefined) { offsetColumn[wlen] = 0x7f; waveColumn[wlen] = start + program.loop; } else if (arp) { offsetColumn[wlen] = 0x7f; waveColumn[wlen] = start; } else { offsetColumn[wlen] = 0x7e; waveColumn[wlen] = 0; }
    wlen++;
    const arpDelay = arp && !program ? Math.max(0, Math.min(15, arp.callsPerStep - 1)) : 0;
    instTable[0 * CT.INSTRUMENTS + id] = ad;
    instTable[1 * CT.INSTRUMENTS + id] = sr;
    instTable[2 * CT.INSTRUMENTS + id] = 0x80 | arpDelay;
    instTable[3 * CT.INSTRUMENTS + id] = (program?.restart ?? wave) | 1;
    instTable[4 * CT.INSTRUMENTS + id] = 0;
    instTable[5 * CT.INSTRUMENTS + id] = inst?.pulseWidth !== undefined && (wave & 0x40) ? 0x80 | ((Math.max(1, Math.min(4095, inst.pulseWidth)) >> 8) & 0x0f) : 0;
    instTable[6 * CT.INSTRUMENTS + id] = 0;
    instTable[7 * CT.INSTRUMENTS + id] = start;
    names[id] = (inst?.name ?? `inst ${note.instrument}`).replace(/^lib:/, "").slice(0, 31);
    if (inst?.tables.filter || inst?.filterRouted) usedFilter = true;
    if (inst?.vibrato) usedVibrato = true;
    if (inst?.slide) usedSlide = true;
    if (inst?.tables.pulse) usedPulseTable = true;
    return id;
  };

  // Rows per voice (note value 0 holds, 1 releases the gate, 3.. a note; MIDI note = 12 + value).
  const maxMidi = 12 + 0x5e;
  interface Row { note: number; instrument: number; tied?: boolean }
  const grids: Row[][] = [];
  let shifted = 0, glides = 0, dropped = 0;
  for (const voice of voices) {
    const rows: Row[] = Array.from({ length: totalRows0 }, () => ({ note: 0, instrument: -1 }));
    const notes = [...voice.notes].sort((a, b) => a.on.tick - b.on.tick || a.id - b.id);
    let previous = -1;
    for (const [ni, note] of notes.entries()) {
      const row = Math.min(totalRows0 - 1, Math.round(frameOf(note.on.time) / rowFrames));
      let pitch = note.pitch;
      const original = pitch;
      while (pitch < 15) pitch += 12;
      while (pitch > maxMidi) pitch -= 12;
      if (pitch !== original) shifted++;
      if (note.effects?.bend) glides++;
      if (rows[row]!.note !== 0) { dropped++; continue; }
      // A legato note that changes the pitch is a tie note: pitch and instrument change without a new envelope. A tie note at the
      // same pitch would only lengthen the note before it, so such a note keeps its own start.
      rows[row] = { note: pitch - 12, instrument: instrumentFor(note), ...(note.effects?.legato && previous >= 0 && previous !== pitch - 12 ? { tied: true } : {}) };
      previous = pitch - 12;
      const next = notes[ni + 1];
      const offRow = Math.max(row + 1, Math.round(frameOf(note.off.time) / rowFrames));
      const nextRow = next ? Math.round(frameOf(next.on.time) / rowFrames) : totalRows0;
      if (offRow < nextRow && offRow < totalRows0 && rows[offRow]!.note === 0) rows[offRow] = { note: 1, instrument: -1 };
    }
    grids.push(rows);
  }
  while (grids.length < 3) grids.push(Array.from({ length: totalRows0 }, () => ({ note: 0, instrument: -1 })));
  if (dropped) warnings.push(`${dropped} note(s) fall on a row that already holds a note and are dropped.`);
  if (shifted) losses.push(`${shifted} notes are outside the CheeseCutter range D#0 to A#7 and were moved by octaves.`);
  if (glides) losses.push(`${glides} glides and portamento notes are exported as plain notes.`);
  if (usedFilter) losses.push("Filter settings and filter tables are not exported.");
  if (usedVibrato) losses.push("Vibrato is not exported.");
  if (usedSlide) losses.push("Instrument slides are not exported.");
  if (wavetableDropped) losses.push(`${wavetableDropped} wavetable program(s) do not fit the wave table and are exported as their waveform.`);
  if (negativeOffsets) losses.push(`${negativeOffsets} instrument(s) with wavetable or arpeggio offsets below the note: a CheeseCutter wave table adds only upwards, so those steps play the note itself.`);
  if (usedPulseTable) losses.push("Pulse tables are not exported; an instrument keeps its fixed pulse width.");
  losses.push("Pulse width modulation, hard restart settings, level and chip volume changes are not exported; every instrument uses a two-call hard restart with zero ADSR.");
  losses.push("Rows are whole multiples of the row length; note starts and ends are moved to the nearest row.");

  // Sequences: identical chunks share one sequence. The chunk length grows until the order lists and the 128 sequences suffice.
  let chosen: { chunk: number; sequences: Uint8Array[]; lists: number[][] } | undefined;
  for (const chunk of [16, 32, 64]) {
    const chunks = Math.ceil(totalRows0 / chunk);
    const sequences: Uint8Array[] = [];
    const seen = new Map<string, number>();
    const lists: number[][] = [];
    let ok = chunks <= 511;
    for (const rows of grids) {
      const order: number[] = [];
      for (let k = 0; ok && k < chunks; k++) {
        // The last sequence ends with the song, so the last note keeps its length without a release row.
        const length = Math.min(chunk, totalRows0 - k * chunk);
        const raw = new Uint8Array(length * 4 + (length < 64 ? 1 : 0));
        for (let r = 0; r < length; r++) {
          const cell = rows[k * chunk + r] ?? { note: 0, instrument: -1 };
          raw[r * 4] = cell.instrument >= 0 ? 0xc0 + cell.instrument : 0xf0;
          raw[r * 4 + 1] = cell.tied ? CT.TIE_MARK : 0xf0;
          raw[r * 4 + 2] = 0x60 + cell.note;
          raw[r * 4 + 3] = 0;
        }
        if (length < 64) raw[length * 4] = CT.END_MARK;
        const key = Buffer.from(raw).toString("latin1");
        let id = seen.get(key);
        if (id === undefined) { id = sequences.length; if (id >= CT.SEQUENCES) { ok = false; break; } sequences.push(raw); seen.set(key, id); }
        order.push(id);
      }
      lists.push(order);
    }
    if (ok) { chosen = { chunk, sequences, lists }; break; }
  }
  if (!chosen) throw new InterchangeLimitError(`the score needs more than ${CT.SEQUENCES} distinct sequences or 511 order list entries, even with sequences of 64 rows; a score whose beats are not a whole number of frames long (for example 125.3114 BPM on PAL is 24 frames per beat) repeats its sequences exactly, other tempos drift against the row grid and need many more`);
  for (const [n, raw] of chosen.sequences.entries()) {
    const at = im[p[O.sequenceLow]! + n]! | (im[p[O.sequenceHigh]! + n]! << 8);
    im.set(raw, at);
  }
  const songTable = p[O.songTable]!;
  const speed = rowFrames - 1;
  for (let v = 0; v < 3; v++) {
    const list = emptyOrderList();
    const entries = chosen.lists[v]!;
    entries.forEach((seq, i) => { list[i * 2] = 0xa0; list[i * 2 + 1] = seq; });
    list[entries.length * 2] = 0xf0; list[entries.length * 2 + 1] = 0x00;
    song.orderLists[0]![v] = list;
    im.set(list, p[O.orderListVoice1 + v]!);
    im[songTable + v * 2] = p[O.orderListVoice1 + v]! & 255;
    im[songTable + v * 2 + 1] = p[O.orderListVoice1 + v]! >> 8;
  }
  im[songTable + 6] = speed; im[songTable + 7] = 7;
  im[p[O.speedTable]!] = speed;
  im[p[O.speedSettings]!] = speed;
  song.speeds[0] = speed;
  song.multiplier = multiplier;
  song.clock = score.mode === "PAL" ? 0 : 1;
  song.title = score.title.slice(0, 32);
  song.author = (score.author ?? "").slice(0, 32);
  song.release = "";
  song.message = "Exported by SIDWave";
  song.instrumentNames = names;
  const bytes = writeCheeseCutter(song);
  return {
    bytes, framesPerRow: rowFrames, multiplier, maxTimingErrorFrames: best, rows: totalRows0, sequences: chosen.sequences.length, sequenceRows: chosen.chunk,
    instruments: instMap.size, voices: voices.length, driver: kind, losses: [...new Set(losses)], warnings,
  };
}
