import test from "#test/runner";
import assert from "#test/assert";
import { AssemblyError } from "../src/assembler.js";
import { code, failure, prg } from "./helpers/asm.js";

/** Asserts the exact AssemblyError message for the source (one-line messages keep the trimmed source line). */
function assertFails(source, message, options) {
  const error = failure(source, options);
  assert.ok(error instanceof AssemblyError);
  assert.equal(error.message, message);
  return error;
}

test("zero page and absolute forms are chosen by the operand value for every mnemonic that has both", () => {
  const cases = [
    ["lda $ff", [0xa5, 0xff]],
    ["lda $100", [0xad, 0x00, 0x01]],
    ["lda $00ff", [0xa5, 0xff]],
    ["lda $ff,x", [0xb5, 0xff]],
    ["lda $100,x", [0xbd, 0x00, 0x01]],
    ["lda $ff,y", [0xb9, 0xff, 0x00]],
    ["ldx $ff,y", [0xb6, 0xff]],
    ["ldx $100,y", [0xbe, 0x00, 0x01]],
    ["ldy $ff,x", [0xb4, 0xff]],
    ["ldy $100,x", [0xbc, 0x00, 0x01]],
    ["sta $ff", [0x85, 0xff]],
    ["sta $0400", [0x8d, 0x00, 0x04]],
    ["asl $10", [0x06, 0x10]],
    ["asl $1000", [0x0e, 0x00, 0x10]],
    ["asl $10,x", [0x16, 0x10]],
    ["asl $1000,x", [0x1e, 0x00, 0x10]],
    ["bit $10", [0x24, 0x10]],
    ["bit $1000", [0x2c, 0x00, 0x10]],
    ["jmp $10", [0x4c, 0x10, 0x00]],
    ["jsr $10", [0x20, 0x10, 0x00]],
    ["jmp ($10)", [0x6c, 0x10, 0x00]],
  ];
  for (const [source, expected] of cases) assert.deepEqual(code(source), expected, source);
});

test("a symbol defined before use selects zero page, one defined after use is sized as absolute", () => {
  assert.deepEqual(code("zp = $10\n  lda zp"), [0xa5, 0x10]);
  assert.deepEqual(code("  lda later\nlater = $10"), [0xad, 0x10, 0x00]);
  assert.deepEqual(code("  lda later,x\nlater = $10"), [0xbd, 0x10, 0x00]);
  assert.deepEqual(code("  sta later,y\nlater = $10"), [0x99, 0x10, 0x00]);
  assert.deepEqual(code("  lda later+1\nlater = $10"), [0xad, 0x11, 0x00]);
});

test("a forward reference to a label stays absolute even when the label ends in zero page", () => {
  const bytes = prg("  * = $0010\n  jmp end\n  nop\nend: rts");
  assert.deepEqual(bytes, [0x10, 0x00, 0x4c, 0x14, 0x00, 0xea, 0x60]);
});

test("an instruction with only a zero-page index form sizes a forward reference as zero page", () => {
  assert.deepEqual(code("  stx later,y\nlater = $10"), [0x96, 0x10]);
  assert.deepEqual(code("  ldx later,y\nlater = $10"), [0xbe, 0x10, 0x00]);
  assertFails(
    ".org $C000\n  stx later,y\nlater = $1234",
    "(input):2: Instruction STX does not support absoluteY addressing (operand $1234 is outside zero page)\n    stx later,y",
  );
  assertFails(".org $C000\n  stx $1234,y", "(input):2: Instruction STX does not support absoluteY addressing\n    stx $1234,y");
  assertFails(".org $C000\n  sty $1234,x", "(input):2: Instruction STY does not support absoluteX addressing\n    sty $1234,x");
});

