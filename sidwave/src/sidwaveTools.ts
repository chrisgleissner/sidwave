// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { SidwaveOperationError } from "./cliCore.js";
import { createLibsidplayfpEngine } from "./engine/libsidplayfp.js";
import type { SidClock, SidEmulation, SidEngine, SystemRoms } from "./engine/types.js";
import { md5ForSonglengths, parseSidFile, songSpeed, subtunes } from "./sidFile.js";
import { lookupSonglength, parseSonglengths, type SonglengthsDb } from "./songlengths.js";
import { parseSidwave } from "./sidwave.js";
import { compileSidwaveBytes, confinedReadOptions, type CompileSummary } from "./sidwaveOps.js";
import { MAX_VERIFY_SECONDS, verifySid, type A1Rules, type VerifyResult } from "./verify/index.js";
import { loadA1Rules } from "./verify/a1.js";

/**
 * Operations behind the `sidwave verify`, `render`, `trace` and `sid-info` commands. The command line only parses
 * arguments and prints; every operation is a function here and fails with a SidwaveOperationError (or an error
 * that classifyError maps to a category).
 */

export type VerifyLevel = "T0" | "T1" | "A0" | "A1";
export const VERIFY_LEVELS: readonly VerifyLevel[] = ["T0", "T1", "A0", "A1"];
export const DEFAULT_HORIZON_SECONDS = 30;

export interface RunControl {
  signal?: AbortSignal;
  onProgress?: (label: string, fraction: number) => void;
  /** Largest number of audio seconds one render or trace may cover. */
  maxSeconds?: number;
  /** Largest number of SID writes one trace may hold. */
  maxRecords?: number;
  /** Largest input file or output size in bytes. */
  maxBytes?: number;
  createEngine?: (emulation: SidEmulation) => SidEngine;
}

export interface LoadedTune {
  /** The file the tune came from, as given. */
  source: string;
  kind: "sid" | "score";
  /** The PSID bytes; a score is compiled to PSID. */
  bytes: Uint8Array;
  md5: string;
  /** Duration of one pass of a score. */
  durationSeconds?: number;
  compiled?: CompileSummary;
}

export interface LoadOptions {
  cwd: string;
  allowDirs?: readonly string[];
  maxBytes?: number;
}

function limitError(what: string, size: number, max: number): SidwaveOperationError {
  return new SidwaveOperationError("limit_exceeded", `${what} is ${size} bytes; the limit is ${max} bytes`, { size, max });
}

