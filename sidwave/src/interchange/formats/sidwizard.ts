// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID-Wizard module (.swm, .sws) in the convert registry. Wraps importSwm and exportSwm.

import { sidwaveFrameRate } from "../../sidwaveCompiler.js";
import { InterchangeUsageError } from "../errors.js";
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { parseSwm } from "../swm.js";
import { importSwm } from "../swmImport.js";
import { exportSwm } from "../swmExport.js";
import { warningLosses } from "../builtinFormats.js";

const head = (b: Uint8Array, from: number, to: number): string => Buffer.from(b.buffer, b.byteOffset + Math.min(from, b.length), Math.max(0, Math.min(to, b.length) - from)).toString("latin1");

export const SID_WIZARD: FormatDefinition = {
  id: "sidwizard", name: "SID-Wizard module", extensions: [".swm", ".sws"], aliases: ["swm", "sws", "sid-wizard"], songs: true,
  magic: (bytes) => (["SWM1", "SWMS"].includes(head(bytes, 2, 6)) ? 1 : 0),
  detection: "the identifier SWM1 or SWMS at offset 2",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "none", loop: true, metadata: true },
  lossSummary: "export: up to three pitched voices of one SID, no drums, vibrato, tables or tempo changes; import: vibrato, chords and most effects are not read; .swi instruments are not handled by convert",
  read: (bytes, ctx) => {
    const result = importSwm(bytes, { ...(ctx.song === undefined ? {} : { subtune: ctx.song }), ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}), validate: ctx.validate !== false });
    return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings)] };
  },
  write: ({ doc, plan, song }) => {
    const result = exportSwm(doc, { song, ...(plan.exportOptions.voiceIds ? { voiceIds: plan.exportOptions.voiceIds } : {}), ...(plan.exportOptions.source ? { source: plan.exportOptions.source } : {}) });
    return { bytes: result.bytes, losses: lossesFromText("write", result.report.losses), report: { ...result.report, rowSeconds: result.report.callsPerRow / (result.report.speed * sidwaveFrameRate(doc.song.mode)) } };
  },
  describe: (bytes) => {
    try { const m = parseSwm(bytes); return { kind: m.kind, patterns: m.patterns.length, instruments: m.instruments.length }; } catch (error) {
      throw new InterchangeUsageError(`not a valid SID-Wizard module: ${(error as Error).message}`);
    }
  },
};
