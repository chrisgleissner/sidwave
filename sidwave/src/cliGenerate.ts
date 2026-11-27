// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { EXIT_OK, SidwaveOperationError, UsageError, envelope, type CliIo } from "./cliCore.js";
import { checkOutput, emit, isCharacterDevice, last, parseInteger, parseNumber, runAuthoring, writeOutput } from "./cliAuthoring.js";
import { DEFAULT_COMPOSER2_PROFILES, DEFAULT_MUSIC_SEED, MUSIC_STYLES, generateSidwave, type GenerateOptions, type MusicStyle } from "./audio/generateSidwave.js";
import { PROFILES } from "./compose/profiles.js";
import { formatSidwave } from "./format/sidwaveFormat.js";
import { parseSidwave, noteNameToMidi } from "./sidwave.js";
import { compileSidwaveBytes } from "./sidwaveOps.js";

export const GENERATE_HELP = `sidwave generate: compose a SIDWave score from a style and a seed

Usage:
  sidwave generate [--style <style>] [--seed <n>] [--composer 1|2] [--profile <name>] [--root <note>]
                   [--clock pal|ntsc] [--bars <n> | --minutes <m>] [-o <score>] [--prg <file>] [--sid <file>] [--force]
  sidwave generate --list [--json]

The same options and seed always give the same score. A seed is a whole number; try several and keep the best.

Options:
  --style <name>     chiptune (default), ambient or funk. With composer 2 the style picks the default profile.
  --profile <name>   Composer 2 profile: form, key mode, tempo, groove and instrumentation (see --list). Implies
                     --composer 2.
  --composer 1|2     2 (default) composes with form, harmony, melody, counterpoint and motif development, 8 to
                     36 bars depending on the profile. 1 is the original generator: 8 bars, or --bars/--minutes.
                     --bars and --minutes need --composer 1.
  --seed <n>         Seed (default ${DEFAULT_MUSIC_SEED}).
  --root <note>      Tonic, such as C3 or D3 (default C3; only the pitch class matters for composer 2).
  --clock pal|ntsc   Video standard (default pal).
  --bars <n>         Length in bars, 1 to 512 (needs --composer 1: the length of a composer 2 score follows its
                     profile; use "sidwave complete --op continue" to extend one).
  --minutes <m>      Length in minutes (needs --composer 1), rounded up to whole bars at the tempo of the style.
  --list             List the styles and the composer 2 profiles, and exit.
  -o <file>          Write the score to <file> ("-" is standard output). Without -o the score goes to standard
                     output unless --prg or --sid is given. An existing file needs --force.
  --prg <file>       Also compile the score to a C64 program (the same bytes as "sidwave compile"); "-" is
                     standard output (then the score must go to a file with -o).
  --sid <file>       Also compile the score to a PSID file; "-" is standard output.
  --force            Replace existing output files.
  --json             Machine-readable output.
  -h, --help         Show this text.

Examples:
  sidwave generate --style funk --seed 7 -o funk7.yaml
  sidwave generate --profile soft-arch-lydian --seed 3 --prg tune.prg --sid tune.sid
  sidwave generate --composer 1 --minutes 2 -o long.yaml
  sidwave generate --list

Exit codes: 0 done; 2 usage; 3 a file cannot be written.
`;

const STYLES = Object.keys(MUSIC_STYLES) as MusicStyle[];

function list(io: CliIo, json: boolean): number {
  const styles = STYLES.map((name) => ({ name, tempo: MUSIC_STYLES[name].tempo, composer2Profile: DEFAULT_COMPOSER2_PROFILES[name] }));
  const profiles = PROFILES.map((p) => ({ name: p.name, description: p.description, tempo: p.tempo, mode: p.mode, form: p.form, ending: p.ending }));
  const text = [
    "Styles:",
    ...styles.map((s) => `  ${s.name.padEnd(10)} ${String(s.tempo).padStart(3)} bpm (composer 1); composer 2 default profile ${s.composer2Profile}`),
    "Composer 2 profiles (--profile):",
    ...profiles.map((p) => `  ${p.name.padEnd(24)} ${p.description}`),
  ].join("\n");
  emit(io, json, "generate", { styles, profiles }, text);
  return EXIT_OK;
}

