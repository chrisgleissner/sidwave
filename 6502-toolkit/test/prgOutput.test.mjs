import test from "#test/runner";
import assert from "#test/assert";
import { AssemblyError, assemblyToPrg, assemblyToPrgDetailed, prgEntryAddress } from "../src/assembler.js";
import { detailed, failure, prg } from "./helpers/asm.js";

/** The ten bytes of the stub for an entry address, as "10 SYS0nnnn": link, line number 10, SYS token, five digits, end of line. */
function stub(entry) {
  const digits = String(entry).padStart(5, "0");
  return [0x0c, 0x08, 0x0a, 0x00, 0x9e, ...[...digits].map((digit) => digit.charCodeAt(0)), 0x00, 0x00, 0x00];
}

test("the PRG starts with the load address, low byte first", () => {
  assert.deepEqual(prg("* = $c000\n  rts").slice(0, 2), [0x00, 0xc0]);
  assert.deepEqual(prg("* = $1234\n  rts").slice(0, 2), [0x34, 0x12]);
  assert.deepEqual(prg("* = $0000\n  rts"), [0x00, 0x00, 0x60]);
  assert.deepEqual(prg("* = $ffff\n  rts"), [0xff, 0xff, 0x60]);
});

test("code at $0801 without an origin gets a 10 SYS stub that jumps to the first instruction", () => {
  const bytes = prg("  lda #1\n  rts");
  const entry = 0x0801 + 13;
  assert.deepEqual(bytes, [0x01, 0x08, ...stub(entry), 0xa9, 0x01, 0x60]);
  assert.equal(entry, 2062);
  assert.equal(String.fromCharCode(...bytes.slice(7, 12)), "02062");
});

test("the stub follows the first instruction even when data comes before it", () => {
  const bytes = prg("data: .byte 1, 2, 3\n  rts");
  // The first instruction is the RTS, after the stub and three data bytes.
  assert.deepEqual(bytes, [0x01, 0x08, ...stub(0x0801 + 13 + 3), 1, 2, 3, 0x60]);
});

test("the load address option replaces $0801 and does not get a stub unless it is $0801", () => {
  assert.deepEqual(prg("  rts", { loadAddress: 0xc000 }), [0x00, 0xc0, 0x60]);
  assert.deepEqual(prg("  rts", { loadAddress: 0x0801 }), [0x01, 0x08, ...stub(0x080e), 0x60]);
  assert.deepEqual(prg("  rts", { loadAddress: 0x0800 }), [0x00, 0x08, 0x60]);
  assert.deepEqual(prg("  rts", { loadAddress: 0 }), [0x00, 0x00, 0x60]);
  assert.deepEqual(prg("  rts", { loadAddress: 0xffff }), [0xff, 0xff, 0x60]);
});

test("the load address option is validated", () => {
  for (const bad of [-1, 0x10000, 1.5, Number.NaN, Infinity]) {
    const error = failure("  rts", { loadAddress: bad });
    assert.ok(error instanceof AssemblyError);
    assert.equal(error.message, `(input):0: loadAddress ${bad} is outside $0000-$FFFF`);
    assert.deepEqual(error.location, { file: "(input)", line: 0, text: "" });
  }
  assert.equal(failure("  rts", { loadAddress: -1, fileName: "main.asm" }).message, "main.asm:0: loadAddress -1 is outside $0000-$FFFF");
});

test("no stub when the source sets its own origin, even $0801", () => {
  assert.deepEqual(prg("  * = $0801\n  rts"), [0x01, 0x08, 0x60]);
  assert.deepEqual(prg("  .org $0801\n  rts"), [0x01, 0x08, 0x60]);
  assert.deepEqual(prg("  org $0801\n  rts"), [0x01, 0x08, 0x60]);
});