export function readInput(file: string, options: { cwd: string; maxBytes?: number }): Uint8Array {
  const path = resolve(options.cwd, file);
  try {
    const size = statSync(path).size;
    if (options.maxBytes !== undefined && size > options.maxBytes) throw limitError(file, size, options.maxBytes);
    return readFileSync(path);
  } catch (error) {
    if (error instanceof SidwaveOperationError) throw error;
    throw new SidwaveOperationError("input", `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file });
  }
}

const isPsid = (bytes: Uint8Array) => bytes.length >= 4 && ["PSID", "RSID"].includes(String.fromCharCode(...bytes.subarray(0, 4)));

/** Reads a SID file, or reads a SIDWave score and compiles it to a PSID with the production compiler. */
export function loadTune(file: string, options: LoadOptions): LoadedTune {
  const bytes = readInput(file, options);
  const extension = extname(file).toLowerCase();
  if (extension === ".sid" || extension === ".psid" || isPsid(bytes)) {
    parseSidFile(bytes);
    return { source: file, kind: "sid", bytes, md5: md5ForSonglengths(bytes) };
  }
  const doc = parseSidwave(Buffer.from(bytes).toString("utf8"), confinedReadOptions(options.cwd, options.allowDirs));
  const compiled = compileSidwaveBytes(doc, { format: "sid" });
  const sid = new Uint8Array(compiled.bytes);
  return { source: file, kind: "score", bytes: sid, md5: md5ForSonglengths(sid), durationSeconds: compiled.summary.durationSeconds, compiled: compiled.summary };
}

export interface SidInfo {
  magic: string;
  version: number;
  name: string;
  author: string;
  released: string;
  songs: number;
  startSong: number;
  loadAddress: number;
  initAddress: number;
  playAddress: number;
  clock: string;
  sidModels: string[];
  secondSidAddress?: number;
  thirdSidAddress?: number;
  speeds: Array<"VBI" | "CIA">;
  sizeBytes: number;
  payloadBytes: number;
  md5: string;
  warnings: string[];
  /** Lengths in seconds from the songlengths database, one per song, where the database has the file. */
  songlengths?: Array<number | null>;
}

export function readSonglengths(file: string, options: { cwd: string; maxBytes?: number }): SonglengthsDb {
  return parseSonglengths(Buffer.from(readInput(file, options)).toString("utf8"));
}

export function sidInfo(bytes: Uint8Array, options: { songlengths?: SonglengthsDb } = {}): SidInfo {
  const file = parseSidFile(bytes);
  const info: SidInfo = {
    magic: file.magic, version: file.version, name: file.name, author: file.author, released: file.released,
    songs: file.songs, startSong: file.startSong, loadAddress: file.loadAddress, initAddress: file.initAddress,
    playAddress: file.playAddress, clock: file.clock, sidModels: [...file.sidModels],
    ...(file.secondSidAddress === undefined ? {} : { secondSidAddress: file.secondSidAddress }),
    ...(file.thirdSidAddress === undefined ? {} : { thirdSidAddress: file.thirdSidAddress }),
    speeds: subtunes(file).map((song) => songSpeed(file, song)),
    sizeBytes: bytes.length, payloadBytes: file.payload.length, md5: md5ForSonglengths(bytes), warnings: file.warnings,
  };
  if (options.songlengths) {
    info.songlengths = subtunes(file).map((song) => {
      const ms = lookupSonglength(options.songlengths!, bytes, song);
      return ms === undefined ? null : ms / 1000;
    });
  }
  return info;
}

function engineFor(control: RunControl, emulation: SidEmulation): SidEngine {
  return control.createEngine ? control.createEngine(emulation) : createLibsidplayfpEngine({ emulation });
}

export const ROM_FILES = { kernal: "kernal.rom", basic: "basic.rom", chargen: "chargen.rom" } as const;

export interface LoadedRoms {
  roms: SystemRoms;
  /** SHA-256 of each ROM that was found. */
  hashes: { kernal?: string; basic?: string; chargen?: string };
}

/** Reads kernal.rom, basic.rom and chargen.rom from `dir`; a ROM that is missing is left out. */
export function loadRoms(dir: string, options: { cwd: string }): LoadedRoms {
  const roots = resolve(options.cwd, dir);
  const roms: SystemRoms = {};
  const hashes: LoadedRoms["hashes"] = {};
  let found = 0;
  for (const [name, file] of Object.entries(ROM_FILES) as Array<[keyof typeof ROM_FILES, string]>) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(roots, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SidwaveOperationError("input", `cannot read ${file} in ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { dir });
    }
    roms[name] = new Uint8Array(bytes);
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
    found++;
  }
  if (found === 0) throw new SidwaveOperationError("input", `${dir} holds none of ${Object.values(ROM_FILES).join(", ")}`, { dir });
  return { roms, hashes };
}

function checkSeconds(seconds: number, control: RunControl): void {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new SidwaveOperationError("usage", "seconds must be a positive number");
  const max = control.maxSeconds ?? MAX_VERIFY_SECONDS;
  if (seconds > max) throw new SidwaveOperationError("limit_exceeded", `${seconds} s exceeds the limit of ${max} s`, { seconds, max });
}

