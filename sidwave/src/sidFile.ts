// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// PSID / RSID (v1-v4) reader and writer.
// Source of truth: HVSC DOCUMENTS/SID_file_format.txt. Depends only on Node builtins.
//
// Speed bits: PSID v2 and v2NG share version 2 (spec lines 211-224), so a v2 file without the
// PlaySID flag is ambiguous; songSpeed() clamps songs above 32 to bit 31 for such files.
//
// Error / warning policy
// ----------------------
// The spec uses MUST for the RSID constraints, the valid ranges of version, dataOffset,
// songs and startSong, and for the data having to fit in the 64K address space. Violations
// of these throw SidFileError.
// The spec uses "should" / "invalid means no extra SID" for reserved flag bits, relocation
// range overlaps, SID address fields that are invalid or set for a too-old version, and
// unused header fields. These are reported in `warnings` (format "<code>: <message>") and
// parsing continues. writeSidFile is strict by default and treats these warnings as errors
// too (pass { strict: false } to emit such a header anyway).
// A pageLength that is non-zero while startPage is 0 or 0xFF, or a relocation range that
// runs past page $FF, is an error (spec: "must be set to 0").

import { createHash } from "node:crypto";

export type SidErrorCode =
  | "truncated"
  | "bad_magic"
  | "bad_version"
  | "bad_data_offset"
  | "bad_song_count"
  | "bad_start_song"
  | "rsid_constraint"
  | "bad_sid_address"
  | "bad_reloc"
  | "bad_field"
  | "bad_string"
  | "too_large"
  | "load_overlap";

export class SidFileError extends Error {
  readonly code: SidErrorCode;
  constructor(code: SidErrorCode, message: string) {
    super(message);
    this.name = "SidFileError";
    this.code = code;
  }
}

export type Clock = "unknown" | "PAL" | "NTSC" | "PAL+NTSC";
export type SidFileModel = "unknown" | "6581" | "8580" | "6581+8580";
export type SongSpeed = "VBI" | "CIA";

export interface SidFileInput {
  magic: "PSID" | "RSID";
  version: 1 | 2 | 3 | 4;
  /** Effective load address. */
  loadAddress: number;
  /** Header load address; 0 (default) means the payload is stored with a 2-byte load address prefix. */
  headerLoadAddress?: number;
  initAddress: number;
  playAddress: number;
  songs: number;
  startSong: number;
  speed: number;
  name: string;
  author: string;
  released: string;
  musPlayer?: boolean;
  /** PSID: PlaySID specific. */
  psidSpecific?: boolean;
  /** RSID: C64 BASIC flag (same flag bit as psidSpecific). */
  basic?: boolean;
  clock?: Clock;
  sidModels?: readonly [SidFileModel, SidFileModel, SidFileModel];
  startPage?: number;
  pageLength?: number;
  secondSidAddress?: number;
  thirdSidAddress?: number;
  /** C64 data without the 2-byte load address prefix. */
  payload: Uint8Array;
}

export interface SidFile extends Required<Omit<SidFileInput, "payload" | "secondSidAddress" | "thirdSidAddress">> {
  dataOffset: number;
  payload: Uint8Array;
  secondSidAddress: number | undefined;
  thirdSidAddress: number | undefined;
  warnings: string[];
}

export interface ParseOptions {
  maxBytes?: number;
}
export interface WriteOptions {
  /** Treat warnings as errors (default true). */
  strict?: boolean;
}

export const DEFAULT_MAX_BYTES = 0x10000 + 0x7c + 2;
const HEADER_V1 = 0x76;
const HEADER_V2 = 0x7c;

const CLOCKS: Clock[] = ["unknown", "PAL", "NTSC", "PAL+NTSC"];
const MODELS: SidFileModel[] = ["unknown", "6581", "8580", "6581+8580"];

// ---- Windows-1252 ----------------------------------------------------------------------
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
]; // undefined bytes (81 8D 8F 90 9D) map to the same C1 code point so they round-trip
const CP1252_REVERSE = new Map<number, number>(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

function decodeString(bytes: Uint8Array): { text: string; garbageAfterNul: boolean } {
  let end = bytes.indexOf(0);
  let garbage = false;
  if (end < 0) end = bytes.length;
  else garbage = bytes.subarray(end).some((b) => b !== 0);
  let s = "";
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
  }
  return { text: s, garbageAfterNul: garbage };
}

