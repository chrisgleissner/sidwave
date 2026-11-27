// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID Factory II export (driver 11.xx): the first three voices of a score as an .sf2 song. SIDWave does not contain the driver.
// The caller supplies it as `driver`: an .sf2 file (its driver is reused and its song data cleared) or a driver PRG such as
// sf2driver11_05.prg from the SID Factory II distribution. The output embeds that driver, so the driver's licence (GPL-2.0)
// applies to the file, as for every song the editor saves.

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type EventExportOptions, type ExportedInstrument, type ExportedNote } from "./events.js";
import { InterchangeLimitError } from "./errors.js";
import { SF2, Sf2Error, cell, orderListAddress, packSequence, parseSf2, sequenceAddress, setCell, tableOf, writeSf2, type Sf2Event } from "./sf2.js";
import { driver11Tables } from "./sf2Import.js";

export interface Sf2ExportOptions extends EventExportOptions {
  /** Bytes of an .sf2 file or of a driver PRG. Required. */
  driver: Uint8Array;
}

export interface Sf2ExportResult {
  bytes: Uint8Array;
  driver: string;
  /** Video frames per row (the tempo table value is this minus one). */
  framesPerRow: number;
  maxTimingErrorFrames: number;
  rows: number;
  sequences: number;
  sequenceRows: number;
  instruments: number;
  voices: number;
  losses: string[];
  warnings: string[];
}

const WAVE_BITS: Record<string, number> = { triangle: 0x10, tri: 0x10, sawtooth: 0x20, saw: 0x20, pulse: 0x40, noise: 0x80 };
const waveByte = (inst: ExportedInstrument): number => {
  let byte = 0;
  for (const part of inst.waveform.split("+")) byte |= WAVE_BITS[part] ?? 0;
  if (byte === 0) byte = 0x40;
  if (inst.ring) byte |= 0x04;
  if (inst.sync) byte |= 0x02;
  return byte;
};

