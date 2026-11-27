// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { ParsedSidwave } from "../sidwave.js";
import { compileSidwaveToPrg, type CompileResult } from "../sidwaveCompiler.js";
import { OP_TABLE } from "../sidwaveEmulator.js";

/**
 * A register-write trace of a compiled score on a fast 6502 interpreter. It runs init and the play routine of the PRG, as
 * the bundled interpreter of `sidwaveEmulator.ts` does (same opcodes, same cycle model), but keeps the state in local
 * variables and records only the SID writes, so a three-minute score traces in about a hundred milliseconds. No audio is
 * produced: the comparison of register writes needs none.
 */
export interface DocTrace {
  compile: CompileResult;
  /** Player calls traced. */
  callCount: number;
  /** Cycles of each call. */
  cycles: Int32Array;
  /** `writes[starts[i]..starts[i + 1])` are the SID writes of call i, each `(offset from $D400) << 8 | value`. */
  starts: Uint32Array;
  writes: Uint32Array;
  initCycles: number;
}

const enum Op { ADC, AND, ASL, BIT, BPL, BMI, BVC, BVS, BCC, BCS, BNE, BEQ, BRK, CMP, CPX, CPY, DEC, EOR, CLC, SEC, CLI, SEI, CLV, CLD, SED, INC, JMP, JSR, LDA, LDX, LDY, LSR, NOP, ORA, TAX, TXA, DEX, INX, TAY, TYA, DEY, INY, ROL, ROR, RTS, RTI, SBC, STA, STX, STY, TSX, TXS, PHA, PLA, PHP, PLP }
const MODES = ["imp", "acc", "imm", "rel", "zp", "zpx", "zpy", "abs", "abx", "aby", "izx", "izy", "ind"];
const NAMES = [
  "ADC", "AND", "ASL", "BIT", "BPL", "BMI", "BVC", "BVS", "BCC", "BCS", "BNE", "BEQ", "BRK", "CMP", "CPX", "CPY", "DEC", "EOR",
  "CLC", "SEC", "CLI", "SEI", "CLV", "CLD", "SED", "INC", "JMP", "JSR", "LDA", "LDX", "LDY", "LSR", "NOP", "ORA", "TAX", "TXA",
  "DEX", "INX", "TAY", "TYA", "DEY", "INY", "ROL", "ROR", "RTS", "RTI", "SBC", "STA", "STX", "STY", "TSX", "TXS", "PHA", "PLA",
  "PHP", "PLP",
];
/** Per opcode, packed: mnemonic (bits 0-7), addressing mode (8-11), base cycles (12-15), read penalty (16); 0 for an unknown opcode. */
const OPS = new Int32Array(256).fill(-1);
OP_TABLE.forEach((entry, op) => {
  if (!entry) return;
  OPS[op] = NAMES.indexOf(entry.name) | (MODES.indexOf(entry.mode) << 8) | (entry.cost << 12) | ((entry.penalty ? 1 : 0) << 16);
});

const RETURN_TRAP = 0xfff0;

/**
 * A 6502 with the registers in local variables of one function, so the interpreter loop stays in registers. `call` runs
 * the subroutine at `address` until it returns to the trap and returns its cycles.
 */
