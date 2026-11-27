# Changelog

All notable changes to `sidwave` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before 1.0.0, a minor version may contain breaking changes.

## Unreleased

### Added

- SID-Wizard files: `sidwave import` reads `.swm`, `.sws` and `.swi` (`--subtune`), `sidwave export --format swm` writes a module for the expressible subset and `--format swi --instrument` an instrument file. Library: `parseSwm`, `writeSwm`, `parseSwi`, `writeSwi`, `importSwm`, `importSwi`, `exportSwm`, `exportSwi`. Mappings, losses and the comparison with the SID-Wizard player are in `doc/interchange.md`.
- `sidwave reconstruct <trace> --from vice-dump|siddump` recovers a score from a VICE `-sounddev dump` text (exact register writes) or a siddump table (approximate, one row per frame), and `sidwave export <score> --format vice-dump` writes the SID writes of a compiled score in the VICE dump text format. Library: `parseViceDump`, `parseSiddump`, `exportViceDump`, `reconstructFromTrace`.

- Added `sidwave convert <in> [<out>]`: converts between SIDWave scores, MIDI, MusicXML, GoatTracker, Furnace, PRG, PSID, WAV and the event list in one step. The input format is detected from the content. The report lists every loss with a code, a severity and a count; `--strict`, `--dry-run`, `--verify` (note F1, onset error, octave shifts, voices dropped), `--keep-score`, `--report` and `--voices` are available. A `.sid` input is read by reconstruct.
- Added `sidwave formats` and `sidwave info <file>`, and `convert()`, `detectFormat()` and `listFormats()` at the package root. A format registry (`interchange/registry.ts`) makes a new format a one-file addition (`interchange/formatsExtra.ts`).
- Added the conversion test matrix: every importer and exporter pair on committed fixtures, with golden losses, per-pair quality thresholds in `doc/interchange.md`, typed errors for truncated and corrupted files, and a chain-equals-two-step identity check.
- Added `sidwave/retarget` and `sidwave retarget`: convert a score between PAL and NTSC, 6581 and 8580, and SID counts. Every change is reported as exact, approximate or dropped with measured numbers (timing per event kind, filter cutoff deviation, voices kept and dropped).
- `sidwave retarget` accepts `--budget-bytes`, `--budget-cycles` and `--allow-changes`: music-preserving steps run first and are checked on the register trace, lossy steps only on request, and a budget that cannot be met gives exit 1 with the best numbers reached.
- npm package `sidwave`: language, parser, lint, compiler to PRG and PSID, generator, examples and the `sidwave` command. It is extracted from c64bridge with the history of the moved files. It is not published yet.
- Added `sidwave/sid-file` and `sidwave/songlengths`: PSID/RSID v1-v4 reader and writer, HVSC Songlengths.md5 parser.
- Added `sidwave/engine` (libsidplayfp-wasm render and cycle-exact trace, optional peer dependency) and `sidwave/verify` (T0, T1 and A0 comparison).
- Added the game build (`compileSidwave` with `target: "game"`, `sidwave compile --target game`): the player at a chosen origin with optional separate data, symbol files, a register contract and cycles measured on a bundled 6502 interpreter. Existing PRG and PSID output is unchanged.
- A committed launcher `bin/sidwave.js`. Previously `npx sidwave` failed in a fresh clone: npm creates the workspace bin link during `npm ci`, before `dist/` exists, and does not create a link whose target is missing. The launcher exists in the clone, so the link is always created and loads `dist/bin.js` once the build has run.

- `sidwave verify`, `render`, `trace` and `sid-info` commands; `--json` on every command; `--progress`, `--max-seconds`, `--max-records`, `--max-bytes`; SIGINT cancellation. Library functions `verifyTunes`, `renderTune`, `traceTune`, `sidInfo`, `loadTune`, `classifyError`.
- Verification level A1 (`compareAudioA1`, `data/verify/a1-rules.json`): a windowed audio comparison with thresholds fitted on score-level mutations. Status: approximate (held-out false accepts 15.3 %, false rejects 22.2 %; see `data/verify/a1-limitations.md`). `scripts/calibrate-a1.mjs` and the mutation generator are included.
- `sidwave reconstruct` and `reconstructSid` (`sidwave/reconstruct`): recover a SIDWave score from a SID tune, recompile it and compare the two traces call by call. The report carries the horizon, call rate, unsupported features, strict and register-state F-diff verdicts and language-extension candidates with reproducers. Exit 1 with `ok: false` when the strict F-diff is not exact.

