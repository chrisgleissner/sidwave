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
import { importMidi } from "./midiImport.js";
import { exportMusicXml } from "./musicxmlExport.js";
import { importMusicXml } from "./musicxmlImport.js";

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
    throw new InterchangeUsageError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
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
    throw new InterchangeUsageError(`cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return path;
}

const stem = (file: string): string => basename(file, extname(file)).replace(/\.sidwave$/i, "");

function exportCommand(args: string[], io: CliIo): number {
  const a = parseFlags(args, ["-o", "--output", "--format", "--song", "--ppq", "--allow-dir"], ["--bend", "--json"]);
  if (a.positional.length !== 1) throw new UsageError("export needs exactly one score file");
  const file = a.positional[0]!;
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
  const ext = output === undefined ? "" : extname(output).toLowerCase();
  const format = (a.flags.get("--format") as string | undefined) ?? (ext === ".mid" || ext === ".midi" ? "midi" : ext === ".musicxml" || ext === ".xml" ? "musicxml" : ext === ".sng" ? "goattracker" : ext === ".fur" ? "furnace" : "events");
  if (!["events", "midi", "musicxml", "goattracker", "furnace"].includes(format)) throw new UsageError(`--format must be events, midi, musicxml, goattracker or furnace, not ${format}`);
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
export const IMPORT_VALUED = ["-o", "--output", "--format", "--grid", "--voices", "--title", "--mode", "--song", "--allow-dir"];
export const IMPORT_BARE = ["--no-drums", "--no-bend", "--no-validate", "--json", "--force"];

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

importers.set("furnace", (bytes, a) => {
  const mode = a.flags.get("--mode") as string | undefined;
  if (mode !== undefined && mode !== "PAL" && mode !== "NTSC") throw new UsageError("--mode must be PAL or NTSC");
  return importFurnace(bytes, { ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}), ...(mode ? { mode } : {}), validate: !a.flags.has("--no-validate") });
});

const detect = (file: string, bytes: Buffer): string | undefined => {
  if (bytes.subarray(0, 4).toString("latin1") === "MThd") return "midi";
  const ext = extname(file).toLowerCase();
  if (ext === ".musicxml" || ext === ".xml") return "musicxml";
  if (ext === ".mxl") return "musicxml";
  if (bytes.subarray(0, 4).toString("latin1") === "GTS5" || bytes.subarray(0, 4).toString("latin1") === "GTS4" || bytes.subarray(0, 4).toString("latin1") === "GTS3" || bytes.subarray(0, 4).toString("latin1") === "GTS2" || ext === ".sng") return "goattracker";
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

function importCommand(args: string[], io: CliIo): number {
  const a = parseFlags(args, IMPORT_VALUED, IMPORT_BARE);
  if (a.positional.length !== 1) throw new UsageError("import needs exactly one input file");
  const file = a.positional[0]!;
  const { bytes, path } = readBounded(io, file);
  const format = (a.flags.get("--format") as string | undefined) ?? detect(file, bytes);
  if (format === undefined) throw new UsageError(`cannot tell the format of ${file}; pass --format midi, musicxml, goattracker or furnace`);
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

export const INTERCHANGE_HELP = `  sidwave export <file> [--format events|midi|musicxml] [-o <out>] [--song <n>] [--ppq <n>] [--bend] [--json]
  sidwave import <file> [--format midi|musicxml|goattracker|furnace] [-o <out.yaml>] [--grid <beats>] [--voices 1-3]
                        [--no-drums] [--no-bend] [--title <text>] [--mode PAL|NTSC] [--no-validate] [--force] [--json]
`;

/** Commands handled here; `cli.ts` hands the arguments after the command name to the matching function. */
export const INTERCHANGE_COMMANDS: Record<string, (args: string[], io: CliIo) => number> = {
  export: exportCommand,
  import: importCommand,
};
