// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// ProTracker MOD reader: 31-sample files (M.K., M!K!, FLT4, FLT8, 4CHN, 6CHN, 8CHN, nnCH, CD81, TDZn), and the 15-sample
// Soundtracker layout. Written from the published ProTracker module format description; no player or converter source is used.

import { InterchangeInputError } from "./errors.js";

export const MOD_MAX_BYTES = 8 * 1024 * 1024;
export const MOD_MAX_CHANNELS = 32;
export const MOD_MAX_PATTERNS = 128;
export const MOD_ROWS = 64;

/** A malformed or unsupported MOD file. Classified as `input`. */
export class ModError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "ModError"; }
}

export interface ModSample {
  name: string;
  /** Length in bytes of the sample data that is present in the file. */
  length: number;
  /** Signed finetune, -8..7. */
  finetune: number;
  /** Default volume, 0..64. */
  volume: number;
  /** Loop start and length in bytes; a loop of 2 bytes or less means no loop. */
  loopStart: number;
  loopLength: number;
  looped: boolean;
  data: Int8Array;
}

export interface ModPattern {
  /** Period, sample number (0 = none), effect (0..15) and effect parameter, indexed `row * channels + channel`. */
  period: Uint16Array;
  sample: Uint8Array;
  effect: Uint8Array;
  param: Uint8Array;
}

export interface ModSong {
  /** `M.K.`, `FLT4`, `6CHN`, ... or `15-sample` for a Soundtracker file. */
  variant: string;
  title: string;
  channels: number;
  sampleCount: 15 | 31;
  samples: ModSample[];
  songLength: number;
  restart: number;
  /** The 128 order list entries, already divided by two for FLT8. */
  orders: Uint8Array;
  patterns: ModPattern[];
  warnings: string[];
}

const text = (bytes: Uint8Array, from: number, length: number): string => {
  let out = "";
  for (let i = from; i < from + length && bytes[i]; i++) out += bytes[i]! >= 32 && bytes[i]! < 127 ? String.fromCharCode(bytes[i]!) : "?";
  return out.trimEnd();
};

/** Channel count of a 31-sample signature, or undefined. */
function signatureChannels(sig: string): { channels: number; flt8: boolean } | undefined {
  if (sig === "M.K." || sig === "M!K!" || sig === "FLT4" || sig === "4CHN" || sig === "M&K!" || sig === "N.T.") return { channels: 4, flt8: false };
  if (sig === "FLT8") return { channels: 8, flt8: true };
  if (sig === "CD81" || sig === "OCTA") return { channels: 8, flt8: false };
  let m = /^(\d)CHN$/.exec(sig);
  if (m && Number(m[1]) >= 1) return { channels: Number(m[1]), flt8: false };
  m = /^(\d\d)CH$/.exec(sig);
  if (m && Number(m[1]) >= 10 && Number(m[1]) <= MOD_MAX_CHANNELS) return { channels: Number(m[1]), flt8: false };
  m = /^TDZ([1-3])$/.exec(sig);
  if (m) return { channels: Number(m[1]), flt8: false };
  return undefined;
}

function readSamples(bytes: Uint8Array, count: number, warnings: string[]): { samples: ModSample[]; lengths: number[] } {
  const samples: ModSample[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 30;
    const words = (bytes[at + 22]! << 8) | bytes[at + 23]!;
    const ft = bytes[at + 24]! & 15;
    const loopWords = (bytes[at + 28]! << 8) | bytes[at + 29]!;
    const loopStartWords = (bytes[at + 26]! << 8) | bytes[at + 27]!;
    const volume = bytes[at + 25]!;
    lengths.push(words * 2);
    if (volume > 64) warnings.push(`sample ${i + 1}: volume ${volume} is above 64 and is clamped`);
    samples.push({
      name: text(bytes, at, 22), length: 0, finetune: ft > 7 ? ft - 16 : ft, volume: Math.min(64, volume),
      loopStart: loopStartWords * 2, loopLength: loopWords * 2, looped: false, data: new Int8Array(0),
    });
  }
  return { samples, lengths };
}

