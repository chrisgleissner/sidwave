// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, envelope, type CliIo } from "./cliCore.js";
import type { SidClock, SidEmulation } from "./engine/types.js";
import {
  VERIFY_LEVELS, defaultHorizon, loadRoms, loadTune, readInput, readSonglengths, renderTune, sidInfo, traceTune, verifyTunes,
  type LoadedTune, type RunControl, type TraceFormat, type VerifyLevel, type VerifyReport,
} from "./sidwaveTools.js";
import { parseA1Rules } from "./verify/a1.js";

/** Flags of verify, render, trace and sid-info. The parser in cli.ts hands every flag to takeRunFlag first. */
export interface RunFlags {
  song?: number;
  seconds?: number;
  level?: VerifyLevel;
  toleranceCycles?: number;
  progress?: boolean;
  maxSeconds?: number;
  maxRecords?: number;
  maxBytes?: number;
  rate?: number;
  model?: "6581" | "8580";
  engine?: SidEmulation;
  clock?: SidClock;
  roms?: string;
  a1Rules?: string;
  songlengths?: string;
}

const FLAGS: Record<string, keyof RunFlags> = {
  "--song": "song", "--seconds": "seconds", "--level": "level", "--tolerance-cycles": "toleranceCycles", "--progress": "progress",
  "--max-seconds": "maxSeconds", "--max-records": "maxRecords", "--max-bytes": "maxBytes", "--rate": "rate", "--model": "model",
  "--engine": "engine", "--clock": "clock", "--roms": "roms", "--a1-rules": "a1Rules", "--songlengths": "songlengths",
};

export function flagName(key: string): string {
  return Object.entries(FLAGS).find(([, value]) => value === key)?.[0] ?? `--${key}`;
}

function number(flag: string, text: string, rule: { integer?: boolean; min: number; exclusiveMin?: boolean }): number {
  const value = Number(text);
  const bad = text.trim() === "" || !Number.isFinite(value) || (rule.integer && !Number.isInteger(value))
    || (rule.exclusiveMin ? value <= rule.min : value < rule.min);
  if (bad) throw new UsageError(`${flag} must be ${rule.integer ? "an integer" : "a number"} ${rule.exclusiveMin ? "above" : "of at least"} ${rule.min}, not "${text}"`);
  return value;
}

function oneOf<T extends string>(flag: string, text: string, values: readonly T[]): T {
  if (!values.includes(text as T)) throw new UsageError(`${flag} must be one of ${values.join(", ")}, not "${text}"`);
  return text as T;
}

/** Consumes `arg` when it is a flag of the verification commands; `next` supplies the value of a separate argument. */
export function takeRunFlag(flags: RunFlags, arg: string, inline: string | undefined, next: () => string | undefined): boolean {
  const key = FLAGS[arg];
  if (key === undefined) return false;
  if (key === "progress") {
    if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    flags.progress = true;
    return true;
  }
  const text = inline ?? next();
  if (text === undefined) throw new UsageError(`${arg} needs a value`);
  switch (key) {
    case "song": flags.song = number(arg, text, { integer: true, min: 1 }); break;
    case "seconds": flags.seconds = number(arg, text, { min: 0, exclusiveMin: true }); break;
    case "toleranceCycles": flags.toleranceCycles = number(arg, text, { integer: true, min: 0 }); break;
    case "maxSeconds": flags.maxSeconds = number(arg, text, { min: 0, exclusiveMin: true }); break;
    case "maxRecords": flags.maxRecords = number(arg, text, { integer: true, min: 0 }); break;
    case "maxBytes": flags.maxBytes = number(arg, text, { integer: true, min: 1 }); break;
    case "rate": flags.rate = number(arg, text, { integer: true, min: 4000 }); break;
    case "level": flags.level = oneOf(arg, text, VERIFY_LEVELS); break;
    case "model": flags.model = oneOf(arg, text, ["6581", "8580"] as const); break;
    case "engine": flags.engine = oneOf(arg, text, ["residfp", "sidlite"] as const); break;
    case "clock": flags.clock = oneOf(arg, text, ["PAL", "NTSC"] as const); break;
    default: (flags as Record<string, unknown>)[key] = text;
  }
  return true;
}

