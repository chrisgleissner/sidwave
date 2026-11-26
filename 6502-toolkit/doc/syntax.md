# Assembly language reference

This page describes every statement the assembler accepts. Each example is assembled by the test suite.
In an `asm` example, the bytes below it are the complete PRG: the first two bytes are the load address, low byte first.
Where an example fails, the exact error message is shown.

Contents: [source format](#source-format), [labels](#labels), [numbers and strings](#numbers-and-strings), [expressions](#expressions), [instructions](#instructions-and-addressing-modes), [directives](#directives), [macros and repeat](#macros-and-repeat), [conditional assembly](#conditional-assembly), [two passes and forward references](#two-passes-and-forward-references), [unsupported syntax](#unsupported-syntax), [error messages](#error-messages).

## Source format

- One statement per line. A line has optional labels, then at most one statement, then an optional comment.
- Comments start with `;` or `//` and run to the end of the line. A `;` or `//` inside a string is text.
- Mnemonics, directive names and the register letters `X`, `Y` and `S` are not case-sensitive. Label and symbol names are case-sensitive.
- Blanks, tabs and non-breaking spaces separate tokens. Line ends can be LF, CRLF or CR. A leading byte order mark is ignored.
- A name is a letter, `_` or `.`, followed by letters, digits, `_` or `.`.

```asm
* = $c000
        lda #1      ; a comment
        sta $d020   // another comment
        .text ";"   ; a semicolon in a string
```

```hex
00 C0 A9 01 8D 20 D0 3B
```

## Labels

A label is a name followed by a colon. Several labels can stand on one line, and a label can stand alone on its own line.
A name in column 0 without a colon is also a label, if an instruction, a directive or a macro call follows it, or nothing does.
A name that stands alone in column 0, that no expression refers to and that has no colon is an error, because it is most likely a misspelt mnemonic. If a statement follows such a name, the assembler adds a warning instead.

A name that starts with `.` is a local label. It belongs to the nearest global label above it, so the same local name can be used again under another global label. Assignments such as `.k = 3` are local in the same way. A local label before the first global label is an error.

```asm
* = $c000
first:  ldx #3
.loop:  dex
        bne .loop
second  ldy #3
.loop:  dey
        bne .loop
        jmp first
```

```hex
00 C0 A2 03 CA D0 FD A0 03 88 D0 FD 4C 00 C0
```

Defining a label or a constant twice with different values is an error, and so is defining a label twice with the same address.
Defining a constant twice with the same value is allowed.

```asm
a: nop
a: nop
```

```error
(input):2: Duplicate label "a" (first defined at (input):1)
    a: nop
```

A local label before any global label:

```asm
.loop: nop
```

```error
(input):1: Local label ".loop" defined before any global label
    .loop: nop
```

## Numbers and strings

| Form | Example | Value |
| --- | --- | --- |
| Hexadecimal | `$ff`, `0xFF` | 255 |
| Binary | `%1010`, `0b1010` | 10 |
| Decimal | `255` | 255 |
| One-character string | `'A'`, `"A"` | 65 |

A string is written in double or single quotes. These escapes are recognised: `\0`, `\t`, `\n`, `\r`, `\xNN` (two hex digits), `\\`, `\"` and `\'`. Any other escape is an error.
A string of one character is a number in an expression. Longer strings are allowed only as arguments of the data directives ([.byte](#byte), [.word](#word), [.text](#text-and-the-acme-text-directives)).

`%` is binary only directly in front of binary digits at the start of an operand or expression; elsewhere it is the modulo operator.

```asm
* = $c000
        .byte $ff, 0xff, %11111111, 0b11111111, 255, 'A', "\x41"
        .byte 10 % 4
```

```hex
00 C0 FF FF FF FF FF 41 41 02
```

An unterminated string and an unknown escape:

```asm
  .byte "abc
```

```error
(input):1: Unterminated string literal (a backslash escapes the next character: write \\ for one backslash and \" for a quote)
    .byte "abc
```

```asm
  .byte "\q"
```

```error
(input):1: Unknown escape "\q" in a string; use \0, \xNN, \n, \r, \t, \\, \" or \'
    .byte "\q"
```

## Expressions

Expressions use 64-bit floating point numbers internally, which are exact for every integer an address or byte value needs. Division truncates toward zero.

| Precedence | Operators | Meaning |
| --- | --- | --- |
| 8 (highest) | `*` `/` `%` | multiply, divide, modulo |
| 7 | `+` `-` | add, subtract |
| 6 | `<<` `>>` | shift left, shift right (arithmetic) |
| 5 | `<` `<=` `>` `>=` | comparison, result 1 or 0 |
| 4 | `==` `!=` | equality, result 1 or 0 |
| 3 | `&` | bitwise and |
| 2 | `^` | bitwise exclusive or |
| 1 (lowest) | `\|` | bitwise or |

Unary operators: `-` and `+` (sign), `!` (logical not: 1 for 0, otherwise 0), `~` (bitwise not), `<` (low byte) and `>` (high byte).
`<` and `>` apply to the whole expression that follows them, as in ACME and 64tass: `>msg+1` is the high byte of `msg+1`. Use parentheses to limit them: `(>msg)+1`.
`*` stands for the address of the current statement. Parentheses group.

The bitwise operators, the shifts and `~` work on 32-bit values. An operand outside -2147483648..4294967295 is an error, and so is a shift count outside 0..31. Division and modulo by zero are errors.

```asm
* = $c000
base = $1234
        .byte <base, >base, >base+1, (>base)+1
        .word base+2*3, (base+2)*3 & $ffff
        .byte 1<<4, 256>>4, $f0&$3c, $f0|$0f, $ff^$0f, !0, !5
        .byte 7/2, 7%4, 1==1, 1!=1, 2<=1
here:   .word *, here+1
```

```hex
00 C0 34 12 12 13 3A 12 A2 36 10 10 30 FF F0 01 00 03 03 01 00 00 14 C0 15 C0
```

Errors in expressions:

```asm
  .byte 1/0
```

```error
(input):1: Division by zero
    .byte 1/0
```

```asm
  .byte 1<<32
```

```error
(input):1: Shift count 32 for << is outside 0..31
    .byte 1<<32
```

## Instructions and addressing modes

The mnemonics are the 56 documented ones and the undocumented ones with their canonical names, listed in [opcodes.md](opcodes.md).
The names `JAM`, `SLO`, `SRE`, `DCP` and `ISC` are used, not `HLT`, `ASO`, `LSE`, `DCM` and `INS`.

| Mode | Syntax | Example |
| --- | --- | --- |
| implied | `mnemonic` | `rts` |
| accumulator | `mnemonic A` or `mnemonic` | `asl a` |
| immediate | `mnemonic #expr` | `lda #$10` |
| zero page | `mnemonic expr` | `lda $10` |
| zero page,X / ,Y | `mnemonic expr,X` | `lda $10,x` |
| absolute | `mnemonic expr` | `lda $1000` |
| absolute,X / ,Y | `mnemonic expr,X` | `lda $1000,x` |
| indirect | `mnemonic (expr)` | `jmp ($fffc)` |
| (indirect,X) | `mnemonic (expr,X)` | `lda ($10,x)` |
| (indirect),Y | `mnemonic (expr),Y` | `lda ($10),y` |
| relative | `mnemonic expr` | `bne loop` |

Rules:

- `A` alone is the accumulator only for `ASL`, `LSR`, `ROL` and `ROR`. For every other instruction `A` is an ordinary symbol, so `lda a` and `lda a+1` read a variable named `a`.
- Zero page or absolute is chosen from the value of the operand. A value from 0 to 255 that is known when the instruction is read selects zero page, when the instruction has a zero-page form. A value that is not known yet (a label defined further down) selects absolute. The second pass then keeps that choice. See [two passes](#two-passes-and-forward-references).
- Instructions that have only a zero-page index form, such as `STX zp,Y`, treat an unknown value as zero page and report an error in the second pass when the value is above 255.
- An absolute operand below $0100 is assembled as zero page when the instruction has a zero-page form. There is no way to force the absolute form.
- A relative branch takes the target address, not the offset. The target must be from 128 bytes before to 127 bytes after the end of the branch instruction.
- A branch at the top of memory wraps: a branch at $FFFE has its next instruction at $0000, as on the CPU.
- Immediate operands must be in -128..255. An address operand must be in 0..65535. A `(zp,X)` or `(zp),Y` operand must be in 0..255.
- The stack-relative form `expr,S` is parsed but no NMOS instruction has it, so it is always an error.

```asm
* = $c000
        lda #$10
        lda $10
        lda $10,x
        lda $1000
        lda $1000,y
        lda ($10,x)
        lda ($10),y
        jmp ($fffc)
        asl a
        ror
        bne *+4
        nop
        nop
```

```hex
00 C0 A9 10 A5 10 B5 10 AD 00 10 B9 00 10 A1 10 B1 10 6C FC FF 0A 6A D0 02 EA EA
```

Branch range:

```asm
* = $c000
        bne $c002+127
```

```hex
00 C0 D0 7F
```

```asm
* = $c000
        bne $c002-128
```

```hex
00 C0 D0 80
```

```asm
* = $c000
        bne $c002+128
```

```error
(input):2: Branch target out of range (offset 128)
    bne $c002+128
```

Unsupported forms name the mnemonic and the form:

```asm
  sta #1
```

```error
(input):1: Instruction STA does not support immediate addressing
    sta #1
```

```asm
  lda #256
```

```error
(input):1: Immediate operand 256 of LDA is outside -128..255 and would be truncated to one byte
    lda #256
```

### Undocumented opcodes

All 105 undocumented opcodes can be assembled with their canonical names.
Several undocumented opcodes share their mnemonic and mode with another opcode (for example the six one-byte `NOP`s besides $EA). The assembler emits the lowest documented opcode of such a pair, or the lowest opcode when none is documented.
Use `.byte` to emit one of the other bytes.

```asm
* = $c000
        lax $10
        sax $11
        slo ($20),y
        alr #$7f
        jam
        nop #$12
        sbc #$12
```

```hex
00 C0 A7 10 87 11 13 20 4B 7F 02 80 12 E9 12
```

## Directives

Directive names start with `.` or `!`, or are plain words such as `org` and `byte`. Each spelling follows the documented meaning in one named assembler, and the test suite compares the bytes with the output of those assemblers.

| Meaning | Spellings |
| --- | --- |
| [origin](#origin) | `* = expr`, `.org expr`, `org expr` |
| [bytes](#byte) | `.byte`, `.byt`, `.by`, `.db`, `byte`, `db`, `!byte`, `!by`, `!8`, `!08` |
| [words](#word) | `.word`, `.wo`, `word`, `dw`, `!word`, `!wo`, `!16` |
| [text](#text-and-the-acme-text-directives) | `.text`, `.ascii`; ACME: `!text`, `!tx`, `!txt`, `!raw`, `!pet`, `!scr` |
| [fill](#fill) | `.fill n[, value]`, `!fill`, `!fi` |
| [align](#align) | `.align n[, fill]`; ACME: `!align and, equal[, fill]` |
| [reserve](#reserve) | `.res n[, value]`, `.ds`, `res`, `ds` |
| [constants](#constants) | `name = expr`, `.equ name, expr`, `name .equ expr` |
| [include](#include) | `.include "file"`, `include`, `!source`, `!src` |
| [binary](#incbin-and-binary) | `.incbin "file"[, offset[, length]]`, `.binary`; ACME: `!binary "file"[, size[, skip]]`, `!bin` |
| [conditions](#conditional-assembly) | `.if expr`, `.else`, `.endif`, `.fi` |
| [macros](#macros-and-repeat) | `.macro`, `.mac`, `.endmacro`, `.endmac`, `.endm` |
| [repeat](#macros-and-repeat) | `.repeat`, `.endrepeat`, `.endrep`, `.rept`, `.endrept` |

An unknown directive fails with the list of every supported spelling.

### Origin

Grammar: `* = expr`, `.org expr` or `org expr`. The value must be 0..65535 and known at that point (no forward references).
Code before the first origin is assembled at the load address (`AssembleOptions.loadAddress`, default $0801).
Several origins make several blocks. The PRG spans from the lowest to the highest written byte, and gaps are zero-filled. See [commodore.md](commodore.md#prg-files).

```asm
* = $c000
        rts
.org $c010
        rts
org $c020
        rts
```

```hex
00 C0 60 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 60 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 60
```

```asm
  .org $10000
```

```error
(input):1: org directive value 65536 is outside $0000-$FFFF
    .org $10000
```

```asm
  * = $10000
```

```error
(input):1: * = value 65536 is outside $0000-$FFFF
    * = $10000
```

### Byte

Grammar: `.byte item[, item ...]`. An item is an expression in -128..255 or a string. A string gives one byte per character with the character code unchanged (code 255 at most).
In the ACME spellings (`!byte`, `!by`, `!8`, `!08`) a string must be a single character.

```asm
* = $c000
        .byte 1, -1, 255, "AB", 'a'+1
        !byte "A"
```

```hex
00 C0 01 FF FF 41 42 62 41
```

```asm
  .byte 256
```

```error
(input):1: byte directive value 256 is outside -128..255 and would be truncated
    .byte 256
```

```asm
  !byte "ab"
```

```error
(input):1: !byte takes a string only as a single character, as in ACME; use !text for longer strings
    !byte "ab"
```

### Word

Grammar: `.word item[, item ...]`. An item is an expression in -32768..65535, written low byte first, or a string, which gives one word per character. Labels defined later can be used.

```asm
* = $c000
        .word $1234, -1, later
later:  .word "A"
```

```hex
00 C0 34 12 FF FF 06 C0 41 00
```

```asm
  .word 65536
```

```error
(input):1: word directive value 65536 is outside -32768..65535 and would be truncated
    .word 65536
```

`.dw` is rejected, because Kick Assembler uses it for four bytes; use `.word`.

### Text and the ACME text directives

`.text` and `.ascii` take strings and expressions. They write PETSCII: a-z are folded to the capitals `$41`-`$5A`, `\n` becomes RETURN (`$0D`), and other ASCII characters are unchanged. A character above $7F is an error.
Lower-case letters in `.text` add one warning per assembly, because 64tass emits ASCII and Kick Assembler emits screen codes for the same line.

Inside a `.text` string, `{name}`, `{$xx}` and `{nn}` are PETSCII control codes. See [commodore.md](commodore.md#petscii-text) for the table.

The ACME spellings are exact copies of the ACME 0.97 tables:

| Directive | `"aB@"` becomes |
| --- | --- |
| `!text`, `!tx`, `!txt`, `!raw` | $61 $42 $40 (raw) |
| `!pet` | $41 $C2 $40 (PETSCII) |
| `!scr` | $01 $42 $00 (screen codes) |

A single character in an expression is converted by the same table: `!pet 'a'+1` is $42.

```asm
* = $c000
        .text "Hello{red}!\n{$93}"
        !text "aB@"
        !pet "aB@"
        !scr "aB@"
        !pet 'a'+1
```

```hex
00 C0 48 45 4C 4C 4F 1C 21 0D 93 61 42 40 41 C2 40 01 42 00 42
```

```asm
  .text "{nope}"
```

```error
(input):1: {nope} is not a known control code (unknown control-code name); write \x7b for a literal brace
    .text "{nope}"
```

```asm
  .text "é"
```

```error
(input):1: text directive character 'é' (code 233) is not ASCII and has no PETSCII mapping; use .byte $xx for it
    .text "é"
```

### Fill

Grammar: `.fill count[, value]`. The count is 0..65536, the value -128..255 and zero when left out.

```asm
* = $c000
        .fill 3, $aa
        !fill 2
        !fi 1, 7
```

```hex
00 C0 AA AA AA 00 00 07
```

```asm
  .fill 65537
```

```error
(input):1: fill directive requires a count of 0..65536, got 65537
    .fill 65537
```

### Align

Grammar: `.align boundary[, value]`. Pads with `value` (zero by default) until the address is a multiple of `boundary`, which is 1..65536.

ACME's `!align andvalue, equalvalue[, value]` pads until `address AND andvalue` equals `equalvalue`. The default fill is $EA (NOP). `andvalue` and `equalvalue` must be in 0..65535, and a pair that no address satisfies is an error.

```asm
* = $c001
        .align 4
        nop
        !align 3, 0
        rts
```

```hex
01 C0 00 00 00 EA EA EA EA 60
```

```asm
  .align 0
```

```error
(input):1: align directive requires a boundary of 1..65536, got 0
    .align 0
```

```asm
  !align 3, 4
```

```error
(input):1: !align 3, 4 can never be satisfied
    !align 3, 4
```

### Reserve

Grammar: `.res count[, value]`, also `.ds`, `res` and `ds`. Without a value, the program counter advances and no byte is written. With a value, the directive is the same as `.fill`.
Reserved space is part of the PRG only where it touches written bytes (a trailing `counter: .res 1`). Detached reserved space, for example zero-page variables, is not. See [commodore.md](commodore.md#prg-files).

```asm
* = $c000
        lda counter
        rts
counter: .res 2
```

```hex
00 C0 AD 04 C0 60 00 00
```

```asm
  .res -1
```

```error
(input):1: reserve directive requires a non-negative size
    .res -1
```

```asm
* = $ffff
  .res 2
```

```error
(input):2: reserve directive of 2 bytes at $FFFF passes $FFFF
    .res 2
```

### Constants

Grammar: `name = expr`, `.equ name, expr` or `name .equ expr`. The three forms are the same. A constant can refer to labels and constants defined later in the file (`size = end - start`), as long as every name has a value at the end of the first pass.

```asm
* = $c000
border = $d020
.equ screen, $d021
bg .equ 6
        lda #bg
        sta border
        sta screen
size = end - start
start:  nop
        nop
end:
        .byte size
```

```hex
00 C0 A9 06 8D 20 D0 8D 21 D0 EA EA 02
```

```asm
a = missing
```

```error
(input):1: Undefined symbol "missing"
    a = missing
```

### Include

Grammar: `.include "path"`. The assembler calls `AssembleOptions.resolveInclude(path, fromFile)` and assembles the returned text in place. The assembler never reads a file itself.
The resolver returns a string, or an object `{ contents, fileName }` that gives the name shown in error messages. Without a resolver, `.include` is an error. A file that includes itself, directly or through other files, is an error.
Included files share labels and constants with the including file. Nesting is limited to 16 levels.

```js
import { assemblyToPrg } from "6502-toolkit";

const files = { "defs.asm": "border = $d020\n", "main.asm": '.include "defs.asm"\n* = $c000\n  sta border\n' };
const prg = assemblyToPrg(files["main.asm"], {
  fileName: "main.asm",
  resolveInclude: (path, fromFile) => ({ contents: files[path], fileName: path }),
});
console.log(prg.toString("hex"));
```

```output
00c08d20d0
```

An error in an included file reports that file's name and line:

```js
import { assemblyToPrg } from "6502-toolkit";

try {
  assemblyToPrg('.include "lib.asm"', {
    resolveInclude: () => ({ contents: "  nop\n  lda #300\n", fileName: "lib.asm" }),
  });
} catch (error) {
  console.log(error.location.file, error.location.line);
  console.log(error.message);
}
```

```output
lib.asm 2
lib.asm:2: Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte
    lda #300
```

Without a resolver:

```js
import { assemblyToPrg } from "6502-toolkit";

try {
  assemblyToPrg('.include "x.asm"');
} catch (error) {
  console.log(error.message);
}
```

```output
(input):1: include needs a resolveInclude option; the MCP tools provide none, so paste the included source into the program
    .include "x.asm"
```

### Incbin and binary

Grammar: `.incbin "path"[, offset[, length]]` and `.binary`. The assembler calls `AssembleOptions.resolveIncbin(path, fromFile)` for the bytes of the file (at most 65536). `offset` defaults to 0 and `length` to the rest of the file. A range that does not fit the file is an error.

ACME's `!binary "path"[, size[, skip]]` (also `!bin`) takes the size first. Either value can be left out (`!binary "x",, 2`). A file shorter than `size` is padded with zeros and adds a warning.

The resolver is called once per path in an assembly.

```js
import { assemblyToPrgDetailed } from "6502-toolkit";

const result = assemblyToPrgDetailed('* = $c000\n  .incbin "data.bin", 1, 2\n  !binary "data.bin", 5, 2', {
  resolveIncbin: (path, fromFile) => Uint8Array.of(1, 2, 3, 4),
});
console.log(result.prg.toString("hex"));
console.log(result.warnings.join("\n"));
```

```output
00c002030304000000
(input):3: !binary "data.bin" has 2 bytes after offset 2; padded with 3 zero bytes to SIZE 5
```

Without a resolver:

```js
import { assemblyToPrg } from "6502-toolkit";

try {
  assemblyToPrg('.incbin "x.bin"');
} catch (error) {
  console.log(error.message);
}
```

```output
(input):1: .incbin needs a resolveIncbin option; the MCP tools provide none, so write the bytes with .byte
    .incbin "x.bin"
```

```asm
  .incbin "data.bin", 3, 2
```

```error
(input):1: .incbin "data.bin": offset 3 and length 2 do not fit the 4 bytes of the file
    .incbin "data.bin", 3, 2
```

## Macros and repeat

Macros are expanded when they are read. A macro must be defined before it is used. Macro names are not case-sensitive and cannot be mnemonics or directives. Expansion is limited to 100000 lines in total and a nesting depth of 16. Labels inside a macro are global, so a macro with a label can be used only once; use a local label in the calling code instead.

**ca65 style.** `.macro name param1, param2` ... `.endmacro` (also `.mac` and `.endmac`). The macro is called by its name. Each parameter name in the body is replaced by the text of its argument. Arguments are separated by commas; commas inside parentheses and strings do not separate.

```asm
* = $c000
.macro store value, address
        lda #value
        sta address
.endmacro
        store 5, $d020
        store 6, $d021
```

```hex
00 C0 A9 05 8D 20 D0 A9 06 8D 21 D0
```

**64tass style.** `name .macro param1, param2` ... `.endm` (also `.endmacro`). The macro is called as `#name` or `.name`. In the body, a parameter is written `\name` or `\{name}`, positional arguments are `\1` to `\9`, and `\@` is the whole argument list as written.

```asm
* = $c000
set .macro value, address
        lda #\value
        sta \{address}
.endm
        #set 5, $d020
        .set 6, $d021
all .macro
        .byte \@
.endm
        #all 1, 2, 3
```

```hex
00 C0 A9 05 8D 20 D0 A9 06 8D 21 D0 01 02 03
```

**Repeat.** `.repeat count` ... `.endrepeat` (also `.endrep`) and `.rept count` ... `.endrept`. The count is 0..65536 and uses numbers and constants defined earlier. A counter name (`.repeat 4, i`) is not supported.

```asm
* = $c000
count = 2 + 1
.repeat count
        inx
.endrepeat
```

```hex
00 C0 E8 E8 E8
```

Errors:

```asm
.macro wait n
  nop
.endmacro
  wait 1, 2
```

```error
(input):4: Macro wait takes 1 argument (n), got 2
    wait 1, 2
```

An error inside an expansion names the macro or repeat:

```asm
.macro bad
  lda #300
.endmacro
  bad
```

```error
(input):4 (in macro bad): Immediate operand 300 of LDA is outside -128..255 and would be truncated to one byte
    lda #300
```

```asm
.repeat 2
  nop
```

```error
(input):1: .repeat has no matching .endrepeat
    .repeat 2
```

## Conditional assembly

Grammar: `.if expr` ... `.else` ... `.endif` (also `.fi`). The expression must have a value at that point: labels defined further down the file are not known yet. A value other than 0 is true. Conditions can be nested. Lines in an inactive branch define no labels and emit no bytes.

```asm
* = $c000
debug = 1
.if debug == 1
        .byte 1
.else
        .byte 2
.endif
.if 0
        .byte 3
.fi
```

```hex
00 C0 01
```

```asm
  .else
```

```error
(input):1: .else without a matching .if
    .else
```

```asm
  nop
  .if 1
  nop
```

```error
(input):2: .if has no matching .endif
    .if 1
```

## Two passes and forward references

The assembler reads the source twice. The first pass assigns an address to every label and chooses an addressing mode for every instruction. The second pass writes the bytes.

- A label can be used before its definition. An instruction that uses an unknown value is sized for absolute addressing, and keeps that size in the second pass, even if the label ends up in zero page.
- A constant whose expression uses a name defined later is resolved after the first pass. A constant that depends on a name that is never defined is an error.
- Directives that change the address or the size (`.org`, `.fill`, `.align`, `.res`, `.if`, `.repeat`) need values that are known at that point.
- A label whose value differs between the passes is an error.

```asm
* = $0010
        jmp end
        nop
end:    rts
```

```hex
10 00 4C 14 00 EA 60
```

## Unsupported syntax

These forms fail with a message that says what to write instead.

| Syntax | Why | Message starts with |
| --- | --- | --- |
| `+` and `-` anonymous labels | use a named label | `Anonymous labels (+ and -, as in 64tass and ACME) are not supported` |
| `@name` cheap local labels (ca65) | use `.name:` | `Unexpected character '@': cheap local labels` |
| `.dw` | ambiguous between assemblers | `unsupported directive .dw` |
| `.pc = addr` (Kick Assembler) | use `* = addr` | `unsupported directive .pc` |
| `.scr`, `.screen`, `.petscii`, `.endr` | not documented by the supported assemblers | `unsupported directive .scr` |
| `.repeat n, counter` | no counter variable | `.repeat with a counter name` |
| 65C02 and 65816 mnemonics | NMOS only | `Unknown instruction` |
| `!convtab`, `!macro`, `!zone` and other ACME blocks | not implemented | `unsupported directive` |

```asm
  nop
  bne -
```

```error
(input):2: Anonymous labels (+ and -, as in 64tass and ACME) are not supported; use a named label
    bne -
```

## Error messages

Every assembly error is an `AssemblyError`. The message has the form

```text
<file>:<line>: <message>
    <the source line, trimmed to 160 characters>
```

and for a line produced by a macro or repeat, `<file>:<line> (in macro name):` or `(in repeat)`. `error.location` holds `{ file, line, text, context? }`. See [api.md](api.md).
The file is `(input)` unless `AssembleOptions.fileName` or an include resolver gives another name. The line number counts from 1; for an expansion it is the line of the call.
