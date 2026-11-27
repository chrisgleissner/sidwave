import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg, AssemblyError } from "../src/assembler.js";
import { screenCodesToAscii, SCREEN_GRAPHIC_PLACEHOLDER } from "../src/petscii.js";

function assemblyMessage(source) {
  try {
    assemblyToPrg(source);
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail(`expected assembly to fail: ${JSON.stringify(source)}`);
}

test("a local label before any global label is rejected", () => {
  assert.match(assemblyMessage(".org $1000\n.loop: nop\n"), /Local label "\.loop" defined before any global label/);
});

test("a local constant before any global label is rejected", () => {
  assert.match(assemblyMessage(".local = 1\n"), /Local constant "\.local" defined before any global label/);
});

test("local labels and constants work once a global label exists", () => {
  const prg = assemblyToPrg(".org $1000\nstart:\n.loop: nop\n.size = 3\n  lda #.size\n  jmp .loop\n");
  assert.deepEqual(Array.from(prg), [0x00, 0x10, 0xea, 0xa9, 0x03, 0x4c, 0x00, 0x10]);
});

test("a division by zero in a deferred constant is reported as an assembly error with its line", () => {
  const source = "x = y / 0\ny = 0\n.org $1000\n.byte x\n";
  assert.throws(() => assemblyToPrg(source), (error) => error instanceof AssemblyError && /Division by zero/.test(error.message) && /:1:/.test(error.message));
});

test("an unresolvable deferred constant names the missing symbol", () => {
  assert.match(assemblyMessage("x = y\n.org $1000\n.byte x\n"), /Undefined symbol "y"/);
});

test("expression syntax errors report unexpected end of input", () => {
  for (const source of ["lda 1 +\n", "x = 1 +\n", ".org $1000\n.byte -\n", ".org $1000\n.byte (\n"]) {
    assert.match(assemblyMessage(source), /Unexpected end of token stream/);
  }
});

test("indirect operand syntax errors name the expected punctuation", () => {
  assert.match(assemblyMessage("lda (1 2)\n"), /Expected '\)' to close indirect operand/);
  assert.match(assemblyMessage("lda ($10),x\n"), /Only ,Y is allowed after a closing parenthesis/);
  assert.match(assemblyMessage("lda ($10,y)\n"), /Only X is allowed inside pre-indexed indirect operands/);
});

test("stack-relative addressing is not available on the 6502", () => {
  assert.match(assemblyMessage("lda $10,s\n"), /does not support expr,S addressing/);
});

test("a branch with an index register is rejected", () => {
  assert.match(assemblyMessage("bne $1000,x\n"), /relative branch and takes no ,X index/);
});

test("screenCodesToAscii trims trailing blank rows by default and keeps them on request", () => {
  const row = (text) => Uint8Array.from(Array.from(text.padEnd(4, " "), (ch) => (ch === " " ? 0x20 : ch.charCodeAt(0) - 0x40)));
  const bytes = new Uint8Array(12);
  bytes.set(row("AB"), 0);
  bytes.fill(0x20, 4);
  const trimmed = screenCodesToAscii(bytes, { columns: 4 });
  assert.equal(trimmed, "AB");
  const kept = screenCodesToAscii(bytes, { columns: 4, trimTrailingEmptyRows: false });
  assert.equal(kept.split("\n").length, 3);
  assert.equal(screenCodesToAscii(Uint8Array.of(0x40), { columns: 4 }), SCREEN_GRAPHIC_PLACEHOLDER);
});