export const RUN_HELP = {
  usage: `  sidwave verify   <reference.sid|score> <candidate.sid|score> [--song <n>] [--seconds <s>] [--level T0|T1|A0|A1] [--tolerance-cycles <n>] [run options]
  sidwave render   <file.sid|score> [-o <out.wav>] [--song <n>] [--seconds <s>] [--rate <hz>] [--engine residfp|sidlite] [run options]
  sidwave trace    <file.sid|score> [-o <out>] [--format csv|jsonl] [--song <n>] [--seconds <s>] [run options]
  sidwave sid-info <file.sid> [--songlengths <Songlengths.md5>] [--json]
`,
  commands: `  verify     Compare a candidate with a reference at increasing levels: T0 (identical register writes per player
             call), T1 (same writes within --tolerance-cycles), A0 (identical SIDLite PCM) and A1 (calibrated
             windowed audio comparison on reSIDfp). A score is compiled to a PSID first. --level is the weakest
             level that counts as a pass (default A1). Prints the highest level reached, the status of each
             level, the first difference and the horizon. Exit 0 when a level up to the requested one passes, 1
             when none does.
  render     Write 16-bit mono PCM as a WAV file (default <name>.wav; "-o -" writes to standard output).
  trace      Write the SID register writes as CSV (sid,address,value,cycle) or JSON lines to standard output, or to -o.
  sid-info   Print the header of a SID file; with --songlengths also the length of each subtune.
`,
  options: `  Run options (verify, render, trace): --progress (progress on standard error), --max-seconds <s>,
                      --max-records <n>, --max-bytes <n> (input and output size), --roms <dir> (kernal.rom, basic.rom,
                      chargen.rom), --model 6581|8580, --clock PAL|NTSC, --songlengths <file>, --a1-rules <file>.
                      Ctrl-C (SIGINT) aborts the run with exit code 5.
`,
};

function control(io: CliIo, flags: RunFlags): RunControl {
  let last = new Map<string, number>();
  return {
    ...(io.signal ? { signal: io.signal } : {}),
    ...(io.createEngine ? { createEngine: io.createEngine } : {}),
    ...(flags.maxSeconds === undefined ? {} : { maxSeconds: flags.maxSeconds }),
    ...(flags.maxRecords === undefined ? {} : { maxRecords: flags.maxRecords }),
    ...(flags.maxBytes === undefined ? {} : { maxBytes: flags.maxBytes }),
    ...(flags.progress
      ? {
        onProgress: (label: string, fraction: number) => {
          const percent = Math.floor(fraction * 10) * 10;
          if (last.get(label) === percent) return;
          last.set(label, percent);
          io.err(`progress: ${label} ${percent}%\n`);
        },
      }
      : {}),
  };
}

function rejectOld(options: CommandOptions, command: string, unsupported: Array<[keyof CommandOptions, string]>): void {
  for (const [key, flag] of unsupported) {
    const value = options[key];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) throw new UsageError(`${flag} does not apply to ${command}`);
  }
}

/** The part of the parsed command line these commands read. */
interface CommandOptions {
  positional: string[];
  output?: string;
  format?: string;
  loop?: boolean;
  json: boolean;
  strict: boolean;
  force: boolean;
  allowDirs: string[];
  run: RunFlags;
}

const common = (command: string, options: CommandOptions, allow: { output?: boolean; format?: boolean } = {}) =>
  rejectOld(options, command, [
    ...(allow.output ? [] : [["output", "-o"] as [keyof CommandOptions, string]]),
    ...(allow.format ? [] : [["format", "--format"] as [keyof CommandOptions, string]]),
    ["loop", "--loop/--no-loop"], ["strict", "--strict"], ["force", "--force"],
  ]);

function reject(options: CommandOptions, command: string, keys: Array<keyof RunFlags>): void {
  for (const key of keys) if (options.run[key] !== undefined) throw new UsageError(`${flagName(key)} does not apply to ${command}`);
}

function loadInputs(io: CliIo, options: CommandOptions, files: string[]): LoadedTune[] {
  return files.map((file) => loadTune(file, { cwd: io.cwd, allowDirs: options.allowDirs, ...(options.run.maxBytes === undefined ? {} : { maxBytes: options.run.maxBytes }) }));
}

function textOf(tune: LoadedTune): string {
  return `${tune.source} (${tune.kind === "score" ? "score, compiled to PSID" : "SID file"})`;
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

function writeOutput(io: CliIo, path: string, bytes: Uint8Array | string, inputs: string[]): void {
  if (inputs.some((input) => sameFile(path, resolve(io.cwd, input)))) throw new UsageError("the output file is an input file; refusing to overwrite it");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
  }
}

