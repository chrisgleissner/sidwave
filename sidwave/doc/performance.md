# Performance

SIDWave is meant to be fast enough that nobody waits for it: a score compiles in a fraction of a second, a
verification run is dominated by the emulator, and no command has a hidden quadratic step. This page lists the CPU-time
budgets, how to measure them, and what the largest costs are.

## Measuring

```bash
npm run build
node scripts/bench-perf.mjs                       # all examples and the large synthetic inputs
node scripts/bench-perf.mjs --examples chiptune_drive,wall_of_sid --runs 3
node scripts/bench-perf.mjs --filter compilePrg   # operations whose name contains the text
node scripts/bench-perf.mjs --dist <dir>          # measure another build, for a before and after comparison
```

Every operation is run once cold (reported as `cold`) and then five times warm. The report gives the median of the warm
runs as CPU time (`process.cpuUsage`, user plus system) and wall time. It is written as JSON to
`~/.c64bridge/sidwave-standalone/perf/bench-<date>.json` (`--out` chooses another file) and as a table to standard
output. The command line entries (`cli/validate`, `cli/compile`, ...) start a new Node process per sample and report wall
time.

Profile the slowest operations with Node's profiler and read the self time per function, not the whole profile:

```bash
node --cpu-prof --cpu-prof-dir=/tmp/prof script.mjs
```

CPU time is the figure to compare. Wall time grows with other load on the machine; on a shared machine CPU time still
varies by tens of percent (hyper-threads and caches are shared), so compare medians of several runs, ideally
alternating the builds that are compared.

## Budgets

The budgets are CPU time of a warm process on a normal development machine, for the bundled examples (up to about
45 KB of YAML) unless the row says otherwise. The "measured" column was taken on a machine that was running with a load
average of 20 to 30 on 8 cores, so it is closer to a worst case than to a best case.

| Operation | Budget | Measured | Dominated by |
| --- | --- | --- | --- |
| Parse a normal example | 60 ms | 25-105 ms | the `yaml` package (about 85 %) |
| Compile to PRG (`compileSidwaveToPrg`, includes lint) | 250 ms | 185-240 ms | arrangement, instrument pool, two assembler passes |
| `lint` | same as compile | 220-310 ms | it runs the full compile |
| `format` | 80 ms | 17-72 ms | the `yaml` package |
| Semantic `diff` | 600 ms | 340-570 ms | one compile (both texts are compiled only when their data differ) |
| `merge` | 400 ms | 110-360 ms | the `yaml` package |
| PSID parse, MD5 | 1 ms | 0.07 ms | |
| Songlengths.md5, 60,000 entries (120,000 lines, 5 MB) | 250 ms | 135-145 ms cold, 65 ms warm | the Map of keys; the line scan is about 80 ms cold |
| STIL.txt, 18,500 entries (107,000 lines) | 300 ms | 120-175 ms cold, 50 ms warm | |
| `sid edit` of one field | 1 ms | 0.3 ms | |
| `sid info` over all of HVSC (59,886 files) with Songlengths and STIL | tens of seconds | 6 s warm cache, 15 s cold cache (5 s CPU) | reading the files |
| `songlengths verify` of all of HVSC | tens of seconds | 3 s | reading the files |
| `sid player` (SIDId, 757 players) | 5 ms per file | 2 ms per file | |
| Game build with measured cycles | 1 s; 3 s for the largest scores | 0.7-2.3 s | the bundled 6502 interpreter (up to 9 million instructions); `--no-measure` skips it |
| T0/T1 comparison, two 3-minute traces | 200 ms | 75-100 ms | unpacking the records |
| Trace IR, one minute of music | 100 ms | 38-55 ms | |
| F-diff, 60 s | 50 ms | 19 ms | |
| A1 comparison, 30 s of audio | 1.2 s | 0.9 s | FFT of 15,000 lag windows per signal |
| A1, identical signals | 150 ms | 74 ms | |
| Quality analysis, 20 s | 1 s | 0.35 s | |
| Fidelity analysis, 20 s | 1 s | 0.64 s | |
| Similarity, 20 s | 2.5 s | 1.7 s | zero-padded FFT per chroma frame |
| Engine render or trace, 30 s | 1.7 s | 1.45 s | the libsidplayfp WebAssembly module (about 20 times real time) |
| `sidwave format --check` (in the process) | 80 ms | 28-70 ms | the `yaml` package |
| `sidwave diff` (in the process) | 800 ms | 225-780 ms | the compile of both texts |
| `sidwave diff --no-compile` (in the process) | 100 ms | 40-85 ms | the `yaml` package |
| `sidwave merge` (in the process) | 400 ms | 90-310 ms | the `yaml` package, then parse of the result |
| `sidwave transform` (in the process) | 400 ms; `--validate parse` 200 ms | 170-330 ms; 40-190 ms | the compile check of the result |
| `sidwave generate` (composer 2) | 100 ms; with `--prg` and `--sid` 300 ms | 38 ms; 170 ms | the composer; then two compiles |
| CLI cold start: `--help` | 200 ms wall | 120-175 ms | Node start-up and module loading |
| CLI cold start: `validate` | 400 ms wall | 300-370 ms | module loading, then a cold parse |
| CLI cold start: `compile` | 1 s wall | 0.7-0.85 s | cold code paths of the compiler |

