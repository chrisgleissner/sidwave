// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// GoatTracker song files (.sng): a parser for GoatTracker 1.x (GTS!), 2.0 beta (GTS2) and 2.x (GTS3, GTS4, GTS5) and a
// writer for GTS5. The loaders follow src/gsong.c of GoatTracker 2.77 (GPL-2.0-or-later; the data layout and the
// conversion rules are the facts used here, no source is copied); older formats are converted to the GTS5 model on load,
// as GoatTracker does.

import { InterchangeInputError } from "./errors.js";

export class GoatTrackerError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "GoatTrackerError"; }
}

export const GT = {
  CMD_DONOTHING: 0, CMD_PORTAUP: 1, CMD_PORTADOWN: 2, CMD_TONEPORTA: 3, CMD_VIBRATO: 4, CMD_SETAD: 5, CMD_SETSR: 6, CMD_SETWAVE: 7,
  CMD_SETWAVEPTR: 8, CMD_SETPULSEPTR: 9, CMD_SETFILTERPTR: 10, CMD_SETFILTERCTRL: 11, CMD_SETFILTERCUTOFF: 12, CMD_SETMASTERVOL: 13,
  CMD_FUNKTEMPO: 14, CMD_SETTEMPO: 15,
  WTBL: 0, PTBL: 1, FTBL: 2, STBL: 3,
  MAX_INSTR: 64, MAX_CHN: 3, MAX_PATT: 208, MAX_TABLELEN: 255, MAX_INSTRNAMELEN: 16, MAX_PATTROWS: 128, MAX_SONGLEN: 254, MAX_SONGS: 32,
  REPEAT: 0xd0, TRANSDOWN: 0xe0, TRANSUP: 0xf0, LOOPSONG: 0xff,
  ENDPATT: 0xff, FIRSTNOTE: 0x60, LASTNOTE: 0xbc, REST: 0xbd, KEYOFF: 0xbe, KEYON: 0xbf, OLDKEYOFF: 0x5e, OLDREST: 0x5f,
} as const;

/** Largest song file read: the largest GTS5 file GoatTracker can write is about 125 KB. */
export const MAX_SNG_BYTES = 256 * 1024;
const MST_NOFINEVIB = 0, MST_FINEVIB = 1, MST_FUNKTEMPO = 2, MST_PORTAMENTO = 3;
/** GoatTracker's default `finevibrato` setting (-V option); used to convert GTS2 vibrato parameters. */
const FINEVIBRATO = MST_FINEVIB;

export interface GtInstrument { ad: number; sr: number; ptr: [number, number, number, number]; vibdelay: number; gatetimer: number; firstwave: number; name: string }
export interface GtSong {
  /** Magic of the file: GTS!, GTS2, GTS3, GTS4 or GTS5. */
  magic: string;
  family: "GoatTracker 1.x" | "GoatTracker 2.0 beta" | "GoatTracker 2.x";
  name: string; author: string; copyright: string;
  /** Per subsong, three order lists as stored: entries, LOOPSONG (0xff) and the loop position. */
  songs: Uint8Array[][];
  /** Instruments 1..63 (index 0 is unused). */
  instruments: GtInstrument[];
  /** Left and right columns of the wave, pulse, filter and speed tables (255 entries each). */
  ltable: Uint8Array[];
  rtable: Uint8Array[];
  /** Patterns as 4-byte rows (note, instrument, command, data); a row with note 0xff ends the pattern. */
  patterns: Uint8Array[];
  /** What the loader converted (empty for GTS3-GTS5). */
  conversions: string[];
}

