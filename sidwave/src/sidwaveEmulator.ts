// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

/**
 * A small NMOS 6502 interpreter for measuring the player: official opcodes only, no decimal mode, no interrupts.
 * Its cycle model is the one of test/helpers/sidwaveEmulator.mjs: base cycles per instruction, plus one for a taken
 * branch and one for a page crossing on an indexed read or a branch. The game build uses it to run a compiled score
 * and report the cycles of each play call.
 */

type Mode = "imp" | "acc" | "imm" | "rel" | "zp" | "zpx" | "zpy" | "abs" | "abx" | "aby" | "izx" | "izy" | "ind";

/** Opcodes by mnemonic: [opcode, addressing mode] pairs. */
const OPCODES: Record<string, Array<[number, Mode]>> = {
  ADC: [[0x69, "imm"], [0x65, "zp"], [0x75, "zpx"], [0x6d, "abs"], [0x7d, "abx"], [0x79, "aby"], [0x61, "izx"], [0x71, "izy"]],
  AND: [[0x29, "imm"], [0x25, "zp"], [0x35, "zpx"], [0x2d, "abs"], [0x3d, "abx"], [0x39, "aby"], [0x21, "izx"], [0x31, "izy"]],
  ASL: [[0x0a, "acc"], [0x06, "zp"], [0x16, "zpx"], [0x0e, "abs"], [0x1e, "abx"]],
  BIT: [[0x24, "zp"], [0x2c, "abs"]],
  BPL: [[0x10, "rel"]], BMI: [[0x30, "rel"]], BVC: [[0x50, "rel"]], BVS: [[0x70, "rel"]],
  BCC: [[0x90, "rel"]], BCS: [[0xb0, "rel"]], BNE: [[0xd0, "rel"]], BEQ: [[0xf0, "rel"]],
  CMP: [[0xc9, "imm"], [0xc5, "zp"], [0xd5, "zpx"], [0xcd, "abs"], [0xdd, "abx"], [0xd9, "aby"], [0xc1, "izx"], [0xd1, "izy"]],
  CPX: [[0xe0, "imm"], [0xe4, "zp"], [0xec, "abs"]],
  CPY: [[0xc0, "imm"], [0xc4, "zp"], [0xcc, "abs"]],
  DEC: [[0xc6, "zp"], [0xd6, "zpx"], [0xce, "abs"], [0xde, "abx"]],
  EOR: [[0x49, "imm"], [0x45, "zp"], [0x55, "zpx"], [0x4d, "abs"], [0x5d, "abx"], [0x59, "aby"], [0x41, "izx"], [0x51, "izy"]],
  CLC: [[0x18, "imp"]], SEC: [[0x38, "imp"]], CLI: [[0x58, "imp"]], SEI: [[0x78, "imp"]],
  CLV: [[0xb8, "imp"]], CLD: [[0xd8, "imp"]], SED: [[0xf8, "imp"]],
  INC: [[0xe6, "zp"], [0xf6, "zpx"], [0xee, "abs"], [0xfe, "abx"]],
  JMP: [[0x4c, "abs"], [0x6c, "ind"]], JSR: [[0x20, "abs"]],
  LDA: [[0xa9, "imm"], [0xa5, "zp"], [0xb5, "zpx"], [0xad, "abs"], [0xbd, "abx"], [0xb9, "aby"], [0xa1, "izx"], [0xb1, "izy"]],
  LDX: [[0xa2, "imm"], [0xa6, "zp"], [0xb6, "zpy"], [0xae, "abs"], [0xbe, "aby"]],
  LDY: [[0xa0, "imm"], [0xa4, "zp"], [0xb4, "zpx"], [0xac, "abs"], [0xbc, "abx"]],
  LSR: [[0x4a, "acc"], [0x46, "zp"], [0x56, "zpx"], [0x4e, "abs"], [0x5e, "abx"]],
  NOP: [[0xea, "imp"]],
  ORA: [[0x09, "imm"], [0x05, "zp"], [0x15, "zpx"], [0x0d, "abs"], [0x1d, "abx"], [0x19, "aby"], [0x01, "izx"], [0x11, "izy"]],
  TAX: [[0xaa, "imp"]], TXA: [[0x8a, "imp"]], DEX: [[0xca, "imp"]], INX: [[0xe8, "imp"]],
  TAY: [[0xa8, "imp"]], TYA: [[0x98, "imp"]], DEY: [[0x88, "imp"]], INY: [[0xc8, "imp"]],
  ROL: [[0x2a, "acc"], [0x26, "zp"], [0x36, "zpx"], [0x2e, "abs"], [0x3e, "abx"]],
  ROR: [[0x6a, "acc"], [0x66, "zp"], [0x76, "zpx"], [0x6e, "abs"], [0x7e, "abx"]],
  RTS: [[0x60, "imp"]], RTI: [[0x40, "imp"]], BRK: [[0x00, "imp"]],
  SBC: [[0xe9, "imm"], [0xe5, "zp"], [0xf5, "zpx"], [0xed, "abs"], [0xfd, "abx"], [0xf9, "aby"], [0xe1, "izx"], [0xf1, "izy"]],
  STA: [[0x85, "zp"], [0x95, "zpx"], [0x8d, "abs"], [0x9d, "abx"], [0x99, "aby"], [0x81, "izx"], [0x91, "izy"]],
  STX: [[0x86, "zp"], [0x96, "zpy"], [0x8e, "abs"]], STY: [[0x84, "zp"], [0x94, "zpx"], [0x8c, "abs"]],
  TSX: [[0xba, "imp"]], TXS: [[0x9a, "imp"]],
  PHA: [[0x48, "imp"]], PLA: [[0x68, "imp"]], PHP: [[0x08, "imp"]], PLP: [[0x28, "imp"]],
};