/** `sidwave generate`. `args` excludes the command name. */
export function runGenerateCli(args: string[], io: CliIo): number {
  const value = ["--style", "--seed", "--composer", "--profile", "--root", "--clock", "--bars", "--minutes", "-o", "--prg", "--sid"];
  return runAuthoring("generate", GENERATE_HELP, { value, bool: ["--list", "--force"] }, args, io, (p, { json }) => {
    if (p.positional.length > 0) throw new UsageError(`generate takes no file argument, not "${p.positional[0]}"; use -o <score> for the output`);
    if (p.flags.has("--list")) return list(io, json);
    const styleText = last(p, "--style") ?? "chiptune";
    if (!STYLES.includes(styleText as MusicStyle)) throw new UsageError(`--style must be ${STYLES.join(", ")}, not "${styleText}"; run "sidwave generate --list"`);
    const style = styleText as MusicStyle;
    const profile = last(p, "--profile");
    if (profile !== undefined && !PROFILES.some((x) => x.name === profile)) throw new UsageError(`unknown profile "${profile}"; run "sidwave generate --list" for the names`);
    const composerText = last(p, "--composer");
    if (composerText !== undefined && composerText !== "1" && composerText !== "2") throw new UsageError(`--composer must be 1 or 2, not "${composerText}"`);
    const wantsLength = p.values.has("--bars") || p.values.has("--minutes");
    if (p.values.has("--bars") && p.values.has("--minutes")) throw new UsageError("use --bars or --minutes, not both");
    if (composerText === "1" && profile !== undefined) throw new UsageError("--profile belongs to composer 2; remove --composer 1");
    if (wantsLength && composerText !== "1") {
      throw new UsageError("--bars and --minutes need --composer 1: the length of a composer 2 score follows its profile. Add --composer 1, or extend a composed score with \"sidwave complete <score> --op continue --bars <n>\"");
    }
    const composer: 1 | 2 = composerText === "1" ? 1 : 2;
    const seed = last(p, "--seed") === undefined ? DEFAULT_MUSIC_SEED : parseInteger("--seed", last(p, "--seed")!, 0, 0xffffffff);
    const root = last(p, "--root") ?? "C3";
    if (noteNameToMidi(root) === undefined) throw new UsageError(`--root needs a note name such as C3 or F#2, not "${root}"`);
    const clock = (last(p, "--clock") ?? "pal").toLowerCase();
    if (clock !== "pal" && clock !== "ntsc") throw new UsageError(`--clock must be pal or ntsc, not "${last(p, "--clock")}"`);

    const options: GenerateOptions = { composer, root, preset: "classic", style, seed, system: clock === "ntsc" ? "NTSC" : "PAL" };
    if (profile !== undefined) options.profile = profile;
    const minutesValue = () => {
      const minutes = parseNumber("--minutes", last(p, "--minutes")!);
      if (minutes <= 0) throw new UsageError(`--minutes must be greater than 0, not "${last(p, "--minutes")}"`);
      return minutes;
    };
    if (wantsLength) {
      const tempo = MUSIC_STYLES[style].tempo;
      const bars = p.values.has("--bars")
        ? parseInteger("--bars", last(p, "--bars")!, 1, 512)
        : Math.max(1, Math.ceil(minutesValue() * 60 * tempo / 240 - 1e-9));
      if (bars > 512) throw new UsageError(`${bars} bars is more than the limit of 512 bars`);
      // The version 1 generator plays eight bars with a repeated hook; another length is a walk of eighth notes.
      if (bars !== 8) options.steps = bars * 8;
    }

    const generated = generateSidwave(options);
    const text = formatSidwave(YAML.stringify(generated.score));
    const prgFile = last(p, "--prg"), sidFile = last(p, "--sid"), scoreFile = last(p, "-o");
    const force = p.flags.has("--force");
    const scoreToStdout = scoreFile === "-" || (scoreFile === undefined && prgFile === undefined && sidFile === undefined);
    if (prgFile === "-" && sidFile === "-") throw new UsageError("--prg - and --sid - cannot both write to standard output");
    if ((prgFile === "-" || sidFile === "-") && scoreToStdout) throw new UsageError("the score and a binary cannot both go to standard output; write the score with -o <file>");
    // Check every output before the first write, so that a refusal leaves no partial output.
    const targets = [scoreToStdout ? undefined : scoreFile, prgFile, sidFile].filter((f): f is string => f !== undefined && f !== "-");
    for (const target of targets) checkOutput(io, target, { force });
    if (new Set(targets.map((t) => resolve(io.cwd, t))).size !== targets.length) throw new UsageError("two outputs name the same file");
    for (const target of targets) {
      const path = resolve(io.cwd, target);
      if (target === "-" || isCharacterDevice(path)) continue;
      // The directory is created when it is missing, so the nearest existing parent must be writable.
      let dir = dirname(path);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      try { accessSync(dir, constants.W_OK); } catch {
        throw new SidwaveOperationError("input", `cannot write ${target}: the directory ${dir} is not writable`, { file: path });
      }
    }
    // Compile before anything is written, so that a failure leaves no partial output.
    const doc = prgFile !== undefined || sidFile !== undefined ? parseSidwave(text) : undefined;
    const compiled: Array<{ kind: "prg" | "sid"; file: string; bytes: Uint8Array; seconds: number }> = [];
    for (const [kind, file] of [["prg", prgFile], ["sid", sidFile]] as const) {
      if (file === undefined) continue;
      const { bytes, summary } = compileSidwaveBytes(doc!, { format: kind });
      compiled.push({ kind, file, bytes, seconds: summary.durationSeconds });
    }
    const outputs: Array<{ kind: string; path: string; bytes: number }> = [];
    if (!scoreToStdout && scoreFile !== undefined) {
      const path = writeOutput(io, scoreFile, text, { force });
      outputs.push({ kind: "score", path, bytes: Buffer.byteLength(text) });
    }
    for (const c of compiled) {
      if (c.file === "-") { io.outBytes(c.bytes); outputs.push({ kind: c.kind, path: "-", bytes: c.bytes.length }); }
      else outputs.push({ kind: c.kind, path: writeOutput(io, c.file, c.bytes, { force }), bytes: c.bytes.length });
    }

    const meter = "profile" in generated ? generated.profile.meter : 4;
    const seconds = generated.bars * meter * 60 / generated.tempo;
    const usedProfile = "profile" in generated ? generated.profile.name : undefined;
    const warnings = [...("warnings" in generated ? generated.warnings : [])];
    const result = {
      style, seed, composer, profile: usedProfile ?? null, root, clock, key: generated.key, tempo: generated.tempo, bars: generated.bars,
      seconds: Math.round(seconds * 10) / 10, outputs, warnings, ...(scoreToStdout && json ? { text } : {}),
    };
    const minutes = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
    const line = `${style} seed ${seed}, composer ${composer}${usedProfile ? ` (${usedProfile})` : ""}: ${generated.key}, ${generated.tempo} bpm, ${generated.bars} bars, about ${minutes}`
      + `${outputs.length ? `; wrote ${outputs.map((o) => o.path).join(", ")}` : ""}`;
    const report = [line, ...warnings.map((w) => `note: ${w}`)].join("\n");
    const binaryToStdout = prgFile === "-" || sidFile === "-";
    if (binaryToStdout) io.err(`${json ? JSON.stringify(envelope("generate", true, { result }), null, 2) : report}\n`);
    else if (scoreToStdout && !json) {
      io.out(text);
      io.err(`${report}\n`);
    } else emit(io, json, "generate", result, report);
    return EXIT_OK;
  });
}