function encodeString(text: string, field: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    let b: number | undefined;
    if (cp === 0) b = undefined;
    else if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) b = cp;
    else b = CP1252_REVERSE.get(cp);
    if (b === undefined) {
      throw new SidFileError("bad_string", `${field}: character U+${cp.toString(16).toUpperCase().padStart(4, "0")} cannot be encoded in Windows-1252`);
    }
    out.push(b);
  }
  if (out.length > 32) throw new SidFileError("bad_string", `${field}: ${out.length} bytes exceed the 32 byte limit`);
  return Uint8Array.from(out);
}

// ---- helpers ---------------------------------------------------------------------------
export function isValidSidAddressByte(b: number): boolean {
  return b % 2 === 0 && ((b >= 0x42 && b <= 0x7f) || (b >= 0xe0 && b <= 0xfe));
}
const sidByteToAddress = (b: number): number => 0xd000 + b * 16;

interface Issue {
  level: "error" | "warning";
  code: SidErrorCode;
  message: string;
}

const hex = (n: number, w = 4): string => "$" + n.toString(16).toUpperCase().padStart(w, "0");
const isInt = (n: unknown, max: number): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

type Fields = Omit<SidFile, "warnings" | "dataOffset">;

/** Rules shared by parse and write. Returns every issue; callers decide what to throw. */
function validate(f: Fields): Issue[] {
  const out: Issue[] = [];
  const err = (code: SidErrorCode, message: string): void => void out.push({ level: "error", code, message });
  const warn = (code: SidErrorCode, message: string): void => void out.push({ level: "warning", code, message });
  const rsid = f.magic === "RSID";

  if (f.magic !== "PSID" && f.magic !== "RSID") err("bad_magic", "magic must be PSID or RSID");
  if (![1, 2, 3, 4].includes(f.version)) err("bad_version", `version ${f.version} is not 1-4`);
  else if (rsid && f.version < 2) err("bad_version", "RSID requires version 2, 3 or 4");

  for (const [name, v, max] of [
    ["loadAddress", f.loadAddress, 0xffff],
    ["headerLoadAddress", f.headerLoadAddress, 0xffff],
    ["initAddress", f.initAddress, 0xffff],
    ["playAddress", f.playAddress, 0xffff],
    ["speed", f.speed, 0xffffffff],
    ["startPage", f.startPage, 0xff],
    ["pageLength", f.pageLength, 0xff],
  ] as const) {
    if (!isInt(v, max)) err("bad_field", `${name} must be an integer 0..${max}`);
  }
  if (f.headerLoadAddress !== 0 && f.headerLoadAddress !== f.loadAddress) {
    err("bad_field", "headerLoadAddress must be 0 or equal to loadAddress");
  }
  if (!isInt(f.songs, 256) || f.songs < 1) err("bad_song_count", `songs ${f.songs} is not 1..256`);
  else if (!isInt(f.startSong, 256) || f.startSong < 1 || f.startSong > f.songs) {
    err("bad_start_song", `startSong ${f.startSong} is not 1..${f.songs}`);
  }
  if (out.some((i) => i.level === "error" && i.code === "bad_field")) return out;

  const loadEnd = f.loadAddress + f.payload.length;
  if (loadEnd > 0x10000) err("too_large", `data ${hex(f.loadAddress)}+${f.payload.length} bytes exceeds 64K`);

  if (rsid) {
    const c = (m: string): void => err("rsid_constraint", m);
    if (f.headerLoadAddress !== 0) c("RSID headerLoadAddress must be 0");
    if (f.playAddress !== 0) c("RSID playAddress must be 0");
    if (f.speed !== 0) c("RSID speed must be 0");
    if (f.loadAddress < 0x07e8) c(`RSID load address ${hex(f.loadAddress)} is below $07E8`);
    if (f.basic) {
      if (f.initAddress !== 0) c("RSID initAddress must be 0 when the BASIC flag is set");
    } else {
      const init = f.initAddress === 0 ? f.loadAddress : f.initAddress;
      const okRange = (init >= 0x07e8 && init <= 0x9fff) || (init >= 0xc000 && init <= 0xcfff);
      if (!okRange) c(`RSID initAddress ${hex(init)} must be $07E8-$9FFF or $C000-$CFFF`);
      else if (init < f.loadAddress || init >= loadEnd) c(`RSID initAddress ${hex(init)} lies outside the load image`);
    }
  }

  // Relocation range.
  if (f.startPage === 0 || f.startPage === 0xff) {
    if (f.pageLength !== 0) err("bad_reloc", "pageLength must be 0 when startPage is 0 or 0xFF");
  } else if (f.startPage + f.pageLength > 0x100) {
    err("bad_reloc", "relocation range runs past page $FF");
  } else if (f.pageLength > 0) {
    const rs = f.startPage * 256;
    const re = (f.startPage + f.pageLength) * 256 - 1;
    if (f.payload.length > 0 && rs < loadEnd && re >= f.loadAddress) {
      warn("load_overlap", `relocation range ${hex(rs)}-${hex(re)} overlaps the load image ${hex(f.loadAddress)}-${hex(loadEnd - 1)}`);
    }
    if (rsid && (rs <= 0x03ff || (re >= 0xa000 && rs <= 0xbfff) || re >= 0xd000)) {
      warn("bad_reloc", `RSID relocation range ${hex(rs)}-${hex(re)} overlaps reserved or ROM memory`);
    }
  }

  // SID addresses.
  for (const [name, addr, minVersion] of [
    ["secondSidAddress", f.secondSidAddress, 3],
    ["thirdSidAddress", f.thirdSidAddress, 4],
  ] as const) {
    if (addr === undefined) continue;
    const b = (addr - 0xd000) / 16;
    if (!Number.isInteger(b) || addr < 0xd000 || !isValidSidAddressByte(b)) {
      err("bad_sid_address", `${name} ${hex(addr)} is not a valid $Dxx0 SID address`);
    } else if (f.version < minVersion) {
      warn("bad_sid_address", `${name} requires version ${minVersion}`);
    }
  }
  if (f.secondSidAddress !== undefined && f.secondSidAddress === f.thirdSidAddress) {
    err("bad_sid_address", "third SID address must differ from the second");
  }

  if (f.version < 2) {
    if (f.musPlayer || f.psidSpecific || f.basic || f.clock !== "unknown" || f.sidModels.some((m) => m !== "unknown")) {
      warn("bad_field", "flags are not defined for version 1");
    }
  }
  if (f.version < 2 && (f.startPage !== 0 || f.pageLength !== 0)) warn("bad_field", "startPage/pageLength are not defined for version 1");
  return out;
}

