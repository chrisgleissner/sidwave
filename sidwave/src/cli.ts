// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseSidwave } from "./sidwave.js";
import { bundleCommand, lockCommand } from "./cliAssets.js";
import { runRetarget } from "./retargetCli.js";
import { SIDWAVE_SYMBOL_FORMATS, compileSidwave, sidwaveGamePsid, type SidwaveSymbolFormat } from "./sidwaveGame.js";
import { SIDWAVE_ASSEMBLERS, renderSidwaveGameInclude, sidwaveRelocationTable, type SidwaveAssembler, type SidwaveRelocationTable } from "./sidwaveGameDeveloper.js";
import {
  classifyError, envelope, EXIT_CODES, EXIT_FAILED, EXIT_OK, EXIT_USAGE, SidwaveOperationError, UsageError, withFile,
  type CliIo,
} from "./cliCore.js";
import { ANALYZE_COMMANDS, ANALYZE_HELP, ANALYZE_USAGE, takeAnalyzeFlag, type AnalyzeFlags } from "./cliAnalyze.js";
import { RECONSTRUCT_COMMAND_HELP, RECONSTRUCT_USAGE, reconstructCommand } from "./cliReconstruct.js";
import { INTERCHANGE_COMMANDS as BASE_INTERCHANGE_COMMANDS, INTERCHANGE_HELP } from "./interchange/cli.js";
import { CONVERT_HELP, HUB_COMMANDS } from "./interchange/convertCli.js";

const INTERCHANGE_COMMANDS = { ...BASE_INTERCHANGE_COMMANDS, ...HUB_COMMANDS };
import { runCompleteCli } from "./cliComplete.js";
import { runSidCli, sidInfoCommand } from "./cliSid.js";
import { runSonglengthsCli } from "./cliSonglengths.js";
import { runStilCli } from "./cliStil.js";
import { isTraceInput, reconstructFromTraceCommand } from "./interchange/traceCli.js";
import { AUTHORING_COMMANDS, AUTHORING_USAGE } from "./cliAuthoringCommands.js";
import { unknownCommandMessage } from "./cliAuthoring.js";
import { PLAY_USAGE, runPlayCli, runWatchCli } from "./cliPlay.js";
import { RUN_COMMANDS, RUN_HELP, flagName, takeRunFlag, type RunFlags } from "./cliVerify.js";
import {
  compileSidwaveBytes, confinedReadOptions, describeSidwave, isExampleName, lintSidwave, listSidwaveExamples,
  readExampleScore, type SidwaveOutputFormat,
} from "./sidwaveOps.js";

export * from "./cliCore.js";

