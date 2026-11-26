import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg } from "6502-toolkit/assembler";
import { Cpu6502 } from "../src/sidwaveEmulator.js";
import { Cpu } from "./helpers/sidwaveEmulator.mjs";

// A program that uses every mnemonic and addressing mode the emulator knows, with page crossings and taken branches.
const PROGRAM = `
* = $20E0
start:
  ldx #$05
  ldy #$03
  lda #$a5
  sta $10
  sta $11,x
  sta $0200
  sta $0200,x
  sta $0200,y
  stx $12
  sty $13
  stx $14,y
  sty $15,x
  lda #$00
  sta $20
  lda #$30
  sta $21
  ldx #0
  lda ($20,x)
  ldy #$ff
  lda ($20),y
  sta ($20),y
  ldx #$ff
  lda $2008,x
  lda $2008,y
  ldx $2008,y
  ldy $2008,x
  ldx $10
  ldy $11
  ldx $12,y
  ldy $13,x
  ldx $2000
  ldy $2001
  lda $10
  lda $11,x
  lda $2000
  adc #$01
  adc $10
  adc $11,x
  adc $2000
  adc $2000,x
  adc $2000,y
  adc ($20,x)
  adc ($20),y
  sbc #$01
  sbc $10
  sbc $2000
  sbc $2000,x
  sbc $2000,y
  and #$f0
  and $10
  and $2000,x
  ora #$0f
  ora $10
  ora $2000,y
  eor #$ff
  eor $10
  eor $2000,x
  cmp #$40
  cmp $10
  cmp $2000,x
  cpx #$10
  cpx $10
  cpx $2000
  cpy #$10
  cpy $10
  cpy $2000
  bit $10
  bit $2000
  asl
  asl $10
  asl $11,x
  asl $2000
  asl $2000,x
  lsr
  lsr $10
  lsr $11,x
  lsr $2000
  lsr $2000,x
  rol
  rol $10
  rol $11,x
  rol $2000
  rol $2000,x
  sec
  ror
  ror $10
  ror $11,x
  ror $2000
  ror $2000,x
  inc $10
  inc $11,x
  inc $2000
  inc $2000,x
  dec $10
  dec $11,x
  dec $2000
  dec $2000,x
  inx
  iny
  dex
  dey
  tax
  tay
  txa
  tya
  tsx
  txs
  pha
  pla
  php
  plp
  clc
  sec
  cli
  sei
  clv
  cld
  nop
  ldx #3
loop1:
  dex
  bne loop1
  ldx #0
  beq t1
  nop
t1:
  bpl t2
  nop
t2:
  bmi t3
  nop
t3:
  bvc t4
  nop
t4:
  bvs t5
  nop
t5:
  bcc t6
  nop
t6:
  bcs t7
  nop
t7:
  jsr sub
  jmp ($2300)
back:
  rts
sub:
  lda #1
  rts
.org $2300
  .word back
.org $2010
  .byte $12,$34,$56,$78,$9a,$bc,$de,$f0
`;

test("the bundled emulator matches the test helper emulator on a program that uses every instruction", () => {
  const run = (make) => {
    const writes = [];
    const mem = new Uint8Array(65536);
    const image = assemblyToPrg(PROGRAM);
    const load = image.readUInt16LE(0);
    mem.set(image.subarray(2), load);
    const cpu = make(mem, { write: (a, v) => writes.push([a, v]), read: (a) => (a === 0xd012 ? 0x77 : undefined) });
    return { cpu, mem, writes };
  };
  const ours = run((mem, hooks) => new Cpu6502(mem, hooks));
  const theirs = run((mem, hooks) => new Cpu(mem, hooks));
  const cyclesOurs = ours.cpu.call(0x20e0, { a: 0x41 });
  const cyclesTheirs = theirs.cpu.call(0x20e0, 0x41);
  assert.equal(cyclesOurs, cyclesTheirs);
  assert.deepEqual(
    [ours.cpu.a, ours.cpu.x, ours.cpu.y, ours.cpu.sp, ours.cpu.c, ours.cpu.z, ours.cpu.n, ours.cpu.v, ours.cpu.i, ours.cpu.steps],
    [theirs.cpu.a, theirs.cpu.x, theirs.cpu.y, theirs.cpu.sp, theirs.cpu.c, theirs.cpu.z, theirs.cpu.n, theirs.cpu.v, theirs.cpu.i, theirs.cpu.steps]);
  assert.deepEqual(ours.writes, theirs.writes);
  assert.deepEqual(ours.mem, theirs.mem);
  assert.deepEqual([ours.cpu.steps, ours.writes.length, cyclesOurs], [141, 36, 505]);
});

