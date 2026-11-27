// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

export * from "./compose.js";
export * from "./profiles.js";
export * from "./measures.js";
export { checkCounterpoint, type CounterpointReport, type CounterpointViolation, type TimedNote } from "./melody.js";
export * from "./complete.js";
export { analyseScore, detectKey, inferChords, extractMotif, type Analysis, type VoiceInfo, type VoiceRole, type EntryInfo } from "./analyse.js";
export { verifyProtected, type ProtectedReport, type ProtectedSpec, type Mismatch } from "./protected.js";
export { traceDocument, worstCycles, type DocTrace } from "./trace.js";
