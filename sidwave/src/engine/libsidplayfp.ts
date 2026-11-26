// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import type { SidEngine, SidEmulation, RenderRequest, RenderResult, TraceRequest, TraceResult } from "./types.js";
import { SidAbortError, SidEngineError, SidEngineUnavailableError, SidLimitError, SidLoadError, TraceOverflowError } from "./types.js";
export * from "./types.js";

const MAX_SID_BYTES = 65_536 + 0x7c;
const DEFAULT_MAX_SECONDS = 600;
const MAX_TRACE_RECORDS = 50_000_000;
const SLICE_SECONDS = 0.02;
const CLOCK_HZ = { PAL: 985_248, NTSC: 1_022_727 } as const;
type EngineOptions = { emulation: SidEmulation; /** Test hooks; production defaults render in ~20 ms slices. */ sliceSeconds?: number; traceBufferLimit?: number };
type SidPlayerContext = {
  configure(rate: number, stereo: boolean): boolean; getLastError(): string;
  setSystemROMs(kernal?: Uint8Array | null, basic?: Uint8Array | null, chargen?: Uint8Array | null): boolean;
  setEmulationConfig(config: Record<string, unknown>): boolean; setSidWriteTraceEnabled(enabled: boolean): void;
  loadSidBuffer(data: Uint8Array): boolean; selectSong(song: number): number; getTuneMd5(): string;
  render(cycles: number): Int16Array | null; getAndClearSidWriteTracesPacked(): Float64Array;
  getDroppedSidWriteTraceCount(): number; delete(): void;
};
type LibsidplayfpWasmModule = { SidPlayerContext: new () => SidPlayerContext };

