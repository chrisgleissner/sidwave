// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

/** An interchange file that cannot be read, is too large, or an output that cannot be written. Classified as `input`. */
export class InterchangeUsageError extends Error {
  constructor(message: string) { super(message); this.name = "InterchangeUsageError"; }
}

/** A score that exceeds a fixed capacity of the target format (patterns, instruments, orderlist length). Classified as `limit_exceeded`. */
export class InterchangeLimitError extends Error {
  constructor(message: string) { super(message); this.name = "InterchangeLimitError"; }
}

/** The stem renderer refuses a score (digi samples, more than three SIDs, no songs). Classified as `limit_exceeded`. */
export class StemsRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "StemsRefusedError"; }
}

/** A malformed or unsupported input file of a tracker or notation format. Classified as `input` like InterchangeUsageError. */
export class InterchangeInputError extends InterchangeUsageError {
  constructor(message: string, readonly yaml?: string) { super(message); this.name = "InterchangeInputError"; }
}