function makeCpu(mem: Uint8Array, onWrite: (offset: number, value: number) => void) {
  const st = { a: 0, x: 0, y: 0, sp: 0xfd, c: 0, z: 0, n: 0, v: 0, d: 0, raster: 100, cycles: 0 };
  function call(address: number): number {
    let { a, x, y, sp, c, z, n, v, d, raster, cycles } = st;
    const start = cycles;
    mem[0x100 + sp] = (RETURN_TRAP - 1) >> 8; sp = (sp - 1) & 0xff;
    mem[0x100 + sp] = (RETURN_TRAP - 1) & 0xff; sp = (sp - 1) & 0xff;
    const base = (sp + 2) & 0xff;
    let pc = address;
    while (pc !== RETURN_TRAP || sp !== base) {
      const op = mem[pc]!;
      pc = (pc + 1) & 0xffff;
      const info = OPS[op]!;
      if (info < 0) throw new Error(`illegal opcode $${op.toString(16)}`);
      const id = info & 0xff;
      const pen = info >> 16;
      cycles += (info >> 12) & 15;
      let ea = 0;
      switch ((info >> 8) & 15) {
        case 2: ea = pc; pc = (pc + 1) & 0xffff; break;
        case 4: ea = mem[pc]!; pc = (pc + 1) & 0xffff; break;
        case 5: ea = (mem[pc]! + x) & 0xff; pc = (pc + 1) & 0xffff; break;
        case 6: ea = (mem[pc]! + y) & 0xff; pc = (pc + 1) & 0xffff; break;
        case 7: ea = mem[pc]! | (mem[(pc + 1) & 0xffff]! << 8); pc = (pc + 2) & 0xffff; break;
        case 8: { const b = mem[pc]! | (mem[(pc + 1) & 0xffff]! << 8); pc = (pc + 2) & 0xffff; ea = (b + x) & 0xffff; if (pen && ea >> 8 !== b >> 8) cycles++; break; }
        case 9: { const b = mem[pc]! | (mem[(pc + 1) & 0xffff]! << 8); pc = (pc + 2) & 0xffff; ea = (b + y) & 0xffff; if (pen && ea >> 8 !== b >> 8) cycles++; break; }
        case 10: { const p = (mem[pc]! + x) & 0xff; pc = (pc + 1) & 0xffff; ea = mem[p]! | (mem[(p + 1) & 0xff]! << 8); break; }
        case 11: { const p = mem[pc]!; pc = (pc + 1) & 0xffff; const b = mem[p]! | (mem[(p + 1) & 0xff]! << 8); ea = (b + y) & 0xffff; if (pen && ea >> 8 !== b >> 8) cycles++; break; }
        case 12: { const p = mem[pc]! | (mem[(pc + 1) & 0xffff]! << 8); pc = (pc + 2) & 0xffff; ea = mem[p]! | (mem[(p & 0xff00) | ((p + 1) & 0xff)]! << 8); break; }
        case 1: ea = -1; break;
        default: break;
      }
      let m = 0;
      switch (id) {
        case Op.LDA: m = ea === 0xd012 ? (raster = (raster + 1) % 312) & 0xff : mem[ea]!; a = m; z = m === 0 ? 1 : 0; n = m >> 7; break;
        case Op.LDX: m = ea === 0xd012 ? (raster = (raster + 1) % 312) & 0xff : mem[ea]!; x = m; z = m === 0 ? 1 : 0; n = m >> 7; break;
        case Op.LDY: m = ea === 0xd012 ? (raster = (raster + 1) % 312) & 0xff : mem[ea]!; y = m; z = m === 0 ? 1 : 0; n = m >> 7; break;
        case Op.STA: if (ea >= 0xd400 && ea < 0xd800) onWrite(ea - 0xd400, a); mem[ea] = a; break;
        case Op.STX: if (ea >= 0xd400 && ea < 0xd800) onWrite(ea - 0xd400, x); mem[ea] = x; break;
        case Op.STY: if (ea >= 0xd400 && ea < 0xd800) onWrite(ea - 0xd400, y); mem[ea] = y; break;
        case Op.ADC: case Op.SBC: {
          m = ea === 0xd012 ? (raster = (raster + 1) % 312) & 0xff : mem[ea]!;
          if (id === Op.SBC) m ^= 0xff;
          const sum = a + m + c;
          v = (~(a ^ m) & (a ^ sum) & 0x80) ? 1 : 0;
          c = sum > 0xff ? 1 : 0;
          a = sum & 0xff; z = a === 0 ? 1 : 0; n = a >> 7;
          break;
        }
        case Op.AND: a &= mem[ea]!; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.ORA: a |= mem[ea]!; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.EOR: a ^= mem[ea]!; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.CMP: case Op.CPX: case Op.CPY: {
          m = mem[ea]!;
          const r = id === Op.CMP ? a : id === Op.CPX ? x : y;
          c = r >= m ? 1 : 0;
          const t = (r - m) & 0xff; z = t === 0 ? 1 : 0; n = t >> 7;
          break;
        }
        case Op.BIT: m = mem[ea]!; z = (a & m) === 0 ? 1 : 0; n = m >> 7; v = (m >> 6) & 1; break;
        case Op.ASL: case Op.LSR: case Op.ROL: case Op.ROR: case Op.INC: case Op.DEC: {
          m = ea < 0 ? a : mem[ea]!;
          let r: number;
          if (id === Op.ASL) { c = m >> 7; r = m << 1; }
          else if (id === Op.LSR) { c = m & 1; r = m >> 1; }
          else if (id === Op.ROL) { r = (m << 1) | c; c = m >> 7; }
          else if (id === Op.ROR) { r = (m >> 1) | (c << 7); c = m & 1; }
          else if (id === Op.INC) r = m + 1;
          else r = m - 1;
          r &= 0xff; z = r === 0 ? 1 : 0; n = r >> 7;
          if (ea < 0) a = r;
          else { if (ea >= 0xd400 && ea < 0xd800) onWrite(ea - 0xd400, r); mem[ea] = r; }
          break;
        }
        case Op.INX: x = (x + 1) & 0xff; z = x === 0 ? 1 : 0; n = x >> 7; break;
        case Op.INY: y = (y + 1) & 0xff; z = y === 0 ? 1 : 0; n = y >> 7; break;
        case Op.DEX: x = (x - 1) & 0xff; z = x === 0 ? 1 : 0; n = x >> 7; break;
        case Op.DEY: y = (y - 1) & 0xff; z = y === 0 ? 1 : 0; n = y >> 7; break;
        case Op.TAX: x = a; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.TAY: y = a; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.TXA: a = x; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.TYA: a = y; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.TSX: x = sp; z = x === 0 ? 1 : 0; n = x >> 7; break;
        case Op.TXS: sp = x; break;
        case Op.PHA: mem[0x100 + sp] = a; sp = (sp - 1) & 0xff; break;
        case Op.PLA: sp = (sp + 1) & 0xff; a = mem[0x100 + sp]!; z = a === 0 ? 1 : 0; n = a >> 7; break;
        case Op.PHP: mem[0x100 + sp] = 0x34 | (n << 7) | (v << 6) | (d << 3) | (z << 1) | c; sp = (sp - 1) & 0xff; break;
        case Op.PLP: { sp = (sp + 1) & 0xff; const p = mem[0x100 + sp]!; n = p >> 7; v = (p >> 6) & 1; d = (p >> 3) & 1; z = (p >> 1) & 1; c = p & 1; break; }
        case Op.CLC: c = 0; break;
        case Op.SEC: c = 1; break;
        case Op.CLD: d = 0; break;
        case Op.SED: throw new Error("decimal mode is not expected in the player");
        case Op.CLV: v = 0; break;
        case Op.CLI: case Op.SEI: case Op.NOP: break;
        case Op.BPL: case Op.BMI: case Op.BVC: case Op.BVS: case Op.BCC: case Op.BCS: case Op.BNE: case Op.BEQ: {
          const taken = id === Op.BPL ? !n : id === Op.BMI ? n === 1 : id === Op.BVC ? !v : id === Op.BVS ? v === 1
            : id === Op.BCC ? !c : id === Op.BCS ? c === 1 : id === Op.BNE ? !z : z === 1;
          const offset = mem[pc]!;
          pc = (pc + 1) & 0xffff;
          if (taken) {
            cycles += 1;
            if (cycles - start > 20_000_000) throw new Error(`call $${address.toString(16)} did not return`);
            const target = (pc + ((offset << 24) >> 24)) & 0xffff;
            if (target >> 8 !== pc >> 8) cycles += 1;
            pc = target;
          }
          break;
        }
        case Op.JMP: pc = ea; if (cycles - start > 20_000_000) throw new Error(`call $${address.toString(16)} did not return`); break;
        case Op.JSR: { const ret = (pc - 1) & 0xffff; mem[0x100 + sp] = ret >> 8; sp = (sp - 1) & 0xff; mem[0x100 + sp] = ret & 0xff; sp = (sp - 1) & 0xff; pc = ea; break; }
        case Op.RTS: { sp = (sp + 1) & 0xff; const low = mem[0x100 + sp]!; sp = (sp + 1) & 0xff; pc = (((mem[0x100 + sp]! << 8) | low) + 1) & 0xffff; break; }
        case Op.RTI: { sp = (sp + 1) & 0xff; const p = mem[0x100 + sp]!; n = p >> 7; v = (p >> 6) & 1; d = (p >> 3) & 1; z = (p >> 1) & 1; c = p & 1; sp = (sp + 1) & 0xff; const low = mem[0x100 + sp]!; sp = (sp + 1) & 0xff; pc = low | (mem[0x100 + sp]! << 8); break; }
        case Op.BRK: { const ret = (pc + 1) & 0xffff; mem[0x100 + sp] = ret >> 8; sp = (sp - 1) & 0xff; mem[0x100 + sp] = ret & 0xff; sp = (sp - 1) & 0xff; mem[0x100 + sp] = 0x34 | (n << 7) | (v << 6) | (d << 3) | (z << 1) | c; sp = (sp - 1) & 0xff; pc = mem[0xfffe]! | (mem[0xffff]! << 8); break; }
        default: throw new Error(`unhandled opcode $${op.toString(16)}`);
      }
    }
    st.a = a; st.x = x; st.y = y; st.sp = sp; st.c = c; st.z = z; st.n = n; st.v = v; st.d = d; st.raster = raster; st.cycles = cycles;
    return cycles - start;
  }
  return { call };
}

