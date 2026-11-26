import test from "#test/runner";
import assert from "#test/assert";
import { AssemblyError } from "../src/assembler.js";
import { code, detailed, failure } from "./helpers/asm.js";

/** Include resolver over an object of file name -> text; records every call. */
function files(table) {
  const calls = [];
  const resolveInclude = (requested, from) => {
    calls.push([requested, from]);
    if (!(requested in table)) throw new Error(`no such file ${requested}`);
    return table[requested];
  };
  return { resolveInclude, calls };
}

function binaries(table) {
  const calls = [];
  const resolveIncbin = (requested, from) => {
    calls.push([requested, from]);
    return table[requested];
  };
  return { resolveIncbin, calls };
}

test("include spellings .include, include, !source and !src assemble the returned text in place", () => {
  for (const spelling of [".include", "include", "!source", "!src", ".INCLUDE"]) {
    const { resolveInclude, calls } = files({ "lib.asm": "  lda #1\n  rts" });
    assert.deepEqual(code(`  nop\n  ${spelling} "lib.asm"\n  inx`, { resolveInclude }), [0xea, 0xa9, 0x01, 0x60, 0xe8], spelling);
    assert.deepEqual(calls, [["lib.asm", "(input)"]], spelling);
  }
});

test("the resolver receives the including file name, so relative includes can be resolved", () => {
  const { resolveInclude, calls } = files({ "a.asm": '  .include "sub/b.asm"', "sub/b.asm": "  nop" });
  assert.deepEqual(code('  .include "a.asm"', { resolveInclude, fileName: "main.asm" }), [0xea]);
  assert.deepEqual(calls, [["a.asm", "main.asm"], ["sub/b.asm", "a.asm"]]);
});

test("the resolver may return an object with a new file name for diagnostics, which later includes see", () => {
  const calls = [];
  const resolveInclude = (requested, from) => {
    calls.push([requested, from]);
    return requested === "a" ? { contents: '  .include "b"', fileName: "/project/a.asm" } : { contents: "  nop" };
  };
  assert.deepEqual(code('  .include "a"', { resolveInclude }), [0xea]);
  assert.deepEqual(calls, [["a", "(input)"], ["b", "/project/a.asm"]]);
});

test("included source defines labels and symbols for the including file and vice versa", () => {
  const { resolveInclude } = files({ "defs.asm": "border = $d020\nhelper: rts" });
  const result = detailed('  .include "defs.asm"\n  jsr helper\n  sta border', { resolveInclude, loadAddress: 0xc000 });
  assert.deepEqual([...result.prg], [0x00, 0xc0, 0x60, 0x20, 0x00, 0xc0, 0x8d, 0x20, 0xd0]);
  assert.deepEqual([...result.symbols], [["border", 0xd020], ["helper", 0xc000]]);
});

test("an included file is read again for each include, and a BOM and CRLF line ends are handled", () => {
  const { resolveInclude, calls } = files({ "n.asm": "﻿  nop\r\n" });
  assert.deepEqual(code('  .include "n.asm"\n  .include "n.asm"', { resolveInclude }), [0xea, 0xea]);
  assert.equal(calls.length, 2);
});

test("include errors: no resolver, recursion, and a resolver that throws", () => {
  assert.equal(
    failure('  .include "x.asm"').message,
    '(input):1: include needs a resolveInclude option; the MCP tools provide none, so paste the included source into the program\n    .include "x.asm"',
  );
  const recursive = files({ "a.asm": '  .include "a.asm"' });
  assert.equal(failure('  .include "a.asm"', { resolveInclude: recursive.resolveInclude }).message, 'a.asm:1: Recursive include detected for "a.asm"\n    .include "a.asm"');
  const missing = files({});
  assert.equal(failure('  .include "gone.asm"', { resolveInclude: missing.resolveInclude }).message, '(input):1: no such file gone.asm\n    .include "gone.asm"');
  assert.equal(failure("  .include lib", { resolveInclude: missing.resolveInclude }).message, "(input):1: include expects a string literal path\n    .include lib");
  assert.equal(failure('  .include "a" "b"', { resolveInclude: missing.resolveInclude }).message, '(input):1: Unexpected tokens at end of line\n    .include "a" "b"');
});

test("an error in an included file carries that file's name and line", () => {
  const { resolveInclude } = files({ "lib.asm": "  nop\n  nop\n  lda #300\n" });
  const error = failure('  .include "lib.asm"', { resolveInclude, fileName: "main.asm" });
  assert.ok(error instanceof AssemblyError);
  assert.equal(error.message, "lib.asm:3: Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte\n    lda #300");
  assert.deepEqual(error.location, { file: "lib.asm", line: 3, text: "  lda #300" });
});

