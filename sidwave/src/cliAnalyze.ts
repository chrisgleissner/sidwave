// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// `sidwave analyze`, `compare`, `isolate`, `preserve` and `extract-instruments`, on the shared CLI contract of
// cliCore.ts. Each command is a thin wrapper of a function of src/analyze; this file holds the argument handling and
// the output only, and cli.ts holds one line of dispatch.

import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, envelope, type CliIo } from "./cliCore.js";
import { analyzeScore, analyzeSid, formatAnalysis } from "./analyze/analysis.js";
import { compare, formatCompare, type CompareInput } from "./analyze/compare.js";
import { extractInstruments } from "./analyze/instruments.js";
import { isolateVoice } from "./analyze/isolate.js";
import { createPreservation, formatPreservation, verifyPreservation, writePreservation } from "./analyze/preserve.js";
import { createLibsidplayfpEngine } from "./engine/libsidplayfp.js";
import type { SidEmulation, SidEngine } from "./engine/types.js";
import { parseSidFile } from "./sidFile.js";
import { confinedReadOptions } from "./sidwaveOps.js";
import { defaultHorizon, loadRoms, loadTune, readInput, readSonglengths, type LoadedTune } from "./sidwaveTools.js";
import { parseA1Rules } from "./verify/a1.js";
import type { RunFlags } from "./cliVerify.js";

/** Flags of these commands. cli.ts hands every flag to takeAnalyzeFlag together with the command name. */
export interface AnalyzeFlags {
  voice?: number;
  mute?: boolean;
  includeOriginal?: boolean;
  rightsPermitted?: boolean;
  verify?: boolean;
  noLadder?: boolean;
  name?: string;
  licence?: string;
  author?: string;
  created?: string;
  stil?: string;
  stilPath?: string;
}

const FLAGS: Record<string, { key: keyof AnalyzeFlags; value: boolean; commands: string[] }> = {
  "--voice": { key: "voice", value: true, commands: ["isolate"] },
  "--mute": { key: "mute", value: false, commands: ["isolate"] },
  "--include-original": { key: "includeOriginal", value: false, commands: ["preserve"] },
  "--rights-permitted": { key: "rightsPermitted", value: false, commands: ["preserve"] },
  "--verify": { key: "verify", value: false, commands: ["preserve"] },
  "--no-ladder": { key: "noLadder", value: false, commands: ["compare", "preserve"] },
  "--name": { key: "name", value: true, commands: ["extract-instruments"] },
  "--licence": { key: "licence", value: true, commands: ["extract-instruments"] },
  "--author": { key: "author", value: true, commands: ["extract-instruments"] },
  "--created": { key: "created", value: true, commands: ["extract-instruments"] },
  "--stil": { key: "stil", value: true, commands: ["preserve"] },
  "--stil-path": { key: "stilPath", value: true, commands: ["preserve"] },
};