export const HELP = `sidwave: compile SIDWave scores to C64 programs and SID files

Usage:
  sidwave validate <file> [--json] [--allow-dir <dir>]
  sidwave compile  <file> [-o <out>] [--format prg|sid] [--loop|--no-loop] [--song <n>] [--json] [--allow-dir <dir>]
  sidwave compile  <file> --target game --origin <addr> [--data-origin <addr>] [--zp <addr>] [--symbols <list>]
                          [--symbols-all] [--no-measure] [--max-cycles <n>] [--reloc] [--format bin|sid|asm]
                          [--asm 64tass|acme|kickass|ca65] [-o <out>] [--loop|--no-loop] [--json]
  sidwave lint     <file> [--loop|--no-loop] [--strict] [--json] [--allow-dir <dir>]
  sidwave lock     <score> [-o <out>] [--json] [--allow-dir <dir>]
  sidwave bundle   <score> -o <dir> [--force] [--json] [--allow-dir <dir>]
  sidwave examples [<name>] [-o <dir>] [--force] [--json]
  sidwave retarget <file> [--clock pal|ntsc] [--model 6581|8580] [--sids <n>] [--budget-cycles <n>] [--budget-bytes <n>]
                          [--allow-changes] [-o <out>] [--force] [--json]   (see "sidwave retarget --help")
  sidwave complete <score> --op continue|harmonise|accompany|fill-section [options]   (see "sidwave complete --help")
  sidwave sid info|edit|player <file.sid|dir> [options]   (SID headers, HVSC tools; see "sidwave sid --help"; "sid-info" is the old name of "sid info")
  sidwave songlengths lookup|verify|write ...             (see "sidwave songlengths --help")
  sidwave stil parse|query ...                            (see "sidwave stil --help")
${AUTHORING_USAGE}${INTERCHANGE_HELP}${CONVERT_HELP}${RUN_HELP.usage}${PLAY_USAGE}${RECONSTRUCT_USAGE}${ANALYZE_USAGE}  sidwave --help | --version

Commands:
  validate   Parse a score. Exit 0 when it is valid, 3 with the path of the first error otherwise.
  compile    Write a PRG (default) or PSID file. The output defaults to the input name with .prg or .sid in the
             current directory; "-o -" writes the bytes to standard output. With --format omitted, a -o name
             ending in .sid selects PSID. --json prints the format, sizes, addresses, SID count and duration.
  compile --target game
             Build the player for use inside a game or demo: assembled at --origin with no BASIC stub, IRQ or
             KERNAL use. Writes <out>.bin (player and data, or the player alone with --data-origin) and
             <out>.data.bin, plus one symbol file per --symbols format (64tass, acme, kickass, ca65, vice, json) next to it:
             <out>.64tass, .acme, .kickass, .ca65, .vice, .symbols.json. Addresses are 0x1000, $1000 or decimal. --zp moves
             the zero page pointers (default $FB). The build runs the score on the bundled emulator to measure the
             cycles per play call; --no-measure skips that. --format sid writes a PSID instead. --json prints the
             register contract, the cycles and the exported labels.
             --format asm writes one assembler include instead of the binaries: <out>.inc (or the -o name ending in
             .inc, .asm, .a or .s) with a header describing the call API, the symbols and the bytes at their
             addresses, in the syntax of --asm (64tass by default, acme, kickass or ca65). --max-cycles <n> writes
             nothing and exits 5 when the worst measured play call (with --no-measure the upper bound) takes more
             than n cycles. --reloc also writes <out>.reloc.json, the byte offsets that change when the build moves
             by whole pages (not with --format sid).
  lint       Print the lint findings. Exit 0 unless the score is invalid; with --strict, exit 1 when there is a
             finding that is not an informational note.
  lock       SIDWave 1.4 libraries: write the sha256 of each library the score imports into its imports (in place
             unless -o names another file; "-o -" prints the score). The version range of each import is checked.
  bundle     Write the score and every library it depends on into the directory -o (libs/ plus bundle.json with
             hashes, licences and provenance), with the import paths rewritten to relative ones. The bundle compiles
             offline to the same bytes. Without --force the directory must be empty. "file:" samples are copied to
             samples/ (read relative to the current directory); compile the bundle from inside its directory.
  examples   Without a name, list the bundled example scores. With a name, print the score, or write
             <name>.yaml into the directory given by -o (it is not overwritten without --force).
${RUN_HELP.commands}${RECONSTRUCT_COMMAND_HELP}${ANALYZE_HELP}
Options:
  --allow-dir <dir>   Allow "file:" sample sources below <dir>, and library files of "imports" (the library search
                      path). Without it samples must lie below the current
                      directory. May be repeated. The sidwave command never uses the network.
  --song <n>          Score with songs (SIDWave 1.4): the song the PRG plays and the PSID starts with, 0-based (default 0).
  --symbols-all       With --target game: also export every internal label as sidwave_int_<label>.
  --json              Machine-readable output on standard output.
${RUN_HELP.options}  -h, --help          Show this text.
  -V, --version       Show the package version.

Exit codes: 0 success; 1 failed verdict (verify below the requested level, lint --strict findings); 2 usage;
3 input or validation error; 4 engine unavailable; 5 limit exceeded or aborted; 70 internal error.
With --json every command prints { "ok", "command", "result" } or { "ok": false, "command", "error": { "category",
"message", "details" } } on standard output. Error categories: usage, input, validation, engine_unavailable,
limit_exceeded, aborted, internal.
`;