test("a syntax error in an included file names the file the resolver reported", () => {
  const resolveInclude = () => ({ contents: "  nop\n  lda (\n", fileName: "/src/lib.asm" });
  const error = failure('  .include "lib"', { resolveInclude });
  assert.equal(error.message, "/src/lib.asm:2: Unexpected end of token stream\n    lda (");
  assert.equal(error.location.file, "/src/lib.asm");
  assert.equal(error.location.line, 2);
});

test("an error in a second-level include names the innermost file, and the root file name is used for the rest", () => {
  const { resolveInclude } = files({ "a.asm": '  nop\n  .include "b.asm"', "b.asm": "  nop\n  bne nowhere" });
  const error = failure('  .include "a.asm"', { resolveInclude, fileName: "main.asm" });
  assert.equal(error.message, 'b.asm:2: Undefined symbol "nowhere"\n    bne nowhere');
  const rootError = failure('  nop\n  .include "a.asm"\n  lda #300', { resolveInclude: files({ "a.asm": "  nop" }).resolveInclude, fileName: "main.asm" });
  assert.equal(rootError.message, "main.asm:3: Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte\n    lda #300");
});

test("the default file name is (input) and fileName replaces it in every message", () => {
  assert.equal(failure("  bogus").message, '(input):1: Unknown instruction "BOGUS"\n    bogus');
  assert.equal(failure("  bogus", { fileName: "player.asm" }).message, 'player.asm:1: Unknown instruction "BOGUS"\n    bogus');
  assert.equal(failure("  bogus", { fileName: "player.asm" }).location.file, "player.asm");
});

test("long source lines are shortened to 160 characters in the message", () => {
  const long = `  lda ${"1+".repeat(100)}x`;
  const message = failure(long).message;
  const shown = message.split("\n    ")[1];
  assert.equal(shown.length, 160);
  assert.ok(shown.endsWith("..."));
});

test(".incbin and .binary insert the bytes the resolver returns; offset and length select a part", () => {
  const { resolveIncbin, calls } = binaries({ "d.bin": Uint8Array.of(1, 2, 3, 4, 5) });
  for (const spelling of [".incbin", ".binary", ".INCBIN"]) {
    assert.deepEqual(code(`  ${spelling} "d.bin"`, { resolveIncbin }), [1, 2, 3, 4, 5], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 2`, { resolveIncbin }), [3, 4, 5], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 1, 3`, { resolveIncbin }), [2, 3, 4], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 5`, { resolveIncbin }), [], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 0, 0`, { resolveIncbin }), [], spelling);
  }
  assert.deepEqual(calls[0], ["d.bin", "(input)"]);
});

test("the incbin resolver is called once per path and assembly, with the including file name", () => {
  const { resolveIncbin, calls } = binaries({ "d.bin": Uint8Array.of(9) });
  assert.deepEqual(code('  .incbin "d.bin"\n  .incbin "d.bin"\n  .incbin "d.bin"', { resolveIncbin, fileName: "m.asm" }), [9, 9, 9]);
  assert.deepEqual(calls, [["d.bin", "m.asm"]]);
});

test("incbin offsets may be expressions and the binary advances the program counter in both passes", () => {
  const { resolveIncbin } = binaries({ "d.bin": Uint8Array.of(1, 2, 3, 4) });
  assert.deepEqual(code('skip = 1\n  .incbin "d.bin", skip, 2\nafter: jmp after', { resolveIncbin }), [2, 3, 0x4c, 0x02, 0xc0]);
});

