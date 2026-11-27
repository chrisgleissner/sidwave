// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// `sidwave sid info | edit | player` and the old name `sidwave sid-info`.

import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, classifyError, envelope, type CliIo, type ErrorReport } from "./cliCore.js";
import {
  LineWriter, addressFlag, emitResult, loadContext, numberFlag, one, parseFlags, hvscPathFor, sameFile, songlengthsOf, writeFileAtomic,
  type FlagSpec, type HvscContext, type ParsedFlags,
} from "./cliHvscCommon.js";
import { readBounded, walkSidFiles } from "./hvsc.js";
import { editSidHeader, type SidEditFields, type SidEditResult } from "./sidEdit.js";
import { identifySidPlayer, loadSidIdSignatures, type SidIdMatch } from "./sidId.js";
import { DEFAULT_MAX_BYTES, SidFileError, parseSidFile, type Clock, type SidFileModel, type SongSpeed } from "./sidFile.js";
import { formatSonglength } from "./songlengthsFile.js";
import { formatStilQuery, queryStil, type StilQueryResult } from "./stil.js";
import { sidInfo, type SidInfo } from "./sidwaveTools.js";

export const SID_HELP = `sidwave sid: look at and edit SID files (PSID and RSID headers)

Usage:
  sidwave sid info   <file.sid|directory> [--hvsc <root>] [--songlengths <file>] [--stil <file>] [--hvsc-path <path>] [--json]
  sidwave sid edit   <file.sid> [field options] [-o <out>|--in-place] [--dry-run] [--strict] [--force] [--json]
  sidwave sid player <file.sid|directory> --sidid <sidid.cfg> [--all] [--json]
  sidwave sid-info   <file.sid> [--songlengths <file>] [--json]     (the old name of "sid info")

Run "sidwave sid info --help", "sidwave sid edit --help" or "sidwave sid player --help" for the options and examples.
The HVSC root defaults to the environment variable HVSC_ROOT. See doc/hvsc.md.
`;

export const SID_INFO_HELP = `sidwave sid info: print the header of a SID file, with its Songlengths and STIL entries

Usage:
  sidwave sid info <file.sid> [options]
  sidwave sid info <directory> [options]      one line per SID file below the directory (--json: one JSON object per line)

Options:
  --hvsc <root>         HVSC root. Songlengths.md5 (or Songlengths.txt) and STIL.txt are read from <root>/DOCUMENTS.
                        Defaults to HVSC_ROOT. Without either, a root above the file or directory is used when there is one.
  --songlengths <file>  Songlengths database (new .md5 or old .txt format), instead of the one under the root.
  --stil <file>         STIL file, instead of the one under the root.
  --hvsc-path <path>    HVSC path of the file for the STIL lookup, when the file is not below the HVSC root.
  --max-bytes <n>       Refuse SID files larger than <n> bytes (default ${DEFAULT_MAX_BYTES}).
  --json                One JSON envelope for a file; for a directory one JSON object per line, then nothing else on standard output.

A directory run reports unreadable files and continues; the exit code is 1 when any file failed.

Examples:
  sidwave sid info Commando.sid
  sidwave sid info ~/C64Music/MUSICIANS/H/Hubbard_Rob/Commando.sid --hvsc ~/C64Music
  HVSC_ROOT=~/C64Music sidwave sid info ~/C64Music/MUSICIANS/H --json > hubbard.jsonl
`;