function flagsWord(f: Fields): number {
  let w = f.musPlayer ? 1 : 0;
  if (f.psidSpecific || f.basic) w |= 2;
  w |= CLOCKS.indexOf(f.clock) << 2;
  w |= MODELS.indexOf(f.sidModels[0]) << 4;
  w |= MODELS.indexOf(f.sidModels[1]) << 6;
  w |= MODELS.indexOf(f.sidModels[2]) << 8;
  return w;
}

// ---- parse -----------------------------------------------------------------------------
export function parseSidFile(bytes: Uint8Array, options: ParseOptions = {}): SidFile {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) throw new SidFileError("too_large", `${bytes.length} bytes exceed the limit of ${maxBytes}`);
  if (bytes.length < 6) throw new SidFileError("truncated", "file is shorter than the 6 byte magic and version");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicText = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magicText !== "PSID" && magicText !== "RSID") throw new SidFileError("bad_magic", `bad magic ${JSON.stringify(magicText)}`);
  const magic = magicText;
  const version = dv.getUint16(4);
  if (version < 1 || version > 4) throw new SidFileError("bad_version", `unsupported version ${version}`);
  if (magic === "RSID" && version < 2) throw new SidFileError("bad_version", "RSID requires version 2, 3 or 4");
  const headerSize = version === 1 ? HEADER_V1 : HEADER_V2;
  if (bytes.length < headerSize) throw new SidFileError("truncated", `header needs ${headerSize} bytes, file has ${bytes.length}`);
  const dataOffset = dv.getUint16(6);
  if (dataOffset !== headerSize) {
    throw new SidFileError("bad_data_offset", `dataOffset ${hex(dataOffset)} must be ${hex(headerSize)} for version ${version}`);
  }

  const warnings: string[] = [];
  const headerLoadAddress = dv.getUint16(8);
  let data = bytes.subarray(dataOffset);
  let loadAddress = headerLoadAddress;
  if (headerLoadAddress === 0) {
    if (data.length < 2) throw new SidFileError("truncated", "no data bytes for the embedded load address");
    loadAddress = data[0] | (data[1] << 8);
    data = data.subarray(2);
  }
  if (data.length === 0) warnings.push("truncated: payload is empty");

  const strings = [0x16, 0x36, 0x56].map((o) => decodeString(bytes.subarray(o, o + 32)));
  strings.forEach((s, i) => {
    if (s.garbageAfterNul) warnings.push(`bad_string: ${["name", "author", "released"][i]} has non-zero bytes after its terminator`);
  });

  let flags = 0;
  let startPage = 0;
  let pageLength = 0;
  let secondByte = 0;
  let thirdByte = 0;
  if (version >= 2) {
    flags = dv.getUint16(0x76);
    startPage = bytes[0x78];
    pageLength = bytes[0x79];
    secondByte = bytes[0x7a];
    thirdByte = bytes[0x7b];
  }
  // Lenient parsing: recoverable deviations become warnings and the offending value is ignored.
  // The writer (validate) stays strict and rejects the same inputs.
  let startSong = dv.getUint16(0x10);
  if (startSong === 0) {
    warnings.push("bad_start_song: startSong 0 is treated as 1");
    startSong = 1;
  }
  if (version < 3 && secondByte !== 0) {
    warnings.push(`bad_sid_address: second SID byte ${hex(secondByte, 2)} is ignored in version ${version}`);
    secondByte = 0;
  }
  if (version < 4 && thirdByte !== 0) {
    warnings.push(`bad_sid_address: third SID byte ${hex(thirdByte, 2)} is ignored in version ${version}`);
    thirdByte = 0;
  }
  if (startPage === 0 || startPage === 0xff) {
    if (pageLength !== 0) {
      warnings.push(`bad_reloc: pageLength ${pageLength} with startPage ${hex(startPage, 2)} is ignored`);
      pageLength = 0;
    }
  } else if (startPage + pageLength > 0x100) {
    warnings.push(`bad_reloc: relocation range ${hex(startPage, 2)}+${pageLength} pages runs past page $FF and is ignored`);
    pageLength = 0;
  }
  if (flags & 0xfc00) warnings.push(`bad_field: reserved flag bits ${hex(flags & 0xfc00)} are set`);
  const sidAddr = (b: number, name: string): number | undefined => {
    if (b === 0) return undefined;
    if (!isValidSidAddressByte(b)) {
      warnings.push(`bad_sid_address: ${name} byte ${hex(b, 2)} is invalid and is ignored`);
      return undefined;
    }
    return sidByteToAddress(b);
  };

  const file: SidFile = {
    magic,
    version: version as 1 | 2 | 3 | 4,
    dataOffset,
    loadAddress,
    headerLoadAddress,
    initAddress: dv.getUint16(0x0a),
    playAddress: dv.getUint16(0x0c),
    songs: dv.getUint16(0x0e),
    startSong,
    speed: dv.getUint32(0x12),
    name: strings[0].text,
    author: strings[1].text,
    released: strings[2].text,
    musPlayer: (flags & 1) !== 0,
    psidSpecific: magic === "PSID" && (flags & 2) !== 0,
    basic: magic === "RSID" && (flags & 2) !== 0,
    clock: CLOCKS[(flags >> 2) & 3],
    sidModels: [MODELS[(flags >> 4) & 3], MODELS[(flags >> 6) & 3], MODELS[(flags >> 8) & 3]],
    startPage,
    pageLength,
    secondSidAddress: sidAddr(secondByte, "secondSidAddress"),
    thirdSidAddress: sidAddr(thirdByte, "thirdSidAddress"),
    payload: data.slice(),
    warnings,
  };
  if (file.secondSidAddress !== undefined && file.secondSidAddress === file.thirdSidAddress) {
    warnings.push("bad_sid_address: third SID address equals the second and is ignored");
    file.thirdSidAddress = undefined;
  }

  for (const issue of validate(file)) {
    if (issue.level === "error") throw new SidFileError(issue.code, issue.message);
    warnings.push(`${issue.code}: ${issue.message}`);
  }
  return file;
}