function formatDifference(report: VerifyReport): string[] {
  const d = report.firstDifference;
  if (!d) return [];
  const where = [
    d.timeSeconds === undefined ? undefined : `${d.timeSeconds.toFixed(3)} s`,
    d.call === undefined ? undefined : `call ${d.call}`,
    d.sid === undefined ? undefined : `SID ${d.sid + 1}`,
    d.voice === undefined ? undefined : `voice ${d.voice}`,
    d.register === undefined ? undefined : `register $${d.register.toString(16).padStart(2, "0")}`,
  ].filter(Boolean).join(", ");
  const values = d.expected !== undefined || d.observed !== undefined ? `; expected ${d.expected ?? "none"}, observed ${d.observed ?? "none"}` : "";
  return [`first difference: ${d.level} ${d.category}${where ? ` at ${where}` : ""}${values}`];
}

export function formatVerify(report: VerifyReport): string {
  const lines = [
    `verify: ${report.verdict === "pass" ? "PASS" : "FAIL"}, highest level reached: ${report.level} (requested ${report.requestedLevel})`,
    `reference: ${report.reference.source} (${report.reference.kind})`,
    `candidate: ${report.candidate.source} (${report.candidate.kind})`,
    `horizon: ${report.horizon.seconds} s, ${report.horizon.calls} player calls`,
    ...(["T0", "T1", "A0", "A1"] as const).map((level) => `  ${level}: ${report.levels[level]}`),
    ...formatDifference(report),
  ];
  if (report.a1) {
    const a = report.a1;
    if (a.reason) lines.push(`A1 (${a.status}): not evaluated (${a.reason})`);
    else {
      lines.push(`A1 (${a.status}): ${a.badWindows} of ${a.windows} windows differ, lag ${a.lagMs} ms${a.truncated ? ", a render ended before the horizon" : ""}` +
        (a.firstBad ? `; first bad window ${a.firstBad.timeSeconds.toFixed(3)} s (${a.firstBad.class})` : ""));
    }
  }
  return lines.join("\n");
}

async function verifyCommand(io: CliIo, options: CommandOptions): Promise<number> {
  common("verify", options);
  reject(options, "verify", ["rate", "engine", "model"]);
  if (options.positional.length !== 2) throw new UsageError("verify needs a reference and a candidate");
  const run = options.run;
  const [reference, candidate] = loadInputs(io, options, options.positional) as [LoadedTune, LoadedTune];
  const songlengths = run.songlengths ? readSonglengths(run.songlengths, { cwd: io.cwd }) : undefined;
  const rom = run.roms ? loadRoms(run.roms, { cwd: io.cwd }) : undefined;
  const rules = run.a1Rules ? parseA1Rules(Buffer.from(readInput(run.a1Rules, { cwd: io.cwd })).toString("utf8")) : undefined;
  const report = await verifyTunes(reference, candidate, {
    ...control(io, run),
    ...(run.level ? { level: run.level } : {}),
    ...(run.song === undefined ? {} : { song: run.song }),
    seconds: run.seconds ?? defaultHorizon(reference, run.song, songlengths),
    ...(run.toleranceCycles === undefined ? {} : { toleranceCycles: run.toleranceCycles }),
    ...(run.clock ? { clock: run.clock } : {}),
    ...(rom ? { roms: rom.roms } : {}),
    ...(rules ? { rules } : {}),
  });
  io.out(options.json ? `${JSON.stringify(envelope("verify", report.verdict === "pass", { result: report }), null, 2)}\n` : `${formatVerify(report)}\n`);
  return report.verdict === "pass" ? EXIT_OK : EXIT_FAILED;
}

function singleInput(options: CommandOptions, command: string): string {
  if (options.positional.length !== 1) throw new UsageError(`${command} needs exactly one file`);
  return options.positional[0]!;
}

async function renderCommand(io: CliIo, options: CommandOptions): Promise<number> {
  common("render", options, { output: true });
  reject(options, "render", ["level", "toleranceCycles", "maxRecords", "a1Rules"]);
  const file = singleInput(options, "render");
  const run = options.run;
  const [tune] = loadInputs(io, options, [file]) as [LoadedTune];
  const songlengths = run.songlengths ? readSonglengths(run.songlengths, { cwd: io.cwd }) : undefined;
  const rom = run.roms ? loadRoms(run.roms, { cwd: io.cwd }) : undefined;
  const toStdout = options.output === "-";
  const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output ?? `${stem}.wav`);
  const { wav, summary } = await renderTune(tune, {
    ...control(io, run),
    seconds: run.seconds ?? defaultHorizon(tune, run.song, songlengths),
    ...(run.song === undefined ? {} : { song: run.song }),
    ...(run.rate === undefined ? {} : { sampleRate: run.rate }),
    ...(run.model ? { model: run.model } : {}), ...(run.clock ? { clock: run.clock } : {}),
    ...(run.engine ? { emulation: run.engine } : {}), ...(rom ? { roms: rom.roms } : {}),
  });
  if (outPath === undefined) io.outBytes(wav);
  else writeOutput(io, outPath, wav, [file]);
  const line = `${outPath ?? "standard output"}: WAV ${summary.wavBytes} bytes, ${summary.seconds.toFixed(1)} s, ${summary.sampleRate} Hz mono, ${summary.engine.emulation}`;
  const report = options.json ? `${JSON.stringify(envelope("render", true, { result: { file, output: outPath ?? null, ...summary } }), null, 2)}\n` : `${line}\n`;
  if (toStdout) io.err(report); else io.out(report);
  return EXIT_OK;
}