test("every indirect form encodes its operand and rejects values outside the encoding", () => {
  assert.deepEqual(code("  lda ($20,x)\n  lda ($20),y\n  jmp ($c000)"), [0xa1, 0x20, 0xb1, 0x20, 0x6c, 0x00, 0xc0]);
  assert.deepEqual(code("  lda ( $20 , X )\n  lda ( $20 ), Y"), [0xa1, 0x20, 0xb1, 0x20]);
  assertFails(".org $C000\n  lda ($100,x)", "(input):2: Instruction LDA (zp,X) requires a zero-page operand ($00-$FF), got $0100\n    lda ($100,x)");
  assertFails(".org $C000\n  lda ($100),y", "(input):2: Instruction LDA (zp),Y requires a zero-page operand ($00-$FF), got $0100\n    lda ($100),y");
  assertFails(".org $C000\n  lda (-1),y", "(input):2: Instruction LDA (zp),Y requires a zero-page operand ($00-$FF), got -1\n    lda (-1),y");
  assertFails(".org $C000\n  jmp (-1)", "(input):2: Address operand -1 of JMP is outside $0000-$FFFF\n    jmp (-1)");
  assertFails(".org $C000\n  jmp ($10000)", "(input):2: Address operand 65536 of JMP is outside $0000-$FFFF\n    jmp ($10000)");
  assertFails(".org $C000\n  lda ($20)", "(input):2: Instruction LDA does not support (expr) addressing\n    lda ($20)");
  assertFails(".org $C000\n  jmp ($20,x)", "(input):2: Instruction JMP does not support (expr,X) addressing\n    jmp ($20,x)");
  assertFails(".org $C000\n  jmp ($20),y", "(input):2: Instruction JMP does not support (expr),Y addressing\n    jmp ($20),y");
  assertFails(".org $C000\n  lda ($20,y)", "(input):2: Only X is allowed inside pre-indexed indirect operands\n    lda ($20,y)");
  assertFails(".org $C000\n  lda ($20),x", "(input):2: Only ,Y is allowed after a closing parenthesis: use (zp),Y or (zp,X) (got ,X)\n    lda ($20),x");
  assertFails(".org $C000\n  lda ($20,x", "(input):2: Unexpected end of token stream\n    lda ($20,x");
  assertFails(".org $C000\n  lda ($20", "(input):2: Unexpected end of token stream\n    lda ($20");
  assertFails(".org $C000\n  lda ($20,x) y", "(input):2: Unexpected tokens after indirect operand\n    lda ($20,x) y");
});

test("an operand that starts with a parenthesis but continues with an operator is an expression", () => {
  assert.deepEqual(code("  lda (1+2)*3"), [0xa5, 0x09]);
  assert.deepEqual(code("lab = $10\n  lda (lab)+1"), [0xa5, 0x11]);
  assert.deepEqual(code("  lda (1+2)*3,x"), [0xb5, 0x09]);
});

test("accumulator forms: A alone is the accumulator only for shifts and rotates", () => {
  assert.deepEqual(code("  asl a\n  lsr A\n  rol\n  ror a"), [0x0a, 0x4a, 0x2a, 0x6a]);
  assert.deepEqual(code("a = $20\n  lda a\n  lda a+1\n  asl a"), [0xa5, 0x20, 0xa5, 0x21, 0x0a]);
  assertFails(".org $C000\n  lda\n", "(input):2: Instruction LDA requires an operand\n    lda");
  assertFails(".org $C000\n  inx a", "(input):2: Instruction INX does not support absolute addressing\n    inx a");
});

test("immediate operands cover -128..255 and take the low or high byte with < and >", () => {
  assert.deepEqual(code("  lda #-128\n  lda #255\n  lda #0"), [0xa9, 0x80, 0xa9, 0xff, 0xa9, 0x00]);
  assert.deepEqual(code("addr = $1234\n  lda #<addr\n  ldx #>addr\n  ldy #>addr+1"), [0xa9, 0x34, 0xa2, 0x12, 0xa0, 0x12]);
  assertFails(".org $C000\n  lda #256", "(input):2: Immediate operand 256 of LDA is outside -128..255 and would be truncated to one byte\n    lda #256");
  assertFails(".org $C000\n  lda #-129", "(input):2: Immediate operand -129 of LDA is outside -128..255 and would be truncated to one byte\n    lda #-129");
  assertFails(".org $C000\n  sta #1", "(input):2: Instruction STA does not support immediate addressing\n    sta #1");
});

test("stack-relative operands are not available on the NMOS inventory", () => {
  assertFails(".org $C000\n  lda $10,s", "(input):2: Instruction LDA does not support expr,S addressing\n    lda $10,s");
  assertFails(".org $C000\n  lda $10,z", "(input):2: Only X, Y, or S are allowed after comma\n    lda $10,z");
  assertFails(".org $C000\n  lda $10,", "(input):2: Unexpected end of token stream\n    lda $10,");
  assertFails(".org $C000\n  lda $10 $20", "(input):2: Unexpected tokens after operand\n    lda $10 $20");
});

test("operands outside the encodable range are rejected for absolute modes", () => {
  assertFails(".org $C000\n  lda $10000", "(input):2: Address operand 65536 of LDA is outside $0000-$FFFF\n    lda $10000");
  assertFails(".org $C000\n  lda -1", "(input):2: Address operand -1 of LDA is outside $0000-$FFFF\n    lda -1");
  assertFails(".org $C000\n  lda $10000,x", "(input):2: Address operand 65536 of LDA is outside $0000-$FFFF\n    lda $10000,x");
  assertFails(".org $C000\n  ldx $10000,y", "(input):2: Address operand 65536 of LDX is outside $0000-$FFFF\n    ldx $10000,y");
});