test("call counts a taken branch and a page crossing the way the NMOS 6502 does", () => {
  const run = (source, registers = {}) => {
    const image = assemblyToPrg(source);
    const mem = new Uint8Array(65536);
    mem.set(image.subarray(2), image.readUInt16LE(0));
    const cpu = new Cpu6502(mem);
    return cpu.call(image.readUInt16LE(0), registers);
  };
  assert.equal(run("* = $3000\n lda $30ff,x\n rts"), 4 + 6, "no crossing with X = 0");
  assert.equal(run("* = $3000\n lda $30ff,x\n rts", { x: 1 }), 4 + 1 + 6, "a read that crosses a page takes a cycle more");
  assert.equal(run("* = $3000\n sta $30ff,x\n rts", { x: 1 }), 5 + 6, "a store never does");
  assert.equal(run("* = $3000\n ldx #1\n bne skip\n nop\nskip: rts"), 2 + 3 + 6, "a taken branch takes a cycle more");
  assert.equal(run("* = $3000\n ldx #0\n bne skip\n nop\nskip: rts"), 2 + 2 + 2 + 6, "a branch that is not taken does not");
  assert.equal(run("* = $30fb\n ldx #1\n bne skip\n nop\n nop\nskip: rts"), 2 + 3 + 1 + 6, "a taken branch to another page takes two more");
  assert.equal(run("* = $3000\n jmp ($3010)\n.org $3010\n.word $3020\n.org $3020\n rts"), 5 + 6);
});

test("call reports the stack depth of the callee, the return address included", () => {
  const image = assemblyToPrg("* = $3000\n jsr inner\n rts\ninner:\n pha\n jsr leaf\n pla\n rts\nleaf:\n php\n plp\n rts");
  const mem = new Uint8Array(65536);
  mem.set(image.subarray(2), 0x3000);
  const cpu = new Cpu6502(mem);
  cpu.call(0x3000);
  // call's return address (2) + jsr inner (2) + pha (1) + jsr leaf (2) + php (1)
  assert.equal(cpu.lastStackDepth, 8);
  assert.equal(cpu.sp, 0xfd);
});

test("registers can be passed to call, and the hooks see reads and writes", () => {
  const image = assemblyToPrg("* = $3000\n sta $d400\n txa\n sta $d401\n tya\n sta $d402\n lda $d012\n sta $0400\n rts");
  const mem = new Uint8Array(65536);
  mem.set(image.subarray(2), 0x3000);
  const writes = [];
  const cpu = new Cpu6502(mem, { write: (a, v) => writes.push([a, v]), read: (a) => (a === 0xd012 ? 0x99 : undefined) });
  cpu.call(0x3000, { a: 1, x: 2, y: 3 });
  assert.deepEqual(writes, [[0xd400, 1], [0xd401, 2], [0xd402, 3], [0x0400, 0x99]]);
});

test("illegal opcodes, decimal mode and a call that does not return are reported", () => {
  const mem = new Uint8Array(65536);
  mem[0x3000] = 0x02;
  assert.throws(() => new Cpu6502(mem).call(0x3000), /illegal opcode \$2 at \$3000/);
  const decimal = assemblyToPrg("* = $3000\n sed\n adc #1\n rts");
  mem.set(decimal.subarray(2), 0x3000);
  assert.throws(() => new Cpu6502(mem).call(0x3000), /decimal mode is not expected in the player/);
  const spin = assemblyToPrg("* = $3000\nspin: jmp spin");
  mem.set(spin.subarray(2), 0x3000);
  assert.throws(() => new Cpu6502(mem).call(0x3000, {}, 50), /call \$3000 did not return \(pc=\$3000\)/);
});

