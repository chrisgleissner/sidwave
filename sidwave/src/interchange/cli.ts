// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Command line for the interchange formats: `sidwave export` and `sidwave import`. `sidwave render` is in renderCli.ts.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { UsageError, envelope, withFile, type CliIo } from "../cliCore.js";
import { parseSidwave } from "../sidwave.js";
import { confinedReadOptions } from "../sidwaveOps.js";
import { InterchangeUsageError } from "./errors.js";
import { exportEvents } from "./events.js";
import { exportGoatTracker } from "./goattrackerExport.js";
import { exportMidi } from "./midiExport.js";
import { exportFurnace } from "./furnaceExport.js";
import { importFurnace } from "./furnaceImport.js";
import { importGoatTracker } from "./goattrackerImport.js";
import { importMod } from "./modImport.js";
import { looksLikeMod } from "./mod.js";
import { looksLikeJch } from "./jch.js";
import { importJch } from "./jchImport.js";
import { importMidi } from "./midiImport.js";
import { exportMusicXml } from "./musicxmlExport.js";
import { importMusicXml } from "./musicxmlImport.js";
import { importSwi, importSwm } from "./swmImport.js";
import { exportSwi, exportSwm } from "./swmExport.js";

export { InterchangeUsageError };
/** Largest score or interchange file the command line reads. */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export interface InterchangeArgs {
  positional: string[];
  flags: Map<string, string | true>;
  allowDirs: string[];
}