// ---- write -----------------------------------------------------------------------------
export function writeSidFile(input: SidFileInput, options: WriteOptions = {}): Uint8Array {
  const strict = options.strict ?? true;
  const headerLoadAddress = input.headerLoadAddress ?? 0;
  const f: Fields = {
    magic: input.magic,
    version: input.version,
    loadAddress: input.loadAddress,
    headerLoadAddress,
    initAddress: input.initAddress,
    playAddress: input.playAddress,
    songs: input.songs,
    startSong: input.startSong,
    speed: input.speed,
    name: input.name,
    author: input.author,
    released: input.released,
    musPlayer: input.musPlayer ?? false,
    psidSpecific: input.psidSpecific ?? false,
    basic: input.basic ?? false,
    clock: input.clock ?? "unknown",
    sidModels: input.sidModels ?? ["unknown", "unknown", "unknown"],
    startPage: input.startPage ?? 0,
    pageLength: input.pageLength ?? 0,
    secondSidAddress: input.secondSidAddress,
    thirdSidAddress: input.thirdSidAddress,
    payload: input.payload,
  };
  if (f.magic === "RSID" && f.psidSpecific) throw new SidFileError("bad_field", "psidSpecific applies to PSID; use basic for RSID");
  if (f.magic === "PSID" && f.basic) throw new SidFileError("bad_field", "basic applies to RSID; use psidSpecific for PSID");
  if (!CLOCKS.includes(f.clock)) throw new SidFileError("bad_field", `unknown clock ${f.clock}`);
  if (f.sidModels.length !== 3 || f.sidModels.some((m) => !MODELS.includes(m))) throw new SidFileError("bad_field", "invalid sidModels");
  for (const issue of validate(f)) {
    if (issue.level === "error" || strict) throw new SidFileError(issue.code, issue.message);
  }

  const headerSize = f.version === 1 ? HEADER_V1 : HEADER_V2;
  const prefix = headerLoadAddress === 0 ? 2 : 0;
  const out = new Uint8Array(headerSize + prefix + f.payload.length);
  const dv = new DataView(out.buffer);
  out.set([...f.magic].map((c) => c.charCodeAt(0)), 0);
  dv.setUint16(4, f.version);
  dv.setUint16(6, headerSize);
  dv.setUint16(8, headerLoadAddress);
  dv.setUint16(0x0a, f.initAddress);
  dv.setUint16(0x0c, f.playAddress);
  dv.setUint16(0x0e, f.songs);
  dv.setUint16(0x10, f.startSong);
  dv.setUint32(0x12, f.speed);
  out.set(encodeString(f.name, "name"), 0x16);
  out.set(encodeString(f.author, "author"), 0x36);
  out.set(encodeString(f.released, "released"), 0x56);
  if (f.version >= 2) {
    dv.setUint16(0x76, flagsWord(f));
    out[0x78] = f.startPage;
    out[0x79] = f.pageLength;
    out[0x7a] = f.secondSidAddress === undefined ? 0 : (f.secondSidAddress - 0xd000) / 16;
    out[0x7b] = f.thirdSidAddress === undefined ? 0 : (f.thirdSidAddress - 0xd000) / 16;
  }
  if (prefix) {
    out[headerSize] = f.loadAddress & 0xff;
    out[headerSize + 1] = f.loadAddress >> 8;
  }
  out.set(f.payload, headerSize + prefix);
  return out;
}

