// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import YAML from "yaml";
import { EXIT_OK, SidwaveOperationError, UsageError, classifyError, envelope, EXIT_CODES, type CliIo } from "./cliCore.js";
import { confinedReadOptions } from "./sidwaveOps.js";
import { completeScore, type CompleteOp, type CompleteOptions } from "./compose/complete.js";

export const COMPLETE_HELP = `sidwave complete: add to an existing SIDWave score without touching what plays

Usage:
  sidwave complete <score> --op continue     --bars <n> [options]
  sidwave complete <score> --op harmonise    --voice <id> --target <id> [--style arp|line] [--instrument <inst>] [options]
  sidwave complete <score> --op accompany    [--bass <id>] [--drums <id>] [--instrument <inst>] [options]
  sidwave complete <score> --op fill-section --section <name> [--bars <n>] [--after <name> | --at <n>] [options]

Operations:
  continue      Append a section of <n> bars in the key, tempo and instruments of the score, with the motif of its last section.
  harmonise     Infer chords from the melody voice and play them on a free voice, as a chord arpeggio or a counter line.
  accompany     Add a bass line and/or percussion on free voices, from chords inferred from the playing voices.
  fill-section  Generate the named section when its timeline entry is empty, or add it when it is missing (at the end
                unless --after or --at is given; inserting before later material needs a length that moves it by a whole
                number of player calls).

Every voice and timeline entry that the operation does not target keeps its SID register writes. A target voice that
plays already is refused. Unless --no-verify is given, both scores are run on a register-write 6502 interpreter and the
register writes of every protected voice are compared call by call; a difference stops the command and writes nothing.
Two things are not compared, and the output names them: when new entries follow the original ones (continue, and
fill-section at the end) the ring-out tail of the original (the calls after its last entry, with "end") is not compared,
because it no longer follows the last original entry; and in the last hard-restart-plus-one calls of a voice's section
that the voice continues, the comparison ends where either score first clears the voice's gate, because the next attack's
hard restart (gate off, zero envelope, the next note's frequency and pulse width) is written there.

Options:
  -o <file>        Output file (default <score>.completed.yaml in the current directory); "-o -" writes to standard output.
  --force          Overwrite the output file.
  --seed <n>       Seed for the generated material (default 1); the same input, operation and seed give the same bytes.
  --allow-dir <dir>  Allow "file:" sample sources below <dir>; without it they must lie below the current directory. May be repeated.
  --no-verify      Skip the register comparison.
  --json           Machine-readable output.
`;

const VALUE = new Set(["--op", "--bars", "--voice", "--target", "--bass", "--drums", "--section", "--after", "--at", "--seed", "--style", "--instrument", "--allow-dir", "-o", "--output"]);

function int(flag: string, text: string, min: number): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) < min) throw new UsageError(`${flag} needs a whole number of at least ${min}, not "${text}"`);
  return Number(text);
}