interface Options {
  positional: string[];
  output?: string;
  format?: string;
  loop?: boolean;
  json: boolean;
  strict: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
  allowDirs: string[];
  target?: string;
  origin?: number;
  dataOrigin?: number;
  /** `compile --song n`: the song the PRG plays and the PSID starts with (0-based). */
  song?: number;
  zeroPage?: number;
  symbols: string[];
  symbolsAll: boolean;
  noMeasure: boolean;
  asm?: string;
  reloc: boolean;
  maxCycles?: number;
  /** Flags of verify, render, trace and sid-info. */
  run: RunFlags;
  /** Flags of analyze, compare, isolate, preserve and extract-instruments. */
  analyze: AnalyzeFlags;
}

const VALUE_FLAGS = new Set(["-o", "--output", "--format", "--allow-dir", "--target", "--origin", "--data-origin", "--zp", "--symbols", "--song", "--asm", "--max-cycles"]);

/** Options that only apply to `compile --target game`. */
const GAME_FLAGS: Array<[keyof Options, string]> = [
  ["target", "--target"], ["origin", "--origin"], ["dataOrigin", "--data-origin"], ["zeroPage", "--zp"],
  ["symbols", "--symbols"], ["symbolsAll", "--symbols-all"], ["noMeasure", "--no-measure"], ["asm", "--asm"], ["reloc", "--reloc"], ["maxCycles", "--max-cycles"],
];

function parseAddress(flag: string, text: string): number {
  const match = /^(?:0x([0-9a-f]+)|\$([0-9a-f]+)|([0-9]+))$/i.exec(text.trim());
  if (!match) throw new UsageError(`${flag} needs an address such as 0x1000, $1000 or 4096, not "${text}"`);
  const value = match[3] !== undefined ? Number.parseInt(match[3], 10) : Number.parseInt((match[1] ?? match[2])!, 16);
  if (value > 0xffff) throw new UsageError(`${flag} ${text} is outside $0000-$FFFF`);
  return value;
}

function parseArgs(args: string[], command: string): Options {
  const options: Options = { positional: [], json: false, strict: false, force: false, help: false, version: false, allowDirs: [], symbols: [], symbolsAll: false, noMeasure: false, reloc: false, run: {}, analyze: {} };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (arg === "--") { options.positional.push(...args.slice(i + 1)); break; }
    if (takeAnalyzeFlag(command, options.analyze, arg, inline, () => args[++i])) continue;
    if (!(command === "compile" && arg === "--song") && takeRunFlag(options.run, arg, inline, () => args[++i])) continue;
    if (VALUE_FLAGS.has(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--format") options.format = value;
      else if (arg === "--allow-dir") options.allowDirs.push(value);
      else if (arg === "--target") options.target = value;
      else if (arg === "--origin") options.origin = parseAddress(arg, value);
      else if (arg === "--data-origin") options.dataOrigin = parseAddress(arg, value);
      else if (arg === "--zp") options.zeroPage = parseAddress(arg, value);
      else if (arg === "--song") {
        if (!/^\d+$/.test(value.trim())) throw new UsageError(`--song needs a song index such as 0 or 2, not "${value}"`);
        options.song = Number(value);
      }
      else if (arg === "--asm") options.asm = value;
      else if (arg === "--max-cycles") { if (!/^\d+$/.test(value)) throw new UsageError("--max-cycles needs a nonnegative integer"); options.maxCycles = Number(value); }
      else if (arg === "--symbols") options.symbols.push(...value.split(",").map((name) => name.trim()).filter(Boolean));
      else options.output = value;
    } else if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--no-loop") options.loop = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--symbols-all") options.symbolsAll = true;
    else if (arg === "--no-measure") options.noMeasure = true;
    else if (arg === "--reloc") options.reloc = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-V" || arg === "--version") options.version = true;
    else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

function pickFile(options: Options, command: string): string {
  if (options.positional.length !== 1) throw new UsageError(`${command} needs exactly one score file`);
  return options.positional[0]!;
}

function rejectOptions(options: Options, command: string, unsupported: Array<[keyof Options, string]>): void {
  for (const [key, flag] of unsupported) {
    const value = options[key];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) {
      throw new UsageError(`${flag} does not apply to ${command}`);
    }
  }
}

