// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Command line of the convert hub: `sidwave convert`, `sidwave formats` and `sidwave info`.

import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, UsageError, envelope, type CliIo } from "../cliCore.js";
import { confinedReadOptions } from "../sidwaveOps.js";
import { parseFlags, numberFlag, readBounded, writeOutput, type InterchangeArgs } from "./cli.js";
import { ambiguityMessage, convert, inputFormat, type ConvertResult } from "./convert.js";
import { InterchangeUsageError } from "./errors.js";
import { detectFormat, findFormat, formatDefinitions, listFormats, resolveTarget } from "./registry.js";
import type { Loss } from "./loss.js";

export const CONVERT_HELP = `  sidwave convert <in> [<out>] [--to <format>] [--from <format>] [--song <n>] [--voices <n>] [--keep-score <file>]
                  [--report <file>|-] [--strict] [--dry-run] [--verify] [--force] [--json]   (see "sidwave convert --help")
  sidwave formats [--json]
  sidwave info <file> [--from <format>] [--json]
`;

const CONVERT_DETAIL = `sidwave convert: convert between the formats that carry C64 music.

Usage:
  sidwave convert <in> [<out>] [--to <format>] [--from <format>] [options]

The input format is detected from the file content (the extension only breaks ties). The target comes from --to, or
from the extension of <out>. Without <out> the output is <input name>.<extension> in the current directory. Existing
files are never overwritten without --force.

Examples:
  sidwave convert song.sng song.mid                 GoatTracker song to MIDI
  sidwave convert tune.mid tune.sid                 MIDI to a playable SID file
  sidwave convert tune.sid tune.sng                 SID to a GoatTracker song (reads the tune by tracing: slower, approximate)
  sidwave convert score.yaml --to musicxml          SIDWave score to MusicXML, written to score.musicxml
  sidwave convert song.fur song.sng --dry-run       show the detection, the chain and the expected losses, write nothing
  sidwave convert unknown.bin out.mid --from sidwave  name the input format when it cannot be detected

Options:
  --to <format>        Target format (id, alias or extension). Run "sidwave formats" for the list.
  --from <format>      Input format; skips detection.
  --song <n>           Song or subtune, 1-based (default 1; a .sid: its start song).
  --voices <n>         Keep at most n voices. The voices with the most notes x pitch range are kept; the others are listed as lost.
  --grid <beats>       Quantisation grid of MIDI and MusicXML input, in quarter notes (default 0.25).
  --mode PAL|NTSC      Clock of imported scores (default PAL).
  --seconds <s>        Horizon of a .sid read and length of a WAV render.
  --model 6581|8580    SID model of a WAV render (default 6581).
  --keep-score <file>  Also write the intermediate SIDWave score.
  --report <file>|-    Write the full report (detection, chain, losses, metrics) as JSON; - prints it.
  --strict             Exit 1, and write nothing, when any loss has severity lost.
  --dry-run            Run the chain in memory and report; write no file. A .sid input is not traced (slow): only the plan is shown.
  --verify             Re-import the output and compare it with the input score: note F1, onset error, octave shifts, voices dropped.
  --force              Overwrite existing output files.
  --allow-dir <dir>    Allow sample files and libraries of a SIDWave score below <dir>.
  --json               Machine-readable result on standard output.

Losses have a severity: info (nothing musical lost), approx (close, not equal) and lost (content missing in the output).
Exit codes: 0 success; 1 --strict found a lost loss; 2 usage; 3 unreadable or ambiguous input; 4 engine unavailable; 5 limit.
`;

const VALUED = ["-o", "--output", "--to", "--from", "--song", "--voices", "--grid", "--mode", "--seconds", "--model", "--keep-score", "--report", "--title", "--allow-dir"];
const BARE = ["--strict", "--dry-run", "--verify", "--force", "--json", "-h", "--help"];

const stem = (file: string): string => basename(file, extname(file)).replace(/\.sidwave$/i, "");
const wantsHelp = (args: string[]): boolean => args.includes("-h") || args.includes("--help");