/** Consumes `arg` when it is a flag of `command` (one of the commands of this file). */
export function takeAnalyzeFlag(command: string, flags: AnalyzeFlags, arg: string, inline: string | undefined, next: () => string | undefined): boolean {
  const spec = FLAGS[arg];
  if (!spec || !spec.commands.includes(command)) return false;
  if (!spec.value) {
    if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    (flags as Record<string, unknown>)[spec.key] = true;
    return true;
  }
  const text = inline ?? next();
  if (text === undefined) throw new UsageError(`${arg} needs a value`);
  if (spec.key === "voice") {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--voice must be an integer of at least 1, not "${text}"`);
    flags.voice = n;
  } else (flags as Record<string, unknown>)[spec.key] = text;
  return true;
}

export const ANALYZE_USAGE = `  sidwave analyze  <file.sid|score> [--song <n>] [--seconds <s>] [--songlengths <file>] [--json]
  sidwave compare  <a> <b> [--song <n>] [--seconds <s>] [--level T0|T1|A0|A1] [--no-ladder] [--json]
  sidwave isolate  <file.sid> --voice <n> [--mute] [-o <out.wav> [--force]] [--song <n>] [--seconds <s>] [--json]
  sidwave preserve <file.sid> [--song <n>] [--seconds <s>] [-o <dir>] [--include-original --rights-permitted] [--stil <STIL.txt> --stil-path <path>] [--json]
  sidwave preserve --verify <dir> [--json]
  sidwave extract-instruments <file.sid|score> [-o <library.yaml> [--force]] [--name <n>] [--licence <spdx>] [--author <a>] [--song <n>] [--seconds <s>] [--json]
`;

export const ANALYZE_HELP = `  analyze    Structural analysis: key and mode, metre, form, motifs, voice use, techniques and resources. Every fact is
             marked observed (read from the register trace or the score) or inferred (the method is named). A SID
             tune is reconstructed first; the horizon is --seconds, else the Songlengths entry (--songlengths), else
             30 s, and is always reported.
  compare    Compare two scores or SID tunes: F-diff of the register traces (total, per class and per voice), the
             verification ladder (A1 has the status "approximate"), and for two scores the semantic diff. Exit 0 when
             the F-diff shows no difference, 1 otherwise.
  isolate    Write a WAV with one voice only (--voice n, global number 1-based), or all but that voice with --mute.
             The method is reconstruct-and-recompile (the engine cannot replay a write list); the result states
             whether filter routing, sync or ring couple the voices (non-additive) and whether the reconstruction is exact.
  preserve   Write a preservation bundle into an empty directory: score, source checksums, configuration, tool
             identities, horizon, verdict, ambiguities and rights in preservation.json with the SHA-256 of each
             file. The original SID is stored only with --include-original --rights-permitted. --verify recompiles
             the score offline and checks every hash and the verdict; exit 0 when all checks pass, 1 otherwise.
             Exit 0 after writing when the strict verdict holds, 1 when it does not (the bundle is written either way).
  extract-instruments
             Write the instruments of a score, or of the reconstruction of a SID tune, as a SIDWave library (1.4, or 1.5
             for a 1.5 source) with provenance (to -o or standard output).
`;

interface Options {
  positional: string[];
  output?: string;
  json: boolean;
  force: boolean;
  allowDirs: string[];
  run: RunFlags;
  analyze: AnalyzeFlags;
  format?: string;
  loop?: boolean;
  strict: boolean;
}

/** Largest STIL file read, in bytes (the HVSC STIL.txt is a few megabytes). */
const STIL_FILE_MAX_BYTES = 32 * 1024 * 1024;

const isPsid = (bytes: Uint8Array) => bytes.length >= 4 && ["PSID", "RSID"].includes(String.fromCharCode(...bytes.subarray(0, 4)));

function engineOf(io: CliIo, emulation: SidEmulation = "sidlite"): SidEngine {
  return io.createEngine ? io.createEngine(emulation) : createLibsidplayfpEngine({ emulation });
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

/** True for any directory entry, including a dangling symbolic link. */
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function writeFile(io: CliIo, path: string, bytes: Uint8Array | string, inputs: string[], force = false): void {
  if (inputs.some((input) => sameFile(path, resolve(io.cwd, input)))) throw new UsageError("the output file is an input file; refusing to overwrite it");
  if (pathExists(path) && !force) throw new UsageError(`${path} exists; use --force to overwrite it`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
  }
}

function reject(options: Options, command: string, flags: Array<[keyof Options, string]>): void {
  for (const [key, flag] of flags) {
    const value = options[key];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) throw new UsageError(`${flag} does not apply to ${command}`);
  }
}


function inputOf(io: CliIo, options: Options, file: string): CompareInput & { path: string } {
  const bytes = readInput(file, { cwd: io.cwd, ...(options.run.maxBytes === undefined ? {} : { maxBytes: options.run.maxBytes }) });
  const path = resolve(io.cwd, file);
  const extension = extname(file).toLowerCase();
  if (extension === ".sid" || extension === ".psid" || isPsid(bytes)) {
    parseSidFile(bytes);
    return { kind: "sid", bytes, source: file, path };
  }
  return { kind: "score", text: Buffer.from(bytes).toString("utf8"), source: file, read: confinedReadOptions(io.cwd, options.allowDirs, path), path };
}

function one(options: Options, command: string): string {
  if (options.positional.length !== 1) throw new UsageError(`${command} needs exactly one file`);
  return options.positional[0]!;
}

function horizon(io: CliIo, options: Options, file: string): number {
  const run = options.run;
  const songlengths = run.songlengths ? readSonglengths(run.songlengths, { cwd: io.cwd }) : undefined;
  const tune: LoadedTune = loadTune(file, { cwd: io.cwd, allowDirs: options.allowDirs });
  return run.seconds ?? defaultHorizon(tune, run.song, songlengths);
}

function checkSong(file: string, bytes: Uint8Array, song: number | undefined): void {
  if (song === undefined) return;
  const header = parseSidFile(bytes);
  if (song > header.songs) throw new SidwaveOperationError("input", `--song ${song} is outside 1..${header.songs}, the subtunes of ${file}`, { file });
}

function emit(io: CliIo, options: Options, command: string, ok: boolean, result: unknown, text: string): void {
  io.out(options.json ? `${JSON.stringify(envelope(command, ok, { result }), null, 2)}\n` : text);
}

async function analyzeCommand(io: CliIo, options: Options): Promise<number> {
  reject(options, "analyze", [["output", "-o"], ["force", "--force"], ["format", "--format"]]);
  const file = one(options, "analyze");
  const input = inputOf(io, options, file);
  const report = input.kind === "sid"
    ? (checkSong(file, input.bytes, options.run.song), await analyzeSid(input.bytes, { engine: engineOf(io), ...(options.run.song === undefined ? {} : { song: options.run.song }), seconds: horizon(io, options, file), ...(io.signal ? { signal: io.signal } : {}) }))
    : await analyzeScore(input.text, { read: input.read });
  emit(io, options, "analyze", true, { file, report }, formatAnalysis(report));
  return EXIT_OK;
}

async function compareCommand(io: CliIo, options: Options): Promise<number> {
  reject(options, "compare", [["output", "-o"], ["force", "--force"], ["format", "--format"]]);
  if (options.positional.length !== 2) throw new UsageError("compare needs two files");
  const [a, b] = options.positional.map((file) => inputOf(io, options, file)) as [CompareInput & { path: string }, CompareInput & { path: string }];
  const run = options.run;
  const rules = run.a1Rules ? parseA1Rules(Buffer.from(readInput(run.a1Rules, { cwd: io.cwd })).toString("utf8")) : undefined;
  const rom = run.roms ? loadRoms(run.roms, { cwd: io.cwd }) : undefined;
  const songlengths = run.songlengths ? readSonglengths(run.songlengths, { cwd: io.cwd }) : undefined;
  let seconds = run.seconds;
  if (seconds === undefined && a.kind === "sid") seconds = defaultHorizon(loadTune(options.positional[0]!, { cwd: io.cwd }), run.song, songlengths);
  const report = await compare(a, b, {
    engine: engineOf(io), a1Engine: engineOf(io, "residfp"),
    ...(seconds === undefined ? {} : { seconds }), ...(run.song === undefined ? {} : { song: run.song }),
    ...(run.level ? { level: run.level } : {}), ...(options.analyze.noLadder ? { noLadder: true } : {}),
    ...(rules ? { rules } : {}), ...(rom ? { roms: rom.roms } : {}), ...(io.signal ? { signal: io.signal } : {}),
  });
  emit(io, options, "compare", report.equal, { a: options.positional[0], b: options.positional[1], report }, formatCompare(report));
  return report.equal ? EXIT_OK : EXIT_FAILED;
}

async function isolateCommand(io: CliIo, options: Options): Promise<number> {
  reject(options, "isolate", [["format", "--format"]]);
  const file = one(options, "isolate");
  if (options.analyze.voice === undefined) throw new UsageError("isolate needs --voice <n>");
  const input = inputOf(io, options, file);
  if (input.kind !== "sid") throw new UsageError("isolate reads a SID file");
  checkSong(file, input.bytes, options.run.song);
  const toStdout = options.output === "-";
  const stem = basename(file, extname(file));
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output ?? `${stem}.voice${options.analyze.voice}.wav`);
  const result = await isolateVoice(input.bytes, {
    voice: options.analyze.voice, mode: options.analyze.mute ? "mute" : "solo", engine: engineOf(io), renderEngine: engineOf(io, options.run.engine ?? "sidlite"),
    ...(options.run.song === undefined ? {} : { song: options.run.song }), seconds: horizon(io, options, file),
    ...(options.run.rate === undefined ? {} : { sampleRate: options.run.rate }), ...(io.signal ? { signal: io.signal } : {}),
  });
  if (outPath === undefined) io.outBytes(result.wav); else writeFile(io, outPath, result.wav, [file], options.force);
  const { wav, ...summary } = result;
  const line = `${outPath ?? "standard output"}: voice ${result.voice} ${result.mode === "solo" ? "alone" : "muted"}, ${result.horizon.seconds} s, method ${result.method}, ${result.coupling.nonAdditive ? `non-additive (${result.coupling.reasons.join("; ")})` : "additive"}, reconstruction ${result.reconstructionStrictExact ? "strictly exact" : "not strictly exact"}\n`;
  const text = options.json ? `${JSON.stringify(envelope("isolate", true, { result: { file, output: outPath ?? null, bytes: wav.length, ...summary } }), null, 2)}\n` : line;
  if (toStdout) io.err(text); else io.out(text);
  return EXIT_OK;
}

async function preserveCommand(io: CliIo, options: Options): Promise<number> {
  reject(options, "preserve", [["force", "--force"], ["format", "--format"]]);
  const flags = options.analyze;
  const target = one(options, "preserve");
  if (flags.verify) {
    if (options.output !== undefined) throw new UsageError("-o does not apply to preserve --verify");
    const result = await verifyPreservation(resolve(io.cwd, target), { engine: engineOf(io), ...(io.signal ? { signal: io.signal } : {}) });
    const lines = [
      `${target}: ${result.ok ? "verified" : "FAILED"}`,
      ...result.checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
      ...result.identityNotes.map((n) => `  note: ${n}`),
      `  stored verdict: strict ${result.verdict.stored.strict}, register state ${result.verdict.stored.registerStateExact}; ${result.verdict.reproduced}`,
    ];
    emit(io, options, "preserve", result.ok, { dir: target, ...result }, `${lines.join("\n")}\n`);
    return result.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (flags.includeOriginal && !flags.rightsPermitted) throw new UsageError("--include-original needs --rights-permitted: the original SID is stored only when redistribution is permitted");
  if (flags.rightsPermitted && !flags.includeOriginal) throw new UsageError("--rights-permitted only applies together with --include-original");
  if ((flags.stil === undefined) !== (flags.stilPath === undefined)) throw new UsageError("--stil and --stil-path are used together");
  const input = inputOf(io, options, target);
  if (input.kind !== "sid") throw new UsageError("preserve reads a SID file");
  checkSong(target, input.bytes, options.run.song);
  const run = options.run;
  const rom = run.roms ? loadRoms(run.roms, { cwd: io.cwd }) : undefined;
  const rules = run.a1Rules ? parseA1Rules(Buffer.from(readInput(run.a1Rules, { cwd: io.cwd })).toString("utf8")) : undefined;
  let stil: { text: string; path: string } | undefined;
  if (flags.stil !== undefined) {
    stil = { text: Buffer.from(readInput(flags.stil, { cwd: io.cwd, maxBytes: options.run.maxBytes ?? STIL_FILE_MAX_BYTES })).toString("utf8"), path: flags.stilPath! };
  }
  const dir = resolve(io.cwd, options.output ?? `${basename(target, extname(target))}.preserved`);
  const level = flags.noLadder ? "none" : run.level ?? "A1";
  const bundle = await createPreservation(input.bytes, {
    engine: engineOf(io), ...(level === "A1" || level === "none" ? { a1Engine: engineOf(io, "residfp") } : {}),
    ...(run.song === undefined ? {} : { song: run.song }), seconds: horizon(io, options, target), level,
    ...(flags.includeOriginal ? { includeOriginal: true, rightsPermitted: true } : {}), ...(stil ? { stil } : {}),
    ...(rom ? { roms: rom.roms } : {}), ...(rules ? { rules } : {}), ...(io.signal ? { signal: io.signal } : {}),
  });
  writePreservation(bundle, dir);
  for (const warning of bundle.warnings) io.err(`warning: ${warning}\n`);
  const ok = bundle.manifest.verdict.strict;
  emit(io, options, "preserve", ok, { file: target, output: dir, files: Object.keys(bundle.manifest.files), manifest: bundle.manifest }, `${dir}: ${[...bundle.files.keys()].join(", ")}\n${formatPreservation(bundle.manifest)}`);
  return ok ? EXIT_OK : EXIT_FAILED;
}

async function extractCommand(io: CliIo, options: Options): Promise<number> {
  reject(options, "extract-instruments", [["format", "--format"]]);
  const file = one(options, "extract-instruments");
  const input = inputOf(io, options, file);
  const flags = options.analyze;
  const common = { ...(flags.name ? { name: flags.name } : {}), ...(flags.licence ? { licence: flags.licence } : {}), ...(flags.author ? { author: flags.author } : {}), ...(flags.created ? { created: flags.created } : {}) };
  let result;
  try {
    if (input.kind === "sid") {
      checkSong(file, input.bytes, options.run.song);
      result = await extractInstruments(input.bytes, { ...common, engine: engineOf(io), ...(options.run.song === undefined ? {} : { song: options.run.song }), seconds: horizon(io, options, file) });
    } else result = await extractInstruments(input.text, common);
  } catch (error) {
    if (error instanceof SidwaveOperationError) throw error;
    const message = (error as Error).message;
    if (/library name|created must|not a YAML mapping/.test(message)) throw new SidwaveOperationError("input", message, { file });
    throw error;
  }
  const toStdout = options.output === undefined || options.output === "-";
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output!);
  if (outPath) writeFile(io, outPath, result.library, [file], options.force);
  const summary = { file, output: outPath ?? null, libraryName: result.libraryName, instruments: result.instruments.map((i) => ({ name: i.name, usedByVoices: i.usedByVoices, patternEntries: i.patternEntries, programs: i.programs })), external: result.external, provenance: result.provenance };
  const line = `${outPath ?? "standard output"}: ${result.instruments.length} instrument${result.instruments.length === 1 ? "" : "s"} in library ${result.libraryName}${result.external.length ? `; not copied (not defined in the score): ${result.external.join(", ")}` : ""}\n`;
  if (options.json) {
    if (toStdout) throw new UsageError("extract-instruments --json needs -o <file>; without it the library itself is written to standard output");
    io.out(`${JSON.stringify(envelope("extract-instruments", true, { result: summary }), null, 2)}\n`);
  } else if (toStdout) { io.out(result.library); io.err(line); } else io.out(line);
  return EXIT_OK;
}

export const ANALYZE_COMMANDS: Record<string, (io: CliIo, options: any) => number | Promise<number>> = {
  analyze: analyzeCommand, compare: compareCommand, isolate: isolateCommand, preserve: preserveCommand, "extract-instruments": extractCommand,
};