const emptyInstrument = (): GtInstrument => ({ ad: 0, sr: 0, ptr: [0, 0, 0, 0], vibdelay: 0, gatetimer: 0, firstwave: 0, name: "" });
const text = (bytes: Uint8Array): string => {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return Array.from(bytes.subarray(0, end), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b >= 160 ? String.fromCharCode(b) : "?")).join("").trimEnd();
};

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.b.length) throw new GoatTrackerError(`the file is truncated (offset ${this.pos})`);
    return this.b[this.pos++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new GoatTrackerError(`the file is truncated (offset ${this.pos}, ${n} bytes needed)`);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Speed table with GoatTracker's makespeedtable(): reuse an equal entry or take the first free slot. */
function makeSpeed(l: Uint8Array, r: Uint8Array, data: number, mode: number): number {
  if (!data) return -1;
  let lv = 0, rv = 0;
  switch (mode) {
    case MST_NOFINEVIB: lv = (data & 0xf0) >> 4; rv = (data & 0x0f) << 4; break;
    case MST_FINEVIB: lv = (data & 0x70) >> 4; rv = ((data & 0x0f) << 4) | ((data & 0x80) >> 4); break;
    case MST_FUNKTEMPO: lv = (data & 0xf0) >> 4; rv = data & 0x0f; break;
    case MST_PORTAMENTO: lv = (data << 2) >> 8; rv = (data << 2) & 0xff; break;
  }
  lv &= 0xff; rv &= 0xff;
  for (let c = 0; c < GT.MAX_TABLELEN; c++) if (l[c] === lv && r[c] === rv) return c;
  for (let c = 0; c < GT.MAX_TABLELEN; c++) if (!l[c] && !r[c]) { l[c] = lv; r[c] = rv; return c; }
  return -1;
}

function readOrderLists(r: Reader, songs: Uint8Array[][]): void {
  const amount = r.u8();
  if (amount > GT.MAX_SONGS) throw new GoatTrackerError(`the file has ${amount} songs; the limit is ${GT.MAX_SONGS}`);
  for (let d = 0; d < amount; d++) {
    const lists: Uint8Array[] = [];
    for (let c = 0; c < GT.MAX_CHN; c++) {
      const length = r.u8();
      lists.push(Uint8Array.from(r.bytes(length + 1)));
    }
    songs.push(lists);
  }
}

/** Parses a GoatTracker song file. */
export function parseGoatTracker(input: Uint8Array): GtSong {
  if (input.length > MAX_SNG_BYTES) throw new GoatTrackerError(`the file has ${input.length} bytes; the limit is ${MAX_SNG_BYTES}`);
  if (input.length < 4) throw new GoatTrackerError("the file is too short to be a GoatTracker song");
  const magic = String.fromCharCode(input[0]!, input[1]!, input[2]!, input[3]!);
  const known = ["GTS!", "GTS2", "GTS3", "GTS4", "GTS5"];
  if (!known.includes(magic)) throw new GoatTrackerError(`not a GoatTracker song (magic "${magic.replace(/[^ -~]/g, "?")}"; expected GTS!, GTS2, GTS3, GTS4 or GTS5)`);
  const r = new Reader(input);
  r.pos = 4;
  const song: GtSong = {
    magic, family: magic === "GTS!" ? "GoatTracker 1.x" : magic === "GTS2" ? "GoatTracker 2.0 beta" : "GoatTracker 2.x",
    name: "", author: "", copyright: "", songs: [], instruments: Array.from({ length: GT.MAX_INSTR }, emptyInstrument),
    ltable: Array.from({ length: 4 }, () => new Uint8Array(GT.MAX_TABLELEN)), rtable: Array.from({ length: 4 }, () => new Uint8Array(GT.MAX_TABLELEN)),
    patterns: [], conversions: [],
  };
  song.name = text(r.bytes(32)); song.author = text(r.bytes(32)); song.copyright = text(r.bytes(32));
  readOrderLists(r, song.songs);
  const readPatterns4 = (convert?: (rows: Uint8Array) => void): void => {
    const amount = r.u8();
    if (amount > GT.MAX_PATT) throw new GoatTrackerError(`the file has ${amount} patterns; the limit is ${GT.MAX_PATT}`);
    for (let c = 0; c < amount; c++) {
      const length = r.u8();
      if (length > GT.MAX_PATTROWS + 1) throw new GoatTrackerError(`pattern ${c} has ${length} rows; the limit is ${GT.MAX_PATTROWS + 1}`);
      const rows = Uint8Array.from(r.bytes(length * 4));
      convert?.(rows);
      song.patterns.push(rows);
    }
  };
  const nameOf = (b: Uint8Array): string => text(b);

  if (magic === "GTS3" || magic === "GTS4" || magic === "GTS5") {
    const amount = r.u8();
    if (amount > GT.MAX_INSTR - 1) throw new GoatTrackerError(`the file has ${amount} instruments; the limit is ${GT.MAX_INSTR - 1}`);
    for (let c = 1; c <= amount; c++) {
      const i = song.instruments[c]!;
      i.ad = r.u8(); i.sr = r.u8(); i.ptr = [r.u8(), r.u8(), r.u8(), r.u8()]; i.vibdelay = r.u8(); i.gatetimer = r.u8(); i.firstwave = r.u8();
      i.name = nameOf(r.bytes(GT.MAX_INSTRNAMELEN));
    }
    for (let c = 0; c < 4; c++) {
      const size = r.u8();
      song.ltable[c]!.set(r.bytes(size)); song.rtable[c]!.set(r.bytes(size));
    }
    readPatterns4();
  } else if (magic === "GTS2") {
    const amount = r.u8();
    if (amount > GT.MAX_INSTR - 1) throw new GoatTrackerError(`the file has ${amount} instruments; the limit is ${GT.MAX_INSTR - 1}`);
    const lt = song.ltable[GT.STBL]!, rt = song.rtable[GT.STBL]!;
    for (let c = 1; c <= amount; c++) {
      const i = song.instruments[c]!;
      i.ad = r.u8(); i.sr = r.u8(); i.ptr[GT.WTBL] = r.u8(); i.ptr[GT.PTBL] = r.u8(); i.ptr[GT.FTBL] = r.u8(); i.vibdelay = r.u8();
      i.ptr[GT.STBL] = makeSpeed(lt, rt, r.u8(), FINEVIBRATO) + 1;
      i.gatetimer = r.u8(); i.firstwave = r.u8();
      i.name = nameOf(r.bytes(GT.MAX_INSTRNAMELEN));
    }
    for (let c = 0; c < 3; c++) {
      const size = r.u8();
      song.ltable[c]!.set(r.bytes(size)); song.rtable[c]!.set(r.bytes(size));
    }
    readPatterns4((rows) => {
      for (let d = 0; d < rows.length / 4; d++) {
        const cmd = rows[d * 4 + 2]!;
        const data = rows[d * 4 + 3]!;
        if (cmd === GT.CMD_FUNKTEMPO) rows[d * 4 + 3] = makeSpeed(lt, rt, data, MST_FUNKTEMPO) + 1;
        else if (cmd === GT.CMD_PORTAUP || cmd === GT.CMD_PORTADOWN || cmd === GT.CMD_TONEPORTA) rows[d * 4 + 3] = makeSpeed(lt, rt, data, MST_PORTAMENTO) + 1;
        else if (cmd === GT.CMD_VIBRATO) rows[d * 4 + 3] = makeSpeed(lt, rt, data, FINEVIBRATO) + 1;
      }
    });
    song.conversions.push("GTS2: instrument vibrato and the portamento, vibrato and funk tempo parameters were moved into the speed table.");
  } else {
    convertGt1(r, song);
  }
  // Conversions GoatTracker applies after loading.
  const version = magic === "GTS!" ? 0 : magic.charCodeAt(3) - 48;
  if (magic === "GTS!" || version < 4) {
    for (let c = 0; c < GT.MAX_TABLELEN; c++) {
      if (song.ltable[GT.PTBL]![c]! < 0x80 && song.rtable[GT.PTBL]![c]) {
        let speed = (song.rtable[GT.PTBL]![c]! << 24) >> 24;
        speed <<= 1;
        if (speed > 127) speed = 127;
        if (speed < -128) speed = -128;
        song.rtable[GT.PTBL]![c] = speed & 0xff;
      }
    }
    song.conversions.push("Pulse modulation speeds of files before GTS4 were doubled (as GoatTracker does on load).");
  }
  if (magic !== "GTS5") {
    for (let c = 1; c < GT.MAX_INSTR; c++) {
      const i = song.instruments[c]!;
      if (i.firstwave >= 0x80) { i.gatetimer |= 0x80; i.firstwave &= 0x7f; }
      if (!i.firstwave) i.gatetimer |= 0x40;
    }
    song.conversions.push("Legato and no-hard-restart flags of files before GTS5 were derived from the first waveform (as GoatTracker does on load).");
  }
  return song;
}

/** GoatTracker 1.x (GTS!): conversion to the GTS5 model, following loadsong() of GoatTracker 2.77. */
function convertGt1(r: Reader, song: GtSong): void {
  const { instruments, ltable, rtable } = song;
  const fwT = ltable[GT.WTBL]!, fwR = rtable[GT.WTBL]!, fpL = ltable[GT.PTBL]!, fpR = rtable[GT.PTBL]!, ffL = ltable[GT.FTBL]!, ffR = rtable[GT.FTBL]!;
  let fw = 0, fp = 0, ff = 0, numfilter = 0;
  const pulse = new Uint8Array(32), pulseadd = new Uint8Array(32), limlow = new Uint8Array(32), limhigh = new Uint8Array(32);
  for (let c = 1; c < 32; c++) {
    const i = instruments[c]!;
    i.ad = r.u8(); i.sr = r.u8();
    pulse[c] = r.u8(); pulseadd[c] = r.u8(); limlow[c] = r.u8(); limhigh[c] = r.u8();
    i.ptr[GT.FTBL] = r.u8();
    if (i.ptr[GT.FTBL] > numfilter) numfilter = i.ptr[GT.FTBL];
    if (pulse[c]! & 1) i.gatetimer |= 0x80;
    pulse[c] = pulse[c]! & 0xfe;
    const wavelen = r.u8() >> 1;
    i.name = text(r.bytes(GT.MAX_INSTRNAMELEN));
    i.ptr[GT.WTBL] = fw + 1;
    for (let d = 0; d < wavelen; d++) {
      const left = r.u8(), right = r.u8();
      if (fw < GT.MAX_TABLELEN) {
        let l = left, rr = right;
        if (l === 0xff && rr) rr = (rr + i.ptr[GT.WTBL] - 1) & 0xff;
        if (l >= 0x8 && l <= 0xf) l |= 0xe0;
        fwT[fw] = l; fwR[fw] = rr; fw++;
      }
    }
    if (wavelen === 2 && !fwT[fw - 2] && !fwR[fw - 2]) {
      i.ptr[GT.WTBL] = 0;
      fw -= 2;
      fwT[fw] = 0; fwR[fw] = 0; fwT[fw + 1] = 0; fwR[fw + 1] = 0;
    }
    if (pulse[c]) {
      let dup = false;
      for (let d = 1; d < c; d++) {
        if (pulse[d] === pulse[c] && pulseadd[d] === pulseadd[c] && limlow[d] === limlow[c] && limhigh[d] === limhigh[c]) { i.ptr[GT.PTBL] = instruments[d]!.ptr[GT.PTBL]; dup = true; break; }
      }
      if (dup || fp >= GT.MAX_TABLELEN) continue;
      i.ptr[GT.PTBL] = fp + 1;
      fpL[fp] = 0x80 | (pulse[c]! >> 4);
      fpR[fp] = (pulse[c]! << 4) & 0xff;
      fp++;
      const add = pulseadd[c]!;
      const emit = (time: number, speed: number): boolean => {
        while (time) {
          const act = Math.min(time, 127);
          if (fp >= GT.MAX_TABLELEN) return false;
          fpL[fp] = act; fpR[fp] = speed & 0xff; fp++;
          time -= act;
        }
        return true;
      };
      const push = (l: number, rr: number): boolean => { if (fp >= GT.MAX_TABLELEN) return false; fpL[fp] = l; fpR[fp] = rr & 0xff; fp++; return true; };
      if (add) {
        const start = pulse[c]! * 16;
        let current = pulse[c]! * 16;
        let ok = true;
        let dist = limhigh[c]! * 16 - current;
        if (dist > 0) { const time = Math.trunc(dist / add); current += time * add; ok = emit(time, add >> 1); }
        const hl = fp;
        dist = current - limlow[c]! * 16;
        if (ok && dist > 0) { const time = Math.trunc(dist / add); current -= time * add; ok = emit(time, -(add >> 1)); }
        if (ok) {
          if (start < limhigh[c]! * 16 && start > current) {
            dist = start - current;
            if (dist > 0) ok = emit(Math.trunc(dist / add), add >> 1);
            if (ok) push(0xff, i.ptr[GT.PTBL] + 1);
          } else {
            dist = limhigh[c]! * 16 - current;
            if (dist > 0) ok = emit(Math.trunc(dist / add), add >> 1);
            if (ok) push(0xff, hl + 1);
          }
        }
      } else push(0xff, 0);
    }
  }
  // Patterns.
  const amount = r.u8();
  if (amount > GT.MAX_PATT) throw new GoatTrackerError(`the file has ${amount} patterns; the limit is ${GT.MAX_PATT}`);
  for (let c = 0; c < amount; c++) {
    const length = r.u8();
    const rows = new Uint8Array(Math.max(1, Math.floor(length / 3)) * 4);
    for (let d = 0; d < Math.floor(length / 3); d++) {
      let note = r.u8();
      let cmd = r.u8();
      let data = r.u8();
      const instr = cmd >> 3;
      cmd &= 7;
      if (note === GT.OLDKEYOFF) note = GT.KEYOFF;
      else if (note === GT.OLDREST) note = GT.REST;
      else if (note !== GT.ENDPATT) { note += GT.FIRSTNOTE; if (note > GT.LASTNOTE) note = GT.REST; }
      if (cmd === 5) { cmd = GT.CMD_SETFILTERPTR; if (data > numfilter) numfilter = data; }
      else if (cmd === 7) {
        if (data < 0xf0) cmd = GT.CMD_SETTEMPO; else { cmd = GT.CMD_SETMASTERVOL; data &= 0x0f; }
      }
      rows[d * 4] = note; rows[d * 4 + 1] = instr; rows[d * 4 + 2] = cmd; rows[d * 4 + 3] = data;
    }
    song.patterns.push(rows);
  }
  let highest = 0;
  for (const rows of song.patterns) for (let d = 0; d < rows.length / 4; d++) { if (rows[d * 4] === GT.ENDPATT) break; highest = Math.max(highest, rows[d * 4 + 1]!); }
  let fi = highest + 1;
  // Filter table.
  const filtertable = Uint8Array.from(r.bytes(256));
  const filterjump = new Array<number>(64).fill(-1);
  const filtermap = new Array<number>(64).fill(0);
  for (let c = 0; c < 64; c++) if (filtertable[c * 4 + 3]! > numfilter) numfilter = filtertable[c * 4 + 3]!;
  if (numfilter > 63) numfilter = 63;
  for (let c = 1; c <= numfilter; c++) {
    filtermap[c] = ff + 1;
    if (filtertable[c * 4]! | filtertable[c * 4 + 1]! | filtertable[c * 4 + 2]! | filtertable[c * 4 + 3]!) {
      if (filtertable[c * 4]) {
        ffL[ff] = 0x80 + (filtertable[c * 4 + 1]! & 0x70); ffR[ff] = filtertable[c * 4]!; ff++;
        if (filtertable[c * 4 + 2]) { ffL[ff] = 0; ffR[ff] = filtertable[c * 4 + 2]!; ff++; }
      } else {
        let time = filtertable[c * 4 + 1]!;
        while (time) {
          const act = Math.min(time, 127);
          ffL[ff] = act; ffR[ff] = filtertable[c * 4 + 2]!; ff++;
          time -= act;
        }
      }
      if (filtertable[c * 4 + 3] !== c + 1) { filterjump[c] = ff; ffL[ff] = 0xff; ffR[ff] = filtertable[c * 4 + 3]!; ff++; }
    }
  }
  for (let c = 1; c <= numfilter; c++) if (filterjump[c] !== -1) ffR[filterjump[c]!] = filtermap[ffR[filterjump[c]!]!] ?? 0;
  for (let c = 1; c < 32; c++) instruments[c]!.ptr[GT.FTBL] = filtermap[instruments[c]!.ptr[GT.FTBL]] ?? 0;
  // Pattern commands.
  const sl = ltable[GT.STBL]!, sr = rtable[GT.STBL]!;
  const arpmap = new Map<string, number>();
  for (const rows of song.patterns) {
    let i = 0;
    for (let d = 0; d < rows.length / 4; d++) {
      if (rows[d * 4 + 1]) i = rows[d * 4 + 1]!;
      const cmd = rows[d * 4 + 2]!;
      if (cmd === GT.CMD_PORTAUP || cmd === GT.CMD_PORTADOWN || cmd === GT.CMD_TONEPORTA) rows[d * 4 + 3] = makeSpeed(sl, sr, rows[d * 4 + 3]!, MST_PORTAMENTO) + 1;
      if (cmd === GT.CMD_VIBRATO) rows[d * 4 + 3] = makeSpeed(sl, sr, rows[d * 4 + 3]!, MST_NOFINEVIB) + 1;
      if (cmd === GT.CMD_SETFILTERPTR) rows[d * 4 + 3] = filtermap[rows[d * 4 + 3]!] ?? 0;
      if (cmd === GT.CMD_SETTEMPO && !rows[d * 4 + 3]) {
        rows[d * 4 + 2] = GT.CMD_FUNKTEMPO;
        rows[d * 4 + 3] = makeSpeed(sl, sr, ((filtertable[2]! << 4) | (filtertable[3]! & 0x0f)) & 0xff, MST_FUNKTEMPO) + 1;
      }
      if (rows[d * 4 + 2] === GT.CMD_DONOTHING && rows[d * 4 + 3]) {
        const note = rows[d * 4]!;
        if (note >= GT.FIRSTNOTE && note <= GT.LASTNOTE && i) {
          // GoatTracker 1.x arpeggio parameter: a new wavetable (and instrument when there is room).
          const param = rows[d * 4 + 3]!;
          const key = `${i}:${param}`;
          let mapped = arpmap.get(key) ?? 0;
          if (!mapped) {
            const arpstart = fw + 1;
            const base = instruments[i]!.ptr[GT.WTBL];
            if (base) for (let e = base - 1; e < GT.MAX_TABLELEN && fwT[e] !== 0xff; e++) { if (fw < GT.MAX_TABLELEN) { fwT[fw] = fwT[e]!; fw++; } }
            const arploop = fw + 1;
            if (fw < GT.MAX_TABLELEN - 3) {
              fwT[fw] = (param & 0x80) >> 7; fwR[fw] = (param & 0x70) >> 4; fw++;
              fwT[fw] = (param & 0x80) >> 7; fwR[fw] = param & 0xf; fw++;
              fwT[fw] = (param & 0x80) >> 7; fwR[fw] = 0; fw++;
              fwT[fw] = 0xff; fwR[fw] = arploop; fw++;
              if (fi < GT.MAX_INSTR) {
                mapped = fi + 256;
                const copy = { ...instruments[i]!, ptr: [...instruments[i]!.ptr] as GtInstrument["ptr"] };
                copy.ptr[GT.WTBL] = arpstart;
                if (copy.name.length < GT.MAX_INSTRNAMELEN - 3) copy.name += `0${(param & 0x7f).toString(16).toUpperCase().padStart(2, "0")}`;
                instruments[fi] = copy;
                fi++;
              } else mapped = arpstart;
              arpmap.set(key, mapped);
            }
          }
          if (mapped) {
            if (mapped < 256) { rows[d * 4 + 2] = GT.CMD_SETWAVEPTR; rows[d * 4 + 3] = mapped; } else { rows[d * 4 + 1] = mapped - 256; rows[d * 4 + 3] = 0; }
          }
        }
        if (!rows[d * 4 + 2]) rows[d * 4 + 3] = 0;
      }
    }
  }
  song.conversions.push("GTS!: GoatTracker 1.x instruments, wavetables, pulse parameters, filter table, patterns, arpeggios and commands were converted to the GoatTracker 2 model.");
}

/** Length of a pattern in rows (up to the row that ends it). */
export function patternLength(rows: Uint8Array | undefined): number {
  if (!rows) return 64;
  const n = rows.length / 4;
  for (let d = 0; d < n; d++) if (rows[d * 4] === GT.ENDPATT) return d;
  return n;
}

const pad = (value: string, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let i = 0; i < Math.min(size - 1, value.length); i++) out[i] = value.charCodeAt(i) < 256 ? value.charCodeAt(i) : 63;
  return out;
};