const RMW = new Set(["ASL", "LSR", "ROL", "ROR", "INC", "DEC"]);

function cycleCost(name: string, mode: Mode): number {
  if (name === "JSR" || name === "RTS" || name === "RTI") return 6;
  if (name === "BRK") return 7;
  if (name === "JMP") return mode === "ind" ? 5 : 3;
  if (name === "PHA" || name === "PHP") return 3;
  if (name === "PLA" || name === "PLP") return 4;
  if (mode === "imp" || mode === "acc" || mode === "imm" || mode === "rel") return 2;
  if (RMW.has(name)) return ({ zp: 5, zpx: 6, abs: 6, abx: 7 } as Record<string, number>)[mode]!;
  if (name.startsWith("ST")) return ({ zp: 3, zpx: 4, zpy: 4, abs: 4, abx: 5, aby: 5, izx: 6, izy: 6 } as Record<string, number>)[mode]!;
  return ({ zp: 3, zpx: 4, zpy: 4, abs: 4, abx: 4, aby: 4, izx: 6, izy: 5 } as Record<string, number>)[mode]!;
}

/** Instruction handler: `address` is the effective address, or -1 for the accumulator. */
type Handler = (cpu: Cpu6502, address: number) => void;

const HANDLERS: Record<string, Handler> = {
  LDA: (c, ad) => { c.a = c.nz(c.rd(ad)); }, LDX: (c, ad) => { c.x = c.nz(c.rd(ad)); }, LDY: (c, ad) => { c.y = c.nz(c.rd(ad)); },
  STA: (c, ad) => c.wr(ad, c.a), STX: (c, ad) => c.wr(ad, c.x), STY: (c, ad) => c.wr(ad, c.y),
  ADC: (c, ad) => c.add(c.rd(ad)), SBC: (c, ad) => c.add(c.rd(ad) ^ 0xff),
  AND: (c, ad) => { c.a = c.nz(c.a & c.rd(ad)); }, ORA: (c, ad) => { c.a = c.nz(c.a | c.rd(ad)); }, EOR: (c, ad) => { c.a = c.nz(c.a ^ c.rd(ad)); },
  CMP: (c, ad) => c.compare(c.a, c.rd(ad)), CPX: (c, ad) => c.compare(c.x, c.rd(ad)), CPY: (c, ad) => c.compare(c.y, c.rd(ad)),
  BIT: (c, ad) => { const v = c.rd(ad); c.z = +((c.a & v) === 0); c.n = v >> 7; c.v = (v >> 6) & 1; },
  ASL: (c, ad) => c.modify(ad, (v) => { c.c = v >> 7; return v << 1; }),
  LSR: (c, ad) => c.modify(ad, (v) => { c.c = v & 1; return v >> 1; }),
  ROL: (c, ad) => c.modify(ad, (v) => { const r = (v << 1) | c.c; c.c = v >> 7; return r; }),
  ROR: (c, ad) => c.modify(ad, (v) => { const r = (v >> 1) | (c.c << 7); c.c = v & 1; return r; }),
  INC: (c, ad) => c.modify(ad, (v) => v + 1), DEC: (c, ad) => c.modify(ad, (v) => v - 1),
  INX: (c) => { c.x = c.nz(c.x + 1); }, INY: (c) => { c.y = c.nz(c.y + 1); },
  DEX: (c) => { c.x = c.nz(c.x - 1); }, DEY: (c) => { c.y = c.nz(c.y - 1); },
  TAX: (c) => { c.x = c.nz(c.a); }, TAY: (c) => { c.y = c.nz(c.a); },
  TXA: (c) => { c.a = c.nz(c.x); }, TYA: (c) => { c.a = c.nz(c.y); },
  TSX: (c) => { c.x = c.nz(c.sp); }, TXS: (c) => { c.sp = c.x; },
  PHA: (c) => c.push(c.a), PLA: (c) => { c.a = c.nz(c.pop()); },
  PHP: (c) => c.push(0x30 | (c.n << 7) | (c.v << 6) | (c.d << 3) | (c.i << 2) | (c.z << 1) | c.c),
  PLP: (c) => { const p = c.pop(); c.n = p >> 7; c.v = (p >> 6) & 1; c.d = (p >> 3) & 1; c.i = (p >> 2) & 1; c.z = (p >> 1) & 1; c.c = p & 1; },
  CLC: (c) => { c.c = 0; }, SEC: (c) => { c.c = 1; }, CLI: (c) => { c.i = 0; }, SEI: (c) => { c.i = 1; },
  CLD: (c) => { c.d = 0; }, SED: (c) => { c.d = 1; }, CLV: (c) => { c.v = 0; }, NOP: () => {},
  BPL: (c) => c.branch(!c.n), BMI: (c) => c.branch(!!c.n), BVC: (c) => c.branch(!c.v), BVS: (c) => c.branch(!!c.v),
  BCC: (c) => c.branch(!c.c), BCS: (c) => c.branch(!!c.c), BNE: (c) => c.branch(!c.z), BEQ: (c) => c.branch(!!c.z),
  JMP: (c, ad) => { c.pc = ad; },
  JSR: (c, ad) => { const ret = (c.pc - 1) & 0xffff; c.push(ret >> 8); c.push(ret & 0xff); c.pc = ad; },
  RTI: (c) => {
    HANDLERS.PLP!(c, 0);
    const low = c.pop();
    c.pc = low | (c.pop() << 8);
  },
  // BRK pushes the address after its padding byte and the status with the break flag, then takes the IRQ vector.
  BRK: (c) => {
    const ret = (c.pc + 1) & 0xffff;
    c.push(ret >> 8);
    c.push(ret & 0xff);
    HANDLERS.PHP!(c, 0);
    c.i = 1;
    c.pc = c.mem[0xfffe]! | (c.mem[0xffff]! << 8);
  },
  RTS: (c) => { const low = c.pop(); c.pc = (((c.pop() << 8) | low) + 1) & 0xffff; },
};