/**
 * Compiles the score to its PRG and runs init and up to `calls` play calls (default and limit: one pass of the score).
 * Pass an already compiled result to avoid compiling again.
 */
export function traceDocument(doc: ParsedSidwave, options: { calls?: number; loop?: boolean; compiled?: CompileResult } = {}): DocTrace {
  const compile = options.compiled ?? compileSidwaveToPrg(doc, options.loop === undefined ? {} : { loop: options.loop });
  const mem = new Uint8Array(0x10000);
  mem.set(compile.prg.subarray(2), compile.loadAddress);
  mem[0xea31] = 0x60; // the KERNAL IRQ routine the player chains to
  mem[0x02a6] = doc.song.mode === "NTSC" ? 0 : 1;
  const total = Math.min(options.calls ?? compile.totalFrames, compile.totalFrames);
  let writes = new Uint32Array(Math.max(1024, total * 16));
  let count = 0;
  const cpu = makeCpu(mem, (offset, value) => {
    if (count === writes.length) { const grown = new Uint32Array(writes.length * 2); grown.set(writes); writes = grown; }
    writes[count++] = (offset << 8) | value;
  });
  const initCycles = cpu.call(compile.initAddress);
  count = 0;
  const cycles = new Int32Array(total);
  const starts = new Uint32Array(total + 1);
  for (let i = 0; i < total; i++) {
    starts[i] = count;
    cycles[i] = cpu.call(compile.playAddress);
  }
  starts[total] = count;
  return { compile, callCount: total, cycles, starts, writes: writes.subarray(0, count), initCycles };
}

export function worstCycles(trace: DocTrace): number {
  let worst = 0;
  for (let i = 0; i < trace.callCount; i++) if (trace.cycles[i]! > worst) worst = trace.cycles[i]!;
  return worst;
}
