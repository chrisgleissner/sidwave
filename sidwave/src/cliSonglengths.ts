// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// `sidwave songlengths lookup | verify | write`.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, type CliIo } from "./cliCore.js";
import { emitResult, numberFlag, one, parseFlags, writeFileAtomic, type FlagSpec, type ParsedFlags } from "./cliHvscCommon.js";
import {
  DEFAULT_DATABASE_MAX_BYTES, findHvscRootAbove, hvscDatabases, hvscPathOf, readBounded, resolveHvscRoot,
} from "./hvsc.js";
import { DEFAULT_MAX_BYTES, SidFileError, parseSidFile } from "./sidFile.js";
import {
  formatSonglength, lookupSonglengthEntries, parseSonglengthList, readSonglengthsText, songlengthsFormatOf, songlengthsKey, verifySonglengths,
  writeSonglengthsEntry, type SonglengthsFormat,
} from "./songlengthsFile.js";

export const SONGLENGTHS_HELP = `sidwave songlengths: look up, verify and edit HVSC Songlengths databases

Usage:
  sidwave songlengths lookup <file.sid> | --md5 <hash>  [--db <file>|--hvsc <root>] [--song <n>] [--json]
  sidwave songlengths verify [<Songlengths.md5>] [<hvsc-root>] [--unlisted] [--limit <n>] [--json]
  sidwave songlengths write  <database> <file.sid> --times <list> [--path <hvsc path>] [--dry-run] [-o <out>] [--json]
  sidwave songlengths write  <database> <file.sid> --from-md5 <old key> [--times <list>] [--path <hvsc path>]

Both formats are read and written: Songlengths.md5 (key = MD5 of the whole file) and the old Songlengths.txt (key =
MD5 of the data and some header fields, whole seconds, optional attributes); the format follows the file extension, or
--format md5|txt. The database defaults to <root>/DOCUMENTS/Songlengths.md5 of --hvsc or HVSC_ROOT.

lookup   Print the song lengths of a file (or of a key with --md5) and the path comments of its entries. Exit 1 when the
         key is not listed.
verify   Check that every entry has a file below the HVSC root with that key. Reports missing files, files with another
         key, files that cannot be read, entries whose number of times differs from the number of songs, and (with
         --unlisted) SID files that have no entry. Exit 1 when anything but an unlisted file is found.
write    Add or update the entry of a file. Only the changed or added lines differ from the input: line breaks, comments,
         "; /path" lines and all other entries stay byte for byte. --times takes one time per subtune, separated by
         commas: m:ss, m:ss.SSS or seconds (3:57,1:02.5,90). An entry that is already listed gets the new times in
         place. --from-md5 re-keys the entry that the file had before it was edited (see "sidwave sid edit"). A new
         entry is inserted in path order and needs --path, or a file below the HVSC root. In the old format the times
         are rounded to whole seconds and the attributes (G), (M), (Z), (B) of the subtune are kept. The database is
         replaced in place unless -o is given.

Examples:
  sidwave songlengths lookup Commando.sid --hvsc ~/C64Music
  sidwave songlengths lookup --md5 c4c5ff8cfefdf683c50e66775cfac1ee --db Songlengths.md5 --json
  sidwave songlengths verify ~/C64Music/DOCUMENTS/Songlengths.md5 ~/C64Music
  sidwave songlengths write Songlengths.md5 NewTune.sid --path /MUSICIANS/X/Xyz/NewTune.sid --times 2:30,1:10.5
  sidwave sid edit Tune.sid --author "New Name" --in-place --hvsc ~/C64Music
  sidwave songlengths write ~/C64Music/DOCUMENTS/Songlengths.md5 Tune.sid --from-md5 <old key printed by sid edit>
`;

const SPEC: FlagSpec = {
  values: ["--db", "--hvsc", "--md5", "--song", "--format", "--times", "--path", "--from-md5", "-o", "--limit", "--max-bytes"],
  switches: ["--json", "--unlisted", "--dry-run"],
  aliases: { "--songlengths": "--db", "--output": "-o" },
};