function rejectRunFlags(options: Options, command: string): void {
  const used = Object.keys(options.run);
  if (used.length > 0) throw new UsageError(`${flagName(used[0]!)} does not apply to ${command}`);
}

function readScore(io: CliIo, file: string): { text: string; path: string } {
  const path = resolve(io.cwd, file);
  try {
    return { text: readFileSync(path, "utf8"), path };
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file });
  }
}

/** Prints a result: the JSON envelope with --json, else the text line. */
function emit(io: CliIo, options: Options, command: string, result: unknown, text: string, ok = true): void {
  io.out(options.json ? `${JSON.stringify(envelope(command, ok, { result }), null, 2)}\n` : `${text}\n`);
}

function validate(io: CliIo, options: Options): number {
  rejectOptions(options, "validate", [["output", "-o"], ["format", "--format"], ["loop", "--loop/--no-loop"], ["strict", "--strict"], ["force", "--force"], ...GAME_FLAGS]);
  const file = pickFile(options, "validate");
  const { text, path } = readScore(io, file);
  const description = withFile(file, () => describeSidwave(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs, path))));
  emit(io, options, "validate", { file, ...description }, `${file}: valid SIDWAVE ${description.version}, ${description.voices} voices, ${description.sids} SID${description.sids === 1 ? "" : "s"}`);
  return EXIT_OK;
}

function pickFormat(options: Options): SidwaveOutputFormat {
  if (options.format !== undefined) {
    if (options.format !== "prg" && options.format !== "sid") throw new UsageError(`--format must be prg or sid, not ${options.format}`);
    return options.format;
  }
  return options.output !== undefined && extname(options.output).toLowerCase() === ".sid" ? "sid" : "prg";
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

function compile(io: CliIo, options: Options): number {
  rejectOptions(options, "compile", [["strict", "--strict"], ["force", "--force"]]);
  const file = pickFile(options, "compile");
  if (options.target !== undefined && options.target !== "prg" && options.target !== "game") {
    throw new UsageError(`--target must be prg or game, not ${options.target}`);
  }
  if (options.target === "game") {
    if (options.song !== undefined) throw new UsageError("--song is not available with --target game; the game passes the song to init in A");
    return compileGame(io, options, file);
  }
  rejectOptions(options, "compile without --target game", GAME_FLAGS.filter(([key]) => key !== "target"));
  const format = pickFormat(options);
  const { text, path } = readScore(io, file);
  const toStdout = options.output === "-";
  const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
  const outPath = toStdout ? undefined : resolve(io.cwd, options.output ?? `${stem}.${format}`);
  if (outPath !== undefined && sameFile(outPath, path)) throw new UsageError("the output file is the input file; refusing to overwrite it");
  const compiled = withFile(file, () => compileSidwaveBytes(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs, path)), { format, ...(options.loop === undefined ? {} : { loop: options.loop }), ...(options.song === undefined ? {} : { song: options.song }) }));
  const { summary, bytes } = compiled;
  if (outPath === undefined) io.outBytes(bytes);
  else {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${outPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: outPath });
    }
  }
  const where = outPath ?? "standard output";
  const line = `${where}: ${summary.format.toUpperCase()} ${summary.outputBytes} bytes, ${summary.durationSeconds.toFixed(1)} s, ${summary.sidCount} SID${summary.sidCount === 1 ? "" : "s"}`;
  const report = options.json ? `${JSON.stringify(envelope("compile", true, { result: { file, output: outPath ?? null, ...summary } }), null, 2)}\n` : `${line}\n`;
  // With bytes on standard output the summary goes to standard error so the two never mix.
  if (toStdout) io.err(report); else io.out(report);
  for (const warning of summary.warnings) io.err(`warning: ${warning}\n`);
  for (const lib of summary.libraries ?? []) io.err(`library ${lib.namespace}: ${lib.name} ${lib.version}, ${lib.licence}, sha256 ${lib.sha256}\n`);
  return EXIT_OK;
}

const SYMBOL_EXTENSIONS: Record<SidwaveSymbolFormat, string> = {
  "64tass": ".64tass", acme: ".acme", kickass: ".kickass", ca65: ".ca65", vice: ".vice", json: ".symbols.json",
};