/** Flags with a value, then flags without one. Unknown flags are usage errors. */
export function parseFlags(args: string[], valued: string[], bare: string[]): InterchangeArgs {
  const out: InterchangeArgs = { positional: [], flags: new Map(), allowDirs: [] };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) { inline = arg.slice(arg.indexOf("=") + 1); arg = arg.slice(0, arg.indexOf("=")); }
    if (arg === "--") { out.positional.push(...args.slice(i + 1)); break; }
    if (valued.includes(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--allow-dir") out.allowDirs.push(value); else out.flags.set(arg, value);
    } else if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    else if (bare.includes(arg)) out.flags.set(arg, true);
    else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

export function numberFlag(args: InterchangeArgs, flag: string): number | undefined {
  const value = args.flags.get(flag);
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new UsageError(`${flag} needs a number, not "${String(value)}"`);
  return n;
}

export function readBounded(io: CliIo, file: string): { bytes: Buffer; path: string } {
  const path = resolve(io.cwd, file);
  try {
    const size = statSync(path).size;
    if (size > MAX_INPUT_BYTES) throw new InterchangeUsageError(`${file} has ${size} bytes; the limit is ${MAX_INPUT_BYTES}`);
    return { bytes: readFileSync(path), path };
  } catch (error) {
    if (error instanceof InterchangeUsageError) throw error;
    throw new InterchangeUsageError(fileProblem("read", file, error));
  }
}

/** A plain sentence for a failed file operation, with the path. */
export function fileProblem(action: "read" | "write", file: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = {
    ENOENT: action === "read" ? "the file does not exist" : "a directory of the path does not exist", EISDIR: "it is a directory, not a file", ENOTDIR: "a part of the path is a file, not a directory",
    EACCES: "permission denied", EPERM: "operation not permitted", ENOSPC: "no space left on the device", EROFS: "the file system is read only",
  };
  return `cannot ${action} ${file}: ${(code && reasons[code]) ?? code ?? (error as Error).message}`;
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

export function writeOutput(io: CliIo, input: string, target: string, bytes: Uint8Array | string): string {
  const path = resolve(io.cwd, target);
  if (sameFile(path, input)) throw new UsageError("the output file is the input file; refusing to overwrite it");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch (error) {
    throw new InterchangeUsageError(fileProblem("write", path, error));
  }
  return path;
}

const stem = (file: string): string => basename(file, extname(file)).replace(/\.sidwave$/i, "");

function swmExportCommand(format: "swm" | "swi", file: string, a: InterchangeArgs, io: CliIo): number {
  const { bytes, path } = readBounded(io, file);
  const song = numberFlag(a, "--song");
  const json = a.flags.has("--json");
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined ?? `${stem(file)}.${format}`;
  try {
    const doc = withFile(file, () => parseSidwave(bytes.toString("utf8"), confinedReadOptions(io.cwd, a.allowDirs)));
    const common = song === undefined ? {} : { song };
    let out: Uint8Array;
    let result: Record<string, unknown>;
    if (format === "swi") {
      const which = a.flags.get("--instrument");
      if (typeof which !== "string") throw new UsageError("--format swi needs --instrument <name or index>");
      const r = exportSwi(doc, /^\d+$/.test(which) ? Number(which) : which, common);
      out = r.bytes; result = { losses: r.losses };
    } else {
      const patternRows = numberFlag(a, "--pattern-rows");
      const r = exportSwm(doc, { ...common, ...(patternRows === undefined ? {} : { patternRows }) });
      for (const loss of r.report.losses) io.err(`note: ${loss}\n`);
      out = r.bytes; result = { ...r.report };
    }
    if (output === "-") { io.outBytes(out); return 0; }
    const written = writeOutput(io, path, output, out);
    const full = { file, format, output: written, bytes: out.length, ...result };
    io.out(json ? `${JSON.stringify(envelope("export", true, { result: full }), null, 2)}\n` : `${written}: SID-Wizard ${format === "swi" ? "instrument" : "module"}, ${out.length} bytes\n`);
    return 0;
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
}

/** Exporters that need the engine and are therefore asynchronous (see traceCli.ts). */
export type AsyncExporter = (file: string, args: InterchangeArgs, io: CliIo, json: boolean) => Promise<number>;
const asyncExporters = new Map<string, AsyncExporter>();
export function registerAsyncExporter(format: string, handler: AsyncExporter): void { asyncExporters.set(format, handler); }

function exportCommand(args: string[], io: CliIo): number | Promise<number> {
  const a = parseFlags(args, ["-o", "--output", "--format", "--song", "--ppq", "--seconds", "--instrument", "--pattern-rows", "--allow-dir"], ["--bend", "--json"]);
  if (a.positional.length !== 1) throw new UsageError("export needs exactly one score file");
  const file = a.positional[0]!;
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
  const ext = output === undefined ? "" : extname(output).toLowerCase();
  const format = (a.flags.get("--format") as string | undefined) ?? (ext === ".dump" ? "vice-dump" : ext === ".swm" ? "swm" : ext === ".swi" ? "swi" : ext === ".mid" || ext === ".midi" ? "midi" : ext === ".musicxml" || ext === ".xml" ? "musicxml" : ext === ".sng" ? "goattracker" : ext === ".fur" ? "furnace" : "events");
  if (format === "swm" || format === "swi") return swmExportCommand(format, file, a, io);
  const asyncExporter = asyncExporters.get(format);
  if (asyncExporter) return asyncExporter(file, a, io, a.flags.has("--json"));
  if (!["events", "midi", "musicxml", "goattracker", "furnace"].includes(format)) throw new UsageError(`--format must be events, midi, musicxml, goattracker, furnace${[...asyncExporters.keys()].map((k) => `, ${k}`).join("")}, not ${format}`);
  if (a.flags.has("--seconds")) throw new UsageError("--seconds applies to --format vice-dump only");
  if (a.flags.has("--instrument") || a.flags.has("--pattern-rows")) throw new UsageError("--instrument and --pattern-rows apply to --format swi and swm only");
  if (format !== "midi" && a.flags.has("--bend")) throw new UsageError("--bend applies to --format midi only");
  const { bytes, path } = readBounded(io, file);
  const song = numberFlag(a, "--song");
  const ppq = numberFlag(a, "--ppq");
  const json = a.flags.has("--json");
  const done = (result: unknown, text: string): number => { io.out(json ? `${JSON.stringify(envelope("export", true, { result }), null, 2)}\n` : `${text}\n`); return 0; };
  try {
    const doc = withFile(file, () => parseSidwave(bytes.toString("utf8"), confinedReadOptions(io.cwd, a.allowDirs)));
    const common = { ...(song === undefined ? {} : { song }), ...(ppq === undefined ? {} : { ppq }) };
    if (format === "events") {
      const events = exportEvents(doc, common);
      if (output === undefined || output === "-") {
        io.out(json ? `${JSON.stringify(envelope("export", true, { result: events }), null, 2)}\n` : `${JSON.stringify(events, null, 2)}\n`);
        return 0;
      }
      const text = `${JSON.stringify(events, null, 2)}\n`;
      const written = writeOutput(io, path, output, text);
      return done({ file, format, output: written, bytes: text.length }, `${written}: ${text.length} bytes of events`);
    }
    if (format === "midi") {
      const result = exportMidi(doc, { ...common, bend: a.flags.has("--bend") });
      const target = output ?? `${stem(file)}.mid`;
      for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
      if (target === "-") { io.outBytes(result.bytes); return 0; }
      const written = writeOutput(io, path, target, result.bytes);
      return done({ file, format, output: written, bytes: result.bytes.length, ppq: result.ppq, tracks: result.tracks, losses: result.losses, warnings: result.warnings },
        `${written}: MIDI, ${result.tracks.length} voice tracks, ${result.bytes.length} bytes`);
    }
    if (format === "goattracker") {
      const result = exportGoatTracker(doc, common);
      const target = output ?? `${stem(file)}.sng`;
      for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
      if (target === "-") { io.outBytes(result.bytes); return 0; }
      const written = writeOutput(io, path, target, result.bytes);
      const { bytes: _bytes, ...info } = result;
      return done({ file, format, output: written, bytes: result.bytes.length, ...info }, `${written}: GoatTracker GTS5, ${result.voices} channels, ${result.rows} rows, ${result.ticksPerRow} calls per row`);
    }
    if (format === "furnace") {
      const result = exportFurnace(doc, common);
      const target = output ?? `${stem(file)}.fur`;
      for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
      if (target === "-") { io.outBytes(result.bytes); return 0; }
      const written = writeOutput(io, path, target, result.bytes);
      const { bytes: _bytes, ...info } = result;
      return done({ file, format, output: written, bytes: result.bytes.length, ...info }, `${written}: Furnace module, ${result.voices} channels, ${result.rows} rows, ${result.ticksPerRow} ticks per row`);
    }
    return musicXmlExport(doc, common, output, path, io, json);
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
}

function musicXmlExport(doc: ReturnType<typeof parseSidwave>, common: { song?: number; ppq?: number }, output: string | undefined, input: string, io: CliIo, json: boolean): number {
  const result = exportMusicXml(doc, common);
  const target = output ?? `${stem(input)}.musicxml`;
  for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
  if (target === "-") { io.out(result.xml); return 0; }
  const written = writeOutput(io, input, target, result.xml);
  const summary = { file: input, format: "musicxml", output: written, bytes: Buffer.byteLength(result.xml), divisions: result.divisions, bars: result.bars, parts: result.parts, losses: result.losses, warnings: result.warnings };
  io.out(json ? `${JSON.stringify(envelope("export", true, { result: summary }), null, 2)}\n` : `${written}: MusicXML, ${result.parts.length} parts, ${result.bars} bars\n`);
  return 0;
}

export interface ImportResultLike { yaml: string; report: unknown }
export type ImportHandler = (bytes: Buffer, args: InterchangeArgs) => ImportResultLike;
const importers = new Map<string, ImportHandler>();
export function registerImporter(format: string, handler: ImportHandler): void { importers.set(format, handler); }
/** Importer flags registered by other modules (valued, bare). */
export const IMPORT_VALUED = ["-o", "--output", "--format", "--grid", "--voices", "--title", "--mode", "--song", "--subtune", "--allow-dir", "--sids", "--transpose"];
export const IMPORT_BARE = ["--no-drums", "--no-bend", "--no-validate", "--json", "--force", "--quality"];

importers.set("musicxml", (bytes, a) => {
  const grid = numberFlag(a, "--grid");
  const voices = numberFlag(a, "--voices");
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  try {
    return importMusicXml(bytes, {
      ...(grid === undefined ? {} : { grid }), ...(voices === undefined ? {} : { voices }),
      ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}),
      ...(mode ? { mode } : {}), drums: !a.flags.has("--no-drums"), validate: !a.flags.has("--no-validate"),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
});

importers.set("goattracker", (bytes, a) => {
  const song = numberFlag(a, "--song");
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  try {
    return importGoatTracker(bytes, {
      ...(song === undefined ? {} : { song }), ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}),
      ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate"),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
});

importers.set("mod", (bytes, a) => {
  const sids = numberFlag(a, "--sids");
  const transpose = numberFlag(a, "--transpose");
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  try {
    const result = importMod(bytes, {
      ...(sids === undefined ? {} : { sids }), ...(transpose === undefined ? {} : { transpose }),
      ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}), ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate"), quality: a.flags.has("--quality"),
    });
    return { yaml: result.yaml, report: result.report };
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
});

importers.set("jch", (bytes, a) => {
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  return importJch(bytes, { ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}), ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate") });
});

importers.set("furnace", (bytes, a) => {
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  return importFurnace(bytes, { ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}), ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate") });
});

const detect = (file: string, bytes: Buffer): string | undefined => {
  if (bytes.subarray(0, 4).toString("latin1") === "MThd") return "midi";
  const ext = extname(file).toLowerCase();
  const id = bytes.subarray(2, 6).toString("latin1");
  if (ext === ".swi") return "swi";
  if (id === "SWM1" || id === "SWMS" || ext === ".swm" || ext === ".sws") return "swm";
  if (ext === ".musicxml" || ext === ".xml") return "musicxml";
  if (ext === ".mxl") return "musicxml";
  if (bytes.subarray(0, 4).toString("latin1") === "GTS5" || bytes.subarray(0, 4).toString("latin1") === "GTS4" || bytes.subarray(0, 4).toString("latin1") === "GTS3" || bytes.subarray(0, 4).toString("latin1") === "GTS2" || ext === ".sng") return "goattracker";
  if (ext === ".mod" || looksLikeMod(bytes)) return "mod";
  if (looksLikeJch(bytes)) return "jch";
  if (ext === ".fur" || bytes[0] === 0x78 || bytes.subarray(0, 16).toString("latin1").startsWith("-Furnace module-")) return "furnace";
  return undefined;
};

importers.set("midi", (bytes, a) => {
  const grid = numberFlag(a, "--grid");
  const voices = numberFlag(a, "--voices");
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  try {
    return importMidi(bytes, {
      ...(grid === undefined ? {} : { grid }), ...(voices === undefined ? {} : { voices }),
      ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}),
      ...(mode ? { mode } : {}), drums: !a.flags.has("--no-drums"), bend: !a.flags.has("--no-bend"), validate: !a.flags.has("--no-validate"),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
});

for (const format of ["swm", "swi"]) {
  importers.set(format, (bytes, a) => {
    const subtune = numberFlag(a, "--subtune");
    const mode = a.flags.get("--mode") as string | undefined;
    if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
    try {
      return (format === "swi" ? importSwi : importSwm)(bytes, {
        ...(subtune === undefined ? {} : { subtune }), ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}),
        ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate"),
      });
    } catch (error) {
      if (error instanceof RangeError) throw new UsageError(error.message);
      throw error;
    }
  });
}

function importCommand(args: string[], io: CliIo): number {
  const a = parseFlags(args, IMPORT_VALUED, IMPORT_BARE);
  if (a.positional.length !== 1) throw new UsageError("import needs exactly one input file");
  const file = a.positional[0]!;
  const { bytes, path } = readBounded(io, file);
  const format = (a.flags.get("--format") as string | undefined) ?? detect(file, bytes);
  if (format === undefined) throw new UsageError(`cannot tell the format of ${file}; pass --format midi, musicxml, goattracker, furnace, mod, jch, swm or swi`);
  if (a.flags.get("-o") === "-" || a.flags.get("--output") === "-") {
    if (a.flags.has("--json")) throw new UsageError("import -o - writes the YAML to stdout; --json cannot be combined with it");
  }
  const handler = importers.get(format);
  if (!handler) throw new UsageError(`unknown or unavailable import format "${format}"`);
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined ?? `${stem(file)}.yaml`;
  const result = withFile(file, () => handler(bytes, a));
  const json = a.flags.has("--json");
  if (output === "-") {
    io.out(result.yaml);
    io.err(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  }
  const target = resolve(io.cwd, output);
  if (existsSync(target) && !a.flags.has("--force")) throw new UsageError(`${target} exists; use --force to overwrite it`);
  const written = writeOutput(io, path, output, result.yaml);
  io.out(json ? `${JSON.stringify(envelope("import", true, { result: { file, format, output: written, report: result.report } }), null, 2)}\n`
    : `${written}: imported ${format}; report follows\n${JSON.stringify(result.report, null, 2)}\n`);
  return 0;
}

export const INTERCHANGE_HELP = `  Examples (the format is detected from the file; --format / --from override):
    sidwave import tune.swm -o tune.yaml           SID-Wizard module (.swm .sws; --subtune n) or instrument (.swi)
    sidwave export score.yaml -o score.swm         SID-Wizard module for the expressible subset (losses are printed)
    sidwave export score.yaml -o run.dump          VICE -sounddev dump text of the compiled score
    sidwave reconstruct run.dump                   score from a VICE dump or a siddump table (SID files work as before)
  sidwave export <file> [--format events|midi|musicxml|goattracker|furnace|vice-dump|swm|swi] [--instrument <name|n>] [--pattern-rows 16|32|64] [-o <out>] [--song <n>] [--ppq <n>] [--bend] [--seconds <s>] [--json]
  sidwave reconstruct <trace> [--from vice-dump|siddump] [--clock PAL|NTSC] [--seconds <s>] [--title <text>] [-o <score.yaml>] [--json]
  sidwave import <file> [--format midi|musicxml|goattracker|furnace|mod|jch|swm|swi] [-o <out.yaml>] [--grid <beats>] [--voices 1-3] [--song <n>] [--subtune <n>] [--sids 1-10] [--transpose <n>] [--quality]
                        [--no-drums] [--no-bend] [--title <text>] [--mode PAL|NTSC] [--no-validate] [--force] [--json]
`;

/** Commands handled here; `cli.ts` hands the arguments after the command name to the matching function. */
export const INTERCHANGE_COMMANDS: Record<string, (args: string[], io: CliIo) => number | Promise<number>> = {
  export: exportCommand,
  import: importCommand,
};