export const SID_EDIT_HELP = `sidwave sid edit: change header fields of a SID file; all other bytes stay as they are

Usage:
  sidwave sid edit <file.sid> <field options> [-o <out>] [--dry-run]

Fields:
  --title <text>  --author <text>  --released <text>        (at most 32 characters each, Windows-1252)
  --songs <n>  --start-song <n>
  --speed <0x..|0b..|n|vbi|cia>   all 32 speed bits; "vbi" is 0, "cia" sets the bit of every song
  --speed-song <n>=vbi|cia        speed of one song (repeat the option)
  --clock pal|ntsc|both|unknown   --model 6581|8580|both|unknown   (first SID; --model2 and --model3 for the others)
  --sid2 <address|none>  --sid3 <address|none>       $D420-$D7E0 or $DE00-$DFE0 in steps of $20
  --mus-player on|off  --playsid on|off (PSID)  --basic on|off (RSID)
  --version <1-4>  --magic psid|rsid
  --load <addr>  --init <addr>  --play <addr>        header addresses (--load does not move the code)
  --reloc-start <page>  --reloc-pages <n>  --reloc none

Output:
  -o <file>      Write here (default <name>.edited.sid in the current directory; "-o -" writes the file to standard output).
  --in-place     Replace the input file.
  --force        Overwrite an existing output file.
  --dry-run      Print the field changes and the MD5 values and write nothing.
  --strict       Treat a result that deviates from the PSID specification as an error, not a warning.
  --songlengths <file> | --hvsc <root>   Say whether the old MD5 key is listed in the database.
  --json         Machine-readable result.

Only the bytes of the named fields change. A field that needs a newer header version raises the version and prints a
warning. The command prints the MD5 key before and after (Songlengths.md5 uses the MD5 of the whole file, so an edit
of any header field changes it; the old Songlengths.txt key ignores text fields). To keep the song lengths of an
edited file, run: sidwave songlengths write <database> <edited.sid> --from-md5 <old md5>

Examples:
  sidwave sid edit Commando.sid --author "Rob Hubbard" --released "1985 Commodore" -o fixed.sid
  sidwave sid edit tune.sid --clock pal --model 6581 --dry-run
  sidwave sid edit multi.sid --speed-song 2=cia --speed-song 3=cia --in-place
`;

export const SID_PLAYER_HELP = `sidwave sid player: identify the player or editor of a SID file with SIDId-style signatures

Usage:
  sidwave sid player <file.sid|directory> --sidid <sidid.cfg> [--all] [--json]

Options:
  --sidid <file>      Signature file of SIDId (sidid.cfg). Defaults to the environment variable SIDID_CFG (or SIDIDCFG).
                      sidwave does not contain a signature file: take the one that comes with SIDId and check its licence.
  --sidid-info <file> The sidid.nfo with names and authors (default: sidid.nfo beside the signature file, when there is one).
  --all               List every player that matches, not only the first in file order (a tune can hold a sample routine too).
  --max-bytes <n>     Refuse SID files larger than <n> bytes.
  --json              One envelope for a file; for a directory one JSON object per line.

The signatures are matched against the C64 data of the tune. The confidence is "high" for a signature with 14 or more
fixed bytes, "medium" for 8 to 13 and "low" below that; a player that matches with two signatures is one step higher.
It measures how specific the matching signature is, not how often the signature is right.

Examples:
  sidwave sid player Commando.sid --sidid ~/tools/sidid/sidid.cfg
  SIDID_CFG=~/tools/sidid/sidid.cfg sidwave sid player ~/C64Music/MUSICIANS/H --json > players.jsonl
`;

// ---- info ---------------------------------------------------------------------------------------------------------

export interface SidInfoRecord extends SidInfo {
  musPlayer: boolean;
  psidSpecific: boolean;
  basic: boolean;
  startPage: number;
  pageLength: number;
  hvscPath?: string;
  stil?: StilQueryResult;
}

const hex = (n: number, w = 4): string => `$${n.toString(16).toUpperCase().padStart(w, "0")}`;

function describeFile(bytes: Uint8Array, context: HvscContext, file: string, hvscPathOption?: string): SidInfoRecord {
  const info = sidInfo(bytes);
  const parsed = parseSidFile(bytes);
  const record: SidInfoRecord = {
    ...info, musPlayer: parsed.musPlayer, psidSpecific: parsed.psidSpecific, basic: parsed.basic, startPage: parsed.startPage, pageLength: parsed.pageLength,
  };
  const lengths = songlengthsOf(context, bytes);
  if (context.songlengths !== undefined) {
    record.songlengths = Array.from({ length: info.songs }, (_, i) => (lengths?.[i] === undefined ? null : lengths[i]! / 1000));
  }
  const path = hvscPathFor(context, file, hvscPathOption);
  if (path !== undefined) record.hvscPath = path;
  if (context.stil !== undefined && path !== undefined) {
    const result = queryStil(context.stil, path);
    if (result.found) record.stil = result;
  }
  return record;
}