- `sidwave export` and `sidwave import` and the library entry point `sidwave/export`: structured event export (`sidwave.events/1`), Standard MIDI File import and export, MusicXML (partwise) import and export, GoatTracker `.sng` import (`GTS!`, `GTS2`, `GTS3` to `GTS5`) and GTS5 export, Furnace `.fur` import and export (C64 chip), and `sidwave render --stems`. Each mapping and its losses are in `doc/interchange.md`. The GoatTracker importer is checked against `gt2reloc` of GoatTracker 2.77; the Furnace export has not been loaded by Furnace itself.
- Composer 2, opt-in with `generateSidwave({ composer: 2, profile })`: 33 profiles with form, functional harmony, melody, motif development, counterpoint with a rule checker (`checkCounterpoint`), groove and drum patterns, and instrumentation on at most three voices per SID under a measured cycle budget. The default generator and its output are unchanged (`test/composeBaseline.test.mjs` pins them).
- `sidwave complete` and `completeScore`: continue, harmonise, accompany and fill-section on an existing score. Target voices must be free; protected voices keep their SID register writes, verified by tracing both scores. `verifyProtected`, `analyseScore`, `measureScore`, `traceDocument` are exported. The result lists what is not compared (the ring-out tail when new entries follow, and the hard restart before a continued voice).
- `scripts/evaluate-composer.mjs` and `data/compose/` (profile list, evaluation of composer 2 against the version 1 generator on proxy measures).
- `sidwave analyze` and `analyzeScore`/`analyzeSid` (`sidwave/analyze`): structural analysis of a score or SID tune (key and mode, metre, form, motifs, voice use, techniques, resources). Every fact is marked `observed` (trace or score) or `inferred` (method named).
- `sidwave compare` and `compare`: F-diff (total, per class, per voice), the verification ladder with the A1 calibration status, and the semantic diff of two scores.
- `sidwave isolate` and `isolateVoice`: one voice alone (or all but one) as a WAV by reconstruct-and-recompile, with the coupling (filter, sync, ring, sample playback) that makes the result non-additive.
- `sidwave preserve` and `createPreservation`/`verifyPreservation`: a preservation bundle (score, checksums, configuration, tool identities, horizon, verdict, ambiguities, rights) with a manifest `preservation.json` that verifies offline. The original SID is stored only with `--include-original --rights-permitted`.
- `sidwave extract-instruments` and `extractInstruments`: the instruments of a score or of a reconstruction as a SIDWave 1.4 library with provenance; `checkInstrumentReuse` compares an extracted instrument in a new score with the source.
- Documentation: `doc/analysis.md`, `doc/preservation.md`.

### Changed

- GoatTracker and Furnace export count time in video frames. A score with `speed: 2` or more was written at twice the intended tempo; the multispeed rounding is now reported as `timing.multispeed`.
- MIDI and MusicXML export write drum hits that share a voice with pitched notes as pitched notes at their written pitch, so that the voice is not read back as a drum voice that drops its pitched notes.
- Breaking (command line): an invalid score or unreadable input exits 3 (was 1 or 2), an unwritable output exits 3 (was 2), a failed verdict is the only exit 1; `--json` prints `{ ok, command, result | error: { category, message, details } }`; the engine yields to the event loop while rendering.

- Licence: GPL-2.0-or-later with the SIDWave Player Exception (`LICENSE-EXCEPTION.md`), replacing GPL-2.0-only.
- The dependency on `6502-toolkit` is `^0.1.0` (was the exact version `0.1.0`).
- `compileSidwaveToSid` accepts a `Uint8Array` for the PRG argument. This widens the parameter type (`Buffer` is a `Uint8Array`); callers are not affected. The compiler results (`CompileResult.prg`, `sid`) remain `Buffer`, because `sidwave` is a Node.js package and its callers use `Buffer` methods on them.
- `engines.node` is `>=20.19` (was `>=24`).
- Published files include `CHANGELOG.md` and `bin`.

### Performance

- Compiling a score is 1.8 times faster over all examples (up to 2.6 times on `chiptune_drive`): the filter cutoff in Hz no longer scans all 2048 register codes on every lookup (now a precomputed table and a cache), stream compression compares integers instead of strings, and instrument variants are memoised. `lint`, `transpose`, `diff` and `merge` are faster by the same factor because they compile. `diff` also compiles only one side when both texts hold equal data. A1 comparison is 2.3 times faster (one half-size FFT per real window, no `Math.hypot`); the band energies were identical to the previous ones on every fixture tested. Similarity and quality analysis are 2 to 3 times faster (cached chroma tables and mono mix, a half-size FFT per frame). Parsing scores with synthesised samples is faster (the resampling kernel is computed once for integer rate ratios). Compiler output, PSID, game build and fixtures are byte-identical.
- Added `scripts/bench-perf.mjs` (CPU and wall time per operation, JSON report), `doc/performance.md` (budgets) and `test/performanceBudgets.test.mjs` (CPU-time regression tests).

### Documentation

- Name written as SIDWave in prose (README files, the language specification, the licence texts, the JSON Schema title, package descriptions, `--help` text and code comments). The npm package name, the `sidwave` command, file names, code identifiers, schema `$id` URLs, YAML keys, and error, lint and output messages (including `Invalid SIDWAVE at ...`) keep their spelling.

### Compatibility

- Language versions 1.0 to 1.3 are carried over unchanged; compiled output for existing scores is expected to be byte-identical to c64bridge 1.3.3. This is to be confirmed by the extraction gate.
