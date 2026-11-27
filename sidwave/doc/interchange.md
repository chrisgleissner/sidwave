# Interchange formats

SIDWave scores can be exported to and imported from other formats. Every mapping below lists what maps exactly, what maps approximately and what is lost. No import embeds the source file in the score to fake a lossless round trip: an imported score contains only notes, tempos and metres that SIDWave plays.

All commands read at most 16 MiB, never modify their input, never overwrite the input file, never use the network, and refuse to overwrite an existing output without `--force` (imports and `render`; `render` checks every target before it writes any). Parsers bound their work (see each section). Exit codes and the `--json` envelope are those of the command line (`{ ok, command, result | error }`): a malformed or unreadable input file is exit 3 (`input`), a refused score for stems is exit 5 (`limit_exceeded`), a usage mistake is exit 2.

```
sidwave export <file> [--format events|midi|musicxml|goattracker|furnace|vice-dump|swm|swi] [--instrument <name|n>] [--pattern-rows 16|32|64] [-o <out>] [--song <n>] [--ppq <n>] [--bend] [--seconds <s>] [--json]
sidwave reconstruct <trace> [--from vice-dump|siddump] [--clock PAL|NTSC] [--seconds <s>] [--title <text>] [-o <score.yaml>] [--json]
sidwave import <file> [--format midi|musicxml|goattracker|furnace|swm|swi] [-o <out.yaml>] [--grid <beats>] [--voices 1-3] [--song <n>] [--subtune <n>]
                      [--no-drums] [--no-bend] [--title <text>] [--mode PAL|NTSC] [--no-validate] [--force] [--json]
sidwave render <score> --stems [-o <dir>] [--force] [--seconds <s>] [--rate <hz>] [--engine residfp|sidlite] [--model 6581|8580] [--song <n>]
```

Library entry point: `sidwave/export` (`exportEvents`, `exportMidi`, `importMidi`, `exportMusicXml`, `importMusicXml`, `parseGoatTracker`, `writeGoatTracker`, `importGoatTracker`, `exportGoatTracker`, `parseFurnace`, `writeFurnace`, `importFurnace`, `exportFurnace`, `parseSmf`, `writeSmf`, `renderStems`, `writeWav`).

Speed: every importer and exporter is linear in the input (maps, sorted arrays and one forward pass; no repeated scans). `test/interchangePerformance.test.mjs` bounds the CPU time (`process.cpuUsage`) on large allowed inputs. Measured on a loaded machine: MusicXML export of 1500 bars 0.41 s, MusicXML import of 2.1 MB 0.63 s without validation, a 56 KB file 0.19 s with SIDWave validation; GoatTracker import of 16,256 rows by 3 channels 0.13 s, small song 0.05 s with validation; Furnace import of 16,384 rows by 3 channels 0.11 s, export of 300 bars 0.16 s. Validation (compiling the result) is the largest part of the import time of a very large score; `--no-validate` skips it.

## Structured event export

`sidwave export score.yaml` (or `--format events`) writes JSON with the schema `sidwave.events/1`.

| Field | Meaning |
| --- | --- |
| `ppq` | Ticks per quarter note (default 480, `--ppq`). |
| `callRate` | Player calls per second. All times are exact multiples of one call. |
| `tempoMap[]` | `{ tick, time, bpm }`. A tempo ramp (`tempo: { to: n }`) has one entry per beat and one at each note start inside the ramp; each entry inside a ramp holds the mean tempo up to the next entry, so the stepped map reproduces the exact time of every entry. Between entries the real tempo deviates from that mean, so a position that is not an entry (a note end) can differ by a small fraction of the interval (below 30 ms for a 60 to 200 BPM ramp over 4 bars in the tests). |
| `timeSignatures[]` | `{ tick, time, bar, numerator, denominator }`, one per change of section metre. |
| `sections[]` | `{ index, name, bar, bars, tick, time }`. |
| `instruments[]` | The compiled instruments the notes use: waveform, ADSR, pulse width, vibrato (`depthSemitones`, `rateHz`, `delayCalls`), arpeggio, slide, ring, sync, filter routing and whether wave, pulse or filter tables are present. `name` is the score name when a note names one. |
| `voices[]` | `{ index, id, name, role, sid, channel, kind: pitched or drums, notes[] }`. Echo and follow copies are voices like any other. |
| `voices[].notes[]` | `{ id, voice, pitch (MIDI), velocity, velocityBasis, instrument, on: { tick, time }, off: { tick, time }, durationTicks, percussion?, drum?, effects? }`. |
| `events[]` | Time-ordered `noteOn`, `noteOff`, `tempo`, `timeSignature` events. At one tick: tempo, time signature, note-offs, then note-ons. |
| `losses[]` | What this score's export leaves out. |

`effects` holds `legato`, `accented`, `bend` (`from`, `to`, `seconds`: a portamento, bend or `slide_from`), `gateOffSeconds` and `chord` (`offsets`, `callsPerStep`: an arpeggiated chord, exported as its root note).

