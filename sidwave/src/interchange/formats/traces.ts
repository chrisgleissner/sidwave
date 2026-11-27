// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Register traces in the convert registry: VICE dump (read by reconstruct, write by tracing the compiled score)
// and siddump (read by reconstruct). Wraps parseViceDump, parseSiddump, reconstructFromTrace and exportViceDump.

import { createLibsidplayfpEngine } from "../../engine/libsidplayfp.js";
import { compileSidwaveBytes } from "../../sidwaveOps.js";
import { reconstructLosses } from "../builtinFormats.js";
import { InterchangeUsageError } from "../errors.js";
import type { FormatDefinition, ReadContext } from "../formatTypes.js";
import { exportViceDump, parseSiddump, parseViceDump, type ImportedTrace } from "../traceInput.js";
import { reconstructFromTrace } from "../traceReconstruct.js";
import type { Loss } from "../loss.js";

const text = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(4096, bytes.length)).toString("latin1");

async function readTrace(parse: (b: Uint8Array, clock: "PAL" | "NTSC") => ImportedTrace, bytes: Uint8Array, ctx: ReadContext) {
  let trace: ImportedTrace;
  try { trace = parse(bytes, ctx.mode ?? "PAL"); } catch (error) {
    if (error instanceof RangeError) throw new InterchangeUsageError(error.message);
    throw error;
  }
  ctx.notice?.("Reading a register trace recovers the score from the writes; the result is approximate and slower than other formats.");
  const engine = ctx.createEngine ? ctx.createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
  let result;
  try {
    result = await reconstructFromTrace(trace, { engine, ...(ctx.seconds === undefined ? {} : { seconds: ctx.seconds }), ...(ctx.title === undefined ? {} : { title: ctx.title }) });
  } catch (error) {
    if (error instanceof RangeError || (error instanceof Error && error.constructor === Error)) throw new InterchangeUsageError(`cannot recover a score from ${ctx.name}: ${(error as Error).message}`);
    throw error;
  }
  const losses: Loss[] = reconstructLosses(result.report, `the ${trace.format} trace`);
  if (trace.approximate) losses.push({ stage: "read", code: "trace.approximate", severity: "approx", count: 1, message: "siddump samples the registers once per frame: the order and cycles of writes inside a frame are invented, so hard restarts and short gate pulses are lost." });
  if (trace.ignoredWrites) losses.push({ stage: "read", code: "trace.ignored", severity: "info", count: trace.ignoredWrites, message: `${trace.ignoredWrites} writes to register offsets 25 to 31 are not part of a SID and were ignored.` });
  return { yaml: result.score, losses, report: result.report, approximate: true, fdiff: { equal: result.report.strictExact, differingCalls: result.report.fdiff.differingCalls, comparedCalls: result.report.fdiff.comparedCalls } };
}

export const VICE_DUMP: FormatDefinition = {
  writeNeedsEngine: true, id: "vice-dump", name: "VICE register dump", extensions: [".dump"], aliases: ["vice"],
  magic: (bytes) => {
    const head = text(bytes);
    if (/^(PSID|RSID)/.test(head)) return 0;
    return /^\d+ \d+ \d+\r?\n\d+ \d+ \d+/.test(head) ? 0.9 : 0;
  },
  detection: "lines of three decimal numbers (cycle delta, register, value)",
  caps: { kind: "trace", tempo: "exact", instruments: "none", expression: "exact", loop: false, metadata: false },
  lossSummary: "read: approximate (reconstruct from the writes; a dump has no chip number, so several SIDs merge into one); write: exact writes with the engine's cycle numbers, one SID only",
  readIsApproximate: true,
  read: (bytes, ctx) => readTrace((b, clock) => parseViceDump(b, { clock }), bytes, ctx),
  write: async ({ doc, song, seconds, createEngine, signal }) => {
    const compiled = compileSidwaveBytes(doc, { format: "sid", loop: false, song });
    const length = seconds ?? Math.min(600, Math.max(1, Math.ceil(compiled.summary.durationSeconds)));
    const engine = createEngine ? createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
    const trace = await engine.trace({ sid: new Uint8Array(compiled.bytes), seconds: length, clock: doc.song.mode === "NTSC" ? "NTSC" : "PAL", ...(signal ? { signal } : {}) });
    const kept: number[] = [];
    for (let i = 0; i < trace.records.length; i += 4) {
      if (trace.records[i + 3]! > trace.horizonCycles) break;
      kept.push(trace.records[i]!, trace.records[i + 1]!, trace.records[i + 2]!, trace.records[i + 3]!);
    }
    const used = [...new Set(kept.filter((_, i) => i % 4 === 0))].sort((x, y) => x - y);
    for (let i = 0; i < kept.length; i += 4) kept[i] = used.indexOf(kept[i]!);
    const dump = exportViceDump(kept);
    return { bytes: dump, losses: [{ stage: "write", code: "trace.cycles", severity: "info", count: 1, message: "Cycle numbers are those of SIDWave's engine; a real VICE run of the same SID file starts with its own power-on delay." }], report: { writes: kept.length / 4, seconds: length } };
  },
  describe: (bytes) => { const t = parseViceDump(bytes); return { writes: t.count, sids: t.sidCount, ignoredWrites: t.ignoredWrites, cycles: t.horizonCycles }; },
};

export const SIDDUMP: FormatDefinition = {
  id: "siddump", name: "siddump table", extensions: [".siddump"],
  magic: (bytes) => { const head = text(bytes); return /^\|.*\|/m.test(head) && /Frame|^\|\s*\d+\s*\|/m.test(head) ? 0.9 : 0; },
  detection: "a table whose rows start with | and have a Frame column",
  caps: { kind: "trace", tempo: "exact", instruments: "none", expression: "exact", loop: false, metadata: false },
  lossSummary: "read only: approximate (one sample per frame; the order and cycle of writes inside a frame are invented)",
  readIsApproximate: true,
  read: (bytes, ctx) => readTrace((b, clock) => parseSiddump(b, { clock }), bytes, ctx),
  describe: (bytes) => { const t = parseSiddump(bytes); return { writes: t.count, cycles: t.horizonCycles, approximate: true }; },
};
