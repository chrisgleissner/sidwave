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

/** What was recovered, what differs and why, in plain words, for a musician. */
export function plainSummary(report: ReconstructReport): string {
  const r = report.recovery;
  const lines: string[] = [];
  const minutes = (report.horizon.seconds / 60).toFixed(1);
  lines.push(`Recovered ${r.noteCount} notes in ${r.instrumentCount} instruments and ${r.patternCount} patterns from the first ${report.horizon.seconds} s (${minutes} min) of the tune; the score is written for SIDWave ${r.languageVersion}.`);
  if (report.strictExact) lines.push("The recompiled score writes exactly the same registers as the tune on every player call: a strict match.");
  else if (report.registerStateExact) lines.push("The recompiled score sets the same register values after every player call. Only the order of writes inside a call or the exact call timing differs, so it should sound the same, but it is not a strict match.");
  else if (report.compile?.ok === false) lines.push(`The recovered score could not be compiled (${report.compile.error}), so nothing could be compared.`);
  else {
    const f = report.fdiff.first;
    if (f) lines.push(`The first difference is in ${f.class} at ${f.timeSeconds.toFixed(2)} s (player call ${f.call})${f.voice !== undefined ? `, voice ${f.voice}` : ""}.`);
    lines.push(`${report.fdiff.differingCalls} register differences over ${report.fdiff.comparedCalls} compared player calls.`);
  }
  if (report.compile?.cycleBudgetExceeded) lines.push("The player needs more cycles per call than a 1 MHz C64 has at this call rate; the score was compiled for a faster CPU, so this is never a strict match.");
  const why = new Map<string, string>([
    ["tuning", "some notes are not on the tuning table the score can describe"],
    ["pitch", "some pitches (slides, vibrato shapes or per-call frequencies) could not be written as notes"],
    ["instrument_budget", "the tune has more instrument variants or table steps than one SIDWave score can hold; the rarest were simplified"],
    ["global_state", "filter or volume changes outside notes are not recovered yet"],
    ["multi_sid", "only the first SID was recovered"],
    ["call_rate", "the player is not called a whole number of times per frame"],
    ["call_timing", "the player's call timing is irregular"],
    ["non_periodic_writes", "part of the tune is played with sample writes outside the player calls"],
    ["hard_restart", "some hard restarts had to be shortened"],
    ["short_note", "notes shorter than one frame were dropped"],
    ["long_note", "very long notes were cut"],
  ]);
  const reasons = [...new Set(report.unsupported.map((u) => u.kind))].map((k) => why.get(k)).filter((x): x is string => Boolean(x));
  if (reasons.length) lines.push(`Why it differs: ${reasons.join("; ")}.`);
  return `${lines.join("\n")}\n`;
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
  if (options.json) io.out(`${JSON.stringify(envelope("reconstruct", ok, { result: { file, output: target ?? null, score, summary: plainSummary(report).trimEnd().split("\n"), report } }), null, 2)}\n`);
  else {
    if (!target) io.out(score);
    io.err(plainSummary(report));
    io.err(`${target ? `${target}: ` : ""}${summaryLine(report)}\n`);
  }
  return ok ? EXIT_OK : EXIT_FAILED;
}
