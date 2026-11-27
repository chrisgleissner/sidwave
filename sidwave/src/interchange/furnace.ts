// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Furnace module files (.fur), C64 (SID) subset: a reader for format versions 157 to 239 ("INFO" header) and 240 and
// later ("INF2" header) and a writer for version 228 (Furnace 0.6.8.1; later Furnace versions load it). The layout
// follows papers/format.md and papers/newIns.md of the Furnace repository (GPL-2.0-or-later; layout facts only).

import { deflateSync, inflateSync } from "node:zlib";
import { InterchangeInputError } from "./errors.js";

export class FurnaceError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "FurnaceError"; }
}

export const FUR_MAGIC = "-Furnace module-";
/** Largest .fur file and largest decompressed module read. */
export const MAX_FUR_BYTES = 16 * 1024 * 1024;
export const MAX_FUR_INFLATED = 32 * 1024 * 1024;
/** Chip ids of the two SID models. */
export const CHIP_C64_8580 = 0x07;
export const CHIP_C64_6581 = 0x47;
export const WRITE_VERSION = 228;

export interface FurMacro { code: number; loop: number; release: number; speed: number; delay: number; values: number[] }
export interface FurInstrument {
  index: number; type: number; name: string;
  /** C64 data ("64" feature). */
  c64?: { flags1: number; flags2: number; ad: number; sr: number; duty: number; cutoffRes: number };
  macros: FurMacro[];
}
export interface FurNote { note?: number; ins?: number; vol?: number; effects: number }
export interface FurSong {
  version: number;
  chips: number[];
  name: string; author: string;
  tickRate: number;
  speeds: number[];
  patternLength: number;
  ordersLength: number;
  channels: number;
  /** orders[position][channel] = pattern index. */
  orders: number[][];
  patterns: Map<number, Map<number, FurNote>>;
  instruments: FurInstrument[];
  subsongs: number;
  conversions: string[];
}

class Reader {
  pos = 0;
  constructor(readonly b: Buffer, readonly end = b.length) {}
  need(n: number): void { if (this.pos + n > this.end || n < 0) throw new FurnaceError(`the file is truncated (offset ${this.pos})`); }
  u8(): number { this.need(1); return this.b[this.pos++]!; }
  u16(): number { this.need(2); const v = this.b.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.b.readUInt32LE(this.pos); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.b.readFloatLE(this.pos); this.pos += 4; return v; }
  skip(n: number): void { this.need(n); this.pos += n; }
  str(): string {
    const start = this.pos;
    while (this.pos < this.end && this.b[this.pos] !== 0) this.pos++;
    if (this.pos >= this.end) throw new FurnaceError(`unterminated string at offset ${start}`);
    const s = this.b.toString("utf8", start, this.pos);
    this.pos++;
    return s;
  }
}

function inflateBounded(input: Buffer): Buffer {
  try { return inflateSync(input, { maxOutputLength: MAX_FUR_INFLATED }); } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ERR_BUFFER_TOO_LARGE" || /larger than/.test(e.message)) throw new FurnaceError(`the module decompresses to more than ${MAX_FUR_INFLATED} bytes`);
    throw new FurnaceError(`the file is not a valid zlib stream (${e.message})`);
  }
}

function readInstrument(r: Reader, index: number, blockEnd: number): FurInstrument {
  const ins: FurInstrument = { index, type: 0, name: "", macros: [] };
  r.u16(); // instrument format version
  ins.type = r.u16();
  while (r.pos + 4 <= blockEnd) {
    const code = r.b.toString("latin1", r.pos, r.pos + 2);
    r.pos += 2;
    const length = r.u16();
    const end = r.pos + length;
    if (end > blockEnd) throw new FurnaceError("an instrument feature runs past its block");
    if (code === "EN") break;
    const f = new Reader(r.b, end);
    f.pos = r.pos;
    if (code === "NA") ins.name = f.str();
    else if (code === "64" && length >= 8) {
      ins.c64 = { flags1: f.u8(), flags2: f.u8(), ad: f.u8(), sr: f.u8(), duty: f.u16(), cutoffRes: f.u16() };
    } else if (code === "MA") {
      const headerLength = f.u16();
      for (let guard = 0; guard < 64 && f.pos < end; guard++) {
        const macro = f.u8();
        if (macro === 255) break;
        const len = f.u8(), loop = f.u8(), release = f.u8(), mode = f.u8(), open = f.u8(), delay = f.u8(), speed = f.u8();
        void mode;
        if (headerLength > 8) f.skip(headerLength - 8);
        const bytes = [1, 1, 2, 4][open >> 6]!;
        const values: number[] = [];
        for (let i = 0; i < len; i++) {
          f.need(bytes);
          const signed = (open >> 6) !== 0;
          const v = bytes === 1 ? (signed ? f.b.readInt8(f.pos) : f.b[f.pos]!) : bytes === 2 ? f.b.readInt16LE(f.pos) : f.b.readInt32LE(f.pos);
          f.pos += bytes;
          values.push(v);
        }
        ins.macros.push({ code: macro, loop, release, speed: Math.max(1, speed), delay, values });
      }
    }
    r.pos = end;
  }
  return ins;
}

