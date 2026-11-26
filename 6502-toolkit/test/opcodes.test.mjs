import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg } from "../src/assembler.js";
import { disassemble, isUndocumentedOpcode, opcodeMetadata } from "../src/disassembler.js";
import { OPCODE_INVENTORY, OPCODES_BY_BYTE, OpcodeAddressingMode, opcodeSize } from "../src/opcodeInventory.js";
import { code } from "./helpers/asm.js";

/**
 * The 256-opcode matrix written out independently of the inventory (16 rows of 16 columns), in the
 * canonical names of the 1541 Ultimate monitor (JAM, SLO, SRE, DCP, ISC). The suffix is the addressing
 * mode: "A" accumulator, "#" immediate, zp, zpx, zpy, abs, abx, aby, ind, izx = (zp,X), izy = (zp),Y, rel.
 */
const MATRIX = [
  "BRK|ORA izx|JAM|SLO izx|NOP zp|ORA zp|ASL zp|SLO zp|PHP|ORA #|ASL A|ANC #|NOP abs|ORA abs|ASL abs|SLO abs",
  "BPL rel|ORA izy|JAM|SLO izy|NOP zpx|ORA zpx|ASL zpx|SLO zpx|CLC|ORA aby|NOP|SLO aby|NOP abx|ORA abx|ASL abx|SLO abx",
  "JSR abs|AND izx|JAM|RLA izx|BIT zp|AND zp|ROL zp|RLA zp|PLP|AND #|ROL A|ANC #|BIT abs|AND abs|ROL abs|RLA abs",
  "BMI rel|AND izy|JAM|RLA izy|NOP zpx|AND zpx|ROL zpx|RLA zpx|SEC|AND aby|NOP|RLA aby|NOP abx|AND abx|ROL abx|RLA abx",
  "RTI|EOR izx|JAM|SRE izx|NOP zp|EOR zp|LSR zp|SRE zp|PHA|EOR #|LSR A|ALR #|JMP abs|EOR abs|LSR abs|SRE abs",
  "BVC rel|EOR izy|JAM|SRE izy|NOP zpx|EOR zpx|LSR zpx|SRE zpx|CLI|EOR aby|NOP|SRE aby|NOP abx|EOR abx|LSR abx|SRE abx",
  "RTS|ADC izx|JAM|RRA izx|NOP zp|ADC zp|ROR zp|RRA zp|PLA|ADC #|ROR A|ARR #|JMP ind|ADC abs|ROR abs|RRA abs",
  "BVS rel|ADC izy|JAM|RRA izy|NOP zpx|ADC zpx|ROR zpx|RRA zpx|SEI|ADC aby|NOP|RRA aby|NOP abx|ADC abx|ROR abx|RRA abx",
  "NOP #|STA izx|NOP #|SAX izx|STY zp|STA zp|STX zp|SAX zp|DEY|NOP #|TXA|XAA #|STY abs|STA abs|STX abs|SAX abs",
  "BCC rel|STA izy|JAM|AHX izy|STY zpx|STA zpx|STX zpy|SAX zpy|TYA|STA aby|TXS|TAS aby|SHY abx|STA abx|SHX aby|AHX aby",
  "LDY #|LDA izx|LDX #|LAX izx|LDY zp|LDA zp|LDX zp|LAX zp|TAY|LDA #|TAX|LAX #|LDY abs|LDA abs|LDX abs|LAX abs",
  "BCS rel|LDA izy|JAM|LAX izy|LDY zpx|LDA zpx|LDX zpy|LAX zpy|CLV|LDA aby|TSX|LAS aby|LDY abx|LDA abx|LDX aby|LAX aby",
  "CPY #|CMP izx|NOP #|DCP izx|CPY zp|CMP zp|DEC zp|DCP zp|INY|CMP #|DEX|AXS #|CPY abs|CMP abs|DEC abs|DCP abs",
  "BNE rel|CMP izy|JAM|DCP izy|NOP zpx|CMP zpx|DEC zpx|DCP zpx|CLD|CMP aby|NOP|DCP aby|NOP abx|CMP abx|DEC abx|DCP abx",
  "CPX #|SBC izx|NOP #|ISC izx|CPX zp|SBC zp|INC zp|ISC zp|INX|SBC #|NOP|SBC #|CPX abs|SBC abs|INC abs|ISC abs",
  "BEQ rel|SBC izy|JAM|ISC izy|NOP zpx|SBC zpx|INC zpx|ISC zpx|SED|SBC aby|NOP|ISC aby|NOP abx|SBC abx|INC abx|ISC abx",
];