/** Exports one song of a score as a SID Factory II file. See doc/interchange.md for the mapping and losses. */
export function exportSf2(doc: ParsedSidwave, options: Sf2ExportOptions): Sf2ExportResult {
  if (!options.driver || options.driver.length === 0) throw new RangeError("a SID Factory II driver is required: pass an .sf2 file or a driver file such as sf2driver11_05.prg (--driver <file>)");
  const song = parseSf2(options.driver);
  if (song.driver.major !== 11) throw new Sf2Error(`the driver is ${song.driver.major}.${String(song.driver.minor).padStart(2, "0")}; the export supports driver 11.xx only; pass a driver 11 file such as sf2driver11_05.prg from the SID Factory II distribution`);
  const t = driver11Tables(song);
  if (!t.cmd || !t.wave || !t.pulse || !t.filter || !t.hr || !t.tempo || !t.init || !t.arp) throw new Sf2Error("the driver lacks one of the tables of driver 11 (wave, pulse, filter, HR, arpeggio, tempo, init)");
  if (song.music.tracks < 3) throw new Sf2Error("the driver has fewer than three tracks");
  const score = exportEvents(doc, options);
  const losses = [...score.losses];
  const warnings: string[] = [];
  const im = song.image;

  // A driver PRG carries the address of sequence 0 only; every sequence slot follows at the sequence size.
  for (let n = 0; n < song.music.sequenceCount; n++) {
    const at = song.music.sequence0 + n * song.music.sequenceSize;
    if (at + song.music.sequenceSize > 0xd000) throw new Sf2Error(`sequence slot ${n} at $${at.toString(16)} would not fit below $D000`);
    im[song.music.sequencePointersLow + n] = at & 255; im[song.music.sequencePointersHigh + n] = at >> 8;
  }
  // Clear the song data of the template.
  const clear = (id: number): void => { const tb = tableOf(song, id)!; im.fill(0, tb.address, tb.address + tb.columns * tb.rows); };
  for (const id of [SF2.TABLE.Commands, SF2.TABLE.Instruments, SF2.TABLE.Wave, SF2.TABLE.Pulse, SF2.TABLE.Filter, SF2.TABLE.Arp, SF2.TABLE.Tempo, SF2.TABLE.HR, SF2.TABLE.Init]) clear(id);
  for (let n = 0; n < song.music.sequenceCount; n++) { const at = sequenceAddress(song, n); im.fill(0, at, at + song.music.sequenceSize); im.set([0x80, 0x00, SF2.SEQ_END], at); }
  for (let v = 0; v < song.music.tracks; v++) { const at = orderListAddress(song, v); im.fill(0, at, at + song.music.orderListSize); im.set([0xa0, 0x00, 0xff, 0x00], at); }

  const frameRate = score.mode === "PAL" ? 985248 / 19656 : 1022727 / 17030;
  if (Math.round(score.callRate / frameRate) > 1) throw new InterchangeLimitError("the score runs the player more than once per frame; SID Factory II driver 11 updates once per frame");
  // Track n of the driver plays voice (n % 3) + 1 of SID n / 3 (multi-SID drivers have 6, 9 or 12 tracks).
  const slotOf = (v: { sid: number; channel: number }): number => v.sid * 3 + v.channel - 1;
  const voices = score.voices.filter((v) => slotOf(v) < song.music.tracks);
  if (score.voices.length > voices.length) losses.push(`Only the ${song.music.tracks} tracks of the driver are exported; the score has voices on SID ${Math.max(...score.voices.map((v) => v.sid)) + 1} and the driver has ${song.music.tracks / 3} SID${song.music.tracks === 3 ? "" : "s"}. Use a multi-SID driver such as sf2driver11_05_2sid.prg for more.`);
  if (voices.length === 0) throw new RangeError("the score has no voice on a SID the driver plays");
  const frameOf = (seconds: number): number => Math.round(seconds * frameRate);
  const frames: number[] = [];
  for (const v of voices) for (const n of v.notes) frames.push(frameOf(n.on.time), frameOf(n.off.time));
  frames.push(frameOf(score.durationSeconds));
  const errorOf = (tf: number): number => { let m = 0; for (const f of frames) m = Math.max(m, Math.abs(f - tf * Math.round(f / tf))); return m; };
  let rowFrames = 3, best = Infinity;
  for (let tf = 12; tf >= 3; tf--) { const e = errorOf(tf); if (e <= 1) { rowFrames = tf; best = e; break; } if (e < best) { best = e; rowFrames = tf; } }
  // Bar starts in frames (from the tempo map and time signatures of the score).
  const barStarts: number[] = [];
  {
    const secondsAt = (tick: number): number => { let e = score.tempoMap[0]!; for (const x of score.tempoMap) if (x.tick <= tick) e = x; return e.time + ((tick - e.tick) / score.ppq) * (60 / e.bpm); };
    let tick = 0;
    while (barStarts.length < 100_000) {
      const seconds = secondsAt(tick);
      if (seconds >= score.durationSeconds - 1e-6) break;
      barStarts.push(seconds * frameRate);
      let sig = score.timeSignatures[0] ?? { numerator: 4, denominator: 4, tick: 0 };
      for (const x of score.timeSignatures) if (x.tick <= tick) sig = x;
      tick += Math.round((score.ppq * 4 * sig.numerator) / sig.denominator);
    }
  }
  // A row length that is not a whole number of frames (a swing or an irregular tempo table: 2, 1, 2, 2 is 2.75 frames per row)
  // is written as a tempo table that repeats every d rows. It is tried when the whole-frame grid is not exact, because a passage
  // that repeats then lands on different rows each time and no longer shares sequences.
  let chain = [rowFrames];
  let starts: number[] | undefined;
  if (best > 0 && barStarts.length >= 2) {
    const barFrames = barStarts[1]! - barStarts[0]!;
    for (const rowsPerBar of [16, 8, 32, 12, 24, 4, 64, 6, 48]) {
      const f = barFrames / rowsPerBar;
      if (f < 2 || f > 13) continue;
      for (let d = 1; d <= 8; d++) {
        const m = Math.round(f * d);
        if (Math.abs(f * d - m) > 0.02 || (d > 1 && m % d === 0)) continue;
        const grid = Array.from({ length: Math.ceil(frameOf(score.durationSeconds) / (m / d)) + 2 }, (_, k) => Math.round((k * m) / d));
        let e = 0;
        for (const fr of frames) { let lo = 0, hi = grid.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (grid[mid]! < fr) lo = mid + 1; else hi = mid; } e = Math.max(e, Math.min(Math.abs(grid[lo]! - fr), lo > 0 ? Math.abs(grid[lo - 1]! - fr) : Infinity)); }
        if (e < best && e <= 1) { best = e; starts = grid; chain = Array.from({ length: d }, (_, k) => grid[k + 1]! - grid[k]!); rowFrames = m / d; }
        break;
      }
      if (starts) break;
    }
  }
  if (best > 1) warnings.push(`No row length from 3 to 12 frames fits every note start and end; ${rowFrames} frames per row leaves an error of up to ${best} frames.`);
  const rowOf = (frame: number): number => {
    if (!starts) return Math.round(frame / rowFrames);
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid]! < frame) lo = mid + 1; else hi = mid; }
    return lo > 0 && frame - starts[lo - 1]! <= starts[lo]! - frame ? lo - 1 : lo;
  };
  const totalRows = Math.max(1, starts ? rowOf(frameOf(score.durationSeconds)) + (starts[rowOf(frameOf(score.durationSeconds))]! < frameOf(score.durationSeconds) ? 1 : 0) : Math.ceil(frameOf(score.durationSeconds) / rowFrames));

  // Tempo and init tables: song 1 starts at tempo row 0 with full volume.
  if (chain.length + 1 > t.tempo!.rows) throw new InterchangeLimitError("the tempo table of the driver is too small for the row length of the score");
  chain.forEach((c, k) => setCell(song, t.tempo!, k, 0, c - 1)); setCell(song, t.tempo!, chain.length, 0, 0x7f);
  setCell(song, t.init, 0, 0, 0); setCell(song, t.init, 0, 1, 0x0f);
  // Hard restart row 0: zero ADSR, like the SIDWave default.
  setCell(song, t.hr, 0, 0, 0); setCell(song, t.hr, 0, 1, 0);

  // Instruments. Notes that differ only in effects (arpeggio, vibrato, local ADSR) share one driver instrument; the effects are
  // written as per-note commands, the way the driver expresses them. The importer expands every effect variant of an
  // instrument into an instrument of its own, so a score read from a song can hold many more instruments than the driver.
  const exported = new Map(score.instruments.map((i) => [i.index, i]));
  const allNotes = voices.flatMap((v) => v.notes);
  const baseKey = (inst: ExportedInstrument | undefined, withAdsr: boolean): string => inst ? `${waveByte(inst)}:${inst.pulseWidth ?? ""}:${withAdsr ? inst.adsr.join(",") : ""}` : "none";
  let withAdsr = true;
  if (new Set(allNotes.map((n) => baseKey(exported.get(n.instrument), true))).size > t.instr!.rows) withAdsr = false;
  const adsrCount = new Map<string, number>();
  for (const n of allNotes) { const inst = exported.get(n.instrument); if (inst) { const k = `${baseKey(inst, false)}|${inst.adsr.join(",")}`; adsrCount.set(k, (adsrCount.get(k) ?? 0) + 1); } }
  const baseAdsr = new Map<string, [number, number, number, number]>();
  for (const n of allNotes) { const inst = exported.get(n.instrument); if (!inst) continue; const bk = baseKey(inst, false); const cur = baseAdsr.get(bk); if (!cur || (adsrCount.get(`${bk}|${inst.adsr.join(",")}`) ?? 0) > (adsrCount.get(`${bk}|${cur.join(",")}`) ?? 0)) baseAdsr.set(bk, inst.adsr); }
  const instMap = new Map<string, number>();
  let wlen = 0, plen = 0, commandRows = 0, arpLength = 0, commandsDropped = 0;
  let usedFilter = false, usedSlide = false, usedWavetable = false, usedPulseTable = false;
  const instrumentFor = (note: ExportedNote): number => {
    const inst = exported.get(note.instrument);
    const key = baseKey(inst, withAdsr);
    let id = instMap.get(key);
    if (id !== undefined) return id;
    id = instMap.size;
    if (id >= t.instr!.rows) throw new InterchangeLimitError(`the score uses more than ${t.instr!.rows} instruments`);
    instMap.set(key, id);
    const wave = inst ? waveByte(inst) : 0x40;
    const adsr = inst ? (withAdsr ? inst.adsr : baseAdsr.get(baseKey(inst, false)) ?? inst.adsr) : undefined;
    const ad = adsr ? (adsr[0] << 4) | adsr[1] : 0x09;
    const sr = adsr ? (adsr[2] << 4) | adsr[3] : 0xa4;
    // Wave program: one row that holds the waveform; an arpeggio command replaces the semitone value of a row whose value is 0.
    if (wlen + 2 > t.wave!.rows) throw new InterchangeLimitError(`the wave tables of the instruments do not fit the ${t.wave!.rows} rows of the driver's wave table`);
    const start = wlen;
    setCell(song, t.wave!, wlen, 0, wave | 1); setCell(song, t.wave!, wlen, 1, 0); wlen++;
    setCell(song, t.wave!, wlen, 0, 0x7f); setCell(song, t.wave!, wlen, 1, wlen - 1); wlen++;
    let pulseRow = 0;
    if (inst?.pulseWidth !== undefined && (wave & 0x40)) {
      const pw = Math.max(1, Math.min(4095, inst.pulseWidth));
      if (plen + 2 > t.pulse!.rows) throw new InterchangeLimitError(`the pulse tables of the instruments do not fit the ${t.pulse!.rows} rows of the driver's pulse table`);
      pulseRow = plen;
      setCell(song, t.pulse!, plen, 0, 0x80 | (pw >> 8)); setCell(song, t.pulse!, plen, 1, pw & 0xff); setCell(song, t.pulse!, plen, 2, 1); plen++;
      setCell(song, t.pulse!, plen, 0, 0x7f); setCell(song, t.pulse!, plen, 1, 0); setCell(song, t.pulse!, plen, 2, plen); plen++;
    }
    const ti = t.instr!;
    setCell(song, ti, id, 0, ad); setCell(song, ti, id, 1, sr); setCell(song, ti, id, 2, 0x80); setCell(song, ti, id, 3, 0); setCell(song, ti, id, 4, pulseRow); setCell(song, ti, id, 5, start);
    if (inst?.tables.filter || inst?.filterRouted) usedFilter = true;
    if (inst?.slide) usedSlide = true;
    if (inst?.tables.wave) usedWavetable = true;
    if (inst?.tables.pulse) usedPulseTable = true;
    return id;
  };
  // Commands: a row of the command table per distinct (type, XX, YY); arpeggios also take rows of the arpeggio table.
  const commandIds = new Map<string, number>();
  const arpStarts = new Map<string, number>();
  const commandFor = (type: number, xx: number, yy: number): number | undefined => {
    const key = `${type}:${xx}:${yy}`;
    let id = commandIds.get(key);
    if (id !== undefined) return id;
    if (commandRows >= t.cmd!.rows) return undefined;
    id = commandRows++;
    commandIds.set(key, id);
    setCell(song, t.cmd!, id, 0, type); setCell(song, t.cmd!, id, 1, xx); setCell(song, t.cmd!, id, 2, yy);
    return id;
  };
  const arpCommand = (arp: { offsets: number[]; callsPerStep: number } | undefined): number | undefined => {
    const offsets = arp ? arp.offsets.map((o) => Math.max(0, Math.min(0x6f, o))) : [0];
    const calls = arp ? Math.max(1, Math.min(256, arp.callsPerStep)) : 1;
    const key = offsets.join(",");
    let start = arpStarts.get(key);
    if (start === undefined) {
      if (arpLength + offsets.length + 1 > t.arp!.rows) return undefined;
      start = arpLength;
      for (const o of offsets) setCell(song, t.arp!, arpLength++, 0, o);
      setCell(song, t.arp!, arpLength++, 0, 0x70);
      arpStarts.set(key, start);
    }
    return commandFor(3, calls - 1, start);
  };
  const fps = score.mode === "PAL" ? 985248 / 19656 : 1022727 / 17030;
  const vibratoCommand = (v: { depthSemitones: number; rateHz: number } | undefined): number | undefined => {
    if (!v) return commandFor(1, 0, 0);
    const xx = Math.max(1, Math.min(255, Math.round(fps / (2 * v.rateHz))));
    const yy = Math.max(0, Math.min(255, Math.round(8 / (2 * Math.max(0.03, v.depthSemitones)) - 1)));
    return commandFor(1, xx, yy);
  };

  // Rows per voice: note 0 releases, 1..0x6F is a note, 0x7E holds.
  const maxMidi = 12 + 0x6f;
  interface Row { note: number; instrument: number; command?: number }
  let grids: Row[][] = [];
  let shifted = 0, glides = 0, dropped = 0;
  let chosen: { chunk: number; sequences: Uint8Array[]; lists: number[][] } | undefined;
  let effects = true;
  // The effect commands of a note depend on the state the track is in, so a repeated passage can differ between its repeats and need more
  // sequences than the driver holds (128). The second attempt leaves the effect commands out.
  for (effects of [true, false]) {
  grids = Array.from({ length: song.music.tracks });
  shifted = 0; glides = 0; dropped = 0; commandsDropped = 0;
  if (!effects) {
    // Local ADSR variants are separate instruments of the score and break the repeats: fold them into the most used ADSR of their instrument.
    withAdsr = false; instMap.clear(); wlen = 0; plen = 0;
    for (const id of [SF2.TABLE.Instruments, SF2.TABLE.Wave, SF2.TABLE.Pulse]) { const tb = tableOf(song, id)!; im.fill(0, tb.address, tb.address + tb.columns * tb.rows); }
  }
  for (const voice of voices) {
    const rows: Row[] = Array.from({ length: totalRows }, () => ({ note: 0x7f, instrument: -1 }));
    const state = { arp: "", vib: "" };
    const notes = [...voice.notes].sort((a, b) => a.on.tick - b.on.tick || a.id - b.id);
    for (const [ni, note] of notes.entries()) {
      const row = Math.min(totalRows - 1, rowOf(frameOf(note.on.time)));
      let pitch = note.pitch;
      const original = pitch;
      while (pitch < 13) pitch += 12;
      while (pitch > maxMidi) pitch -= 12;
      if (pitch !== original) shifted++;
      if (note.effects?.bend) glides++;
      if (rows[row]!.note !== 0x7f) { dropped++; continue; }
      const inst = exported.get(note.instrument);
      const instrument = instrumentFor(note);
      // Effects that are not the track's current state become one command on the note (arpeggio and vibrato stay until changed; a local ADSR lasts for the note).
      const arp = inst?.arpeggio && inst.arpeggio.offsets.length > 1 ? inst.arpeggio : undefined;
      const arpKey = arp ? `${arp.offsets.join(",")}/${arp.callsPerStep}` : "";
      const vibKey = inst?.vibrato ? `${inst.vibrato.depthSemitones}/${inst.vibrato.rateHz}` : "";
      const baseAd = withAdsr ? undefined : baseAdsr.get(baseKey(inst, false));
      const localAdsr = inst && baseAd && inst.adsr.join(",") !== baseAd.join(",") ? inst.adsr : undefined;
      // A row holds one command. Wanted changes are tried in order; the first that fits is written and the state follows it,
      // so a change that does not fit is retried on the next note instead of being assumed.
      let command: number | undefined;
      const tryCommand = (wanted: boolean, make: () => number | undefined, commit: () => void): void => {
        if (!wanted) return;
        if (command !== undefined) { commandsDropped++; return; }
        const id = make();
        if (id === undefined) { commandsDropped++; return; }
        command = id; commit();
      };
      if (effects) {
      tryCommand(arpKey !== state.arp, () => arpCommand(arp), () => { state.arp = arpKey; });
      tryCommand(vibKey !== state.vib, () => vibratoCommand(inst?.vibrato), () => { state.vib = vibKey; });
      tryCommand(localAdsr !== undefined, () => commandFor(8, (localAdsr![0] << 4) | localAdsr![1], (localAdsr![2] << 4) | localAdsr![3]), () => undefined);
      }
      rows[row] = { note: pitch - 12, instrument, ...(command === undefined ? {} : { command }) };
      const next = notes[ni + 1];
      const offRow = Math.max(row + 1, rowOf(frameOf(note.off.time)));
      const nextRow = next ? rowOf(frameOf(next.on.time)) : totalRows;
      if (offRow < nextRow && offRow < totalRows && rows[offRow]!.note === 0x7f) rows[offRow] = { note: 0, instrument: -1 };
    }
    grids[slotOf(voice)] = rows;
  }
  for (let slot = 0; slot < grids.length; slot++) grids[slot] ??= Array.from({ length: totalRows }, () => ({ note: 0x7f, instrument: -1 }));
  // 0x7f marks "nothing here": a hold of the previous note (0x7E) or silence (0) depending on what precedes it.
  for (const rows of grids) {
    let sounding = false;
    for (const r of rows) {
      if (r.note === 0x7f) r.note = sounding ? 0x7e : 0;
      else sounding = r.note !== 0;
    }
  }
  if (dropped) warnings.push(`${dropped} note(s) fall on a row that already holds a note and are dropped.`);
  if (shifted) losses.push(`${shifted} notes are outside the SID Factory II range C#0 to B7 and were moved by octaves.`);
  if (glides) losses.push(`${glides} glides and portamento notes are exported as plain notes.`);
  if (usedFilter) losses.push("Filter settings and filter tables are not exported.");
  if (!effects) losses.push("Arpeggio, vibrato and local ADSR commands are not exported: with them the score needs more sequences than the driver holds.");
  if (commandsDropped) losses.push(`${commandsDropped} effect command(s) (arpeggio, vibrato or local ADSR) were dropped: a row holds one command or the command table is full.`);
  if (usedSlide) losses.push("Instrument slides are not exported.");
  if (usedWavetable) losses.push("Wavetable steps of an instrument are not exported (the instrument plays its waveform; arpeggios are kept).");
  if (usedPulseTable) losses.push("Pulse tables are not exported; an instrument keeps its fixed pulse width.");
  losses.push("Pulse width modulation, hard restart settings, level and chip volume changes and the title and author are not exported; every instrument uses the hard restart of table row 0 with zero ADSR.");
  losses.push("Rows are whole multiples of the row length; note starts and ends are moved to the nearest row.");

  // Sequences: identical chunks share one sequence; the chunk length grows until the order lists and the sequence slots suffice.
  chosen = undefined;
  /** Packs the tracks cut at `cuts` (row indices per track, ascending, starting at 0): identical segments share a sequence. */
  const pack = (cuts: number[][], longest: number): typeof chosen => {
    const sequences: Uint8Array[] = [];
    const seen = new Map<string, number>();
    const lists: number[][] = [];
    for (const [v, rows] of grids.entries()) {
      const order: number[] = [];
      const c = cuts[v]!;
      if (c.length > song.music.orderListSize - 3) return undefined;
      for (let k = 0; k < c.length; k++) {
        const from = c[k]!, to = c[k + 1] ?? totalRows;
        const events: Sf2Event[] = [];
        for (let r = from; r < to; r++) { const x = rows[r] ?? { note: 0, instrument: -1 }; events.push({ instrument: x.instrument >= 0 ? x.instrument : 0x80, command: x.command ?? 0x80, note: x.note, tied: false }); }
        const packed = packSequence(events);
        if (packed.length > song.music.sequenceSize) return undefined;
        const id0 = Buffer.from(packed).toString("latin1");
        let id = seen.get(id0);
        if (id === undefined) { id = sequences.length; if (id >= song.music.sequenceCount) return undefined; sequences.push(packed); seen.set(id0, id); }
        order.push(id);
      }
      lists.push(order);
    }
    return { chunk: longest, sequences, lists };
  };
  const uniform = (chunk: number): number[][] => grids.map(() => Array.from({ length: Math.ceil(totalRows / chunk) }, (_, k) => k * chunk));
  // 16, 32 and 64 rows first.
  for (const chunk of [16, 32, 64]) { chosen = pack(uniform(chunk), chunk); if (chosen) break; }
  if (!chosen) {
    // Repeated passages rarely start at multiples of a fixed length: the song's own sequences are whole bars (a bar of 16 ticks at
    // 2.75 frames per tick is 14.67 rows, so a bar does not take a power of two rows). Cut at every k-th bar start instead.
    for (const bars of [1, 2, 4, 8]) {
      const at = [...new Set(barStarts.filter((_, i) => i % bars === 0).map((f) => rowOf(Math.round(f))).filter((r) => r < totalRows))].sort((x, y) => x - y);
      if (at[0] !== 0) at.unshift(0);
      const longest = Math.max(...at.map((x, i) => (at[i + 1] ?? totalRows) - x));
      chosen = pack(grids.map(() => at), longest);
      if (chosen) break;
    }
  }
  if (chosen) break;
  }
  if (!chosen) throw new InterchangeLimitError(`the score needs more than ${song.music.sequenceCount} distinct sequences or more order list entries than the driver holds; a score whose beats are a whole number of frames long (125.3114 BPM on PAL is 24 frames per beat) repeats its sequences exactly, other tempos drift against the row grid and need many more`);
  let end = song.end;
  for (const [n, packed] of chosen.sequences.entries()) { const at = sequenceAddress(song, n); im.set(packed, at); end = Math.max(end, at + packed.length); }
  for (let v = 0; v < song.music.tracks; v++) {
    const at = orderListAddress(song, v);
    const bytes = [0xa0, ...chosen.lists[v]!, 0xff, 0x00];
    im.set(bytes, at);
    end = Math.max(end, at + bytes.length);
  }
  // The editor's own data (comments, preferences) is not written: clear the pointer so the editor does not read stale data.
  if (song.loadAddress <= 0x0ffb && end > 0x0ffc) { im[0x0ffb] = 0; im[0x0ffc] = 0; }
  song.end = end;
  return {
    bytes: writeSf2(song), driver: `${song.driver.major}.${String(song.driver.minor).padStart(2, "0")}.${String(song.driver.revision).padStart(2, "0")}`, framesPerRow: rowFrames, maxTimingErrorFrames: best, rows: totalRows, sequences: chosen.sequences.length,
    sequenceRows: chosen.chunk, instruments: instMap.size, voices: voices.length, losses: [...new Set(losses)], warnings,
  };
}
void cell;

