# Changelog

All notable changes to `sidwave` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before 1.0.0, a minor version may contain breaking changes.

## Unreleased

### Added

- npm package `sidwave`: language, parser, lint, compiler to PRG and PSID, generator, examples and the `sidwave` command. It is extracted from c64bridge with the history of the moved files. It is not published yet.
- Added `sidwave/sid-file` and `sidwave/songlengths`: PSID/RSID v1-v4 reader and writer, HVSC Songlengths.md5 parser.
- Added `sidwave/engine` (libsidplayfp-wasm render and cycle-exact trace, optional peer dependency) and `sidwave/verify` (T0, T1 and A0 comparison).
- Added the game build (`compileSidwave` with `target: "game"`, `sidwave compile --target game`): the player at a chosen origin with optional separate data, symbol files, a register contract and cycles measured on a bundled 6502 interpreter. Existing PRG and PSID output is unchanged.
- A committed launcher `bin/sidwave.js`. Previously `npx sidwave` failed in a fresh clone: npm creates the workspace bin link during `npm ci`, before `dist/` exists, and does not create a link whose target is missing. The launcher exists in the clone, so the link is always created and loads `dist/bin.js` once the build has run.

- `sidwave verify`, `render`, `trace` and `sid-info` commands; `--json` on every command; `--progress`, `--max-seconds`, `--max-records`, `--max-bytes`; SIGINT cancellation. Library functions `verifyTunes`, `renderTune`, `traceTune`, `sidInfo`, `loadTune`, `classifyError`.
- Verification level A1 (`compareAudioA1`, `data/verify/a1-rules.json`): a windowed audio comparison with thresholds fitted on score-level mutations. Status: approximate (held-out false accepts 15.3 %, false rejects 22.2 %; see `data/verify/a1-limitations.md`). `scripts/calibrate-a1.mjs` and the mutation generator are included.

### Changed

- Breaking (command line): an invalid score or unreadable input exits 3 (was 1 or 2), an unwritable output exits 3 (was 2), a failed verdict is the only exit 1; `--json` prints `{ ok, command, result | error: { category, message, details } }`; the engine yields to the event loop while rendering.

- Licence: GPL-2.0-or-later with the SIDWave Player Exception (`LICENSE-EXCEPTION.md`), replacing GPL-2.0-only.
- The dependency on `6502-toolkit` is `^0.1.0` (was the exact version `0.1.0`).
- `compileSidwaveToSid` accepts a `Uint8Array` for the PRG argument. This widens the parameter type (`Buffer` is a `Uint8Array`); callers are not affected. The compiler results (`CompileResult.prg`, `sid`) remain `Buffer`, because `sidwave` is a Node.js package and its callers use `Buffer` methods on them.
- `engines.node` is `>=20.19` (was `>=24`).
- Published files include `CHANGELOG.md` and `bin`.

### Documentation

- Name written as SIDWave in prose (README files, the language specification, the licence texts, the JSON Schema title, package descriptions, `--help` text and code comments). The npm package name, the `sidwave` command, file names, code identifiers, schema `$id` URLs, YAML keys, and error, lint and output messages (including `Invalid SIDWAVE at ...`) keep their spelling.

### Compatibility

- Language versions 1.0 to 1.3 are carried over unchanged; compiled output for existing scores is expected to be byte-identical to c64bridge 1.3.3. This is to be confirmed by the extraction gate.
