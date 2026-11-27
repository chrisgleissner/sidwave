// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { SidFileError } from "./sidFile.js";
import { SonglengthsError } from "./songlengths.js";
import { HvscError } from "./hvsc.js";
import { SidwaveValidationError } from "./sidwave.js";
import { SidwaveGameCycleLimitError } from "./sidwaveGame.js";
import { InterchangeLimitError, InterchangeUsageError } from "./interchange/errors.js";
import { MidiError } from "./interchange/smf.js";
import { MidiImportError } from "./interchange/midiImport.js";
import { A1Error } from "./verify/a1.js";
import { VerifyError } from "./verify/index.js";
import { RetargetError } from "./retarget/types.js";
import { SidEngineError } from "./engine/types.js";
import type { SidEmulation, SidEngine } from "./engine/types.js";

/**
 * Error categories of the command line and of the operation functions behind it. The category decides the exit
 * code, so a failed verdict (exit 1) never shares a code with an operational failure.
 */
export type ErrorCategory = "usage" | "input" | "validation" | "engine_unavailable" | "limit_exceeded" | "aborted" | "internal";

export const EXIT_OK = 0;
/** A failed verdict: verify did not reach the requested level, or lint --strict found a problem. */
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** Unreadable or invalid input, or an invalid score. */
export const EXIT_INPUT = 3;
export const EXIT_ENGINE_UNAVAILABLE = 4;
/** A resource budget was exceeded or the run was cancelled. */
export const EXIT_LIMIT = 5;
export const EXIT_INTERNAL = 70;

export const EXIT_CODES: Record<ErrorCategory, number> = {
  usage: EXIT_USAGE,
  input: EXIT_INPUT,
  validation: EXIT_INPUT,
  engine_unavailable: EXIT_ENGINE_UNAVAILABLE,
  limit_exceeded: EXIT_LIMIT,
  aborted: EXIT_LIMIT,
  internal: EXIT_INTERNAL,
};

export class SidwaveOperationError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.name = "SidwaveOperationError";
  }
}

export class UsageError extends SidwaveOperationError {
  constructor(message: string) {
    super("usage", message);
    this.name = "UsageError";
  }
}

export interface ErrorReport {
  category: ErrorCategory;
  message: string;
  details: Record<string, unknown>;
}

/** Maps any thrown value to a category. Unknown errors are `internal`. */
export function classifyError(error: unknown): ErrorReport {
  if (error instanceof SidwaveOperationError) return { category: error.category, message: error.message, details: error.details };
  if (error instanceof SidwaveValidationError) return { category: "validation", message: error.message, details: { path: error.path } };
  if (error instanceof RetargetError) return { category: "validation", message: error.message, details: { code: error.code } };
  if (error instanceof InterchangeLimitError) return { category: "limit_exceeded", message: error.message, details: {} };
  if (error instanceof SidwaveGameCycleLimitError) return { category: "limit_exceeded", message: error.message, details: { measured: error.measured, upperBound: error.upperBound, limit: error.limit } };
  if (error instanceof MidiError || error instanceof MidiImportError || error instanceof InterchangeUsageError) return { category: "input", message: error.message, details: {} };
  if (error instanceof SidFileError) return { category: "input", message: error.message, details: { code: error.code } };
  if (error instanceof HvscError) return { category: error.category, message: error.message, details: { code: error.code } };
  if (error instanceof SonglengthsError) return { category: "input", message: error.message, details: { code: error.code } };
  if (error instanceof A1Error) return { category: error.code === "invalid_input" ? "usage" : "input", message: error.message, details: { code: error.code } };
  if (error instanceof SidEngineError) {
    const category: ErrorCategory = error.code === "aborted" ? "aborted"
      : error.code === "engine_unavailable" ? "engine_unavailable"
        : error.code === "load_failed" ? "input" : "limit_exceeded";
    return { category, message: error.message, details: { code: error.code } };
  }
  if (error instanceof VerifyError) {
    const category: ErrorCategory = error.code === "invalid_options" ? "usage"
      : error.code === "trace_limit" ? "limit_exceeded"
        : error.code === "unsupported_pcm_engine" || error.code === "pcm_engine_required" ? "engine_unavailable" : "internal";
    return { category, message: error.message, details: { code: error.code } };
  }
  if (error instanceof Error && error.name === "AbortError") return { category: "aborted", message: "The operation was aborted", details: {} };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return { category: "input", message: `${(error as Error).message}`, details: { code } };
  }
  return { category: "internal", message: error instanceof Error ? error.message : String(error), details: {} };
}

export interface CliIo {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  outBytes(bytes: Uint8Array): void;
  /** Aborts the running operation (SIGINT in the command line). */
  signal?: AbortSignal;
  /** Replaces the creation of the libsidplayfp engines; used by tests and embedders. */
  createEngine?: (emulation: SidEmulation) => SidEngine;
}

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  result?: unknown;
  error?: ErrorReport;
}

/** `ok` is false for a failed verdict, which carries a `result` and no `error`. */
export function envelope(command: string, ok: boolean, payload: { result: unknown } | { error: ErrorReport }): JsonEnvelope {
  return { ok, command, ...payload };
}

/** Runs `fn`; a validation error gets the name of the file so that the command line can print "file: message". */
export function withFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const report = classifyError(error);
    if (report.category === "validation") {
      throw new SidwaveOperationError("validation", report.message, { ...report.details, file }, { cause: error });
    }
    throw error;
  }
}