async function traceCommand(io: CliIo, options: CommandOptions): Promise<number> {
  common("trace", options, { output: true, format: true });
  reject(options, "trace", ["level", "toleranceCycles", "a1Rules", "rate", "model", "engine"]);
  const file = singleInput(options, "trace");
  const run = options.run;
  const format = options.format === undefined ? "csv" : oneOf("--format", options.format, ["csv", "jsonl"] as const) as TraceFormat;
  if (options.json && options.output === undefined) throw new UsageError("trace --json needs -o <file>; without it the trace itself is written to standard output");
  const [tune] = loadInputs(io, options, [file]) as [LoadedTune];
  const songlengths = run.songlengths ? readSonglengths(run.songlengths, { cwd: io.cwd }) : undefined;
  const rom = run.roms ? loadRoms(run.roms, { cwd: io.cwd }) : undefined;
  const toStdout = options.output === undefined || options.output === "-";
  const { text, summary } = await traceTune(tune, {
    ...control(io, run), format,
    seconds: run.seconds ?? defaultHorizon(tune, run.song, songlengths),
    ...(run.song === undefined ? {} : { song: run.song }),
    ...(run.clock ? { clock: run.clock } : {}), ...(rom ? { roms: rom.roms } : {}),
  });
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output!);
  if (outPath === undefined) io.out(text);
  else writeOutput(io, outPath, text, [file]);
  const line = `${outPath ?? "standard output"}: ${summary.records} SID writes as ${format}, ${summary.seconds.toFixed(1)} s, ${summary.clock}`;
  const report = options.json ? `${JSON.stringify(envelope("trace", true, { result: { file, output: outPath ?? null, ...summary } }), null, 2)}\n` : `${line}\n`;
  if (toStdout) io.err(report); else io.out(report);
  return EXIT_OK;
}

function sidInfoCommand(io: CliIo, options: CommandOptions): number {
  common("sid-info", options);
  reject(options, "sid-info", ["song", "seconds", "level", "toleranceCycles", "progress", "maxSeconds", "maxRecords", "rate", "model", "engine", "clock", "roms", "a1Rules"]);
  const file = singleInput(options, "sid-info");
  const bytes = readInput(file, { cwd: io.cwd, ...(options.run.maxBytes === undefined ? {} : { maxBytes: options.run.maxBytes }) });
  const songlengths = options.run.songlengths ? readSonglengths(options.run.songlengths, { cwd: io.cwd }) : undefined;
  const info = sidInfo(bytes, songlengths ? { songlengths } : {});
  const hex = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const text = [
    `${file}: ${info.magic} v${info.version}, ${info.songs} song${info.songs === 1 ? "" : "s"}, start song ${info.startSong}`,
    `name: ${info.name}`, `author: ${info.author}`, `released: ${info.released}`,
    `load ${hex(info.loadAddress)}, init ${hex(info.initAddress)}, play ${hex(info.playAddress)}`,
    `clock ${info.clock}, SID models ${info.sidModels.join("/")}, speed ${info.speeds.join(",")}`,
    `md5 ${info.md5}`,
    ...(info.songlengths ? [`song lengths: ${info.songlengths.map((s) => (s === null ? "unknown" : `${s}s`)).join(", ")}`] : []),
    ...info.warnings.map((w) => `warning: ${w}`),
  ].join("\n");
  io.out(options.json ? `${JSON.stringify(envelope("sid-info", true, { result: { file, ...info } }), null, 2)}\n` : `${text}\n`);
  return EXIT_OK;
}

export const RUN_COMMANDS: Record<string, (io: CliIo, options: any) => number | Promise<number>> = {
  verify: verifyCommand, render: renderCommand, trace: traceCommand, "sid-info": sidInfoCommand,
};

