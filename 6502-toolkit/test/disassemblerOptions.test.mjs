import test from "#test/runner";
import assert from "#test/assert";
import { disassemble, formatDisassembly } from "../src/disassembler.js";

const bytes = (...values) => Uint8Array.from(values);

test("disassemble decodes a sequence and advances by the instruction size", () => {
  const lines = disassemble(bytes(0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60), 0xc000);
  assert.deepEqual(
    lines.map((line) => [line.address, line.bytes, line.mnemonic, line.operand, line.undocumented, line.label]),
    [
      [0xc000, [0xa9, 0x01], "LDA", "#$01", false, undefined],
      [0xc002, [0x8d, 0x20, 0xd0], "STA", "$D020", false, undefined],
      [0xc005, [0x60], "RTS", "", false, undefined],
    ],
  );
});

test("the count limit works as a number and as an option", () => {
  const input = bytes(0xea, 0xea, 0xea, 0xea);
  assert.equal(disassemble(input, 0x1000, 2).length, 2);
  assert.equal(disassemble(input, 0x1000, { count: 3 }).length, 3);
  assert.equal(disassemble(input, 0x1000, 0).length, 0);
  assert.equal(disassemble(input, 0x1000).length, 4);
  assert.equal(disassemble(input, 0x1000, undefined).length, 4);
  assert.deepEqual(disassemble(new Uint8Array(0), 0x1000), []);
});

test("symbols label instruction addresses and name branch and absolute targets, in both argument forms", () => {
  const symbols = new Map([[0xc000, "start"], [0xc006, "done"], [0xd020, "border"], [0xc100, "table"]]);
  const input = bytes(0xa9, 0x00, 0x8d, 0x20, 0xd0, 0xf0, 0x01, 0x60, 0x6c, 0x00, 0xc1, 0xbd, 0x00, 0xc1);
  const expected = [
    ["start", "#$00", undefined],
    [undefined, "$D020", "border"],
    [undefined, "$C008", undefined],
    [undefined, "($C100)", undefined],
    [undefined, "$C100,X", "table"],
  ];
  for (const lines of [disassemble(input, 0xc000, { symbols }), disassemble(input, 0xc000, undefined, symbols)]) {
    // The branch at $C005 goes to $C008; the label "done" is at $C006, in the middle of the branch.
    assert.deepEqual(lines.map((line) => [line.label, line.operand, line.operandLabel]), [
      expected[0], expected[1], expected[2], [undefined, "", undefined], expected[3], expected[4],
    ]);
    assert.equal(lines[3].label, undefined);
  }
  const labelled = disassemble(bytes(0xea, 0x60), 0xc005, { symbols: new Map([[0xc006, "done"]]) });
  assert.deepEqual(labelled.map((line) => line.label), [undefined, "done"]);
  const relative = disassemble(bytes(0xd0, 0xfe), 0xc000, { symbols: new Map([[0xc000, "loop"]]) });
  assert.deepEqual([relative[0].label, relative[0].operand, relative[0].operandLabel], ["loop", "$C000", "loop"]);
  const absY = disassemble(bytes(0xb9, 0x00, 0x04), 0x1000, { symbols: new Map([[0x0400, "screen"]]) });
  assert.equal(absY[0].operandLabel, "screen");
});

test("branches decode forward and backward offsets and wrap at the ends of the address space", () => {
  assert.equal(disassemble(bytes(0xd0, 0x7f), 0xc000)[0].operand, "$C081");
  assert.equal(disassemble(bytes(0xd0, 0x80), 0xc000)[0].operand, "$BF82");
  assert.equal(disassemble(bytes(0xd0, 0x00), 0xfffe)[0].operand, "$0000");
  assert.equal(disassemble(bytes(0xd0, 0xfe), 0x0000)[0].operand, "$0000");
  assert.equal(disassemble(bytes(0xd0, 0x80), 0x0000)[0].operand, "$FF82");
});

test("addresses wrap at $FFFF", () => {
  const lines = disassemble(bytes(0xea, 0xea, 0xea), 0xffff);
  assert.deepEqual(lines.map((line) => line.address), [0xffff, 0x0000, 0x0001]);
});

test("allowUndocumented false turns every undocumented opcode into one ??? byte", () => {
  const lines = disassemble(bytes(0xa9, 0x01, 0x4b, 0x7f, 0xea, 0x02, 0x1a), 0xc000, { allowUndocumented: false });
  assert.deepEqual(lines.map((line) => [line.address, line.bytes, line.mnemonic, line.operand, line.undocumented]), [
    [0xc000, [0xa9, 0x01], "LDA", "#$01", false],
    [0xc002, [0x4b], "???", "$4B", true],
    [0xc003, [0x7f], "???", "$7F", true],
    [0xc004, [0xea], "NOP", "", false],
    [0xc005, [0x02], "???", "$02", true],
    [0xc006, [0x1a], "???", "$1A", true],
  ]);
  const labelled = disassemble(bytes(0x02), 0xc000, { allowUndocumented: false, symbols: new Map([[0xc000, "bad"]]) });
  assert.equal(labelled[0].label, "bad");
  assert.equal(disassemble(bytes(0x4b, 0x7f), 0xc000, { allowUndocumented: true })[0].mnemonic, "ALR");
});

test("input that ends inside an instruction is shown as .byte data, not as an invented operand", () => {
  const cases = [
    [[0xad], ".byte", "$AD", [0xad]],
    [[0xad, 0x34], ".byte", "$AD,$34", [0xad, 0x34]],
    [[0xa9], ".byte", "$A9", [0xa9]],
    [[0xea, 0x6c, 0x00], ".byte", "$6C,$00", [0x6c, 0x00]],
  ];
  for (const [input, mnemonic, operand, tail] of cases) {
    const lines = disassemble(bytes(...input), 0xc000);
    const last = lines[lines.length - 1];
    assert.equal(last.mnemonic, mnemonic);
    assert.equal(last.operand, operand);
    assert.deepEqual(last.bytes, tail);
    assert.equal(last.undocumented, false);
  }
  const symbols = new Map([[0xc000, "cut"]]);
  assert.equal(disassemble(bytes(0xad), 0xc000, { symbols })[0].label, "cut");
});

test("formatDisassembly renders labels, bytes, undocumented marks and operand labels", () => {
  const symbols = new Map([[0xc000, "start"], [0xd020, "border"]]);
  const lines = disassemble(bytes(0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x4b, 0x7f, 0x60), 0xc000, { symbols });
  assert.equal(
    formatDisassembly(lines),
    [
      "start:",
      "  $C000  A9 00     LDA #$00",
      "  $C002  8D 20 D0  STA $D020  ; border",
      "  $C005  4B 7F     ALR* #$7F",
      "  $C007  60        RTS",
    ].join("\n"),
  );
  assert.equal(formatDisassembly([]), "");
});

test("the lowest and highest opcode bytes are handled, and bytes above 255 are masked by the typed array", () => {
  assert.equal(disassemble(bytes(0x00), 0).at(0).mnemonic, "BRK");
  assert.equal(disassemble(bytes(0xff, 0x34, 0x12), 0).at(0).mnemonic, "ISC");
  assert.equal(disassemble(bytes(0xff, 0x34, 0x12), 0).at(0).operand, "$1234,X");
});
