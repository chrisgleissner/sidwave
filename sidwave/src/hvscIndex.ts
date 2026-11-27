// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Library entry point of the HVSC tools (`sidwave/hvsc`): SID header editing, Songlengths files, STIL and SIDId
// player signatures. The command line is `sidwave sid`, `sidwave songlengths` and `sidwave stil`; see doc/hvsc.md.

export {
  HvscError, DEFAULT_DATABASE_MAX_BYTES, fileOfHvscPath, findHvscRootAbove, hvscDatabases, hvscPathOf, readBounded, resolveHvscRoot, walkSidFiles,
  type HvscDatabases, type HvscErrorCode,
} from "./hvsc.js";
export * from "./sidEdit.js";
export * from "./songlengthsFile.js";
export * from "./stil.js";
export * from "./sidId.js";