// ---- helpers: subtunes, speed, MD5 -----------------------------------------------------
/** 1-based song numbers 1..songs. */
export function subtunes(file: Pick<SidFile, "songs">): number[] {
  return Array.from({ length: file.songs }, (_, i) => i + 1);
}

/**
 * Speed of a song. Version 1 files and PSID v2+ files with the PlaySID-specific flag wrap
 * (song 33 uses bit 0). Other v2+ files (including RSID, whose speed must be 0) use bit 31
 * for every song above 32.
 *
 * Spec ambiguity: PSID v2 and v2NG share version number 2 (SID_file_format.txt, lines 211-224).
 * A v2 file without the PlaySID flag may be either, so it cannot be told whether songs above 32
 * wrap (v2) or share bit 31 (v2NG). This function keeps the clamp (bit 31) for such files.
 */
export function songSpeed(
  file: Pick<SidFile, "version" | "magic" | "psidSpecific" | "speed" | "songs">,
  song: number,
): SongSpeed {
  if (!Number.isInteger(song) || song < 1 || song > file.songs) throw new RangeError(`song ${song} is outside 1..${file.songs}`);
  const wrap = file.version === 1 || (file.magic === "PSID" && file.psidSpecific);
  const bit = wrap ? (song - 1) % 32 : Math.min(song - 1, 31);
  return ((file.speed >>> bit) & 1) === 1 ? "CIA" : "VBI";
}

/** Effective init address (0 in the header means the load address). */
export function effectiveInitAddress(file: Pick<SidFile, "initAddress" | "loadAddress">): number {
  return file.initAddress === 0 ? file.loadAddress : file.initAddress;
}

/** Songlengths.md5 key: lower-case hex MD5 of the whole file (new-format Songlengths MD5, full file). */
export function md5ForSonglengths(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}