/** Per opcode: handler, addressing mode, base cycles and whether a page crossing on an indexed read costs a cycle. */
const OP_FN: Array<Handler | undefined> = [];
const OP_MODE: Mode[] = [];
const OP_COST: number[] = [];
const OP_PENALTY: boolean[] = [];
for (const [name, list] of Object.entries(OPCODES)) {
  for (const [op, mode] of list) {
    OP_FN[op] = HANDLERS[name]!;
    OP_MODE[op] = mode;
    OP_COST[op] = cycleCost(name, mode);
    OP_PENALTY[op] = !name.startsWith("ST") && !RMW.has(name);
  }
}

export interface CpuHooks {
  /** Called for every write, after the value has been masked to a byte. */
  write?(address: number, value: number): void;
  /** Returns a value to override the memory byte at `address`, or undefined to read memory. */
  read?(address: number): number | undefined;
}

/** Return address pushed by {@link Cpu6502.call}: execution stops when the callee returns to it. */
const RETURN_TRAP = 0xfff0;

export class Cpu6502 {
  a = 0; x = 0; y = 0; sp = 0xfd; pc = 0;
  c = 0; z = 0; i = 1; d = 0; v = 0; n = 0;
  steps = 0;
  cycles = 0;
  /** Lowest stack pointer seen since the start of the last call (the stack grows down from $FF). */
  minSp = 0xff;
  /** Bytes of stack the last {@link call} used, counting the return address pushed for it. */
  lastStackDepth = 0;

  constructor(readonly mem: Uint8Array, private readonly hooks: CpuHooks = {}) {}