test(".incbin errors: no resolver, bad ranges, oversized or wrong-typed results, missing path", () => {
  assert.equal(
    failure('  .incbin "d.bin"').message,
    '(input):1: .incbin needs a resolveIncbin option; the MCP tools provide none, so write the bytes with .byte\n    .incbin "d.bin"',
  );
  const { resolveIncbin } = binaries({ "d.bin": Uint8Array.of(1, 2, 3, 4), big: new Uint8Array(65537), text: "abc" });
  assert.equal(
    failure('  .incbin "d.bin", 3, 2', { resolveIncbin }).message,
    '(input):1: .incbin "d.bin": offset 3 and length 2 do not fit the 4 bytes of the file\n    .incbin "d.bin", 3, 2',
  );
  assert.equal(
    failure('  .incbin "d.bin", 5', { resolveIncbin }).message,
    '(input):1: .incbin "d.bin": offset 5 and length -1 do not fit the 4 bytes of the file\n    .incbin "d.bin", 5',
  );
  assert.equal(
    failure('  .incbin "d.bin", -1', { resolveIncbin }).message,
    '(input):1: .incbin "d.bin": offset -1 and length 5 do not fit the 4 bytes of the file\n    .incbin "d.bin", -1',
  );
  assert.equal(failure('  .incbin "big"', { resolveIncbin }).message, '(input):1: .incbin "big" must give at most 65536 bytes\n    .incbin "big"');
  assert.equal(failure('  .incbin "text"', { resolveIncbin }).message, '(input):1: .incbin "text" must give at most 65536 bytes\n    .incbin "text"');
  assert.equal(failure("  .incbin d", { resolveIncbin }).message, "(input):1: incbin expects a string literal path\n    .incbin d");
  assert.equal(failure('  .incbin "d.bin", later', { resolveIncbin }).message, '(input):1: Undefined symbol "later"\n    .incbin "d.bin", later');
});

test("!binary and !bin take [size][, skip]; either value may be left out; a short file is padded with a warning", () => {
  const { resolveIncbin } = binaries({ "d.bin": Uint8Array.of(1, 2, 3, 4) });
  for (const spelling of ["!binary", "!bin", "!BINARY"]) {
    assert.deepEqual(code(`  ${spelling} "d.bin"`, { resolveIncbin }), [1, 2, 3, 4], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 2`, { resolveIncbin }), [1, 2], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 2, 1`, { resolveIncbin }), [2, 3], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin",, 2`, { resolveIncbin }), [3, 4], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", , `, { resolveIncbin }), [1, 2, 3, 4], spelling);
    assert.deepEqual(code(`  ${spelling} "d.bin", 0`, { resolveIncbin }), [], spelling);
  }
  const result = detailed('  * = $c000\n  !binary "d.bin", 6, 1', { resolveIncbin });
  assert.deepEqual([...result.prg], [0x00, 0xc0, 2, 3, 4, 0, 0, 0]);
  assert.deepEqual(result.warnings, ['(input):2: !binary "d.bin" has 3 bytes after offset 1; padded with 3 zero bytes to SIZE 6']);
});

test("!binary errors: no resolver, skip and size out of range, path not a string", () => {
  assert.equal(
    failure('  !binary "d.bin"').message,
    '(input):1: !binary needs a resolveIncbin option; the MCP tools provide none, so write the bytes with .byte\n    !binary "d.bin"',
  );
  const { resolveIncbin } = binaries({ "d.bin": Uint8Array.of(1, 2, 3, 4) });
  assert.equal(failure('  !binary "d.bin",, 5', { resolveIncbin }).message, '(input):1: !binary "d.bin": SKIP 5 is outside the 4 bytes of the file\n    !binary "d.bin",, 5');
  assert.equal(failure('  !binary "d.bin",, -1', { resolveIncbin }).message, '(input):1: !binary "d.bin": SKIP -1 is outside the 4 bytes of the file\n    !binary "d.bin",, -1');
  assert.equal(failure('  !binary "d.bin", 65537', { resolveIncbin }).message, '(input):1: !binary "d.bin": SIZE 65537 is outside 0..65536\n    !binary "d.bin", 65537');
  assert.equal(failure('  !binary "d.bin", -1', { resolveIncbin }).message, '(input):1: !binary "d.bin": SIZE -1 is outside 0..65536\n    !binary "d.bin", -1');
  assert.equal(failure("  !binary d", { resolveIncbin }).message, "(input):1: !binary expects a string literal path\n    !binary d");
  assert.equal(failure('  !binary "d.bin", 1, 1, 1', { resolveIncbin }).message, '(input):1: Unexpected tokens at end of line\n    !binary "d.bin", 1, 1, 1');
});

test("incbin data that is written twice at the same address is an overlap error", () => {
  const { resolveIncbin } = binaries({ "d.bin": Uint8Array.of(1, 2) });
  assert.equal(
    failure('  * = $c000\n  .incbin "d.bin"\n  * = $c001\n  .incbin "d.bin"', { resolveIncbin }).message,
    '(input):4: Overlapping output: the block starting at $C001 (line 4) writes $C001, which the block $C000-$C001 (line 2) already wrote\n    .incbin "d.bin"',
  );
});
