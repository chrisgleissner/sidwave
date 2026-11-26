# API reference

All functions are synchronous and pure: they take values and return values, and they never read files, use the network or keep state between calls. The package has no dependencies.
The signatures below are TypeScript. The package ships its own type declarations.

The package root exports everything. The subpaths `6502-toolkit/assembler`, `6502-toolkit/disassembler`, `6502-toolkit/opcodeInventory`, `6502-toolkit/petscii` and `6502-toolkit/ioRange` export one module each.

Contents: [assembler](#assembler), [disassembler](#disassembler), [opcode inventory](#opcode-inventory), [PETSCII](#petscii), [I/O range](#io-range).

## Assembler

### assemblyToPrg

```ts
function assemblyToPrg(source: string, options?: AssembleOptions): Uint8Array
```

Assembles `source` and returns the PRG file: two load-address bytes, low byte first, followed by the program bytes. Throws [AssemblyError](#assemblyerror) when the source is wrong.
The language is described in [syntax.md](syntax.md), the PRG rules in [commodore.md](commodore.md).

```js
import { assemblyToPrg } from "6502-toolkit";

const prg = assemblyToPrg("* = $c000\n  lda #$01\n  sta $d020\n  rts\n");
console.log(Buffer.from(prg).toString("hex"));
console.log(prg.length);
```

```output
00c0a9018d20d060
8
```

The result is a `Uint8Array`. The package does not use `Buffer` and runs in browsers without polyfills. In Node.js, `Buffer.from(prg)` gives a `Buffer` if you need its methods.

### assemblyToPrgDetailed

```ts
function assemblyToPrgDetailed(source: string, options?: AssembleOptions): AssemblyResult
```

Same as `assemblyToPrg`, and also returns the entry address, the symbols and the warnings.

```js
import { assemblyToPrgDetailed } from "6502-toolkit";

const result = assemblyToPrgDetailed("* = $c000\nstart: ldx #8\n.loop: dex\n  bne .loop\n  rts\nbuffer: .res 2\n");
console.log(Buffer.from(result.prg).toString("hex"));
console.log(result.entryAddress.toString(16));
console.log(JSON.stringify([...result.symbols]));
console.log(result.warnings.length);
```

```output
00c0a208cad0fd600000
c000
[["start",49152],["buffer",49158]]
0
```

### AssembleOptions

```ts
interface AssembleOptions {
  loadAddress?: number;
  fileName?: string;
  resolveInclude?: (requestedPath: string, fromFile: string) => string | { contents: string; fileName?: string };
  resolveIncbin?: (requestedPath: string, fromFile: string) => Uint8Array;
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `loadAddress` | `0x0801` | Address of code and data that appear before the first `* =` or `.org`. An integer in 0..65535, otherwise `assemblyToPrg` throws an `AssemblyError`. If it is $0801 and an instruction is assembled there before any origin, the assembler adds a BASIC `10 SYS` stub in front of the code. |
| `fileName` | `"(input)"` | File name shown in error messages and passed to the resolvers as `fromFile`. |
| `resolveInclude` | none | Called for `.include "path"` with the path and the name of the including file. Returns the source text, or an object with the text and a file name for messages. Without it, `.include` is an error. |
| `resolveIncbin` | none | Called for `.incbin "path"` and `!binary "path"` with the path and the name of the including file. Returns at most 65536 bytes. Called once per path. Without it, `.incbin` is an error. |

The stub rule in detail: the stub is added only when an instruction is assembled at the load address before any origin. Data-only source, or data at $0801 followed by code at an explicit origin, gets no stub. A source that sets its own origin, even `* = $0801`, gets no stub. See [commodore.md](commodore.md#basic-sys-stub).

The assembler does not touch the file system. The caller decides what a path means:

```js
import { assemblyToPrg } from "6502-toolkit";

const files = new Map([["border.asm", "border = $d020\n"]]);
const prg = assemblyToPrg('.include "border.asm"\n* = $c000\n  inc border\n', {
  resolveInclude: (path, fromFile) => files.get(path),
});
console.log(Buffer.from(prg).toString("hex"));
```

```output
00c0ee20d0
```

### AssemblyResult

```ts
interface AssemblyResult {
  readonly prg: Uint8Array;
  readonly entryAddress: number;
  readonly symbols: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}
```

| Field | Meaning |
| --- | --- |
| `prg` | The PRG file. Empty (0 bytes, not even a load address) when the source emits no bytes. |
| `entryAddress` | The address to start with `SYS`: the target of a leading BASIC `SYS` line at $0801 (the automatic stub or one the source contains), otherwise the first instruction, otherwise the load address. |
| `symbols` | Global labels and constants with their final values. Local labels (`.name`) are not included. |
| `warnings` | Things that are legal but probably not intended: a name in column 0 that is taken as a label and that nothing refers to, lower-case letters in `.text`, a `!binary` that is padded with zeros, a zero-filled gap or trailing `.res` of 1024 bytes or more, an empty image. |

### AssemblyError

```ts
class AssemblyError extends Error {
  readonly location: { file: string; line: number; text: string; context?: string };
}
```

Thrown for every error in the source, in an include, in a macro expansion or in the options. `message` is `<file>:<line>: <text>` followed by a new line, four spaces and the trimmed source line. For code produced by a macro or repeat, the first part is `<file>:<line> (in macro name):` or `(in repeat):`.
`location.file` is the file of the line that is wrong: the root file name, or the name an include resolver gave. `location.line` counts from 1. It is 0 for an invalid `loadAddress`. `location.text` is the source line.

```js
import { assemblyToPrg, AssemblyError } from "6502-toolkit";

try {
  assemblyToPrg("  nop\n  lda #300\n", { fileName: "main.asm" });
} catch (error) {
  console.log(error instanceof AssemblyError);
  console.log(JSON.stringify(error.location));
  console.log(error.message);
}
```

```output
true
{"file":"main.asm","line":2,"text":"  lda #300"}
main.asm:2: Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte
    lda #300
```

### prgEntryAddress

```ts
function prgEntryAddress(prg: Uint8Array): number
```

Returns the address to start a PRG with `SYS`. If the PRG loads at $0801 and starts with a BASIC line `SYS <number>` (spaces and an opening parenthesis after the token are skipped), the number is returned. Otherwise the load address is returned.
The function works on any PRG, not only on one from this assembler. An empty array gives 0.

```js
import { assemblyToPrg, prgEntryAddress } from "6502-toolkit";

console.log(prgEntryAddress(assemblyToPrg("  rts")));
console.log(prgEntryAddress(assemblyToPrg("* = $c000\n  rts")));
console.log(prgEntryAddress(Uint8Array.of(0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x34, 0x30, 0x39, 0x36, 0x00, 0x00, 0x00)));
```

```output
2062
49152
4096
```

## Disassembler

### disassemble

```ts
function disassemble(
  bytes: Uint8Array,
  baseAddress: number,
  countOrOptions?: number | DisassembleOptions,
  symbols?: ReadonlyMap<number, string>,
): DisassemblyLine[]
```

Decodes `bytes` as 6502 machine code that starts at `baseAddress`. The result has one entry per instruction. Decoding stops after `count` instructions or at the end of `bytes`.
The third argument is either a number (the instruction count) or an options object. The fourth argument is the symbol map for the number form.

- Every one of the 256 opcode bytes is decoded. Undocumented opcodes have their canonical mnemonic and `undocumented: true`.
- Operands are always assemblable text. Branch targets are absolute addresses. A symbol for an operand address is reported in `operandLabel`, not in the operand text.
- If `bytes` ends inside an instruction, the remaining bytes are returned as one `.byte` line instead of an instruction with a made-up operand.
- Addresses wrap at $FFFF.

```js
import { disassemble } from "6502-toolkit";

const lines = disassemble(Uint8Array.of(0xa9, 0x01, 0x8d, 0x20, 0xd0, 0xd0, 0xfb, 0x4b, 0x7f), 0xc000);
for (const line of lines) {
  console.log(line.address.toString(16), line.mnemonic, line.operand, line.undocumented);
}
```

```output
c000 LDA #$01 false
c002 STA $D020 false
c005 BNE $C002 false
c007 ALR #$7F true
```

### DisassembleOptions

```ts
interface DisassembleOptions {
  readonly count?: number;
  readonly symbols?: ReadonlyMap<number, string>;
  readonly allowUndocumented?: boolean;
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `count` | all | Maximum number of instructions. |
| `symbols` | none | Address to name. A name for the address of an instruction is the `label` of that line. A name for a branch target or an absolute operand is the `operandLabel`. |
| `allowUndocumented` | `true` | When `false`, every undocumented opcode becomes a one-byte line with mnemonic `???` and operand `$xx`. |

### DisassemblyLine

```ts
interface DisassemblyLine {
  readonly address: number;
  readonly bytes: readonly number[];
  readonly label: string | undefined;
  readonly mnemonic: string;
  readonly operand: string;
  readonly operandLabel?: string;
  readonly undocumented: boolean;
}
```

### formatDisassembly

```ts
function formatDisassembly(lines: DisassemblyLine[]): string
```

Renders lines as text: a `label:` line for each label, then address, bytes, mnemonic and operand. Undocumented mnemonics get a `*`, and an operand label is added as a comment.

```js
import { disassemble, formatDisassembly } from "6502-toolkit";

const symbols = new Map([[0xc000, "start"], [0xd020, "border"]]);
const lines = disassemble(Uint8Array.of(0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x4b, 0x7f, 0x60), 0xc000, { symbols });
console.log(formatDisassembly(lines));
```

```output
start:
  $C000  A9 00     LDA #$00
  $C002  8D 20 D0  STA $D020  ; border
  $C005  4B 7F     ALR* #$7F
  $C007  60        RTS
```

### isUndocumentedOpcode

```ts
function isUndocumentedOpcode(opcode: number): boolean
```

True for the 105 undocumented opcode bytes. Only the low 8 bits of `opcode` are used.

### opcodeMetadata

```ts
function opcodeMetadata(opcode: number): { mnemonic: string; undocumented: boolean; size: number }
```

Mnemonic, status and instruction length in bytes (1 to 3) of an opcode byte.

```js
import { isUndocumentedOpcode, opcodeMetadata } from "6502-toolkit";

console.log(JSON.stringify(opcodeMetadata(0xa9)));
console.log(JSON.stringify(opcodeMetadata(0x4b)));
console.log(isUndocumentedOpcode(0xea), isUndocumentedOpcode(0xfa));
```

```output
{"mnemonic":"LDA","undocumented":false,"size":2}
{"mnemonic":"ALR","undocumented":true,"size":2}
false true
```

## Opcode inventory

The table that the assembler and the disassembler share. [opcodes.md](opcodes.md) lists all entries.

### OPCODE_INVENTORY

```ts
const OPCODE_INVENTORY: readonly OpcodeInventoryEntry[]
```

256 entries in opcode order; the entry at index `n` describes opcode byte `n`. The array is frozen.

```js
import { OPCODE_INVENTORY } from "6502-toolkit";

console.log(OPCODE_INVENTORY.length);
console.log(JSON.stringify(OPCODE_INVENTORY[0xa9]));
console.log(JSON.stringify(OPCODE_INVENTORY[0x02]));
```

```output
256
{"opcode":169,"mnemonic":"LDA","mode":"immediate","illegal":false}
{"opcode":2,"mnemonic":"JAM","mode":"implied","illegal":true}
```

### OPCODES_BY_BYTE

```ts
const OPCODES_BY_BYTE: readonly OpcodeInventoryEntry[]
```

The same array as `OPCODE_INVENTORY`, under a name that says how it is indexed.

### OpcodeInventoryEntry

```ts
interface OpcodeInventoryEntry {
  readonly opcode: number;
  readonly mnemonic: string;
  readonly mode: OpcodeAddressingMode;
  readonly illegal: boolean;
}
```

`illegal` is true for undocumented opcodes.

### OpcodeAddressingMode

```ts
const OpcodeAddressingMode: {
  Imp: "implied"; Acc: "accumulator"; Imm: "immediate"; Zp: "zeroPage"; ZpX: "zeroPageX"; ZpY: "zeroPageY";
  ZpS: "zeroPageS"; Rel: "relative"; Abs: "absolute"; AbsX: "absoluteX"; AbsY: "absoluteY";
  Ind: "indirect"; IndX: "indirectX"; IndY: "indirectY";
}
type OpcodeAddressingMode = "implied" | "accumulator" | "immediate" | ... // the values above
```

`zeroPageS` (stack relative) is part of the type but no NMOS opcode uses it.

### opcodeSize

```ts
function opcodeSize(mode: OpcodeAddressingMode): number
```

Instruction length in bytes for an addressing mode: 1 for implied and accumulator, 2 for immediate, zero page, relative and the two indirect-indexed modes, 3 for absolute and indirect.

```js
import { OpcodeAddressingMode, opcodeSize } from "6502-toolkit";

console.log(opcodeSize(OpcodeAddressingMode.Imp), opcodeSize(OpcodeAddressingMode.Zp), opcodeSize(OpcodeAddressingMode.Ind));
```

```output
1 2 3
```

## PETSCII

Helpers for PETSCII text and screen codes. The control-code names are listed in [commodore.md](commodore.md#petscii-text).

### encodeStringWithNames

```ts
function encodeStringWithNames(input: string, options?: { foldLowercase?: boolean }): Uint8Array
```

Encodes text with control-code tokens to PETSCII bytes. Tokens are `{name}`, `{$xx}`, `{nn}`, and the older short forms `:name:` and `<name>`. Other characters are passed through, and an unknown token stays literal text. With `foldLowercase`, a-z become the capitals $41-$5A. Throws for a character above 255.

```js
import { encodeStringWithNames } from "6502-toolkit";

console.log(Buffer.from(encodeStringWithNames("{clear}{red}Hi{$0d}")).toString("hex"));
console.log(Buffer.from(encodeStringWithNames("hi{red}", { foldLowercase: true })).toString("hex"));
```

```output
931c48690d
48491c
```

### parseBraceToken

```ts
function parseBraceToken(source: string, startIndex: number): BraceToken | null
```

Parses `{name}`, `{$xx}` or `{nn}` at `startIndex`. Returns `null` when the text is not a token candidate (no closing brace, or characters that a token never contains), and `{ ok: false }` with a reason when it looks like a token but is not a known code. `endIndex` is the index after the closing brace.

```js
import { parseBraceToken } from "6502-toolkit";

console.log(JSON.stringify(parseBraceToken("{red}", 0)));
console.log(JSON.stringify(parseBraceToken("{nope}", 0)));
console.log(JSON.stringify(parseBraceToken("{256}", 0)));
console.log(JSON.stringify(parseBraceToken("{a,b}", 0)));
```

```output
{"ok":true,"value":28,"endIndex":5}
{"ok":false,"token":"{nope}","reason":"unknown control-code name","endIndex":6}
{"ok":false,"token":"{256}","reason":"decimal codes are 0-255","endIndex":5}
null
```

### BraceToken

```ts
type BraceToken =
  | { readonly ok: true; readonly value: number; readonly endIndex: number }
  | { readonly ok: false; readonly token: string; readonly reason: string; readonly endIndex: number };
```

The result of `parseBraceToken`.

### parseNamedCharToken

```ts
function parseNamedCharToken(source: string, startIndex: number): { value: number; endIndex: number } | null
```

Like `parseBraceToken`, and also accepts the short forms `:name:` and `<name>` for a short list of names. Returns `null` for anything that is not a valid token.

### lookupNamedPetscii

```ts
function lookupNamedPetscii(name: string): number | undefined
```

The code of a control-code name. Case, spaces and dashes are ignored: `"Light-Blue"`, `"light blue"` and `"light_blue"` are the same name.

### petsciiControlName

```ts
function petsciiControlName(byte: number): string | undefined
```

The canonical name of a control code, for listings. Codes 7 and 10 have no function on the C64 and give `undefined`.

```js
import { lookupNamedPetscii, petsciiControlName } from "6502-toolkit";

console.log(lookupNamedPetscii("Light-Blue"), petsciiControlName(154), petsciiControlName(147), petsciiControlName(65));
```

```output
154 lblu clr undefined
```

### asciiToPetscii

```ts
function asciiToPetscii(char: string): number
```

Returns the character code for a single character from 0 to 255 and throws otherwise. No letter folding is done; for that, use `encodeStringWithNames` with `foldLowercase`.

### petsciiToAscii

```ts
function petsciiToAscii(bytes: Uint8Array): string
```

Shows PETSCII bytes as text. Printable ASCII characters and the capitals $C1-$DA are mapped, the RETURN codes ($0D, $11, $8D) become a new line, $07 stays the bell character, and every other byte becomes a space.

### petsciiToScreenCode

```ts
function petsciiToScreenCode(petscii: number): number | undefined
```

The screen code that the KERNAL shows for a printable PETSCII code. Control codes ($00-$1F and $80-$9F) have none and give `undefined`.

```js
import { petsciiToScreenCode } from "6502-toolkit";

console.log(petsciiToScreenCode(0x41), petsciiToScreenCode(0x61), petsciiToScreenCode(0xc1), petsciiToScreenCode(0x93));
```

```output
1 65 65 undefined
```

### screenCodesToAscii

```ts
function screenCodesToAscii(bytes: Uint8Array, options?: ScreenAsciiOptions): string
```

Shows a screen memory dump as text lines. Graphics characters appear as [`SCREEN_GRAPHIC_PLACEHOLDER`](#screen_graphic_placeholder).

```js
import { SCREEN_GRAPHIC_PLACEHOLDER, screenCodesToAscii } from "6502-toolkit";

const screen = Uint8Array.of(8, 5, 12, 12, 15, 32, 32, 32, 0x66, 0x66, 32, 32);
console.log(screenCodesToAscii(screen, { columns: 8 }));
console.log(SCREEN_GRAPHIC_PLACEHOLDER === "\u2592");
```

```output
HELLO
▒▒
true
```

### ScreenAsciiOptions

```ts
interface ScreenAsciiOptions {
  readonly columns?: number;           // default 40
  readonly rows?: number;              // default: all rows
  readonly trimTrailingSpaces?: boolean;      // default true
  readonly trimTrailingEmptyRows?: boolean;   // default true
  readonly charset?: "upper" | "lower";       // default "upper"
}
```

### SCREEN_GRAPHIC_PLACEHOLDER

```ts
const SCREEN_GRAPHIC_PLACEHOLDER: "\u2592"
```

The character that `screenCodesToAscii` shows for screen codes that are graphics, not text. It never occurs as a C64 text character.

## I/O range

### IO_RANGE_START and IO_RANGE_END

```ts
const IO_RANGE_START: 0xd000
const IO_RANGE_END: 0xdfff
```

The I/O area of the C64 memory map. A write there reaches the VIC-II, SID, CIA and colour RAM, not RAM.

### rangeOverlapsIo

```ts
function rangeOverlapsIo(start: number, length: number): boolean
```

True when the `length` bytes from `start` overlap $D000-$DFFF. A length of 0 or less, or `NaN`, overlaps nothing. The assembler uses it to refuse a zero-filled gap that would write zeros to I/O registers.

```js
import { rangeOverlapsIo } from "6502-toolkit";

console.log(rangeOverlapsIo(0xcfff, 1), rangeOverlapsIo(0xcfff, 2), rangeOverlapsIo(0xe000, 16));
```

```output
false true false
```