/** Parses a Furnace module (zlib-compressed or not). Only the C64 chip is accepted. */
export function parseFurnace(input: Uint8Array): FurSong {
  try { return parseFurnaceUnchecked(input); } catch (error) {
    if (error instanceof RangeError) throw new FurnaceError(`malformed module (${error.message})`);
    throw error;
  }
}

function parseFurnaceUnchecked(input: Uint8Array): FurSong {
  if (input.length > MAX_FUR_BYTES) throw new FurnaceError(`the file has ${input.length} bytes; the limit is ${MAX_FUR_BYTES}`);
  let data = Buffer.from(input.buffer, input.byteOffset, input.length);
  if (data.length >= 2 && data.toString("latin1", 0, 16) !== FUR_MAGIC) data = inflateBounded(data);
  if (data.toString("latin1", 0, 16) !== FUR_MAGIC) throw new FurnaceError("not a Furnace module (missing the -Furnace module- header)");
  const r = new Reader(data);
  r.pos = 16;
  const version = r.u16();
  r.u16();
  const infoPointer = r.u32();
  if (version < 157) throw new FurnaceError(`format version ${version} is older than 157 (Furnace 0.6pre6); open the file in Furnace 0.6 or later and save it again`);
  if (infoPointer + 8 > data.length) throw new FurnaceError("the song info pointer is outside the file");
  const song: FurSong = { version, chips: [], name: "", author: "", tickRate: 60, speeds: [6], patternLength: 64, ordersLength: 0, channels: 0, orders: [], patterns: new Map(), instruments: [], subsongs: 1, conversions: [] };
  const pattern: number[] = [];
  const insPointers: number[] = [];
  r.pos = infoPointer;
  const id = data.toString("latin1", r.pos, r.pos + 4);
  r.pos += 4;
  const blockSize = r.u32();
  const info = new Reader(data, Math.min(data.length, r.pos + blockSize));
  info.pos = r.pos;
  const readOrders = (rd: Reader, ordLen: number, channels: number): void => {
    if (ordLen * channels > 65536) throw new FurnaceError("the order table is too large");
    for (let o = 0; o < ordLen; o++) song.orders.push(new Array<number>(channels).fill(0));
    for (let c = 0; c < channels; c++) for (let o = 0; o < ordLen; o++) song.orders[o]![c] = rd.u8(); // channels outer, as Furnace reads and writes it
  };
  if (id === "INFO") {
    if (version >= 240) throw new FurnaceError("an INFO header in a version 240 or later file");
    info.u8(); const speed1 = info.u8(), speed2 = info.u8(); info.u8();
    song.tickRate = info.f32();
    song.patternLength = info.u16(); song.ordersLength = info.u16(); info.u8(); info.u8();
    const insCount = info.u16(), waveCount = info.u16(), sampleCount = info.u16(), patCount = info.u32();
    const chipIds = Array.from(data.subarray(info.pos, info.pos + 32)); info.skip(32);
    for (const c of chipIds) { if (c === 0) break; song.chips.push(c); }
    info.skip(32 + 32 + 128);
    song.name = info.str(); song.author = info.str(); info.f32();
    info.skip(20);
    if (insCount > 256 || waveCount > 256 || sampleCount > 256 || patCount > 65536) throw new FurnaceError("the module declares too many instruments, wavetables, samples or patterns");
    for (let i = 0; i < insCount; i++) insPointers.push(info.u32());
    info.skip(4 * (waveCount + sampleCount));
    for (let i = 0; i < patCount; i++) pattern.push(info.u32());
    checkChips(song);
    song.channels = song.chips.length * 3;
    readOrders(info, song.ordersLength, song.channels);
    info.skip(song.channels * 3); // effect columns, hide, collapse
    for (let i = 0; i < song.channels * 2; i++) info.str();
    info.str(); // comment
    info.f32(); // master volume
    info.skip(28); // extended compatibility flags
    info.u16(); info.u16(); // virtual tempo
    info.str(); info.str(); // first subsong name, comment
    song.subsongs = 1 + info.u8();
    info.skip(3);
    info.skip(4 * (song.subsongs - 1));
    for (let i = 0; i < 6; i++) info.str();
    info.skip(12 * song.chips.length);
    const connections = info.u32();
    if (connections > 4096) throw new FurnaceError("too many patchbay connections");
    info.skip(4 * connections + 1);
    info.skip([138, 155, 168, 183, 184, 188, 191, 200].filter((v) => version >= v).length);
    const speedLength = info.u8();
    if (speedLength < 1 || speedLength > 16) throw new FurnaceError(`invalid speed pattern length ${speedLength}`);
    const speeds = Array.from(data.subarray(info.pos, info.pos + 16)); info.skip(16);
    song.speeds = speeds.slice(0, speedLength).map((s) => s || 1);
    if (version < 139) song.speeds = [speed1, speed2].filter((s) => s > 0);
  } else if (id === "INF2") {
    if (version < 240) throw new FurnaceError("an INF2 header in a version before 240");
    song.name = info.str(); song.author = info.str();
    for (let i = 0; i < 6; i++) info.str();
    info.f32(); info.u8(); info.f32();
    const totalChannels = info.u16();
    const numChips = info.u16();
    if (numChips > 32 || totalChannels > 4096) throw new FurnaceError("the module declares too many chips or channels");
    for (let i = 0; i < numChips; i++) { song.chips.push(info.u16()); info.u16(); info.skip(12); }
    checkChips(song);
    song.channels = totalChannels;
    const connections = info.u32();
    if (connections > 4096) throw new FurnaceError("too many patchbay connections");
    info.skip(4 * connections + 1);
    const elements: Array<{ type: number; pointers: number[] }> = [];
    for (let guard = 0; guard < 64; guard++) {
      const type = info.u8();
      if (type === 0) break;
      const n = info.u32();
      if (n > 65536) throw new FurnaceError("too many elements");
      const pointers: number[] = [];
      for (let i = 0; i < n; i++) pointers.push(info.u32());
      elements.push({ type, pointers });
    }
    for (const e of elements) {
      if (e.type === 4) insPointers.push(...e.pointers);
      else if (e.type === 7) pattern.push(...e.pointers);
      else if (e.type === 1) {
        song.subsongs = e.pointers.length;
        const p = e.pointers[0];
        if (p === undefined) continue;
        if (p + 8 > data.length) throw new FurnaceError("a subsong pointer is outside the file");
        const s = new Reader(data, Math.min(data.length, p + 8 + data.readUInt32LE(p + 4)));
        s.pos = p + 8;
        song.tickRate = s.f32(); s.u8(); s.u8();
        song.patternLength = s.u16(); song.ordersLength = s.u16(); s.u8(); s.u8(); s.u16(); s.u16();
        const n = s.u8();
        if (n < 1 || n > 16) throw new FurnaceError(`invalid speed pattern length ${n}`);
        const speeds: number[] = [];
        for (let i = 0; i < 16; i++) speeds.push(s.u16());
        song.speeds = speeds.slice(0, n).map((x) => x || 1);
        s.str(); s.str();
        readOrders(s, song.ordersLength, song.channels);
      }
    }
  } else throw new FurnaceError(`unknown song info block "${id.replace(/[^ -~]/g, "?")}"`);
  if (!(song.tickRate > 0 && song.tickRate <= 1000)) throw new FurnaceError(`invalid tick rate ${song.tickRate}`);
  if (song.patternLength < 1 || song.patternLength > 256 || song.ordersLength < 1 || song.ordersLength > 256) throw new FurnaceError("invalid pattern or order length");
  song.conversions.push(`Furnace format version ${version} (${id}).`);

  for (const [i, p] of insPointers.entries()) {
    if (p + 8 > data.length || data.toString("latin1", p, p + 4) !== "INS2") continue;
    const size = data.readUInt32LE(p + 4);
    const rd = new Reader(data, Math.min(data.length, p + 8 + size));
    rd.pos = p + 8;
    song.instruments[i] = readInstrument(rd, i, rd.end);
  }
  for (const p of pattern) {
    if (p + 8 > data.length || data.toString("latin1", p, p + 4) !== "PATN") continue;
    const size = data.readUInt32LE(p + 4);
    const rd = new Reader(data, Math.min(data.length, p + 8 + size));
    rd.pos = p + 8;
    const subsong = rd.u8();
    const channel = version >= 240 ? rd.u16() : rd.u8();
    const index = rd.u16();
    if (version >= 51) rd.str();
    if (subsong !== 0) continue;
    const rows = new Map<number, FurNote>();
    let row = 0;
    while (rd.pos < rd.end && row < song.patternLength) {
      const mask = rd.u8();
      if (mask === 0xff) break;
      if (mask & 0x80) { row += (mask & 0x7f) + 2; continue; }
      if (mask === 0) { row++; continue; }
      let effectMask = 0;
      if (mask & 0x20) effectMask |= rd.u8();
      if (mask & 0x40) effectMask |= rd.u8() << 8;
      if (mask & 0x08) effectMask |= 1;
      if (mask & 0x10) effectMask |= 2;
      const note: FurNote = { effects: 0 };
      if (mask & 0x01) { const n = rd.u8(); if (n === 183) rd.skip(4); note.note = n; }
      if (mask & 0x02) note.ins = rd.u8();
      if (mask & 0x04) note.vol = rd.u8();
      for (let k = 0; k < 16; k++) if (effectMask & (1 << k)) { rd.u8(); if (!(k & 1)) note.effects++; }
      rows.set(row, note);
      row++;
    }
    song.patterns.set(channel * 65536 + index, rows);
    if (song.patterns.size > 70000) throw new FurnaceError("too many patterns");
  }
  return song;
}

