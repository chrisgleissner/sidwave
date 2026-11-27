# Repository structure

| Path | Contents |
| --- | --- |
| `LICENSES.md` | Which licence applies to which directory. `COPYING` holds the GPL-2.0 text. |
| `README.md` | Overview for musicians and developers, status and limitations. |
| `CHANGELOG.md` | Changes by release. |
| `sidwave/` | npm package `sidwave`: language, parser, lint, compiler, generator, examples, CLI `sidwave`. |
| `sidwave/doc/` | Package documentation, including `licensing.md`. |
| `6502-toolkit/` | npm package `6502-toolkit` (MIT): 6502 assembler, disassembler, opcode table, PETSCII, I/O range and PRG helpers. |
| `scripts/` | Repository scripts: coverage gate, clean-consumer, consumer type and fresh-clone checks, performance measurement, A1 calibration, composer evaluation and the reconstruction corpus. |
| `package.json` | Private workspace root (`sidwave`, `6502-toolkit`): `build`, `test`, `test:bun`, `coverage`, `pack`, `check:consumer`, `check:types`, `check:fresh-clone`. |
| `.github/workflows/ci.yaml` | CI: tests on Node 20 and 24 and on Bun, coverage gate, pack and clean-install smoke test. |
| `.github/workflows/release.yaml` | Publishes one package to npm when a tag `<package>@<version>` is pushed. |
| `doc/` | Repository-level documentation (this file). |

The repository was produced from the `packages/` directory of c64bridge with `git filter-repo`, so the history of the moved files is preserved. Device control, MCP tools and hardware capture scripts stay in c64bridge.
