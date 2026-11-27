// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { EXIT_OK, SidwaveOperationError, UsageError, type CliIo } from "./cliCore.js";
import {
  emit, last, parseInteger, parseNumber, readText, runAuthoring, splitList, writeOutput, type ParsedFlags,
} from "./cliAuthoring.js";
import { confinedReadOptions } from "./sidwaveOps.js";
import {
  SidwaveTransformError, humanise, quantise, restructure, scaleTempo, setTempo, substituteInstrument, transpose,
  type TransformOptions, type TransformReport, type TransformResult,
} from "./transform/index.js";

export const TRANSFORM_HELP = `sidwave transform: change a SIDWave score and report what changed

Usage:
  sidwave transform <score> <operation>... [-o <out>] [--force] [--json] [--allow-dir <dir>]

Operations (one or more; they are applied in the order given):
  --transpose <n>            Shift every pitched note and chord by <n> semitones (negative shifts down). Drums are not
                             moved. A note that would leave the SID's range is an error that names its path.
      --voice <id|name>,...      Only these voices (transpose and humanise).
      --section <name>,...       Only the patterns that these sections play (transpose); a pattern that is also
                                 played outside them is an error.
  --tempo <bpm>              Set the tempo.
  --tempo-factor <f>         Multiply the tempo by <f> (1.25 is 25 % faster).
  --swap-instrument <a>=<b>  Replace every use of instrument <a> by <b> (an instrument of the score or lib:<name>).
                             May be repeated. Only the instrument: and inst: fields are rewritten, not the @name
                             suffixes inside groove strings.
  --quantise <grid>          Round every explicit note length to a multiple of <grid> beats (0.25 is a sixteenth note,
                             a beat is a quarter note). Each bar keeps its length. (Also --quantize.)
  --humanise <max>           Vary note lengths by at most <max> beats, deterministically for --seed (default 1).
                             Pitches and bar lengths are kept. (Also --humanize.)
      --seed <n>                 Seed of --humanise.
  --order <a>,<b>,...        Set the timeline to the named sections, in this order (repeats allowed).

Every result is formatted canonically and is parsed and compiled again before it is written; a result that does not
compile is never written. Without -o the transformed score goes to standard output and an existing file is never
touched. The report says what changed: the number of values and their paths (--json lists all of them), what was
preserved, and warnings for parts that were left alone.

Options:
  -o <file>          Write the score to <file>. An existing file needs --force (also when it is the input file).
  --force            Replace an existing -o file.
  --validate <level> What to check on the result: compile (default; parse and compile it, which also finds a
                     result that is valid but cannot be compiled, such as a bend that no longer fits a faster
                     tempo) or parse (parse only; several times faster on a large score).
  --allow-dir <dir>  Allow "file:" sources and library files below <dir>. May be repeated.
  --json             Machine-readable output; without -o the score is in result.text.
  -h, --help         Show this text.

Examples:
  sidwave transform song.yaml --transpose 2 -o song-d.yaml
  sidwave transform song.yaml --transpose -5 --voice 3 --tempo 140 -o out.yaml
  sidwave transform song.yaml --swap-instrument lib:lead_pwm=lib:sync_lead --quantise 0.25
  sidwave transform song.yaml --order intro,verse,chorus,verse,chorus -o long.yaml

Exit codes: 0 done; 2 usage; 3 unreadable or invalid score, or a transformation that cannot be applied.
`;

interface Step { op: string; param: unknown; run: (text: string, options: TransformOptions) => TransformResult }

function buildSteps(p: ParsedFlags): Step[] {
  const voices = splitList(last(p, "--voice") ?? "");
  const sections = splitList(last(p, "--section") ?? "");
  const seed = last(p, "--seed") === undefined ? 1 : parseInteger("--seed", last(p, "--seed")!, 0, 0xffffffff);
  const steps: Step[] = [];
  for (const [flag, value] of p.order) {
    switch (flag) {
      case "--transpose": {
        const semitones = parseInteger(flag, value, -96, 96);
        steps.push({ op: "transpose", param: { semitones, ...(voices.length ? { voices } : {}), ...(sections.length ? { sections } : {}) },
          run: (text, options) => transpose(text, { ...options, semitones, ...(voices.length || sections.length ? { scope: { ...(voices.length ? { voices } : {}), ...(sections.length ? { sections } : {}) } } : {}) }) });
        break;
      }
      case "--tempo": {
        const bpm = parseNumber(flag, value);
        steps.push({ op: "tempo", param: { bpm }, run: (text, options) => setTempo(text, { ...options, bpm }) });
        break;
      }
      case "--tempo-factor": {
        const factor = parseNumber(flag, value);
        steps.push({ op: "tempo-factor", param: { factor }, run: (text, options) => scaleTempo(text, { ...options, factor }) });
        break;
      }
      case "--swap-instrument": {
        const at = value.indexOf("=");
        if (at < 1 || at === value.length - 1) throw new UsageError(`--swap-instrument needs <from>=<to>, for example lib:lead_pwm=lib:sync_lead, not "${value}"`);
        const from = value.slice(0, at), to = value.slice(at + 1);
        steps.push({ op: "swap-instrument", param: { from, to }, run: (text, options) => substituteInstrument(text, { ...options, from, to }) });
        break;
      }
      case "--quantise": {
        const grid = parseNumber(flag, value);
        steps.push({ op: "quantise", param: { grid }, run: (text, options) => quantise(text, { ...options, grid }) });
        break;
      }
      case "--humanise": {
        const maxShift = parseNumber(flag, value);
        steps.push({ op: "humanise", param: { maxShift, seed, ...(voices.length ? { voices } : {}) },
          run: (text, options) => humanise(text, { ...options, seed, maxShift, ...(voices.length ? { scope: { voices } } : {}) }) });
        break;
      }
      case "--order": {
        const order = splitList(value);
        if (order.length === 0) throw new UsageError("--order needs section names separated by commas, for example intro,verse,chorus");
        steps.push({ op: "order", param: { order }, run: (text, options) => restructure(text, { ...options, order }) });
        break;
      }
      default: break;
    }
  }
  return steps;
}

