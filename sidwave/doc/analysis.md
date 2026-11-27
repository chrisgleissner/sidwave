# Analysis, comparison, isolation and instrument extraction

This page describes the commands `sidwave analyze`, `compare`, `isolate` and `extract-instruments` and the library functions behind them (`sidwave/analyze`). Preservation bundles have their own page: [preservation.md](preservation.md).

Every operation is a function first. The command line only reads files, calls the function and prints. All commands use the shared command-line contract: exit 0 for success, 1 for a failed verdict, 2 for usage errors, 3 for unreadable or invalid input, and `--json` prints `{ ok, command, result | error }`.

## Observed and inferred facts

Every fact in an analysis report carries a `basis` field.

- `observed`: read from the register trace of the tune, or from the score text: register values, control bits, call timing. A classification by thresholds (hard restart, arpeggio, vibrato, slide, pulse and filter sweeps) is not an observation; it is `inferred` with the detector named, and the register facts in its evidence stay observed.
- `inferred`: the result of a model applied to observations. An inferred fact always has a `method` field that names the model. For a SID tune, everything derived from the note list is inferred, because the notes come from the SIDWave reconstruction of the tune and not from the tune itself.

The report field `limits` lists what bounds the facts for this input (for example that the cycle figures are write spans, or that the compiler rejected the reconstruction).

## `sidwave analyze <file> [--song n] [--seconds s] [--songlengths file] [--json]`

The file is a SIDWave score or a SID file. A SID tune is reconstructed first (`reconstructSid`), and the analysis runs on the reconstruction and on the register trace of the original tune. The horizon is `--seconds`, else the Songlengths entry given with `--songlengths`, else 30 s, and is always reported. A score is analysed statically; `analyzeScore(text, { engine })` additionally traces the compiled score and measures techniques and resources in the trace.

| Section | Content | Basis |
| --- | --- | --- |
| `key` | Tonic, mode, correlation, margin to the runner-up, confidence (high: correlation at least 0.75 and margin at least 0.05; medium: correlation at least 0.55), pitch-class histogram | inferred: Krumhansl-Schmuckler key profiles correlated with the duration-weighted pitch-class histogram of the pitched notes |
| `metre.declared` | Beats per bar, tempo | observed in a score; inferred for a SID tune (the reconstruction assumes four beats per bar and fits the tempo to the player call rate) |
| `metre.detected` | Bar length of 3, 4 or 6 beats | inferred: mean onset strength on the beats 0, L, 2L, ... relative to all beats; 4 wins ties, 3 and 6 need a clearly stronger accent |
| `form` | Bar labels (bars with the same notes at the same offsets in the same voices get the same label), runs, repetitions, share of repeated bars, the loop (longest suffix with at least two exact repetitions of one period, found with the prefix function), sections | labels and runs: observed for a score, inferred for a SID tune; loop: inferred; the declared `loop_to` and the declared sections: observed |
| `motifs` | Recurring figures of 4, 5, 6 or 8 notes: interval steps, inter-onset intervals in eighths of a beat, number of occurrences, voices and the first locations (bar and beat) | inferred: n-gram mining, at least 3 non-overlapping occurrences, repeated single notes excluded, a shorter motif that lies inside a longer one is dropped |
| `voices` | Note count, range, notes per second, sounding share, role | role: observed when the score declares it, else inferred from the pitch rank of the median note, note length and the share of percussion. For a SID tune each voice also has `trace`: gate share, waveforms used and the frequency range of the registers, all observed |
| `techniques` | See below | from a trace: control-bit and rate facts (sync, ring, test bit, noise, combined waveforms, multispeed, sample playback) observed; threshold classifications inferred with the detector named. From a score: observed in the instrument definitions |
| `resources` | See below | observed or inferred, per entry |

Offsets and lengths in the form and motif comparison are rounded to eighths of a beat (lengths to half beats). A tempo that is not a whole number of calls per beat moves the same musical position by one call from bar to bar, and the comparison must not call such bars different.

### Techniques

