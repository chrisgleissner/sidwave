// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// JCH NewPlayer 20.G editor image in the convert registry (read only). Wraps importJch.

import { InterchangeUsageError } from "../errors.js";
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { warningLosses } from "../builtinFormats.js";
import { looksLikeJch, parseJch } from "../jch.js";
import { importJch } from "../jchImport.js";

export const JCH_NEWPLAYER: FormatDefinition = {
  id: "jch", name: "JCH NewPlayer 20.G editor image", extensions: [], aliases: ["jch-newplayer", "np20"],
  magic: (bytes) => (looksLikeJch(bytes) ? 0.95 : 0),
  detection: "load address $0F00 and the mark 20.G at $0FEE, in a PRG or in a PSID file",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "none", loop: true, metadata: true },
  lossSummary: "read only: the filter, most commands, the wave table dwell and per-voice looping are not imported; packed or relocated tunes are not supported",
  read: (bytes, ctx) => {
    const result = importJch(bytes, { ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}), validate: ctx.validate !== false });
    return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings)] };
  },
  describe: (bytes) => {
    try { const s = parseJch(bytes); return { version: s.version, name: s.name, tempo: s.tempo }; } catch (error) {
      throw new InterchangeUsageError(`not a JCH NewPlayer 20.G image: ${(error as Error).message}`);
    }
  },
};
