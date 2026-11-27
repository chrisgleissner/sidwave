// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Byte-level editor for the PSID / RSID header (HVSC DOCUMENTS/SID_file_format.txt). The editor patches the fields
// that are named in the edit and copies every other byte of the file unchanged, including bytes that a parse and
// write would normalise (text after the zero terminator of a string, reserved flag bits, ignored header bytes).
// The result is validated with the parser; a field combination that the specification forbids is an error.

import { SidFileError, encodeSidHeaderString, isValidSidAddressByte, md5ForSonglengths, parseSidFile, songSpeed, type Clock, type ParseOptions, type SidFile, type SidFileModel, type SongSpeed } from "./sidFile.js";
import { HvscError } from "./hvsc.js";
import { legacyMd5ForSonglengths } from "./songlengths.js";

export interface SidEditFields {
  /** Switch between PSID and RSID. */
  magic?: "PSID" | "RSID";
  /** Header version 1 to 4. Without it the version is raised when another edited field needs a newer one. */
  version?: 1 | 2 | 3 | 4;
  name?: string;
  author?: string;
  released?: string;
  songs?: number;
  startSong?: number;
  /** The 32 speed bits (bit 0 = song 1, 1 = CIA). */
  speed?: number;
  /** Speed of single songs (1-based), applied on top of `speed` or the existing bits. */
  speedSongs?: Record<number, SongSpeed>;
  clock?: Clock;
  /** Model of the first, second and third SID. */
  sidModel?: SidFileModel;
  sid2Model?: SidFileModel;
  sid3Model?: SidFileModel;
  /** Address ($D420-$D7E0 or $DE00-$DFE0, multiples of $20), or null for no second/third SID. */
  secondSidAddress?: number | null;
  thirdSidAddress?: number | null;
  musPlayer?: boolean;
  /** Flag bit 1 of a PSID: the tune is PlaySID specific. */
  psidSpecific?: boolean;
  /** Flag bit 1 of an RSID: the tune starts with its BASIC part. */
  basic?: boolean;
  loadAddress?: number;
  initAddress?: number;
  playAddress?: number;
  startPage?: number;
  pageLength?: number;
}

export interface SidEditOptions extends ParseOptions {
  /** Treat a new warning (a result that parses but deviates from the specification) as an error. */
  strict?: boolean;
}

export interface SidEditChange {
  field: string;
  from: string;
  to: string;
  /** Byte range of the field in the new file. */
  offset: number;
  length: number;
}

export interface SidEditResult {
  bytes: Uint8Array;
  /** Fields whose value changed. A field that was set to the value it already had is not listed. */
  changes: SidEditChange[];
  /** New deviations and things the edit does not do (for example, that a changed load address does not move code). */
  warnings: string[];
  version: { from: number; to: number };
  /** True when the header got longer or shorter (a version 1 header has 6 bytes less than later versions). */
  layoutChanged: boolean;
  /** Byte ranges [start, end) that differ from the input; absent when the layout changed. */
  changedRanges?: Array<[number, number]>;
  /** Songlengths.md5 key (MD5 of the whole file) and the key of the old Songlengths.txt format. */
  md5: { old: string; new: string };
  legacyMd5: { old: string; new: string };
}

const FIELD_NAMES = new Set([
  "magic", "version", "name", "author", "released", "songs", "startSong", "speed", "speedSongs", "clock", "sidModel", "sid2Model", "sid3Model",
  "secondSidAddress", "thirdSidAddress", "musPlayer", "psidSpecific", "basic", "loadAddress", "initAddress", "playAddress", "startPage", "pageLength",
]);
const CLOCKS: Clock[] = ["unknown", "PAL", "NTSC", "PAL+NTSC"];
const MODELS: SidFileModel[] = ["unknown", "6581", "8580", "6581+8580"];