Exact: note pitch, order, voice assignment, section structure, tempo and metre. Times are the player's own frame times, so they include swing and the frame rounding of the player. Ticks come from those times, snapped to a 1/24-beat grid when they are within half a player call of it, so that notes on the grid have grid ticks. Approximate: `velocity`, a proxy for loudness. It is `round(127 * sustain/15 * chipVolume/15)` where sustain is the note's effective sustain level (the instrument sustain, scaled by voice, pattern and section levels and accents) and the chip volume is the SID volume at the note (1 when unset). Notes with sustain 0 (percussion and transients) get `velocityBasis: "default"` and `round(100 * chipVolume/15)`. Not exported: digi samples, sound effects, filter, pulse width modulation and wavetable changes (the instrument table says they exist), silent notes that only drive a sync or ring source, the release tail after a note's end.

## Standard MIDI File

Export writes format 1. Import reads format 0 and 1; format 2 (independent sequences) is rejected with an error. SIDWave contains its own reader and writer (`parseSmf`, `writeSmf`, no dependency). The tests verify the output with the independent `midi-file` parser (MIT, dev dependency only).

### Export

`sidwave export score.yaml -o score.mid [--bend] [--song n] [--ppq n]`

| SIDWave | MIDI |
| --- | --- |
| Title, author | Conductor track name (`FF 03`), copyright (`FF 02`). |
| Tempo (and tempo per section, ramps) | Tempo events in the conductor track (`FF 51`). A ramp is stepped as described for the event export. |
| Section metre | Time signature (`FF 58`) at the section start. |
| Section names | Marker events (`FF 06`). |
| One voice | One track (named `v<id> <name>`) and one channel. Pitched voices take the channels 1-9, 11-16 in order; drum voices use channel 10. With more than 15 pitched voices, voices share channels and the export says so. |
| Note | Note on and off at the exported ticks, velocity as above. Ties are merged into the note. |
| Instrument | Program change before the first note and whenever the instrument changes, from the table below. |
| Drum hit | Channel 10, key from the drum name (library: kick 36, snare 38, clap 39, hat 42, open hat 46, tom 45, crash 49; other names by keyword; unknown names play as 38 and the export says so). |
| Bend, slide and vibrato (only with `--bend`) | Pitch bend, with the bend range set to 12 semitones through RPN 0. A glide runs from its start pitch to the note pitch over its duration. A slide from `fx.slide` starts `depth` semitones below the note. Vibrato is a triangle of `depth` semitones at `rate` Hz after `delay` calls. Bend is reset to centre after the note. |

Program mapping. Library instruments: `bass_pluck` 34, `filter_bass` 39, `lead_pwm` 81, `chip_arp_major` 81, `chip_arp_minor` 81, `bell_ring` 15, `sync_lead` 82, `pad_slow` 90, `octave_bass` 40, `wide_pwm_pad` 91, `pluck_arp` 47, `noise_lead_attack` 82 (1-based GM numbers; the file stores them minus one). Other instruments by role, then by waveform: role bass 39 (saw), 34 (triangle), 40; role pad 90 or 91; role arp 81; noise 121; saw 82; triangle 80; pulse 81.