function intFlag(a: InterchangeArgs, flag: string, min: number): number | undefined {
  const n = numberFlag(a, flag);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} needs a whole number of at least ${min}, not "${String(a.flags.get(flag))}"`);
  return n;
}

function choice<T extends string>(a: InterchangeArgs, flag: string, allowed: readonly T[]): T | undefined {
  const v = a.flags.get(flag);
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new UsageError(`${flag} must be ${allowed.join(" or ")}, not "${String(v)}"`);
  return v as T;
}

const short = (text: string, n = 150): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function lossLines(losses: readonly Loss[]): string[] {
  const rank = { lost: 0, approx: 1, info: 2 } as const;
  return [...losses].sort((a, b) => rank[a.severity] - rank[b.severity]).map((l) => `  ${l.severity.padEnd(6)} ${l.code.padEnd(20)} ${String(l.count).padStart(4)}  ${short(l.message.split(" | ")[0]!)}`);
}

function severityCounts(losses: readonly Loss[]): string {
  const count = (s: Loss["severity"]): number => losses.filter((l) => l.severity === s).length;
  return `${count("lost")} lost, ${count("approx")} approximate, ${count("info")} info`;
}

function checkOverwrite(io: CliIo, target: string, force: boolean): void {
  const path = resolve(io.cwd, target);
  if (existsSync(path) && !force) throw new UsageError(`${path} exists; use --force to overwrite it`);
}

async function convertCommand(args: string[], io: CliIo): Promise<number> {
  if (wantsHelp(args)) { io.out(CONVERT_DETAIL); return EXIT_OK; }
  const a = parseFlags(args, VALUED, BARE);
  if (a.positional.length < 1 || a.positional.length > 2) throw new UsageError("convert needs an input file and optionally an output file: sidwave convert <in> [<out>] [--to <format>]");
  const [file, out] = a.positional as [string, string | undefined];
  const outFlag = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
  if (out !== undefined && outFlag !== undefined) throw new UsageError("name the output once: as the second argument or with -o");
  const outputName = out ?? outFlag;
  const json = a.flags.has("--json");
  const dryRun = a.flags.has("--dry-run");
  const force = a.flags.has("--force");
  const keepScore = a.flags.get("--keep-score") as string | undefined;
  const reportTarget = a.flags.get("--report") as string | undefined;
  const toStdout = outputName === "-";
  if (toStdout && (json || reportTarget === "-")) throw new UsageError("-o - writes the converted bytes to standard output; --json and --report - cannot share it");
  if (json && reportTarget === "-") throw new UsageError("--report - and --json both print to standard output; use --report <file> with --json");

  const to = a.flags.get("--to") as string | undefined;
  const target = resolveTarget(to, outputName);
  const extensionWarnings: string[] = [];
  if (to !== undefined && outputName !== undefined && !toStdout) {
    const ext = extname(outputName).toLowerCase();
    if (ext && !target.extensions.includes(ext)) extensionWarnings.push(`the output name ${outputName} does not have a ${target.id} extension (${target.extensions.join(", ")}); --to ${to} decides the format`);
  }
  const { bytes, path } = readBounded(io, file);
  const song = intFlag(a, "--song", 1);
  const voices = intFlag(a, "--voices", 1);
  const grid = numberFlag(a, "--grid");
  if (grid !== undefined && !(grid > 0)) throw new UsageError("--grid needs a number above 0");
  const seconds = numberFlag(a, "--seconds");
  if (seconds !== undefined && !(seconds > 0)) throw new UsageError("--seconds needs a number above 0");
  const mode = choice(a, "--mode", ["PAL", "NTSC"] as const);
  const model = choice(a, "--model", ["6581", "8580"] as const);
  const from = a.flags.get("--from") as string | undefined;
  if (from !== undefined && !findFormat(from)) throw new InterchangeUsageError(`unknown format "${from}" for --from; run "sidwave formats"`);
  const title = typeof a.flags.get("--title") === "string" ? (a.flags.get("--title") as string) : undefined;

  const outputPath = toStdout ? undefined : outputName ?? `${stem(file)}${target.extensions[0]!}`;
  // Check every output before the chain runs, so a refusal leaves nothing partial and wastes no time.
  if (!dryRun) {
    if (outputPath !== undefined) { checkOverwrite(io, outputPath, force); if (resolve(io.cwd, outputPath) === path) throw new UsageError("the output file is the input file; refusing to overwrite it"); }
    if (keepScore !== undefined) checkOverwrite(io, keepScore, force);
  }
  if (reportTarget !== undefined && reportTarget !== "-") checkOverwrite(io, reportTarget, force);

  const notices: string[] = [];
  const options = {
    inputName: file, ...(from === undefined ? {} : { from }), to: target.id,
    ...(song === undefined ? {} : { song }), ...(voices === undefined ? {} : { voices }), ...(grid === undefined ? {} : { grid }),
    ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(seconds === undefined ? {} : { seconds }), ...(title === undefined ? {} : { title }),
    verify: a.flags.has("--verify"),
    readOptions: confinedReadOptions(io.cwd, a.allowDirs, path),
    ...(io.createEngine ? { createEngine: io.createEngine } : {}), ...(io.signal ? { signal: io.signal } : {}),
    notice: (message: string) => { notices.push(message); if (!json) io.err(`notice: ${message}\n`); },
  };

  // A dry run of a .sid input shows the plan without tracing the tune.
  if (dryRun) {
    const probe = inputFormat(bytes, options);
    if (probe.format.readIsApproximate) {
      const plan = { dryRun: true, traced: false, from: probe.format.id, to: target.id, detected: { format: probe.format.id, by: probe.viaFrom ? "--from" : probe.detection.best?.by, candidates: probe.detection.candidates, warnings: probe.detection.warnings },
        chain: [`read:${probe.format.id}`, "normalise", `plan:${target.id}`, `write:${target.id}`],
        expectedLosses: [{ stage: "read", code: "reconstruct.approximate", severity: "approx", count: 1, message: "Reading a .sid recovers the score by tracing the tune: approximate, slow, limited to the horizon. The F-diff of the recovered score is part of the real report." }],
        output: outputPath ?? null };
      io.out(json ? `${JSON.stringify(envelope("convert", true, { result: plan }), null, 2)}\n`
        : `dry run: ${file} is ${probe.format.id} (${probe.viaFrom ? "--from" : probe.detection.best?.by}); chain ${plan.chain.join(" > ")}\n  approx reconstruct.approximate  reading a .sid is approximate and slower (not run in a dry run)\n`);
      return EXIT_OK;
    }
  }

  const result = await convert(bytes, options);
  for (const w of [...result.detected.warnings, ...extensionWarnings]) io.err(`warning: ${w}\n`);

  const strictFailed = a.flags.has("--strict") && result.severity === "lost";
  const outputs: Array<{ kind: string; path: string | null; bytes: number; format: string }> = [];
  if (!dryRun && !strictFailed) {
    if (toStdout) { io.outBytes(result.output); outputs.push({ kind: "output", path: null, bytes: result.output.length, format: result.to }); }
    else {
      const written = writeOutput(io, path, outputPath!, result.output);
      outputs.push({ kind: "output", path: written, bytes: result.output.length, format: result.to });
    }
    if (keepScore !== undefined) {
      const written = writeOutput(io, path, keepScore, result.score.endsWith("\n") ? result.score : `${result.score}\n`);
      outputs.push({ kind: "score", path: written, bytes: Buffer.byteLength(result.score), format: "sidwave" });
    }
  }
  const summary = {
    dryRun, ...(strictFailed ? { strictFailed: true, note: "--strict: a loss with severity lost was found; nothing was written" } : {}),
    from: result.from, to: result.to, detected: result.detected, chain: result.chain, losses: result.losses, severity: result.severity,
    ...(result.metrics ? { metrics: result.metrics } : {}), notices: result.notices, plan: result.plan, outputs, defaults: result.defaults, timings: result.timings,
    reports: result.reports,
  };
  if (reportTarget !== undefined) {
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    if (reportTarget === "-") io.out(text); else outputs.push({ kind: "report", path: writeOutput(io, path, reportTarget, text), bytes: Buffer.byteLength(text), format: "json" });
  }
  const ok = !strictFailed;
  if (json) { io.out(`${JSON.stringify(envelope("convert", ok, { result: summary }), null, 2)}\n`); return ok ? EXIT_OK : EXIT_FAILED; }
  if (reportTarget === "-") return ok ? EXIT_OK : EXIT_FAILED;
  const text = humanSummary(file, result, outputs, dryRun, strictFailed);
  // With the converted bytes on standard output the summary goes to standard error so the two never mix.
  if (toStdout) io.err(text); else io.out(text);
  return ok ? EXIT_OK : EXIT_FAILED;
}

function humanSummary(file: string, result: ConvertResult, outputs: Array<{ kind: string; path: string | null; bytes: number }>, dryRun: boolean, strictFailed: boolean): string {
  const lines: string[] = [];
  const how = result.detected.viaFrom ? "from --from" : `detected by ${result.detected.by}, confidence ${result.detected.confidence}`;
  const where = dryRun ? "dry run, nothing written" : outputs.filter((o) => o.kind !== "report").map((o) => `${o.kind} ${o.path ?? "standard output"} (${o.bytes} bytes)`).join(", ");
  lines.push(`${file}: ${result.from} (${how}) -> ${result.to}; ${where || "nothing written"}`);
  lines.push(`chain: ${result.chain.join(" > ")}`);
  if (result.plan.dropped.length) lines.push(`voices dropped: ${result.plan.dropped.map((id) => `v${id}`).join(", ")}`);
  if (result.losses.length) { lines.push(`losses (${severityCounts(result.losses)}):`); lines.push(...lossLines(result.losses)); }
  else lines.push("losses: none");
  const m = result.metrics;
  if (m) {
    lines.push(m.available
      ? `quality: note F1 ${m.noteF1} (precision ${m.precision}, recall ${m.recall}), onset error mean ${m.onsetError?.meanMs} ms max ${m.onsetError?.maxMs} ms, octave shifts ${m.octaveShifted}, voices dropped ${m.voicesDropped}, instruments mapped ${m.instruments?.mapped}/${m.instruments?.used}${m.fdiff ? `, F-diff ${m.fdiff.differingCalls} register-class differences over ${m.fdiff.comparedCalls} calls` : ""}`
      : `quality: not measured (${m.reason})`);
  }
  if (strictFailed) lines.push("--strict: a loss with severity lost was found; nothing was written");
  return `${lines.join("\n")}\n`;
}

function formatsCommand(args: string[], io: CliIo): number {
  if (wantsHelp(args)) { io.out("sidwave formats [--json]\n  List the formats of \"sidwave convert\": read and write support, how each is detected and what it loses.\n"); return EXIT_OK; }
  const a = parseFlags(args, [], ["--json"]);
  if (a.positional.length) throw new UsageError("formats takes no arguments");
  const list = listFormats();
  if (a.flags.has("--json")) { io.out(`${JSON.stringify(envelope("formats", true, { result: { formats: list } }), null, 2)}\n`); return EXIT_OK; }
  const w = (n: string, k: keyof (typeof list)[number]): number => Math.max(n.length, ...list.map((f) => String(f[k]).length));
  const idW = w("id", "id"), nameW = w("name", "name");
  const rows = [`${"id".padEnd(idW)}  ${"name".padEnd(nameW)}  read    write  extensions`];
  for (const f of list) rows.push(`${f.id.padEnd(idW)}  ${f.name.padEnd(nameW)}  ${(f.read ? (f.readApproximate ? "approx" : "yes") : "no").padEnd(6)}  ${(f.write ? "yes" : "no").padEnd(5)}  ${f.extensions.join(" ")}`);
  rows.push("", "Detection and losses:");
  for (const f of list) rows.push(`  ${f.id}: detected by ${f.detection}.`, `    ${f.lossSummary}.`);
  io.out(`${rows.join("\n")}\n`);
  return EXIT_OK;
}

function infoCommand(args: string[], io: CliIo): number {
  if (wantsHelp(args)) { io.out("sidwave info <file> [--from <format>] [--json]\n  Detect the format of any supported file and describe it.\n"); return EXIT_OK; }
  const a = parseFlags(args, ["--from"], ["--json"]);
  if (a.positional.length !== 1) throw new UsageError("info needs exactly one file");
  const file = a.positional[0]!;
  const { bytes } = readBounded(io, file);
  const from = a.flags.get("--from") as string | undefined;
  const detection = detectFormat(bytes, file);
  const format = from !== undefined ? findFormat(from) : detection.best ? formatDefinitions().find((f) => f.id === detection.best!.id) : undefined;
  if (from !== undefined && !format) throw new InterchangeUsageError(`unknown format "${from}" for --from; run "sidwave formats"`);
  if (!format) throw new InterchangeUsageError(ambiguityMessage(file, detection));
  let details: Record<string, unknown> = {};
  try { details = format.describe ? format.describe(bytes) : {}; } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError) throw new InterchangeUsageError(`${file} is not a valid ${format.id} file: ${error.message}`);
    throw error;
  }
  const result = {
    file, bytes: bytes.length, format: format.id, name: format.name, confidence: from !== undefined ? 1 : detection.best!.confidence, by: from !== undefined ? "--from" : detection.best!.by,
    readable: format.read !== undefined, writable: format.write !== undefined, details, warnings: detection.warnings, candidates: detection.candidates,
  };
  if (a.flags.has("--json")) { io.out(`${JSON.stringify(envelope("info", true, { result }), null, 2)}\n`); return EXIT_OK; }
  for (const w of detection.warnings) io.err(`warning: ${w}\n`);
  const facts = Object.entries(details).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  io.out(`${file}: ${format.name} (${result.by}, confidence ${result.confidence}), ${bytes.length} bytes\n  can be read: ${result.readable ? "yes" : "no"}; can be written: ${result.writable ? "yes" : "no"}\n${facts.join("\n")}${facts.length ? "\n" : ""}`);
  return EXIT_OK;
}

/** Commands of the convert hub; `cli.ts` merges them with the other interchange commands. */
export const HUB_COMMANDS: Record<string, (args: string[], io: CliIo) => number | Promise<number>> = {
  convert: convertCommand, formats: formatsCommand, info: infoCommand,
};
