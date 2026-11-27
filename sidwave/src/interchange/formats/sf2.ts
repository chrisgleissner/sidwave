// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID Factory II songs (.sf2) in the convert registry. Wraps importSf2 and exportSf2. Writing needs a user-supplied driver
// (an .sf2 file or a driver PRG): SIDWave does not contain the driver.

import { InterchangeUsageError } from "../errors.js";
import { parseSf2 } from "../sf2.js";
import { importSf2 } from "../sf2Import.js";
import { exportSf2 } from "../sf2Export.js";
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { warningLosses } from "../builtinFormats.js";

export const SID_FACTORY_II: FormatDefinition = {
  id: "sf2", name: "SID Factory II song", extensions: [".sf2"], aliases: ["sidfactory2", "sid-factory-ii"], songs: true,
  magic: (bytes) => (bytes.length > 8 && bytes[2] === 0x37 && bytes[3] === 0x13 ? 0.9 : 0),
  detection: "a PRG whose first two bytes after the load address are the id 0x1337",
  caps: { kind: "tracker", maxVoices: 12, tempo: "grid", instruments: "native", expression: "none", loop: true, metadata: false },
  lossSummary: "write needs --driver (an .sf2 file or a driver 11 PRG); no drums, filter tables or glides; import: driver 11 only",
  // `ctx.validate` is not passed on: the importer finds from its own score check which parts SIDWave cannot hold and imports
  // again without them, so without the check it could return a score that SIDWave rejects.
  read: (bytes, ctx) => {
    let result;
    try { result = importSf2(bytes, { ...(ctx.song === undefined ? {} : { song: ctx.song }), ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}) }); } catch (error) {
      if (error instanceof RangeError) throw new InterchangeUsageError(error.message);
      throw error;
    }
    return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings)] };
  },
  write: ({ doc, plan, driver }) => {
    if (!driver) throw new InterchangeUsageError("writing SID Factory II needs a driver: pass --driver <file> (an .sf2 file or a driver file such as sf2driver11_05.prg; SIDWave does not ship the driver)");
    const result = exportSf2(doc, { ...plan.exportOptions, driver });
    const { bytes, losses, warnings, ...report } = result;
    return { bytes, losses: [...lossesFromText("write", losses), ...warningLosses("write", warnings)], report };
  },
  describe: (bytes) => {
    try { const s = parseSf2(bytes); return { driver: `${s.driver.major}.${String(s.driver.minor).padStart(2, "0")}`, tracks: s.music.tracks }; } catch (error) {
      throw new InterchangeUsageError(`not a valid SID Factory II song: ${(error as Error).message}`);
    }
  },
};