Techniques found in a trace by thresholds carry `basis: "inferred"` and a `method` that names the detector (`DETECTORS` in `techniques.ts`). A technique lists the voices (global number 1 to 3 per SID) that use it and its evidence. Detectors read the register trace of one voice at a time and are linear in the number of calls. The init call (every register written) is skipped.

| Technique | Rule (thresholds in `THRESHOLDS`) |
| --- | --- |
| hard restart | at least 3 gate-on edges, and at least half of them follow a gate-off gap of 1 to 3 calls with the test bit set or the AD/SR registers changed |
| arpeggio | a gate-on run of at least 8 calls whose frequency, with equal neighbours collapsed, has at least 6 steps over 2 to 6 distinct values, repeats with a period of 2 to 6 steps (90 % match), and spans more than 6 % |
| vibrato | a gate-on run of at least 12 calls with at least 3 distinct values, a range of at most 6 % (about a semitone), at least 4 reversals of direction, and regular spacing of the reversals (coefficient of variation at most 0.4). Rate and depth are reported |
| pitch slide | a monotone frequency change of at least 6 changing calls over at least 5 distinct values, not an arpeggio |
| pulse width sweep | at least 8 changing calls in one direction and a total change of at least 64, while the pulse waveform is selected |
| filter sweep | the same for the cutoff while at least one voice is routed through the filter and a filter mode is selected. Routing without a sweep is reported with `swept: false` |
| oscillator sync, ring modulation, test bit, noise, combined waveforms | the control register bits (sync and ring only with a waveform selected; the test bit also in the order of the writes inside a call) |
| multispeed | more than one player call per frame |
| sample playback | dense non-periodic writes to `$D418`, with the write rate and the share of all writes |

For a score, techniques are read from the instrument definitions that voices use (hard restart, wavetable arpeggio, vibrato, pulse and filter tables, sync, ring, speed, samples). They are observed in the score, but a technique that is defined and never triggered may be listed.

### Resources

- `trace` (observed): calls, calls per frame, call period in cycles, share of irregular spacings, writes, the span in cycles from the first to the last SID write of a call (minimum, median, 95th percentile, maximum), writes per call and the number of non-periodic writes. The span is a lower bound of the cost of the player; the engine does not report the CPU cycles between writes, so the cost per call is not measured.
- `memory` (observed, SID input): load and end address, size, init and play address, SID count, clock and models from the PSID header.
- `compiled` (inferred, score input): the sizes and the static worst-case cycle bound from the compiler. Pass `resources: false` to `analyzeScore` to skip it; the compiler arranges the score a second time, and for a large score that costs more than the whole analysis.

### Status

| Part | Status |
| --- | --- |
| Technique detection | verified within declared bounds: synthetic traces with one known technique each, the independently written player fixtures (`hardRestart`, `arpeggio`, `vibrato`, `pulseSweep`, `filterSweep`, `sync`, `ring`, `multispeed`, `nmiSampler`, `testBit`) and the seeded round-trip tunes. Not checked against labelled real tunes |
| Resources | verified within declared bounds for the trace figures; the cycle span is a lower bound |
| Key, form, motifs, voice roles | approximate: heuristics with named methods. The key of a reconstruction depends on its note lengths |
| Metre detection | approximate: it agrees with the declared metre on 10 of the 15 bundled example scores. Use `metre.declared` for a score |
| Musical facts of a real tune | approximate: the reconstruction of real tunes does not yet compile in every case. When the compiler rejects it, the note list is read from the score text (`modelOfScoreText`: no ties, legato, portamento or chords), and `limits` says so. They are computed on the 24 development tunes only; no held-out tune was used |

## `sidwave compare <a> <b> [--song n] [--seconds s] [--level T0|T1|A0|A1] [--no-ladder] [--json]`

Each input is a score or a SID file; a score is compiled to a PSID. The report holds:

- the F-diff of the two register traces (the init call of each trace skipped): `equal`, differing calls in total and per register class, the first difference, and the same for each voice alone (`voices`);
- the F-diff of the register state only (`fdiffState`);
- the verification ladder of `sidwave verify` up to `--level` (default A1): T0, T1, A0 and A1, the first difference, and notes. A1 has the calibration status `approximate` and is `not evaluated`, with the reason, when the pinned ROM images are not supplied (`--roms`). T0 and T1 compare the writes of one player; between a SIDWave-compiled score and a tune with another player they are not applicable;
- for two scores, the semantic diff of the S4 formatter: the number of changes by class (formatting, musical, synthesis, hardware, structural), the first changes, and whether the compiled output is identical.

Exit 0 when the F-diff shows no difference, 1 otherwise. Library: `compare(a, b, options)`.

## `sidwave isolate <file.sid> --voice n [--mute] [-o out.wav] [--song n] [--seconds s]`

Writes a 48 kHz mono WAV of voice `n` alone (global number: SID 1 has voices 1 to 3, SID 2 has 4 to 6). With `--mute` it writes all voices except `n`.

**Method: reconstruct-and-recompile.** The libsidplayfp-wasm binding can render a tune and trace its writes, but it cannot replay a list of register writes, so a voice cannot be muted by masking its writes in a trace replay. The tune is reconstructed as a SIDWave score, the silenced voices get an empty layer in every timeline section, and the score is compiled and rendered. Consequences:

- The audio is as exact as the reconstruction. The result states `reconstructionStrictExact`; when it is false, the audio is an approximation of the voice. When the compiler rejects the reconstruction, the command fails with the reason `reconstruction_not_compilable` (exit 3).
- Oscillator phases differ from the original: the SIDWave player writes a few cycles apart from the original player, and the phase of a voice depends on the exact cycle of each frequency write. The solo renders of the three voices of a tune that is not coupled add up in power to the power of the full tune (tested within 15 %), not sample by sample. The first 20 ms hold a start-up transient that differs.
- The result is marked **non-additive** (`coupling.nonAdditive`, with the reasons) when the trace shows: the target or several voices routed through the filter (the filter does not give the sum of its inputs; on the 6581 it is nonlinear); the target uses sync or ring modulation or is the modulator of a voice that does (voice 1 is modulated by voice 3, voice 2 by 1, voice 3 by 2, on each SID); or sample playback writes the shared volume register.

`-o` refuses to overwrite an existing file without `--force` (also for `extract-instruments`). Library: `isolateVoice(sidBytes, options)`.

## `sidwave extract-instruments <file.sid|score> [-o library.yaml] [--name n] [--licence spdx] [--author a] [--created date]`

Writes the instruments of a score, or of the reconstruction of a SID tune, as a SIDWave 1.4 asset library (`sidwave: "1.4"`, `library` with name, version, licence and provenance, `instruments`). Each instrument is its full definition with its note program: waveform, pulse width, ADSR, hard restart, wavetable, pulse table, filter table, vibrato. The library loads through the production import resolver.

Provenance: `provenance.source` names the origin: for a SID tune the MD5 and SHA-256 of the file, the subtune and the horizon; for a score the SHA-256 of the score. The library file also has a comment header with the same data and, for a SID tune, whether the reconstruction was strictly exact (an inexact reconstruction can have wrong instruments). The library format has no field for more provenance, so the checksums are in the free-text `source` field and the comments. The licence is `LicenseRef-unknown` unless `--licence` is given: an extracted instrument carries the rights of its source, which SIDWave does not know. `created` defaults to today; pass it for reproducible output. Instruments that the score uses but does not define (`lib:` and imported ones) are listed in `external` and not copied. Library: `extractInstruments`.

**Reuse test.** `checkInstrumentReuse` builds a one-voice probe score twice from the extracted instrument: once with the definition inline and once imported from the library file, plays the same notes, compiles and traces both, and compares the register output of the voice call by call (F-diff restricted to that voice). The source side of the comparison is the source score's own definition of the instrument (`sourceInstrument`), not a copy from the library, so a corrupted extraction fails the check. For a SID tune the source score is its reconstruction; the check then shows that the library reproduces that score, not that the reconstruction reproduces the tune (see the strict verdict). `replaceWithImports` replaces every extracted instrument in the source score by an import; the voices of the source and of the replaced score must then give identical registers.

