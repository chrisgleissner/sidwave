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
sidwave verify   <reference.sid|score> <candidate.sid|score> [--song <n>] [--seconds <s>] [--level T0|T1|A0|A1] [--tolerance-cycles <n>]
sidwave render   <file.sid|score> [-o <out.wav>] [--song <n>] [--seconds <s>] [--rate <hz>] [--engine residfp|sidlite]
sidwave trace    <file.sid|score> [-o <out>] [--format csv|jsonl] [--song <n>] [--seconds <s>]
sidwave reconstruct <file.sid> [--song <n>] [--seconds <s>] [-o <score.yaml>] [--json]
sidwave sid-info <file.sid> [--songlengths <Songlengths.md5>] [--json]
sidwave --help | --version
```

`compile --target game` has further options, described in [Using the player in a game](#using-the-player-in-a-game).

- `validate` parses the score. Exit 0 when valid; exit 3 and the path of the first error (`Invalid SIDWAVE at $.voices[0].adsr: ...`) otherwise.
- `compile` writes a PRG (default) or PSID. Without `-o` the file is named after the input, with `.prg` or `.sid`, in the current directory. A `-o` name ending in `.sid` selects PSID unless `--format` is given. `-o -` writes the bytes to standard output and the summary to standard error. `--json` prints the format, sizes, load, entry, init and play addresses, SID count, duration, frame counts and lint count. `--loop` (the default) and `--no-loop` select whether the song restarts at its end. The input file is never overwritten.
- `lint` prints the lint findings. It exits 0 for a valid score, whatever the findings; with `--strict` it exits 1 when there is a finding that is not an informational note.
- `examples` lists the bundled example scores. `examples <name>` prints one to standard output, or with `-o <dir>` writes `<dir>/<name>.yaml`; an existing file is only replaced with `--force`.
- `verify` compiles a score argument to a PSID, then compares reference and candidate at the levels described under [Verify](#verify). `--level` is the weakest level that counts as a pass (default `A1`); the levels up to it are evaluated. The output names the highest level reached, the status of each level, the first difference and the horizon. The horizon is `--seconds`, else one pass of a score, else the songlengths entry, else 30 s, and at most 180 s. A1 uses the frozen rule file in `data/verify/a1-rules.json`, or the file given with `--a1-rules`.
- `render` writes 16-bit mono PCM as a WAV file (48 kHz by default, reSIDfp by default). `trace` writes the SID register writes as CSV (`sid,address,value,cycle`) or JSON lines, to standard output or `-o`. `trace --json` needs `-o`, because standard output carries the trace otherwise.
- `sid-info` prints the PSID/RSID header; with `--songlengths` it adds the length of each subtune.
- `reconstruct` recovers a SIDWave score from a SID tune. The tune is traced on SIDLite for `--seconds` (default 180, always reported), the recovered score is compiled and traced again, and the two traces are compared call by call (F-diff). The score goes to `-o` or standard output; `--json` prints the envelope with `result: { file, output, score, report }` (horizon, call rate, unsupported features, F-diff summary, language-extension candidates with reproducers). `--song` is the 1-based PSID subtune. Exit 0 when the strict F-diff shows no difference (`report.strictExact`: register state, in-call control write order and call timing, standard alignment, score compiles); otherwise exit 1 with `ok: false` and the result. `report.registerStateExact` is a secondary, weaker value: it ignores control-write order inside a call (a test-bit pulse `$09` then `$41` equals `$41` alone), which registers a call writes, and call timing; it is not audio equality. Unreadable or invalid input exits 3. Library: `reconstructSid` from `sidwave/reconstruct`.
- `--allow-dir <dir>` (repeatable) permits `file:` sample sources below `<dir>`. Without it they must lie below the current directory (symbolic links are resolved first). The command never uses the network.
- Run options of `verify`, `render` and `trace`: `--progress` writes progress to standard error (never standard output), `--max-seconds`, `--max-records` and `--max-bytes` bound the audio length, the trace size and the input and output size, `--roms <dir>` supplies `kernal.rom`, `basic.rom` and `chargen.rom`, `--clock PAL|NTSC` overrides the header (and `--model 6581|8580` for `render`). Ctrl-C (SIGINT) aborts the run through an `AbortSignal` that is passed to the library; a second Ctrl-C ends the process at once.

### Breaking changes of the command line

Compared with the earlier command line: an invalid score and an unreadable input file now exit 3 (they exited 1 and 2); an unwritable output path exits 3 (it exited 2); a failed verdict is the only case that exits 1. With `--json` the output is now an envelope `{ "ok", "command", "result" }` or `{ "ok": false, "command", "error": { "category", "message", "details" } }` instead of one flat object per command, and the file name of a failed validation moved to `error.details.file`. A second Ctrl-C exits 5.

### JSON output, error categories and exit codes

With `--json` every command prints one JSON document on standard output:

```json
{ "ok": true, "command": "verify", "result": { } }
{ "ok": false, "command": "verify", "error": { "category": "input", "message": "cannot read b.yaml: ENOENT", "details": { "file": "b.yaml" } } }
```

`ok` is false for a failed verdict (verify below the requested level, `lint --strict` with findings); such a document has a `result` and no `error`. An operational failure has an `error` and no `result`.

| Category | Exit | Meaning |
| --- | --- | --- |
| (none, failed verdict) | 1 | `verify` did not reach the requested level, or `lint --strict` found a problem |
| `usage` | 2 | unknown command or option, missing or invalid argument, refusing to overwrite an input file |
| `input` | 3 | unreadable or invalid file (including SID files), unwritable output path |
| `validation` | 3 | the score is invalid; `details.path` is the JSON path of the first error |
| `engine_unavailable` | 4 | `libsidplayfp-wasm` is not installed or could not be loaded |
| `limit_exceeded` | 5 | a `--max-*` budget or an engine limit was exceeded |
| `aborted` | 5 | the run was cancelled (SIGINT) |
| `internal` | 70 | an unexpected error |

Operational failures never use exit code 1, so a failed verdict cannot be mistaken for a broken run. Every command is a library function (`compileSidwaveBytes`, `lintSidwave`, `loadTune`, `verifyTunes`, `renderTune`, `traceTune`, `sidInfo`, ...); the command line only translates arguments and output. `classifyError` maps any thrown error to its category.

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
| Entry points | `origin+0` init, `+3` play, `+6` stop, `+9` sfx. Each is a three byte jump. `sfx` is a one byte `rts` stub unless the score defines `effects` (SIDWave 1.4), when it is a jump to the effect entry; the table never changes its layout. |
| `init` input | `A` = song index, 0-based. A score without `songs` has only song 0 and ignores other values; with `songs` (SIDWave 1.4), an index beyond the last song plays song 0 (see [Songs](#songs-sidwave-14)). `X` = clock: 0 PAL, 1 NTSC (any other value counts as NTSC), `$FF` reads the KERNAL flag at `$02A6` (nonzero on PAL); do not place the player over `$02A6` if you pass `$FF` (the build warns). `init` silences the SID registers and resets the song. |
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

The symbol files export `sidwave_init`, `sidwave_play`, `sidwave_stop`, `sidwave_sfx`, `sidwave_ram`, `sidwave_ram_end`, `sidwave_data` and `sidwave_data_end` (with `--data-origin`), `sidwave_zp_ptr`, `sidwave_zp_sid_io` (several SIDs), `sidwave_play_calls_per_frame` and, with songs, `sidwave_songs`. The ACME, KickAssembler and ca65 files also carry the contract as comments.

### Songs (SIDWave 1.4)

A score can hold several songs that share one player, one instrument table and the same patterns and named sections. Each song has its own `timeline` and may set `loop`, `tempo` and `speed`. [`game_songs.yaml`](data/sound/examples/game_songs.yaml) has a title tune, an in-game loop and a game-over jingle:

```yaml
sidwave: 1.4
# instruments, voices and sections as in any score
songs:
  - { name: title, timeline: [intro, verse, bridge, verse] }
  - { name: ingame, tempo: 140, loop: drive, timeline: [intro, drive, rise, drive, bridge] }  # repeats from "drive"
  - { name: gameover, tempo: 90, loop: false, timeline: [fallen, { bars: 2, layers: { v3: low } }] }  # plays once