/** Per mode tag: inventory mode, size, operand bytes used in the tests, source operand, disassembled operand. */
const MODES = {
  "": { mode: "implied", size: 1, operandBytes: [], source: "", text: "" },
  A: { mode: "accumulator", size: 1, operandBytes: [], source: "A", text: "A" },
  "#": { mode: "immediate", size: 2, operandBytes: [0x12], source: "#$12", text: "#$12" },
  zp: { mode: "zeroPage", size: 2, operandBytes: [0x12], source: "$12", text: "$12" },
  zpx: { mode: "zeroPageX", size: 2, operandBytes: [0x12], source: "$12,X", text: "$12,X" },
  zpy: { mode: "zeroPageY", size: 2, operandBytes: [0x12], source: "$12,Y", text: "$12,Y" },
  abs: { mode: "absolute", size: 3, operandBytes: [0x34, 0x12], source: "$1234", text: "$1234" },
  abx: { mode: "absoluteX", size: 3, operandBytes: [0x34, 0x12], source: "$1234,X", text: "$1234,X" },
  aby: { mode: "absoluteY", size: 3, operandBytes: [0x34, 0x12], source: "$1234,Y", text: "$1234,Y" },
  ind: { mode: "indirect", size: 3, operandBytes: [0x34, 0x12], source: "($1234)", text: "($1234)" },
  izx: { mode: "indirectX", size: 2, operandBytes: [0x12], source: "($12,X)", text: "($12,X)" },
  izy: { mode: "indirectY", size: 2, operandBytes: [0x12], source: "($12),Y", text: "($12),Y" },
  // A branch at $C000 to $C010 has the offset $0E; the disassembler prints the target address.
  rel: { mode: "relative", size: 2, operandBytes: [0x0e], source: "$C010", text: "$C010" },
};

const OFFICIAL_MNEMONICS = new Set((
  "ADC AND ASL BCC BCS BEQ BIT BMI BNE BPL BRK BVC BVS CLC CLD CLI CLV CMP CPX CPY DEC DEX DEY EOR INC INX INY JMP JSR " +
  "LDA LDX LDY LSR NOP ORA PHA PHP PLA PLP ROL ROR RTI RTS SBC SEC SED SEI STA STX STY TAX TAY TSX TXA TXS TYA"
).split(" "));

const CASES = MATRIX.flatMap((row, rowIndex) => {
  const cells = row.split("|");
  assert.equal(cells.length, 16, `matrix row ${rowIndex}`);
  return cells.map((cell, column) => {
    const [mnemonic, tag = ""] = cell.split(" ");
    const opcode = rowIndex * 16 + column;
    // The 151 documented opcodes: official mnemonics, except NOP other than $EA and SBC $EB.
    const documented = OFFICIAL_MNEMONICS.has(mnemonic) && !(mnemonic === "NOP" && opcode !== 0xea) && opcode !== 0xeb;
    return { opcode, mnemonic, tag, ...MODES[tag], documented };
  });
});

const hex2 = (value) => value.toString(16).toUpperCase().padStart(2, "0");

/** The opcode the assembler uses for a mnemonic and mode: the lowest documented one, else the lowest. */
function canonicalOpcode(entry) {
  const sameForm = CASES.filter((other) => other.mnemonic === entry.mnemonic && other.tag === entry.tag);
  return (sameForm.find((other) => other.documented) ?? sameForm[0]).opcode;
}

/** Opcodes that share mnemonic and mode with an earlier or documented opcode; the assembler never emits them. */
const ALIAS_OPCODES = [
  0x12, 0x1a, 0x22, 0x32, 0x34, 0x3a, 0x3c, 0x42, 0x44, 0x52, 0x54, 0x5a, 0x5c, 0x62, 0x64, 0x72, 0x74, 0x7a,
  0x7c, 0x82, 0x89, 0x92, 0xb2, 0xc2, 0xd2, 0xd4, 0xda, 0xdc, 0xe2, 0xeb, 0xf2, 0xf4, 0xfa, 0xfc, 0x2b,
].sort((a, b) => a - b);

test("the inventory has 256 entries in opcode order and matches the independent matrix", () => {
  assert.equal(OPCODE_INVENTORY.length, 256);
  assert.equal(OPCODES_BY_BYTE, OPCODE_INVENTORY);
  for (const entry of CASES) {
    const inventory = OPCODE_INVENTORY[entry.opcode];
    assert.deepEqual(
      { opcode: inventory.opcode, mnemonic: inventory.mnemonic, mode: inventory.mode, illegal: inventory.illegal },
      { opcode: entry.opcode, mnemonic: entry.mnemonic, mode: entry.mode, illegal: !entry.documented },
      `inventory entry $${hex2(entry.opcode)}`,
    );
  }
});

test("151 opcodes are documented and 105 are undocumented, 12 of them JAM", () => {
  assert.equal(CASES.filter((entry) => entry.documented).length, 151);
  assert.equal(CASES.filter((entry) => !entry.documented).length, 105);
  assert.equal(CASES.filter((entry) => entry.mnemonic === "JAM").length, 12);
  assert.deepEqual(
    CASES.filter((entry) => entry.mnemonic === "JAM").map((entry) => entry.opcode),
    [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2],
  );
});

