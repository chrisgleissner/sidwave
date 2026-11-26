import test from "#test/runner";
import assert from "#test/assert";
import { AssemblyError } from "../src/assembler.js";
import { code, detailed, failure, prg } from "./helpers/asm.js";

/** Asserts the exact AssemblyError message: "(input):<line>: <text>" plus the trimmed source line. */
function assertFails(source, message, options) {
  const error = failure(source, options);
  assert.ok(error instanceof AssemblyError);
  assert.equal(error.message, message);
  return error;
}

/** Table-driven helper: every spelling must assemble to the same bytes. */
function assertSpellings(spellings, expected) {
  for (const source of spellings) assert.deepEqual(code(source), expected, source);
}

test("origin directives: org, .org and * = set the address of the following bytes", () => {
  for (const source of [".org $2000\n  rts", "org $2000\n  rts", "* = $2000\n  rts", "*=$2000\n  rts", ".ORG $2000\n  rts", "* = $1000+$1000\n  rts"]) {
    assert.deepEqual(prg(source), [0x00, 0x20, 0x60], source);
  }
  assert.deepEqual(prg("size = 16\n* = $1000 + size * 2\n  rts"), [0x20, 0x10, 0x60]);
});

test("origin directives: values outside $0000-$FFFF and undefined symbols are errors", () => {
  assertFails("  .org $10000\n  rts", "(input):1: org directive value 65536 is outside $0000-$FFFF\n    .org $10000");
  assertFails("  .org -1", "(input):1: org directive value -1 is outside $0000-$FFFF\n    .org -1");
  assertFails("  * = $10000", "(input):1: * = value 65536 is outside $0000-$FFFF\n    * = $10000");
  assertFails("  .org nowhere", '(input):1: Undefined symbol "nowhere"\n    .org nowhere');
  assertFails("  .org", "(input):1: Unexpected end of token stream\n    .org");
  assertFails("  .org $10 $20", "(input):1: Unexpected tokens at end of line\n    .org $10 $20");
  assertFails("  .pc = $1000", '(input):1: unsupported directive .pc (Kick Assembler); use "* = address"\n    .pc = $1000');
});

test("byte directive spellings: .byte .byt .by byte db .db !byte !by !8 !08", () => {
  assertSpellings(
    [".byte 1,2", ".byt 1,2", ".by 1,2", "byte 1,2", "db 1,2", ".db 1,2", "!byte 1,2", "!by 1,2", "!8 1,2", "!08 1,2", ".BYTE 1, 2", "  .byte 1 , 2"],
    [1, 2],
  );
  assert.deepEqual(code("  .byte"), []);
});

test("byte directive values: -128..255 are accepted, expressions and strings are evaluated", () => {
  assert.deepEqual(code("  .byte -128, 255, 0, -1"), [0x80, 0xff, 0x00, 0xff]);
  assert.deepEqual(code("lab = 5\n  .byte lab*2, <$1234, >$1234, 'A', 'A'-64, \"AB\", \"\\n\""), [10, 0x34, 0x12, 0x41, 0x01, 0x41, 0x42, 0x0a]);
  assert.deepEqual(code('  .byte "é"'), [0xe9]);
  assertFails("  .byte 256", "(input):1: byte directive value 256 is outside -128..255 and would be truncated\n    .byte 256");
  assertFails("  .byte -129", "(input):1: byte directive value -129 is outside -128..255 and would be truncated\n    .byte -129");
  assertFails('  .byte "€"', "(input):1: byte directive character '€' (code 8364) does not fit in one byte\n    .byte \"€\"");
  assertFails("  .byte later", '(input):1: Undefined symbol "later"\n    .byte later');
  assert.deepEqual(code("  .byte later\nlater = 7"), [7]);
});

test("word directive spellings: .word .wo word dw !word !wo !16 write little-endian words", () => {
  assertSpellings(
    [".word $1234,2", ".wo $1234,2", "word $1234,2", "dw $1234,2", "!word $1234,2", "!wo $1234,2", "!16 $1234,2"],
    [0x34, 0x12, 0x02, 0x00],
  );
});

