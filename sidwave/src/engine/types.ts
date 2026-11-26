// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
export type SidEmulation = "residfp" | "sidlite";
export type SidClock = "PAL" | "NTSC";
export type EngineIdentity = { id: string; version: string; emulation: SidEmulation };

export interface SystemRoms {
  kernal?: Uint8Array;
  basic?: Uint8Array;
  chargen?: Uint8Array;
}

export interface RenderRequest {
  sid: Uint8Array;
  song?: number;
  seconds: number;
  sampleRate?: number;
  channels?: 1 | 2;
  model?: "6581" | "8580";
  /** Defaults to the clock flag in the PSID header (PAL when the header does not say). */
  clock?: SidClock;
  roms?: SystemRoms;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  maxSeconds?: number;
}

export interface RenderResult {
  samples: Int16Array;
  sampleRate: number;
  channels: 1 | 2;
  seconds: number;
  engine: EngineIdentity;
  md5: string;
}

export interface TraceRequest extends RenderRequest {
  /** Largest number of records a trace may hold. Default 4,194,304 (2^22, 128 MB of Float64). Exceeding it throws TraceOverflowError. */
  maxRecords?: number;
  /**
   * Receives each batch of records as it is produced. When set, the records are not also accumulated:
   * the result carries an empty `records` array and `count` reports how many records were delivered.
   * An error thrown by the callback aborts the trace and propagates unchanged.
   */
  onChunk?: (records: TraceChunk) => void;
}

/** Four Float64 columns per record: sid (zero-based), address offset, value, cyclePhi1. */
export type TraceChunk = Float64Array;

export interface TraceRecord {
  sid: number;
  address: number;
  value: number;
  cycle: number;
}

export interface TraceResult {
  /** Empty when the request supplied onChunk. */
  records: Float64Array;
  /** Number of records in the trace (delivered through onChunk or held in `records`). */
  count: number;
  /** Records the engine reported as dropped. Any nonzero count aborts the trace, so a returned result carries 0. */
  droppedRecords: number;
  /** Clock the trace was produced with (request, else PSID header, else PAL). */
  clock: SidClock;
  /** Cycle, counted from engine start, at which the first PCM sample is produced. */
  originCycle: number;
  /** originCycle plus the requested duration. Records after this cycle are discarded, so traces of equal duration end at the same cycle. */
  horizonCycles: number;
  /** Cycle at the end of the last rendered slice. It can exceed horizonCycles by up to one slice (about 20 ms). */
  cycles: number;
  seconds: number;
  /** PCM rendered while tracing; identical to the PCM of a render() with the same request. */
  samples: Int16Array;
  sampleRate: number;
  channels: 1 | 2;
  engine: EngineIdentity;
}

export interface SidEngine {
  id: string;
  /** Version of the loaded libsidplayfp-wasm package; "unknown" until the first render or trace has loaded it. */
  readonly version: string;
  render(req: RenderRequest): Promise<RenderResult>;
  trace(req: TraceRequest): Promise<TraceResult>;
}

export type SidEngineErrorCode =
  | "aborted"
  | "limit_exceeded"
  | "engine_unavailable"
  | "load_failed"
  | "trace_overflow";

export class SidEngineError extends Error {
  constructor(
    message: string,
    readonly code: SidEngineErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.name = new.target.name;
  }
}

export class SidEngineUnavailableError extends SidEngineError {
  constructor(message: string, cause?: unknown) {
    super(message, "engine_unavailable", { cause });
  }
}

export class SidLoadError extends SidEngineError {
  constructor(message: string, cause?: unknown) {
    super(message, "load_failed", { cause });
  }
}

export class SidLimitError extends SidEngineError {
  constructor(message: string) {
    super(message, "limit_exceeded");
  }
}

export class SidAbortError extends SidEngineError {
  constructor() {
    super("SID operation aborted", "aborted");
  }
}

export class TraceOverflowError extends SidEngineError {
  constructor(message: string) {
    super(message, "trace_overflow");
  }
}