/** Horizon when --seconds is not given: one pass of a score, else the songlengths entry, else 30 s; at most 180 s. */
export function defaultHorizon(tune: LoadedTune, song: number | undefined, songlengths: SonglengthsDb | undefined): number {
  const fromDb = songlengths ? lookupSonglength(songlengths, tune.bytes, song ?? 1) : undefined;
  const seconds = tune.durationSeconds ?? (fromDb === undefined ? undefined : fromDb / 1000) ?? DEFAULT_HORIZON_SECONDS;
  return Math.max(0.1, Math.min(seconds, MAX_VERIFY_SECONDS));
}

// ---------------------------------------------------------------------------------------------------------
// render

export interface RenderTuneOptions extends RunControl {
  song?: number;
  seconds: number;
  sampleRate?: number;
  model?: "6581" | "8580";
  clock?: SidClock;
  emulation?: SidEmulation;
  roms?: SystemRoms;
}

export interface RenderTuneSummary {
  seconds: number;
  sampleRate: number;
  channels: 1;
  samples: number;
  wavBytes: number;
  engine: { id: string; version: string; emulation: SidEmulation };
  md5: string;
  sha256: string;
}

/** A 16-bit PCM WAV file. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels: 1 | 2 = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

export async function renderTune(tune: LoadedTune, options: RenderTuneOptions): Promise<{ wav: Uint8Array; summary: RenderTuneSummary }> {
  checkSeconds(options.seconds, options);
  const emulation = options.emulation ?? "residfp";
  const sampleRate = options.sampleRate ?? 48_000;
  const estimated = 44 + Math.ceil(options.seconds * sampleRate) * 2;
  if (options.maxBytes !== undefined && estimated > options.maxBytes) throw limitError("the WAV output", estimated, options.maxBytes);
  const engine = engineFor(options, emulation);
  const result = await engine.render({
    sid: tune.bytes, seconds: options.seconds, sampleRate, channels: 1,
    ...(options.song === undefined ? {} : { song: options.song }),
    ...(options.model ? { model: options.model } : {}), ...(options.clock ? { clock: options.clock } : {}),
    ...(options.roms ? { roms: options.roms } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxSeconds === undefined ? {} : { maxSeconds: options.maxSeconds }),
    ...(options.onProgress ? { onProgress: (f: number) => options.onProgress!("render", f) } : {}),
  });
  const wav = encodeWav(result.samples, result.sampleRate, 1);
  return {
    wav,
    summary: {
      seconds: result.seconds, sampleRate: result.sampleRate, channels: 1, samples: result.samples.length, wavBytes: wav.length,
      engine: { id: result.engine.id, version: result.engine.version, emulation: result.engine.emulation },
      md5: result.md5, sha256: createHash("sha256").update(wav).digest("hex"),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// trace

export type TraceFormat = "csv" | "jsonl";

export interface TraceTuneOptions extends RunControl {
  song?: number;
  seconds: number;
  format?: TraceFormat;
  clock?: SidClock;
  emulation?: SidEmulation;
  roms?: SystemRoms;
}

export interface TraceTuneSummary {
  format: TraceFormat;
  records: number;
  clock: SidClock;
  originCycle: number;
  horizonCycles: number;
  seconds: number;
  outputBytes: number;
}

export function formatTrace(records: Float64Array, format: TraceFormat): string {
  const lines: string[] = format === "csv" ? ["sid,address,value,cycle"] : [];
  for (let i = 0; i < records.length; i += 4) {
    const [sid, address, value, cycle] = [records[i]!, records[i + 1]!, records[i + 2]!, records[i + 3]!];
    lines.push(format === "csv" ? `${sid},${address},${value},${cycle}` : JSON.stringify({ sid, address, value, cycle }));
  }
  return `${lines.join("\n")}\n`;
}

export async function traceTune(tune: LoadedTune, options: TraceTuneOptions): Promise<{ text: string; summary: TraceTuneSummary }> {
  checkSeconds(options.seconds, options);
  const format = options.format ?? "csv";
  const engine = engineFor(options, options.emulation ?? "sidlite");
  const result = await engine.trace({
    sid: tune.bytes, seconds: options.seconds, sampleRate: 48_000, channels: 1,
    ...(options.song === undefined ? {} : { song: options.song }),
    ...(options.clock ? { clock: options.clock } : {}), ...(options.roms ? { roms: options.roms } : {}),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxSeconds === undefined ? {} : { maxSeconds: options.maxSeconds }),
    ...(options.onProgress ? { onProgress: (f: number) => options.onProgress!("trace", f) } : {}),
  });
  const text = formatTrace(result.records, format);
  if (options.maxBytes !== undefined && text.length > options.maxBytes) throw limitError("the trace output", text.length, options.maxBytes);
  return {
    text,
    summary: {
      format, records: result.count, clock: result.clock, originCycle: result.originCycle, horizonCycles: result.horizonCycles,
      seconds: result.seconds, outputBytes: Buffer.byteLength(text),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// verify

export interface VerifyTunesOptions extends RunControl {
  /** The weakest level that counts as a pass. Default A1. */
  level?: VerifyLevel;
  song?: number;
  seconds: number;
  toleranceCycles?: number;
  clock?: SidClock;
  roms?: SystemRoms;
  romHashes?: LoadedRoms["hashes"];
  /** Rule set for A1. Default: the frozen rule file shipped with the package. */
  rules?: A1Rules;
}