Losses (always listed in the command's `losses`): ADSR, waveform, pulse width and its modulation, ring modulation, sync, filter, wavetables and hard restart; the note length is the written length, not the gate time; without `--bend` all pitch movement; vibrato fade and the exact slide timing are approximated with `--bend`.

### Import

`sidwave import tune.mid -o tune.yaml [--grid 0.25] [--voices 3] [--no-drums] [--no-bend]`

The result is a SIDWave 1.3 score for one SID (at most 3 voices), validated by compiling it. The report lists everything below that happened to this file.

* **Tracks to voices.** A part is the notes of one channel in one track. The percussion channel (10) is a drum part. Parts are ranked by importance, `notes x (1 + pitch range in octaves)`, the highest first. One drum voice is allocated first (it is always `v3` or the last voice), then melodic parts by rank until `--voices` voices exist. Remaining parts are listed in `droppedParts` with the reason.
* **Monophony.** A SID voice plays one note at a time. When notes of a part overlap, the highest note wins, except in a part whose median pitch is below C3 (MIDI 48): that part is a bass and the lowest note wins. A held note stays unless a winning note starts; an equal pitch retriggers. `droppedPolyphony` and `truncated` count the effects.
* **Range.** Notes are moved by octaves into the playable range C0 to the highest note of the system. `octaveShifted` counts them.
* **Instruments.** GM program of the part, by family: pianos `keys` (pulse), chromatic percussion `mallet` (triangle), organ `organ` (pulse), guitar `guitar` (pulse), bass `bass` (saw), strings `strings` (saw), brass `brass` (saw), reed and pipe `wind` (triangle), synth lead `lead` (pulse), pad `pad` (triangle), synth effects `pluck` (pulse); anything else and parts without program `lead`. A low part without program uses `bass`.
* **Drums.** Percussion keys map to the library drums (kick 35 36; snare 37 38 40; clap 39; toms 41 43 45 47 48 50; crash and ride 49 51 52 53 55 57 59; open hat 46; closed hat 42 44 54 56 69 70 80 81). Only one hit per grid cell plays; priority is kick, snare, clap, tom, crash, open hat, hat. Other keys and lower-priority hits are counted in `droppedHits`. Drum velocity is not imported.
* **Quantisation.** Onsets and note ends are rounded to the grid (`--grid`, in quarter notes, default 0.25 = a sixteenth in 4/4; it must divide every bar). `quantisation` reports the largest and mean onset error in ticks and the largest in milliseconds, the number of notes that moved, and the largest note-end error. Note lengths are whole cells, so staccato and legato articulation is not preserved; gaps up to the next onset are rests.
* **Velocity.** Velocity maps to the SIDWave `level` of a note (`round(15 x velocity/127)`, 1 to 15). The most common level of a voice is the voice level; a note carries its own level only when it differs. A level scales the sustain of an instrument, so it has no effect on instruments with sustain 0.
* **Tempo map.** The tempo at the start of each bar is the tempo of that bar. A tempo change inside a bar takes effect at the next bar line (`tempoChanges.movedToBarLine`). Tempos are clamped to 30-220 BPM (`clamped`). Sections break at every change of tempo or metre and after 4 bars.
* **Time signatures.** 2/4, 3/4, 4/4, 5/4, 6/8, 7/8, 9/8 and 12/8 map to the same SIDWave metre. A signature with another number of beats per bar maps to the SIDWave metre with the same bar length when there is one (for example 6/4 to 12/8); otherwise the import fails. A signature that is not on a bar line starts at the next bar line.
* **Pitch bend.** With the bend range of RPN 0 (default 2 semitones), a bend at the start of a note shifts its written pitch to the nearest semitone. A bend inside a note that ends at least one semitone away from the start becomes a SIDWave `bend` (`to` in semitones, `frames` from the last bend event). Bend that returns to its start pitch (vibrato) and other bends are not imported (`bendsLost`).
* **Not imported:** controllers other than the bend range, aftertouch, SysEx, text other than track names, the note release velocity, drum velocity, polyphony, more than three voices, SMPTE time division. File size (8 MiB), tracks (256), events (2,000,000), ticks (2^31), bars (2048) and grid cells (400,000) are bounded, and the parser reports malformed files as errors.

## MusicXML

Uncompressed partwise MusicXML (`.musicxml`, `.xml`). SIDWave reads and writes it with its own bounded XML reader (`parseXml`, no dependency). The tests verify the output with the independent `fast-xml-parser` (MIT, dev dependency only).

Reader limits (untrusted input): at most 16 MiB; elements nested at most 64 deep; at most 1,000,000 elements and 64 attributes per element; at most 2,000,000 notes, 2048 bars and 400,000 grid cells. Only the five predefined XML entities and numeric character references are decoded. A `DOCTYPE` with an internal subset (where entities are declared) and any other entity reference are rejected; the external DTD named by a `DOCTYPE` is never fetched. Compressed `.mxl` (zip) files are rejected with a message that asks for an uncompressed export (no zip reader without a new dependency). `score-timewise` is rejected.

### Export

`sidwave export score.yaml -o score.musicxml [--song n] [--ppq n]`

| SIDWave | MusicXML |
| --- | --- |
| Title, author | `work-title`, `creator type="composer"`. |
| One voice | One `part` (named `v<id> <name>`), one `voice` 1 inside it. |
| Section metre | `time` (beats, beat-type) at the first measure of each section with a new signature; measures are one bar of the section metre. |
| Tempo (sections, ramps) | `direction` with `metronome` and `sound tempo` in the first part, at the tick of each tempo-map entry; a note that spans a tempo change is split into tied notes. |
| Section names | `rehearsal` directions in the first part. |
| Note | `note` with `pitch` (sharps), `duration` in divisions (`divisions` = ticks per quarter note, default 480; there is no `type`), `tie`/`tied` where a note crosses a bar line or a tempo change. Rests fill the gaps. |
| Velocity | `dynamics` attribute of the note, `velocity / 90 x 100` (MusicXML defines 100 as MIDI velocity 90). |
| Instrument | One `score-instrument`/`midi-instrument` per distinct GM program in the part (program table as for MIDI), referenced by each note. |
| Drum hit | `unpitched` note with a `midi-unpitched` key (GM percussion key + 1) per drum name; the part uses the percussion clef. |

Exact: pitch, order, voice assignment, bar structure, tempo and metre at bar lines. Approximate: velocity. Lost: ADSR, waveform, pulse width, ring, sync, filter, wavetables, bend, glide, slide, vibrato, the note type (the duration is exact in ticks but is not engraved as quarter or eighth note), key signature (always C major).

### Import

`sidwave import tune.musicxml -o tune.yaml [--grid 0.25] [--voices 3] [--no-drums]`

Voice allocation, monophony (skyline: highest note wins, lowest in a part with a median below C3), range, quantisation, tempo-per-bar and time-signature rules are those of the MIDI import. Differences:

* Parts are the unit of allocation (instead of MIDI track and channel). A part with more unpitched than pitched notes is a drum part; its hits map through the `midi-unpitched` key of the note's `instrument` in the part list (hits without a key are counted in `droppedHits`).
* Instruments: the `midi-program` of the note's `instrument`, else of the part's first `midi-instrument`, by the GM family table; a bass part without program uses `bass`. A note carries `inst` only when its program differs from the voice's most common one.
* Positions come from `duration`, `backup`, `forward` and `chord`; `divisions` can change per measure. Ties merge notes of equal pitch. Transposition (`transpose`: `chromatic` and `octave-change`) is applied, so notes are imported at sounding pitch.
* A first measure marked `implicit="yes"` that is shorter than its bar (a pickup) is padded with a rest at its start, with a warning. A measure whose content differs from its time signature produces a warning.
* Tempo comes from `sound tempo` or `metronome` (beat-unit and dots); a tempo inside a bar takes effect at the next bar line. Level comes from the `dynamics` attribute (`velocity = 0.9 x dynamics`; 127 without it).
* Not imported (always in the report): grace notes, cue notes, unpitched notes in pitched parts, repeat signs and endings (measures play once as written), dynamics marks, articulations, slurs, ornaments, lyrics, key signatures, clefs, additive or free time signatures (an error), polyphony, more than three voices.

## GoatTracker

`.sng` song files of GoatTracker 1.x (`GTS!`), GoatTracker 2.0 beta (`GTS2`) and GoatTracker 2.x (`GTS3`, `GTS4`, `GTS5`) import through one path: the parser converts every version to the GTS5 model exactly as the loader of GoatTracker 2.77 does (`src/gsong.c`), and the importer works on that model. Export writes GTS5. Sources: upstream GoatTracker 2.77 (SourceForge, `GoatTracker_2.77.zip`, SHA-256 `96c2bd6a6ab3aca2f5bb18b1c764ac6ea69ac245cae14002a72cd87c554561ef`, GPL-2.0-or-later). Only file layout and conversion rules are used; no source is copied. The fork `leafo/goattracker2` (commit a78e7e5, 2013, MIDI note input) has the same `.sng` loader (magics `GTS3` to `GTS5`, `GTS2`, `GTS!`) and no `gt2reloc`, so the differential check uses upstream 2.77 (`gt2reloc` built with `-U_FORTIFY_SOURCE -fno-stack-protector`, which the 2.77 sources need on current compilers).

Input bounds: 256 KiB per file (the largest file GoatTracker writes is about 125 KB), at most 32 songs, 63 instruments, 208 patterns of at most 128 rows, tables of at most 255 entries. A truncated file is an error (GoatTracker itself zero-fills). The import expands the first pass of each order list; at most 100,000 rows per channel.

### Import

`sidwave import tune.sng -o tune.yaml [--song n] [--mode PAL|NTSC]`

| GoatTracker | SIDWave |
| --- | --- |
| Song name, author, copyright | Title, author, a comment line. |
| Channels 1 to 3 of the chosen subsong (`--song`, 1-based) | Voices 1 to 3. |
| Order list: patterns, REPEAT, TRANSPOSE | Expanded into one grid cell per pattern row. Transposition is applied to the notes. LOOPSONG ends the import; a loop to a position other than the start is reported (SIDWave loops the whole timeline). |
| Row length (tempo, in player calls) | The grid has 4 rows per beat (2, 8 or 1 when a tempo would leave 30 to 220 BPM). `tempo = 60 x frame rate / (rows per beat x calls per row)` for each bar (125.31 BPM for the default 6 calls on PAL). Funk tempo is played with the average row length. |
| Note, rest, key off | Note, tie, rest. Tone portamento notes are played as new notes. Notes are moved by octaves into the playable range. |
| Instrument | A SIDWave instrument per instrument used: ADSR, wavetable (waveform bits, gate, ring, sync, test, relative and absolute note steps, delays, loop), pulse table (set and add steps, loop), filter table (set, cutoff and add steps, type, resonance), vibrato (approximated as a triangle in semitones at C4) and hard restart (gate timer, or off when its no-hard-restart flag is set). |

Approximate: the first frame of a note (GoatTracker applies the first waveform and not the wavetable pitch on tick 0; the importer starts the wavetable on the first frame), the vibrato depth (GoatTracker's depends on the note), filter cutoff (8 bit to 11 bit by a shift of three), the filter routing (GoatTracker's filter is global and routes the channels named in the filter control byte; SIDWave routes the voice of the instrument that starts the table), relative wavetable offsets (limited to the range of the notes the song plays on the instrument), and tempo changes that are not on a bar line (the rows in between keep the earlier row length).

Not imported (counted in `commands` and `losses`): pattern commands other than tempo (portamento, vibrato, set AD, SR, waveform, wavetable, pulse and filter pointers, filter control and cutoff, master volume), per-channel tempo, wavetable command steps, loops to other than the start, the per-channel differences in order list length (shorter channels are padded with rests), and the instrument names beyond their use as score names.

Per-version conversions reported in `report.conversions`: `GTS!` (GoatTracker 1.x instruments, pulse parameters turned into a pulse table, the filter table rebuilt, patterns of three bytes, old arpeggio parameters turned into wavetables, portamento and vibrato parameters into the speed table), `GTS2` (three tables, the speed table made on load), `GTS3` (pulse speeds doubled, legato and no-hard-restart flags derived), `GTS4` (flags derived), `GTS5` (none).

### Export

`sidwave export score.yaml -o song.sng`

Writes GTS5 for the first three voices of the first SID. The row length is the largest number of player calls from 3 to 12 at which every note start and end is within one call of a row (the result reports `ticksPerRow` and `maxTimingErrorCalls`); a tempo command sets it. Patterns have 64 rows and identical patterns are shared. Instruments: ADSR, waveform, ring and sync bits, a fixed pulse width in a pulse table, arpeggios as wavetable steps, hard restart 2 calls. Lost: filter, vibrato, slides, glides (plain notes), pulse width modulation, volume levels, wavetables other than arpeggios, notes beyond three voices, two notes on one row.

### Differential check against gt2reloc

`test/interchangeGoatTracker.test.mjs` runs `gt2reloc` (upstream 2.77, `GT2RELOC` or `~/.c64bridge/sidwave-standalone/tools/goattracker2-upstream-2.77/linux/gt2reloc`; the tests skip without it) on a hand-authored file of each version (`GTS!`, `GTS2`, `GTS3`, `GTS4`, `GTS5`, built byte by byte in `test/helpers/gtFixtures.mjs`), on the SIDWave export, and on five of the example songs, and compares the PSID with the one compiled from the imported (or original) score. The loader of `gt2reloc` converts the older formats, so each version is also a test of the importer's conversion.

Alignment: the GoatTracker player starts every channel one row late (its call counter starts at one row, a row being tempo + 1 = 6 calls with the default tempo value 5) and sets the note pitch from the wavetable one call after the note starts, while the SIDWave player plays its first note on call 0. The reference therefore lags by `ticks per row + 1` calls (7 calls, 143 ms, at the default 6). The tests derive the expected shift from the song's initial ticks per row and assert that a search over -12 to 12 calls finds it (within one call on the example songs).

Results on the hand-authored files (six seconds, SIDLite trace, pinned shift): the gate agrees in 98 % and 100 % of the calls of voices 1 and 2 and the note (in semitones) in 95 % and 98 %, for all five versions. The export direction gives gate 94 % and 97 %, note 94 % and 98 %. On the example songs (eight to ten seconds; gate / note agreement of voices 1/2/3, and the share of A1 windows outside the thresholds): dojo 1.00/0.98/0.98 and 1.00/0.67/0.67, 39 %; consultant 1.00/1.00/1.00 and 0.98/0.99/0.95, 15 %; sanction 0.97/0.97/0.98 and 0.97/0.89/0.72, 57 %; funktest 0.99/0.80/0.99 and 0.88/0.70/0.34, 32 %; transylvanian 0.93/0.93/0.99 and 0.50/0.93/0.89, 60 %; 2xtest (checked once, not in the test) 0.99/0.96/1.00 and 0.82/0.40/0.00, 61 %. The ladder: T0, T1 and A0 fail on every file (the players run different code and the frequency table of GoatTracker differs from the SIDWave table, so register values differ even for equal notes); A1 is evaluated with the open ROMs and fails on every file, status approximate. The F-diff class match shares on the fixtures after alignment: waveform 0.92 to 0.98, adsr 0.81, volume 0.95, timing 0.83 to 0.95, gate 0.67 to 0.88, filter 1.0, pitch and pulse about 0.

What the results support: on simple songs the gate (rhythm) agrees closely and the note mostly; on songs with wavetable arpeggios, drums and vibrato, note agreement falls to between 0 % and 99 % per voice and the sound differs (A1 fails). The tests require gate agreement of at least 90 % on the fixtures and 75 % on the example songs, and print the other figures.

The 14 example songs of GoatTracker 2.77 (all `GTS5`) import without error (not committed; the test reads them from the local tool directory when present).

## Furnace

`.fur` modules (C64 chip only: 6581, chip id 0x47, and 8580, 0x07). Import reads zlib-compressed and uncompressed files of format version 157 (Furnace 0.6pre6) and later: the `INFO` header (versions 157 to 239) and the `INF2` header (240 and later). Older versions, other chips (and modules with more than one chip) are errors that say what to change. Export writes format version 228 (Furnace 0.6.8.1), uncompressed; newer Furnace versions load older formats. The layout is taken from `papers/format.md` and `papers/newIns.md` of the Furnace repository.

Input bounds: 16 MiB file, 32 MiB after decompression (`zlib` with `maxOutputLength`; a compression bomb is an error), 256 instruments, 65,536 patterns, 256 rows by 256 order positions, at most 100,000 rows.

Verification status: the reader and writer are tested against modules built byte by byte from the specification in `test/helpers/furFixtures.mjs` (versions 228 and 240, compressed and uncompressed) and by writing and reading back. No Furnace program or command-line converter is installed on this machine, so no module written by SIDWave has been loaded by Furnace itself. The order table is channels-outer (all positions of channel 1, then channel 2, as `fur.cpp` reads and `song.cpp` writes it), and a pattern row's effect bytes follow one combined effect mask in bit order; both were checked by a review against the Furnace source. The macro header length of 8 rests on the specification text alone. Treat the export as untested against Furnace until a module has been opened in it.

### Import

`sidwave import tune.fur -o tune.yaml`

| Furnace | SIDWave |
| --- | --- |
| Song name, author | Title, author. |
| Channels 1 to 3 | Voices 1 to 3 (first subsong only; the count is reported). |
| Orders, patterns | One grid cell per row. Jumps and other flow effects are not followed. |
| Speed (ticks per row) and tick rate | The mean of the speed pattern gives the row length in seconds; 4 rows per beat (2, 8 or 1 when the tempo would leave 30 to 220 BPM). |
| Note, note off, release | Note (MIDI = note - 48, so 108 is C-4), tie, rest. |
| Volume column | Level of the following notes (0 to 15, at least 1). |
| C64 instrument | ADSR, waveform bits, pulse width (duty), arpeggio and waveform macros as a wavetable (the macro speed as frames per step, the loop), duty macro as a pulse table. |

Lost (in `losses`): all effect commands (counted), subsongs after the first, ring modulation and sync flags, the filter, other macros, panning, wavetables, samples, the patchbay, and instruments that are not C64 instruments (a plain pulse instrument is used). Macro steps count Furnace ticks and SIDWave steps count player calls, which run at different rates.

### Export

`sidwave export score.yaml -o song.fur`

First three voices of the first SID; the row length is chosen as for GoatTracker (1 to 12 ticks at the call rate of the score as tick rate). Instruments: ADSR, waveform, duty, ring and sync flags, arpeggio as an arpeggio macro. Lost: filter, pulse width modulation, vibrato, slides, levels, wavetable steps other than arpeggios, hard restart settings, more than three voices, two notes on one row. The writer emits no effect commands (no speed, tempo or volume effects).

## WAV and stems

`sidwave render` renders the mix through the libsidplayfp engine (the optional `libsidplayfp-wasm` package) as a 16-bit mono WAV. `--engine sidlite` selects the fast SIDLite model (default `residfp`; `--emulation` is an alias), `--model` forces the SID model, `--seconds` and `--rate` set the length and rate (default 48000 Hz; `--sample-rate` is an alias). `--song` is 1-based like the other run commands.

`sidwave render score.yaml --stems -o dir` (`-o -` is refused; the default directory is `<name>-stems`) writes `<name>.mix.wav`, one `<name>.v<id>.wav` per voice and `<name>.stems.json`. Each stem is a compile of the score in which the layers of all other voices are rests, rendered through the same player. The idle SID is not silent in the emulation (a constant offset for each voice and the master volume), so a score with every voice muted is rendered as well and subtracted from the stems; a stem holds only what its voice adds. A voice that echoes, follows or doubles another voice cannot be separated from its source and is rendered together with it (`voices` in the manifest lists both).

The manifest labels the stems `additive: true` or `false`. Stems are non-additive when voices influence each other, which the tool detects from the score: the SID filter in use (a filter table, a filter owner, `filter_env` or `filter_mod`; the routed voices share one filter), ring modulation, hard sync, and copies of other voices. `additive` is true only when nothing couples the voices and the measured energy ratio is within the tolerance: the summed energy of the stems must be within 15 % of the energy of the mix after removing the baseline. The manifest records `energyRatio` and `energyWithinTolerance` (measured on SIDLite: 0.97 for a three-voice test score); a score without coupling whose ratio is outside the tolerance is labelled non-additive. The check is an energy heuristic. It compares summed energy only, so it cannot detect voices whose waveforms are phase-correlated (for example identical or inverted voices) in a way that makes the summed energy of the stems match the energy of the mix while the samples differ. They do not add up sample by sample. A muted voice makes the play call shorter, so the register writes of the voices after it land a few hundred cycles earlier in the call, which shifts oscillator phases (relative RMS difference 0.3 to 0.4, reported as `sumError.relativeRms`). Scores with digi samples (the PSID player omits them) and scores with more than three SIDs are refused.

The tests check the WAV header and samples with the independent `wavefile` parser (MIT, dev dependency only).

## Register traces: VICE dump and siddump

A trace is a list of SID register writes with cycle numbers. `sidwave reconstruct <trace> --from vice-dump|siddump` feeds it into the same pipeline as `sidwave reconstruct <file.sid>`: recover a score, compile it, trace the compiled score with the engine and compare both traces call by call (F-diff). The trace file is not played; the report compares the imported writes with the recompiled score. `--clock` (default PAL) sets the CPU clock, which the files do not contain. `--seconds` (default: the length of the trace, at most 180; limit 600) is the compared horizon. The exit code follows `report.strictExact` as for a SID file.

### VICE dump (`--from vice-dump`)

`vsid -console -warp -silent -limit <cycles> -sounddev dump -soundarg out.txt tune.sid` writes one line per SID write: `<cycle delta> <register> <value>`, decimal, single spaces. The delta counts cycles since the previous write. The parser reads exactly this and also accepts CR LF line ends and blank lines. Status: exact (every write, its value and its cycle).

- The format has no chip number. Checked with VICE 3.10 on a two-SID tune: writes to `$D404` and `$D424` both appear as register 4. A multi-SID tune therefore imports as one SID with the writes of all chips merged. The export refuses a trace with writes to more than one SID for the same reason.
- Registers 25 to 31 are accepted and counted in `ignoredWrites`; they are not part of the trace.
- Limits: 4,194,304 writes (the engine's trace limit), 12 digits per number, a delta of at most 2^32 cycles, 16 MiB per file. Malformed lines are exit 3 with the line number.
- A vsid 3.10 dump starts with a small delta (342 cycles in the test file) and the SID writes of the tune's own start-up; the first lines are the volume write and the reset sequence of the player, not a header. Cycle 0 is the start of the dump. A reconstruction from a dump and one from the same SID file recover the same notes (36 notes for the test tune over 18 s); the compared calls differ by a few calls because the two emulators start the tune at different cycles.

### VICE dump export (`sidwave export score.yaml --format vice-dump`)

Compiles the score (no loop), traces it with the engine for `--seconds` (default: the score length, at most 600) and writes the writes in the VICE text format, so that desidulate and similar tools read it. Status: exact for the writes the engine produces. The cycle numbers are the engine's, not those of a VICE run. Scores with more than one SID are refused (see above).

### siddump (`--from siddump`)

Reads the table printed by siddump V1.11 (Cadaver, BSD-3): `| Frame | Freq Note/Abs WF ADSR Pul | ... | FCut RC Typ V |`, with the frame column as a number or as `m:ss.ff` (option `-s`). A column holds a value only when it changed; the parser keeps the other values. Status: approximate.

Mapping: each row is one call at `frame * cycles per frame`. A printed field becomes the register writes of that field: frequency (`$D400/1`), pulse width (12 bit), control register, AD and SR for each voice, then filter cutoff, `$D417` and `$D418` (filter mode from the `Typ` column, volume from `V`). Inside a call the writes are in the order ADSR, frequency, pulse width, control register, filter, 8 cycles apart.

Lost: the order and cycles of writes inside a frame, so hard-restart sequences and test-bit pulses; gate pulses shorter than a frame; writes that do not change a value; `$D418` bit 7 (voice 3 off), the low five bits of the cutoff (siddump prints `$D415 << 5 | $D416 << 8`) and the note names (frequencies are used). The report marks the trace as approximate and the strict F-diff compares the invented in-frame order with the recompiled score, so a siddump reconstruction is not expected to reach `strictExact`. Limits: 1,000,000 rows, rows must have increasing frame numbers, the table must have the fixed column layout of siddump (low-resolution mode `-l` is accepted).

## SID-Wizard (`.swm`, `.sws`, `.swi`)

SID-Wizard (Hermit Software) is a C64 tracker. A module has three tracks, an orderlist (sequence) per track, patterns shared between the tracks, instruments with a waveform/arpeggio table, a pulse table and a filter table, chords and tempo programs. SIDWave reads and writes the 1.x file layout described in SID-Wizard's `SWM-spec.src` (SID-Wizard declares itself WTF-licensed in its README; the format layer is written from that description and from reading the packer and player sources, no code is copied). Header identifiers: `SWM1` (one SID), `SWMS` (stereo, two SIDs, six sequences per subtune). Limits: the writer keeps to the editor's (`SWM-spec.src`: 8 subtunes, 100 patterns, 37 instruments); the reader also accepts the theoretical limits that other tools use (32 subtunes, 127 patterns, 62 instruments), 255 rows per pattern, 126 bytes per orderlist, 64 KiB per file. Larger counts, unexplained bytes between the header and the data, rows that do not add up to the pattern length and truncated data are exit 3 (`input`).

### Import (`sidwave import file.swm [--subtune n]`)

`.swm`, `.sws` and `.swi` are detected by the identifier at offset 2 or the extension. The module is walked in player calls, as the player does: each track follows its orderlist (patterns, transposition `$80-$9F`, track tempo `$B0-$EF`, separators, end `$FE`, jump `$FF`), rows last as many calls as the tempo state says (subtune tempo or funk tempo, tempo programs, big effects `$10-$15`), and the first revisit of an orderlist position ends the track (`endedBy: "jump"`; the loop point is not imported, SIDWave loops the whole song). Rows are placed on a grid whose cell is the greatest common divisor of all row lengths, merged until a note lasts at least the 3 frames SIDWave needs. The tempo is exact (calls per cell fix the beats per minute; `cellBeats` picks 1/16 to 2 beats so that the tempo lies in 60 to 200). SIDWave plays at most 600 seconds of a module (`maxSeconds`).

| SID-Wizard | SIDWave | Status |
| --- | --- | --- |
| Note 1 to 95 (C-0 to A#7), orderlist transposition, instrument octave shift | Note (MIDI 12 to 106, moved by octaves when outside the compiler's range) | exact; note starts land on the same call as in the stock player when the grid is not merged (see below) |
| Instrument column 1 to 62 | Instrument of the voice or `@name` on the note; the voice's most used instrument is the voice default | exact |
| `$3F` in the instrument column (legato) | `legato: true` | approximate |
| Note effect gate off (`$7E`) and gate on (`$7D`) | Rest or tie, and a new attack of the same pitch | exact |
| Frame speed 1 to 8 | `speed` | exact |
| Subtune tempo, funk tempo, tempo programs, track tempo | Tempo from the grid; alternating rows are placed on the common grid | exact for one constant tempo, approximate when tempos alternate or change |
| Instrument ADSR | `adsr` | exact |
| Waveform table: waveform and gate/test/ring/sync bits per row, row speed, repeat rows, absolute notes, relative pitch steps | `wavetable` (`wave`, `gate`, `ring`, `sync`, `test`, `note`, `calls`, `loop`) | approximate; pitch steps that leave the playable range for the highest note played with the instrument are dropped, then the table (reported per instrument) |
| Pulse table: set rows, add rows, jump | `pulse_width`, `pulsetable` | approximate (add amount is read as a signed byte per call) |
| Filter table: set (band, resonance, cutoff high byte), add rows, jump | `filtertable` (cutoff = high byte x 8) | approximate; type 3 (low and band pass) is played as low pass; the filter switch is not imported |
| Hard restart (timer, restart ADSR, test bit) | `hard_restart` | approximate |

Lost (always listed in `report.losses` when present in the file): instrument vibrato, default chord and chord effects, detune, pulse and filter keyboard tracking, note-column vibrato, portamento, sync and ring note effects, small effects in the instrument and effect column (volume, sustain, release, waveform, ADSR and filter settings), track and note delay (`$1D`, `$1E`), orderlist volume changes, tuning types other than 440 Hz (432 Hz and just intonation are played in equal temperament), subtune jumps (treated as the end of the track), the loop position. `.sws` imports all six tracks as voices 1 to 6 on two SIDs at `$D400` and `$D420`. `.swi` imports one instrument and a score that plays it once at C4.

Verification against the SID-Wizard player. The SID-Wizard repository ships 41 modules (40 `.swm`, 1 `.sws`) and 324 `.swi` instruments, and 26 SID files that SID-Maker (the real player) made from some modules. Reader: all 41 modules and all 324 instruments parse, and the writer reproduces every file byte for byte, header included (unmodelled header bytes are kept). Import: 38 of 41 modules and all 324 instruments convert; refused with exit 3 are `lenore.swm` (the player needs more cycles per call than a 1 MHz C64 has at speed 4) and two modules whose waveform tables still leave the playable range after the per-instrument fallback. Differential: only two modules were compared with the player, `echo-test` and `bronkosaurus` (20 s each).

- Alignment is fixed, not searched. The player reads a row at tick 0, spends tick 1 on the first hard-restart phase and writes the note at tick 2 (`player.asm`: `TICK_0`, `TICK_1`, `TICK_2`), so a note starts 2 calls after the call that starts the imported score's note. That offset gave 185 of 185 note starts on the same call for `bronkosaurus`. The `echo-test` SID is built with the echo player, which writes the volume register in several short calls per frame; possibly the reconstruction groups them differently. The measured offset is 3. The extra call is not derived from the player source; it is reported as measured, and the test uses 3 for that file.
- Pitch is sampled 8 calls after each note start, after the instrument's arpeggio or waveform table has settled: 144 of 149 (97 %) for `echo-test` and 151 of 185 (82 %) for `bronkosaurus`. The remaining notes differ because the instrument plays a chord from the chord table (default chord or chord effect), which the import does not read: the stock player's base note is the same but the sounding pitch is an arpeggio step.
- Modules whose rows are shorter than 3 frames (`futuco`, 5 calls at speed 2) are merged onto a coarser grid and match less well.

Status: approximate for sound, exact for note timing on unmerged grids.

### Export (`sidwave export score.yaml --format swm`, `--format swi --instrument <name|n>`)

Writes an SWM1 module for the subset that the format expresses; everything else is listed in `losses` (also printed as `note:` lines). Up to three pitched voices of the first SID, with the notes' pitch (MIDI 12 to 106; others are moved by octaves), start and end as gate-off rows; instruments with waveform (including ring and sync bits), ADSR and the first pulse width; a constant tempo (the greatest common divisor of all note starts and ends in player calls, at most 127 calls per row); orderlists that loop. Patterns hold 16, 32 or 64 rows (`--pattern-rows`) and identical patterns are shared across tracks. The module plays at full volume with the editor's default instrument settings (hard restart timer 2).

Not exported: drum voices, voices beyond three or on another SID, velocity and levels, vibrato, arpeggios, slides, wavetables, pulse and filter tables, filter routing, echo and follow copies, tempo changes and swing, bends and legato. `--format swi` writes one instrument (waveform, ADSR, pulse width) and lists what it leaves out. Scores whose speed is not 1 to 8 calls per frame, with more than 100 distinct patterns, more than 124 patterns per track or more than 37 instruments are refused (exit 3). `.sws` export is not available.

Verification of the export: the exported file is read back by `sidwave import` (same note count, pitches and start times within 30 ms on the test score), and by SWMconvert, the SID-Wizard author's own converter built from its source (`SWMconvert.c`, public domain; the test builds it with `gcc` when the SID-Wizard checkout is present and skips otherwise): it converts the exported module to a MIDI file with the same three tracks, the same 14, 8 and 2 notes with the same pitches and the same relative timing as the score's event export. SWMconvert has no licence text in the repository; it was read and built locally for this check only, nothing from it is part of SIDWave. Player check not achieved: SID-Maker (`exporter.asm`) assembles with 64tass 1.60 (`-D SID_AMOUNT=1 -D SFX_SUPPORT=0 -D SLOWDOWN_SUPP=0 -D SWP_EXPORT=0`) and runs in `x64sc -sounddev dummy` under Xvfb with a remote monitor; its file selector (`*.SWM`, drive 8) came up and read the directory of a d64 image. Two steps failed: the exported file did not appear in the list (the selector filters on the file type name, which a plain c1541 `-write` does not set), and keys written into the KERNAL keyboard buffer through the monitor were not consumed (the program scans `$DC01` directly), so no module was converted. Status: exact for the expressible subset at note level (read back by two independent readers), not verified at register level against the player.
