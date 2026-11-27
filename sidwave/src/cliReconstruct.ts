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

export function summaryLine(report: ReconstructReport): string {
  const f = report.fdiffState;
  const state = Object.entries(f.classes).filter(([n]) => n !== "timing").reduce((sum, [, c]) => sum + c.differingCalls, 0);
  const turbo = report.compile?.turboFallback ? ", turbo fallback (not run at 1 MHz)" : "";
  return `horizon ${report.horizon.seconds} s (${report.horizon.calls} calls), ${report.recovery.noteCount} notes, ${report.recovery.instrumentCount} instruments, `
    + `strict ${report.strictExact ? "exact" : "not exact"}, register state ${report.registerStateExact ? "exact" : "differs"}${turbo}, `
    + `F-diff: ${report.fdiff.callsWithDifference} of ${report.fdiff.comparedCalls} calls differ, ${state} differing calls in register-state classes, ${f.classes.timing.differingCalls} in call timing, ${report.languageExtensions.length} language-extension candidates`;
}

const VOICE_REGISTERS = ["frequency low", "frequency high", "pulse width low", "pulse width high", "control", "attack/decay", "sustain/release"];
const GLOBAL_REGISTERS = new Map<number, string>([[0x15, "filter cutoff low"], [0x16, "filter cutoff high"], [0x17, "filter resonance and routing"], [0x18, "filter mode and volume"]]);

/** The register in words, for example "voice 1 control register ($D404)". The base address is that of the first SID. */
export function registerName(register: number, voice?: number): string {
  const address = `$D4${register.toString(16).toUpperCase().padStart(2, "0")}`;
  if (register < 0x15) return `voice ${voice ?? Math.floor(register / 7) + 1} ${VOICE_REGISTERS[register % 7]} register (${address})`;
  return `${GLOBAL_REGISTERS.get(register) ?? "register"} register (${address})`;
}

const hexByte = (v: number): string => `$${v.toString(16).toUpperCase().padStart(2, "0")}`;

/** The likely cause of a first difference, from its class. */
const LIKELY_CAUSE = new Map<string, string>([
  ["gate", "the gate or test bit is switched at a different time than in the original: hard-restart timing, gate-off timing relative to the note, or use of the test bit"],
  ["pitch", "the frequencies differ: a pitch program, slide, vibrato shape or note outside the tuning table that the score cannot describe exactly"],
  ["waveform", "the waveform or its control bits (sync, ring) differ: a waveform program the score cannot express"],
  ["pulse", "the pulse width differs: a pulse-width program or start value that was not recovered exactly"],
  ["adsr", "the envelope settings differ: an envelope change inside a note or a hard-restart envelope"],
  ["filter", "the filter registers differ: filter changes outside notes are not recovered yet"],
  ["volume", "the master volume differs: the start-up volume ramp or a volume change outside notes"],
  ["timing", "the player is called at a different time than in the original"],
]);

/** What was recovered, what differs and why, in plain words, for a musician. */
export function plainSummary(report: ReconstructReport): string {
  const r = report.recovery;
  const lines: string[] = [];
  const minutes = (report.horizon.seconds / 60).toFixed(1);
  lines.push(`Recovered ${r.noteCount} notes in ${r.instrumentCount} instruments and ${r.patternCount} patterns from the first ${report.horizon.seconds} s (${minutes} min) of the tune; the score is written for SIDWave ${r.languageVersion}.`);
  const turbo = report.compile?.turboFallback;
  if (report.internalError) lines.push(`Internal error: the recovered score is not valid${report.internalError.field ? ` at ${report.internalError.field}` : ""}: ${report.internalError.message}. This is a defect or a limit of the recovery, not of the tune.`);
  if (report.compile?.ok === false) lines.push(`The recompiled score does not match the original: the recovered score could not be compiled (${report.compile.error}), so nothing could be compared.`);
  else if (turbo) lines.push(`The recompiled score does not match the original at 1 MHz: ${turbo.message}. The saved score includes \`cpu: turbo\` and a warning comment, so the file compiles as it is. It was compared on a turbo CPU and is never counted as a match.`);
  else if (report.strictExact) lines.push("The recompiled score matches the original: it writes exactly the same registers as the tune on every player call, a strict match.");
  else if (report.registerStateExact) lines.push("The recompiled score matches the original in the register values after every player call. Only the order of writes inside a call or the exact call timing differs, so it should sound the same, but it is not a strict match.");
  else lines.push("The recompiled score does not match the original.");
  if (report.compile?.ok !== false && !report.strictExact) {
    const f = report.fdiff;
    if (f.callsWithDifference > 0 || !report.registerStateExact) {
      const share = f.comparedCalls ? ` (${((100 * f.callsWithDifference) / f.comparedCalls).toFixed(1)} %)` : "";
      lines.push(`${f.callsWithDifference} of ${f.comparedCalls} player calls differ${share}.`);
    }
    const first = f.first;
    if (first && !report.registerStateExact) {
      const what = first.register !== undefined ? registerName(first.register, first.voice) : first.class;
      const values = first.expected !== undefined && first.observed !== undefined ? ` is ${hexByte(first.expected)} in the tune and ${hexByte(first.observed)} in the recompiled score` : first.detail ? ` differs (${first.detail})` : " differs";
      if (first.call === 0) lines.push(`Start-up difference: in the first player call after the init (call 0), the ${what}${values}.`);
      else lines.push(`The first difference is at ${first.timeSeconds.toFixed(2)} s (player call ${first.call}): the ${what}${values}.`);
      const cause = LIKELY_CAUSE.get(first.class);
      if (cause) lines.push(`Likely cause: ${cause}${first.call === 0 ? "; at call 0 this is usually the player's start-up writes (register order and values in the init, voices the tune never initialises, the volume ramp)" : ""}.`);
    }
  }
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
  if (reasons.length) lines.push(`Not recovered: ${reasons.join("; ")}.`);
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