```

The three songs compile to 3188 bytes as one player, against 6485 bytes as three separate PRGs. The game build starts a song when you call `sidwave_init` with its index in `A` (`lda #1 : ldx #0 : jsr sidwave_init`); `init` resets the player, so any song can start at any time. A song with `loop: false` stops writing registers when it ends. `contract.songs` lists the play calls per frame, the loop behaviour and the length of every song, and the cycles are measured for each song. A PRG plays song 0 (or the song given as the `song` option of `compileSidwaveToPrg`); a PSID records the song count and takes the song in `A` as the PSID format defines. At most 32 songs, and songs times voice channels (3 per SID) at most 255. The language rules are in [`sidwave.md`](data/sound/sidwave.md#sidwave-14).

### Sound effects (SIDWave 1.4)

A score can define sound effects that the game starts at run time, over the music. An effect is a short list of steps (frequency, waveform, pulse width, envelope, gate, filter routing and the number of play calls each step lasts) with a priority from 0 to 15 and the voices of the first SID it may use. While an effect owns a voice, the music keeps running but writes that voice into a shadow instead of the SID; when the effect ends, the shadow goes to the SID in the same play call and the music continues where it is. [`raster_bars.yaml`](examples/game/raster_bars.yaml) has one effect:

```yaml
effects:
  pew:
    priority: 8
    voices: [3]
    steps:
      - { freq: 2400, wave: pulse, pulse: 0.25, adsr: [0, 0, 15, 6] }
      - { freq: 1800 }
      - { freq: 1300 }
      - { freq: 900 }
      - { freq: 600 }
      - { gate: false, wait: 3 }
```

