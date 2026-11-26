// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import { createRequire } from "node:module";
import type {
  SidClock,
  SidEngine,
  SidEmulation,
  RenderRequest,
  RenderResult,
  TraceRequest,
  TraceResult,
} from "./types.js";
import {
  SidAbortError,
  SidEngineError,
  SidEngineUnavailableError,
  SidLimitError,
  SidLoadError,
  TraceOverflowError,
} from "./types.js";
export * from "./types.js";

const MAX_SID_BYTES = 65_536 + 0x7c;
const DEFAULT_MAX_SECONDS = 600;
const MAX_TRACE_RECORDS = 4_194_304;
const SLICE_SECONDS = 0.02;
const CLOCK_HZ = { PAL: 985_248, NTSC: 1_022_727 } as const;
/** Cycles from the start of the probe tune's init routine to its first SID write (LDA #imm, then STA abs). */
const PROBE_FIRST_WRITE_CYCLE = 6;

type EngineOptions = {
  emulation: SidEmulation;
  /** Test hooks; production defaults render in ~20 ms slices. */
  sliceSeconds?: number;
  traceBufferLimit?: number;
  /** Test hook: replaces the dynamic import of the optional libsidplayfp-wasm package. */
  importModule?: (specifier: string) => Promise<unknown>;
  /** Test hook: replaces reading the installed package version. */
  readVersion?: () => string;
};

type SidPlayerContext = {
  configure(rate: number, stereo: boolean): boolean;
  getLastError(): string;
  setSystemROMs(
    kernal?: Uint8Array | null,
    basic?: Uint8Array | null,
    chargen?: Uint8Array | null,
  ): boolean;
  setEmulationConfig(config: Record<string, unknown>): boolean;
  setSidWriteTraceEnabled(enabled: boolean): void;
  loadSidBuffer(data: Uint8Array): boolean;
  selectSong(song: number): number;
  getTuneMd5(): string;
  render(cycles: number): Int16Array | null;
  getAndClearSidWriteTracesPacked(): Float64Array;
  getDroppedSidWriteTraceCount(): number;
  delete(): void;
};

type LibsidplayfpWasmModule = { SidPlayerContext: new () => SidPlayerContext };

type RunResult = {
  samples: Int16Array;
  sampleRate: number;
  channels: 1 | 2;
  seconds: number;
  md5: string;
  trace: Float64Array;
  droppedRecords: number;
  traceCount: number;
  clock: SidClock;
  originCycle: number;
  horizonCycles: number;
  cycles: number;
};

/**
 * The clock flag of a PSID v2+ header: "PAL" or "NTSC", or undefined when the header gives none
 * (not a PSID, version 1, or the flag says unknown or both).
 */
export function psidClock(sid: Uint8Array): SidClock | undefined {
  const magic = String.fromCharCode(...sid.subarray(0, 4));
  if ((magic !== "PSID" && magic !== "RSID") || sid.length < 0x78) return undefined;
  const version = (sid[4] << 8) | sid[5];
  if (version < 2) return undefined;
  const clockBits = (((sid[0x76] << 8) | sid[0x77]) >> 2) & 3;
  return clockBits === 1 ? "PAL" : clockBits === 2 ? "NTSC" : undefined;
}

/** A PSID whose init routine does LDA #$0F, STA $D418, RTS. Its first write marks where PCM starts. */
function probeSid(clock: SidClock): Uint8Array {
  const sid = new Uint8Array(0x7c + 8);
  sid.set([0x50, 0x53, 0x49, 0x44], 0); // "PSID"
  sid.set([0x00, 0x02, 0x00, 0x7c], 4); // version 2, data offset
  sid.set([0x10, 0x00], 0x0a); // init address $1000
  sid.set([0x00, 0x01, 0x00, 0x01], 0x0e); // one song, start song 1
  sid[0x77] = clock === "NTSC" ? 0b1000 : 0b0100;
  sid.set([0x00, 0x10, 0xa9, 0x0f, 0x8d, 0x18, 0xd4, 0x60], 0x7c); // load address $1000, code
  return sid;
}

function readInstalledVersion(): string {
  return (createRequire(import.meta.url)("libsidplayfp-wasm/package.json") as { version: string }).version;
}

/** Keeps the records at or before the horizon; returns the input array itself when all of them qualify. */
function withinHorizon(packed: Float64Array, horizonCycles: number): Float64Array {
  const total = packed.length / 4;
  let kept = 0;
  for (let i = 0; i < total; i++) {
    if (packed[i * 4 + 3] <= horizonCycles) kept++;
  }
  if (kept === total) return packed;
  const out = new Float64Array(kept * 4);
  let next = 0;
  for (let i = 0; i < total; i++) {
    if (packed[i * 4 + 3] > horizonCycles) continue;
    out.set(packed.subarray(i * 4, i * 4 + 4), next * 4);
    next++;
  }
  return out;
}

