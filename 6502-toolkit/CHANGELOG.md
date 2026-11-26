# Changelog

All notable changes to `6502-toolkit` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before 1.0.0, a minor version may contain breaking changes.

## Unreleased

### Added

- npm package `6502-toolkit`: 6502 assembler and disassembler, extracted from c64bridge. It is not published yet.
- Documentation: a package README with install, quick start, API overview, syntax summary, Commodore support, a comparison with other npm 6502 assemblers and limitations; `doc/syntax.md`, `doc/api.md`, `doc/commodore.md` and a generated `doc/opcodes.md` (all 256 opcodes). The code examples in these pages are run by the test suite, and `doc` is included in the published package.
- Tests: one generated test per opcode for assembling, disassembling and round trip, tables for every addressing mode, directive spelling, PRG rule and PETSCII token, and exact error messages.
- A test that runs the built package in a child process with `Buffer` removed and every `node:` import blocked, and assembles and disassembles a program.
- `sideEffects: false` in `package.json`, so bundlers can drop unused modules.

### Changed

- The assembler is renamed from `c64-asm6502` (directory `asm6502/`) to `6502-toolkit` and now also contains the disassembler, exported as `6502-toolkit/disassembler`.
- Licence: MIT.
- Breaking for callers that use `Buffer` methods on the result: `assemblyToPrg` and the `prg` field of `assemblyToPrgDetailed` are now typed and returned as `Uint8Array`, not `Buffer`. The bytes are unchanged. Callers that only read, index, spread or pass the result on keep working. Callers that use `Buffer` methods such as `readUInt16LE` or `toString("hex")` wrap the result with `Buffer.from(prg)`. The package no longer imports `node:buffer` or any other Node.js module, so it runs in browsers without polyfills.
- The coverage gate requires 98 % line coverage (Bun) and 95 % branch coverage (Node with c8, a new development dependency). The branch records are added to the LCOV file that CI uploads to Codecov.
- `engines.node` is `>=20.19` (was `>=24`).
- Published files include `CHANGELOG.md`.