test("an unsupported form for the mnemonic names the mnemonic and the form", () => {
  assertFails(".org $C000\n  jsr $10,x", "(input):2: Instruction JSR does not support absoluteX addressing\n    jsr $10,x");
  assertFails(".org $C000\n  jmp $10,y", "(input):2: Instruction JMP does not support absoluteY addressing\n    jmp $10,y");
  assertFails(".org $C000\n  clc #1", "(input):2: Instruction CLC does not support immediate addressing\n    clc #1");
  assertFails(".org $C000\n  clc $10", "(input):2: Instruction CLC does not support absolute addressing\n    clc $10");
  assertFails(".org $C000\n  bne $10,x", "(input):2: Instruction BNE is a relative branch and takes no ,X index\n    bne $10,x");
  assertFails(".org $C000\n  bne #1", "(input):2: Instruction BNE does not support immediate addressing\n    bne #1");
  assertFails(".org $C000\n  bne", "(input):2: Instruction BNE requires an operand\n    bne");
});

test("branches reach -128 and +127 bytes from the end of the instruction", () => {
  // The branch at $C000 ends at $C002; the target is offset bytes from there.
  assert.deepEqual(code("  bne $c002+127"), [0xd0, 0x7f]);
  assert.deepEqual(code("  bne $c002-128"), [0xd0, 0x80]);
  assert.deepEqual(code("  bne $c002"), [0xd0, 0x00]);
  assert.deepEqual(code("  bne $c002-1"), [0xd0, 0xff]);
  assertFails(".org $C000\n  bne $c002+128", "(input):2: Branch target out of range (offset 128)\n    bne $c002+128");
  assertFails(".org $C000\n  bne $c002-129", "(input):2: Branch target out of range (offset -129)\n    bne $c002-129");
});

test("every branch mnemonic encodes a relative offset to a label, backward and forward", () => {
  const opcodes = { bpl: 0x10, bmi: 0x30, bvc: 0x50, bvs: 0x70, bcc: 0x90, bcs: 0xb0, bne: 0xd0, beq: 0xf0 };
  for (const [mnemonic, opcode] of Object.entries(opcodes)) {
    assert.deepEqual(code(`back: nop\n  ${mnemonic} back\n  ${mnemonic} fwd\n  nop\nfwd: rts`), [0xea, opcode, 0xfd, opcode, 0x01, 0xea, 0x60], mnemonic);
  }
});

test("a branch at the top of memory wraps to $0000 as the CPU does", () => {
  assert.deepEqual(prg("* = $fffe\n  bne $0000"), [0xfe, 0xff, 0xd0, 0x00]);
  assert.deepEqual(prg("* = $fffe\n  bne $007f"), [0xfe, 0xff, 0xd0, 0x7f]);
  assertFails("* = $fffe\n  bne $ffff", "(input):2: Branch target out of range (offset 65535)\n    bne $ffff");
  assertFails("* = $0000\n  bne $fffe", "(input):2: Branch target out of range (offset 65532)\n    bne $fffe");
});

test("the last byte of memory can be written but not the one after it", () => {
  assert.deepEqual(prg("* = $ffff\n  rts"), [0xff, 0xff, 0x60]);
  assert.deepEqual(prg("* = $fffd\n  jmp $0000"), [0xfd, 0xff, 0x4c, 0x00, 0x00]);
  assertFails("* = $ffff\n  lda #1", "(input):2: Output passes $FFFF: a byte would be written at $10000, outside the 64 KB address space\n    lda #1");
  assertFails("* = $ffff\n  .word 1", "(input):2: Output passes $FFFF: a byte would be written at $10000, outside the 64 KB address space\n    .word 1");
  assertFails("* = $fffe\n  .byte 1,2,3", "(input):2: Output passes $FFFF: a byte would be written at $10000, outside the 64 KB address space\n    .byte 1,2,3");
});

test("the program counter symbol * is the address of the current instruction", () => {
  assert.deepEqual(code("  jmp *\n  jmp *+3\n  lda #<*\n  lda #>*"), [0x4c, 0x00, 0xc0, 0x4c, 0x06, 0xc0, 0xa9, 0x06, 0xa9, 0xc0]);
});

test("a name that is only defined later is reported with the symbols it is missing", () => {
  assertFails(".org $C000\n  lda missing", "(input):2: Undefined symbol \"missing\"\n    lda missing");
  assertFails(".org $C000\n  lda one+two", "(input):2: Undefined symbols \"one\", \"two\"\n    lda one+two");
  assertFails(".org $C000\nValue = 1\n  lda value", "(input):3: Undefined symbol \"value\" (symbols are case-sensitive; did you mean \"Value\"?)\n    lda value");
});
