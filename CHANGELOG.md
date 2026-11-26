# Changelog

## Unreleased

### Added

- Standalone repository for SIDWAVE, extracted from c64bridge with the history of the moved files.
- npm package `sidwave` (language, parser, lint, compiler to PRG and PSID, generator, examples) and `6502-toolkit` (the 6502 assembler used by the compiler). Neither is published yet.
- Documentation drafts: repository README, package READMEs, licensing notes.

### Changed

- The assembler package `c64-asm6502` (directory `asm6502/`) is renamed to `6502-toolkit` (directory `6502-toolkit/`) and now also contains the disassembler, exported as `6502-toolkit/disassembler`.
- `6502-toolkit` is licensed under the MIT licence.
- `sidwave` is licensed under GPL-2.0-or-later with the SIDWAVE Player Exception (`sidwave/LICENSE-EXCEPTION.md`), replacing GPL-2.0-only. The root `LICENSE` is replaced by `LICENSE.md`; the GPL text is in `COPYING`.

### Compatibility

- Language versions 1.0 to 1.3 are carried over unchanged; compiled output for existing scores is expected to be byte-identical to c64bridge 1.3.3. This is to be confirmed by the extraction gate.