test("no stub for data-only source, or data at $0801 followed by code at an explicit origin", () => {
  assert.deepEqual(prg("  .byte 1, 2, 3"), [0x01, 0x08, 1, 2, 3]);
  assert.deepEqual(prg("  .text \"HI\""), [0x01, 0x08, 0x48, 0x49]);
  assert.deepEqual(prg("  .byte 1\n  * = $0810\n  rts"), [0x01, 0x08, 1, ...Array(14).fill(0), 0x60]);
  const result = detailed("  .byte 1\n  * = $c000\n  rts");
  assert.equal(result.entryAddress, 0xc000);
});

test("a hand-written BASIC line at $0801 is kept as written", () => {
  // 10 SYS 2062 written as data, followed by code at $080E.
  const source = "  * = $0801\n  .word $080b\n  .word 10\n  .byte $9e\n  .text \"2062\"\n  .byte 0, 0, 0\n  rts";
  const result = detailed(source);
  assert.deepEqual([...result.prg], [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x32, 0x00, 0x00, 0x00, 0x60]);
  assert.equal(result.entryAddress, 2062);
});

test("prgEntryAddress returns the SYS target of a leading BASIC line at $0801, otherwise the load address", () => {
  const withStub = Uint8Array.from([0x01, 0x08, ...stub(2062), 0x60]);
  assert.equal(prgEntryAddress(withStub), 2062);
  const text = (line) => Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, ...line, 0x00, 0x00, 0x00]);
  assert.equal(prgEntryAddress(text([0x9e, ..."4096"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)))), 4096);
  assert.equal(prgEntryAddress(text([0x9e, 0x20, 0x28, ..."49152"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)))), 49152);
  assert.equal(prgEntryAddress(text([0x20, 0x20, 0x9e, ..."2061"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)))), 2061);
  assert.equal(prgEntryAddress(text([0x9e, ..."65536"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)))), 0x0801);
  assert.equal(prgEntryAddress(text([0x9e])), 0x0801);
  assert.equal(prgEntryAddress(text([0x99, ..."2061"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)))), 0x0801);
  assert.equal(prgEntryAddress(Uint8Array.from([0x00, 0xc0, 0x60])), 0xc000);
  assert.equal(prgEntryAddress(Uint8Array.from([0x01, 0x08, 0x60])), 0x0801);
  assert.equal(prgEntryAddress(Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e])), 0x0801);
  assert.equal(prgEntryAddress(new Uint8Array(0)), 0);
  assert.equal(prgEntryAddress(Uint8Array.of(0x34)), 0x34);
});

test("entryAddress: the SYS target when there is a stub, otherwise the first instruction, otherwise the load address", () => {
  assert.equal(detailed("  rts").entryAddress, 2062);
  assert.equal(detailed("  * = $c000\n  .byte 1\n  nop").entryAddress, 0xc001);
  assert.equal(detailed("  * = $c000\n  .byte 1, 2").entryAddress, 0xc000);
  assert.equal(detailed("  .byte 1, 2").entryAddress, 0x0801);
  assert.equal(detailed("  * = $0900\n  jmp *").entryAddress, 0x0900);
  assert.equal(detailed("  rts", { loadAddress: 0xc000 }).entryAddress, 0xc000);
});

test("symbols: global labels and constants after both passes, local labels excluded", () => {
  const result = detailed("  * = $c000\nstart: nop\n.loop: jmp .loop\nend: rts\nvalue = $1234\n.local = 5");
  assert.deepEqual([...result.symbols], [["start", 0xc000], ["end", 0xc004], ["value", 0x1234]]);
  assert.ok(result.prg instanceof Uint8Array);
});

test("assemblyToPrg returns the same bytes as assemblyToPrgDetailed", () => {
  const source = "  * = $c000\n  lda #1\n  rts";
  assert.deepEqual([...assemblyToPrg(source)], [...assemblyToPrgDetailed(source).prg]);
});

test("an empty image warns and has no bytes, not even a load address", () => {
  for (const source of ["", "; only a comment\n", "label:", "x = 5", "  * = $c000\nbuf: .res 8"]) {
    const result = detailed(source);
    assert.deepEqual([...result.prg], [], JSON.stringify(source));
    assert.deepEqual(result.warnings, ["The source emits no bytes (only labels, equates or .res); the PRG is empty"]);
    assert.equal(result.entryAddress, 0x0801);
  }
});