/** `sidwave complete`. Everything after the command name is in `args`. */
export function runCompleteCli(args: string[], io: CliIo): number {
  const json = args.includes("--json");
  try {
    const values: Record<string, string> = {};
    const positional: string[] = [];
    let force = false;
    let verify = true;
    const allowDirs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      let arg = args[i]!;
      let inline: string | undefined;
      if (arg.startsWith("--") && arg.includes("=")) { inline = arg.slice(arg.indexOf("=") + 1); arg = arg.slice(0, arg.indexOf("=")); }
      if (arg === "-h" || arg === "--help") { io.out(COMPLETE_HELP); return EXIT_OK; }
      if (VALUE.has(arg)) {
        const value = inline ?? args[++i];
        if (value === undefined) throw new UsageError(`${arg} needs a value`);
        if (arg === "--allow-dir") allowDirs.push(value);
        else values[arg === "--output" ? "-o" : arg] = value;
      } else if (arg === "--json") { /* handled above */ }
      else if (arg === "--force") force = true;
      else if (arg === "--no-verify") verify = false;
      else if (arg !== "-" && arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
      else positional.push(arg);
    }
    if (positional.length !== 1) throw new UsageError("complete needs exactly one score file");
    const op = values["--op"];
    if (!op || !["continue", "harmonise", "accompany", "fill-section"].includes(op)) throw new UsageError("complete needs --op continue, harmonise, accompany or fill-section");
    const options: CompleteOptions = { verify, readOptions: confinedReadOptions(io.cwd, allowDirs) };
    if (values["--bars"] !== undefined) options.bars = int("--bars", values["--bars"], 1);
    if (values["--voice"] !== undefined) options.voice = int("--voice", values["--voice"], 1);
    if (values["--target"] !== undefined) options.target = int("--target", values["--target"], 1);
    if (values["--bass"] !== undefined) options.bass = int("--bass", values["--bass"], 1);
    if (values["--drums"] !== undefined) options.drums = int("--drums", values["--drums"], 1);
    if (values["--at"] !== undefined) options.at = int("--at", values["--at"], 1);
    if (values["--seed"] !== undefined) options.seed = int("--seed", values["--seed"], 0);
    if (values["--section"] !== undefined) options.section = values["--section"];
    if (values["--after"] !== undefined) options.after = values["--after"];
    if (values["--instrument"] !== undefined) options.instrument = values["--instrument"];
    if (values["--style"] !== undefined) {
      if (values["--style"] !== "arp" && values["--style"] !== "line") throw new UsageError(`--style must be arp or line, not ${values["--style"]}`);
      options.style = values["--style"];
    }
    const file = positional[0]!;
    const path = resolve(io.cwd, file);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (error) {
      throw new SidwaveOperationError("input", `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file });
    }
    let result;
    try { result = completeScore(text, op as CompleteOp, options); } catch (error) {
      const report = classifyError(error);
      if (report.category === "validation") throw new SidwaveOperationError("validation", report.message, { ...report.details, file }, { cause: error });
      throw error;
    }
    const output = YAML.stringify(result.score);
    const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
    const toStdout = values["-o"] === "-";
    const outPath = toStdout ? undefined : resolve(io.cwd, values["-o"] ?? `${stem}.completed.yaml`);
    if (outPath !== undefined) {
      const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
      if (real(outPath) === real(path)) throw new UsageError("the output file is the input file; refusing to overwrite it");
      if (existsSync(outPath) && !force) throw new UsageError(`${outPath} exists; use --force to overwrite it`);
      try { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, output); } catch (error) {
        throw new SidwaveOperationError("input", `cannot write ${outPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: outPath });
      }
    } else io.out(output);
    const summary = {
      file, output: outPath ?? null, op, targets: result.targets, entries: result.entries.map((i) => i + 1), addedBars: result.addedBars,
      protected: result.protected ?? null,
    };
    const line = `${outPath ?? "standard output"}: ${op}, voices ${result.targets.join(",")}, ${result.addedBars} bars added`
      + (result.protected ? `, protected material identical over ${result.protected.cellsCompared} voice sections (${result.protected.callsCompared} player calls)`
        + (result.protected.unprotectedTail ? `; not compared: ring-out tail, calls ${result.protected.unprotectedTail.fromCall}-${result.protected.unprotectedTail.toCall - 1}` : "") : ", protected material not verified");
    const message = json ? `${JSON.stringify(envelope("complete", true, { result: summary }), null, 2)}\n` : `${line}\n`;
    if (toStdout) io.err(message); else io.out(message);
    return EXIT_OK;
  } catch (error) {
    const report = classifyError(error);
    if (json) io.out(`${JSON.stringify(envelope("complete", false, { error: report }), null, 2)}\n`);
    else if (report.category === "usage") io.err(`sidwave: ${report.message}\nRun "sidwave complete --help" for usage.\n`);
    else if (report.category === "validation" && typeof report.details.file === "string") io.err(`${report.details.file}: ${report.message}\n`);
    else io.err(`sidwave: ${report.message}\n`);
    return EXIT_CODES[report.category];
  }
}