// ---- cycles per opcode, written out from the NMOS 6502 reference (MOS MCS6500 programming manual) -----------------
// [opcode, mnemonic, mode, cycles, page crossing adds a cycle]. "r" marks the read instructions whose indexed modes
// take a cycle more when the index crosses a page; stores and read-modify-write instructions never do.
const R = true;
const TABLE = [
  [0x69, "ADC", "imm", 2], [0x65, "ADC", "zp", 3], [0x75, "ADC", "zpx", 4], [0x6d, "ADC", "abs", 4], [0x7d, "ADC", "abx", 4, R], [0x79, "ADC", "aby", 4, R], [0x61, "ADC", "izx", 6], [0x71, "ADC", "izy", 5, R],
  [0x29, "AND", "imm", 2], [0x25, "AND", "zp", 3], [0x35, "AND", "zpx", 4], [0x2d, "AND", "abs", 4], [0x3d, "AND", "abx", 4, R], [0x39, "AND", "aby", 4, R], [0x21, "AND", "izx", 6], [0x31, "AND", "izy", 5, R],
  [0x0a, "ASL", "acc", 2], [0x06, "ASL", "zp", 5], [0x16, "ASL", "zpx", 6], [0x0e, "ASL", "abs", 6], [0x1e, "ASL", "abx", 7],
  [0x24, "BIT", "zp", 3], [0x2c, "BIT", "abs", 4],
  [0x00, "BRK", "imp", 7],
  [0x18, "CLC", "imp", 2], [0xd8, "CLD", "imp", 2], [0x58, "CLI", "imp", 2], [0xb8, "CLV", "imp", 2],
  [0xc9, "CMP", "imm", 2], [0xc5, "CMP", "zp", 3], [0xd5, "CMP", "zpx", 4], [0xcd, "CMP", "abs", 4], [0xdd, "CMP", "abx", 4, R], [0xd9, "CMP", "aby", 4, R], [0xc1, "CMP", "izx", 6], [0xd1, "CMP", "izy", 5, R],
  [0xe0, "CPX", "imm", 2], [0xe4, "CPX", "zp", 3], [0xec, "CPX", "abs", 4],
  [0xc0, "CPY", "imm", 2], [0xc4, "CPY", "zp", 3], [0xcc, "CPY", "abs", 4],
  [0xc6, "DEC", "zp", 5], [0xd6, "DEC", "zpx", 6], [0xce, "DEC", "abs", 6], [0xde, "DEC", "abx", 7],
  [0xca, "DEX", "imp", 2], [0x88, "DEY", "imp", 2],
  [0x49, "EOR", "imm", 2], [0x45, "EOR", "zp", 3], [0x55, "EOR", "zpx", 4], [0x4d, "EOR", "abs", 4], [0x5d, "EOR", "abx", 4, R], [0x59, "EOR", "aby", 4, R], [0x41, "EOR", "izx", 6], [0x51, "EOR", "izy", 5, R],
  [0xe6, "INC", "zp", 5], [0xf6, "INC", "zpx", 6], [0xee, "INC", "abs", 6], [0xfe, "INC", "abx", 7],
  [0xe8, "INX", "imp", 2], [0xc8, "INY", "imp", 2],
  [0x4c, "JMP", "abs", 3], [0x6c, "JMP", "ind", 5], [0x20, "JSR", "abs", 6],
  [0xa9, "LDA", "imm", 2], [0xa5, "LDA", "zp", 3], [0xb5, "LDA", "zpx", 4], [0xad, "LDA", "abs", 4], [0xbd, "LDA", "abx", 4, R], [0xb9, "LDA", "aby", 4, R], [0xa1, "LDA", "izx", 6], [0xb1, "LDA", "izy", 5, R],
  [0xa2, "LDX", "imm", 2], [0xa6, "LDX", "zp", 3], [0xb6, "LDX", "zpy", 4], [0xae, "LDX", "abs", 4], [0xbe, "LDX", "aby", 4, R],
  [0xa0, "LDY", "imm", 2], [0xa4, "LDY", "zp", 3], [0xb4, "LDY", "zpx", 4], [0xac, "LDY", "abs", 4], [0xbc, "LDY", "abx", 4, R],
  [0x4a, "LSR", "acc", 2], [0x46, "LSR", "zp", 5], [0x56, "LSR", "zpx", 6], [0x4e, "LSR", "abs", 6], [0x5e, "LSR", "abx", 7],
  [0xea, "NOP", "imp", 2],
  [0x09, "ORA", "imm", 2], [0x05, "ORA", "zp", 3], [0x15, "ORA", "zpx", 4], [0x0d, "ORA", "abs", 4], [0x1d, "ORA", "abx", 4, R], [0x19, "ORA", "aby", 4, R], [0x01, "ORA", "izx", 6], [0x11, "ORA", "izy", 5, R],
  [0x48, "PHA", "imp", 3], [0x08, "PHP", "imp", 3], [0x68, "PLA", "imp", 4], [0x28, "PLP", "imp", 4],
  [0x2a, "ROL", "acc", 2], [0x26, "ROL", "zp", 5], [0x36, "ROL", "zpx", 6], [0x2e, "ROL", "abs", 6], [0x3e, "ROL", "abx", 7],
  [0x6a, "ROR", "acc", 2], [0x66, "ROR", "zp", 5], [0x76, "ROR", "zpx", 6], [0x6e, "ROR", "abs", 6], [0x7e, "ROR", "abx", 7],
  [0x40, "RTI", "imp", 6], [0x60, "RTS", "imp", 6],
  [0xe9, "SBC", "imm", 2], [0xe5, "SBC", "zp", 3], [0xf5, "SBC", "zpx", 4], [0xed, "SBC", "abs", 4], [0xfd, "SBC", "abx", 4, R], [0xf9, "SBC", "aby", 4, R], [0xe1, "SBC", "izx", 6], [0xf1, "SBC", "izy", 5, R],
  [0x38, "SEC", "imp", 2], [0xf8, "SED", "imp", 2], [0x78, "SEI", "imp", 2],
  [0x85, "STA", "zp", 3], [0x95, "STA", "zpx", 4], [0x8d, "STA", "abs", 4], [0x9d, "STA", "abx", 5], [0x99, "STA", "aby", 5], [0x81, "STA", "izx", 6], [0x91, "STA", "izy", 6],
  [0x86, "STX", "zp", 3], [0x96, "STX", "zpy", 4], [0x8e, "STX", "abs", 4],
  [0x84, "STY", "zp", 3], [0x94, "STY", "zpx", 4], [0x8c, "STY", "abs", 4],
  [0xaa, "TAX", "imp", 2], [0xa8, "TAY", "imp", 2], [0xba, "TSX", "imp", 2], [0x8a, "TXA", "imp", 2], [0x9a, "TXS", "imp", 2], [0x98, "TYA", "imp", 2],
];
const BRANCHES = [[0x90, "BCC", "c", 0], [0xb0, "BCS", "c", 1], [0xf0, "BEQ", "z", 1], [0xd0, "BNE", "z", 0], [0x30, "BMI", "n", 1], [0x10, "BPL", "n", 0], [0x70, "BVS", "v", 1], [0x50, "BVC", "v", 0]];