export interface VerifyReport {
  /** "pass" when a level up to the requested one was reached, else "fail". */
  verdict: "pass" | "fail";
  requestedLevel: VerifyLevel;
  /** Highest level reached: the strongest level that passed, or "none". */
  level: VerifyResult["level"];
  levels: VerifyResult["levels"];
  horizon: VerifyResult["horizon"];
  firstDifference?: VerifyResult["firstDifference"];
  a1?: VerifyResult["a1"];
  engines: VerifyResult["engines"];
  reference: { source: string; kind: "sid" | "score"; md5: string };
  candidate: { source: string; kind: "sid" | "score"; md5: string };
}

export async function verifyTunes(reference: LoadedTune, candidate: LoadedTune, options: VerifyTunesOptions): Promise<VerifyReport> {
  const requested = options.level ?? "A1";
  const rank = VERIFY_LEVELS.indexOf(requested);
  checkSeconds(options.seconds, options);
  const traceEngine = engineFor(options, "sidlite");
  const progress = options.onProgress;
  const result = await verifySid(reference.bytes, candidate.bytes, {
    engine: traceEngine,
    seconds: options.seconds,
    ...(options.song === undefined ? {} : { song: options.song }),
    ...(options.toleranceCycles === undefined ? {} : { toleranceCycles: options.toleranceCycles }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(rank >= 2 ? { pcmEngine: traceEngine } : {}),
    ...(rank >= 3
      ? {
        a1: {
          engine: engineFor(options, "residfp"),
          rules: options.rules ?? loadRulesOrFail(),
          ...(options.roms ? { roms: options.roms } : {}),
          ...(options.romHashes ? { romHashes: options.romHashes } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(progress ? { onProgress: (f: number) => progress("A1 render", f) } : {}),
        },
      }
      : {}),
  });
  const reached = result.level === "none" ? -1 : VERIFY_LEVELS.indexOf(result.level);
  const verdict = reached >= 0 && reached <= rank ? "pass" : "fail";
  return {
    verdict, requestedLevel: requested, level: result.level, levels: result.levels, horizon: result.horizon,
    ...(result.firstDifference ? { firstDifference: result.firstDifference } : {}),
    ...(result.a1 ? { a1: result.a1 } : {}),
    engines: result.engines,
    reference: { source: reference.source, kind: reference.kind, md5: reference.md5 },
    candidate: { source: candidate.source, kind: candidate.kind, md5: candidate.md5 },
  };
}

function loadRulesOrFail(): A1Rules {
  try {
    return loadA1Rules();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SidwaveOperationError("input", "The frozen A1 rule file is missing from the package; pass --a1-rules <file> or use --level A0", {});
    }
    throw error;
  }
}