/** No ROMs are bundled. RSID/BASIC tunes need caller supplied KERNAL/BASIC/CHARGEN images. */
export function createLibsidplayfpEngine({
  emulation,
  sliceSeconds = SLICE_SECONDS,
  traceBufferLimit = 2 ** 20,
  importModule = (specifier: string) => import(specifier),
  readVersion = readInstalledVersion,
}: EngineOptions): SidEngine {
  const id = "libsidplayfp-wasm";
  let version = "unknown";
  let modulePromise: Promise<LibsidplayfpWasmModule> | undefined;
  const origins = new Map<SidClock, Promise<number>>();
  const optionalPackage = ["libsidplayfp", "wasm"].join("-");

  const getModule = () =>
    (modulePromise ??= importModule(optionalPackage)
      .then((loaded: any) => {
        try {
          version = readVersion();
        } catch {
          version = "unknown";
        }
        return loaded.loadLibsidplayfp({ engine: emulation }) as Promise<LibsidplayfpWasmModule>;
      })
      .catch((error) => {
        modulePromise = undefined;
        throw new SidEngineUnavailableError(
          `The libsidplayfp-wasm package is required but could not be loaded (${String(error)}). ` +
            "Install it with: npm install libsidplayfp-wasm",
          error,
        );
      }));

  const identity = () => ({ id, version, emulation });

  /** Cycle at which PCM starts, measured once per clock with a tune that writes in its first instructions. */
  function getOrigin(clock: SidClock): Promise<number> {
    let origin = origins.get(clock);
    if (!origin) {
      origin = run({ sid: probeSid(clock), seconds: SLICE_SECONDS, clock }, true, Infinity).then((probe) => {
        if (probe.trace.length === 0) throw new SidLoadError("The origin probe tune produced no SID write");
        return probe.trace[3] - PROBE_FIRST_WRITE_CYCLE;
      });
      origin.catch(() => origins.delete(clock));
      origins.set(clock, origin);
    }
    return origin;
  }

  /** originCycle is only used when tracing; pass undefined to measure it. */
  async function run(req: RenderRequest, tracing: boolean, originCycle?: number): Promise<RunResult> {
    validate(req);
    const maxSeconds = req.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (!Number.isFinite(req.seconds) || req.seconds <= 0 || req.seconds > maxSeconds) {
      throw new SidLimitError(`seconds must be in (0, ${maxSeconds}]`);
    }
    const sampleRate = req.sampleRate ?? 44_100;
    const channels = req.channels ?? 1;
    if (!Number.isInteger(sampleRate) || sampleRate < 4000 || sampleRate > 192000) {
      throw new SidLimitError("sampleRate must be an integer from 4000 to 192000");
    }
    const clock: SidClock = req.clock ?? psidClock(req.sid) ?? "PAL";
    const clockHz = CLOCK_HZ[clock];
    const mod = await getModule();
    checkAbort(req);
    const origin = tracing ? (originCycle ?? (await getOrigin(clock))) : 0;
    const frames = Math.ceil(req.seconds * sampleRate);
    const horizonCycles = origin + Math.round((frames * clockHz) / sampleRate);
    const wantSamples = frames * channels;
    const ctx: SidPlayerContext = new mod.SidPlayerContext();
    const onChunk = reqOnChunk(req) ? req.onChunk : undefined;
    const maxRecords = tracing ? ((req as TraceRequest).maxRecords ?? MAX_TRACE_RECORDS) : MAX_TRACE_RECORDS;
    let callbackFailure: { error: unknown } | undefined;
    const callback = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        callbackFailure = { error };
        throw error;
      }
    };
    try {
      if (!ctx.configure(sampleRate, channels === 2)) throw new SidLoadError(ctx.getLastError());
      if (req.roms && !ctx.setSystemROMs(req.roms.kernal ?? null, req.roms.basic ?? null, req.roms.chargen ?? null)) {
        throw new SidLoadError(`Unable to apply system ROMs: ${ctx.getLastError()}`);
      }
      ctx.setEmulationConfig({
        ...(req.model ? { sidModel: req.model === "6581" ? "MOS6581" : "MOS8580", forceSidModel: true } : {}),
        c64Model: clock,
        forceC64Model: true,
        powerOnDelay: 8191,
      });
      // Trace is enabled before loadSidBuffer so init writes are captured when the binding records them.
      if (tracing) ctx.setSidWriteTraceEnabled(true);
      if (!ctx.loadSidBuffer(req.sid)) throw new SidLoadError(ctx.getLastError());
      if (req.song !== undefined && ctx.selectSong(req.song) === 0) {
        throw new SidLoadError(ctx.getLastError() || `Unable to select song ${req.song}`);
      }
      const md5 = ctx.getTuneMd5();
      const pcm: Int16Array[] = [];
      const traceParts: Float64Array[] = [];
      let sampleCount = 0;
      let producedSamples = 0;
      let traceCount = 0;
      let droppedRecords = 0;
      let slice = 0;
      // render() is bounded to ~20 ms and trace is drained on every slice before it can approach 2^20 entries.
      const cyclesPerSlice = Math.max(1, Math.floor(clockHz * sliceSeconds));
      while (sampleCount < wantSamples) {
        checkAbort(req);
        const chunk = ctx.render(cyclesPerSlice);
        if (!chunk) throw new SidLoadError(ctx.getLastError() || "libsidplayfp render failed");
        const copy = chunk.slice();
        const needed = Math.min(copy.length, wantSamples - sampleCount);
        if (needed) pcm.push(copy.subarray(0, needed));
        sampleCount += needed;
        producedSamples += copy.length;
        if (tracing) {
          const dropped = ctx.getDroppedSidWriteTraceCount();
          const drained = ctx.getAndClearSidWriteTracesPacked();
          droppedRecords += dropped;
          if (dropped !== 0 || drained.length / 4 > traceBufferLimit) {
            throw new TraceOverflowError(
              `Trace buffer overflow in render slice ${slice} (${dropped} dropped records; limit ${traceBufferLimit})`,
            );
          }
          const packed = withinHorizon(drained, horizonCycles);
          if (packed.length) {
            traceCount += packed.length / 4;
            if (traceCount > maxRecords) {
              throw new TraceOverflowError(`Trace exceeds maxRecords ${maxRecords}; records would be lost`);
            }
            if (onChunk) callback(() => onChunk(packed));
            else traceParts.push(packed);
          }
        }
        slice++;
        if (req.onProgress) callback(() => req.onProgress!(Math.min(1, sampleCount / wantSamples)));
      }
      const samples = new Int16Array(sampleCount);
      let offset = 0;
      for (const part of pcm) {
        samples.set(part, offset);
        offset += part.length;
      }
      const trace = new Float64Array(traceParts.reduce((n, part) => n + part.length, 0));
      offset = 0;
      for (const part of traceParts) {
        trace.set(part, offset);
        offset += part.length;
      }
      const seconds = sampleCount / (sampleRate * channels);
      const cycles = origin + Math.round((producedSamples / channels / sampleRate) * clockHz);
      return { samples, sampleRate, channels, seconds, md5, trace, droppedRecords, traceCount, clock, originCycle: origin, horizonCycles, cycles };
    } catch (error) {
      if (callbackFailure && error === callbackFailure.error) throw error;
      if (error instanceof SidEngineError) throw error;
      throw new SidLoadError(error instanceof Error ? error.message : String(error), error);
    } finally {
      ctx.delete();
    }
  }

  return {
    id,
    get version() {
      return version;
    },
    async render(req): Promise<RenderResult> {
      const result = await run(req, false);
      return {
        samples: result.samples,
        sampleRate: result.sampleRate,
        channels: result.channels,
        seconds: result.seconds,
        engine: identity(),
        md5: result.md5,
      };
    },
    async trace(req): Promise<TraceResult> {
      const maxRecords = req.maxRecords ?? MAX_TRACE_RECORDS;
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
        throw new SidLimitError("maxRecords must be a nonnegative safe integer");
      }
      const result = await run(req, true);
      return {
        records: result.trace,
        count: result.traceCount,
        droppedRecords: result.droppedRecords,
        clock: result.clock,
        originCycle: result.originCycle,
        horizonCycles: result.horizonCycles,
        cycles: result.cycles,
        seconds: result.seconds,
        samples: result.samples,
        sampleRate: result.sampleRate,
        channels: result.channels,
        engine: identity(),
      };
    },
  };
}

function reqOnChunk(req: RenderRequest): req is TraceRequest & { onChunk: (records: Float64Array) => void } {
  return "onChunk" in req && typeof (req as TraceRequest).onChunk === "function";
}

function checkAbort(req: RenderRequest): void {
  if (req.signal?.aborted) throw new SidAbortError();
}

function validate(req: RenderRequest): void {
  if (!(req.sid instanceof Uint8Array) || req.sid.length < 4 || req.sid.length > MAX_SID_BYTES) {
    throw new SidLimitError(`SID input must be a Uint8Array of at most ${MAX_SID_BYTES} bytes`);
  }
  checkAbort(req);
}