/** Executes the one instruction at `pc` with the given index registers and returns the cycles it took. */
function cyclesOf(pc, bytes, setup = {}) {
  const mem = new Uint8Array(65536);
  mem.set(bytes, pc);
  mem[0x10] = 0xf0; mem[0x11] = 0x30; // ($10) = $30F0
  mem[0xfffe] = 0x00; mem[0xffff] = 0x40; // IRQ vector
  const cpu = new Cpu6502(mem);
  cpu.pc = pc;
  cpu.sp = 0xf0;
  Object.assign(cpu, setup);
  const before = cpu.cycles;
  cpu.step();
  return { cycles: cpu.cycles - before, cpu };
}

test("the table lists the 151 documented NMOS opcodes once, with the 8 branches", () => {
  assert.equal(new Set(TABLE.map(([op]) => op)).size + BRANCHES.length, 151);
  assert.equal(TABLE.length + BRANCHES.length, 151);
});

for (const [opcode, name, mode, base, penalty] of TABLE) {
  test(`cycles: ${name} ${mode} ($${opcode.toString(16).toUpperCase().padStart(2, "0")}) takes ${base}${penalty ? " (+1 across a page)" : ""}`, () => {
    // Operands: zero page $10 (pointer to $30F0), absolute $30F0 (so +$20 crosses a page, +$00 does not).
    const operand = { imp: [], acc: [], imm: [0x01], zp: [0x10], zpx: [0x10], zpy: [0x10], abs: [0xf0, 0x30], abx: [0xf0, 0x30], aby: [0xf0, 0x30], izx: [0x10], izy: [0x10], ind: [0x00, 0x31] }[mode];
    const prepared = (setup) => {
      // Stack contents for RTS and RTI; the indirect jump reads its target from $3100.
      const mem = new Uint8Array(65536);
      mem.set([opcode, ...operand], 0x2000);
      mem.set([0xf0, 0x30], 0x10);
      mem.set([0x00, 0x40, 0x00, 0x20, 0x00, 0x40], 0x1f0);
      mem.set([0x00, 0x20], 0x3100);
      mem[0xfffe] = 0x00; mem[0xffff] = 0x40;
      const cpu = new Cpu6502(mem);
      cpu.pc = 0x2000;
      cpu.sp = 0xf0;
      Object.assign(cpu, setup);
      cpu.step();
      return cpu.cycles;
    };
    assert.equal(prepared({ x: 0, y: 0 }), base);
    if (mode === "abx" || mode === "aby" || mode === "izy") {
      const crossing = prepared({ x: 0x20, y: 0x20 });
      assert.equal(crossing, base + (penalty ? 1 : 0));
      assert.equal(prepared({ x: 0x01, y: 0x01 }), base, "an index that stays on the page");
    }
  });
}

