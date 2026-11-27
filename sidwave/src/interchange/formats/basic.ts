// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Commodore BASIC V2 DATA player in the convert registry (write only). Wraps writeBasic.

import { writeBasic } from "../basic.js";
import type { FormatDefinition } from "../formatTypes.js";

const head = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(512, bytes.length)).toString("latin1");

export const COMMODORE_BASIC: FormatDefinition = {
  id: "basic", name: "Commodore BASIC V2 DATA player", extensions: [".bas"], aliases: ["commodore-basic"], songs: false,
  magic: (bytes, extension) => (extension === ".bas" && /^\d{1,5} ?[A-Za-z]/.test(head(bytes)) ? 0.6 : 0),
  detection: "a numbered BASIC listing with the extension .bas",
  caps: { kind: "program", maxVoices: 3, tempo: "exact", instruments: "native", expression: "partial", loop: false, metadata: false },
  lossSummary: "write only: one SID, one value of pitch, waveform and pulse width per note; timing in 1/60 s steps, dense passages are late; large scores exceed BASIC RAM (--seconds shortens them)",
  write: (ctx) => writeBasic(ctx),
};