test("a trailing .res of 1024 bytes or more is zero-filled into the PRG and reported", () => {
  const result = detailed("  * = $c000\n  nop\nbuffer: .res 2000");
  assert.equal(result.prg.length, 2 + 1 + 2000);
  assert.deepEqual([...result.prg.subarray(0, 4)], [0x00, 0xc0, 0xea, 0x00]);
  assert.deepEqual(result.warnings, [
    ".res space next to the emitted bytes adds 2000 zero bytes to the PRG ($C000-$C7D0); put big buffers in a separate .org block or define them with name = address instead",
  ]);
  // Below the threshold there is no warning, but the space is still part of the image.
  const small = detailed("  * = $c000\n  nop\nbuffer: .res 1023");
  assert.equal(small.prg.length, 2 + 1 + 1023);
  assert.deepEqual(small.warnings, []);
});

test("reserved space in front of the emitted bytes extends the image to the left", () => {
  const result = detailed("  * = $c000\nbuffer: .res 1100\n  nop");
  assert.equal(result.prg.length, 2 + 1100 + 1);
  assert.deepEqual([...result.prg.subarray(0, 2)], [0x00, 0xc0]);
  assert.equal(result.prg[result.prg.length - 1], 0xea);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^\.res space next to the emitted bytes adds 1100 zero bytes to the PRG \(\$C000-\$C44C\);/);
});

test("overlapping and adjoining reservations are merged into one extension", () => {
  const result = detailed("  * = $c000\n  nop\n  * = $c001\n  .res 900\n  * = $c200\n  .res 900");
  assert.deepEqual([...result.prg.subarray(0, 3)], [0x00, 0xc0, 0xea]);
  assert.equal(result.prg.length, 2 + (0xc200 + 900 - 0xc000));
  assert.deepEqual(result.warnings, [
    ".res space next to the emitted bytes adds 1411 zero bytes to the PRG ($C000-$C583); put big buffers in a separate .org block or define them with name = address instead",
  ]);
});

test("a gap of zero bytes between output blocks is part of the PRG; 1024 bytes or more is reported", () => {
  const small = detailed("  * = $c000\n  .byte 1\n  * = $c010\n  .byte 2");
  assert.deepEqual([...small.prg], [0x00, 0xc0, 1, ...Array(15).fill(0), 2]);
  assert.deepEqual(small.warnings, []);
  const large = detailed("  * = $c000\n  .byte 1\n  * = $c800\n  .byte 2");
  assert.equal(large.prg.length, 2 + 0x801);
  assert.deepEqual(large.warnings, [
    "2047 zero bytes $C001-$C7FF between output blocks are part of the PRG; assemble the blocks separately or move them closer",
  ]);
});

test("a gap that touches $D000-$DFFF is refused", () => {
  const error = failure("  * = $cff0\n  .byte 1\n  * = $d010\n  .byte 2");
  assert.ok(error instanceof AssemblyError);
  assert.equal(
    error.message,
    "(input):4: The zero-filled gap $CFF1-$D00F between output blocks overlaps $D000-$DFFF (I/O registers); assemble the blocks separately instead",
  );
});

test("output blocks that overlap are an error naming both blocks", () => {
  const error = failure("  * = $c000\n  .byte 1, 2, 3\n  * = $c001\n  .byte 9");
  assert.equal(
    error.message,
    "(input):4: Overlapping output: the block starting at $C001 (line 4) writes $C001, which the block $C000-$C002 (line 2) already wrote\n    .byte 9",
  );
});

test("blocks written in descending address order are still one PRG from the lowest address", () => {
  assert.deepEqual(prg("  * = $c002\n  .byte 3\n  * = $c000\n  .byte 1, 2"), [0x00, 0xc0, 1, 2, 3]);
});

test("warnings from the label check come first, then the assembler warnings", () => {
  const result = detailed("  * = $c000\nunused nop\n  .text \"a\"");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /"unused" in column 0 is taken as a label/);
  assert.match(result.warnings[1], /^\(input\):3: \.text turns a-z/);
});