function formatOf(flags: ParsedFlags, path: string): SonglengthsFormat {
  const text = one(flags, "--format");
  if (text === undefined) return songlengthsFormatOf(path);
  if (text !== "md5" && text !== "txt") throw new UsageError(`--format must be md5 or txt, not "${text}"`);
  return text;
}

function databasePath(io: CliIo, explicit: string | undefined, root: string | undefined): string {
  if (explicit !== undefined) return resolve(io.cwd, explicit);
  if (root !== undefined) {
    const found = hvscDatabases(root).songlengths;
    if (found !== undefined) return found;
    throw new SidwaveOperationError("input", `no Songlengths.md5 or Songlengths.txt in ${join(root, "DOCUMENTS")}; pass the database file explicitly`);
  }
  throw new UsageError("no Songlengths database given. Pass --db <file> (or --hvsc <root>), or set HVSC_ROOT");
}

const maxBytesOf = (flags: ParsedFlags): number => (flags.values.has("--max-bytes") ? numberFlag("--max-bytes", one(flags, "--max-bytes")!, 1, Number.MAX_SAFE_INTEGER) : DEFAULT_MAX_BYTES);

function readSid(io: CliIo, flags: ParsedFlags, file: string): { bytes: Uint8Array; songs: number } {
  const bytes = readBounded(resolve(io.cwd, file), maxBytesOf(flags), file);
  try { return { bytes, songs: parseSidFile(bytes).songs }; } catch (error) {
    if (error instanceof SidFileError) throw new SidwaveOperationError("input", `${file}: ${error.message}; is it a PSID or RSID file?`, { file, code: error.code });
    throw error;
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(3).replace(/\.?0+$/, "")} s`;

function lookup(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, SPEC);
  if (flags.help) { io.out(SONGLENGTHS_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  const md5Flag = one(flags, "--md5");
  if ((md5Flag === undefined) === (flags.positional.length !== 1)) {
    if (md5Flag !== undefined && flags.positional.length > 0) throw new UsageError("give a file or --md5, not both");
    throw new UsageError('lookup needs a SID file or --md5 <hash>; see "sidwave songlengths --help"');
  }
  const fileArg = flags.positional[0];
  const sidDir = fileArg === undefined ? undefined : dirname(resolve(io.cwd, fileArg));
  let root = resolveHvscRoot(io.cwd, one(flags, "--hvsc"));
  if (root === undefined && one(flags, "--db") === undefined && sidDir !== undefined) root = findHvscRootAbove(sidDir);
  const path = databasePath(io, one(flags, "--db"), root);
  const format = formatOf(flags, path);
  let key: string;
  let songs: number | undefined;
  if (md5Flag !== undefined) {
    if (!/^[0-9a-f]{32}$/i.test(md5Flag)) throw new UsageError(`--md5 needs 32 hexadecimal digits, not "${md5Flag}"`);
    key = md5Flag.toLowerCase();
  } else {
    const sid = readSid(io, flags, fileArg!);
    key = songlengthsKey(sid.bytes, format);
    songs = sid.songs;
  }
  const song = one(flags, "--song") === undefined ? undefined : numberFlag("--song", one(flags, "--song")!, 1, 256);
  const entries = lookupSonglengthEntries(readSonglengthsText(path), key);
  const label = fileArg ?? key;
  const record = {
    md5: key, format, database: path, found: entries.length > 0, ...(songs === undefined ? {} : { songs }),
    entries: entries.map((e) => ({ path: e.path || null, line: e.line, durationsMs: song === undefined ? e.durations : e.durations[song - 1] === undefined ? [] : [e.durations[song - 1]!] })),
  };
  if (entries.length === 0) {
    emitResult(io, json, "songlengths lookup", record, `${label}: not listed in ${path} (${format === "txt" ? "old" : "new"} format key ${key})`, false);
    return EXIT_FAILED;
  }
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${label}: ${entry.path || "(no path comment)"}  key ${key}  line ${entry.line}`);
    entry.durations.forEach((ms, i) => { if (song === undefined || song === i + 1) lines.push(`  song ${i + 1}: ${formatSonglength(ms, format)} (${seconds(ms)})`); });
    if (song !== undefined && entry.durations[song - 1] === undefined) lines.push(`  song ${song}: not in the entry (it has ${entry.durations.length})`);
    if (songs !== undefined && songs !== entry.durations.length) lines.push(`  warning: the file has ${songs} songs, the entry ${entry.durations.length} times`);
  }
  emitResult(io, json, "songlengths lookup", record, lines.join("\n"));
  return EXIT_OK;
}