for (const [opcode, name, flag, taken] of BRANCHES) {
  test(`cycles: ${name} takes 2 not taken, 3 taken, 4 when taken across a page`, () => {
    const notTaken = { [flag]: taken ? 0 : 1 };
    const takenFlags = { [flag]: taken };
    assert.equal(cyclesOf(0x2000, [opcode, 0x02], notTaken).cycles, 2);
    assert.equal(cyclesOf(0x2000, [opcode, 0x02], takenFlags).cycles, 3);
    assert.equal(cyclesOf(0x2000, [opcode, 0xfe], takenFlags).cycles, 3, "backwards on the same page");
    assert.equal(cyclesOf(0x20fd, [opcode, 0x02], takenFlags).cycles, 4, "forwards onto the next page");
    assert.equal(cyclesOf(0x2100, [opcode, 0xfc], takenFlags).cycles, 4, "backwards onto the previous page");
    assert.equal(cyclesOf(0x20fd, [opcode, 0x02], notTaken).cycles, 2, "a page crossing costs nothing when not taken");
  });
}

test("BRK pushes the return address and the status with the break flag and takes the IRQ vector; RTI undoes it", () => {
  const { cpu, cycles } = cyclesOf(0x2000, [0x00, 0xea], { c: 1, i: 0 });
  assert.equal(cycles, 7);
  assert.deepEqual([cpu.pc, cpu.i, cpu.sp, cpu.mem[0x1f0], cpu.mem[0x1ef], cpu.mem[0x1ee]], [0x4000, 1, 0xed, 0x20, 0x02, 0x31]);
  cpu.step(); // the byte at $4000 is zero again: BRK
  assert.equal(cpu.pc, 0x4000);
  const mem = new Uint8Array(65536);
  mem.set([0x40], 0x4000);
  mem.set([0x31, 0x02, 0x20], 0x1ee);
  const back = new Cpu6502(mem);
  back.pc = 0x4000;
  back.sp = 0xed;
  back.step();
  assert.deepEqual([back.pc, back.c, back.i, back.sp], [0x2002, 1, 0, 0xf0]);
});
