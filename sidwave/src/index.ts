// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

export * from "./sidwave.js";
export * from "./sidwaveCompiler.js";
export * from "./sidwaveGame.js";
export * from "./sidwaveDigi.js";
export * from "./sidwavePcm.js";
export * from "./sidwaveForm.js";
export * from "./sidwaveFilterModel.js";
export * from "./sidwaveLint.js";
export * from "./sidwaveExamples.js";
export * from "./sidwaveOps.js";
export * from "./sidFile.js";
export * from "./songlengths.js";
export * from "./audio/generateSidwave.js";
export * from "./audio/sidwaveReference.js";
export * from "./audio/sidwaveSimilarity.js";
export * from "./audio/sidwaveFidelity.js";
export * from "./audio/sidwaveQuality.js";
export * from "./sidwaveTools.js";
export { classifyError, SidwaveOperationError, EXIT_CODES, type ErrorCategory, type ErrorReport } from "./cliCore.js";