const HINTS: Record<string, string> = {
  out_of_range: "Use a smaller value, or limit the change with --voice or --section.",
  unsupported: "Limit the change with --voice or --section, or edit that part by hand.",
};

/** `sidwave transform`. `args` excludes the command name. */
export function runTransformCli(args: string[], io: CliIo): number {
  const value = ["-o", "--allow-dir", "--validate", "--transpose", "--voice", "--section", "--tempo", "--tempo-factor", "--swap-instrument", "--quantise", "--quantize", "--humanise", "--humanize", "--seed", "--order"];
  const alias = { "--quantize": "--quantise", "--humanize": "--humanise" };
  return runAuthoring("transform", TRANSFORM_HELP, { value, bool: ["--force"], alias }, args, io, (p, { json }) => {
    if (p.positional.length !== 1) throw new UsageError("transform needs exactly one score file");
    const file = p.positional[0]!;
    const steps = buildSteps(p);
    if (steps.length === 0) throw new UsageError("transform needs an operation: --transpose, --tempo, --tempo-factor, --swap-instrument, --quantise, --humanise or --order");
    const ops = new Set(steps.map((s) => s.op));
    if (p.values.has("--voice") && !ops.has("transpose") && !ops.has("humanise")) throw new UsageError("--voice applies to --transpose and --humanise only");
    if (p.values.has("--section") && !ops.has("transpose")) throw new UsageError("--section applies to --transpose only");
    if (p.values.has("--seed") && !ops.has("humanise")) throw new UsageError("--seed applies to --humanise only");
    const output = last(p, "-o");
    const level = last(p, "--validate") ?? "compile";
    if (level !== "compile" && level !== "parse") throw new UsageError(`--validate must be compile or parse, not "${level}"`);
    const { text: input, path } = readText(io, file);
    const read = confinedReadOptions(io.cwd, p.values.get("--allow-dir") ?? [], path);

    let text = input;
    const reports: Array<{ op: string; param: unknown } & TransformReport> = [];
    try {
      steps.forEach((step, index) => {
        // The first step checks the input, the last one the final result (compiled with --validate compile).
        // The steps between need no check of their own: each reads the previous result and the last step checks the end.
        const first = index === 0, final = index === steps.length - 1;
        const validate = steps.length === 1 ? level : first ? "parse" : final ? (level === "compile" ? "result" : "none") : "none";
        const result = step.run(text, { validate, read });
        text = result.text;
        reports.push({ op: step.op, param: step.param, ...result.report });
      });
    } catch (error) {
      if (error instanceof SidwaveTransformError) {
        const hint = HINTS[error.code];
        throw new SidwaveOperationError("validation", `${error.message}${hint ? `. ${hint}` : ""}`, { file, code: error.code }, { cause: error });
      }
      throw error;
    }

    const total = reports.reduce((sum, r) => sum + r.changed.length, 0);
    const warnings = reports.flatMap((r) => r.warnings.map((w) => `${r.op}: ${w}`));
    const summary = `${total === 0 ? "nothing changed" : `${total} value${total === 1 ? "" : "s"} changed`}: ${reports.map((r) => `${r.op} ${r.changed.length}`).join(", ")}`;
    const textOut = [summary, ...warnings.map((w) => `warning: ${w}`)].join("\n");
    const toStdout = output === undefined || output === "-";
    const outPath = toStdout ? null : writeOutput(io, output!, text, { force: p.flags.has("--force"), inputs: [path] });
    const result = { file, output: outPath, changed: total, steps: reports, ...(toStdout && json ? { text } : {}) };
    if (toStdout && !json) {
      io.out(text);
      io.err(`${textOut}\n`);
    } else emit(io, json, "transform", result, `${outPath}: ${textOut}`);
    return EXIT_OK;
  });
}
