# sidwave

[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg?flag=sidwave)](https://codecov.io/gh/chrisgleissner/sidwave)

SIDWave is a music language, compiler and toolkit for the Commodore 64 SID chip. Write a score as YAML or JSON. Compile it to a self-playing C64 PRG or to a PSID file that includes the 6502 player.

Status: pre-release. This package has not been published to npm yet. Build it from the [repository](https://github.com/chrisgleissner/sidwave#install-and-first-tune). Once published, the install command is:

```sh
npm install sidwave
```

Requires Node.js 20.19 or later. Runtime dependencies: `yaml` and `6502-toolkit`. Optional peer dependency: `libsidplayfp-wasm` (see Engine).

## Library

The public API is not final. These functions exist today:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";

const doc = parseSidwave(readFileSync("song.sidwave.yaml", "utf8")); // throws SidwaveValidationError
const result = compileSidwaveToPrg(doc);
const { sid } = compileSidwaveToSid(doc, result.prg);

writeFileSync("song.prg", result.prg);
writeFileSync("song.sid", sid);
```

## SID files

`sidwave/sid-file` reads and writes PSID and RSID files (versions 1 to 4): `parseSidFile`, `writeSidFile`, `subtunes`, `songSpeed`, `effectiveInitAddress` and `md5ForSonglengths`. Invalid input throws `SidFileError` with a `code`. `sidwave/songlengths` parses the HVSC Songlengths database: `parseSonglengths`, `parseSonglengthsWithPaths`, `parseDuration` and `lookupSonglength`. Both are also exported from the package root.

```ts
import { readFileSync } from "node:fs";
import { parseSidFile } from "sidwave/sid-file";

const sid = parseSidFile(new Uint8Array(readFileSync("tune.sid")));
console.log(sid.name, sid.author, sid.songs);
// Fixture ä Generated 2 (for test/fixtures/sidfile/psid_v2_basic.sid)
```

Text fields (`name`, `author`, `released`) are Windows-1252. Parsing is lenient and reports recoverable deviations in `warnings`; `writeSidFile` is strict. `songSpeed` clamps songs above 32 to bit 31 for PSID v2 files without the PlaySID flag, because v2 and v2NG share version 2 and cannot be told apart.

## Command line

```text
sidwave validate <file> [--json] [--allow-dir <dir>]
sidwave compile  <file> [-o <out>] [--format prg|sid] [--loop|--no-loop] [--json] [--allow-dir <dir>]
sidwave lint     <file> [--loop|--no-loop] [--strict] [--json] [--allow-dir <dir>]
sidwave examples [<name>] [-o <dir>] [--force] [--json]
sidwave --help | --version
```

`compile --target game` has further options, described in [Using the player in a game](#using-the-player-in-a-game).

- `validate` parses the score. Exit 0 when valid; exit 1 and the path of the first error (`Invalid SIDWAVE at $.voices[0].adsr: ...`) otherwise.
- `compile` writes a PRG (default) or PSID. Without `-o` the file is named after the input, with `.prg` or `.sid`, in the current directory. A `-o` name ending in `.sid` selects PSID unless `--format` is given. `-o -` writes the bytes to standard output and the summary to standard error. `--json` prints the format, sizes, load, entry, init and play addresses, SID count, duration, frame counts and lint count. `--loop` (the default) and `--no-loop` select whether the song restarts at its end. The input file is never overwritten.
- `lint` prints the lint findings. It exits 0 for a valid score, whatever the findings; with `--strict` it exits 1 when there is a finding that is not an informational note.
- `examples` lists the bundled example scores. `examples <name>` prints one to standard output, or with `-o <dir>` writes `<dir>/<name>.yaml`; an existing file is only replaced with `--force`.
- `--allow-dir <dir>` (repeatable) permits `file:` sample sources below `<dir>`. Without it they must lie below the current directory (symbolic links are resolved first). The command never uses the network.

Exit codes: 0 success; 1 invalid input or failed verdict; 2 usage or operational error (unknown option, unreadable or unwritable file, refusing to overwrite). Every command is a library function (`compileSidwaveBytes`, `lintSidwave`, `confinedFileReader`, ...); the command line only translates arguments and output.

## Using the player in a game

A game build is the player assembled at an address you choose. It has no BASIC stub, installs no interrupt, touches no CIA or KERNAL vector and leaves the call timing to your program. You call it from your own raster interrupt or main loop.

### Compile

```sh
sidwave compile song.sidwave.yaml --target game --origin 0x1000 --symbols acme -o song
```

This writes `song.bin`, the player and music at `$1000` (raw bytes, no load address), and `song.acme`, the symbol file. Load `song.bin` at `$1000` with your loader or include it in your build with `!binary` or `.incbin`. The summary line reports the cycles of one `play` call. `--json` prints the contract, the cycles and the exported labels.

| Option | Effect |
| --- | --- |
| `--origin <addr>` | Address of the entry table, `$0200` to `$CFFF`. The player, its variables and its data must end below `$D000`. Required. |
| `--data-origin <addr>` | Put the streams and tables in a second file, `song.data.bin`, at this address. The player file then holds only code, constants and the entry table. Both files belong together; the contract records a SHA-256 of the data, and `init` does not check it. |
| `--zp <addr>` | Zero page base of the player's pointers, `$02` to `$FE` (default `$FB`). A score with several SIDs needs four bytes, so the base must be at most `$FC`. |
| `--symbols <list>` | Symbol files to write next to the output, separated by commas: `acme` (`song.acme`), `kickass` (`.kickass`), `ca65` (`.ca65`), `vice` (`.vice`), `json` (`.symbols.json`). `acme` also loads in 64tass. |
| `--symbols-all` | Export every internal label too, as `sidwave_int_<label>`. |
| `--no-measure` | Skip the measurement run (see below). |
| `--format sid` | Write a PSID file of the same player instead. Its start routine passes the clock to `init`, and the header records the largest free page range of `$0400`-`$CFFF`. |

In the library, `compileSidwave(doc, { target: "game", origin, dataOrigin, zeroPage, symbols })` returns `player`, `data`, `combined` (`Uint8Array`), `symbols`, `contract` and `cycles`.

### Call it from a raster interrupt

This program uses the symbol file written above. It starts the music at `$1000` and plays one frame per raster interrupt. It is assembled with ACME syntax; 64tass accepts the symbol file as it is.

```asm
        !source "song.acme"              ; sidwave_init, sidwave_play, sidwave_stop, ...

        * = $0801
        !byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061

start:  sei
        lda #$7f
        sta $dc0d                        ; CIA1 interrupts off
        lda $dc0d
        lda #$01
        sta $d01a                        ; raster interrupt on
        lda #$fa
        sta $d012                        ; at raster line $FA
        lda $d011
        and #$7f
        sta $d011
        lda #0                           ; A = subtune 0
        ldx #$ff                         ; X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        cli
main:   jmp main                         ; your game goes here

irq:    lda #$01
        sta $d019                        ; acknowledge the raster interrupt
        jsr sidwave_play                 ; one play call per frame
        jmp $ea81                        ; restore A, X, Y and return from the interrupt
```

Call `sidwave_stop` to silence the voices when the game state changes. `stop` leaves interrupts alone; to start the music again, call `init`.

A score with multispeed (`speed` above 1) needs `speed` play calls per video frame, evenly spaced over the frame. Use `speed` raster interrupts per frame, for example one every `312 / speed` lines on PAL (263 lines on NTSC), and call `play` from each. The contract field `playCallsPerFrame` holds the number.

### Contract

| Item | Guarantee |
| --- | --- |
| Entry points | `origin+0` init, `+3` play, `+6` stop, `+9` sfx. Each is a three byte jump. `sfx` is a one byte `rts` stub until sound effects exist; the table never changes its layout. |
| `init` input | `A` = subtune index, 0-based; only 0 exists and other values are ignored. `X` = clock: 0 PAL, 1 NTSC (any other value counts as NTSC), `$FF` reads the KERNAL flag at `$02A6` (nonzero on PAL); do not place the player over `$02A6` if you pass `$FF` (the build warns). `init` silences the SID registers and resets the song. |
| `play`, `stop` input | None. Call `play` once per play period. |
| Registers | `init`, `play` and `stop` clobber A, X and Y. The interrupt and decimal flags are never changed; the other flags are undefined on return. |
| Processor port `$01` | Saved on entry, set to `$36` while the routine runs (I/O and KERNAL visible, BASIC ROM off), restored on return. |
| Zero page | `--zp` base and the byte after it (`ptr`); with several SIDs also the next two bytes (`sid_io`). Saved and restored by `play`. |
| SID registers | `$D400`-`$D418` of every SID of the score, written in the same order as the PRG player. The PRG, the PSID and the game build produce identical register writes. |
| RAM written | Only the ranges in `contract.ram`, which lie inside the player image and in the variable block that follows it (`sidwave_ram` to `sidwave_ram_end`). The variable block is not part of the file; keep it free. A score with a voice `detune` also patches four operand bytes inside the image (listed in `contract.patchedCode`), so the player cannot run from ROM then. Nothing else is written. |
| Interrupts | None used. No interrupt vector, CIA or VIC timer is touched. |
| Stack | `contract.maxStackBytes` bytes at most, return address included, measured over the whole song. |
| Cycles | `cycles.worst` is measured: the build runs every play call of the song plus one more pass of the loop on the bundled 6502 emulator, with the call through the entry table. `cycles.estimatedWorst` is the compiler's upper bound. The build fails when the measured value exceeds the estimate. The average is `cycles.average`. VIC and DMA stalls are not included. |
| Not supported | CIA2 digi samples (`samples:`), which need an installed NMI. A build with a KERNAL that is banked out is not offered; the player sets `$01` to `$36` itself. `cpu: turbo` builds, but the build does not switch the CPU speed. |

The symbol files export `sidwave_init`, `sidwave_play`, `sidwave_stop`, `sidwave_sfx`, `sidwave_ram`, `sidwave_ram_end`, `sidwave_data` and `sidwave_data_end` (with `--data-origin`), `sidwave_zp_ptr`, `sidwave_zp_sid_io` (several SIDs) and `sidwave_play_calls_per_frame`. The ACME, KickAssembler and ca65 files also carry the contract as comments.

## What you get

- The player as a library for games and demos: any origin, separate data, symbol files and a documented contract (see [Using the player in a game](#using-the-player-in-a-game)).
- Language versions 1.0 to 1.3: wave, pulse and filter tables, hard restart, sync and ring, echo, unison, follower voices, multispeed, sections, up to 10 SIDs and 30 voices in a PRG (PSID: up to 3 SIDs), CIA2 volume digis in a PRG.
- Lint checks and error messages that name the failing path in the score.
- 14 example scores in [`data/sound/examples`](data/sound/examples).

Planned and not yet available: `sidwave verify`, formatter and diff, subtunes and sound effects for games, reconstruction of SID tunes into scores, MIDI/MusicXML/tracker import.

## Engine

`sidwave/engine` renders and traces SID files with [libsidplayfp-wasm](https://www.npmjs.com/package/libsidplayfp-wasm) (reSIDfp or SIDLite). `sidwave/verify` compares the SID register writes of two tunes (levels T0 and T1) and, with a SIDLite engine, their PCM (level A0). The package is an optional peer dependency (`^1.1.1`): install it yourself when you use these two entry points.

```bash
npm install libsidplayfp-wasm
```

Without it, `createLibsidplayfpEngine(...).render()` and `.trace()` throw `SidEngineUnavailableError` with a message that names the package and this install command; the original error is in `cause`. The rest of sidwave does not need the package. `engine.version` is the installed package version and reads "unknown" until the first render or trace has loaded it.

```ts
import { createLibsidplayfpEngine } from "sidwave/engine";

const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const { samples, md5 } = await engine.render({ sid, seconds: 10 });
const trace = await engine.trace({ sid, seconds: 10 });
```

### Trace

`trace` returns the SID writes as groups of four numbers (SID number, register, value, cycle). Cycles are counted from engine start. It never drops writes: if the trace buffer or `maxRecords` would be exceeded it throws `TraceOverflowError`.

- `maxRecords` defaults to 4,194,304 (2^22 records, 128 MB of Float64). Raise it explicitly for longer traces.
- With `onChunk`, records are delivered as they are produced and are not accumulated: the result has an empty `records` array and `count` gives the number of records delivered. An error thrown by `onChunk` or `onProgress` ends the call and propagates unchanged.
- `clock` defaults to the clock flag in the PSID header (PAL if the header gives none). It determines the slice length, the horizon and all cycle-to-time conversions.
- `horizonCycles` is `originCycle` plus the requested duration, where `originCycle` is the cycle at which the first PCM sample is produced. It is measured with a small PSID probe tune and is approximate for RSID or ROM-booted tunes, whose start-up time differs; verdicts are unaffected because both traces in a comparison share it. Records after the horizon are discarded, so traces of equal duration end at the same cycle. `cycles` is the end of the last rendered slice and can exceed `horizonCycles` by up to one slice (about 20 ms).

### Tracing and audio

`trace` also returns the PCM it rendered. With SIDLite this PCM is bit-identical to the PCM of `render` with the same request; the test suite compares SHA-256 hashes of both. With reSIDfp only the length and the RMS level are checked (within one percent), because the PCM of reSIDfp is not reproducible across freshly created engines, so a bit-exact comparison is not possible.

### ROMs

ROMs are optional. No ROMs are downloaded or bundled. Pass your own KERNAL, BASIC and character ROM images in the `roms` field of a request:

```ts
await engine.render({ sid, seconds: 10, roms: { kernal, basic, chargen } }); // Uint8Array images
```

Tunes that call the KERNAL or BASIC (RSID tunes, for example) may not advance without them. The test suite renders and traces the SID files that sidwave compiles without any ROM and finds SID writes at the expected play rate; other tunes are untested without ROMs.

### Verify

```ts
import { createLibsidplayfpEngine } from "sidwave/engine";
import { verifySid } from "sidwave/verify";

const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const result = await verifySid(referenceSid, candidateSid, { engine, pcmEngine: engine, seconds: 10 });
// result.level is "T0", "T1", "A0" or "none"; result.levels holds pass or fail per level.
if (result.firstDifference) {
  const { category, call, voice, register, cycle, timeSeconds } = result.firstDifference;
}
```

- T0: both tunes make the same writes in the same order in every player call.
- T1: the same writes with every write within `toleranceCycles` (default 0) of the reference. Cycles are compared from engine start, so a tune that starts writing later than the reference fails at its first write.
- A0: identical SIDLite PCM.
- A trace with no writes inside the horizon fails T0 and T1 with category `empty_trace`.
- The clock is taken from the PSID header of the reference tune unless `clock` is given. Every difference carries `cycle` and `timeSeconds` on that clock.

## Versioning and support

- The package follows semantic versioning from 1.0.0. Before 1.0.0, a minor version may contain breaking changes. They are listed in [CHANGELOG.md](CHANGELOG.md).
- A deprecated export or option is announced in the changelog one minor release before it is removed.
- Supported runtimes: Node.js 20.19 or later (the oldest version in CI is 20) and Bun 1.3.1 or later. The package uses Node.js modules (`node:fs`, `node:buffer`) and is not meant for browsers; the player it compiles runs on a C64.
- The package is ESM only. On Node.js 20.19 and later, 22.12 and later, and all later versions, `require("sidwave")` loads it through `require(esm)`. On older versions, use `await import("sidwave")`.

## More

- [Repository README](https://github.com/chrisgleissner/sidwave#readme): overview, examples, roadmap
- [Language specification](data/sound/sidwave.md) and [JSON Schema](data/sound/sidwave.schema.json)
- [Licensing notes](doc/licensing.md): read this before releasing a tune or embedding the player in a game

License: GPL-2.0-or-later with the [SIDWave Player Exception](LICENSE-EXCEPTION.md).
