# 6502-toolkit

An assembler and a disassembler for the NMOS 6502 and 6510 (Commodore 64), written in TypeScript, with all 256 opcodes, PRG output and PETSCII text.

[![CI](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml/badge.svg)](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml)
[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg?flag=6502-toolkit)](https://codecov.io/gh/chrisgleissner/sidwave)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why this one

- **All 256 NMOS opcodes, including the undocumented ones, with canonical names** (`JAM`, `SLO`, `SRE`, `DCP`, `ISC`, `LAX`, `SAX`, `ALR`, ...). Every opcode is assembled, disassembled and round-tripped in its own test. The table is in [doc/opcodes.md](doc/opcodes.md).
- **A disassembler in the same package.** It decodes every opcode byte. Its output is text that the assembler accepts again.
- **PRG output with an automatic BASIC `SYS` stub.** Code at $0801 gets a `10 SYS` line in front of it. The result reports the entry address, and `prgEntryAddress` finds it in any PRG.
- **PETSCII text with brace tokens.** `.text "{clear}{red}HELLO"` writes the control codes by name, by hex value or by decimal value. ACME's `!pet` and `!scr` are included.
- **`include` and `incbin` go through callbacks that you provide.** The package never reads a file. It imports nothing from Node.js, and a test runs the built package with `Buffer` removed and every `node:` import blocked.
- **A symbol table, warnings and exact error locations.** `AssemblyError` carries the file name and line, also for errors in included files and macro expansions.
- **Synchronous, pure and without dependencies.** Same input, same output. It runs on Node.js (see Versioning and support), Bun and in browsers; CI runs the tests on Node.js and Bun.
- **Directive spellings from ACME, 64tass, ca65 and Kick Assembler,** compared with bytes that those assemblers produced, and more than 1,000 tests (1072 in the last Node run: 1070 passed, 1 skipped, 1 to do). CI enforces at least 98 % line coverage and 95 % branch coverage.

## Install

```sh
npm install 6502-toolkit
```

Node.js 20.19 or later, or Bun 1.3.1 or later. The package is ESM only and ships its TypeScript declarations. It uses no Node.js modules and no `Buffer`, so a bundler needs no polyfills for it. The assembler returns a `Uint8Array`.

## Quick start

Assemble a program to a PRG file:

```js
import { writeFileSync } from "node:fs";
import { assemblyToPrgDetailed } from "6502-toolkit";

const source = `
        * = $c000
start:  ldx #0
loop:   inc $d020
        dex
        bne loop
        rts
`;
const result = assemblyToPrgDetailed(source);
writeFileSync("border.prg", result.prg);
console.log(`${result.prg.length} bytes, load address $${(result.prg[0] | (result.prg[1] << 8)).toString(16)}, entry $${result.entryAddress.toString(16)}`);
console.log(Buffer.from(result.prg).toString("hex"));
```

```output
11 bytes, load address $c000, entry $c000
00c0a200ee20d0cad0fa60
```

Disassemble bytes back to text:

```js
import { disassemble, formatDisassembly } from "6502-toolkit";

const prg = Uint8Array.from(Buffer.from("00c0a200ee20d0cad0fa60", "hex"));
const loadAddress = prg[0] | (prg[1] << 8);
const lines = disassemble(prg.subarray(2), loadAddress, { symbols: new Map([[0xd020, "border"]]) });
console.log(formatDisassembly(lines));
```

```output
  $C000  A2 00     LDX #$00
  $C002  EE 20 D0  INC $D020  ; border
  $C005  CA        DEX
  $C006  D0 FA     BNE $C002
  $C008  60        RTS
```

Start the PRG with `LOAD "BORDER.PRG",8,1` and `SYS 49152` on a C64, or run it with an emulator or an Ultimate cartridge.

## API overview

All functions are synchronous. Details and examples: [doc/api.md](doc/api.md).

| Export | Purpose |
| --- | --- |
| [`assemblyToPrg(source, options?)`](doc/api.md#assemblytoprg) | Assemble source text to a PRG `Uint8Array`. |
| [`assemblyToPrgDetailed(source, options?)`](doc/api.md#assemblytoprgdetailed) | Same, plus entry address, symbols and warnings. |
| [`AssembleOptions`](doc/api.md#assembleoptions) | `loadAddress`, `fileName`, `resolveInclude`, `resolveIncbin`. |
| [`AssemblyResult`](doc/api.md#assemblyresult) | `prg`, `entryAddress`, `symbols`, `warnings`. |
| [`AssemblyError`](doc/api.md#assemblyerror) | Error with `location` (`file`, `line`, `text`, `context`). |
| [`prgEntryAddress(prg)`](doc/api.md#prgentryaddress) | The `SYS` address of a PRG. |
| [`disassemble(bytes, baseAddress, options?)`](doc/api.md#disassemble) | Decode machine code to lines. |
| [`formatDisassembly(lines)`](doc/api.md#formatdisassembly) | Render lines as text. |
| [`isUndocumentedOpcode(opcode)`](doc/api.md#isundocumentedopcode), [`opcodeMetadata(opcode)`](doc/api.md#opcodemetadata) | Look up an opcode byte. |
| [`OPCODE_INVENTORY`](doc/api.md#opcode_inventory), [`OPCODES_BY_BYTE`](doc/api.md#opcodes_by_byte), [`OpcodeAddressingMode`](doc/api.md#opcodeaddressingmode), [`opcodeSize(mode)`](doc/api.md#opcodesize) | The 256-entry opcode table. |
| [`encodeStringWithNames`](doc/api.md#encodestringwithnames), [`parseBraceToken`](doc/api.md#parsebracetoken), [`parseNamedCharToken`](doc/api.md#parsenamedchartoken), [`lookupNamedPetscii`](doc/api.md#lookupnamedpetscii), [`petsciiControlName`](doc/api.md#petsciicontrolname) | PETSCII control-code tokens. |
| [`asciiToPetscii`](doc/api.md#asciitopetscii), [`petsciiToAscii`](doc/api.md#petsciitoascii), [`petsciiToScreenCode`](doc/api.md#petsciitoscreencode), [`screenCodesToAscii`](doc/api.md#screencodestoascii), [`SCREEN_GRAPHIC_PLACEHOLDER`](doc/api.md#screen_graphic_placeholder) | PETSCII and screen code conversion. |
| [`IO_RANGE_START`, `IO_RANGE_END`](doc/api.md#io_range_start-and-io_range_end), [`rangeOverlapsIo`](doc/api.md#rangeoverlapsio) | The $D000-$DFFF I/O area. |

The subpaths `6502-toolkit/assembler`, `/disassembler`, `/opcodeInventory`, `/petscii` and `/ioRange` import one module each.

## Syntax at a glance

```asm
* = $c000                ; origin (also: .org $c000)
border = $d020           ; constant (also: .equ border, $d020)
start:  ldx #<message    ; label; < is the low byte, > the high byte
.loop:  lda message,x    ; .loop is local to the label above it
        beq done
        sta $0400,x
        inx
        bne .loop
done:   rts
message: .text "hello{$0d}"
```

```hex
00 C0 A2 0E BD 0E C0 F0 06 9D 00 04 E8 D0 F5 60 48 45 4C 4C 4F 0D
```

- **Labels:** `name:`, or a name in column 0. `.name:` is local to the last global label. Anonymous labels (`+`, `-`) are not supported.
- **Numbers:** `$ff`, `0xff`, `%1010`, `0b1010`, decimal, `'A'` for a character.
- **Operators:** `* / %`, `+ -`, `<< >>`, `< <= > >=`, `== !=`, `&`, `^`, `|`, and unary `- + ! ~ < >`. `*` is the current address. Parentheses group.
- **Comments:** `;` and `//`.
- **Strings:** `"..."` or `'...'` with the escapes `\0 \t \n \r \xNN \\ \" \'`.

| Directive | Spellings |
| --- | --- |
| Origin | `* = n`, `.org n`, `org n` |
| Bytes, words | `.byte`, `.byt`, `.by`, `.db`, `byte`, `db`, `!byte`, `!by`, `!8`; `.word`, `.wo`, `word`, `dw`, `!word`, `!wo`, `!16` |
| Text | `.text`, `.ascii` (PETSCII, brace tokens); `!text`, `!tx`, `!txt`, `!raw`, `!pet`, `!scr` (ACME) |
| Fill, align, reserve | `.fill`, `!fill`, `!fi`; `.align`, `!align` (ACME form); `.res`, `.ds`, `res`, `ds` |
| Constants | `name = n`, `.equ name, n`, `name .equ n` |
| Include | `.include`, `include`, `!source`, `!src` (through `resolveInclude`) |
| Binary data | `.incbin`, `.binary` (`"file"[, offset[, length]]`), `!binary`, `!bin` (`"file"[, size[, skip]]`), through `resolveIncbin` |
| Conditions | `.if`, `.else`, `.endif`, `.fi` |
| Macros | `.macro name params` ... `.endmacro` (ca65), `name .macro params` ... `.endm` (64tass) |
| Repeat | `.repeat n` ... `.endrepeat`, `.rept n` ... `.endrept` |

The full reference with grammar, examples and error messages is [doc/syntax.md](doc/syntax.md).

## Commodore support

- **PRG:** the result starts with the two-byte load address. Several `* =` blocks give one PRG, and the assembler refuses a zero-filled gap that would write to the I/O area $D000-$DFFF.
- **SYS stub:** code that is assembled at $0801 without an origin gets `10 SYS02062` (the number is the first instruction) in front of it. The rules for when the stub is added are in [doc/commodore.md](doc/commodore.md#basic-sys-stub).
- **PETSCII:** `.text` folds a-z to the capitals, turns `\n` into RETURN and reads `{name}`, `{$xx}` and `{nn}` as control codes. The table of names is in [doc/commodore.md](doc/commodore.md#petscii-text).

## Comparison with other npm packages

Facts as of 2026-11-26, taken from npm metadata and from each package's npm README. "Not documented" means that the npm README does not mention the feature; it does not mean the feature is missing.

| | 6502-toolkit | [jsasm6502](https://www.npmjs.com/package/jsasm6502) | [@moonbase-machines/mos6502](https://www.npmjs.com/package/@moonbase-machines/mos6502) | [c64jasm](https://www.npmjs.com/package/c64jasm) | [js65](https://www.npmjs.com/package/js65) | [asm6502](https://www.npmjs.com/package/asm6502) |
| --- | --- | --- | --- | --- | --- | --- |
| Version compared | 0.1.0 | 1.7.0 | 0.23.0 | 0.9.2 | 2.3.4 | 0.0.2 |
| Undocumented opcodes | yes, all 105 | not documented | CPU emulator runs documented instructions; assembler syntax not documented | not documented | not documented | not documented |
| Disassembler | yes | listing of assembled source only | yes | not documented | not documented | not documented |
| PRG output | yes, with SYS stub | not documented | not documented | not documented | not documented (README is about NES ROMs) | not documented |
| PETSCII text | yes, brace tokens | not documented (strings use a charmap) | not documented | not documented | not documented | not documented |
| Macros | yes | yes | not documented | yes (package description: "macro assembler") | yes | not documented |
| include and incbin through callbacks | yes | include through a required `readFile` callback | not documented | not documented | not documented | not documented |
| 65C02 | no | yes | not documented | not documented | no ("no support for other cpus besides the 6502") | not documented |
| Runtime dependencies | none | 2 | none listed | 7 | 2 | none listed |
| Licence | MIT | MIT | MIT | MIT | MPL-2.0 | MIT |
| Last npm release | not yet published | 2025-03-19 | 2026-11-16 | 2021-04-10 | 2026-11-25 | 2024-12-21 |

The README of @moonbase-machines/mos6502 describes its assembler as one "for Moonbase's own 6502 code". It is part of a package that emulates the 6502 CPU.

## Limitations

- NMOS 6502 and 6510 only. There are no 65C02 or 65816 instructions.
- One flat output image of at most 64 KB. There are no segments, no linker and no object files. Several `* =` blocks are joined into one PRG.
- No listing output. The result has the PRG, the entry address, the symbols and the warnings.
- Macros must be defined before they are used. Labels inside a macro are global, so a macro that contains a label can be used once.
- `.repeat` takes a constant count and no counter variable.
- Anonymous labels (`+`, `-`) and ca65 `@` labels are not supported. Use `.name:` labels.
- Expressions are numbers only. There are no string, array or floating point values, and no user-defined character maps (`!convtab`, `.charmap`).
- The disassembler prints absolute operands in the form `$00nn`, and the assembler uses the zero-page instruction for such an operand. A disassembled `LDA $0012` assembles to the two-byte form. The syntax has no way to force the absolute form.
- Several undocumented opcodes are aliases of each other (the six one-byte `NOP`s, for example). The assembler emits one opcode of each group, so disassembling and assembling an alias gives an equivalent instruction with another opcode byte. [doc/opcodes.md](doc/opcodes.md) lists them.
- No command line tool. The package is a library.
- The PRG is a `Uint8Array`. In Node.js, call `Buffer.from(prg)` if you need `Buffer` methods.

## Used by

[SIDWave](https://github.com/chrisgleissner/sidwave) (package `sidwave`) uses the assembler to build its music player, and [c64bridge](https://github.com/chrisgleissner/c64bridge) uses it to assemble programs for VICE and Ultimate devices.

## Versioning and support

- The package follows semantic versioning from 1.0.0. Before 1.0.0, a minor version may contain breaking changes. They are listed in [CHANGELOG.md](CHANGELOG.md).
- A deprecated export or option is announced in the changelog one minor release before it is removed.
- Supported runtimes: Node.js 20.19 or later (the oldest version in CI is 20), Bun 1.3.1 or later, and current browsers through a bundler or native ES modules.
- The package is ESM only. On Node.js 20.19 and later, 22.12 and later, and all later versions, `require("6502-toolkit")` loads it through `require(esm)`. On older versions, use `await import("6502-toolkit")`.

## Documentation

- [doc/syntax.md](doc/syntax.md): the assembly language.
- [doc/api.md](doc/api.md): every export.
- [doc/commodore.md](doc/commodore.md): PRG, BASIC stub, PETSCII.
- [doc/opcodes.md](doc/opcodes.md): all 256 opcodes.

## Licence

MIT. See [LICENSE](LICENSE).
