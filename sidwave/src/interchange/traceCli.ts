// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Command line of the trace formats: `sidwave reconstruct <trace> --from vice-dump|siddump` and
// `sidwave export <score> --format vice-dump`.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT_FAILED, EXIT_OK, UsageError, envelope, type CliIo } from "../cliCore.js";
import { createLibsidplayfpEngine } from "../engine/libsidplayfp.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes, confinedReadOptions } from "../sidwaveOps.js";
import { withFile } from "../cliCore.js";
import { InterchangeUsageError } from "./errors.js";
import { MAX_INPUT_BYTES, numberFlag, parseFlags, readBounded, registerAsyncExporter, writeOutput } from "./cli.js";
import { exportViceDump, parseSiddump, parseViceDump, TRACE_CLOCK_HZ, type TraceClock } from "./traceInput.js";
import { reconstructFromTrace } from "./traceReconstruct.js";

export const TRACE_INPUT_FORMATS = ["vice-dump", "siddump"] as const;

/** Detects a trace file from its first bytes: a VICE dump (three decimal numbers per line) or a siddump table (rows starting with `|`). */
export function detectTraceFormat(bytes: Uint8Array): "vice-dump" | "siddump" | undefined {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  if (/^(PSID|RSID)/.test(head)) return undefined;
  if (/^\d+ \d+ \d+\r?\n/.test(head)) return "vice-dump";
  if (/^\|.*\|/m.test(head) && /Frame|^\|\s*\d+\s*\|/m.test(head)) return "siddump";
  return undefined;
}

/** True when `sidwave reconstruct` was given a trace file instead of a SID file (no --from needed). */
export function isTraceInput(args: string[], cwd: string): boolean {
  const file = args.find((a) => !a.startsWith("-"));
  if (file === undefined) return false;
  try {
    const path = resolve(cwd, file);
    if (statSync(path).size > MAX_INPUT_BYTES) return false;
    return detectTraceFormat(readFileSync(path).subarray(0, 4096)) !== undefined;
  } catch { return false; }
}

function clockFlag(a: ReturnType<typeof parseFlags>): TraceClock {
  const value = a.flags.get("--clock");
  if (value === undefined) return "PAL";
  if (value !== "PAL" && value !== "NTSC") throw new UsageError("--clock must be PAL or NTSC");
  return value;
}

/** `sidwave reconstruct <trace-file> [--from vice-dump|siddump] [--clock PAL|NTSC] [--seconds s] [--title t] [-o score.yaml] [--json]`. */
export async function reconstructFromTraceCommand(args: string[], io: CliIo): Promise<number> {
  const a = parseFlags(args, ["--from", "--clock", "--seconds", "--title", "-o", "--output"], ["--json", "--force"]);
  if (a.positional.length !== 1) throw new UsageError("reconstruct --from needs exactly one trace file");
  const file = a.positional[0]!;
  const { bytes, path: inputPath } = readBounded(io, file);
  const from = a.flags.get("--from") ?? detectTraceFormat(bytes);
  if (from === undefined) throw new UsageError(`cannot tell the format of ${file}; pass --from vice-dump (lines of "cycles register value", from vsid -sounddev dump) or --from siddump (a table printed by siddump), or use "sidwave reconstruct" on a .sid file`);
  if (!(TRACE_INPUT_FORMATS as readonly unknown[]).includes(from)) throw new UsageError(`--from must be ${TRACE_INPUT_FORMATS.join(" or ")}, not ${String(from)}`);
  const seconds = numberFlag(a, "--seconds");
  if (seconds !== undefined && !(seconds > 0 && seconds <= 600)) throw new UsageError("--seconds must be above 0 and at most 600");
  const clock = clockFlag(a);
  let trace;
  try { trace = from === "vice-dump" ? parseViceDump(bytes, { clock }) : parseSiddump(bytes, { clock }); } catch (error) {
    if (error instanceof InterchangeUsageError) {
      const other = detectTraceFormat(bytes);
      throw new InterchangeUsageError(`${error.message}${other && other !== from ? `; the file looks like a ${other}, pass --from ${other}` : from === "vice-dump" ? "; expected lines of \"<cycles> <register> <value>\" as written by vsid -sounddev dump" : "; expected the table printed by siddump (| Frame | Freq Note/Abs WF ADSR Pul | ...)"}`);
    }
    throw error;
  }
  const engine = io.createEngine ? io.createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
  let result;
  try {
    result = await reconstructFromTrace(trace, { engine, ...(seconds === undefined ? {} : { seconds }), ...(typeof a.flags.get("--title") === "string" ? { title: a.flags.get("--title") as string } : {}) });
  } catch (error) {
    if (error instanceof RangeError) throw new InterchangeUsageError(error.message);
    throw error;
  }
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
  const target = output === undefined || output === "-" ? undefined : writeOutput(io, inputPath, output, result.score);
  const ok = result.report.strictExact;
  const json = a.flags.has("--json");
  if (json) io.out(`${JSON.stringify(envelope("reconstruct", ok, { result: { file, from, output: target ?? null, score: result.score, trace: result.trace, report: result.report } }), null, 2)}\n`);
  else {
    if (!target) io.out(result.score);
    for (const warning of result.trace.warnings) io.err(`warning: ${warning}\n`);
    const r = result.report;
    io.err(`${target ? `${target}: ` : ""}${from} trace of ${result.trace.writes} writes, horizon ${r.horizon.seconds} s (${r.horizon.calls} calls), ${r.recovery.noteCount} notes, strict ${r.strictExact ? "exact" : "not exact"}, register state ${r.registerStateExact ? "exact" : "differs"}\n`);
  }
  return ok ? EXIT_OK : EXIT_FAILED;
}

