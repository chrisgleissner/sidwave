# sidwave

[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg?flag=sidwave)](https://codecov.io/gh/chrisgleissner/sidwave)

SIDWave is a music language, compiler and toolkit for the Commodore 64 SID chip. Write a score as YAML or JSON. Compile it to a self-playing C64 PRG or to a PSID file that includes the 6502 player.

Status: pre-release. This package has not been published to npm yet. Build it from the [repository](https://github.com/chrisgleissner/sidwave#install-and-first-tune). Once published, the install command is:

```sh
npm install sidwave
```

Requires Node.js 24 or later. Runtime dependencies: `yaml` and `6502-toolkit`. Optional peer dependency: `libsidplayfp-wasm` (see Engine).

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
sidwave --help | --version
```

- `validate` parses the score. Exit 0 when valid; exit 1 and the path of the first error (`Invalid SIDWAVE at $.voices[0].adsr: ...`) otherwise.
- `compile` writes a PRG (default) or PSID. Without `-o` the file is named after the input, with `.prg` or `.sid`, in the current directory. A `-o` name ending in `.sid` selects PSID unless `--format` is given. `-o -` writes the bytes to standard output and the summary to standard error. `--json` prints the format, sizes, load, entry, init and play addresses, SID count, duration, frame counts and lint count. `--loop` (the default) and `--no-loop` select whether the song restarts at its end. The input file is never overwritten.
- `lint` prints the lint findings. It exits 0 for a valid score, whatever the findings; with `--strict` it exits 1 when there is a finding that is not an informational note.
- `examples` lists the bundled example scores. `examples <name>` prints one to standard output, or with `-o <dir>` writes `<dir>/<name>.yaml`; an existing file is only replaced with `--force`.
- `--allow-dir <dir>` (repeatable) permits `file:` sample sources below `<dir>`. Without it they must lie below the current directory (symbolic links are resolved first). The command never uses the network.

Exit codes: 0 success; 1 invalid input or failed verdict; 2 usage or operational error (unknown option, unreadable or unwritable file, refusing to overwrite). Every command is a library function (`compileSidwaveBytes`, `lintSidwave`, `confinedFileReader`, ...); the command line only translates arguments and output.

## What you get

- Language versions 1.0 to 1.3: wave, pulse and filter tables, hard restart, sync and ring, echo, unison, follower voices, multispeed, sections, up to 10 SIDs and 30 voices in a PRG (PSID: up to 3 SIDs), CIA2 volume digis in a PRG.
- Lint checks and error messages that name the failing path in the score.
- 14 example scores in [`data/sound/examples`](data/sound/examples).

Planned and not yet available: SID file reader and writer, `sidwave verify`, formatter and diff, a relocatable player and sound effects for games, reconstruction of SID tunes into scores, MIDI/MusicXML/tracker import.

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
- A trace with no writes inside the horizon fails T0 and T1 with category `empty_trace`.
- The clock is taken from the PSID header of the reference tune unless `clock` is given. Every difference carries `cycle` and `timeSeconds` on that clock.

## More

- [Repository README](https://github.com/chrisgleissner/sidwave#readme): overview, examples, roadmap
- [Language specification](data/sound/sidwave.md) and [JSON Schema](data/sound/sidwave.schema.json)
- [Licensing notes](doc/licensing.md): read this before releasing a tune or embedding the player in a game

License: GPL-2.0-or-later with the [SIDWave Player Exception](LICENSE-EXCEPTION.md).
