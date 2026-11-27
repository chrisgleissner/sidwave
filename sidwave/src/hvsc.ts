// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Helpers shared by the HVSC tools: the error type, HVSC root and database discovery, HVSC path handling, bounded
// file reads and the walk over a directory of SID files. Depends only on Node builtins.

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ErrorCategory } from "./cliCore.js";

export type HvscErrorCode =
  | "usage"
  | "bad_value"
  | "bad_combination"
  | "bad_format"
  | "too_large"
  | "not_found"
  | "unreadable";

/** An error of the HVSC tools. `category` decides the exit code of the command line. */
export class HvscError extends Error {
  readonly code: HvscErrorCode;
  readonly category: ErrorCategory;
  constructor(code: HvscErrorCode, message: string, category?: ErrorCategory) {
    super(message);
    this.name = "HvscError";
    this.code = code;
    this.category = category ?? (code === "usage" || code === "bad_value" || code === "bad_combination" ? "usage" : code === "too_large" ? "limit_exceeded" : "input");
  }
}

/** Largest HVSC database file read by default (Songlengths.md5 is 5 MB, STIL.txt 5 MB). */
export const DEFAULT_DATABASE_MAX_BYTES = 32 * 1024 * 1024;
/** Deepest directory level the walk descends (HVSC is 4 levels deep). */
export const MAX_WALK_DEPTH = 32;

/** Reads a file after checking its size; the size is compared before any byte is read. */
export function readBounded(path: string, maxBytes: number, label = path): Uint8Array {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw new HvscError("too_large", `${label} is ${size} bytes, over the limit of ${maxBytes}; raise it with --max-bytes if the file is legitimate`);
    const buffer = Buffer.allocUnsafe(size);
    let done = 0;
    while (done < size) {
      const n = readSync(fd, buffer, done, size - done, null);
      if (n <= 0) break;
      done += n;
    }
    return done === size ? buffer : buffer.subarray(0, done);
  } catch (error) {
    if (error instanceof HvscError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new HvscError(code === "ENOENT" ? "not_found" : "unreadable", `cannot read ${label}: ${code ?? (error as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface HvscDatabases {
  root: string;
  songlengths?: string;
  stil?: string;
}

/** Locates Songlengths.md5 (or the old Songlengths.txt) and STIL.txt below `<root>/DOCUMENTS`. */
export function hvscDatabases(root: string): HvscDatabases {
  const documents = join(root, "DOCUMENTS");
  const found: HvscDatabases = { root };
  for (const name of ["Songlengths.md5", "Songlengths.txt"]) {
    if (existsSync(join(documents, name))) { found.songlengths = join(documents, name); break; }
  }
  if (existsSync(join(documents, "STIL.txt"))) found.stil = join(documents, "STIL.txt");
  return found;
}

/**
 * The HVSC root named by `explicit` (`--hvsc`), else by the environment variable HVSC_ROOT. Returns undefined when
 * neither is set, and throws when the named directory does not exist.
 */
export function resolveHvscRoot(cwd: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = explicit ?? (env.HVSC_ROOT !== undefined && env.HVSC_ROOT !== "" ? env.HVSC_ROOT : undefined);
  if (named === undefined) return undefined;
  const root = resolve(cwd, named);
  let isDirectory = false;
  try { isDirectory = statSync(root).isDirectory(); } catch { /* reported below */ }
  if (!isDirectory) {
    throw new HvscError("not_found", `the HVSC root ${root} (from ${explicit !== undefined ? "--hvsc" : "HVSC_ROOT"}) is not a directory; pass the directory that contains DOCUMENTS, MUSICIANS and GAMES`);
  }
  return root;
}

/** Walks up from `start` (at most `levels` directories) to the first directory with a DOCUMENTS folder that holds a database. */
export function findHvscRootAbove(start: string, levels = 12): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i <= levels; i++) {
    const found = hvscDatabases(dir);
    if (found.songlengths !== undefined || found.stil !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** "/MUSICIANS/H/Hubbard_Rob/Commando.sid" for a file below `root`, else undefined. */
export function hvscPathOf(root: string, file: string): string | undefined {
  const base = resolve(root);
  const target = resolve(file);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(prefix)) return undefined;
  return `/${target.slice(prefix.length).split(sep).join("/")}`;
}

/** The absolute file of an HVSC path ("/MUSICIANS/X/Y.sid"). Rejects paths that would leave the root. */
export function fileOfHvscPath(root: string, hvscPath: string): string {
  const parts = hvscPath.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === ".." || part === ".")) throw new HvscError("bad_value", `the HVSC path ${hvscPath} must not contain "." or ".." segments`);
  return join(root, ...parts);
}

/** True for a path that names a SID file by extension. */
export const isSidName = (name: string): boolean => /\.sid$/i.test(name);

export interface WalkOptions {
  maxDepth?: number;
  /** Called for a directory that cannot be read; the walk continues. */
  onError?: (path: string, error: Error) => void;
}

/**
 * The `.sid` files below `dir`, directory by directory in code-unit order of the names. Symbolic links are not
 * followed, so a link loop cannot make the walk endless.
 */
export function* walkSidFiles(dir: string, options: WalkOptions = {}, depth = 0): Generator<string> {
  const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    options.onError?.(dir, error as Error);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (depth < maxDepth) yield* walkSidFiles(join(dir, entry.name), options, depth + 1);
      else options.onError?.(join(dir, entry.name), new HvscError("too_large", `directory nesting is deeper than ${maxDepth} levels`));
    } else if (entry.isFile() && isSidName(entry.name)) yield join(dir, entry.name);
  }
}

/** Decodes bytes as Windows-1252-compatible Latin-1 text (HVSC text files are not UTF-8). */
export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Reads a database text file with a size bound. */
export function readTextBounded(path: string, maxBytes: number, label = path): string {
  return latin1(readBounded(path, maxBytes, label));
}

// Kept for callers that only need to know whether a path is a readable regular file.
export function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