The entry `sfx` (`origin+9`) takes the effect index in `A` (the position in the mapping; the symbol file defines `sidwave_fx_<name>`) and the voice in `Y` (1 to 3, or `$FF` for any voice the effect allows). It returns carry clear when the effect started and carry set when it was rejected: no free voice or only voices that play an effect of equal or higher priority, a voice the effect does not allow, an unknown effect, or a play-once song that has ended. The effect begins with the next `play` call. A voice that no effect plays is free; otherwise the lowest-priority effect below the new one is replaced, and the same effect restarts on its own voice. `sfx` disables interrupts while it runs and restores the interrupt flag, so the main program may call it while a raster interrupt calls `play`.

```asm
        lda #sidwave_fx_pew              ; effect index
        ldy #$ff                         ; any allowed voice
        jsr sidwave_sfx                  ; carry clear: started
```

In a PRG the entry is `$0816`: `POKE 780,0: POKE 782,255: SYS 2070` from BASIC, `lda #0 : ldy #$ff : jsr $0816` from machine code. A PSID has the same entry but no standard way to call it. Costs: 604 bytes of engine, 4 bytes per effect and 11 per step; up to about 790 more cycles in a play call with three effects stepping at once (the game build's `cycles.withEffects` measures it). Limits: 32 effects of 255 steps, 1 to 3 voices of the first SID, no centred voices. The rules, the allocation order, the measurements and the tests are in [`sidwave.md`](data/sound/sidwave.md#effects).

### Example game programs

[`examples/game`](examples/game) has two small games-in-miniature. Each is a SIDWave score with effects (`.yaml`) and a 6502 program (`.asm`) that the build script assembles with 6502-toolkit behind the player into one PRG:

| Program | What it does |
| --- | --- |
| `raster_bars` | A raster interrupt plays the music, starts the effect `pew` on voice 3 when the fire button of joystick port 2 goes down, and draws 64 lines of scrolling raster bars. |
| `sprite_bounce` | A sprite moves across the screen (joystick port 2 steers it) and bounces off the edges. The effect `bounce` plays on a hit at the left or right edge and `thud` on a hit at the top or bottom edge; a corner hit plays both. |

```sh
npm run build
npm run examples:game          # writes examples/game/out/raster_bars.prg and sprite_bounce.prg
x64sc -autostart examples/game/out/raster_bars.prg
```

The build compiles the score at the first page behind the program, passes the ACME symbol file to the assembler as `music.acme`, and assembles the program twice because its size does not depend on the player's address but the symbol values do. The tests (`test/sidwaveGameDemos.test.mjs`) run both programs on the bundled emulator for 600 and 900 frames with scripted joystick input in `$DC00` and a raster position that follows the cycle count: the effect starts in the frame after the press or the hit, the voices that no effect owns write exactly what the plain score writes, the voice gets its music back, the bars and the sprite registers match a model, and the cycles of one frame stay below the PAL budget of 63 x 312 = 19656 cycles. In the frame where player and program together take the most, `raster_bars` spends 2341 cycles in the player, 2419 in its own code and 4304 in the loop that waits for the raster lines of the bars (9064 in all). Without the wait loop it leaves 19656 - 2341 - 2419 = 14896 cycles of every frame for a game; `sprite_bounce` takes 2026 for the player and 174 for its own code, and leaves 17456.

## What you get

- The player as a library for games and demos: any origin, separate data, symbol files and a documented contract (see [Using the player in a game](#using-the-player-in-a-game)).
- Language versions 1.0 to 1.4: songs and sound effects (1.4), wave, pulse and filter tables, hard restart, sync and ring, echo, unison, follower voices, multispeed, sections, up to 10 SIDs and 30 voices in a PRG (PSID: up to 3 SIDs), CIA2 volume digis in a PRG.
- Lint checks and error messages that name the failing path in the score.
- 15 example scores in [`data/sound/examples`](data/sound/examples).

Planned and not yet available: reconstruction of SID tunes into scores, MIDI/MusicXML/tracker import.

## Formatting, diff and merge

`sidwave/format` rewrites a score in a canonical layout, compares two scores by meaning, and merges two edits of one base score. These are library functions only; there is no command line for them yet.

- `formatSidwave(text)` sorts the keys of the document, voices, patterns, instruments, sections and notes into the order of the language specification, writes strings with double quotes, writes short lists of scalars (at most 6 items and 72 characters) on one line, and keeps comments. A comment block that is followed by a blank line before the first key stays at the top of the file. Formatting a formatted score returns it unchanged. It throws the YAML error for text that is not YAML.
- `diffSidwave(a, b)` returns `{ changes, compiledEqual }`. Each change has a JSON-pointer-like `path`, the `before` and `after` values, and a class: `musical` (notes, tempo, timeline, sections), `synthesis` (instruments, waveforms, ADSR, filters, effects), `hardware` (SIDs, chip model, clock mode) or `structural` (everything else). Text that differs only in layout gives one `formatting` change. `compiledEqual` is true when both scores compile to the same PRG.
- `mergeSidwave(base, ours, theirs)` merges the maps of the three scores key by key, and lists of equal length entry by entry. When both sides change the same value differently, or one side deletes a value that the other changes, it returns `{ conflicts }` and no merged text. Otherwise it returns `{ merged, conflicts: [] }`, where `merged` is canonical text that has been parsed as a valid score. The changes are applied to the YAML document of `ours`, so its comments, anchors, aliases and flow style stay where the merge did not change a value; comments that belong to a value changed by the merge are lost. If an edit cannot be applied in place (for example below an alias), the whole result is written from the merged data, which drops all comments and expands aliases. The result then has `preserved: false` and a `warnings` entry that gives the reason; otherwise `preserved` is `true`. Check `preserved` before you replace a commented file with `merged`.

```ts
import { formatSidwave, diffSidwave, mergeSidwave } from "sidwave/format";

const base = formatSidwave(`title: Demo
sidwave: 1.2
tempo: 120
voices:
  - id: 1
    patterns:
      A: { groove: "C4 ~ ~ ~", length: 1 }
timeline: [{ bars: 1, layers: { v1: A } }]
`);
// sidwave: 1.2, title: "Demo", tempo: 120, ... (keys in specification order)

const ours = base.replace("Demo", "Demo tune");
const theirs = base.replace("C4", "D4");

diffSidwave(base, theirs).changes;
// [{ class: "musical", path: "/voices/0/patterns/A/groove", before: "C4 ~ ~ ~", after: "D4 ~ ~ ~", summary: "/voices/0/patterns/A/groove changed" }]

mergeSidwave(base, ours, theirs).merged; // title "Demo tune" and groove "D4 ~ ~ ~"
mergeSidwave(base, base.replace("C4", "E4"), theirs).conflicts;
// [{ path: "/voices/0/patterns/A/groove", base: "C4 ~ ~ ~", ours: "E4 ~ ~ ~", theirs: "D4 ~ ~ ~", summary: "Concurrent edits at /voices/0/patterns/A/groove" }]
```

## Transformations

`sidwave/transform` changes a score and returns `{ text, report }`. The text is canonical (see above). `report.changed` lists the paths that were edited, `report.preserved` names what the operation keeps, and `report.warnings` names the parts it left alone. Every transformation first checks that its input is a valid score, then parses and compiles its result. A transformation never returns a score that does not parse or compile: it throws `SidwaveTransformError` instead. The `code` is `input` (the text is not a valid score), `precondition` (an argument or the result is not acceptable, with the parser or compiler message), `out_of_range` or `unsupported`. Pass `validate: "parse"` to check only parsing, or `validate: "none"` to skip the checks for a fragment that is not a complete score.

| Function | Effect |
| --- | --- |
| `transpose(text, { semitones, scope? })` | Shifts notes, slides, bends, chord symbols and motifs. Drum voices and `kitNote` entries stay. Notes (and the wavetable offsets built on them) must stay in the playable SID range of the score's clock, otherwise `precondition`. `scope` selects voices (by id or name) and sections. A section scope is refused when a selected pattern is also played by another section. A note with an accidental keeps its style (flat stays flat); other notes follow the style the score uses more often. `semitones: 0` returns the input text. |
| `setTempo(text, { bpm })`, `scaleTempo(text, { factor })` | Set or multiply the tempo (30 to 220 BPM). Notes stay the same. A tempo at which a note becomes shorter than the player allows makes the result invalid, and the call throws `precondition`. |
| `substituteInstrument(text, { from, to })` | Replaces `instrument` and `inst` references. `to` is a defined instrument or a `lib:` recipe. |
| `quantise(text, { grid })` | Rounds explicit `len` values to the grid. Each bar group keeps its length. |
| `restructure(text, { order })` | Sets the timeline to the named sections or entries in the given order. Existing entries keep their modifiers and overrides. The same order returns the input text. |
| `humanise(text, { seed, maxShift })` | Varies explicit `len` values by up to `maxShift` beats with a seeded generator, in pairs inside a bar group. The same seed gives the same text. |

```ts
import { transpose, setTempo } from "sidwave/transform";

const up = transpose(base, { semitones: 2 });
up.report.changed; // ["/voices/0/patterns/A/groove"]
// the groove "C4 ~ ~ ~" is now "D4 ~ ~ ~"

setTempo(up.text, { bpm: 90 }).report.changed; // ["/tempo"]
```

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
- A1: a calibrated comparison of reSIDfp PCM, for tunes whose register writes differ but may still sound the same. See below.
- A trace with no writes inside the horizon fails T0 and T1 with category `empty_trace`.
- The clock is taken from the PSID header of the reference tune unless `clock` is given. Every difference carries `cycle` and `timeSeconds` on that clock.

### A1: calibrated audio comparison

A1 compares two 48 kHz mono reSIDfp renders (with the pinned engine and ROMs) in windows of 1024 samples (hop 512, Hann), using 48 log-spaced band energies from 40 Hz to 16 kHz and the window level. After one global alignment of at most +-24 ms (a larger shift is a timing defect and fails), a window is bad when the mean band difference exceeds `thetaSpec` dB, the level difference exceeds `thetaLevel` dB, or only one of the two is above the -60 dBFS floor by more than `sGap` dB. The tune fails when `k` consecutive windows or `m` windows within 2 s are bad. A render that ends before the horizon counts its missing windows as bad. The result reports the lag, the number of bad windows, the first failing time and its class, the horizon and the SHA-256 of the rule file.

```ts
import { createLibsidplayfpEngine } from "sidwave/engine";
import { verifySid, loadA1Rules } from "sidwave/verify";
const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const residfp = createLibsidplayfpEngine({ emulation: "residfp" });
const result = await verifySid(reference, candidate, { engine, seconds: 60, a1: { engine: residfp, rules: loadA1Rules() } });
// result.levels.A1 is "pass", "fail" or "not evaluated"; result.a1.reason says why it was not evaluated.
```

**Status: approximate.** On the held-out tunes the frozen rules accepted 15 of 98 material defects (false accepts 15.3 %, 95 % interval 9.5-23.7 %) and rejected 4 of 18 benign changes (false rejects 22.2 %, 9.0-45.2 %; all four are 3-cent detunes). The bound for "verified within declared bounds" is 5 % for both, so A1 stays "approximate": a pass means the audio is plausibly the same, not that it is proven. Pitch-only changes (waveform swaps, small timing shifts, pulse width, filter cutoff) are the weakest area. `result.a1.status` carries the status, the CLI prints it, and [`data/verify/a1-heldout-report.json`](data/verify/a1-heldout-report.json) lists the per-class rates and every misclassified case.

**Limits of the calibration.** The error rates are less reliable than their intervals suggest. Most benign controls were vacuous: the identical recompile read the same cached PCM, and the instrument-rename and duplicate-pattern refactors compile to identical SIDs and were skipped, so the effective benign set was 7 identical, 7 one-sample-delay and 4 detune items. The false-reject rate says little about how often A1 rejects equivalent tunes. Two benign classes of the design (inaudible voice volume, register reordering) were not implemented, and bases that do not compile to a PSID (`digi_groove`, `wall_of_sid`, and `ultisid_orchestra` in the held-out set) were excluded. [`data/verify/a1-limitations.md`](data/verify/a1-limitations.md) lists these and the requirements for a second version (independently rendered benign controls that differ in their SID bytes).

When the rule file pins ROM hashes, A1 hashes the ROMs it is given (`--roms <dir>` on the command line) and reports "not evaluated" with the reason if they are missing or differ.

The thresholds come from `data/verify/a1-rules.json`, which `scripts/calibrate-a1.mjs` writes after a grid search over score-level mutations (wrong, missing and extra notes, octave errors, detuning, timing, envelope, waveform, pulse width, filter, sync and ring, percussion, sections) and benign refactors. See the rule file for the corpus, the split between development and held-out tunes, and the measured error rates.

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
