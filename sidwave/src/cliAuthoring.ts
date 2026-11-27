// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Shared parts of the authoring commands (transform, format, diff, merge, generate): flag parsing, the error report
// in the form of the command line contract (see cliCore.ts), reading scores and writing output files.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSidwave, type ParsedSidwave } from "./sidwave.js";
import { confinedReadOptions } from "./sidwaveOps.js";
import {
  EXIT_CODES, SidwaveOperationError, UsageError, classifyError, envelope, type CliIo,
} from "./cliCore.js";

export interface FlagSpec {
  /** Flags that take a value. A value flag may be repeated; every value is kept. */
  value: readonly string[];
  /** Flags without a value. `--json` and `-h/--help` are always accepted. */
  bool?: readonly string[];
  /** Alternative names, for example `{ "--output": "-o" }`. */
  alias?: Readonly<Record<string, string>>;
}

export interface ParsedFlags {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
  /** Value flags in the order given, so that a command can apply its steps in that order. */
  order: Array<[string, string]>;
  help: boolean;
  json: boolean;
}

export function parseFlags(args: readonly string[], spec: FlagSpec): ParsedFlags {
  const parsed: ParsedFlags = { positional: [], values: new Map(), flags: new Set(), order: [], help: false, json: false };
  const alias = { "--output": "-o", ...(spec.alias ?? {}) };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (arg === "--") { parsed.positional.push(...args.slice(i + 1)); break; }
    arg = (alias as Record<string, string>)[arg] ?? arg;
    if (spec.value.includes(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      parsed.values.set(arg, [...(parsed.values.get(arg) ?? []), value]);
      parsed.order.push([arg, value]);
    } else if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (spec.bool?.includes(arg)) parsed.flags.add(arg);
    else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

export const last = (p: ParsedFlags, flag: string): string | undefined => { const all = p.values.get(flag); return all?.[all.length - 1]; };

export function parseInteger(flag: string, text: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[+-]?\d+$/.test(text.trim()) || Number(text) < min || Number(text) > max) {
    throw new UsageError(`${flag} needs a whole number from ${min} to ${max}, not "${text}"`);
  }
  return Number(text);
}

export function parseNumber(flag: string, text: string): number {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) throw new UsageError(`${flag} needs a number, not "${text}"`);
  return value;
}

export function splitList(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

export interface AuthoringContext { io: CliIo; json: boolean }

/** Runs `body`, prints a failure in the form requested (text, or the JSON envelope) and returns the exit code. */
export function runAuthoring(
  command: string, help: string, spec: FlagSpec, args: readonly string[], io: CliIo,
  body: (parsed: ParsedFlags, context: AuthoringContext) => number,
): number {
  const json = args.includes("--json");
  try {
    const parsed = parseFlags(args, spec);
    if (parsed.help) { io.out(help); return 0; }
    return body(parsed, { io, json: parsed.json });
  } catch (error) {
    const report = classifyError(error);
    if (json) io.out(`${JSON.stringify(envelope(command, false, { error: report }), null, 2)}\n`);
    else if (report.category === "usage") io.err(`sidwave: ${report.message}\nRun "sidwave ${command} --help" for usage.\n`);
    else if (report.category === "validation" && typeof report.details.file === "string") io.err(`${report.details.file}: ${report.message}\n`);
    else io.err(`sidwave: ${report.message}\n`);
    return EXIT_CODES[report.category];
  }
}

/** Prints a result: the JSON envelope with --json, else the text. `ok` false is a failed verdict (exit 1). */
export function emit(io: CliIo, json: boolean, command: string, result: unknown, text: string, ok = true, stream: "out" | "err" = "out"): void {
  const message = json ? `${JSON.stringify(envelope(command, ok, { result }), null, 2)}\n` : text.endsWith("\n") || text === "" ? text : `${text}\n`;
  if (message !== "") io[stream](message);
}

export function readText(io: CliIo, file: string): { text: string; path: string } {
  const path = resolve(io.cwd, file);
  try {
    return { text: readFileSync(path, "utf8"), path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? `no such file: ${file}` : code === "EISDIR" ? `is a directory: ${file}; name a score file`
      : code === "EACCES" ? `permission denied: ${file}` : `cannot read ${file}: ${code ?? (error as Error).message}`;
    throw new SidwaveOperationError("input", reason, { file, code });
  }
}

/** Parses `text` as a score and throws a validation error that names `file` when it is not one. */
export function requireScore(io: CliIo, file: string, text: string, path: string, allowDirs: readonly string[] = []): ParsedSidwave {
  return guard(file, () => parseSidwave(text, confinedReadOptions(io.cwd, allowDirs, path)));
}

/**
 * Runs `fn` for the file `file`: a validation error or a YAML syntax error gets the name of the file, so that the
 * command line prints "file: message" and exits 3.
 */
export function guard<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && (error.name === "YAMLParseError" || error.name === "YAMLWarning")) {
      throw new SidwaveOperationError("validation", `not valid YAML: ${error.message.split("\n")[0]}`, { file }, { cause: error });
    }
    const report = classifyError(error);
    if (report.category === "validation") {
      throw new SidwaveOperationError("validation", report.message, { ...report.details, file }, { cause: error });
    }
    throw error;
  }
}

export function isCharacterDevice(path: string): boolean {
  try { return statSync(path).isCharacterDevice(); } catch { return false; }
}

/** Fails with the usage error that writeOutput would raise, without writing: call it for every output before the first write. */
export function checkOutput(io: CliIo, output: string, options: { force: boolean; inputs?: readonly string[] }): void {
  const path = resolve(io.cwd, output);
  if (options.force || isCharacterDevice(path)) return;
  if ((options.inputs ?? []).some((input) => sameFile(input, path))) {
    throw new UsageError(`${output} is an input file; use --force to rewrite it in place, or choose another -o`);
  }
  if (existsSync(path)) throw new UsageError(`${output} exists; use --force to overwrite it, or choose another -o`);
}

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
export const sameFile = (a: string, b: string): boolean => real(a) === real(b);

/**
 * Writes `bytes` to `output` and returns the absolute path. An existing file is replaced only with `force`; `inputs`
 * are the files the command read, and replacing one of them also needs `force`.
 */
export function writeOutput(io: CliIo, output: string, bytes: Uint8Array | string, options: { force: boolean; inputs?: readonly string[] }): string {
  const path = resolve(io.cwd, output);
  if (isCharacterDevice(path)) {
    // /dev/null, /dev/stdout and the like: nothing to protect, and nothing to create.
    try { writeFileSync(path, bytes); } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
    }
    return path;
  }
  if (!options.force) {
    if ((options.inputs ?? []).some((input) => sameFile(input, path))) {
      throw new UsageError(`${output} is an input file; use --force to rewrite it in place, or choose another -o`);
    }
    if (existsSync(path)) throw new UsageError(`${output} exists; use --force to overwrite it, or choose another -o`);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
  }
  return path;
}

/** A value for one line of text: JSON, shortened. */
export function brief(value: unknown, max = 70): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