test("opcodeSize gives the instruction length of every addressing mode", () => {
  const sizes = Object.values(OpcodeAddressingMode).map((mode) => [mode, opcodeSize(mode)]);
  assert.deepEqual(Object.fromEntries(sizes), {
    implied: 1, accumulator: 1, immediate: 2, zeroPage: 2, zeroPageX: 2, zeroPageY: 2, zeroPageS: 2, relative: 2,
    absolute: 3, absoluteX: 3, absoluteY: 3, indirect: 3, indirectX: 2, indirectY: 2,
  });
});

for (const entry of CASES) {
  const label = `$${hex2(entry.opcode)} ${entry.mnemonic}${entry.tag ? ` ${entry.tag}` : ""}${entry.documented ? "" : " (undocumented)"}`;

  test(`assemble ${label}`, () => {
    const canonical = canonicalOpcode(entry);
    const bytes = code(`  ${entry.mnemonic} ${entry.source}`);
    assert.deepEqual(bytes, [canonical, ...entry.operandBytes]);
    if (canonical === entry.opcode) assert.equal(bytes[0], entry.opcode);
  });

  test(`disassemble ${label}`, () => {
    const lines = disassemble(Uint8Array.of(entry.opcode, ...entry.operandBytes), 0xc000);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.address, 0xc000);
    assert.deepEqual(line.bytes, [entry.opcode, ...entry.operandBytes]);
    assert.equal(line.mnemonic, entry.mnemonic);
    assert.equal(line.operand, entry.text);
    assert.equal(line.undocumented, !entry.documented);
    assert.equal(line.label, undefined);
    assert.deepEqual(opcodeMetadata(entry.opcode), { mnemonic: entry.mnemonic, undocumented: !entry.documented, size: entry.size });
    assert.equal(isUndocumentedOpcode(entry.opcode), !entry.documented);
    assert.equal(line.bytes.length, entry.size);
  });

  test(`round trip ${label}`, () => {
    const original = [entry.opcode, ...entry.operandBytes];
    const [line] = disassemble(Uint8Array.from(original), 0xc000);
    const bytes = code(`  ${line.mnemonic} ${line.operand}`);
    // The assembler emits the documented encoding when several opcodes share a mnemonic and mode.
    assert.deepEqual(bytes, [canonicalOpcode(entry), ...entry.operandBytes]);
    assert.equal(bytes.length, original.length);
    assert.equal(bytes[0] === entry.opcode, !ALIAS_OPCODES.includes(entry.opcode));
  });
}

test("opcodes that share a mnemonic and mode with another opcode assemble to the lowest documented one", () => {
  const aliases = CASES.filter((entry) => canonicalOpcode(entry) !== entry.opcode).map((entry) => entry.opcode);
  assert.deepEqual(aliases, ALIAS_OPCODES);
  // The well-known aliases, spelled out.
  assert.deepEqual(code("  nop"), [0xea]);
  assert.deepEqual(code("  sbc #$12"), [0xe9, 0x12]);
  assert.deepEqual(code("  nop #$12"), [0x80, 0x12]);
  assert.deepEqual(code("  nop $12"), [0x04, 0x12]);
  assert.deepEqual(code("  nop $12,x"), [0x14, 0x12]);
  assert.deepEqual(code("  nop $1234"), [0x0c, 0x34, 0x12]);
  assert.deepEqual(code("  nop $1234,x"), [0x1c, 0x34, 0x12]);
  assert.deepEqual(code("  jam"), [0x02]);
  assert.deepEqual(code("  anc #$12"), [0x0b, 0x12]);
});

test("mnemonics are case-insensitive and the old Ultimate monitor names are not accepted", () => {
  assert.deepEqual(code("  LdA #$01\n  jMp ($1234)"), [0xa9, 0x01, 0x6c, 0x34, 0x12]);
  for (const old of ["HLT", "ASO", "LSE", "DCM", "INS"]) {
    assert.throws(() => assemblyToPrg(`.org $C000\n  ${old}`), new RegExp(`Unknown instruction "${old}"`));
  }
});

test("round trip of a mixed program through disassemble and assemble keeps every byte", () => {
  const bytes = Uint8Array.from([0xa9, 0x00, 0x8d, 0x20, 0xd0, 0xa2, 0x08, 0xca, 0xd0, 0xfd, 0x6c, 0x34, 0x12, 0x4b, 0x7f, 0x60]);
  const lines = disassemble(bytes, 0xc000);
  const text = lines.map((line) => `  ${line.mnemonic} ${line.operand}`).join("\n");
  assert.deepEqual(code(text), [...bytes]);
});

test("assembled code is accepted by the PRG writer for every one of the 256 opcode bytes in one image", () => {
  const source = CASES.map((entry) => `  ${entry.mnemonic} ${entry.tag === "rel" ? "*+16" : entry.source}`).join("\n");
  const prg = assemblyToPrg(`.org $C000\n${source}`);
  const expected = CASES.flatMap((entry) => [canonicalOpcode(entry), ...entry.operandBytes]);
  assert.deepEqual([...prg], [0x00, 0xc0, ...expected]);
});