const hex = (n: number, w = 4): string => `$${n.toString(16).toUpperCase().padStart(w, "0")}`;
const bad = (message: string): HvscError => new HvscError("bad_value", message);

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${name} must be a whole number from ${min} to ${max}, not ${typeof value === "number" ? value : JSON.stringify(value)}`);
  }
  return value;
}

function address(name: string, value: unknown): number {
  return integer(name, value, 0, 0xffff);
}

function sidAddress(name: string, value: unknown): number | null {
  if (value === null) return null;
  const a = integer(name, value, 0, 0xffff);
  const byte = (a - 0xd000) / 16;
  if (a < 0xd000 || !Number.isInteger(byte) || !isValidSidAddressByte(byte)) {
    throw bad(`${name} ${hex(a)} is not a valid SID address; use $D420-$D7E0 or $DE00-$DFE0 in steps of $20 (or none)`);
  }
  return a;
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw bad(`${name} must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`);
  return value as T;
}

function bool(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw bad(`${name} must be true or false`);
  return value;
}

/** Hint appended to a parser error so that the message says what to do. */
function hintFor(error: SidFileError): string {
  switch (error.code) {
    case "rsid_constraint": return " (an RSID needs play address 0, speed 0, a load address of $07E8 or higher and, unless the BASIC flag is set, an init address inside the data; set these in the same edit)";
    case "bad_start_song": return " (change the start song in the same edit, or choose a song count that includes it)";
    case "bad_song_count": return " (a SID file holds 1 to 256 songs)";
    case "bad_reloc": return " (set the relocation start page and page count together; page count must be 0 for start page 0 or $FF)";
    case "bad_sid_address": return " (the second SID address needs version 3 and the third version 4)";
    default: return "";
  }
}

/**
 * Edits header fields of a SID file. Only the bytes of the changed fields differ in the result, except that a change
 * between version 1 and a later version adds or removes the 6 byte extension of the header. Throws SidFileError
 * when `bytes` is not a valid file or the edit would produce an invalid one, and HvscError for a bad field value.
 */
export function editSidHeader(bytes: Uint8Array, fields: SidEditFields, options: SidEditOptions = {}): SidEditResult {
  for (const key of Object.keys(fields)) if (!FIELD_NAMES.has(key)) throw bad(`unknown field "${key}"`);
  const before: SidFile = parseSidFile(bytes, options);
  const oldVersion = before.version;
  const oldHeaderSize = oldVersion === 1 ? 0x76 : 0x7c;
  const rawU16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;

  // Values from the edit, checked.
  const f: SidEditFields = {
    magic: fields.magic === undefined ? undefined : oneOf("magic", fields.magic, ["PSID", "RSID"] as const),
    version: fields.version === undefined ? undefined : (integer("version", fields.version, 1, 4) as 1 | 2 | 3 | 4),
    name: fields.name, author: fields.author, released: fields.released,
    songs: fields.songs === undefined ? undefined : integer("songs", fields.songs, 1, 256),
    startSong: fields.startSong === undefined ? undefined : integer("startSong", fields.startSong, 1, 256),
    speed: fields.speed === undefined ? undefined : integer("speed", fields.speed, 0, 0xffffffff),
    speedSongs: fields.speedSongs,
    clock: fields.clock === undefined ? undefined : oneOf("clock", fields.clock, CLOCKS),
    sidModel: fields.sidModel === undefined ? undefined : oneOf("sidModel", fields.sidModel, MODELS),
    sid2Model: fields.sid2Model === undefined ? undefined : oneOf("sid2Model", fields.sid2Model, MODELS),
    sid3Model: fields.sid3Model === undefined ? undefined : oneOf("sid3Model", fields.sid3Model, MODELS),
    secondSidAddress: fields.secondSidAddress === undefined ? undefined : sidAddress("secondSidAddress", fields.secondSidAddress),
    thirdSidAddress: fields.thirdSidAddress === undefined ? undefined : sidAddress("thirdSidAddress", fields.thirdSidAddress),
    musPlayer: fields.musPlayer === undefined ? undefined : bool("musPlayer", fields.musPlayer),
    psidSpecific: fields.psidSpecific === undefined ? undefined : bool("psidSpecific", fields.psidSpecific),
    basic: fields.basic === undefined ? undefined : bool("basic", fields.basic),
    loadAddress: fields.loadAddress === undefined ? undefined : address("loadAddress", fields.loadAddress),
    initAddress: fields.initAddress === undefined ? undefined : address("initAddress", fields.initAddress),
    playAddress: fields.playAddress === undefined ? undefined : address("playAddress", fields.playAddress),
    startPage: fields.startPage === undefined ? undefined : integer("startPage", fields.startPage, 0, 255),
    pageLength: fields.pageLength === undefined ? undefined : integer("pageLength", fields.pageLength, 0, 255),
  };
  for (const key of ["name", "author", "released"] as const) {
    if (f[key] !== undefined && typeof f[key] !== "string") throw bad(`${key} must be text`);
  }
  const speedSongs: Array<[number, SongSpeed]> = [];
  if (f.speedSongs !== undefined) {
    if (typeof f.speedSongs !== "object" || f.speedSongs === null) throw bad("speedSongs must map song numbers to VBI or CIA");
    for (const [key, value] of Object.entries(f.speedSongs)) {
      speedSongs.push([integer("speedSongs song", Number(key), 1, 256), oneOf(`speedSongs[${key}]`, value, ["VBI", "CIA"] as const)]);
    }
  }

  const rawFlags = oldVersion >= 2 ? rawU16(bytes, 0x76) : 0;
  const oldModel = (n: 0 | 1 | 2): SidFileModel => MODELS[(rawFlags >> (4 + 2 * n)) & 3]!;
  const oldClock = CLOCKS[(rawFlags >> 2) & 3]!;
  const newMagic = f.magic ?? before.magic;
  const finalClock = f.clock ?? oldClock;
  const finalModels: SidFileModel[] = [f.sidModel ?? oldModel(0), f.sid2Model ?? oldModel(1), f.sid3Model ?? oldModel(2)];
  const oldBit1 = (rawFlags & 2) !== 0;
  const bit1Edit = newMagic === "RSID" ? f.basic : f.psidSpecific;
  if (newMagic === "RSID" && f.psidSpecific !== undefined) throw bad("psidSpecific applies to a PSID; for an RSID use basic");
  if (newMagic === "PSID" && f.basic !== undefined) throw bad("basic applies to an RSID; for a PSID use psidSpecific");
  const finalBit1 = bit1Edit ?? oldBit1;
  const finalMus = f.musPlayer ?? (rawFlags & 1) !== 0;
  const oldStartPage = oldVersion >= 2 ? bytes[0x78]! : 0;
  const oldPageLength = oldVersion >= 2 ? bytes[0x79]! : 0;
  const finalStartPage = f.startPage ?? oldStartPage;
  const finalPageLength = f.pageLength ?? oldPageLength;

  // The version that the touched fields need.
  const reasons: Array<[number, string]> = [];
  const need = (version: number, why: string): void => void reasons.push([version, why]);
  if (f.magic === "RSID") need(2, "an RSID");
  if (f.clock !== undefined && f.clock !== "unknown") need(2, "the clock flag");
  if (f.sidModel !== undefined && f.sidModel !== "unknown") need(2, "the SID model flag");
  if (f.musPlayer === true) need(2, "the MUS player flag");
  if (bit1Edit === true) need(2, newMagic === "RSID" ? "the BASIC flag" : "the PlaySID flag");
  if ((f.startPage !== undefined && f.startPage !== 0) || (f.pageLength !== undefined && f.pageLength !== 0)) need(2, "the relocation range");
  if (typeof f.secondSidAddress === "number") need(3, "a second SID address");
  if (f.sid2Model !== undefined && f.sid2Model !== "unknown") need(3, "the model of the second SID");
  if (typeof f.thirdSidAddress === "number") need(4, "a third SID address");
  if (f.sid3Model !== undefined && f.sid3Model !== "unknown") need(4, "the model of the third SID");
  const needed = reasons.reduce((max, [v]) => Math.max(max, v), 1);
  const warnings: string[] = [];
  let newVersion: number = f.version ?? Math.max(oldVersion, needed);
  if (f.version !== undefined && f.version < needed) {
    const [, why] = reasons.filter(([v]) => v === needed)[0]!;
    throw new HvscError("bad_combination", `${why} needs header version ${needed} or later, but version ${f.version} was requested; use version ${needed} or leave the version out`);
  }
  if (f.version === undefined && newVersion > oldVersion) {
    const why = reasons.filter(([v]) => v > oldVersion).map(([, w]) => w).join(", ");
    warnings.push(`raised the header version from ${oldVersion} to ${newVersion} for ${why}; players that only know version ${oldVersion} ignore these fields`);
  }
  if (newMagic === "RSID" && newVersion < 2) newVersion = 2;

  // A lower version drops fields of the later ones; refuse when that would lose data.
  const secondByteOld = oldVersion >= 3 ? bytes[0x7a]! : 0;
  const thirdByteOld = oldVersion >= 4 ? bytes[0x7b]! : 0;
  if (newVersion < oldVersion) {
    const loses: string[] = [];
    const finalSecond = f.secondSidAddress === undefined ? secondByteOld !== 0 : f.secondSidAddress !== null;
    const finalThird = f.thirdSidAddress === undefined ? thirdByteOld !== 0 : f.thirdSidAddress !== null;
    if (newVersion < 4 && (finalThird || finalModels[2] !== "unknown")) loses.push("the third SID");
    if (newVersion < 3 && (finalSecond || finalModels[1] !== "unknown")) loses.push("the second SID");
    if (newVersion < 2 && (finalMus || finalBit1 || finalClock !== "unknown" || finalModels[0] !== "unknown" || finalStartPage !== 0 || finalPageLength !== 0)) loses.push("the flags and relocation range");
    if (loses.length > 0) throw new HvscError("bad_combination", `version ${newVersion} has no room for ${loses.join(" and ")}; clear those fields in the same edit or keep version ${oldVersion}`);
  }

  // Output buffer: the header of the new version, then the data.
  const newHeaderSize = newVersion === 1 ? 0x76 : 0x7c;
  const layoutChanged = newHeaderSize !== oldHeaderSize;
  const out = new Uint8Array(newHeaderSize + (bytes.length - oldHeaderSize));
  out.set(bytes.subarray(0, Math.min(oldHeaderSize, newHeaderSize)), 0);
  out.set(bytes.subarray(oldHeaderSize), newHeaderSize);
  const dv = new DataView(out.buffer);
  const changes: SidEditChange[] = [];
  const note = (field: string, from: string, to: string, offset: number, length: number): void => void changes.push({ field, from, to, offset, length });

  if (newVersion !== oldVersion) {
    dv.setUint16(4, newVersion);
    note("version", String(oldVersion), String(newVersion), 4, 2);
  }
  if (layoutChanged) {
    dv.setUint16(6, newHeaderSize);
    note("dataOffset", hex(oldHeaderSize), hex(newHeaderSize), 6, 2);
  }
  if (newMagic !== before.magic) {
    for (let i = 0; i < 4; i++) out[i] = newMagic.charCodeAt(i);
    note("magic", before.magic, newMagic, 0, 4);
  }

  const word = (field: string, offset: number, value: number | undefined, format: (n: number) => string = (n) => String(n)): void => {
    if (value === undefined) return;
    const old = rawU16(out, offset);
    if (old === value) return;
    dv.setUint16(offset, value);
    note(field, format(old), format(value), offset, 2);
  };
  const text = (field: string, offset: number, value: string | undefined, oldText: string): void => {
    if (value === undefined) return;
    const encoded = encodeSidHeaderString(value, field);
    if (value === oldText) return;
    const padded = new Uint8Array(32);
    padded.set(encoded);
    out.set(padded, offset);
    note(field, JSON.stringify(oldText), JSON.stringify(value), offset, 32);
  };

  // Load address: in the header when it is not 0, else in the first two data bytes.
  if (f.loadAddress !== undefined) {
    const headerLoad = rawU16(out, 8);
    if (headerLoad !== 0) word("loadAddress", 8, f.loadAddress, hex);
    else {
      const o = newHeaderSize;
      const old = out[o]! | (out[o + 1]! << 8);
      if (old !== f.loadAddress) {
        out[o] = f.loadAddress & 0xff;
        out[o + 1] = f.loadAddress >> 8;
        note("loadAddress", hex(old), hex(f.loadAddress), o, 2);
      }
    }
    if (f.loadAddress !== before.loadAddress) warnings.push("changing the load address moves where the data is loaded but does not relocate the code in it");
  }
  word("initAddress", 0x0a, f.initAddress, hex);
  word("playAddress", 0x0c, f.playAddress, hex);
  word("songs", 0x0e, f.songs);
  word("startSong", 0x10, f.startSong);

  // Speed.
  if (f.speed !== undefined || speedSongs.length > 0) {
    let speed = f.speed ?? dv.getUint32(0x12);
    const songs = f.songs ?? before.songs;
    const wrap = newVersion === 1 || (newMagic === "PSID" && finalBit1);
    for (const [song, mode] of speedSongs) {
      if (song > songs) throw bad(`speed of song ${song} was given, but the file has ${songs} song${songs === 1 ? "" : "s"}`);
      const bit = wrap ? (song - 1) % 32 : Math.min(song - 1, 31);
      if (!wrap && song > 32) warnings.push(`song ${song} shares speed bit 31 with every song above 32 in this header version; the edit sets that bit`);
      speed = mode === "CIA" ? (speed | (1 << bit)) >>> 0 : (speed & ~(1 << bit)) >>> 0;
    }
    const old = dv.getUint32(0x12);
    if (old !== speed) {
      dv.setUint32(0x12, speed);
      note("speed", `0x${old.toString(16).padStart(8, "0")}`, `0x${speed.toString(16).padStart(8, "0")}`, 0x12, 4);
    }
  }

  text("name", 0x16, f.name, before.name);
  text("author", 0x36, f.author, before.author);
  text("released", 0x56, f.released, before.released);

  // Flags and the v2+ bytes.
  if (newVersion >= 2) {
    let flags = oldVersion >= 2 ? rawFlags : 0;
    const flagChanges: Array<[string, string, string]> = [];
    const setFlag = (field: string, mask: number, shift: number, value: number | undefined, names: readonly string[]): void => {
      if (value === undefined) return;
      const old = (flags & mask) >> shift;
      if (old === value) return;
      flags = (flags & ~mask) | (value << shift);
      flagChanges.push([field, names[old]!, names[value]!]);
    };
    const onOff = ["off", "on"] as const;
    setFlag("musPlayer", 1, 0, f.musPlayer === undefined ? undefined : Number(f.musPlayer), onOff);
    setFlag(newMagic === "RSID" ? "basic" : "psidSpecific", 2, 1, bit1Edit === undefined ? undefined : Number(bit1Edit), onOff);
    setFlag("clock", 0xc, 2, f.clock === undefined ? undefined : CLOCKS.indexOf(f.clock), CLOCKS);
    setFlag("sidModel", 0x30, 4, f.sidModel === undefined ? undefined : MODELS.indexOf(f.sidModel), MODELS);
    setFlag("sid2Model", 0xc0, 6, f.sid2Model === undefined ? undefined : MODELS.indexOf(f.sid2Model), MODELS);
    setFlag("sid3Model", 0x300, 8, f.sid3Model === undefined ? undefined : MODELS.indexOf(f.sid3Model), MODELS);
    if (flags !== (oldVersion >= 2 ? rawFlags : 0)) {
      dv.setUint16(0x76, flags);
      for (const [field, from, to] of flagChanges) note(field, from, to, 0x76, 2);
    }
    const byte = (field: string, offset: number, value: number | undefined, format: (n: number) => string = String): void => {
      if (value === undefined) return;
      const old = out[offset]!;
      if (old === value) return;
      out[offset] = value;
      note(field, format(old), format(value), offset, 1);
    };
    byte("startPage", 0x78, f.startPage, (n) => hex(n, 2));
    byte("pageLength", 0x79, f.pageLength);
    const sidByte = (field: string, offset: number, value: number | null | undefined): void => {
      if (value === undefined) return;
      const next = value === null ? 0 : (value - 0xd000) / 16;
      const old = out[offset]!;
      if (old === next) return;
      out[offset] = next;
      note(field, old === 0 ? "none" : isValidSidAddressByte(old) ? hex(0xd000 + old * 16) : `invalid byte ${hex(old, 2)}`, value === null ? "none" : hex(value), offset, 1);
    };
    sidByte("secondSidAddress", 0x7a, f.secondSidAddress);
    sidByte("thirdSidAddress", 0x7b, f.thirdSidAddress);
  }

  // Combinations that the parser reports only as warnings, or reads leniently, are errors for an explicit edit.
  if (f.startPage !== undefined || f.pageLength !== undefined) {
    if ((finalStartPage === 0 || finalStartPage === 0xff) && finalPageLength !== 0) {
      throw new HvscError("bad_combination", `the page count must be 0 when the start page is ${hex(finalStartPage, 2)}; set both, for example start page $1E and 4 pages, or both 0`);
    }
    if (finalStartPage + finalPageLength > 0x100) throw new HvscError("bad_combination", `the relocation range ${hex(finalStartPage, 2)} + ${finalPageLength} pages runs past page $FF`);
  }
  if (typeof f.secondSidAddress === "number" && f.secondSidAddress === (f.thirdSidAddress ?? (thirdByteOld === 0 ? null : 0xd000 + thirdByteOld * 16))) {
    throw new HvscError("bad_combination", "the second and third SID address must differ");
  }
  if (typeof f.thirdSidAddress === "number" && f.thirdSidAddress === (f.secondSidAddress ?? (secondByteOld === 0 ? null : 0xd000 + secondByteOld * 16))) {
    throw new HvscError("bad_combination", "the second and third SID address must differ");
  }
  if (typeof f.thirdSidAddress === "number" && (f.secondSidAddress === null || (f.secondSidAddress === undefined && secondByteOld === 0))) {
    warnings.push("a third SID address is set without a second one; players expect the second SID to be present");
  }

  let after: SidFile;
  try {
    after = parseSidFile(out, options);
  } catch (error) {
    if (error instanceof SidFileError) throw new SidFileError(error.code, `the edit would produce an invalid file: ${error.message}${hintFor(error)}`);
    throw error;
  }
  const known = new Set(before.warnings);
  const fresh = after.warnings.filter((w) => !known.has(w));
  if (options.strict && fresh.length > 0) throw new SidFileError("bad_field", `the edit would produce a file that deviates from the specification (--strict): ${fresh.join("; ")}`);
  warnings.push(...fresh);
  if (f.magic !== undefined && f.magic !== before.magic && oldBit1 && bit1Edit === undefined) {
    warnings.push(`flag bit 1 is kept; it now means ${f.magic === "RSID" ? "BASIC" : "PlaySID specific"} instead of ${before.magic === "RSID" ? "BASIC" : "PlaySID specific"}`);
  }
  if (finalMus) warnings.push("the MUS player flag is set: the data is Compute!'s Sidplayer MUS and needs an external player");
  if ((finalModels[1] !== "unknown" && after.secondSidAddress === undefined) || (finalModels[2] !== "unknown" && after.thirdSidAddress === undefined)) {
    warnings.push("a model is set for a second or third SID that has no address, so it has no effect");
  }
  if (newMagic === "RSID" && before.magic === "PSID") warnings.push("RSID files need a real C64 environment; check the result in a player that supports RSID");

  let changedRanges: Array<[number, number]> | undefined;
  if (!layoutChanged) {
    changedRanges = [];
    let start = -1;
    for (let i = 0; i <= out.length; i++) {
      const differs = i < out.length && out[i] !== bytes[i];
      if (differs && start < 0) start = i;
      else if (!differs && start >= 0) { changedRanges.push([start, i]); start = -1; }
    }
  }
  return {
    bytes: out, changes, warnings, version: { from: oldVersion, to: newVersion }, layoutChanged,
    ...(changedRanges === undefined ? {} : { changedRanges }),
    md5: { old: md5ForSonglengths(bytes), new: md5ForSonglengths(out) },
    legacyMd5: { old: legacyMd5ForSonglengths(bytes), new: legacyMd5ForSonglengths(out) },
  };
}

/** The speed of every song as a list, for display ("VBI" or "CIA"). */
export function songSpeeds(file: Pick<SidFile, "version" | "magic" | "psidSpecific" | "speed" | "songs">): SongSpeed[] {
  return Array.from({ length: file.songs }, (_, i) => songSpeed(file, i + 1));
}