function checkChips(song: FurSong): void {
  if (song.chips.length === 0) throw new FurnaceError("the module has no sound chip");
  for (const chip of song.chips) {
    if (chip !== CHIP_C64_6581 && chip !== CHIP_C64_8580) {
      throw new FurnaceError(`the module uses the sound chip 0x${chip.toString(16)}; only the C64 chip (6581: 0x47, 8580: 0x07) is supported`);
    }
  }
  if (song.chips.length > 1) throw new FurnaceError(`the module has ${song.chips.length} SID chips; only one is supported`);
}

// ---------------------------------------------------------------------------------------------------------------- writer

export interface FurWriteInstrument { name: string; flags1: number; flags2: number; ad: number; sr: number; duty: number; arp?: { values: number[]; speed: number } }
export interface FurWriteSong {
  name: string; author: string; chip: number; tickRate: number; speed: number; patternLength: number;
  /** orders[position][channel] */
  orders: number[][];
  /** patterns[channel][index] = rows (note, instrument, volume), -1 for empty. */
  patterns: Array<Array<Array<{ note: number; ins: number; vol: number }>>>;
  instruments: FurWriteInstrument[];
}

class Out {
  parts: Buffer[] = [];
  size = 0;
  push(b: Buffer): void { this.parts.push(b); this.size += b.length; }
  u8(v: number): void { this.push(Buffer.from([v & 0xff])); }
  u16(v: number): void { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); this.push(b); }
  u32(v: number): void { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.push(b); }
  f32(v: number): void { const b = Buffer.alloc(4); b.writeFloatLE(v); this.push(b); }
  zeros(n: number): void { this.push(Buffer.alloc(n)); }
  str(s: string): void { this.push(Buffer.from(`${s.replace(/\0/g, "")}\0`, "utf8")); }
  ascii(s: string): void { this.push(Buffer.from(s, "latin1")); }
  bytes(): Buffer { return Buffer.concat(this.parts); }
}

