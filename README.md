# SIDWave

Write Commodore 64 SID music as text. Compile it to a C64 program or a SID file.

[![CI](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml)
[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg)](https://codecov.io/gh/chrisgleissner/sidwave)
[![sidwave licence: GPL-2.0-or-later with the SIDWave Player Exception](https://img.shields.io/badge/sidwave-GPL--2.0--or--later%20with%20Player%20Exception-blue.svg)](sidwave/LICENSE-EXCEPTION.md)
[![6502-toolkit licence: MIT](https://img.shields.io/badge/6502--toolkit-MIT-blue.svg)](6502-toolkit/LICENSE)
[![sidwave on npm](https://img.shields.io/npm/v/sidwave?label=sidwave)](https://www.npmjs.com/package/sidwave)
[![6502-toolkit on npm](https://img.shields.io/npm/v/6502-toolkit?label=6502-toolkit)](https://www.npmjs.com/package/6502-toolkit)
[![Tested on Linux](https://img.shields.io/badge/CI-Linux-forestgreen)](#status-and-limitations)

SIDWave is a music language, compiler and toolkit for the SID sound chip of the Commodore 64. A score is a YAML or JSON file that describes instruments, patterns and a timeline of sections.

The compiler turns a score into a self-playing C64 program (PRG) or a PSID file. Both include the 6502 player code that runs on the C64. The compiler runs offline and needs no C64.

SIDWave is for chip musicians who prefer a text editor and version control to a tracker, for game and demo developers who need a small, scriptable music pipeline, and for tool authors who want a documented, testable description of SID music.

## Choose your path

| I want to... | Start here | What SIDWave provides |
| --- | --- | --- |
| **Compose a tune** (musician) | [For musicians](#for-musicians) | A text score format, 15 example scores and an [eight-lesson tutorial](sidwave/doc/tutorial.md), lint checks that explain problems, and a JSON Schema for editor completion. |
| **Compile and play a tune** on a C64 or an emulator | [Install and first tune](#install-and-first-tune), then [Play](#3-play) | A PRG that starts with `SYS 2061`, or a PSID file for SID players. The program detects PAL or NTSC. |
| **Embed the player in a game or demo** | [Using the player in a game](#using-the-player-in-a-game) | The player at an address you choose, symbol files or an assembler include, a page relocation table, several songs and sound effects. |
| **Convert music between formats** | [Converting and analysing](#converting-and-analysing) | `sidwave convert` between scores, MIDI, MusicXML and several tracker formats, with a list of what each conversion loses. |
| **Use the library or CLI from code** | [For developers](#for-developers) | `parseSidwave`, `compileSidwaveToPrg`, `compileSidwaveToSid`, further subpath exports, and the `sidwave` command with exit codes and JSON output. |
| **Use the 6502 toolkit on its own** | [6502-toolkit](6502-toolkit/README.md) | A 6502 assembler and disassembler with all 256 NMOS opcodes, PETSCII, I/O range and PRG helpers. MIT licence. |
| **Contribute** | [Repository layout](#repository-layout) and [Status and limitations](#status-and-limitations) | A workspace with two packages, tests that run the compiled player on a bundled 6502 emulator, and a list of known limitations. |

## A short score

This is the opening of Beethoven's *Für Elise* for three triangle voices. It is a complete, valid SIDWave 1.3 score. It compiles to a 1.8 KB PRG and plays for about 11.5 seconds before it loops.

```yaml
sidwave: 1.3
title: "Für Elise (opening)"
author: "Ludwig van Beethoven"
tempo: 83.54
mode: PAL
voices:
  - id: 1
    name: Lead
    waveform: triangle
    adsr: [1, 4, 9, 4]
    patterns:
      theme:
        groove: [E5, D#5, E5, D#5, E5, B4, D5, C5, A4, "-", A3, C4, E4, "-", A4, B4]
  - id: 2
    name: Harmony
    waveform: triangle
    adsr: [2, 5, 8, 5]
    patterns:
      accomp:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", A2, E3, A3, E3, A2, E3, A3, E3]
  - id: 3
    name: Bass
    waveform: triangle
    adsr: [1, 3, 10, 5]
    patterns:
      bass:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", A1, "-", "-", "-", A1, "-", "-", "-"]
timeline:
  - section: Theme
    bars: 4
    layers: { v1: theme, v2: accomp, v3: bass }
```

Each voice has an instrument (waveform and ADSR envelope) and named patterns. A `groove` pattern lists one note per entry. `-` is a rest and `~` ties to the previous note. The `timeline` plays sections in order and chooses a pattern per voice. The song loops after the last section. Real scores add instruments with wave, pulse and filter tables, vibrato, echo, several SIDs and more. The [examples](#examples) show a full piece.

## What it compiles to

| Output | Contents | Limits |
| --- | --- | --- |
| **PRG** | A program loaded at `$0801` and started with `SYS 2061`. It detects PAL or NTSC, programs CIA 1 timer A for the song's play rate, installs an IRQ handler and returns to BASIC while the music plays. | Up to 10 SIDs and 30 voices. Must end below `$D000`. CIA2 volume digis (sampled sound) are available here. |
| **PSID** | A PSID v2, v3 or v4 file with the same player (init `$0810`, play `$0813`) for SID players. | Up to 3 SIDs. No CIA2 digis. |

Language features (SIDWave 1.0 to 1.5; a score declares its version, and byte-hash tests pin the output of older versions):

- Wave, pulse and filter tables per instrument; hard restart; sync and ring modulation.
- Vibrato (with delay and fade-in), slide, portamento, legato, chord arpeggios, pitch bends.
- Echo, unison and follower voices.
- Multispeed (1 to 4 player calls per frame), a metre per section, sections, sequences and dynamics.
- Several SIDs with model, pan and filter ownership per chip; CIA2 volume digis (PRG only).
- Several songs in one score that share one player, sound effects that play over the music, and asset libraries of instruments, patterns and effects (1.4).
- Player start options, exact note registers, a per-call table for the filter and volume registers, and speeds up to 8 (1.5).
- Lint checks that report problems such as notes shorter than the hard-restart minimum or a tempo that does not fit the frame grid.

The compiler measures the player's cost and reports it. `worstCaseCyclesPerCall` in the compile result is a conservative cycle estimate. Typical songs use roughly 20 to 65 raster lines per frame. The full definition is in the [language specification](sidwave/data/sound/sidwave.md).

## Install and first tune

SIDWave needs Node.js 20.19 or later.

```sh
npm install sidwave
npx sidwave examples chiptune_drive -o . && npx sidwave compile chiptune_drive.yaml
```

The last command writes `chiptune_drive.yaml` and `chiptune_drive.prg` into the current directory. The PRG is about 22 KB (22,205 bytes) and plays for about 2.5 minutes (154.5 s). The compiler also prints the warning `LEVEL-NOOP`. This is expected: it means that a level or volume change on a note has no effect because the instrument has sustain 0, so use chip volume or a kit variant for those sounds. Open the PRG with `x64sc chiptune_drive.prg`, or add `--format sid` to the compile command and play the SID file with `sidplayfp chiptune_drive.sid`.

Rendering, tracing, verification, reconstruction and playback through your system's audio player also need the optional package `libsidplayfp-wasm`:

```sh
npm install libsidplayfp-wasm
npx -p sidwave -p libsidplayfp-wasm sidwave render chiptune_drive.yaml    # without installing either
```

The rest of this README writes `sidwave` for the command. In a project where the package is installed, run it as `npx sidwave`. In a checkout of this repository, run `npm ci && npm run build` first; `npx sidwave` then runs the local build.

## For musicians

### 1. Write a score

Save a score as `song.sidwave.yaml`. A JSON Schema is shipped for editor completion and validation; see [Authoring and validation](sidwave/data/sound/sidwave.md#authoring-and-validation). Start from one of the [examples](#examples) and change it.

### 2. Check and compile

```sh
sidwave validate song.sidwave.yaml
sidwave lint song.sidwave.yaml
sidwave compile song.sidwave.yaml
```

`validate` exits 0 for a valid score. Otherwise it exits 3 and prints the path of the first error. `compile` writes `song.prg` (or `song.sid` with `--format sid`) into the current directory; `-o <file>` chooses another name. `lint` prints the findings. `sidwave examples` lists the bundled scores. The list of commands is in the [package README](sidwave/README.md#command-line); `sidwave --help` describes the options. `sidwave format`, `diff`, `merge`, `transform`, `generate` and `complete` help with writing and versioning scores ([authoring commands](sidwave/doc/authoring.md)).

### 3. Play

```sh
sidwave play song.sidwave.yaml                  # through the audio player of your system
sidwave watch song.sidwave.yaml                 # restart on every save, errors with line and column
sidwave play song.sidwave.yaml --target vice    # through VICE
```

`play` and `watch` are described in the [package README](sidwave/README.md#playing-and-watching). To use the compiled files elsewhere:

- **VICE**: open the PRG with `x64sc song.prg` (autostart), or attach it from the emulator's menu. VICE needs a normal C64 setup with ROMs.
- **sidplayfp**: play the PSID, for example `sidplayfp song.sid`. sidplayfp emulates the SID and CPU only, not the C64's analogue audio path, so it sounds close to a real machine but not identical.
- **Real hardware**: copy the PRG to a disk image, SD card or other storage the machine can read, then `LOAD` and `RUN` it. On an Ultimate 64 or C64 Ultimate you can also run the PRG from the file browser or through c64bridge. Pitch and tempo are correct on PAL and NTSC machines because the PRG detects the video standard.

### Examples

The package ships 15 example scores in [`sidwave/data/sound/examples`](sidwave/data/sound/examples). `sidwave examples <name> -o <dir>` writes one out. Their headers describe technique and form. A few starting points:

| Score | Shows |
| --- | --- |
| `chiptune_drive`, `ambient_filter`, `funk_bass` | Typical single-SID styles. |
| `acid_line` | Filter accents. |
| `arp_ballad` | Chord arpeggios and pulse-width modulation. |
| `drum_and_bass` | Multispeed breakbeats. |
| `digi_groove` | CIA2 volume samples (PRG only). |
| `metal_sync` | Sync, ring modulation and pitch bends. |
| `chamber_waltz` | 3/4 time and counterpoint. |
| `title_fanfare` | Two SIDs, filtered brass, a held cadence. |
| `game_songs` | Three songs in one player. |
| `ultisid_orchestra`, `wall_of_sid` | 24 and 27 voices on several SIDs. |

## For developers

### Package

The package `sidwave` has two runtime dependencies: `yaml` and [`6502-toolkit`](6502-toolkit/README.md), the 6502 assembler and disassembler that builds the player. `libsidplayfp-wasm` is an optional peer dependency for the features that emulate the SID.

### Library

The public API is not frozen; names may change before 1.0. These functions cover the core path.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";

const doc = parseSidwave(readFileSync("song.sidwave.yaml", "utf8")); // throws SidwaveValidationError
const result = compileSidwaveToPrg(doc);  // prg, addresses, duration, lint findings, warnings, cycle estimate
const { sid } = compileSidwaveToSid(doc, result.prg); // PSID built around the PRG's player

writeFileSync("song.prg", result.prg);
writeFileSync("song.sid", sid);
```

`parseSidwave` rejects unknown fields, unknown pattern names and out-of-range values with an error that names the path in the score. The compile result also carries `entryAddress`, `initAddress`, `playAddress`, `loadAddress`, `endAddress`, `totalFrames`, `framesPerSecond`, `durationSeconds`, `worstCaseCyclesPerCall`, `basicFreeBytes`, `warnings` and, when there are findings to report, `lint`. The package has further entry points, for example `sidwave/sid-file`, `sidwave/engine`, `sidwave/verify`, `sidwave/format`, `sidwave/transform`, `sidwave/export`, `sidwave/reconstruct` and `sidwave/play`. The `exports` field of [`package.json`](sidwave/package.json) lists all of them, and the [package README](sidwave/README.md) describes the main ones.

### Command line

| Task | Commands |
| --- | --- |
| Compile and check | `validate`, `compile`, `lint`, `examples` |
| Write and version scores | `format`, `diff`, `merge`, `transform`, `generate`, `complete`, `retarget`, `lock`, `bundle` |
| Play | `play`, `watch` |
| Convert | `convert`, `formats`, `info`, `import`, `export` |
| Render, trace and compare | `render`, `trace`, `verify`, `compare` |
| Study SID tunes | `reconstruct`, `analyze`, `isolate`, `preserve`, `extract-instruments` |
| HVSC data | `sid info`, `sid edit`, `sid player`, `songlengths`, `stil` |

The [package README](sidwave/README.md#command-line) has the synopsis of each command and the exit codes.

### Using the player in a game

`sidwave compile --target game --origin <addr>` assembles the player at the address you choose, without a BASIC stub, interrupt handler or KERNAL use. Your program calls `init`, `play`, `stop` and `sfx`. The build can write symbol files for 64tass, ACME, KickAssembler, ca65 and VICE or one assembler include (`--format asm`), can place the data separately, can write a page relocation table (`--reloc`), and can fail when a play call exceeds a cycle limit (`--max-cycles`). SIDWave 1.4 adds several songs and sound effects. CIA2 digis are not available in a game build. See [the package README](sidwave/README.md#using-the-player-in-a-game) for the call contract.

The PRG output is different: it is a standalone program at `$0801` that takes over the CIA 1 timer IRQ, uses zero-page bytes `$FB/$FC` (restored after each call; more with several SIDs) and ends below `$D000`. Its PSID has init at `$0810` and play at `$0813`.

### Converting and analysing

```sh
sidwave convert song.sng song.mid        # GoatTracker to MIDI
sidwave convert tune.mid tune.sid        # MIDI to a playable SID file
sidwave formats                          # what can be read and written
```

| Direction | Formats |
| --- | --- |
| Read and write | SIDWave score, MIDI, MusicXML (uncompressed input only), GoatTracker, Furnace, CheeseCutter 2.x, SID Factory II (driver 11), SID-Wizard |
| Read only | ABC, ProTracker MOD, JCH NewPlayer 20.G, siddump table |
| Write only | PRG, WAV, event list (JSON), Commodore BASIC V2 program |
| PSID or RSID tune, VICE register dump | Read through reconstruction (approximate). A score can be written as PSID or as a VICE dump. |

Writing CheeseCutter or SID Factory II files needs a driver file that you supply (`--driver`). Most conversions lose something; the command lists each loss. The mappings and measurements are in [interchange formats](sidwave/doc/interchange.md).

`sidwave reconstruct` recovers an editable score from a SID tune and compares its register trace with the original. `analyze`, `compare`, `isolate`, `extract-instruments` and `preserve` are described in [analysis](sidwave/doc/analysis.md) and [preservation bundles](sidwave/doc/preservation.md). The SID file and HVSC tools are described in [HVSC tools](sidwave/doc/hvsc.md).

### Rendering and verification

`sidwave render`, `trace`, `verify` and local playback use the `libsidplayfp-wasm` engine. `verify` compares two tunes on four levels: identical register writes per player call (T0), writes within a cycle tolerance (T1), identical SIDLite audio (A0) and a calibrated audio comparison (A1, approximate). CIA2 digi scores have no PSID form, so `render`, `trace` and `verify` refuse them; `sidwave play --target vice` plays them through VICE. The library entry point `sidwave/reference` renders through an external `sidplayfp` binary instead.

### Build and test

```sh
npm ci
npm run build
npm test
npm run test:bun
```

`npm test` runs the Node test runner in both packages. `npm run test:bun` runs the same tests with Bun. Tests that need an external tool or local data, such as `sidplayfp`, an assembler or HVSC, are skipped when it is not available.

### Releases

Each package is released separately by pushing a tag. The tag is `<package>@<version>` and the version must equal `version` in that package's `package.json`. The tagged commit must be on `main`. `sidwave` depends on `6502-toolkit`, so tag `6502-toolkit` first and wait until that version is on npm:

```sh
git tag 6502-toolkit@0.9.0
git push origin 6502-toolkit@0.9.0
# after the release workflow has succeeded and `npm view 6502-toolkit@0.9.0 version` prints the version
git tag sidwave@0.9.0
git push origin sidwave@0.9.0
```

`.github/workflows/release.yaml` runs only for these tags. It builds, runs the Node and Bun tests and the consumer checks, and publishes the package with `npm publish --provenance --access public`, using the repository secret `NPM_TOKEN`. Pushes to branches and pull requests do not start it. Before tagging, move the "Unreleased" changelog entries under the new version.

## Repository layout

| Path | Contents |
| --- | --- |
| `sidwave/` | npm package `sidwave`: language, parser, lint, compiler, generator, examples and the `sidwave` command. GPL-2.0-or-later with the player exception. |
| `6502-toolkit/` | npm package `6502-toolkit`: 6502 assembler, disassembler, opcode table, PETSCII, I/O range and PRG helpers. MIT. |
| `doc/` | Repository-level documentation. See [repository structure](doc/repository-structure.md). |
| `scripts/` | Per-package coverage gate, the clean-consumer, consumer type and fresh-clone checks, and the performance, calibration, composer evaluation and reconstruction corpus scripts. |

## Status and limitations

Version 0.9.0 is the first npm release of both packages. Before 1.0.0, a minor version may contain breaking changes. The [changelog of `sidwave`](sidwave/CHANGELOG.md) and the [changelog of `6502-toolkit`](6502-toolkit/CHANGELOG.md) list the contents.

SIDWave was extracted from [c64bridge](https://github.com/chrisgleissner/c64bridge).

**Reconstruction and verification**

- Reconstruction of SID tunes is approximate. 0 of 24 development tunes are reproduced exactly. In the committed [development report](sidwave/data/reconstruct/dev-report.md), 3 of the recovered scores need `cpu: turbo`, and every tune was compared over its first 10 seconds only, because none matched in that window. Held-out tunes have not been run.
- The A1 audio comparison is approximate. On held-out tunes it accepted 15.3 % of material defects and rejected 22.2 % of benign changes ([limitations](sidwave/data/verify/a1-limitations.md)).

**Conversion**

- SID Factory II support covers driver 11 only, and playback fidelity is partial. Over the 54 example songs, the median note agreement with the original driver is 0.709 for import and 0.756 for export.
- JCH NewPlayer 20.G import is approximate: the filter and most commands are not imported.
- CheeseCutter stereo songs are not supported. CheeseCutter and SID Factory II export need a driver file that you supply.
- The Furnace export has not been loaded by Furnace itself.

**Playback and development tools**

- `sidwave play --target u64` has not been tested on hardware.
- The local playback target handles at most 3 SIDs and no digi samples.
- The KickAssembler include is not verified: the test that assembles it needs a KickAssembler installation and is skipped in CI.
- CI runs on Linux only. macOS and Windows are not tested.

**Language**

- There is no per-note velocity and no arbitrary memory or register writes. SIDWave 1.5 writes a limited set of SID registers directly.
- PSID output supports at most 3 SIDs and no CIA2 digis.
- No human listening sign-off exists for the examples, and some hardware comparisons are open (for example `stereo_echo`).

## Documentation

- [Language specification](sidwave/data/sound/sidwave.md) and [JSON Schema](sidwave/data/sound/sidwave.schema.json)
- [Package README](sidwave/README.md) with the command-line reference
- [Tutorial](sidwave/doc/tutorial.md), [authoring commands](sidwave/doc/authoring.md), [interchange formats](sidwave/doc/interchange.md), [analysis](sidwave/doc/analysis.md), [preservation bundles](sidwave/doc/preservation.md), [HVSC tools](sidwave/doc/hvsc.md) and [performance](sidwave/doc/performance.md)
- [Licensing notes](sidwave/doc/licensing.md), including what the generated player means for released tunes and games
- [Repository structure](doc/repository-structure.md)
- [Changelog](CHANGELOG.md)

## Related projects

- [c64bridge](https://github.com/chrisgleissner/c64bridge) is an MCP server that connects coding agents to VICE and Ultimate hardware. It is an optional integration that writes, compiles and plays SIDWave scores on VICE or a device. SIDWave does not need it.
- [SIDFlow](https://github.com/chrisgleissner/sidflow) analyses SID collections and streams similar tunes. It is a separate project. The scripts that select the reconstruction corpus can read its published analysis data.
- [6502-toolkit](6502-toolkit/README.md) is the assembler and disassembler in this repository. It was extracted from c64bridge.

## License

The `sidwave/` package and everything outside `6502-toolkit/` is licensed under GPL-2.0-or-later with the [SIDWave Player Exception](sidwave/LICENSE-EXCEPTION.md). The exception allows compiled tunes, and games that embed the generated player, to be released under any terms. Read the [licensing notes](sidwave/doc/licensing.md). The `6502-toolkit/` package is licensed under the MIT licence. See [LICENSES.md](LICENSES.md), [COPYING](COPYING) (GPL-2.0 text), [the exception](sidwave/LICENSE-EXCEPTION.md) and [the MIT licence](6502-toolkit/LICENSE).