function infoText(file: string, info: SidInfoRecord, stilText: string): string {
  const lines = [
    `${file}: ${info.magic} v${info.version}, ${info.songs} song${info.songs === 1 ? "" : "s"}, start song ${info.startSong}`,
    `name: ${info.name}`, `author: ${info.author}`, `released: ${info.released}`,
    `load ${hex(info.loadAddress)}, init ${hex(info.initAddress)}, play ${hex(info.playAddress)}`,
    `clock ${info.clock}, SID models ${info.sidModels.join("/")}, speed ${info.speeds.every((v) => v === info.speeds[0]) ? `${info.speeds[0]}${info.songs > 1 ? " (all songs)" : ""}` : info.speeds.join(",")}`,
    `md5 ${info.md5}`,
    `size ${info.sizeBytes} bytes, data ${info.payloadBytes} bytes`,
  ];
  if (info.secondSidAddress !== undefined) lines.push(`second SID ${hex(info.secondSidAddress)}${info.thirdSidAddress === undefined ? "" : `, third SID ${hex(info.thirdSidAddress)}`}`);
  else if (info.thirdSidAddress !== undefined) lines.push(`third SID ${hex(info.thirdSidAddress)}`);
  const flags = [info.musPlayer ? "MUS player" : "", info.psidSpecific ? "PlaySID specific" : "", info.basic ? "BASIC" : ""].filter(Boolean);
  if (flags.length > 0) lines.push(`flags: ${flags.join(", ")}`);
  if (info.startPage !== 0 || info.pageLength !== 0) lines.push(`relocation: start page ${hex(info.startPage, 2)}, ${info.pageLength} page${info.pageLength === 1 ? "" : "s"}`);
  if (info.hvscPath !== undefined) lines.push(`HVSC path ${info.hvscPath}`);
  if (info.songlengths) lines.push(`song lengths: ${info.songlengths.map((s) => (s === null ? "unknown" : `${s}s`)).join(", ")}`);
  if (stilText !== "") lines.push(stilText);
  lines.push(...info.warnings.map((w) => `warning: ${w}`));
  return lines.join("\n");
}

function stilBlock(result: StilQueryResult | undefined): string {
  return result === undefined ? "" : ["STIL:", ...formatStilQuery(result).split("\n").slice(1)].join("\n");
}

const INFO_SPEC: FlagSpec = {
  values: ["--hvsc", "--songlengths", "--stil", "--hvsc-path", "--max-bytes"],
  switches: ["--json"],
};

