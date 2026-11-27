// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// `sidwave stil parse | query`.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, type CliIo } from "./cliCore.js";
import { emitResult, numberFlag, one, parseFlags, type FlagSpec, type ParsedFlags } from "./cliHvscCommon.js";
import { DEFAULT_DATABASE_MAX_BYTES, findHvscRootAbove, hvscDatabases, hvscPathOf, readTextBounded, resolveHvscRoot } from "./hvsc.js";
import { formatStilQuery, parseStil, queryStil, type StilDb } from "./stil.js";

export const STIL_HELP = `sidwave stil: read the HVSC STIL (SID Tune Information List)

Usage:
  sidwave stil parse [<STIL.txt>] [--hvsc <root>] [--json]
  sidwave stil query <path-in-hvsc | file.sid> [--stil <STIL.txt> | --hvsc <root>] [--subtune <n>] [--json]

parse    Parse the whole file and print the number of entries, subtune blocks and fields, the version, and any line the
         parser did not understand. With --json the full content: every entry with its blocks and fields.
query    Print the STIL entry of one tune: the fields that apply to the whole file, then those of each subtune (NAME,
         AUTHOR, TITLE with album and timestamp, ARTIST, COMMENT). The argument is an HVSC path such as
         /MUSICIANS/H/Hubbard_Rob/Commando.sid, or a SID file below the HVSC root. Exit 1 when the tune has no entry.

The STIL file is <root>/DOCUMENTS/STIL.txt of --hvsc or of HVSC_ROOT, or the file named by --stil. STIL.txt is Latin-1.

Examples:
  sidwave stil query /MUSICIANS/H/Hubbard_Rob/Commando.sid --hvsc ~/C64Music
  sidwave stil query ~/C64Music/DEMOS/A-F/Bugle_Boy_BASIC.sid --subtune 3
  sidwave stil parse ~/C64Music/DOCUMENTS/STIL.txt
`;

const SPEC: FlagSpec = { values: ["--stil", "--hvsc", "--subtune"], switches: ["--json"] };

function stilFile(io: CliIo, flags: ParsedFlags, near: string | undefined, positional?: string): { path: string; root?: string } {
  const explicit = one(flags, "--stil") ?? positional;
  let root = resolveHvscRoot(io.cwd, one(flags, "--hvsc"));
  if (explicit !== undefined) return { path: resolve(io.cwd, explicit), ...(root === undefined ? {} : { root }) };
  if (root === undefined && near !== undefined) root = findHvscRootAbove(near);
  if (root === undefined) throw new UsageError("no STIL file given. Pass --stil <STIL.txt> or --hvsc <root>, or set HVSC_ROOT");
  const path = hvscDatabases(root).stil;
  if (path === undefined) throw new SidwaveOperationError("input", `no STIL.txt in ${root}/DOCUMENTS; pass the file with --stil`);
  return { path, root };
}

function load(path: string): StilDb {
  return parseStil(readTextBounded(path, DEFAULT_DATABASE_MAX_BYTES));
}

function parse(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, SPEC);
  if (flags.help) { io.out(STIL_HELP); return EXIT_OK; }
  if (flags.positional.length > 1) throw new UsageError("parse takes at most one file");
  const { path } = stilFile(io, flags, undefined, flags.positional[0]);
  const db = load(path);
  let blocks = 0;
  let fields = 0;
  for (const entry of db.entries.values()) { blocks += entry.blocks.length; for (const b of entry.blocks) fields += b.fields.length; }
  const summary = { file: path, version: db.version ?? null, entries: db.entries.size, blocks, fields, warnings: db.warnings };
  const text = [`${path}: STIL${db.version === undefined ? "" : ` v${db.version}`}, ${db.entries.size} entries, ${blocks} blocks, ${fields} fields`,
    ...db.warnings.slice(0, 20).map((w) => `warning: ${w}`), ...(db.warnings.length > 20 ? [`... ${db.warnings.length - 20} more warnings (--json for all)`] : [])].join("\n");
  emitResult(io, flags.switches.has("--json"), "stil parse", flags.switches.has("--json") ? { ...summary, items: [...db.entries.values()] } : summary, text);
  return EXIT_OK;
}

function query(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, SPEC);
  if (flags.help) { io.out(STIL_HELP); return EXIT_OK; }
  if (flags.positional.length !== 1) throw new UsageError('query needs an HVSC path or a SID file; see "sidwave stil --help"');
  const arg = flags.positional[0]!;
  const subtune = one(flags, "--subtune") === undefined ? undefined : numberFlag("--subtune", one(flags, "--subtune")!, 1, 256);
  const onDisk = resolve(io.cwd, arg);
  const isFile = existsSync(onDisk);
  let hvscPath: string | undefined;
  let near: string | undefined;
  if (isFile) near = dirname(onDisk);
  else if (/^\/?(DEMOS|GAMES|MUSICIANS)\//.test(arg)) hvscPath = arg.startsWith("/") ? arg : `/${arg}`;
  else throw new SidwaveOperationError("input", `${arg} is neither a file nor an HVSC path (which starts with /DEMOS/, /GAMES/ or /MUSICIANS/)`, { file: arg });
  const { path, root } = stilFile(io, flags, near);
  if (isFile) {
    hvscPath = root === undefined ? undefined : hvscPathOf(root, onDisk);
    if (hvscPath === undefined) throw new UsageError(`${arg} is not below the HVSC root${root === undefined ? "" : ` ${root}`}; give its HVSC path instead, for example /MUSICIANS/X/Name/File.sid`);
  }
  const result = queryStil(load(path), hvscPath!, subtune);
  const record = { stil: path, ...result, ...(subtune === undefined ? {} : { subtune }) };
  if (!result.found) {
    emitResult(io, flags.switches.has("--json"), "stil query", record, `no STIL entry for ${result.path} in ${path}`, false);
    return EXIT_FAILED;
  }
  emitResult(io, flags.switches.has("--json"), "stil query", record, formatStilQuery(result));
  return EXIT_OK;
}

/** `sidwave stil <parse|query>`; `args` are the arguments after "stil". */
export function runStilCli(args: string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") { io.out(STIL_HELP); return EXIT_OK; }
  if (sub === "parse") return parse(io, rest);
  if (sub === "query") return query(io, rest);
  throw new UsageError(`unknown stil command "${sub}"; use parse or query (sidwave stil --help)`);
}