Why these values: the YAML package is the floor for parsing, formatting and merging; the budgets for those leave room
above what it needs. Compiling has no external floor, so its budget is the measured cost with a margin, and the
regression test below fails when it grows by more than about five times its measured ratio. The analysis budgets follow what the algorithms
need (the number of FFTs is fixed by the window and hop sizes) and can only move by a better FFT.

## What was changed to reach them

- **Filter cutoff in Hz** (`resolveCutoff`): every lookup scanned all 2048 register codes, each with a linear search of
  the curve. A cutoff table per chip model is now computed once and the results are cached. In a profile of compile, format and
  diff of `chiptune_drive` it accounted for 38 % of the CPU time.
- **Stream compression** (`compressVoiceTokens`): token keys are interned to integers, so the repeated comparisons and
  the three-token signatures compare numbers, and candidate subroutines are indexed by their first token.
- **Instrument pool**: instruments that differ from a pooled instrument only in envelope, sustain or filter routing are
  memoised per base instrument instead of being copied and serialised for every note, and pitch-independent
  instruments are built once per pattern entry and not once per pitch.
- **Semantic diff**: values are compared in place, not by serialising both sides at every level, and when both texts hold
  equal data only one of them is compiled.
- **A1**: each window is real, so its spectrum is computed with one complex FFT of half the length, and the band powers
  are formed without `Math.hypot`. The band energies were identical to the previous implementation on all fixtures tested (the arithmetic order differs, so a last-digit difference is possible in principle).
- **Fidelity, quality and similarity**: FFT twiddle factors and the bit-reversal table are computed once per size (same
  values as the recurrence used before), the chroma tables and the mono mix are reused, and each chroma frame uses a
  half-size FFT. Reports differ from the previous ones by less than 1e-13 relative.
- **Samples** (`resamplePcm`): for an integer ratio between the work rate and the sample rate the interpolation kernel is
  computed once for the integers it is evaluated at, and not for every tap of every output sample. Parsing
  `digi_groove` went from about 400 ms to about 165 ms.
- **Trace validation** (`traceWrites`, `buildIr`): no temporary arrays per record.

The compiler output, PSID files, the game build and the example fixtures are byte-identical to the previous version
(`sidwaveCompat10`, `sidwaveCompat12`, `sidwaveGameBaseline` and the example hash tests).

## Known costs that are not reduced

- The bundled 6502 interpreter (`sidwaveEmulator.ts`) runs about 25 million instructions per second. A game build of a
  large score executes up to 9 million instructions, so it takes 0.3 to 2 s. A rewrite as one `switch` and with
  pre-decoded tables was measured and was not faster, so the interpreter is unchanged. Use `--no-measure` when cycle
  counts are not needed.
- The `yaml` package parses about 1 MB per second. Parsing is bounded by it.
- The engine renders about 20 times faster than real time, inside WebAssembly.

## Regression tests

`test/performanceBudgets.test.mjs` measures parse, compile, format, diff, cutoff resolution, Songlengths parsing, trace
comparison, trace IR, A1 and `convert` (score to MIDI and to GoatTracker with `--verify`: 6.5 x the reference, limit 24 x) as the smallest CPU time of several runs, divided by the smallest CPU time of a fixed workload
measured alternately in the same process (a mixed allocation, sort and JSON workload; a tight arithmetic loop was
rejected because it ran 5 times slower in some processes). The bounds are about five times the measured ratio, so they
flag a complexity regression (a quadratic scan, a repeated parse). Run with
`SIDWAVE_PERF_REPORT=1` to print the measured ratios.
