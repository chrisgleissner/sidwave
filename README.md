# SIDWave

Write Commodore 64 SID music as text. Compile it to a C64 program or a SID file.

[![CI](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/chrisgleissner/sidwave/actions/workflows/ci.yaml)
[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg)](https://codecov.io/gh/chrisgleissner/sidwave)
[![sidwave license: GPL-2.0-or-later + player exception](https://img.shields.io/badge/sidwave-GPL--2.0--or--later%20%2B%20player%20exception-blue.svg)](sidwave/LICENSE-EXCEPTION.md)
[![6502-toolkit license: MIT](https://img.shields.io/badge/6502--toolkit-MIT-blue.svg)](6502-toolkit/LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](#status-and-roadmap)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-forestgreen)](#for-developers)

SIDWave is a music language, compiler and toolkit for the SID sound chip of the Commodore 64. A score is a YAML or JSON file that describes instruments, patterns and a timeline of sections.

The compiler turns a score into a self-playing C64 program (PRG) or a PSID file. Both include the 6502 player code that runs on the C64. The compiler runs without a network connection, an AI assistant or a C64.

SIDWave is for chip musicians who prefer a text editor and version control to a tracker, for game and demo developers who need a small, scriptable music pipeline, and for tool authors who want a documented, testable description of SID music.

## Choose your path

| I want to... | Start here | What SIDWave provides |
| --- | --- | --- |
| **Compose a tune** (musician) | [For musicians](#for-musicians) | A text score format, 14 example scores, lint checks that explain problems, and a JSON Schema for editor completion. |
| **Compile and play a tune** on a C64 or an emulator | [Install and first tune](#install-and-first-tune), then [Play](#3-play) | A PRG that starts with `SYS 2061`, or a PSID file for SID players. The program detects PAL or NTSC. |
| **Embed the player in a game or demo** | [Using the player in a game](#using-the-player-in-a-game) | Today: a standalone player at `$0801`. A relocatable player and sound effects are planned. |
| **Use the library or CLI from code** | [For developers](#for-developers) | `parseSidwave`, `compileSidwaveToPrg`, `compileSidwaveToSid`, and the `sidwave` command with exit codes and JSON output. |
| **Use the 6502 toolkit on its own** | [6502-toolkit](6502-toolkit/README.md) | A 6502 assembler and disassembler with all 256 NMOS opcodes, PETSCII, I/O range and PRG helpers. MIT licence. |
| **Contribute** | [Repository layout](#repository-layout) and [Status and roadmap](#status-and-roadmap) | A workspace with two packages, a test suite that runs in a 6502 emulator, and a list of planned work. |

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

Language features, by SIDWave version (1.0 to 1.3; each version compiles older scores to the same bytes):

- Wave, pulse and filter tables per instrument; hard restart; sync and ring modulation.
- Vibrato (with delay and fade-in), slide, portamento, legato, chord arpeggios, pitch bends.
- Echo, unison and follower voices.
- Multispeed (1 to 4 player calls per frame), a metre per section, sections, sequences and dynamics.
- Several SIDs with model, pan and filter ownership per chip; CIA2 volume digis (PRG only).
- Lint checks that report problems such as notes shorter than the hard-restart minimum or a tempo that does not fit the frame grid.

The compiler measures the player's cost and reports it. `worstCaseCyclesPerCall` in the compile result is a conservative cycle estimate. Typical songs use roughly 20 to 65 raster lines per frame. The full definition is in the [language specification](sidwave/data/sound/sidwave.md).

## Install and first tune

SIDWave has not been published to npm. Build it from this repository. It needs Node.js 24 or later.

```sh
git clone https://github.com/chrisgleissner/sidwave.git && cd sidwave
npm ci && npm run build
node sidwave/dist/bin.js examples chiptune_drive -o . && node sidwave/dist/bin.js compile chiptune_drive.yaml
```

The last command writes `chiptune_drive.yaml` and `chiptune_drive.prg` into the repository root. The PRG is about 22 KB (22,205 bytes) and plays for about 2.5 minutes (154.5 s). The compiler also prints the warning `LEVEL-NOOP`. This is expected: it means that a level or volume change on a note has no effect because the instrument has sustain 0, so use chip volume or a kit variant for those sounds. Open the PRG with `x64sc chiptune_drive.prg`, or add `--format sid` to the compile command and play the SID file with `sidplayfp chiptune_drive.sid`.

The rest of this README writes `sidwave` for the command. In a checkout, `sidwave` means `node sidwave/dist/bin.js`, run from the repository root. The `sidwave` command is on the `PATH` only after the package is installed from npm.

## For musicians

### 1. Write a score

Save a score as `song.sidwave.yaml`. A JSON Schema is shipped for editor completion and validation; see [Authoring and validation](sidwave/data/sound/sidwave.md#authoring-and-validation). Start from one of the [examples](#examples) and change it.

### 2. Check and compile

```sh
sidwave validate song.sidwave.yaml
sidwave lint song.sidwave.yaml
sidwave compile song.sidwave.yaml
```

`validate` exits 0 for a valid score. Otherwise it exits 1 and prints the path of the first error. `compile` writes `song.prg` (or `song.sid` with `--format sid`) into the current directory; `-o <file>` chooses another name. `lint` prints the findings. `sidwave examples` lists the bundled scores. The full list of commands and options is in the [package README](sidwave/README.md#command-line).

### 3. Play

- **VICE**: open the PRG with `x64sc song.prg` (autostart), or attach it from the emulator's menu. VICE needs a normal C64 setup with ROMs.
- **sidplayfp**: play the PSID, for example `sidplayfp song.sid`. sidplayfp emulates the SID and CPU only, not the C64's analogue audio path, so it sounds close to a real machine but not identical.
- **Real hardware**: copy the PRG to a disk image, SD card or other storage the machine can read, then `LOAD` and `RUN` it. On an Ultimate 64 or C64 Ultimate you can also run the PRG from the file browser or through c64bridge. Pitch and tempo are correct on PAL and NTSC machines because the PRG detects the video standard.

### Examples

The repository ships 14 example scores in [`sidwave/data/sound/examples`](sidwave/data/sound/examples). `sidwave examples <name> -o <dir>` writes one out. Their headers describe technique and form. A few starting points:

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
| `ultisid_orchestra`, `wall_of_sid` | 24 and 27 voices on several SIDs. |

## For developers

### Package

The package `sidwave` has two runtime dependencies: `yaml` and [`6502-toolkit`](6502-toolkit/README.md), the 6502 assembler and disassembler that builds the player. Once it is published, `npm install sidwave` installs it. Until then, build it from this repository as shown above.

### Library

The public API is not frozen. The functions below exist today and are what the package currently exports for the core path. Other names may change before 1.0.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";

const doc = parseSidwave(readFileSync("song.sidwave.yaml", "utf8")); // throws SidwaveValidationError
const result = compileSidwaveToPrg(doc);  // prg, addresses, duration, lint findings, warnings, cycle estimate
const { sid } = compileSidwaveToSid(doc, result.prg); // PSID built around the PRG's player

writeFileSync("song.prg", result.prg);
writeFileSync("song.sid", sid);
```

`parseSidwave` rejects unknown fields, unknown pattern names and out-of-range values with an error that names the path in the score. The compile result also carries `entryAddress`, `initAddress`, `playAddress`, `loadAddress`, `endAddress`, `totalFrames`, `framesPerSecond`, `durationSeconds`, `worstCaseCyclesPerCall`, `basicFreeBytes`, `warnings` and, when there are findings to report, `lint`. A parser, lint, generator for new scores, and similarity and fidelity analysis also exist inside the code base. Their public names are not final and are not documented here.

### Command line

`sidwave validate | compile | lint | examples`. The [package README](sidwave/README.md#command-line) lists every option and the exit codes.

### Using the player in a game

This is not available yet. Today the compiled player is a standalone program at `$0801`. It takes over the CIA 1 timer IRQ, uses zero-page bytes `$FB/$FC` (restored after each call) and ends below `$D000`. The PSID has init at `$0810` and play at `$0813`. There is no relocatable player, no separate player and data split, and no sound-effect support. A relocatable player and sound effects are planned.

### Rendering and analysis

The existing reference render calls an external `sidplayfp` binary and does not include CIA2 digis. Digi scores are rendered with VICE by a script in c64bridge. A WebAssembly engine (`libsidplayfp-wasm`) is planned as an optional dependency.

### Build and test

```sh
npm ci
npm run build
npm test
npm run test:bun
```

`npm test` runs the Node test runner in both packages. `npm run test:bun` runs the same tests with Bun. Tests that render with `sidplayfp` are skipped when it is not installed.

## Repository layout

| Path | Contents |
| --- | --- |
| `sidwave/` | npm package `sidwave`: language, parser, lint, compiler, generator, examples and the `sidwave` command. GPL-2.0-or-later with the player exception. |
| `6502-toolkit/` | npm package `6502-toolkit`: 6502 assembler, disassembler, opcode table, PETSCII, I/O range and PRG helpers. MIT. |
| `doc/` | Repository-level documentation. See [repository structure](doc/repository-structure.md). |
| `scripts/` | Per-package coverage gate and the clean-consumer check. |

## Status and roadmap

SIDWave is being extracted from [c64bridge](https://github.com/chrisgleissner/c64bridge) into this repository. It is pre-release, and nothing has been published to npm.

**Available now**

- Parser and validator for language versions 1.0 to 1.3, with the specification and JSON Schema.
- Lint with documented finding codes.
- Compiler to PRG and PSID, with an emulator-based test suite and byte-hash tests that pin older language versions.
- Generator for new scores.
- 14 example scores.
- Reference rendering through an external `sidplayfp`.
- Similarity and fidelity analysis of rendered audio.
- A minimal CLI: `sidwave validate | compile | lint | examples`, with exit codes 0 (success), 1 (invalid input or failed verdict) and 2 (usage or operational error).

**Planned, not available**

- SID file reader and writer.
- `sidwave verify`: a verification ladder that compares register traces first and audio second.
- Formatter and diff for scores.
- A relocatable player and sound effects for games.
- Reconstruction of existing SID tunes into editable scores.
- Import from MIDI, MusicXML and tracker formats (GoatTracker, Furnace).
- Preservation bundles.

Known limitations of the language: no per-note velocity, no multiple subtunes, no arbitrary register writes. No human listening sign-off exists for the examples, and some hardware comparisons are open (for example `stereo_echo`).

## Documentation

- [Language specification](sidwave/data/sound/sidwave.md) and [JSON Schema](sidwave/data/sound/sidwave.schema.json)
- [Package README](sidwave/README.md) with the command-line reference
- [Licensing notes](sidwave/doc/licensing.md), including what the generated player means for released tunes and games
- [Repository structure](doc/repository-structure.md)
- [Changelog](CHANGELOG.md)

## Related projects

- [c64bridge](https://github.com/chrisgleissner/c64bridge) is an MCP server that connects coding agents to VICE and Ultimate hardware. It is an optional integration: it lets an AI assistant write, compile and play SIDWave scores and run them on a device. SIDWave does not need it.
- [SIDFlow](https://github.com/chrisgleissner/sidflow) analyses SID collections and streams similar tunes. It is a separate project. SIDWave's planned verification work may use its published analysis data.
- [6502-toolkit](6502-toolkit/README.md) is the assembler and disassembler in this repository. [c64bridge](https://github.com/chrisgleissner/c64bridge) also uses it to assemble programs for VICE and Ultimate devices.

## License

The `sidwave/` package and everything outside `6502-toolkit/` is licensed under GPL-2.0-or-later with the [SIDWave Player Exception](sidwave/LICENSE-EXCEPTION.md). The exception allows compiled tunes, and games that embed the generated player, to be released under any terms. Read the [licensing notes](sidwave/doc/licensing.md). The `6502-toolkit/` package is licensed under the MIT licence. See [LICENSE.md](LICENSE.md).
