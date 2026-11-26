# Commodore support

This page describes the parts of the package that are specific to the Commodore 64: the PRG file format, the BASIC `SYS` stub that starts a program, PETSCII text, and the I/O range check.

## PRG files

A PRG file is the format that the C64 loads from disk, tape and cartridge-less loaders: the first two bytes are the load address, low byte first, and the rest is copied to memory starting at that address.
`assemblyToPrg` returns this format. `assemblyToPrgDetailed` returns it in `prg` together with the entry address, symbols and warnings.

- The load address is the lowest address that the source writes a byte to. A block that only defines labels, or only reserves space with `.res`, does not move it.
- The file ends with the highest byte written. `.res` space that touches written bytes is part of the file, zero-filled. Detached `.res` space (zero-page variables, for example) is not.
- Several `* =` blocks give one PRG that spans from the lowest to the highest address. The gap between blocks is zero-filled.
- A gap of 1024 zero bytes or more adds a warning. A gap that touches $D000-$DFFF is an error, because loading it would write zeros to the VIC-II, SID, CIA and colour RAM.
- Two blocks that write the same address are an error. Output past $FFFF is an error.
- A source that writes nothing gives an empty `Buffer` (not even a load address) and the warning `The source emits no bytes (only labels, equates or .res); the PRG is empty`.

```js
import { assemblyToPrgDetailed } from "6502-toolkit";

const result = assemblyToPrgDetailed("* = $c000\n  .byte 1\n* = $c010\n  .byte 2\n");
console.log(result.prg.toString("hex"));
console.log(result.prg.length);
```

```output
00c00100000000000000000000000000000002
19
```

## BASIC SYS stub

A PRG that loads at $0801 is read by BASIC as a program. Raw machine code there would be taken as BASIC lines. For code at $0801, the assembler therefore writes a one-line BASIC program in front of the code:

```text
10 SYS02062
```

The stub is 13 bytes: the link pointer to the end of the line ($080C), the line number 10, the `SYS` token $9E, five ASCII digits, a zero byte for the end of the line, and two zero bytes for the end of the program.
The five digits are the address of the first instruction. Their width is fixed, so the stub is the same size in both assembler passes.

The rules (also in the documentation of `AssembleOptions.loadAddress`):

1. The stub is added when the load address is $0801 (the default) and an instruction is assembled there before any `* =` or `.org`.
2. "Code" means an instruction. Data first and an instruction after it still gives a stub, which jumps to the instruction.
3. Source that is only data, or data at $0801 followed by code at an explicit origin, gets no stub: there is no entry point at $0801.
4. A source that sets its own origin, even `* = $0801`, gets no stub. It can contain its own BASIC line; `entryAddress` then reports the `SYS` target of that line.
5. A different `loadAddress`, such as $C000, gets no stub.

Start such a program with `SYS 2062` (the number in the stub), not with `RUN`, because the stub is a `SYS` line that ends the program after the jump returns.

```js
import { assemblyToPrgDetailed, prgEntryAddress } from "6502-toolkit";

const result = assemblyToPrgDetailed("  lda #$01\n  sta $d020\n  rts\n");
console.log(result.prg.toString("hex"));
console.log(result.entryAddress, prgEntryAddress(result.prg));
console.log(Buffer.from(result.prg.subarray(7, 12)).toString("latin1"));
```

```output
01080c080a009e3032303632000000a9018d20d060
2062 2062
02062
```

`prgEntryAddress(prg)` finds the start address of any PRG: the `SYS` number of a leading BASIC line at $0801, or the load address. It skips spaces and an opening parenthesis after the token, and ignores a number above 65535.

## PETSCII text

