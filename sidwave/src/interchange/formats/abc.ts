// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// ABC 2.1 is a read-only notation source.
import type { FormatDefinition } from "../formatTypes.js";
import { lossesFromText } from "../loss.js";
import { importAbc } from "../abcImport.js";

export const ABC: FormatDefinition = {
  id: "abc",
  name: "ABC notation",
  extensions: [".abc"],
  aliases: ["abc"],
  songs: true,
  readQuantises: true,
  magic(bytes) {
    const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65_536)));
    const firstTune = /^X:\s*\d+\s*(?:\r?\n|$)/m.exec(text);
    if (!firstTune) return 0;
    return /^K:\s*\S/m.test(text.slice(firstTune.index + firstTune[0].length)) ? 0.95 : 0;
  },
  detection: "an X: tune line followed by a K: key header",
  caps: {
    kind: "notation",
    maxVoices: 3,
    tempo: "grid",
    instruments: "none",
    expression: "none",
    loop: false,
    metadata: true,
  },
  lossSummary: "read only: chords are reduced to simultaneous SID voice lanes; grace notes, decorations, lyrics, slurs and unknown directives are omitted",
  read(bytes, context) {
    const result = importAbc(bytes, {
      ...(context.song === undefined ? {} : { song: context.song }),
      ...(context.title ? { title: context.title } : {}),
      ...(context.grid ? { grid: context.grid } : {}),
      ...(context.voices ? { voices: context.voices } : {}),
      ...(context.mode ? { mode: context.mode } : {}),
      validate: context.validate,
    });
    return {
      yaml: result.yaml,
      report: result.report,
      losses: lossesFromText("read", result.losses),
    };
  },
};