function verify(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, SPEC);
  if (flags.help) { io.out(SONGLENGTHS_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  if (flags.positional.length > 2) throw new UsageError("verify takes a database and an HVSC root; see \"sidwave songlengths --help\"");
  let dbArg = one(flags, "--db");
  let rootArg = one(flags, "--hvsc");
  for (const p of flags.positional) {
    const isDirectory = (() => { try { return statSync(resolve(io.cwd, p)).isDirectory(); } catch { return false; } })();
    if (isDirectory && rootArg === undefined) rootArg = p;
    else if (!isDirectory && dbArg === undefined) dbArg = p;
    else throw new UsageError(`cannot tell what "${p}" is; verify takes <Songlengths.md5> and <hvsc-root>`);
  }
  const root = resolveHvscRoot(io.cwd, rootArg);
  if (root === undefined) throw new UsageError("no HVSC root given. Pass it as the second argument or --hvsc <root>, or set HVSC_ROOT");
  const path = databasePath(io, dbArg, root);
  const format = formatOf(flags, path);
  const limit = flags.values.has("--limit") ? numberFlag("--limit", one(flags, "--limit")!, 0, 1_000_000) : 50;
  const report = verifySonglengths(readSonglengthsText(path), root, { format, unlisted: flags.switches.has("--unlisted") });
  const problems = report.missing.length + report.wrongMd5.length + report.unreadable.length + report.subtuneMismatch.length;
  const lines = [`${path}: ${report.entries} entries (${format === "txt" ? "old" : "new"} format), checked against ${root}`, `  ok: ${report.ok}`];
  const section = <T,>(name: string, items: T[], show: (item: T) => string): void => {
    if (items.length === 0) return;
    lines.push(`  ${name}: ${items.length}`);
    for (const item of items.slice(0, limit)) lines.push(`    ${show(item)}`);
    if (items.length > limit) lines.push(`    ... ${items.length - limit} more (--limit ${items.length}, or --json for all)`);
  };
  section("missing files", report.missing, (m) => `${m.path} (line ${m.line})`);
  section("wrong MD5", report.wrongMd5, (w) => `${w.path} (line ${w.line}): listed ${w.expected}, file has ${w.actual}${w.listedAs ? `, which is listed for ${w.listedAs}` : ""}`);
  section("unreadable files", report.unreadable, (u) => `${u.path} (line ${u.line}): ${u.reason}`);
  section("number of times differs from the number of songs", report.subtuneMismatch, (m) => `${m.path} (line ${m.line}): ${m.songs} songs, ${m.durations} times`);
  section("entries without a path comment (not checked)", report.noPath, (n) => `${n.md5} (line ${n.line})`);
  if (report.unlistedFiles) section("SID files without an entry", report.unlistedFiles, (f) => f);
  lines.push(problems === 0 ? "  no problems" : `  ${problems} problem${problems === 1 ? "" : "s"}`);
  emitResult(io, json, "songlengths verify", { database: path, root, ...report, problems }, lines.join("\n"), problems === 0);
  return problems === 0 ? EXIT_OK : EXIT_FAILED;
}

function write(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, SPEC);
  if (flags.help) { io.out(SONGLENGTHS_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  if (flags.positional.length !== 2) throw new UsageError('write needs a database and a SID file; see "sidwave songlengths --help"');
  const [dbArg, fileArg] = flags.positional as [string, string];
  const dbPath = resolve(io.cwd, dbArg);
  const format = formatOf(flags, dbPath);
  const sid = readSid(io, flags, fileArg);
  const key = songlengthsKey(sid.bytes, format);
  const timesArg = one(flags, "--times");
  const fromMd5 = one(flags, "--from-md5");
  if (fromMd5 !== undefined && !/^[0-9a-f]{32}$/i.test(fromMd5)) throw new UsageError(`--from-md5 needs 32 hexadecimal digits, not "${fromMd5}"`);
  const durations = timesArg === undefined ? undefined : parseSonglengthList(timesArg);
  if (durations !== undefined && durations.length !== sid.songs) {
    throw new UsageError(`${fileArg} has ${sid.songs} song${sid.songs === 1 ? "" : "s"}, but --times has ${durations.length} time${durations.length === 1 ? "" : "s"}; give one time per subtune`);
  }
  let hvscPath = one(flags, "--path");
  if (hvscPath === undefined) {
    const root = resolveHvscRoot(io.cwd, one(flags, "--hvsc")) ?? findHvscRootAbove(dirname(resolve(io.cwd, fileArg)));
    if (root !== undefined) hvscPath = hvscPathOf(root, resolve(io.cwd, fileArg));
  }
  if (hvscPath !== undefined) {
    if (!hvscPath.startsWith("/")) hvscPath = `/${hvscPath}`;
    if ([...hvscPath].some((c) => c.charCodeAt(0) > 255)) throw new UsageError("the HVSC path must be in Latin-1 characters, as in the database");
  }
  const text = readSonglengthsText(dbPath, DEFAULT_DATABASE_MAX_BYTES);
  const result = writeSonglengthsEntry(text, {
    md5: key, ...(durations === undefined ? {} : { durations }), ...(hvscPath === undefined ? {} : { path: hvscPath }), ...(fromMd5 === undefined ? {} : { fromMd5 }),
  }, format);
  const warnings: string[] = [];
  if (result.action === "rekeyed" && durations === undefined) {
    const carried = result.changes[0] && /=(.*)$/.exec(result.changes[0].after)?.[1]?.split(/\s+/).filter(Boolean).length;
    if (carried !== undefined && carried !== sid.songs) warnings.push(`the entry has ${carried} times but the file has ${sid.songs} songs; give --times with one time per subtune`);
  }
  const dryRun = flags.switches.has("--dry-run");
  const outFlag = one(flags, "-o");
  const outPath = outFlag === undefined ? dbPath : resolve(io.cwd, outFlag);
  if (!dryRun && result.action !== "unchanged") writeFileAtomic(outPath, Buffer.from(result.text, "latin1"));
  const lines = [`${dbArg}: entry ${result.action}${dryRun ? " (dry run, nothing written)" : result.action === "unchanged" ? "" : outFlag === undefined ? "" : ` in ${outPath}`}  key ${key}${hvscPath === undefined ? "" : `  ${hvscPath}`}`];
  for (const change of result.changes) {
    if (change.before !== "") lines.push(`  line ${change.line}: - ${change.before}`);
    lines.push(`${change.before === "" ? "  + " : "           + "}${change.after.replace(/\r?\n/g, "\n    + ")}`);
  }
  lines.push(...warnings.map((w) => `warning: ${w}`));
  emitResult(io, json, "songlengths write", { database: dbPath, output: dryRun ? null : outPath, dryRun, md5: key, format, path: hvscPath ?? null, action: result.action, changes: result.changes, warnings }, lines.join("\n"));
  return EXIT_OK;
}

/** `sidwave songlengths <lookup|verify|write>`; `args` are the arguments after "songlengths". */
export function runSonglengthsCli(args: string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") { io.out(SONGLENGTHS_HELP); return EXIT_OK; }
  if (sub === "lookup") return lookup(io, rest);
  if (sub === "verify") return verify(io, rest);
  if (sub === "write") return write(io, rest);
  throw new UsageError(`unknown songlengths command "${sub}"; use lookup, verify or write (sidwave songlengths --help)`);
}