test("word directive values: -32768..65535, labels, forward references and one-character strings", () => {
  assert.deepEqual(code("  .word -32768, 65535, -1"), [0x00, 0x80, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(code("  .word start, end\nstart: nop\nend:"), [0x04, 0xc0, 0x05, 0xc0, 0xea]);
  assert.deepEqual(code('  .word "AB"'), [0x41, 0x00, 0x42, 0x00]);
  assert.deepEqual(code('  .word "€"'), [0xac, 0x20]);
  assertFails("  .word 65536", "(input):1: word directive value 65536 is outside -32768..65535 and would be truncated\n    .word 65536");
  assertFails("  .word -32769", "(input):1: word directive value -32769 is outside -32768..65535 and would be truncated\n    .word -32769");
  assertFails('  .word "😀"', "(input):1: word directive character '😀' (code 128512) does not fit in one word\n    .word \"😀\"");
  assertFails("  .word nowhere", '(input):1: Undefined symbol "nowhere"\n    .word nowhere');
});

test(".dw is rejected because Kick Assembler uses it for four bytes", () => {
  assertFails(
    "  .dw 1",
    "(input):1: unsupported directive .dw (ambiguous: Kick Assembler's .dw is a 4-byte .dword, which is not supported; use .word for 2 bytes); supported: " +
      ".org/org/* = ; .byte/.byt/.by/.db/!byte/!by/!8/!08 ; .word/.wo/!word/!wo/!16 ; .text/.ascii ; !text/!tx/!txt/!raw ; !pet ; !scr ; " +
      ".fill/!fill/!fi ; .align ; !align ; .res/.ds ; .equ/name = value ; .include/!source/!src ; .incbin/.binary ; !binary/!bin ; " +
      ".if/.else/.endif/.fi ; .macro/.mac name params ... .endmacro/.endmac/.endm ; name .macro params ... .endm ; " +
      ".repeat n ... .endrep/.endrepeat ; .rept n ... .endrept\n    .dw 1",
  );
});

test("unsupported and removed directive spellings name what to write instead", () => {
  assert.match(failure("  .scr \"a\"").message, /unsupported directive \.scr \(use !scr \(ACME screen codes\)\); supported: /);
  assert.match(failure("  .screen \"a\"").message, /unsupported directive \.screen \(use !scr \(ACME screen codes\)\); supported: /);
  assert.match(failure("  .petscii \"a\"").message, /unsupported directive \.petscii \(use !pet \(ACME PETSCII\) or \.text\); supported: /);
  assert.match(failure("  .endr").message, /unsupported directive \.endr \(use \.endrept \(64tass\) or \.endrep \(ca65\)\); supported: /);
  assert.match(failure("  .frobnicate 1").message, /unsupported directive \.frobnicate; supported: .* \(a local label needs a trailing ":"\)\n {4}\.frobnicate 1$/s);
  assert.match(failure("  !frobnicate 1").message, /unsupported directive !frobnicate; supported: /);
  assert.ok(!failure("  !frobnicate 1").message.includes("local label"));
});

test("text directive: .text and .ascii fold a-z to PETSCII capitals and turn newline into RETURN", () => {
  assertSpellings(['  .text "Hello, World 1"', '  .ascii "Hello, World 1"'], [0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x2c, 0x20, 0x57, 0x4f, 0x52, 0x4c, 0x44, 0x20, 0x31]);
  assert.deepEqual(code('  .text "A\\nB"'), [0x41, 0x0d, 0x42]);
  assert.deepEqual(code('  .text "AZ", "[]"'), [0x41, 0x5a, 0x5b, 0x5d]);
  assert.deepEqual(code('  .text ""'), []);
  assert.deepEqual(code("  .text 65, 66"), [65, 66]);
});

test("text directive: brace control codes by name, hex and decimal; unknown tokens are errors", () => {
  assert.deepEqual(code('  .text "{clear}{red}A{$93}{147}{cursor down}"'), [0x93, 0x1c, 0x41, 0x93, 0x93, 0x11]);
  assert.deepEqual(code('  .text "{wht}{rvs on}X{rvs off}"'), [0x05, 0x12, 0x58, 0x92]);
  // A brace that is not a token candidate stays an ordinary character.
  assert.deepEqual(code('  .text "{a,b} { }"'), [0x7b, 0x41, 0x2c, 0x42, 0x7d, 0x20, 0x7b, 0x20, 0x7d]);
  assertFails('  .text "{nope}"', '(input):1: {nope} is not a known control code (unknown control-code name); write \\x7b for a literal brace\n    .text "{nope}"');
  assertFails('  .text "{256}"', '(input):1: {256} is not a known control code (decimal codes are 0-255); write \\x7b for a literal brace\n    .text "{256}"');
  assertFails('  .text "é"', "(input):1: text directive character 'é' (code 233) is not ASCII and has no PETSCII mapping; use .byte $xx for it\n    .text \"é\"");
});

test("text directive: lowercase letters add one warning that names the alternatives", () => {
  const result = detailed('  .text "abc"\n  .text "def"');
  assert.equal(result.warnings.length, 1);
  assert.equal(
    result.warnings[0],
    "(input):1: .text turns a-z into the PETSCII letters $41-$5A (this assembler's rule); 64tass would emit the ASCII codes and Kick Assembler screen codes. Use !text for raw bytes, !pet for ACME's PETSCII or !scr for screen codes",
  );
  assert.deepEqual(detailed('  .text "ABC{red}"').warnings, []);
  assert.deepEqual(detailed('  .text "{red}"').warnings, []);
  assert.deepEqual(detailed('  !text "abc"').warnings, []);
});

test("ACME text directives: !text !tx !txt !raw are raw, !pet and !scr use the PETSCII and screen tables", () => {
  assertSpellings(['  !text "aB@"', '  !tx "aB@"', '  !txt "aB@"', '  !raw "aB@"'], [0x61, 0x42, 0x40]);
  assert.deepEqual(code('  !pet "aB1[]"'), [0x41, 0xc2, 0x31, 0x5b, 0x5d]);
  assert.deepEqual(code('  !scr "aB@[_`"'), [0x01, 0x42, 0x00, 0x1b, 0x1f, 0x40]);
  // Single characters in expressions are converted with the table of the directive.
  assert.deepEqual(code("  !pet 'a'+1, 'B'"), [0x42, 0xc2]);
  assert.deepEqual(code("  !scr 'a', 'A'+1"), [0x01, 0x42]);
  assert.deepEqual(code("  !text 'a'+1"), [0x62]);
  // Braces are ordinary characters in ACME strings.
  assert.deepEqual(code('  !text "{r}"'), [0x7b, 0x72, 0x7d]);
  assertFails('  !text "€"', "(input):1: text character '€' (code 8364) does not fit in one byte; use \\xNN for a byte value\n    !text \"€\"");
  assertFails('  !byte "ab"', "(input):1: !byte takes a string only as a single character, as in ACME; use !text for longer strings\n    !byte \"ab\"");
  assertFails('  !word "ab"', "(input):1: !word takes a string only as a single character, as in ACME; use !text for longer strings\n    !word \"ab\"");
  assert.deepEqual(code('  !byte "a"'), [0x61]);
});

test("string escapes: \\0 \\t \\n \\r \\xNN \\\\ \\\" \\'", () => {
  assert.deepEqual(code('  !text "\\0\\t\\n\\r\\x41\\x7b\\\\\\"\\\'"'), [0x00, 0x09, 0x0a, 0x0d, 0x41, 0x7b, 0x5c, 0x22, 0x27]);
  assert.deepEqual(code("  .byte 'a', '\\''"), [0x61, 0x27]);
  assertFails('  .byte "\\q"', '(input):1: Unknown escape "\\q" in a string; use \\0, \\xNN, \\n, \\r, \\t, \\\\, \\" or \\\'\n    .byte "\\q"');
  assertFails('  .byte "\\xZZ"', '(input):1: Escape \\x needs two hex digits, for example "\\x41"\n    .byte "\\xZZ"');
  assertFails('  .byte "abc', '(input):1: Unterminated string literal (a backslash escapes the next character: write \\\\ for one backslash and \\" for a quote)\n    .byte "abc');
});

test("fill spellings: .fill !fill !fi fill n bytes, zero when the value is left out", () => {
  assertSpellings(["  .fill 3, $aa", "  !fill 3, $aa", "  !fi 3, $aa", "  .FILL 3,$AA"], [0xaa, 0xaa, 0xaa]);
  assert.deepEqual(code("  .fill 2"), [0, 0]);
  assert.deepEqual(code("  .fill 0, 1"), []);
  assert.deepEqual(code("n = 2\n  .fill n+1, -1"), [0xff, 0xff, 0xff]);
  assert.deepEqual(prg("  * = 0\n  .fill 65536, 7").length, 2 + 65536);
  assertFails("  .fill -1", "(input):1: fill directive requires a count of 0..65536, got -1\n    .fill -1");
  assertFails("  .fill 65537", "(input):1: fill directive requires a count of 0..65536, got 65537\n    .fill 65537");
  assertFails("  .fill 2, 256", "(input):1: fill directive value 256 is outside -128..255 and would be truncated\n    .fill 2, 256");
  assertFails("  .fill later", '(input):1: Undefined symbol "later"\n    .fill later');
  assertFails("  .fill 2, 1, 2", "(input):1: Unexpected tokens at end of line\n    .fill 2, 1, 2");
});

test("align: .align n[, fill] pads to a multiple of n, the default fill is zero", () => {
  assert.deepEqual(code("  nop\n  .align 4\n  nop"), [0xea, 0, 0, 0, 0xea]);
  assert.deepEqual(code("  nop\n  .align 4, $ea\n  rts"), [0xea, 0xea, 0xea, 0xea, 0x60]);
  assert.deepEqual(code("  .align 4\n  nop"), [0xea]);
  assert.deepEqual(code("  .align 1\n  nop"), [0xea]);
  assert.deepEqual(prg("  * = $c0f0\n  .align 256, $ea\n  rts").slice(0, 2), [0xf0, 0xc0]);
  assert.equal(prg("  * = $c0f0\n  .align 256, $ea\n  rts").length, 2 + 16 + 1);
  assertFails("  .align 0", "(input):1: align directive requires a boundary of 1..65536, got 0\n    .align 0");
  assertFails("  .align 65537", "(input):1: align directive requires a boundary of 1..65536, got 65537\n    .align 65537");
  assertFails("  nop\n  .align 4, 256", "(input):2: align directive value 256 is outside -128..255 and would be truncated\n    .align 4, 256");
});

test("!align ANDVALUE, EQUALVALUE[, FILL] pads until (pc AND mask) equals the value, fill $EA by default", () => {
  assert.deepEqual(code("  nop\n  !align 3, 0\n  rts"), [0xea, 0xea, 0xea, 0xea, 0x60]);
  assert.deepEqual(code("  nop\n  !align 3, 0, 0\n  rts"), [0xea, 0, 0, 0, 0x60]);
  assert.deepEqual(code("  !align 3, 0\n  rts"), [0x60]);
  assert.deepEqual(code("  !align 255, 2, $55\n  rts"), [0x55, 0x55, 0x60]);
  assertFails("  !align 3", "(input):1: !align needs ANDVALUE, EQUALVALUE [, FILLVALUE] (use .align N to align to a multiple of N)\n    !align 3");
  assertFails("  !align 3, 4", "(input):1: !align 3, 4 can never be satisfied\n    !align 3, 4");
  assertFails("  !align 65536, 0", "(input):1: !align needs ANDVALUE and EQUALVALUE in 0..65535, got 65536, 0\n    !align 65536, 0");
  assertFails("  !align 3, 0, 256", "(input):1: !align value 256 is outside -128..255 and would be truncated\n    !align 3, 0, 256");
});

test("reserve spellings: .res .ds ds res advance the address; a value argument fills", () => {
  for (const spelling of [".res", ".ds", "ds", "res", ".RES"]) {
    assert.deepEqual(code(`  lda #1\n  ${spelling} 2\n  rts`), [0xa9, 0x01, 0x00, 0x00, 0x60], spelling);
  }
  assert.deepEqual(code("  lda #1\n  .res 2, $55\n  rts"), [0xa9, 0x01, 0x55, 0x55, 0x60]);
  assert.deepEqual(code("  .res 0\n  nop"), [0xea]);
  assertFails("  .res -1", "(input):1: reserve directive requires a non-negative size\n    .res -1");
  assertFails("  * = $ffff\n  .res 2", "(input):2: reserve directive of 2 bytes at $FFFF passes $FFFF\n    .res 2");
  assertFails("  .res nowhere", '(input):1: Undefined symbol "nowhere"\n    .res nowhere');
  assertFails("  .res 1, 2, 3", "(input):1: Unexpected tokens at end of line\n    .res 1, 2, 3");
});

test("reserve: space next to emitted bytes is part of the image, detached space is not", () => {
  assert.deepEqual(prg("  * = $c000\n  nop\ncounter: .res 3"), [0x00, 0xc0, 0xea, 0, 0, 0]);
  assert.deepEqual(prg("  * = $c000\ncounter: .res 3\n  nop"), [0x00, 0xc0, 0, 0, 0, 0xea]);
  assert.deepEqual(prg("  * = $0002\nzpvar: .res 1\n  * = $c000\n  nop"), [0x00, 0xc0, 0xea]);
  assert.equal(detailed("  * = $0002\nzpvar: .res 1\n  * = $c000\n  nop").symbols.get("zpvar"), 2);
});

test("symbol definitions: name = value, .equ name, value and name .equ value", () => {
  assert.deepEqual(code("a = 5\n.equ b, 6\nc .equ 7\n  .byte a, b, c"), [5, 6, 7]);
  assert.deepEqual(code("a = 5\n  .byte a\na = 5"), [5]);
  assert.deepEqual(code("size = end - start\nstart: nop\nnop\nend:\n  .byte size"), [0xea, 0xea, 2]);
  assertFails("a = 1\na = 2", '(input):2: Duplicate symbol "a" (first defined at (input):1)\n    a = 2');
  assertFails("a: nop\na: nop", '(input):2: Duplicate label "a" (first defined at (input):1)\n    a: nop');
  assertFails("a = 1\na: nop", '(input):2: Duplicate label "a" (first defined at (input):1)\n    a: nop');
  assertFails("  .equ 5, 6", "(input):1: .equ expects a symbol name\n    .equ 5, 6");
  assertFails("  .equ a 6", "(input):1: .equ expects a comma between the name and the value\n    .equ a 6");
  assertFails("a = missing", '(input):1: Undefined symbol "missing"\n    a = missing');
  assertFails("a = b\nb = a", '(input):1: Undefined symbol "b"\n    a = b');
});

test("labels: name:, a bare name in column 0, several labels on one line, case-sensitive", () => {
  const result = detailed("one: two: three\n  nop\nFour lda #1\nfive:\n  rts\n  jmp one\n  jmp Four\n  jmp five\n  jmp two\n  jmp three");
  assert.deepEqual([...result.symbols], [["one", 0x0801 + 13], ["two", 0x0801 + 13], ["three", 0x0801 + 13], ["Four", 0x0801 + 14], ["five", 0x0801 + 16]]);
});

test("local labels belong to the last global label and may repeat under another one", () => {
  assert.deepEqual(code("first: ldx #3\n.loop: dex\n  bne .loop\nsecond: ldy #3\n.loop: dey\n  bne .loop"), [0xa2, 0x03, 0xca, 0xd0, 0xfd, 0xa0, 0x03, 0x88, 0xd0, 0xfd]);
  assertFails("  .loop: nop", '(input):1: Local label ".loop" defined before any global label\n    .loop: nop');
  assertFails("main: nop\n  jmp .missing", '(input):2: Undefined symbol ".missing"\n    jmp .missing');
  assertFails("main: nop\n.x: nop\n.x: nop", '(input):3: Duplicate label ".x" (first defined at (input):2)\n    .x: nop');
  assertFails("  nop\n.local = 1", '(input):2: Local constant ".local" defined before any global label\n    .local = 1');
  assert.deepEqual(code("main: nop\n.k = 3\n  .byte .k"), [0xea, 3]);
});

test("conditional assembly: .if .else .endif and .fi, nested, with the value of constants", () => {
  assert.deepEqual(code("  .if 1\n  .byte 1\n  .else\n  .byte 2\n  .endif"), [1]);
  assert.deepEqual(code("  .if 0\n  .byte 1\n  .else\n  .byte 2\n  .endif"), [2]);
  assert.deepEqual(code("  .if 0\n  .byte 1\n  .fi\n  .byte 3"), [3]);
  assert.deepEqual(code("debug = 1\n  .if debug == 1\n  .byte 1\n  .endif\n  .if debug != 1\n  .byte 2\n  .endif"), [1]);
  assert.deepEqual(code("  .if 1\n  .if 0\n  .byte 1\n  .else\n  .byte 2\n  .endif\n  .else\n  .byte 3\n  .endif"), [2]);
  assert.deepEqual(code("  .if 0\n  .if 1\n  .byte 1\n  .else\n  .byte 2\n  .endif\n  .else\n  .byte 3\n  .endif"), [3]);
  // Labels and instructions in an inactive branch are not defined or emitted.
  assert.deepEqual(code("  .if 0\ndead: nop\n  .endif\n  rts"), [0x60]);
  assertFails("  .else", "(input):1: .else without a matching .if\n    .else");
  assertFails("  .endif", "(input):1: .endif without a matching .if\n    .endif");
  assertFails("  .if 1\n  .else\n  .else\n  .endif", "(input):3: .else after .else in the same .if\n    .else");
  assertFails("  nop\n  .if 1\n  nop", "(input):2: .if has no matching .endif\n    .if 1");
  assertFails("  .if later\n  .endif\nlater = 1", '(input):1: Undefined symbol "later"\n    .if later');
});

test("macros: ca65 style .macro name params, parameters replaced by their bare names", () => {
  const source = ".macro store value, address\n  lda #value\n  sta address\n.endmacro\n  store 5, $d020\n  store 6, $d021";
  assert.deepEqual(code(source), [0xa9, 5, 0x8d, 0x20, 0xd0, 0xa9, 6, 0x8d, 0x21, 0xd0]);
  assert.deepEqual(code(".mac inc2 addr\n  inc addr\n  inc addr\n.endmac\n  inc2 $10"), [0xe6, 0x10, 0xe6, 0x10]);
  assert.deepEqual(code(".macro two\n  nop\n  nop\n.endmacro\n  two"), [0xea, 0xea]);
  // The macro name is case-insensitive; the expanded labels are global, so a label inside needs care.
  assert.deepEqual(code(".macro twice\n  nop\n.endmacro\n  TWICE\n  Twice"), [0xea, 0xea]);
});

test("macros: 64tass style name .macro params, called as #name or .name, with \\1 \\name \\{name} \\@", () => {
  const body = "set .macro value, address\n  lda #\\value\n  sta \\{address}\n.endm\n";
  assert.deepEqual(code(`${body}  #set 5, $d020`), [0xa9, 5, 0x8d, 0x20, 0xd0]);
  assert.deepEqual(code(`${body}  .set 6, $d021`), [0xa9, 6, 0x8d, 0x21, 0xd0]);
  assert.deepEqual(code("put .macro\n  lda #\\1\n  sta \\2\n.endmacro\n  #put 7, $d020"), [0xa9, 7, 0x8d, 0x20, 0xd0]);
  assert.deepEqual(code("all .macro\n  .byte \\@\n.endm\n  #all 1, 2, 3"), [1, 2, 3]);
});

test("macros: the argument count, nesting, duplicate names and missing ends are checked", () => {
  assert.deepEqual(code(".macro inner\n  nop\n.endmacro\n.macro outer\n  inner\n  inner\n.endmacro\n  outer"), [0xea, 0xea]);
  assertFails(".macro wait n\n  nop\n.endmacro\n  wait 1, 2", "(input):4: Macro wait takes 1 argument (n), got 2\n    wait 1, 2");
  assertFails(".macro wait n, m\n  nop\n.endmacro\n  wait 1", "(input):4: Macro wait takes 2 arguments (n, m), got 1\n    wait 1");
  assertFails(".macro m\n  nop\n.endmacro\n.macro m\n  nop\n.endmacro", '(input):4: Macro "m" is already defined (line 1)\n    .macro m');
  assertFails(".macro lda\n  nop\n.endmacro", '(input):1: Macro name "lda" is a mnemonic or directive\n    .macro lda');
  assertFails(".macro m\n  nop", "(input):1: .macro has no matching .endmacro\n    .macro m");
  assertFails(".endmacro", "(input):1: .endmacro without a matching .macro\n    .endmacro");
  assertFails(".endm", "(input):1: .endm without a matching .macro\n    .endm");
  assertFails(".macro\n  nop\n.endmacro", "(input):1: .macro needs a name: .macro name param1, param2 (ca65) or name .macro param1, param2 (64tass)\n    .macro");
  assertFails(".macro m 5\n  nop\n.endmacro", "(input):1: .macro parameters are names separated by commas\n    .macro m 5");
  assertFails("  #nomacro 1", "(input):1: #nomacro calls a macro that is not defined (macros must be defined before use)\n    #nomacro 1");
});

test("an error inside a macro or repeat expansion names the macro or repeat as context", () => {
  const error = assertFails(".macro bad\n  lda #300\n.endmacro\n  nop\n  bad", "(input):5 (in macro bad): Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte\n    lda #300");
  assert.equal(error.location.line, 5);
  assert.equal(error.location.context, "macro bad");
  assertFails(".repeat 2\n  lda #300\n.endrepeat", "(input):1 (in repeat): Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte\n    lda #300");
});

test("repeat: .repeat n and .rept n repeat the body, the count may use earlier constants", () => {
  assert.deepEqual(code(".repeat 3\n  nop\n.endrepeat"), [0xea, 0xea, 0xea]);
  assert.deepEqual(code(".rept 2\n  inx\n.endrept"), [0xe8, 0xe8]);
  assert.deepEqual(code(".repeat 2\n  nop\n.endrep"), [0xea, 0xea]);
  assert.deepEqual(code("count = 2 + 1\n.repeat count\n  iny\n.endrepeat"), [0xc8, 0xc8, 0xc8]);
  assert.deepEqual(code(".repeat 0\n  nop\n.endrepeat\n  rts"), [0x60]);
  assert.deepEqual(code(".repeat 2\n.repeat 2\n  nop\n.endrepeat\n.endrepeat"), [0xea, 0xea, 0xea, 0xea]);
  assertFails(".repeat 65537\n nop\n.endrepeat", "(input):1: .repeat needs a count of 0..65536 made of numbers and constants defined earlier with \"name = value\"\n    .repeat 65537");
  assertFails(".repeat later\n nop\n.endrepeat\nlater = 2", "(input):1: .repeat needs a count of 0..65536 made of numbers and constants defined earlier with \"name = value\"\n    .repeat later");
  assertFails(".repeat 2, i\n nop\n.endrepeat", '(input):1: .repeat with a counter name (ca65 ".repeat count, name") is not supported; use a macro or write the values out\n    .repeat 2, i');
  assertFails(".repeat 2\n nop", "(input):1: .repeat has no matching .endrepeat\n    .repeat 2");
  assertFails(".endrepeat", "(input):1: .endrepeat without a matching .repeat or .rept\n    .endrepeat");
  assertFails(".endrept", "(input):1: .endrept without a matching .repeat or .rept\n    .endrept");
});

test("expansion limits: more than 100000 expanded lines and nesting deeper than 16 are errors", () => {
  assertFails(".repeat 60000\n nop\n.endrepeat\n.repeat 60000\n nop\n.endrepeat", "(input):4: Macro and repeat expansion exceeds 100000 lines\n    .repeat 60000");
  const nested = Array.from({ length: 17 }, () => ".repeat 1").join("\n") + "\n nop\n" + Array.from({ length: 17 }, () => ".endrepeat").join("\n");
  assert.match(failure(nested).message, /Macro, repeat and include nesting is deeper than 16/);
});

test("expression operators and number formats", () => {
  const bytes = (expression) => code(`  .word ${expression}`);
  const cases = [
    ["$10", 0x10], ["0x10", 0x10], ["%1010", 10], ["0b1010", 10], ["10", 10], ["1+2*3", 7], ["(1+2)*3", 9], ["7/2", 3], ["-7/2", -3], ["7%4", 3],
    ["1<<4", 16], ["256>>4", 16], ["$f0&$3c", 0x30], ["$f0|$0f", 0xff], ["$ff^$0f", 0xf0], ["~0&$ffff", 0xffff], ["!0", 1], ["!5", 0], ["-(-5)", 5], ["+5", 5],
    ["1==1", 1], ["1!=1", 0], ["1<2", 1], ["2<=1", 0], ["3>2", 1], ["2>=3", 0], ["<$1234", 0x34], [">$1234", 0x12], ["<$1234+1", 0x35], ["%1010 % 4", 2],
    ["1|2^3&4", 3], ["2+3<<1", 10], ["1<2==1", 1],
  ];
  for (const [expression, value] of cases) {
    const masked = value & 0xffff;
    assert.deepEqual(bytes(expression), [masked & 0xff, masked >> 8], expression);
  }
  assertFails("  .byte 1/0", "(input):1: Division by zero\n    .byte 1/0");
  assertFails("  .byte 1%0", "(input):1: Modulo by zero\n    .byte 1%0");
  assertFails("  .byte 1<<32", "(input):1: Shift count 32 for << is outside 0..31\n    .byte 1<<32");
  assertFails("  .byte 1>>-1", "(input):1: Shift count -1 for >> is outside 0..31\n    .byte 1>>-1");
  assertFails("  .word 4294967296|1", "(input):1: Operand 4294967296 of | is outside the 32-bit range -2147483648..4294967295\n    .word 4294967296|1");
  assertFails("  .word ~4294967296", "(input):1: Operand 4294967296 of ~ is outside the 32-bit range -2147483648..4294967295\n    .word ~4294967296");
  assertFails("  .byte (1+2", "(input):1: Unexpected end of token stream\n    .byte (1+2");
  assertFails("  .byte 1+", "(input):1: Unexpected end of token stream\n    .byte 1+");
  assertFails("  .byte 1 2", "(input):1: Unexpected tokens at end of line\n    .byte 1 2");
  assertFails("  .byte $", "(input):1: Malformed numeric literal\n    .byte $");
  assertFails('  .byte 1+"ab"', "(input):1: String constants in expressions must be exactly one character\n    .byte 1+\"ab\"");
  assertFails("  .byte #1", "(input):1: Unexpected token in expression\n    .byte #1");
});

test("tokenizer errors: unknown characters and cheap local labels", () => {
  assertFails("  lda #`", "(input):1: Unexpected character '`' (U+0060)\n    lda #`");
  assertFails("  lda @x", "(input):1: Unexpected character '@': cheap local labels (ca65 @name) are not supported; use a local label such as .loop:\n    lda @x");
  assertFails("  lda \u0001", "(input):1: Unexpected character '' (U+0001)\n    lda \u0001");
  assertFails("  nop\n  bne -", "(input):2: Anonymous labels (+ and -, as in 64tass and ACME) are not supported; use a named label\n    bne -");
  assertFails("  +", '(input):1: Anonymous labels (+ and -, as in 64tass and ACME) are not supported; use a named label such as "loop:"\n    +');
  assertFails("  :", "(input):1: Expected an opcode, directive, or assignment\n    :");
});

test("comments: ; and // end a line, but not inside strings; CRLF, CR and a BOM are line breaks or ignored", () => {
  assert.deepEqual(code("  nop ; comment\n  nop // comment\n  .byte \";\", \"//\" ; x"), [0xea, 0xea, 0x3b, 0x2f, 0x2f]);
  assert.deepEqual(prg("\uFEFF* = $c000\r\n  nop\r  rts\r\n"), [0x00, 0xc0, 0xea, 0x60]);
  assert.deepEqual(code("\t nop\u00a0\n"), [0xea]);
});

test("a name in column 0 that nothing refers to is an error when alone and a warning before a statement", () => {
  assertFails("rts2\n  nop", '(input):1: Unknown instruction "rts2": a name alone in column 0 that nothing refers to is not taken as a label; write "rts2:" if it is one\n    rts2');
  assert.deepEqual(detailed("  * = $c000\nrts2 nop").warnings, [
    '(input):2: "rts2" in column 0 is taken as a label without a colon and nothing refers to it; if it is a misspelt instruction, that instruction is missing (write "rts2:" to silence this)',
  ]);
  assert.deepEqual(detailed("  * = $c000\nused nop\n  jmp used").warnings, []);
  assertFails("foo bar baz", '(input):1: Unknown instruction "foo" (a name in column 0 is a label only when an instruction, directive or macro follows it or nothing does; labels may also end with \':\')\n    foo bar baz');
  assertFails("  frob", '(input):1: Unknown instruction "FROB"\n    frob');
});
