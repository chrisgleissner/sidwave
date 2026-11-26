import test from "#test/runner";
import assert from "#test/assert";
import { AssemblyError } from "../src/assembler.js";
import { IO_RANGE_END, IO_RANGE_START, rangeOverlapsIo } from "../src/ioRange.js";
import { code, detailed, failure } from "./helpers/asm.js";

function assertFails(source, message, options) {
  const error = failure(source, options);
  assert.ok(error instanceof AssemblyError);
  assert.equal(error.message, message);
}

test("comparison operators give 1 for true and 0 for false, in every direction", () => {
  const cases = [
    ["1==2", 0], ["2==2", 1], ["1!=2", 1], ["2!=2", 0], ["1<2", 1], ["2<2", 0], ["3<2", 0], ["1<=2", 1], ["2<=2", 1], ["3<=2", 0],
    ["3>2", 1], ["2>2", 0], ["1>2", 0], ["3>=2", 1], ["2>=2", 1], ["1>=2", 0], ["-1<0", 1], ["0<-1", 0],
  ];
  for (const [expression, value] of cases) assert.deepEqual(code(`  .byte ${expression}`), [value], expression);
});

test("the arithmetic operators give exact results, including negative operands", () => {
  const cases = [
    ["5-3", 2], ["3-5", -2], ["6/3", 2], ["7/-2", -3], ["-7%4", -3], ["7%-4", 3], ["2*-3", -6], ["-2*-3", 6], ["1<<0", 1], ["$80>>7", 1], ["-8>>1", -4],
    ["-1&$ff", 255], ["-1|0", -1], ["-1^$ff", -256], ["~$ff", -256], ["~-1", 0], ["!-1", 0],
  ];
  for (const [expression, value] of cases) {
    const bytes = code(`  .word ${expression}`);
    assert.deepEqual(bytes, [value & 0xff, (value >> 8) & 0xff], expression);
  }
});

test("repeat counts are evaluated from constants with every operator", () => {
  const nops = (count) => Array(count).fill(0xea);
  const cases = [
    ["2", 2], ["5-3", 2], ["6/3", 2], ["7%4", 3], ["1<<1", 2], ["8>>2", 2], ["6&3", 2], ["1|2", 3], ["1^3", 2], ["2*2", 4], ["1==1", 1], ["1!=1", 0],
    ["1<2", 1], ["2<=1", 0], ["3>2", 1], ["2>=3", 0], ["3/2", 1], ["1==2", 0], ["1!=2", 1], ["2<1", 0], ["1<=2", 1], ["2>3", 0], ["3>=2", 1], ["+2", 2], ["-(-2)", 2], ["!0", 1], ["!2", 0], ["~-3", 2], ["<$0102", 2], [">$0200", 2], ["(1+1)", 2],
  ];
  for (const [expression, count] of cases) {
    assert.deepEqual(code(`.repeat ${expression}\n  nop\n.endrepeat`), nops(count), expression);
  }
  const countError = (expression) =>
    `(input):1: .repeat needs a count of 0..65536 made of numbers and constants defined earlier with "name = value"\n    .repeat ${expression}`;
  for (const expression of ["6/0", "6%0", "1<<32", "1>>-1", "*", "-1", "unknown", "-unknown", "!unknown", "1+unknown", "unknown+1"]) {
    assertFails(`.repeat ${expression}\n  nop\n.endrepeat`, countError(expression));
  }
  assertFails(".repeat 1.5\n  nop\n.endrepeat", "(input):1: Unexpected tokens at end of line\n    .repeat 1.5");
});

test("repeat bodies keep escapes such as \\n, and expansion lines report the repeat as context", () => {
  assert.deepEqual(code('.repeat 2\n  .text "A\\nB"\n.endrepeat'), [0x41, 0x0d, 0x42, 0x41, 0x0d, 0x42]);
  assertFails(".repeat 1\n  .text \"\\@\"\n.endrepeat", '(input):1: \\@ (the macro parameter list) is only valid inside a macro\n    .repeat 1');
});

test("macro arguments: quotes, escaped quotes, parentheses, comments and positional or named references", () => {
  assert.deepEqual(code('.macro put a, b\n  .byte a, b\n.endmacro\n  put "xy", (1+2)'), [0x78, 0x79, 3]);
  assert.deepEqual(code('.macro put a, b\n  .byte a, b\n.endmacro\n  put 1, (2)'), [1, 2]);
  assert.deepEqual(code('.macro put a, b\n  .byte a, b\n.endmacro\n  put 1, 2 ; trailing comment'), [1, 2]);
  assert.deepEqual(code('.macro put a, b\n  .byte a, b\n.endmacro\n  put 1, 2 // trailing comment'), [1, 2]);
  assert.deepEqual(code(".macro put a, b\n  .byte a, b\n.endmacro\n  put 'a', '\\''"), [0x61, 0x27]);
  assert.deepEqual(code('.macro put a, b\n  .byte a, b\n.endmacro\n  put "\\"", 7'), [0x22, 7]);
  assert.deepEqual(code('.macro one a\n  .byte a\n.endmacro\n  one (1+2)*3'), [9]);
  assert.deepEqual(code('.macro one a\n  .byte a\n.endmacro\n  one (1+(2))'), [3]);
});

test("macro parameters in parentheses after the name are accepted", () => {
  assert.deepEqual(code(".macro two(a, b)\n  lda #a\n  ldx #b\n.endmacro\n  two 1, 2"), [0xa9, 1, 0xa2, 2]);
});

