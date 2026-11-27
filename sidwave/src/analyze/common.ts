// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Shared pieces of the analysis, comparison, isolation and preservation operations.

import { createHash } from "node:crypto";
import type { SidEngine, TraceRequest, TraceResult } from "../engine/types.js";
import { SID_REGISTER_COUNT, type FrameIr, type IrCall, type IrSidState } from "../reconstruct/ir.js";

/**
 * How a fact was obtained. `observed`: read from the register trace or from the score itself. `inferred`: the
 * result of a model applied to those observations; the entry then names the method.
 */
export type Basis = "observed" | "inferred";

export interface Marked {
  basis: Basis;
  /** Name of the model, required for an inferred fact. */
  method?: string;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const md5 = (data: string | Uint8Array): string => createHash("md5").update(data).digest("hex");

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const PITCH_CLASS_NAMES = NOTE_NAMES;

/** Note name of a MIDI note number, for example 60 gives "C4". */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Global voice number (1-based, counted over all SIDs) of a zero-based SID and voice. */
export const globalVoice = (sid: number, voice: number): number => sid * 3 + voice + 1;

/**
 * Wraps an engine so that equal trace requests (same tune bytes, subtune, length, clock, model and emulation) are
 * traced once. A request with `onChunk` is never cached. Renders are passed through.
 */
export function memoEngine(engine: SidEngine): SidEngine & { readonly traceCalls: number; readonly cacheHits: number } {
  const cache = new Map<string, TraceResult>();
  let traceCalls = 0;
  let cacheHits = 0;
  return {
    id: engine.id,
    get version() { return engine.version; },
    get traceCalls() { return traceCalls; },
    get cacheHits() { return cacheHits; },
    render: (request) => engine.render(request),
    async trace(request: TraceRequest): Promise<TraceResult> {
      traceCalls++;
      if (request.onChunk || request.roms) return engine.trace(request);
      const key = [sha256(request.sid), request.song ?? "", request.seconds, request.clock ?? "", request.model ?? "", request.sampleRate ?? "", request.channels ?? ""].join("|");
      const hit = cache.get(key);
      if (hit && (request.maxRecords === undefined || hit.count <= request.maxRecords)) {
        cacheHits++;
        return hit;
      }
      const result = await engine.trace(request);
      cache.set(key, result);
      return result;
    },
  };
}

/**
 * The part of an IR that one voice contributes: the seven registers of the voice and its control-write order, with
 * everything else (other voices, filter, volume) cleared. `voice` is the global voice number, 1-based.
 */
export function restrictIrToVoice(ir: FrameIr, voice: number): FrameIr {
  const sidIndex = Math.floor((voice - 1) / 3);
  const v = (voice - 1) % 3;
  const calls: IrCall[] = ir.calls.map((call) => ({
    ...call,
    sids: call.sids.map((state, s): IrSidState => {
      const regs = new Uint8Array(SID_REGISTER_COUNT);
      let written = 0;
      if (s === sidIndex) {
        for (let r = v * 7; r < v * 7 + 7; r++) {
          regs[r] = state.regs[r]!;
          written |= state.written & (1 << r);
        }
      }
      const control: [number[], number[], number[]] = [[], [], []];
      if (s === sidIndex) control[v] = state.control[v]!.slice();
      return { regs, written, control };
    }),
  }));
  return { ...ir, calls };
}

/** The calls from `from` (inclusive) to `to` (exclusive) of an IR, as an IR of their own. */
export function sliceIr(ir: FrameIr, from: number, to: number): FrameIr {
  return { ...ir, calls: ir.calls.slice(from, to).map((call, index) => ({ ...call, index })) };
}

/**
 * SHA-256 over what a strict F-diff compares: the number of calls, and for every call and SID the 25 registers and
 * the control-write order of each voice. Cycle values are not part of it, so two traces that differ only in the
 * cycle at which a call starts have the same fingerprint.
 */
export function irFingerprint(ir: FrameIr): string {
  const hash = createHash("sha256");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(ir.calls.length, 0);
  head.writeUInt32LE(ir.sidCount, 4);
  hash.update(head);
  for (const call of ir.calls) {
    for (const sid of call.sids) {
      hash.update(sid.regs);
      for (let v = 0; v < 3; v++) {
        const seq = sid.control[v]!;
        hash.update(Uint8Array.of(seq.length & 0xff, ...seq));
      }
    }
  }
  return hash.digest("hex");
}

/** Registers of one voice at a call as numbers. */
export interface VoiceRegs {
  freq: number;
  pulse: number;
  control: number;
  ad: number;
  sr: number;
}

export function voiceRegs(regs: Uint8Array, voice: number): VoiceRegs {
  const o = voice * 7;
  return {
    freq: regs[o]! | (regs[o + 1]! << 8),
    pulse: regs[o + 2]! | ((regs[o + 3]! & 15) << 8),
    control: regs[o + 4]!,
    ad: regs[o + 5]!,
    sr: regs[o + 6]!,
  };
}

/** A CPU time (user plus system, microseconds) of this process, for the bounds of the performance tests. */
export function cpuMicros(): number {
  const u = process.cpuUsage();
  return u.user + u.system;
}
