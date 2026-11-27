// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

/** An interchange file that cannot be read, is too large, or an output that cannot be written. Classified as `input`. */
export class InterchangeUsageError extends Error {
  constructor(message: string) { super(message); this.name = "InterchangeUsageError"; }
}

/** The stem renderer refuses a score (digi samples, more than three SIDs, no songs). Classified as `limit_exceeded`. */
export class StemsRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "StemsRefusedError"; }
}