function targetOf(io: CliIo, flags: ParsedFlags, what: string): { target: string; isDirectory: boolean } {
  if (flags.positional.length !== 1) throw new UsageError(`${what} needs exactly one file or directory; see "sidwave sid ${what.split(" ")[0]} --help"`);
  const target = resolve(io.cwd, flags.positional[0]!);
  let isDirectory: boolean;
  try { isDirectory = statSync(target).isDirectory(); } catch (error) {
    throw new SidwaveOperationError("input", `cannot read ${flags.positional[0]}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: flags.positional[0]! });
  }
  return { target, isDirectory };
}

const maxBytesOf = (flags: ParsedFlags): number => (flags.values.has("--max-bytes") ? numberFlag("--max-bytes", one(flags, "--max-bytes")!, 1, Number.MAX_SAFE_INTEGER) : DEFAULT_MAX_BYTES);

/** Runs a function per SID file below a directory; a failure of one file is reported and the run goes on. */
function batch(io: CliIo, flags: ParsedFlags, directory: string, perFile: (path: string, bytes: Uint8Array) => { json: unknown; text: string }, summaryName: string): number {
  const json = flags.switches.has("--json");
  const maxBytes = maxBytesOf(flags);
  const writer = new LineWriter(io);
  let files = 0;
  let failures = 0;
  const started = Date.now();
  for (const path of walkSidFiles(directory, { onError: (dir, error) => io.err(`warning: cannot read directory ${relative(directory, dir) || dir}: ${error.message}\n`) })) {
    files++;
    const name = relative(directory, path).split("\\").join("/");
    try {
      const { json: record, text } = perFile(path, readBounded(path, maxBytes, name));
      writer.line(json ? JSON.stringify({ file: name, ...(record as object) }) : text);
    } catch (error) {
      failures++;
      const report: ErrorReport = classifyError(error);
      writer.line(json ? JSON.stringify({ file: name, error: { category: report.category, message: report.message } }) : `${name}: error: ${report.message}`);
    }
  }
  writer.flush();
  io.err(`${summaryName}: ${files} file${files === 1 ? "" : "s"}, ${failures} failed, ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  if (files === 0) io.err(`warning: no .sid files below ${directory}\n`);
  return failures > 0 ? EXIT_FAILED : EXIT_OK;
}

export function sidInfoCommand(io: CliIo, args: string[], commandName = "sid info"): number {
  const flags = parseFlags(args, INFO_SPEC);
  if (flags.help) { io.out(SID_INFO_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  const { target, isDirectory } = targetOf(io, flags, "info");
  const context = loadContext(io, flags, { near: isDirectory ? target : dirname(target), wantSonglengths: true, wantStil: true, discover: true });
  if (isDirectory) {
    return batch(io, flags, target, (path, bytes) => {
      const record = describeFile(bytes, context, path);
      const brief = `${relative(target, path)}: ${record.magic} v${record.version}, ${record.songs} song${record.songs === 1 ? "" : "s"}, "${record.name}" by ${record.author}, ${record.released}`
        + `${record.songlengths ? `, ${record.songlengths.map((s) => (s === null ? "?" : formatSonglength(s * 1000))).join(" ")}` : ""}`;
      return { json: record, text: brief };
    }, "sid info");
  }
  const file = flags.positional[0]!;
  const bytes = readBounded(target, maxBytesOf(flags), file);
  let record: SidInfoRecord;
  try { record = describeFile(bytes, context, target, one(flags, "--hvsc-path")); } catch (error) {
    if (error instanceof SidFileError) throw new SidwaveOperationError("input", `${file}: ${error.message}; is it a PSID or RSID file?`, { file, code: error.code });
    throw error;
  }
  emitResult(io, json, commandName, { file, ...record }, infoText(file, record, stilBlock(record.stil)));
  return EXIT_OK;
}

// ---- edit ---------------------------------------------------------------------------------------------------------

const EDIT_SPEC: FlagSpec = {
  values: [
    "--title", "--author", "--released", "--songs", "--start-song", "--speed", "--speed-song", "--clock", "--model", "--model2", "--model3",
    "--sid2", "--sid3", "--mus-player", "--playsid", "--basic", "--version", "--magic", "--load", "--init", "--play", "--reloc-start", "--reloc-pages",
    "--reloc", "-o", "--hvsc", "--songlengths", "--max-bytes",
  ],
  switches: ["--in-place", "--force", "--dry-run", "--strict", "--json"],
  aliases: { "--name": "--title", "--output": "-o" },
};

const CLOCKS: Record<string, Clock> = { pal: "PAL", ntsc: "NTSC", both: "PAL+NTSC", "pal+ntsc": "PAL+NTSC", unknown: "unknown", any: "PAL+NTSC" };
const MODELS: Record<string, SidFileModel> = { "6581": "6581", "8580": "8580", both: "6581+8580", "6581+8580": "6581+8580", unknown: "unknown", any: "6581+8580" };

function mapped<T>(name: string, text: string, table: Record<string, T>): T {
  const value = table[text.trim().toLowerCase()];
  if (value === undefined) throw new UsageError(`${name} must be one of ${Object.keys(table).join(", ")}, not "${text}"`);
  return value;
}

function onOff(name: string, text: string): boolean {
  const t = text.trim().toLowerCase();
  if (["on", "yes", "true", "1"].includes(t)) return true;
  if (["off", "no", "false", "0"].includes(t)) return false;
  throw new UsageError(`${name} must be on or off, not "${text}"`);
}

function sidAddressFlag(name: string, text: string): number | null {
  if (/^(none|off|0)$/i.test(text.trim())) return null;
  return addressFlag(name, text);
}

function speedFlag(text: string, songs: number): number {
  const t = text.trim().toLowerCase();
  if (t === "vbi") return 0;
  if (t === "cia") return songs >= 32 ? 0xffffffff : ((1 << songs) - 1) >>> 0;
  const match = /^(?:0x([0-9a-f]{1,8})|0b([01]{1,32})|(\d+))$/.exec(t);
  if (!match) throw new UsageError(`--speed needs vbi, cia, or a number such as 0x5 or 0b101, not "${text}"`);
  const value = match[1] !== undefined ? Number.parseInt(match[1], 16) : match[2] !== undefined ? Number.parseInt(match[2], 2) : Number(match[3]);
  if (value > 0xffffffff) throw new UsageError("--speed is a 32 bit value");
  return value;
}

function fieldsOf(flags: ParsedFlags, songs: number): SidEditFields {
  const fields: SidEditFields = {};
  const text = (flag: string): string | undefined => one(flags, flag);
  const set = <K extends keyof SidEditFields>(key: K, value: SidEditFields[K] | undefined): void => { if (value !== undefined) fields[key] = value; };
  set("name", text("--title"));
  set("author", text("--author"));
  set("released", text("--released"));
  const s = text("--songs"); if (s !== undefined) fields.songs = numberFlag("--songs", s, 1, 256);
  const ss = text("--start-song"); if (ss !== undefined) fields.startSong = numberFlag("--start-song", ss, 1, 256);
  const speed = text("--speed"); if (speed !== undefined) fields.speed = speedFlag(speed, fields.songs ?? songs);
  for (const entry of flags.values.get("--speed-song") ?? []) {
    const match = /^(\d+)\s*[=:]\s*(vbi|cia)$/i.exec(entry.trim());
    if (!match) throw new UsageError(`--speed-song needs <song>=vbi or <song>=cia, not "${entry}"`);
    (fields.speedSongs ??= {})[numberFlag("--speed-song", match[1]!, 1, 256)] = match[2]!.toUpperCase() as SongSpeed;
  }
  const clock = text("--clock"); if (clock !== undefined) fields.clock = mapped("--clock", clock, CLOCKS);
  const m1 = text("--model"); if (m1 !== undefined) fields.sidModel = mapped("--model", m1, MODELS);
  const m2 = text("--model2"); if (m2 !== undefined) fields.sid2Model = mapped("--model2", m2, MODELS);
  const m3 = text("--model3"); if (m3 !== undefined) fields.sid3Model = mapped("--model3", m3, MODELS);
  const a2 = text("--sid2"); if (a2 !== undefined) fields.secondSidAddress = sidAddressFlag("--sid2", a2);
  const a3 = text("--sid3"); if (a3 !== undefined) fields.thirdSidAddress = sidAddressFlag("--sid3", a3);
  const mus = text("--mus-player"); if (mus !== undefined) fields.musPlayer = onOff("--mus-player", mus);
  const playsid = text("--playsid"); if (playsid !== undefined) fields.psidSpecific = onOff("--playsid", playsid);
  const basic = text("--basic"); if (basic !== undefined) fields.basic = onOff("--basic", basic);
  const version = text("--version"); if (version !== undefined) fields.version = numberFlag("--version", version, 1, 4) as 1 | 2 | 3 | 4;
  const magic = text("--magic"); if (magic !== undefined) fields.magic = mapped("--magic", magic, { psid: "PSID", rsid: "RSID" } as Record<string, "PSID" | "RSID">);
  const load = text("--load"); if (load !== undefined) fields.loadAddress = addressFlag("--load", load);
  const init = text("--init"); if (init !== undefined) fields.initAddress = addressFlag("--init", init);
  const play = text("--play"); if (play !== undefined) fields.playAddress = addressFlag("--play", play);
  const reloc = text("--reloc");
  if (reloc !== undefined) {
    if (reloc.trim().toLowerCase() !== "none") throw new UsageError(`--reloc takes only "none"; use --reloc-start and --reloc-pages for a range`);
    fields.startPage = 0;
    fields.pageLength = 0;
  }
  const rs = text("--reloc-start"); if (rs !== undefined) fields.startPage = addressFlag("--reloc-start", rs, 0xff);
  const rp = text("--reloc-pages"); if (rp !== undefined) fields.pageLength = numberFlag("--reloc-pages", rp, 0, 255);
  return fields;
}

function editText(file: string, output: string | undefined, result: SidEditResult, hint: string[], dryRun: boolean): string {
  const lines = [`${file}${output === undefined ? "" : ` -> ${output}`}${dryRun ? " (dry run, nothing written)" : ""}`];
  if (result.changes.length === 0) lines.push("  no field changes");
  for (const c of result.changes) lines.push(`  ${c.field}: ${c.from} -> ${c.to}  (bytes ${hex(c.offset, 2)}-${hex(c.offset + c.length - 1, 2)})`);
  if (result.layoutChanged) lines.push(`  header ${result.version.from === 1 ? "extended by 6 bytes" : "shortened by 6 bytes"}; the data moved with it`);
  lines.push(`md5 (Songlengths.md5)  ${result.md5.old === result.md5.new ? `unchanged ${result.md5.new}` : `old ${result.md5.old}\n                       new ${result.md5.new}`}`);
  lines.push(`md5 (Songlengths.txt)  ${result.legacyMd5.old === result.legacyMd5.new ? `unchanged ${result.legacyMd5.new}` : `old ${result.legacyMd5.old}\n                       new ${result.legacyMd5.new}`}`);
  lines.push(...hint);
  lines.push(...result.warnings.map((w) => `warning: ${w}`));
  return lines.join("\n");
}

export function sidEditCommand(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, EDIT_SPEC);
  if (flags.help) { io.out(SID_EDIT_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  if (flags.positional.length !== 1) throw new UsageError('sid edit needs exactly one SID file; see "sidwave sid edit --help"');
  const file = flags.positional[0]!;
  const input = resolve(io.cwd, file);
  const dryRun = flags.switches.has("--dry-run");
  const inPlace = flags.switches.has("--in-place");
  const outputFlag = one(flags, "-o");
  if (inPlace && outputFlag !== undefined) throw new UsageError("--in-place and -o are alternatives");
  const bytes = readBounded(input, maxBytesOf(flags), file);
  let parsedSongs: number;
  try { parsedSongs = parseSidFile(bytes).songs; } catch (error) {
    if (error instanceof SidFileError) throw new SidwaveOperationError("input", `${file}: ${error.message}; is it a PSID or RSID file?`, { file, code: error.code });
    throw error;
  }
  const fields = fieldsOf(flags, parsedSongs);
  if (Object.keys(fields).length === 0) throw new UsageError('sid edit needs at least one field to change, for example --author "Name"; see "sidwave sid edit --help"');
  const result = editSidHeader(bytes, fields, { strict: flags.switches.has("--strict"), maxBytes: maxBytesOf(flags) });

  const toStdout = outputFlag === "-";
  const stem = basename(file, extname(file));
  const outPath = toStdout ? undefined : inPlace ? input : resolve(io.cwd, outputFlag ?? `${stem}.edited.sid`);
  if (outPath !== undefined && !inPlace && !dryRun && result.changes.length > 0) {
    if (sameFile(outPath, input)) throw new UsageError("the output file is the input file; use --in-place to replace it, or choose another -o");
    if (existsSync(outPath) && !flags.switches.has("--force")) throw new UsageError(`${outPath} exists; use --force to overwrite it, or choose another -o`);
  }

  // Say whether the old key is listed in a database, when one is given.
  const hint: string[] = [];
  let listed: { path: string; format: string } | undefined;
  if (result.changes.length > 0 && result.md5.old !== result.md5.new && (flags.values.has("--songlengths") || flags.values.has("--hvsc") || process.env.HVSC_ROOT)) {
    const context = loadContext(io, flags, { wantSonglengths: true, wantStil: false, discover: false });
    if (context.songlengths !== undefined) {
      const oldKey = context.songlengths.format === "txt" ? result.legacyMd5.old : result.md5.old;
      const newKey = context.songlengths.format === "txt" ? result.legacyMd5.new : result.md5.new;
      if (oldKey !== newKey && context.songlengths.db.has(oldKey)) {
        listed = { path: context.songlengthsPath!, format: context.songlengths.format };
        hint.push(`songlengths: the old key is listed in ${context.songlengthsPath}; after the edit it no longer matches. To carry the times over:`,
          `  sidwave songlengths write ${context.songlengthsPath} ${outPath === undefined ? "<edited.sid>" : outPath} --from-md5 ${oldKey}`);
      } else if (oldKey === newKey) hint.push(`songlengths: the key of the ${context.songlengths.format === "txt" ? "old Songlengths.txt" : "Songlengths.md5"} format is unchanged, so the entry stays valid`);
    }
  }

  let written = false;
  if (!dryRun && result.changes.length > 0) {
    if (outPath === undefined) io.outBytes(result.bytes);
    else writeFileAtomic(outPath, result.bytes);
    written = true;
  }
  const record = {
    file, output: outPath === undefined ? null : outPath, dryRun, written, changes: result.changes, warnings: result.warnings, version: result.version,
    layoutChanged: result.layoutChanged, changedRanges: result.changedRanges ?? null, md5: result.md5, legacyMd5: result.legacyMd5,
    ...(listed === undefined ? {} : { songlengthsListed: listed }),
  };
  const text = result.changes.length === 0 && !dryRun
    ? `${file}: nothing to change; every given value is already in the file${result.warnings.length > 0 ? `\n${result.warnings.map((w) => `warning: ${w}`).join("\n")}` : ""}`
    : editText(file, written || dryRun ? (outPath === undefined ? "standard output" : relative(io.cwd, outPath) || outPath) : undefined, result, hint, dryRun);
  // With the file on standard output the report goes to standard error so the two never mix.
  if (toStdout && written) io.err(json ? `${JSON.stringify(envelope("sid edit", true, { result: record }), null, 2)}\n` : `${text}\n`);
  else emitResult(io, json, "sid edit", record, text);
  return EXIT_OK;
}

// ---- player -------------------------------------------------------------------------------------------------------

const PLAYER_SPEC: FlagSpec = { values: ["--sidid", "--sidid-info", "--max-bytes"], switches: ["--all", "--json"] };

function matchText(m: SidIdMatch): string {
  const info = m.info;
  const named = info?.name !== undefined ? ` (${info.name}${info.author ? `, ${info.author}` : ""})` : "";
  return `${m.player}${named}, confidence ${m.confidence}, ${m.fixedBytes} fixed bytes in ${m.fragments} fragment${m.fragments === 1 ? "" : "s"}${m.signaturesMatched > 1 ? `, ${m.signaturesMatched} signatures match` : ""}, at ${hex(m.address)} (data offset ${m.offset})`;
}

export function sidPlayerCommand(io: CliIo, args: string[]): number {
  const flags = parseFlags(args, PLAYER_SPEC);
  if (flags.help) { io.out(SID_PLAYER_HELP); return EXIT_OK; }
  const json = flags.switches.has("--json");
  const { target, isDirectory } = targetOf(io, flags, "player");
  const cfgText = one(flags, "--sidid") ?? process.env.SIDID_CFG ?? process.env.SIDIDCFG;
  if (cfgText === undefined || cfgText === "") {
    throw new UsageError("no SIDId signature file given. Pass --sidid <path to sidid.cfg> or set SIDID_CFG. sidwave does not contain a signature file; use the one that comes with SIDId (see doc/hvsc.md)");
  }
  const cfgPath = resolve(io.cwd, cfgText);
  const nfoText = one(flags, "--sidid-info");
  const nfoPath = nfoText !== undefined ? resolve(io.cwd, nfoText) : join(dirname(cfgPath), "sidid.nfo");
  const nfo = nfoText !== undefined || existsSync(nfoPath) ? readBounded(nfoPath, 4 * 1024 * 1024, nfoText ?? nfoPath) : undefined;
  const { db, info } = loadSidIdSignatures(readBounded(cfgPath, 4 * 1024 * 1024, cfgText), nfo);
  const all = flags.switches.has("--all");
  const identify = (bytes: Uint8Array): SidIdMatch[] => identifySidPlayer(bytes, db, { all, ...(info === undefined ? {} : { info }) });
  if (isDirectory) {
    return batch(io, flags, target, (path, bytes) => {
      const matches = identify(bytes);
      const first = matches[0];
      return {
        json: { identified: matches.length > 0, player: first?.player ?? null, confidence: first?.confidence ?? null, matches },
        text: `${relative(target, path)}: ${first === undefined ? "no player identified" : `${first.player} (${first.confidence})${all && matches.length > 1 ? `; also ${matches.slice(1).map((m) => m.player).join(", ")}` : ""}`}`,
      };
    }, "sid player");
  }
  const file = flags.positional[0]!;
  const bytes = readBounded(target, maxBytesOf(flags), file);
  let matches: SidIdMatch[];
  try { matches = identify(bytes); } catch (error) {
    if (error instanceof SidFileError) throw new SidwaveOperationError("input", `${file}: ${error.message}; is it a PSID or RSID file?`, { file, code: error.code });
    throw error;
  }
  const text = matches.length === 0 ? `${file}: no player identified (${db.players.length} players, ${db.signatures} signatures tried)`
    : `${file}: ${matches.map(matchText).join("\n  also ")}`;
  emitResult(io, json, "sid player", { file, identified: matches.length > 0, matches, signatureFile: cfgPath, players: db.players.length, signatures: db.signatures }, text);
  return EXIT_OK;
}

// ---- dispatch -----------------------------------------------------------------------------------------------------

/** `sidwave sid <info|edit|player>`; `args` are the arguments after "sid". */
export function runSidCli(args: string[], io: CliIo): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") { io.out(SID_HELP); return EXIT_OK; }
  if (sub === "info") return sidInfoCommand(io, rest);
  if (sub === "edit") return sidEditCommand(io, rest);
  if (sub === "player") return sidPlayerCommand(io, rest);
  throw new UsageError(`unknown sid command "${sub}"; use info, edit or player (sidwave sid --help)`);
}
