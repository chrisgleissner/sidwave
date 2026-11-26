import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { OPCODES_PAGE, renderOpcodesPage } from "../scripts/gen-opcode-table.mjs";
import { OPCODE_INVENTORY } from "../src/opcodeInventory.js";

test("doc/opcodes.md is exactly what scripts/gen-opcode-table.mjs generates", () => {
  const committed = fs.readFileSync(OPCODES_PAGE, "utf8");
  assert.equal(committed, renderOpcodesPage(), "run: node scripts/gen-opcode-table.mjs");
});

test("the generated page has one row per opcode, in order, with the documented count in the text", () => {
  const rows = renderOpcodesPage().split("\n").filter((line) => line.startsWith("| $"));
  assert.equal(rows.length, 256);
  rows.forEach((row, opcode) => {
    const cells = row.split("|").map((cell) => cell.trim());
    assert.equal(cells[1], `$${opcode.toString(16).toUpperCase().padStart(2, "0")}`);
    assert.equal(cells[2], OPCODE_INVENTORY[opcode].mnemonic);
    assert.equal(cells[6], OPCODE_INVENTORY[opcode].illegal ? "undocumented" : "documented");
  });
  assert.match(renderOpcodesPage(), /151 are documented and 105 are undocumented\./);
});

test("selected rows of the generated page, written out", () => {
  const page = renderOpcodesPage();
  const expected = [
    "| $00 | BRK | implied | `BRK` | 1 | documented |  |",
    "| $02 | JAM | implied | `JAM` | 1 | undocumented | stops the CPU until reset |",
    "| $0A | ASL | accumulator | `ASL A` | 1 | documented |  |",
    "| $1A | NOP | implied | `NOP` | 1 | undocumented | same as $EA; the assembler emits $EA |",
    "| $4C | JMP | absolute | `JMP $aaaa` | 3 | documented |  |",
    "| $6C | JMP | indirect | `JMP ($aaaa)` | 3 | documented |  |",
    "| $91 | STA | (zero page),Y | `STA ($nn),Y` | 2 | documented |  |",
    "| $D0 | BNE | relative | `BNE $aaaa` | 2 | documented |  |",
    "| $EA | NOP | implied | `NOP` | 1 | documented |  |",
    "| $EB | SBC | immediate | `SBC #$nn` | 2 | undocumented | same as $E9; the assembler emits $E9 |",
  ];
  for (const row of expected) assert.ok(page.includes(`${row}\n`), row);
});