/** `compile --target game`: raw binaries at the origin, symbol files and the contract. */
function compileGame(io: CliIo, options: Options, file: string): number {
  if (options.origin === undefined) throw new UsageError("--target game needs --origin");
  const format = options.format ?? (options.output !== undefined && extname(options.output).toLowerCase() === ".sid" ? "sid" : "bin");
  if (format !== "bin" && format !== "sid" && format !== "asm") throw new UsageError(`--format for --target game must be bin, sid or asm, not ${format}`);
  const asm = (options.asm ?? "64tass") as SidwaveAssembler;
  if (!SIDWAVE_ASSEMBLERS.includes(asm)) throw new UsageError(`--asm must be ${SIDWAVE_ASSEMBLERS.join(", ")}, not ${asm}`);
  if (options.asm !== undefined && format !== "asm") throw new UsageError("--asm needs --format asm");
  if (options.reloc && format === "sid") throw new UsageError("--reloc describes the player and data bytes; use --format bin or asm");
  if (options.output === "-") throw new UsageError("-o - is not available with --target game (the build has several files)");
  const symbols = options.symbols.map((name) => {
    if (!SIDWAVE_SYMBOL_FORMATS.includes(name as SidwaveSymbolFormat)) {
      throw new UsageError(`--symbols takes ${SIDWAVE_SYMBOL_FORMATS.join(", ")}, not ${name}`);
    }
    return name as SidwaveSymbolFormat;
  });
  const { text, path } = readScore(io, file);
  const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
  const base = options.output === undefined ? resolve(io.cwd, stem)
    : resolve(io.cwd, options.output).replace(format === "asm" ? /\.(inc|asm|a|s)$/i : /\.(bin|sid)$/i, "");
  // An include keeps the name given with -o when it has a source extension.
  const includePath = options.output !== undefined && /\.(inc|asm|a|s)$/i.test(options.output) ? resolve(io.cwd, options.output) : `${base}.inc`;
  const outputs: Array<{ kind: string; path: string; bytes: number; address?: number }> = [];
  const write = (target: string, bytes: Uint8Array | string, kind: string, address?: number) => {
    if (sameFile(target, path)) throw new UsageError("an output file is the input file; refusing to overwrite it");
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: target });
    }
    outputs.push({ kind, path: target, bytes: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length, ...(address === undefined ? {} : { address }) });
  };
  let build;
  let doc;
  // Everything that can fail is computed before the first file is written.
  let include: string | undefined;
  let psid: Uint8Array | undefined;
  let relocation: SidwaveRelocationTable | undefined;
  try {
    doc = parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs, path));
    const gameOptions = {
      target: "game" as const, origin: options.origin, dataOrigin: options.dataOrigin, zeroPage: options.zeroPage,
      symbols, symbolsAll: options.symbolsAll, measure: !options.noMeasure, maxCycles: options.maxCycles, ...(options.loop === undefined ? {} : { loop: options.loop }),
    };
    build = compileSidwave(doc, gameOptions);
    if (format === "asm") include = renderSidwaveGameInclude(build, asm, doc.song.title);
    if (format === "sid") psid = sidwaveGamePsid(doc, build);
    if (options.reloc) relocation = sidwaveRelocationTable(doc, gameOptions);
  } catch (error) {
    return withFile(file, (): number => { throw error; });
  }
  try {
    if (include !== undefined) write(includePath, include, `include-${asm}`, build.combinedOrigin);
    else if (psid) write(`${base}.sid`, psid, "psid", build.combinedOrigin);
    else if (build.data) {
      write(`${base}.bin`, build.player, "player", build.contract.memory.player.start);
      write(`${base}.data.bin`, build.data, "data", build.contract.memory.data!.start);
    } else write(`${base}.bin`, build.player, "player", build.contract.memory.player.start);
    if (relocation) write(`${base}.reloc.json`, `${JSON.stringify(relocation)}\n`, "relocation");
  } catch (error) {
    return withFile(file, (): number => { throw error; });
  }
  for (const [name, content] of Object.entries(build.symbols)) write(`${base}${SYMBOL_EXTENSIONS[name as SidwaveSymbolFormat]}`, content!, `symbols-${name}`);
  const { cycles, contract } = build;
  const cycleText = cycles.worst === null ? `upper bound ${cycles.estimatedWorst} cycles per play call (not measured)`
    : `worst ${cycles.worst} cycles per play call (measured over ${cycles.measuredOverSeconds!.toFixed(0)} s), upper bound ${cycles.estimatedWorst}`;
  const line = `${outputs[0]!.path}: game build, player $${contract.memory.player.start.toString(16).toUpperCase()}-$${(contract.memory.player.end - 1).toString(16).toUpperCase()}`
    + `${contract.memory.data ? `, data $${contract.memory.data.start.toString(16).toUpperCase()}-$${(contract.memory.data.end - 1).toString(16).toUpperCase()}` : ""}, ${cycleText}`;
  const report = options.json
    ? `${JSON.stringify(envelope("compile", true, { result: {
      file, target: "game", format, outputs, origin: contract.memory.player.start, dataOrigin: options.dataOrigin ?? null,
      zeroPage: options.zeroPage ?? 0xfb, contract, cycles, labels: build.labels, totalFrames: build.totalFrames,
      durationSeconds: build.durationSeconds, warnings: build.warnings,
      ...(doc.libraries ? { libraries: doc.libraries } : {}),
    } }), null, 2)}\n`
    : `${line}\n`;
  io.out(report);
  for (const warning of build.warnings) io.err(`warning: ${warning}\n`);
  return EXIT_OK;
}

