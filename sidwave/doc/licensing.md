# Licensing notes

This page explains how the SIDWAVE licence applies to the things people make with it. It is an explanation, not legal advice; ask a lawyer if a decision depends on it.

## Code licence

The SIDWAVE code (the parser, compiler, player generator, CLI and tools) is licensed under **GPL-2.0-or-later**, with the **SIDWAVE Player Exception** (version 1.0) in [LICENSE-EXCEPTION.md](../LICENSE-EXCEPTION.md). The exception is a separate file because a custom exception has no SPDX identifier; every source file names it in its header.

## What a compiled PRG or SID contains

The compiler's output contains two things:

1. **Your music data**: the note, instrument and timing streams generated from your score.
2. **The player**: a 6502 program, produced from assembly that is part of the compiler's source, that reads those streams and drives the SID.

The score you write is yours. Music data derived from your score is your work. The player is generated from GPL code, and the Player Exception defines what that means for the output.

## The Player Exception

The exception covers the "Player Code": the 6502 machine code and data that the compiler places into its output to play a score, including code produced by a version of SIDWAVE that you modified. A larger work that contains part or all of the Player Code may be distributed under terms of your choice, as long as that work is not itself a music compiler, player generator or tracker that uses the Player Code as the player it generates.

- **Musicians releasing tunes.** You may release compiled PRG and SID files under any terms, including closed or commercial terms. You do not have to publish your score or the SIDWAVE source.
- **Game and demo developers embedding the player.** You may embed the player in a closed program and distribute that program under terms of your choice.

## What the exception does not cover

- The compiler, the library, the command-line tools and their source code stay under the GPL. If you distribute them, or a modified version, the GPL applies.
- A music compiler, player generator or tracker that uses the Player Code (or a modified version) as the player it generates is not covered. The exception does not allow building a competing music compiler from the player.

If you modify SIDWAVE, you may extend the exception to your version, but you are not obliged to. If you do not want to, delete the exception statement from your version.

## Dependencies

| Component | Licence | Use |
| --- | --- | --- |
| `6502-toolkit` | MIT (same author) | Required. Assembles the player. |
| `yaml` 2.9.0 | ISC | Required. Parses YAML scores. |
| `libsidplayfp-wasm` 1.1.1 | GPL-2.0-or-later | Optional, planned for rendering and tracing. Wraps libsidplayfp 3.1.1 and reSIDfp, both GPL-2.0-or-later. |

`sidplayfp` and VICE are separate programs that you install and run yourself. SIDWAVE calls them as external processes and does not include or link their code.

## Example scores

The example scores are covered by the same licence as the repository unless a file states otherwise. Some examples are arrangements of public-domain compositions.