function block(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function instrumentBlock(ins: FurWriteInstrument): Buffer {
  const o = new Out();
  o.u16(228); o.u16(3);
  const feature = (code: string, body: Buffer) => { o.ascii(code); o.u16(body.length); o.push(body); };
  feature("NA", Buffer.from(`${ins.name}\0`, "utf8"));
  const c = new Out();
  c.u8(ins.flags1); c.u8(ins.flags2); c.u8(ins.ad); c.u8(ins.sr); c.u16(ins.duty); c.u16(0); c.u8(0);
  feature("64", c.bytes());
  if (ins.arp && ins.arp.values.length) {
    const m = new Out();
    m.u16(8);
    m.u8(1); m.u8(ins.arp.values.length); m.u8(0); m.u8(255); m.u8(0); m.u8(0x40 | 1); m.u8(0); m.u8(Math.max(1, Math.min(255, ins.arp.speed)));
    for (const v of ins.arp.values) m.u8(v);
    m.u8(255);
    feature("MA", m.bytes());
  }
  o.ascii("EN"); o.u16(0);
  return o.bytes();
}

function patternBlock(channel: number, index: number, rows: Array<{ note: number; ins: number; vol: number }>): Buffer {
  const o = new Out();
  o.u8(0); o.u8(channel); o.u16(index); o.str("");
  let skip = 0;
  const flush = () => { while (skip > 0) { if (skip === 1) { o.u8(0); skip = 0; } else { const n = Math.min(skip, 129); o.u8(0x80 | (n - 2)); skip -= n; } } };
  for (const row of rows) {
    const mask = (row.note >= 0 ? 1 : 0) | (row.ins >= 0 ? 2 : 0) | (row.vol >= 0 ? 4 : 0);
    if (!mask) { skip++; continue; }
    flush();
    o.u8(mask);
    if (row.note >= 0) o.u8(row.note);
    if (row.ins >= 0) o.u8(row.ins);
    if (row.vol >= 0) o.u8(row.vol);
  }
  flush();
  o.u8(0xff);
  return o.bytes();
}

/** Writes a Furnace module of format version 228 (uncompressed). */
export function writeFurnace(song: FurWriteSong, compress = false): Buffer {
  const channels = 3;
  const info = new Out();
  info.u8(0); info.u8(song.speed); info.u8(song.speed); info.u8(1);
  info.f32(song.tickRate);
  info.u16(song.patternLength); info.u16(song.orders.length); info.u8(4); info.u8(16);
  const patternCount = song.patterns.reduce((n, p) => n + p.length, 0);
  info.u16(song.instruments.length); info.u16(0); info.u16(0); info.u32(patternCount);
  const chips = Buffer.alloc(32); chips[0] = song.chip;
  info.push(chips); info.zeros(32 + 32 + 128);
  info.str(song.name); info.str(song.author); info.f32(440);
  info.zeros(20);
  const pointerAt = info.size;
  info.zeros(4 * (song.instruments.length + patternCount));
  for (let c = 0; c < channels; c++) for (const row of song.orders) info.u8(row[c] ?? 0);
  info.u8(1); info.u8(1); info.u8(1); info.zeros(channels * 2); // effect columns, hide, collapse
  for (let i = 0; i < channels * 2; i++) info.str("");
  info.str(""); info.f32(1);
  info.zeros(28);
  info.u16(1); info.u16(1);
  info.str(""); info.str(""); info.u8(0); info.zeros(3);
  for (let i = 0; i < 6; i++) info.str("");
  info.f32(1); info.f32(0); info.f32(0);
  info.u32(0); info.u8(1);
  info.zeros(8); // compatibility flags added in versions 138 to 200
  info.u8(1); { const s = Buffer.alloc(16); s[0] = song.speed; info.push(s); }
  info.u8(0);
  info.u32(0); info.u32(0); info.u32(0);
  const infoBody = info.bytes();
  const headerSize = 32;
  const infoBlockSize = 8 + infoBody.length;
  const blocks: Buffer[] = [];
  const pointers: number[] = [];
  let at = headerSize + infoBlockSize;
  for (const ins of song.instruments) { const b = block("INS2", instrumentBlock(ins)); pointers.push(at); at += b.length; blocks.push(b); }
  for (const [channel, list] of song.patterns.entries()) {
    for (const [index, rows] of list.entries()) { const b = block("PATN", patternBlock(channel, index, rows)); pointers.push(at); at += b.length; blocks.push(b); }
  }
  pointers.forEach((p, i) => infoBody.writeUInt32LE(p, pointerAt + 4 * i));
  const header = Buffer.alloc(headerSize);
  header.write(FUR_MAGIC, 0, "latin1");
  header.writeUInt16LE(WRITE_VERSION, 16);
  header.writeUInt32LE(headerSize, 20);
  const file = Buffer.concat([header, block("INFO", infoBody), ...blocks]);
  return compress ? Buffer.from(deflateSync(file)) : file;
}