Status: verified within declared bounds: instruments of seeded scores (a sample of three in the default test run, all of them with `SIDWAVE_FULL_REUSE=1`) (pulse tables, arpeggio wavetables, hard restart, vibrato, filter tables) and instruments of reconstructions are reusable with an equal F-diff; the check is shown to fail for a changed instrument.

## Editability

Prompt section 6 requires that a reconstructed score can be edited. The test `analyzeEdit.test.mjs` applies one edit at a time to seeded scores and to the scores reconstructed from seeded tunes and from three independently written player fixtures. Each edit checks that the intended change happened and that the register output of everything unrelated is unchanged (F-diff restricted to the unrelated voices, and a comparison of the calls before and after the edited part).

- change one note: the first occurrence of a pattern of voice 1 gets a private copy and one note moves by a fifth; differing calls of voice 1 lie between the edited note and the next one; voices 2 and 3 are identical.
- swap an instrument: voice 2 gets another instrument; voices 1 and 3 are identical. An instrument whose hard restart does not fit the notes is rejected by the compiler and the next candidate is tried.
- transpose a section: the timeline is split into two sections that own their patterns, section 2 is transposed by two semitones with the `transpose` transform; every call before section 2 is identical.
- change the tempo: `setTempo` to 80 %; the tempo field changed, the length in calls scales, and each voice plays the same pitches in the same order.
- reuse an extracted instrument: the reuse test above.

Results: pass on every cell; no cell is n/a. The edits apply to any layout: the note to change is any plain sounding note of any voice and pattern occurrence (the occurrence gets a private copy of its pattern and the changed note is found by comparing the note lists read from the text), the instrument swap uses another instrument of the score or a copy of the voice's instrument with another envelope, and the tempo edit applies to any score. The transposition check asserts that every pitched note of section 2 moved by exactly the interval and every note of section 1 did not. The test allows no n/a.

**Weak rows.** On the three reconstructed fixtures the tune is one voice with one note in the horizon. There, "change one note" has no successor note and no other voice, and "swap an instrument" has no other voice, so the check that unrelated parts keep their registers is vacuous; the intended change is still checked. These six cells are reported as `pass (weak)` and the test allows weak passes on the fixtures only.

| Input class | change one note | swap an instrument | transpose a section | change the tempo | reuse an instrument |
| --- | --- | --- | --- | --- | --- |
| seeded basic/1, arpeggio/3, hard_restart/4, vibrato/5, combined/1 | pass | pass | pass | pass | pass |
| reconstructed (the same five tunes) | pass | pass | pass | pass | pass |
| reconstructed fixtures arpeggio, vibrato, pulseSweep | pass (weak) | pass (weak) | pass | pass | pass |

## Performance

The operations are linear in the number of calls, notes or bars (the motif miner is linear in notes times four lengths; sorting adds n log n in the call-span percentiles). CPU time (user plus system, measured with `process.cpuUsage`) for a trace of 36,000 calls (12 minutes at 50 Hz), three voices, filter and pulse activity:

| Operation | CPU time |
| --- | --- |
| `techniquesFromIr` | 110 ms |
| `traceVoiceFacts` | 41 ms |
| `irFingerprint` | 44 ms |
| `restrictIrToVoice` | 24 ms |
| `differingCalls` | 13 ms |
| `traceResources`, `detectCoupling` | 13 ms, 9 ms |
| `fdiff` (existing) | 150 ms |

The music analysis (key, metre, form, motifs, voice use) of 60,000 notes takes under two seconds, and under 80 ms for the largest bundled example (2,190 notes). The tests assert these bounds on CPU time, with a margin of about five, and that four times the input takes at most ten times the CPU time. The cost of a full analysis of a SID tune is the trace and the reconstruction; the analysis traces the tune once, because the trace of the reconstruction is shared through a cache keyed by the tune bytes. On the development tunes (20 s horizon) `analyzeSid`, which includes the reconstruction, used 1.8 to 2.6 s of CPU time.
