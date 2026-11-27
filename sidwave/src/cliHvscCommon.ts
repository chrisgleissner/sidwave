// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Parts shared by the HVSC commands (sid, songlengths, stil): a small flag parser, the lookup of the HVSC root and
// databases, and the writing of output files.

import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SidwaveOperationError, UsageError, envelope, type CliIo } from "./cliCore.js";
import {
  DEFAULT_DATABASE_MAX_BYTES, HvscError, findHvscRootAbove, hvscDatabases, hvscPathOf, readTextBounded, resolveHvscRoot,
} from "./hvsc.js";
import { parseSonglengths } from "./songlengths.js";
import { songlengthsFormatOf, songlengthsKey, type SonglengthsFormat } from "./songlengthsFile.js";
import { parseStil, type StilDb } from "./stil.js";

export interface FlagSpec {
  /** Flags that take a value, by name. */
  values: readonly string[];
  /** Flags without a value. */
  switches: readonly string[];
  /** Alternative names, mapped to the canonical flag. */
  aliases?: Record<string, string>;
}

export interface ParsedFlags {
  positional: string[];
  values: Map<string, string[]>;
  switches: Set<string>;
  help: boolean;
}

/** Splits `args` into positional arguments, value flags (`--name v` or `--name=v`) and switches. */
export function parseFlags(args: readonly string[], spec: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { positional: [], values: new Map(), switches: new Set(), help: false };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) { inline = arg.slice(arg.indexOf("=") + 1); arg = arg.slice(0, arg.indexOf("=")); }
    if (arg === "--") { out.positional.push(...args.slice(i + 1)); break; }
    if (arg === "-h" || arg === "--help") { out.help = true; continue; }
    arg = spec.aliases?.[arg] ?? arg;
    if (spec.values.includes(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      const list = out.values.get(arg);
      if (list) list.push(value); else out.values.set(arg, [value]);
    } else if (spec.switches.includes(arg)) {
      if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
      out.switches.add(arg);
    } else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}; see --help`);
    else out.positional.push(arg);
  }
  return out;
}

export const one = (flags: ParsedFlags, name: string): string | undefined => {
  const list = flags.values.get(name);
  if (list !== undefined && list.length > 1) throw new UsageError(`${name} is given more than once`);
  return list?.[0];
};

/** A whole number flag; `min` and `max` bound it. */
export function numberFlag(name: string, text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text.trim())) throw new UsageError(`${name} needs a whole number from ${min} to ${max}, not "${text}"`);
  const value = Number(text);
  if (value < min || value > max) throw new UsageError(`${name} needs a whole number from ${min} to ${max}, not ${text}`);
  return value;
}

/** 0x1000, $1000 or 4096, up to `max`. */
export function addressFlag(name: string, text: string, max = 0xffff): number {
  const match = /^(?:0x([0-9a-f]+)|\$([0-9a-f]+)|([0-9]+))$/i.exec(text.trim());
  if (!match) throw new UsageError(`${name} needs an address such as 0x1000, $1000 or 4096, not "${text}"`);
  const value = match[3] !== undefined ? Number.parseInt(match[3], 10) : Number.parseInt((match[1] ?? match[2])!, 16);
  if (value > max) throw new UsageError(`${name} ${text} is above $${max.toString(16).toUpperCase()}`);
  return value;
}

export interface HvscContext {
  root?: string;
  songlengthsPath?: string;
  songlengths?: { db: Map<string, number[]>; format: SonglengthsFormat };
  stilPath?: string;
  stil?: StilDb;
}

export interface ContextRequest {
  /** Directory or file to search upward for an HVSC root when no root is given. */
  near?: string;
  wantSonglengths: boolean;
  wantStil: boolean;
  /** Search upward from `near` for a root. Off for commands that must not read databases implicitly. */
  discover: boolean;
}

/**
 * Locates and reads the Songlengths and STIL databases. A path from --songlengths or --stil wins; otherwise they are
 * taken from the HVSC root of --hvsc, then of HVSC_ROOT, then (when `discover` is set) of the closest HVSC root above `near`.
 */
export function loadContext(io: CliIo, flags: ParsedFlags, request: ContextRequest): HvscContext {
  const dbLimit = DEFAULT_DATABASE_MAX_BYTES;
  const context: HvscContext = {};
  let root = resolveHvscRoot(io.cwd, one(flags, "--hvsc"));
  if (root === undefined && request.discover && request.near !== undefined) root = findHvscRootAbove(request.near);
  if (root !== undefined) context.root = root;
  const databases = root === undefined ? undefined : hvscDatabases(root);
  const explicitSonglengths = one(flags, "--songlengths");
  const explicitStil = one(flags, "--stil");
  const songlengthsPath = explicitSonglengths !== undefined ? resolve(io.cwd, explicitSonglengths) : databases?.songlengths;
  const stilPath = explicitStil !== undefined ? resolve(io.cwd, explicitStil) : databases?.stil;
  if (request.wantSonglengths && songlengthsPath !== undefined) {
    context.songlengthsPath = songlengthsPath;
    context.songlengths = { db: parseSonglengths(readTextBounded(songlengthsPath, dbLimit, explicitSonglengths ?? songlengthsPath)), format: songlengthsFormatOf(songlengthsPath) };
  }
  if (request.wantStil && stilPath !== undefined) {
    context.stilPath = stilPath;
    context.stil = parseStil(readTextBounded(stilPath, dbLimit, explicitStil ?? stilPath));
  }
  return context;
}

/** Songlengths in ms of a file, or undefined when the database has no entry. */
export function songlengthsOf(context: HvscContext, bytes: Uint8Array): number[] | undefined {
  if (context.songlengths === undefined) return undefined;
  return context.songlengths.db.get(songlengthsKey(bytes, context.songlengths.format));
}

export function hvscPathFor(context: HvscContext, file: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit.startsWith("/") ? explicit : `/${explicit}`;
  return context.root === undefined ? undefined : hvscPathOf(context.root, file);
}

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
export const sameFile = (a: string, b: string): boolean => real(a) === real(b);

/** Writes a file by writing a temporary file beside it and renaming it, so an interrupted write cannot truncate the target. */
export function writeFileAtomic(path: string, bytes: Uint8Array | string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* nothing to clean */ }
    throw new SidwaveOperationError("input", `cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
  }
}

/** Prints a result: the JSON envelope with --json, else the text. */
export function emitResult(io: CliIo, json: boolean, command: string, result: unknown, text: string, ok = true): void {
  io.out(json ? `${JSON.stringify(envelope(command, ok, { result }), null, 2)}\n` : `${text}${text.endsWith("\n") ? "" : "\n"}`);
}

/** Collects lines and hands them to `io.out` in chunks, so a run over 60,000 files does not make 60,000 writes. */
export class LineWriter {
  private chunk: string[] = [];
  private size = 0;
  constructor(private readonly io: CliIo, private readonly limit = 64 * 1024) {}
  line(text: string): void {
    this.chunk.push(text);
    this.size += text.length + 1;
    if (this.size >= this.limit) this.flush();
  }
  flush(): void {
    if (this.chunk.length === 0) return;
    this.io.out(`${this.chunk.join("\n")}\n`);
    this.chunk = [];
    this.size = 0;
  }
}

export { HvscError };
