// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// `sidwave retarget`: the command line of the retargeting library.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, envelope, withFile, type CliIo } from "./cliCore.js";
import { confinedReadOptions, isExampleName, readExampleScore } from "./sidwaveOps.js";
import { retargetSidwave, type RetargetChange, type RetargetReport } from "./retarget.js";

export const RETARGET_HELP = `Usage:
  sidwave retarget <score> [--clock pal|ntsc] [--model 6581|8580] [--sids <n>] [--budget-cycles <n>] [--budget-bytes <n>]
                   [--allow-changes] [-o <out.yaml>] [--force] [--json] [--allow-dir <dir>]

  retarget   Convert a score to another video standard, SID model or SID count and, with a budget, optimise it. Every
             change is reported as exact, approximate or dropped with measured numbers (timing error in ms, filter
             deviation in Hz, voices kept and dropped, bytes and cycles). At least one of the options above is needed.
             The result is written to -o (not overwritten without --force; "-o -" or no -o writes it to standard
             output and the report to standard error). --json prints the report as JSON on standard output.
             --budget-bytes limits the PRG size and --budget-cycles the worst-case cycles of one play call, measured
             on the bundled emulator. Steps that keep the register trace identical run first; lossy steps (copy voices,
             multispeed, table length) run only with --allow-changes. A budget that cannot be met gives exit 1 and the
             best numbers reached; no score is written then.
             Exit codes: 0 success, 1 infeasible budget, 2 usage error, 3 unreadable or invalid input, or a score that does not compile.
             With --json the envelope has ok: false and a result (no error) for an infeasible budget.
  <score> may be a file or the name of a bundled example.
`;

interface Parsed {
  file?: string;
  clock?: string;
  model?: string;
  sids?: number;
  budgetCycles?: number;
  budgetBytes?: number;
  allowChanges: boolean;
  output?: string;
  force: boolean;
  json: boolean;
  allowDirs: string[];
  help: boolean;
}

function whole(flag: string, value: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) throw new UsageError(`${flag} needs a positive whole number, not "${value}"`);
  return Number(value);
}

function parse(args: string[]): Parsed {
  const out: Parsed = { allowChanges: false, force: false, json: false, allowDirs: [], help: false };
  const values = new Set(["--clock", "--model", "--sids", "--budget-cycles", "--budget-bytes", "-o", "--output", "--allow-dir"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) { inline = arg.slice(arg.indexOf("=") + 1); arg = arg.slice(0, arg.indexOf("=")); }
    if (values.has(arg)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--clock") {
        if (!/^(pal|ntsc)$/i.test(value)) throw new UsageError(`--clock needs pal or ntsc, not "${value}"`);
        out.clock = value.toLowerCase();
      } else if (arg === "--model") {
        if (value !== "6581" && value !== "8580") throw new UsageError(`--model needs 6581 or 8580, not "${value}"`);
        out.model = value;
      } else if (arg === "--sids") out.sids = whole(arg, value);
      else if (arg === "--budget-cycles") out.budgetCycles = whole(arg, value);
      else if (arg === "--budget-bytes") out.budgetBytes = whole(arg, value);
      else if (arg === "--allow-dir") out.allowDirs.push(value);
      else out.output = value;
    } else if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
    else if (arg === "--allow-changes") out.allowChanges = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError("retarget needs exactly one score file");
  if (positional[0] !== undefined) out.file = positional[0];
  return out;
}

/** One line per group of changes with the same step, construct and class. */
function groupedLines(changes: RetargetChange[]): string[] {
  const groups = new Map<string, { change: RetargetChange; count: number; worst: number }>();
  for (const change of changes) {
    const key = `${change.step}|${change.construct}|${change.class}`;
    const group = groups.get(key);
    if (group) { group.count++; group.worst = Math.max(group.worst, change.errorMs ?? 0); } else groups.set(key, { change, count: 1, worst: change.errorMs ?? 0 });
  }
  return [...groups.values()].map(({ change, count, worst }) =>
    `${change.class.padEnd(11)} ${change.step}/${change.construct}${count > 1 ? ` x${count}${worst > 0 ? `, worst ${worst.toFixed(1)} ms` : ""}` : ""}: ${change.summary}`);
}