/** Writes a GTS5 song file (the format of GoatTracker 2.77). */
export function writeGoatTracker(song: Pick<GtSong, "name" | "author" | "copyright" | "songs" | "instruments" | "ltable" | "rtable" | "patterns">): Uint8Array {
  const out: number[] = [0x47, 0x54, 0x53, 0x35];
  const put = (bytes: ArrayLike<number>) => { for (let i = 0; i < bytes.length; i++) out.push(bytes[i]! & 0xff); };
  put(pad(song.name, 32)); put(pad(song.author, 32)); put(pad(song.copyright, 32));
  out.push(song.songs.length);
  for (const lists of song.songs) for (const list of lists) {
    // list = entries, LOOPSONG, loop position
    out.push(list.length - 1);
    put(list);
  }
  let highest = 0;
  for (let c = 1; c < GT.MAX_INSTR; c++) { const i = song.instruments[c]!; if (i.ad || i.sr || i.ptr[0] || i.ptr[1] || i.ptr[2] || i.ptr[3] || i.vibdelay) highest = c; }
  out.push(highest);
  for (let c = 1; c <= highest; c++) {
    const i = song.instruments[c]!;
    out.push(i.ad, i.sr, i.ptr[0], i.ptr[1], i.ptr[2], i.ptr[3], i.vibdelay, i.gatetimer, i.firstwave);
    put(pad(i.name, GT.MAX_INSTRNAMELEN));
  }
  for (let c = 0; c < 4; c++) {
    let len = GT.MAX_TABLELEN;
    while (len > 0 && !(song.ltable[c]![len - 1]! | song.rtable[c]![len - 1]!)) len--;
    out.push(len);
    put(song.ltable[c]!.subarray(0, len)); put(song.rtable[c]!.subarray(0, len));
  }
  out.push(song.patterns.length);
  for (const rows of song.patterns) { out.push(rows.length / 4); put(rows); }
  return Uint8Array.from(out);
}
