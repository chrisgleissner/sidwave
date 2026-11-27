// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// ProTracker MOD in the convert registry (read only). Wraps importMod.

import { InterchangeUsageError } from "../errors.js";
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { warningLosses } from "../builtinFormats.js";
import { looksLikeMod, parseMod } from "../mod.js";
import { importMod } from "../modImport.js";

export const PROTRACKER_MOD: FormatDefinition = {
  id: "mod", name: "ProTracker MOD", extensions: [".mod"], aliases: ["protracker", "amiga-mod"], songs: false,
  magic: (bytes) => (looksLikeMod(bytes) ? 0.9 : 0),
  detection: "a MOD signature (M.K., FLT4, 6CHN, 8CHN, nnCH, ...) at offset 1080",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "none", loop: true, metadata: true },
  lossSummary: "read only: four or more channels are reduced to three voices per SID, samples become SID waveforms and ADSR, and effects without a SIDWave equivalent are dropped",
  read: (bytes, ctx) => {
    const result = importMod(bytes, { ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}), validate: ctx.validate !== false });
    return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings)] };
  },
  describe: (bytes) => {
    try { const m = parseMod(bytes); return { variant: m.variant, channels: m.channels, patterns: m.patterns.length, samples: m.samples.filter((s) => s.length > 2).length }; } catch (error) {
      throw new InterchangeUsageError(`not a valid MOD file: ${(error as Error).message}`);
    }
  },
};