test("macro bodies: comments and strings are not substituted, positional references beyond the arguments are empty", () => {
  const body = ".macro m v\n  .byte v ; v in a comment\n  .text \"v\"\n  .byte v // v again\n.endmacro\n  m 7";
  assert.deepEqual(code(body), [7, 0x56, 7]);
  // The second positional argument is missing: it is replaced by nothing, which leaves a trailing comma.
  assert.deepEqual(code("name .macro\n  .byte \\1, \\2\n.endm\n  #name 5"), [5]);
  assert.deepEqual(code('name .macro x\n  .byte "\\\\"\n.endm\n  #name 3'), [0x5c]);
  // A backslash that is not a parameter reference stays, so the string escape \\n still works.
  assert.deepEqual(code("name .macro x\n  .text \"\\n\"\n.endm\n  #name 3"), [0x0d]);
  assert.deepEqual(code("name .macro x\n  .byte \\x, \\{x}\n.endm\n  #name 3"), [3, 3]);
});

test("a macro definition inside a macro body is matched with its own end", () => {
  const source = ".macro outer\n.macro inner\n  nop\n.endmacro\n  inner\n.endmacro\n  outer";
  assert.deepEqual(code(source), [0xea]);
  const named = "outer .macro\ninner .macro\n  nop\n.endm\n  #inner\n.endm\n  #outer";
  assert.deepEqual(code(named), [0xea]);
  const labelled = ".macro body\nlbl: nop\n.endmacro\n  body";
  assert.deepEqual(code(labelled), [0xea]);
  assertFails(".macro dup\n.macro inner\n  nop\n.endmacro\n.endmacro\n  dup\n  dup", '(input):7 (in macro dup): Macro "inner" is already defined (line 6)\n    .macro inner');
});

test("a name in column 0 followed by an ACME directive is a label", () => {
  const result = detailed("* = $c000\ndata !byte 1, 2\n  jmp data");
  assert.deepEqual([...result.prg], [0x00, 0xc0, 1, 2, 0x4c, 0x00, 0xc0]);
  assert.deepEqual(result.warnings, []);
});

test("a bare label that only a byte selector refers to is used, so it raises no error and no warning", () => {
  const result = detailed("* = $c000\nvec nop\n  lda #<vec\n  ldx #>vec");
  assert.deepEqual([...result.prg], [0x00, 0xc0, 0xea, 0xa9, 0x00, 0xa2, 0xc0]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual([...detailed("* = $c000\nvec nop\n  .byte -vec & 255").prg].slice(2), [0xea, 0x00]);
});

test("unsupported directive spelling .pc without an equals sign names the replacement", () => {
  assert.match(failure("  .pc $1000").message, /^\(input\):1: unsupported directive \.pc \(use "\* = address" \(Kick Assembler \.pc is not supported\)\); supported: /);
});

test("a closing parenthesis is required, and an indirect operand cannot be followed by more text", () => {
  assertFails("  .byte (1+2 3)", "(input):1: Expected closing parenthesis\n    .byte (1+2 3)");
  assertFails("  jmp ($20) x", "(input):1: Unexpected tokens at end of line\n    jmp ($20) x");
});

test("a local name used before any global label is undefined", () => {
  assertFails("  lda .nope", '(input):1: Undefined symbol ".nope"\n    lda .nope');
  assertFails("main: nop\n  lda .nope", '(input):2: Undefined symbol ".nope"\n    lda .nope');
});

test("an assignment that is resolved late reports a clash with the line that defines the name again", () => {
  assertFails("a = later\na = 5\nlater = 1", '(input):1: Duplicate symbol "a" (first defined at (input):2)\n    a = later');
  assert.deepEqual(code("a = later\nlater = 5\n  .byte a"), [5]);
  assert.deepEqual(code("main: nop\n.a = .b + 1\n.b = 4\n  .byte .a"), [0xea, 5]);
  assertFails("a = b\nb = c", '(input):1: Undefined symbol "b"\n    a = b');
});

test("the location counter and the undefined-symbol check name the missing symbol", () => {
  assertFails("  * = nowhere", '(input):1: Undefined symbol "nowhere"\n    * = nowhere');
  assertFails("  lda later + *", '(input):1: Undefined symbol "later"\n    lda later + *');
  assertFails("  lda -later", '(input):1: Undefined symbol "later"\n    lda -later');
});

test("a resolver that throws a string or an error reports the message with the line of the directive", () => {
  assertFails('  .incbin "x"', "(input):1: boom\n    .incbin \"x\"", { resolveIncbin: () => { throw "boom"; } });
  assertFails('  .incbin "x"', "(input):1: broken\n    .incbin \"x\"", { resolveIncbin: () => { throw new Error("broken"); } });
  assertFails('  .include "x"', "(input):1: boom\n    .include \"x\"", { resolveInclude: () => { throw "boom"; } });
});

test("nesting deeper than 16 levels is reported at line 0 when the innermost body is empty", () => {
  const depth = 17;
  const source = [...Array(depth).fill(".repeat 1"), ...Array(depth).fill(".endrepeat")].join("\n");
  assertFails(source, "(input):0: Macro, repeat and include nesting is deeper than 16");
});

test("rangeOverlapsIo reports whether a byte range touches $D000-$DFFF", () => {
  assert.equal(IO_RANGE_START, 0xd000);
  assert.equal(IO_RANGE_END, 0xdfff);
  const cases = [
    [0xcfff, 1, false], [0xcfff, 2, true], [0xd000, 1, true], [0xd800, 16, true], [0xdfff, 1, true], [0xdfff, 2, true], [0xe000, 1, false],
    [0xc000, 0x2000, true], [0x0000, 0x1000, false], [0xd000, 0, false], [0xd000, -1, false], [0xd000, Number.NaN, false], [0xe000, 0x1000, false],
  ];
  for (const [start, length, expected] of cases) assert.equal(rangeOverlapsIo(start, length), expected, `${start.toString(16)}+${length}`);
});