export function describeRetarget(report: RetargetReport): string {
  const { exact, approximate, dropped } = report.summary;
  const lines = [
    `retarget: ${report.verdict}; ${exact} exact, ${approximate} approximate, ${dropped} dropped changes${report.summary.voicesDropped ? `, ${report.summary.voicesDropped} voices dropped` : ""}`,
    `before: ${report.before.bytes} bytes, ${report.before.cycles} cycles per play call (${report.before.cyclesKind}); after: ${report.after.bytes} bytes, ${report.after.cycles} cycles (${report.after.cyclesKind})`,
    ...groupedLines(report.changes),
    ...(report.sids ? report.sids.voices.map((v) => `voice ${v.id}${v.name ? ` "${v.name}"` : ""}: ${v.decision} (${v.class}, rank ${v.rank}): ${v.reason}`) : []),
    ...report.notes,
  ];
  return lines.join("\n");
}

/** Runs `sidwave retarget`. `args` excludes the command name. Usage errors throw; everything else returns an exit code. */
export function runRetarget(io: CliIo, args: string[]): number {
  const options = parse(args);
  if (options.help) { io.out(RETARGET_HELP); return EXIT_OK; }
  if (!options.file) throw new UsageError("retarget needs exactly one score file");
  if (options.clock === undefined && options.model === undefined && options.sids === undefined && options.budgetCycles === undefined && options.budgetBytes === undefined) {
    throw new UsageError("retarget needs at least one of --clock, --model, --sids, --budget-cycles or --budget-bytes");
  }
  if (options.allowChanges && options.budgetCycles === undefined && options.budgetBytes === undefined) throw new UsageError("--allow-changes applies to --budget-cycles and --budget-bytes");
  let text: string;
  if (isExampleName(options.file) && !existsSync(resolve(io.cwd, options.file))) text = readExampleScore(options.file);
  else {
    try { text = readFileSync(resolve(io.cwd, options.file), "utf8"); } catch (error) {
      throw new SidwaveOperationError("input", `cannot read ${options.file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: options.file });
    }
  }
  const target = options.output !== undefined && options.output !== "-" ? resolve(io.cwd, options.output) : undefined;
  if (target && existsSync(target) && !options.force) throw new UsageError(`${options.output} exists; use --force to overwrite it`);

  const result = withFile(options.file, () => retargetSidwave(text, {
    ...(options.clock ? { clock: options.clock as "pal" | "ntsc" } : {}), ...(options.model ? { model: options.model as "6581" | "8580" } : {}),
    ...(options.sids !== undefined ? { sids: options.sids } : {}), ...(options.budgetCycles !== undefined ? { budgetCycles: options.budgetCycles } : {}),
    ...(options.budgetBytes !== undefined ? { budgetBytes: options.budgetBytes } : {}), allowChanges: options.allowChanges,
    read: confinedReadOptions(io.cwd, options.allowDirs),
  }));
  const { report } = result;
  const fits = report.verdict === "ok";
  if (fits && target) {
    try { writeFileSync(target, result.text); } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${options.output}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: target });
    }
  }
  if (options.json) {
    io.out(`${JSON.stringify(envelope("retarget", fits, { result: {
      file: options.file, verdict: report.verdict, ...(fits && target ? { output: target } : {}),
      ...(fits && !target ? { text: result.text } : {}), ...(!fits ? { bestEffortText: result.text } : {}), report,
    } }), null, 2)}\n`);
  } else if (target) {
    io.out(`${describeRetarget(report)}\n${fits ? `wrote ${target}\n` : "no output written\n"}`);
  } else {
    if (fits) io.out(result.text);
    io.err(`${describeRetarget(report)}\n`);
  }
  return fits ? EXIT_OK : EXIT_FAILED;
}