function lint(io: CliIo, options: Options): number {
  rejectOptions(options, "lint", [["output", "-o"], ["format", "--format"], ["force", "--force"], ...GAME_FLAGS]);
  const file = pickFile(options, "lint");
  const { text, path } = readScore(io, file);
  const report = withFile(file, () => lintSidwave(parseSidwave(text, confinedReadOptions(io.cwd, options.allowDirs, path)), options.loop === undefined ? {} : { loop: options.loop }));
  const failed = options.strict && report.actionable > 0;
  emit(io, options, "lint", { file, findings: report.findings, actionable: report.actionable },
    report.findings.length === 0 ? `${file}: no lint findings` : report.formatted.map((line) => `${file}: ${line}`).join("\n"), !failed);
  return failed ? EXIT_FAILED : EXIT_OK;
}

function examples(io: CliIo, options: Options): number {
  rejectOptions(options, "examples", [["format", "--format"], ["loop", "--loop/--no-loop"], ["strict", "--strict"], ["allowDirs", "--allow-dir"], ...GAME_FLAGS]);
  if (options.positional.length > 1) throw new UsageError("examples takes at most one name");
  const name = options.positional[0];
  if (name === undefined) {
    rejectOptions(options, "examples without a name", [["output", "-o"], ["force", "--force"]]);
    const list = listSidwaveExamples();
    emit(io, options, "examples", list, list.map((e) => `${e.name.padEnd(18)} ${e.title}: ${e.style}`).join("\n"));
    return EXIT_OK;
  }
  if (!isExampleName(name)) throw new UsageError(`unknown example "${name}"; run "sidwave examples" for the list`);
  const score = readExampleScore(name);
  if (options.output === undefined) {
    io.out(score);
    return EXIT_OK;
  }
  const target = join(resolve(io.cwd, options.output), `${name}.yaml`);
  if (existsSync(target) && !options.force) throw new UsageError(`${target} exists; use --force to overwrite it`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, score);
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot write ${target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: target });
  }
  emit(io, options, "examples", { name, output: target, bytes: Buffer.byteLength(score) }, `wrote ${target}`);
  return EXIT_OK;
}

type Command = (io: CliIo, options: Options) => number | Promise<number>;
const assetArgs = (options: Options, command: string) => ({ file: pickFile(options, command), ...(options.output === undefined ? {} : { output: options.output }), force: options.force, json: options.json, allowDirs: options.allowDirs });
const lock: Command = (io, options) => lockCommand(io, assetArgs(options, "lock"));
const bundle: Command = (io, options) => bundleCommand(io, assetArgs(options, "bundle"));

const COMMANDS: Record<string, Command> = { validate, compile, lint, examples, lock, bundle, ...RUN_COMMANDS, reconstruct: reconstructCommand, ...ANALYZE_COMMANDS };

