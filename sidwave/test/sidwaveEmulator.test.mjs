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
