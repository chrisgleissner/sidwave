// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
export type SidEmulation = "residfp" | "sidlite";
export type EngineIdentity = { id: string; version: string; emulation: SidEmulation };

export interface SystemRoms { kernal?: Uint8Array; basic?: Uint8Array; chargen?: Uint8Array }
export interface RenderRequest {
  sid: Uint8Array; song?: number; seconds: number; sampleRate?: number; channels?: 1 | 2;
  model?: "6581" | "8580"; clock?: "PAL" | "NTSC"; roms?: SystemRoms; signal?: AbortSignal;
  onProgress?: (fraction: number) => void; maxSeconds?: number;
}
export interface RenderResult {
  samples: Int16Array; sampleRate: number; channels: 1 | 2; seconds: number;
  engine: EngineIdentity; md5: string;
}
export interface TraceRequest extends RenderRequest {
  maxRecords?: number; onChunk?: (records: TraceChunk) => void;
}
/** Four Float64 columns per record: sid (zero-based), address offset, value, cyclePhi1. */
export type TraceChunk = Float64Array;
export interface TraceRecord { sid: number; address: number; value: number; cycle: number }
export interface TraceResult {
  records: Float64Array; count: number; droppedRecords: 0; cycles: number; seconds: number;
  engine: EngineIdentity;
}
export interface SidEngine {
  id: string; version: string;
  render(req: RenderRequest): Promise<RenderResult>;
  trace(req: TraceRequest): Promise<TraceResult>;
}

export type SidEngineErrorCode = "aborted" | "limit_exceeded" | "engine_unavailable" | "load_failed" | "trace_overflow";
export class SidEngineError extends Error {
  constructor(message: string, readonly code: SidEngineErrorCode) { super(message); this.name = new.target.name; }
}
export class SidEngineUnavailableError extends SidEngineError {
  constructor(message: string) { super(message, "engine_unavailable"); }
}
export class SidLoadError extends SidEngineError {
  constructor(message: string) { super(message, "load_failed"); }
}
export class SidLimitError extends SidEngineError {
  constructor(message: string) { super(message, "limit_exceeded"); }
}
export class SidAbortError extends SidEngineError {
  constructor() { super("SID operation aborted", "aborted"); }
}
export class TraceOverflowError extends SidEngineError {
  constructor(message: string) { super(message, "trace_overflow"); }
}