/** Reports a failure in the form the caller asked for and returns the exit code of its category. */
function fail(io: CliIo, json: boolean, command: string, error: unknown): number {
  const report = classifyError(error);
  if (json) {
    io.out(`${JSON.stringify(envelope(command, false, { error: report }), null, 2)}\n`);
  } else if (report.category === "usage") {
    io.err(`sidwave: ${report.message}\nRun "sidwave --help" for usage.\n`);
  } else if (report.category === "validation" && typeof report.details.file === "string") {
    io.err(`${report.details.file}: ${report.message}\n`);
  } else {
    io.err(`sidwave: ${report.message}\n`);
  }
  return EXIT_CODES[report.category];
}

/**
 * Runs the command line. `args` excludes the node binary and script path. The commands validate, compile, lint,
 * examples, sid, songlengths and stil finish synchronously; verify, render and trace return a promise.
 */
export function runCli(args: string[], io: CliIo): number | Promise<number> {
  const json = args.includes("--json");
  const [first, ...rest] = args;
  const interchange = first !== undefined && Object.prototype.hasOwnProperty.call(INTERCHANGE_COMMANDS, first) ? INTERCHANGE_COMMANDS[first] : undefined;
  const hvsc = first === "sid" || first === "sid-info" || first === "songlengths" || first === "stil";
  const authoring = first !== undefined && Object.prototype.hasOwnProperty.call(AUTHORING_COMMANDS, first) ? AUTHORING_COMMANDS[first] : undefined;
  const name = first !== undefined && (first === "retarget" || hvsc || interchange || authoring || Object.prototype.hasOwnProperty.call(COMMANDS, first)) ? first : "sidwave";
  try {
    if (first === undefined) { io.err(HELP); return EXIT_USAGE; }
    if (first === "-h" || first === "--help" || first === "help") { io.out(HELP); return EXIT_OK; }
    if (first === "-V" || first === "--version") { io.out(`${packageVersion()}\n`); return EXIT_OK; }
    if (first === "retarget") return runRetarget(io, rest);
    if (interchange) { const outcome = interchange(rest, io); return outcome instanceof Promise ? outcome.catch((error: unknown) => fail(io, json, name, error)) : outcome; }
    if (first === "complete") return runCompleteCli(rest, io);
    if (first === "sid") return runSidCli(rest, io);
    if (first === "sid-info") return rest.includes("-h") || rest.includes("--help") ? runSidCli(["info", "--help"], io) : sidInfoCommand(io, rest, "sid-info");
    if (first === "songlengths") return runSonglengthsCli(rest, io);
    if (first === "stil") return runStilCli(rest, io);
    if (first === "reconstruct" && (rest.some((arg) => arg === "--from" || arg.startsWith("--from=")) || isTraceInput(rest, io.cwd))) return reconstructFromTraceCommand(rest, io).catch((error: unknown) => fail(io, json, name, error));
    if (authoring) return authoring(rest, io);
    if (first === "play") return runPlayCli(rest, io);
    if (first === "watch") return runWatchCli(rest, io);
    const command = name === "sidwave" ? undefined : COMMANDS[name];
    if (!command) throw new UsageError(unknownCommandMessage(first, [...Object.keys(COMMANDS), ...Object.keys(INTERCHANGE_COMMANDS), ...Object.keys(AUTHORING_COMMANDS), "retarget", "complete", "sid", "songlengths", "stil", "play", "watch"]));
    const options = parseArgs(rest, name);
    if (options.help) { io.out(HELP); return EXIT_OK; }
    if (options.version) { io.out(`${packageVersion()}\n`); return EXIT_OK; }
    if (!Object.prototype.hasOwnProperty.call(RUN_COMMANDS, name) && name !== "reconstruct" && !Object.prototype.hasOwnProperty.call(ANALYZE_COMMANDS, name)) rejectRunFlags(options, name);
    const outcome = command(io, options);
    return outcome instanceof Promise ? outcome.catch((error: unknown) => fail(io, json, name, error)) : outcome;
  } catch (error) {
    return fail(io, json, name, error);
  }
}