`.text` and `.ascii` write PETSCII. `a`-`z` are folded to the capitals $41-$5A of the upper-case/graphics character set, `\n` becomes RETURN ($0D), and other ASCII characters are unchanged. Characters above $7F are an error.
Inside the string, a token in braces writes a control code. The same tokens work in `encodeStringWithNames` (see [api.md](api.md#encodestringwithnames)).

| Token | Meaning |
| --- | --- |
| `{name}` | The code with that name from the table below. Case is ignored. Spaces and `-` are the same as `_`: `{cursor up}`, `{cursor-up}` and `{cursor_up}` are one name. |
| `{$xx}` | One or two hexadecimal digits. |
| `{nn}` | A decimal number from 0 to 255. |

A brace pair that does not look like a token (`{a,b}`, `{ }`, a `{` without `}`) is ordinary text. A brace pair that looks like a token but is not one is an error that names the token and the reason; write `\x7b` for a literal `{`.

```js
import { assemblyToPrg } from "6502-toolkit";

const prg = assemblyToPrg('* = $c000\n  .text "{clear}{wht}Hello, {red}world{$0d}{147}"');
console.log(Buffer.from(prg.subarray(2)).toString("hex"));
```

```output
930548454c4c4f2c201c574f524c440d93
```

### Control-code names

The first name of each row is the one a listing uses. Codes 7 and 10 do nothing on the C64; their names are accepted, but a listing writes the code as a number. Code 0 has no name, because a zero byte ends a tokenised BASIC line; write `{$00}` or `{0}` if you need it.
The names and values follow the control-code list of the c64ref project, which is the source for the table.

| Code | Hex | Names |
| --- | --- | --- |
| 3 | $03 | `stop` |
| 5 | $05 | `wht`, `white` |
| 7 | $07 | `bell`, `beep` |
| 8 | $08 | `dis_case_switch` |
| 9 | $09 | `ena_case_switch` |
| 10 | $0A | `lf` |
| 13 | $0D | `return`, `cr`, `newline` |
| 14 | $0E | `lowercase`, `swlc` |
| 17 | $11 | `down`, `cursor_down`, `crsr_down` |
| 18 | $12 | `rvs_on`, `reverse_on`, `rvon` |
| 19 | $13 | `home`, `cursor_home`, `crsr_home` |
| 20 | $14 | `del`, `delete` |
| 28 | $1C | `red` |
| 29 | $1D | `right`, `cursor_right`, `crsr_right` |
| 30 | $1E | `grn`, `green` |
| 31 | $1F | `blu`, `blue` |
| 94 | $5E | `up_arrow`, `uparrow` |
| 95 | $5F | `left_arrow`, `leftarrow` |
| 115 | $73 | `heart` |
| 129 | $81 | `org`, `orange` |
| 131 | $83 | `run` |
| 133 | $85 | `f1` |
| 134 | $86 | `f3` |
| 135 | $87 | `f5` |
| 136 | $88 | `f7` |
| 137 | $89 | `f2` |
| 138 | $8A | `f4` |
| 139 | $8B | `f6` |
| 140 | $8C | `f8` |
| 141 | $8D | `shift_return` |
| 142 | $8E | `uppercase`, `swuc` |
| 144 | $90 | `blk`, `black` |
| 145 | $91 | `up`, `cursor_up`, `crsr_up` |
| 146 | $92 | `rvs_off`, `reverse_off`, `rvoff` |
| 147 | $93 | `clr`, `clear` |
| 148 | $94 | `inst`, `ins`, `insert` |
| 149 | $95 | `brn`, `brown` |
| 150 | $96 | `lred`, `light_red` |
| 151 | $97 | `dgry`, `dark_grey`, `dark_gray`, `gry1` |
| 152 | $98 | `mgry`, `medium_grey`, `medium_gray`, `gry2` |
| 153 | $99 | `lgrn`, `light_green` |
| 154 | $9A | `lblu`, `light_blue` |
| 155 | $9B | `lgry`, `light_grey`, `light_gray`, `gry3` |
| 156 | $9C | `pur`, `purple` |
| 157 | $9D | `left`, `cursor_left`, `crsr_left` |
| 158 | $9E | `yel`, `yellow` |
| 159 | $9F | `cyn`, `cyan` |
| 222 | $DE | `pi` |

In the `:name:` and `<name>` forms of `encodeStringWithNames`, only a short list of single-word names is recognised, so that text such as `Mode: reverse on: yes` stays text.

### ACME text directives

`!text` writes the characters unchanged. `!pet` converts them to PETSCII: a-z become $41-$5A and A-Z become $C1-$DA. `!scr` converts them to screen codes: a-z become $01-$1A, `@` becomes $00. These tables are the ones of ACME 0.97. In these directives braces are ordinary characters. See [syntax.md](syntax.md#text-and-the-acme-text-directives).

## I/O range

`rangeOverlapsIo(start, length)` tells whether a byte range touches $D000-$DFFF, the area where the C64 maps the VIC-II, SID, CIA registers and colour RAM. The assembler uses it to refuse a PRG whose zero-filled gap would write to this area. Callers can use it before writing a PRG to a machine. See [api.md](api.md#rangeoverlapsio).
