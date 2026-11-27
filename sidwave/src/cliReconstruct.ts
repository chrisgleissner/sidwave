// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// `sidwave reconstruct <file.sid> [--song n] [--seconds s] [-o score.yaml] [--json]`, on the shared CLI contract of
// cliCore.ts. Kept in its own file so that other commands can be added to cli.ts without touching this one.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, envelope, type CliIo } from "./cliCore.js";
import { createLibsidplayfpEngine } from "./engine/libsidplayfp.js";
import { parseSidFile } from "./sidFile.js";
import { readInput } from "./sidwaveTools.js";
import { DEFAULT_HORIZON_SECONDS, reconstructSid, type ReconstructReport } from "./reconstruct/reconstruct.js";

export const RECONSTRUCT_USAGE = "  sidwave reconstruct <file.sid> [--song <n>] [--seconds <s>] [-o <score.yaml>] [--json]\n";
export const RECONSTRUCT_COMMAND_HELP = `  reconstruct Recover a score from a SID tune: trace it, recover notes, instruments and patterns, recompile the score,
             trace it again and compare call by call (F-diff). --song is the 1-based PSID subtune, --seconds the
             horizon (default ${DEFAULT_HORIZON_SECONDS}, always reported). The score goes to -o or standard output. Exit 0 when the strict F-diff
             shows no difference (report.strictExact), 1 otherwise (--json then has ok:false and the result).
`;

/** The part of the parsed command line this command reads. */
interface ReconstructOptions {
  positional: string[];
  output?: string;
  json: boolean;
  run: { song?: number; seconds?: number };
}

/** The strict verdict: see ReconstructReport.strictExact. registerStateExact is secondary and does not decide the exit code. */
export function reconstructPassed(report: ReconstructReport): boolean {
  return report.strictExact;
}

function summaryLine(report: ReconstructReport): string {
  const f = report.fdiffState;
  const state = Object.entries(f.classes).filter(([n]) => n !== "timing").reduce((sum, [, c]) => sum + c.differingCalls, 0);
  return `horizon ${report.horizon.seconds} s (${report.horizon.calls} calls), ${report.recovery.noteCount} notes, ${report.recovery.instrumentCount} instruments, `
    + `strict ${report.strictExact ? "exact" : "not exact"}, register state ${report.registerStateExact ? "exact" : "differs"} (${state} differing calls), `
    + `F-diff: ${state} differing calls in register-state classes, ${f.classes.timing.differingCalls} in call timing, ${report.languageExtensions.length} language-extension candidates`;
}

export async function reconstructCommand(io: CliIo, options: ReconstructOptions): Promise<number> {
  if (options.positional.length !== 1) throw new UsageError("reconstruct needs exactly one SID file");
  const file = options.positional[0]!;
  const bytes = readInput(file, { cwd: io.cwd });
  const header = parseSidFile(bytes);
  if (options.run.song !== undefined && options.run.song > header.songs) {
    throw new SidwaveOperationError("input", `--song ${options.run.song} is outside 1..${header.songs}, the subtunes of ${file}`, { file });
  }
  const engine = io.createEngine ? io.createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
  const { score, report } = await reconstructSid(bytes, { engine, song: options.run.song, seconds: options.run.seconds });
  const target = options.output === undefined || options.output === "-" ? undefined : resolve(io.cwd, options.output);
  if (target) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, score);
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: target });
    }
  }
  const ok = reconstructPassed(report);
  if (options.json) io.out(`${JSON.stringify(envelope("reconstruct", ok, { result: { file, output: target ?? null, score, report } }), null, 2)}\n`);
  else {
    if (!target) io.out(score);
    io.err(`${target ? `${target}: ` : ""}${summaryLine(report)}\n`);
  }
  return ok ? EXIT_OK : EXIT_FAILED;
}
