// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Reconstruction from an imported register trace (VICE dump, siddump) instead of a SID file. The pipeline is the
// one of `reconstructSid` (recover a score, compile it, trace it again, F-diff both traces). It is reused unchanged:
// the engine passed to it returns the imported trace for the first trace request and the real engine's trace for
// the second one, so that recovery, compilation and comparison stay in one place.

import { writeSidFile } from "../sidFile.js";
import type { SidEngine, TraceRequest, TraceResult } from "../engine/types.js";
import { DEFAULT_HORIZON_SECONDS, reconstructSid, type ReconstructResult } from "../reconstruct/reconstruct.js";
import { TRACE_CLOCK_HZ, type ImportedTrace } from "./traceInput.js";

export interface TraceReconstructOptions {
  engine: SidEngine;
  /** Horizon in seconds. Default: the length of the trace rounded up, at most 180. */
  seconds?: number;
  title?: string;
}

/** A PSID that carries only the clock; reconstructSid reads nothing else from it. */
function placeholderSid(clock: ImportedTrace["clock"]): Uint8Array {
  return writeSidFile({
    magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 1, startSong: 1, speed: 0,
    name: "trace", author: "", released: "", clock, payload: new Uint8Array([0x60, 0x60, 0x60, 0x60]),
  });
}

export interface TraceReconstructResult extends ReconstructResult {
  /** The seconds of the trace that the comparison covers. */
  seconds: number;
  trace: { format: ImportedTrace["format"]; writes: number; approximate: boolean; ignoredWrites: number; warnings: string[] };
}

export async function reconstructFromTrace(trace: ImportedTrace, options: TraceReconstructOptions): Promise<TraceReconstructResult> {
  if (trace.count === 0) throw new RangeError("the trace holds no SID writes");
  const hz = TRACE_CLOCK_HZ[trace.clock];
  const seconds = options.seconds ?? Math.min(DEFAULT_HORIZON_SECONDS, Math.max(1, Math.ceil(trace.horizonCycles / hz)));
  let served = false;
  const engine: SidEngine = {
    id: options.engine.id,
    get version() { return options.engine.version; },
    render: (req) => options.engine.render(req),
    async trace(req: TraceRequest): Promise<TraceResult> {
      if (served) return options.engine.trace(req);
      served = true;
      return {
        records: trace.records, count: trace.count, droppedRecords: 0, clock: trace.clock, originCycle: trace.originCycle,
        horizonCycles: Math.round(seconds * hz), cycles: trace.horizonCycles, seconds, samples: new Int16Array(0), sampleRate: 48_000, channels: 1,
        engine: { id: options.engine.id, version: options.engine.version, emulation: "sidlite" },
      };
    },
  };
  const result = await reconstructSid(placeholderSid(trace.clock), { engine, seconds, ...(options.title === undefined ? {} : { title: options.title }) });
  return { ...result, seconds, trace: { format: trace.format, writes: trace.count, approximate: trace.approximate, ignoredWrites: trace.ignoredWrites, warnings: trace.warnings } };
}
