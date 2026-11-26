# Changelog

## Unreleased

### Added

- Standalone repository for SIDWAVE, extracted from c64bridge with the history of the moved files.
- npm package `sidwave` (language, parser, lint, compiler to PRG and PSID, generator, examples) and `6502-toolkit` (the 6502 assembler used by the compiler). Neither is published yet.
- Documentation drafts: repository README, package READMEs, licensing notes.
- `6502-toolkit` documentation: a package README with install, quick start, API overview, syntax summary, Commodore support, a comparison with other npm 6502 assemblers and limitations; `doc/syntax.md`, `doc/api.md`, `doc/commodore.md` and a generated `doc/opcodes.md` (all 256 opcodes). The code examples in these pages are run by the test suite, and `doc` is included in the published package.
- `6502-toolkit` tests: one generated test per opcode for assembling, disassembling and round trip, tables for every addressing mode, directive spelling, PRG rule and PETSCII token, and exact error messages.

### Changed

- The coverage gate for `6502-toolkit` requires 98 % line coverage (Bun) and 95 % branch coverage (Node with c8, a new development dependency). The branch records are added to the LCOV file that CI uploads to Codecov. The gate for `sidwave` is unchanged.
- The assembler package `c64-asm6502` (directory `asm6502/`) is renamed to `6502-toolkit` (directory `6502-toolkit/`) and now also contains the disassembler, exported as `6502-toolkit/disassembler`.
- `6502-toolkit` is licensed under the MIT licence.
- `sidwave` is licensed under GPL-2.0-or-later with the SIDWAVE Player Exception (`sidwave/LICENSE-EXCEPTION.md`), replacing GPL-2.0-only. The root `LICENSE` is replaced by `LICENSE.md`; the GPL text is in `COPYING`.

### Documentation

- Name written as SIDWave in prose (README files, the language specification, the licence texts, the JSON Schema title, package descriptions, `--help` text and code comments). The npm package name, the `sidwave` command, file names, code identifiers, schema `$id` URLs, YAML keys, and error, lint and output messages (including `Invalid SIDWAVE at ...`) keep their spelling.
- Repository README restructured: tagline, "Choose your path" table, install and first-tune commands, repository layout.

### Compatibility

- Language versions 1.0 to 1.3 are carried over unchanged; compiled output for existing scores is expected to be byte-identical to c64bridge 1.3.3. This is to be confirmed by the extraction gate.