/** No ROMs are bundled. RSID/BASIC tunes need caller supplied KERNAL/BASIC/CHARGEN images. */
export function createLibsidplayfpEngine({ emulation, sliceSeconds = SLICE_SECONDS, traceBufferLimit = 2 ** 20 }: EngineOptions): SidEngine {
  const id = "libsidplayfp-wasm";
  const version = "1.1.1";
  let modulePromise: Promise<LibsidplayfpWasmModule> | undefined;
  const optionalPackage = ["libsidplayfp", "wasm"].join("-");
  const getModule = () => modulePromise ??= import(optionalPackage).then((loaded: any) => loaded.loadLibsidplayfp({ engine: emulation }) as Promise<LibsidplayfpWasmModule>).catch(error => {
    throw new SidEngineUnavailableError(`libsidplayfp-wasm is unavailable; install the optional dependency: ${String(error)}`);
  });
  const identity = () => ({ id, version, emulation });
  async function run(req: RenderRequest, tracing: boolean): Promise<{ samples: Int16Array; sampleRate: number; channels: 1 | 2; seconds: number; md5: string; trace: Float64Array; cycles: number }> {
    validate(req);
    const maxSeconds = req.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (!Number.isFinite(req.seconds) || req.seconds <= 0 || req.seconds > maxSeconds) throw new SidLimitError(`seconds must be in (0, ${maxSeconds}]`);
    const sampleRate = req.sampleRate ?? 44_100;
    const channels = req.channels ?? 1;
    if (!Number.isInteger(sampleRate) || sampleRate < 4000 || sampleRate > 192000) throw new SidLimitError("sampleRate must be an integer from 4000 to 192000");
    const mod = await getModule();
    checkAbort(req);
    const ctx: SidPlayerContext = new mod.SidPlayerContext();
    try {
      if (!ctx.configure(sampleRate, channels === 2)) throw new SidLoadError(ctx.getLastError());
      if (req.roms && !ctx.setSystemROMs(req.roms.kernal ?? null, req.roms.basic ?? null, req.roms.chargen ?? null)) throw new SidLoadError(`Unable to apply system ROMs: ${ctx.getLastError()}`);
      ctx.setEmulationConfig({ ...(req.model ? { sidModel: req.model === "6581" ? "MOS6581" : "MOS8580", forceSidModel: true } : {}), ...(req.clock ? { c64Model: req.clock, forceC64Model: true } : {}), powerOnDelay: 8191 });
      // Trace is enabled before loadSidBuffer so init writes are captured when the binding records them.
      if (tracing) ctx.setSidWriteTraceEnabled(true);
      if (!ctx.loadSidBuffer(req.sid)) throw new SidLoadError(ctx.getLastError());
      if (req.song !== undefined && ctx.selectSong(req.song) === 0) throw new SidLoadError(ctx.getLastError() || `Unable to select song ${req.song}`);
      const md5 = ctx.getTuneMd5();
      const frames: Int16Array[] = [];
      const traceParts: Float64Array[] = [];
      let sampleCount = 0, traceCount = 0, cycles = 0, slice = 0;
      const wantSamples = Math.ceil(req.seconds * sampleRate) * channels;
      // render() is bounded to ~20 ms and trace is drained on every slice before it can approach 2^20 entries.
      const cyclesPerSlice = Math.max(1, Math.floor(CLOCK_HZ[req.clock ?? "PAL"] * sliceSeconds));
      while (sampleCount < wantSamples) {
        checkAbort(req);
        const chunk = ctx.render(cyclesPerSlice);
        if (!chunk) throw new SidLoadError(ctx.getLastError() || "libsidplayfp render failed");
        const copy = chunk.slice();
        const needed = Math.min(copy.length, wantSamples - sampleCount);
        if (needed) frames.push(copy.subarray(0, needed));
        sampleCount += needed;
        cycles += cyclesPerSlice;
        if (tracing) {
          const dropped = ctx.getDroppedSidWriteTraceCount();
          const packed = ctx.getAndClearSidWriteTracesPacked();
          if (dropped !== 0 || packed.length / 4 > traceBufferLimit) throw new TraceOverflowError(`Trace buffer overflow in render slice ${slice} (${dropped} dropped records; limit ${traceBufferLimit})`);
          if (packed.length) {
            traceCount += packed.length / 4;
            if (traceCount > (tracing ? (req as TraceRequest).maxRecords ?? MAX_TRACE_RECORDS : MAX_TRACE_RECORDS)) throw new SidLimitError("Trace maxRecords exceeded");
            if (reqOnChunk(req)) req.onChunk!(packed);
            traceParts.push(packed);
          }
        }
        slice++;
        req.onProgress?.(Math.min(1, sampleCount / wantSamples));
      }
      const samples = new Int16Array(sampleCount);
      let offset = 0; for (const frame of frames) { samples.set(frame, offset); offset += frame.length; }
      const trace = new Float64Array(traceCount * 4); offset = 0; for (const part of traceParts) { trace.set(part, offset); offset += part.length; }
      return { samples, sampleRate, channels, seconds: sampleCount / (sampleRate * channels), md5, trace, cycles };
    } catch (error) {
      if (error instanceof SidEngineError) throw error;
      throw new SidLoadError(error instanceof Error ? error.message : String(error));
    } finally { ctx.delete(); }
  }
  return {
    id, version,
    async render(req): Promise<RenderResult> {
      const result = await run(req, false);
      return { samples: result.samples, sampleRate: result.sampleRate, channels: result.channels, seconds: result.seconds, engine: identity(), md5: result.md5 };
    },
    async trace(req): Promise<TraceResult> {
      const maxRecords = req.maxRecords ?? MAX_TRACE_RECORDS;
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) throw new SidLimitError("maxRecords must be a nonnegative safe integer");
      const result = await run(req, true);
      return { records: result.trace, count: result.trace.length / 4, droppedRecords: 0, cycles: result.cycles, seconds: result.seconds, engine: identity() };
    },
  };
}

function reqOnChunk(req: RenderRequest): req is TraceRequest { return "onChunk" in req && typeof (req as TraceRequest).onChunk === "function"; }
function checkAbort(req: RenderRequest): void { if (req.signal?.aborted) throw new SidAbortError(); }
function validate(req: RenderRequest): void {
  if (!(req.sid instanceof Uint8Array) || req.sid.length < 4 || req.sid.length > MAX_SID_BYTES) throw new SidLimitError(`SID input must be a Uint8Array of at most ${MAX_SID_BYTES} bytes`);
  checkAbort(req);
}
