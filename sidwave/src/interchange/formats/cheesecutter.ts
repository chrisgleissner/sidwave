// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// CheeseCutter 2.x songs (.ct) in the convert registry. Wraps importCheeseCutter and exportCheeseCutter. Writing needs a
// user-supplied driver (a .ct file or the player binary): SIDWave does not ship CheeseCutter's player.

import { InterchangeUsageError } from "../errors.js";
import { parseCheeseCutter, subtuneCount } from "../cheesecutter.js";
import { importCheeseCutter } from "../cheesecutterImport.js";
import { exportCheeseCutter } from "../cheesecutterExport.js";
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { warningLosses } from "../builtinFormats.js";

export const CHEESECUTTER: FormatDefinition = {
  id: "cheesecutter", name: "CheeseCutter 2.x song", extensions: [".ct"], aliases: ["ct"], songs: true,
  magic: (bytes) => (bytes.length > 3 && bytes[0] === 0x43 && bytes[1] === 0x43 && bytes[2] === 0x32 ? 1 : 0),
  detection: "the magic CC2 followed by a zlib stream",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "none", loop: true, metadata: true },
  lossSummary: "write needs --driver (a .ct file or the player binary); up to three voices, no drums, glides or filter tables; import: stereo (2-SID) songs are not supported yet",
  // `ctx.validate` is not passed on: the importer finds from its own score check which parts SIDWave cannot hold and imports
  // again without them, so without the check it could return a score that SIDWave rejects.
  read: (bytes, ctx) => {
    const result = importCheeseCutter(bytes, { ...(ctx.song === undefined ? {} : { song: ctx.song }), ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}) });
    return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings)] };
  },
  write: ({ doc, plan, driver }) => {
    if (!driver) throw new InterchangeUsageError("writing CheeseCutter needs a driver: pass --driver <file> (a .ct file or the CheeseCutter player binary; SIDWave does not ship the player)");
    const result = exportCheeseCutter(doc, { ...plan.exportOptions, driver });
    const { bytes, losses, warnings, ...report } = result;
    return { bytes, losses: [...lossesFromText("write", losses), ...warningLosses("write", warnings)], report };
  },
  describe: (bytes) => {
    try { const s = parseCheeseCutter(bytes); return { version: s.version, subtunes: subtuneCount(s) }; } catch (error) {
      throw new InterchangeUsageError(`not a valid CheeseCutter song: ${(error as Error).message}`);
    }
  },
};
