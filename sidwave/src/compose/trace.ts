// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { ParsedSidwave } from "../sidwave.js";
import { compileSidwaveToPrg, type CompileResult } from "../sidwaveCompiler.js";
import { Cpu6502 } from "../sidwaveEmulator.js";

/** One play call: the SID register writes in order as [offset from $D400, value], and the cycles of the call. */
export interface TraceCall { writes: Array<[number, number]>; cycles: number }

export interface DocTrace { compile: CompileResult; calls: TraceCall[]; initCycles: number }

/**
 * Compiles the score to its PRG and runs init and `calls` play calls on the bundled 6502 interpreter, recording the SID
 * writes of every call. The interpreter is deterministic, so two traces of the same score are identical.
 */
export function traceDocument(doc: ParsedSidwave, options: { calls?: number; loop?: boolean } = {}): DocTrace {
  const compile = compileSidwaveToPrg(doc, options.loop === undefined ? {} : { loop: options.loop });
  const mem = new Uint8Array(0x10000);
  mem.set(compile.prg.subarray(2), compile.loadAddress);
  mem[0xea31] = 0x60; // the KERNAL IRQ routine the player chains to
  mem[0x02a6] = doc.song.mode === "NTSC" ? 0 : 1;
  let raster = 100;
  let writes: Array<[number, number]> = [];
  const cpu = new Cpu6502(mem, {
    write(address, value) {
      if (address >= 0xd400 && address < 0xd800) writes.push([address - 0xd400, value]);
    },
    read(address) {
      if (address === 0xd012) return (raster = (raster + 1) % 312) & 0xff;
      return undefined;
    },
  });
  const initCycles = cpu.call(compile.initAddress);
  writes = [];
  const total = options.calls ?? compile.totalFrames;
  const calls: TraceCall[] = [];
  for (let i = 0; i < total; i++) {
    writes = [];
    const cycles = cpu.call(compile.playAddress);
    calls.push({ writes, cycles });
  }
  return { compile, calls, initCycles };
}

export function worstCycles(trace: DocTrace): number {
  return trace.calls.reduce((worst, call) => Math.max(worst, call.cycles), 0);
}