  /** @internal Instruction handlers use these members. */
  rd(address: number): number {
    address &= 0xffff;
    const override = this.hooks.read?.(address);
    return override === undefined ? this.mem[address]! : override;
  }
  wr(address: number, value: number): void {
    address &= 0xffff;
    this.hooks.write?.(address, value & 0xff);
    this.mem[address] = value & 0xff;
  }
  push(value: number): void {
    this.mem[0x100 + this.sp] = value & 0xff;
    this.sp = (this.sp - 1) & 0xff;
    if (this.sp < this.minSp) this.minSp = this.sp;
  }
  pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.mem[0x100 + this.sp]!;
  }
  nz(value: number): number {
    value &= 0xff;
    this.z = +(value === 0);
    this.n = value >> 7;
    return value;
  }
  add(value: number): void {
    const sum = this.a + value + this.c;
    this.v = (~(this.a ^ value) & (this.a ^ sum) & 0x80) ? 1 : 0;
    this.c = +(sum > 0xff);
    this.a = this.nz(sum);
  }
  compare(register: number, value: number): void {
    this.c = +(register >= value);
    this.nz(register - value);
  }
  modify(address: number, fn: (value: number) => number): void {
    if (address < 0) {
      this.a = this.nz(fn(this.a));
    } else {
      this.wr(address, this.nz(fn(this.rd(address))));
    }
  }
  branch(taken: boolean): void {
    const offset = this.fetch();
    if (taken) {
      this.cycles += 1;
      this.pc = this.indexed(this.pc, (offset << 24) >> 24, true);
    }
  }

  private fetch(): number {
    const value = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }
  private fetch16(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }
  private zp16(address: number): number {
    return this.mem[address & 0xff]! | (this.mem[(address + 1) & 0xff]! << 8);
  }
  private indexed(base: number, index: number, penalty: boolean): number {
    const address = (base + index) & 0xffff;
    if (penalty && address >> 8 !== base >> 8) this.cycles += 1;
    return address;
  }
  private effective(mode: Mode, penalty: boolean): number {
    switch (mode) {
      case "zp": return this.fetch();
      case "zpx": return (this.fetch() + this.x) & 0xff;
      case "zpy": return (this.fetch() + this.y) & 0xff;
      case "abs": return this.fetch16();
      case "abx": return this.indexed(this.fetch16(), this.x, penalty);
      case "aby": return this.indexed(this.fetch16(), this.y, penalty);
      case "izx": return this.zp16((this.fetch() + this.x) & 0xff);
      case "izy": return this.indexed(this.zp16(this.fetch()), this.y, penalty);
      case "ind": {
        const pointer = this.fetch16();
        return this.rd(pointer) | (this.rd((pointer & 0xff00) | ((pointer + 1) & 0xff)) << 8);
      }
      case "imm": {
        const address = this.pc;
        this.pc = (this.pc + 1) & 0xffff;
        return address;
      }
      case "acc": return -1;
      default: return 0;
    }
  }

  step(): void {
    const at = this.pc;
    const op = this.fetch();
    const fn = OP_FN[op];
    if (!fn) throw new Error(`illegal opcode $${op.toString(16)} at $${at.toString(16)}`);
    if (this.d) throw new Error("decimal mode is not expected in the player");
    this.steps += 1;
    this.cycles += OP_COST[op]!;
    fn(this, this.effective(OP_MODE[op]!, OP_PENALTY[op]!));
  }

  /**
   * Calls the subroutine at `address` with the given registers and returns the number of cycles until it returns.
   * The stack depth the callee used (the return address pushed for it included) is left in {@link lastStackDepth}.
   */
  call(address: number, registers: { a?: number; x?: number; y?: number } = {}, limit = 1_000_000): number {
    this.a = registers.a ?? 0;
    if (registers.x !== undefined) this.x = registers.x;
    if (registers.y !== undefined) this.y = registers.y;
    this.push((RETURN_TRAP - 1) >> 8);
    this.push((RETURN_TRAP - 1) & 0xff);
    const base = (this.sp + 2) & 0xff;
    this.minSp = this.sp;
    this.pc = address;
    const startSteps = this.steps;
    const startCycles = this.cycles;
    while (!(this.pc === RETURN_TRAP && this.sp === base)) {
      this.step();
      if (this.steps - startSteps > limit) throw new Error(`call $${address.toString(16)} did not return (pc=$${this.pc.toString(16)})`);
    }
    this.lastStackDepth = base - this.minSp;
    return this.cycles - startCycles;
  }
}
