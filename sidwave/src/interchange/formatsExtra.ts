// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Formats added to `sidwave convert` by other work packages. To add a format:
//   1. Create interchange/format<Name>.ts that exports a FormatDefinition (see formatTypes.ts and builtinFormats.ts).
//   2. Replace the placeholder comment of the format below with the import and the array entry.
// Nothing else changes: detection, `convert`, `formats`, `info` and the conversion test matrix pick the entry up.
// Each format has its own placeholder line, so branches that add different formats do not conflict.

import type { FormatDefinition } from "./formatTypes.js";
// import { SID_WIZARD } from "./formatSidWizard.js";
// import { VICE_DUMP } from "./formatViceDump.js";
// import { SIDDUMP } from "./formatSiddump.js";
// import { CHEESECUTTER } from "./formatCheeseCutter.js";
// import { SF2 } from "./formatSf2.js";

export const EXTRA_FORMATS: FormatDefinition[] = [
  // SID_WIZARD,
  // VICE_DUMP,
  // SIDDUMP,
  // CHEESECUTTER,
  // SF2,
];