/** Reads a MOD file. Throws ModError for anything that is not a plausible MOD; never reads outside the buffer. */
export function parseMod(bytes: Uint8Array): ModSong {
  if (bytes.length > MOD_MAX_BYTES) throw new ModError(`the file is ${bytes.length} bytes; the limit is ${MOD_MAX_BYTES}`);
  if (bytes.length < 600) throw new ModError("the file is too short for a MOD");
  const warnings: string[] = [];
  let variant = "";
  let channels = 4;
  let flt8 = false;
  let sampleCount: 15 | 31 = 31;
  if (bytes.length >= 1084) {
    const sig = String.fromCharCode(bytes[1080]!, bytes[1081]!, bytes[1082]!, bytes[1083]!);
    const found = signatureChannels(sig);
    if (found) { variant = sig; channels = found.channels; flt8 = found.flt8; }
  }
  if (!variant) { sampleCount = 15; variant = "15-sample"; }
  const headerSize = sampleCount === 31 ? 1084 : 600;
  const lengthAt = 20 + sampleCount * 30;
  const { samples, lengths } = readSamples(bytes, sampleCount, warnings);
  let songLength = bytes[lengthAt]!;
  const restart = bytes[lengthAt + 1]!;
  const orders = Uint8Array.from(bytes.subarray(lengthAt + 2, lengthAt + 2 + 128));
  if (songLength === 0) throw new ModError("the song length is 0");
  if (songLength > 128) { warnings.push(`the song length ${songLength} is above 128 and is clamped to 128`); songLength = 128; }
  let maxOrder = 0;
  for (const o of orders) if (o > maxOrder) maxOrder = o;
  if (flt8) for (let i = 0; i < 128; i++) orders[i] = orders[i]! >> 1;
  const patternCount = flt8 ? (maxOrder >> 1) + 1 : maxOrder + 1;
  const stored = flt8 ? patternCount * 2 : patternCount;
  if (patternCount > MOD_MAX_PATTERNS) throw new ModError(`the order list names pattern ${patternCount - 1}; the limit is ${MOD_MAX_PATTERNS - 1}`);
  const blockChannels = flt8 ? 4 : channels;
  const patternBytes = MOD_ROWS * blockChannels * 4;
  const patternsEnd = headerSize + stored * patternBytes;
  if (patternsEnd > bytes.length) throw new ModError(`the file ends inside the pattern data (needs ${patternsEnd} bytes, has ${bytes.length})`);
  const maxSampleNumber = sampleCount;
  const patterns: ModPattern[] = [];
  let invalid = 0;
  for (let p = 0; p < patternCount; p++) {
    const pat: ModPattern = {
      period: new Uint16Array(MOD_ROWS * channels), sample: new Uint8Array(MOD_ROWS * channels),
      effect: new Uint8Array(MOD_ROWS * channels), param: new Uint8Array(MOD_ROWS * channels),
    };
    for (let block = 0; block < (flt8 ? 2 : 1); block++) {
      const base = headerSize + (flt8 ? p * 2 + block : p) * patternBytes;
      for (let row = 0; row < MOD_ROWS; row++) {
        for (let c = 0; c < blockChannels; c++) {
          const at = base + (row * blockChannels + c) * 4;
          const b0 = bytes[at]!, b1 = bytes[at + 1]!, b2 = bytes[at + 2]!, b3 = bytes[at + 3]!;
          const idx = row * channels + block * 4 + c;
          // The upper nibble of byte 0 is the high nibble of the sample number; the 15-sample layout has no such nibble.
          const sample = sampleCount === 31 ? (b0 & 0xf0) | (b2 >> 4) : b2 >> 4;
          const period = ((b0 & 0x0f) << 8) | b1;
          if (sampleCount === 15 && (b0 & 0xf0) !== 0) invalid++;
          if (period !== 0 && (period < 28 || period > 1712)) invalid++;
          pat.period[idx] = period; pat.sample[idx] = sample > maxSampleNumber ? 0 : sample;
          pat.effect[idx] = b2 & 15; pat.param[idx] = b3;
        }
      }
    }
    patterns.push(pat);
  }
  if (sampleCount === 15 && invalid > 0) throw new ModError("the file has no MOD signature and its pattern data is not a valid 15-sample module");
  if (sampleCount === 31 && invalid > 0) warnings.push(`${invalid} pattern cell(s) have a period outside 28..1712 or ignored bits; the periods are kept and clamped when notes are chosen`);
  // Sample data follows the patterns, sample after sample; a file that is short is read as far as it goes.
  let at = patternsEnd;
  let missing = 0;
  for (let i = 0; i < sampleCount; i++) {
    const want = lengths[i]!;
    const have = Math.max(0, Math.min(want, bytes.length - at));
    missing += want - have;
    const s = samples[i]!;
    s.length = have;
    s.data = new Int8Array(have);
    for (let k = 0; k < have; k++) s.data[k] = (bytes[at + k]! << 24) >> 24;
    at += want;
    s.looped = s.loopLength > 2 && s.loopStart < have;
    if (s.looped && s.loopStart + s.loopLength > have) s.loopLength = have - s.loopStart;
    if (s.looped && s.loopLength <= 2) s.looped = false;
  }
  if (missing) warnings.push(`the file ends ${missing} byte(s) before the end of the sample data`);
  return { variant, title: text(bytes, 0, 20), channels, sampleCount, samples, songLength, restart, orders, patterns, warnings };
}

/** True when the bytes look like a MOD: a known signature, or a plausible 15-sample module. Cheap; does not read sample data. */
export function looksLikeMod(bytes: Uint8Array): boolean {
  if (bytes.length >= 1084) {
    const sig = String.fromCharCode(bytes[1080]!, bytes[1081]!, bytes[1082]!, bytes[1083]!);
    if (signatureChannels(sig)) return true;
  }
  return false;
}

/** True when a 15-sample MOD passes the parser's plausibility checks. */
export function looksLikeFifteenSampleMod(bytes: Uint8Array): boolean {
  try { return parseMod(bytes).sampleCount === 15; } catch (error) {
    if (error instanceof ModError) return false;
    throw error;
  }
}

// Period of a note, in note numbers relative to period 428 = MIDI 48 (ProTracker C-2). Finetune scales a period by 2^(-ft/96).
// The sample is played at 7093789.2 / (2 x period) points per second (PAL), so period 428 sounds as MIDI 48 (129.5 Hz) when
// one cycle of the waveform is 64 points long. Other cycle lengths shift the pitch.
export const MOD_REFERENCE_PERIOD = 428;
export const MOD_REFERENCE_MIDI = 48;
export const MOD_REFERENCE_CYCLE = 64;

/**
 * Nearest MIDI note of a period played by a sample with the given finetune (-8..7). `tuning` is added before rounding:
 * the semitones by which the sample sounds above a sample with a cycle of 64 points.
 */
export function periodToMidi(period: number, finetune = 0, tuning = 0): number {
  const base = period * 2 ** (finetune / 96);
  return MOD_REFERENCE_MIDI + Math.round(12 * Math.log2(MOD_REFERENCE_PERIOD / base) + tuning);
}

/** Period of a MIDI note at finetune 0, as a real number. */
export function midiToPeriod(midi: number): number {
  return MOD_REFERENCE_PERIOD * 2 ** ((MOD_REFERENCE_MIDI - midi) / 12);
}