/** `sidwave export <score> --format vice-dump`: the SID writes of the compiled score, as VICE's `-sounddev dump` writes them. */
async function exportViceDumpCommand(file: string, a: ReturnType<typeof parseFlags>, io: CliIo, json: boolean): Promise<number> {
  const { bytes, path } = readBounded(io, file);
  const song = numberFlag(a, "--song");
  const requested = numberFlag(a, "--seconds");
  const doc = withFile(file, () => parseSidwave(bytes.toString("utf8"), confinedReadOptions(io.cwd, a.allowDirs)));
  const compiled = compileSidwaveBytes(doc, { format: "sid", loop: false, ...(song === undefined ? {} : { song }) });
  const seconds = requested ?? Math.min(600, Math.max(1, Math.ceil(compiled.summary.durationSeconds)));
  if (!(seconds > 0 && seconds <= 600)) throw new UsageError("--seconds must be above 0 and at most 600");
  const engine = io.createEngine ? io.createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
  const trace = await engine.trace({ sid: new Uint8Array(compiled.bytes), seconds, clock: doc.song.mode === "NTSC" ? "NTSC" : "PAL" });
  const horizon = trace.horizonCycles;
  const kept: number[] = [];
  for (let i = 0; i < trace.records.length; i += 4) {
    if (trace.records[i + 3]! > horizon) break;
    // The engine numbers the chips of a tune from 1 when it was started with an explicit song; VICE numbers them from 0.
    kept.push(trace.records[i]!, trace.records[i + 1]!, trace.records[i + 2]!, trace.records[i + 3]!);
  }
  const used = [...new Set(kept.filter((_, i) => i % 4 === 0))].sort((x, y) => x - y);
  for (let i = 0; i < kept.length; i += 4) kept[i] = used.indexOf(kept[i]!);
  const text = exportViceDump(kept);
  const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
  const clockHz = TRACE_CLOCK_HZ[trace.clock];
  if (output === undefined || output === "-") {
    if (json) io.out(`${JSON.stringify(envelope("export", true, { result: { file, format: "vice-dump", writes: kept.length / 4, seconds, dump: text } }), null, 2)}\n`);
    else io.out(text);
    return EXIT_OK;
  }
  const written = writeOutput(io, path, output, text);
  const result = { file, format: "vice-dump", output: written, bytes: text.length, writes: kept.length / 4, seconds, clock: trace.clock, clockHz, losses: ["Cycle numbers are those of SIDWave's engine; a real VICE run of the same SID file starts with its own power-on delay."] };
  io.out(json ? `${JSON.stringify(envelope("export", true, { result }), null, 2)}\n` : `${written}: VICE dump, ${kept.length / 4} writes, ${text.length} bytes\n`);
  return EXIT_OK;
}

registerAsyncExporter("vice-dump", exportViceDumpCommand);
