# Interchange formats

SIDWave scores can be exported to and imported from other formats. Every mapping below lists what maps exactly, what maps approximately and what is lost. No import embeds the source file in the score to fake a lossless round trip: an imported score contains only notes, tempos and metres that SIDWave plays.

All commands read at most 16 MiB, never modify their input, never overwrite the input file, never use the network, and refuse to overwrite an existing output without `--force` (imports and `render`; `render` checks every target before it writes any). Parsers bound their work (see each section). Exit codes and the `--json` envelope are those of the command line (`{ ok, command, result | error }`): a malformed or unreadable input file is exit 3 (`input`), a refused score for stems is exit 5 (`limit_exceeded`), a usage mistake is exit 2.

```
sidwave export <file> [--format events|midi|musicxml|goattracker|furnace|vice-dump|swm|swi] [--instrument <name|n>] [--pattern-rows 16|32|64] [-o <out>] [--song <n>] [--ppq <n>] [--bend] [--seconds <s>] [--json]
sidwave reconstruct <trace> [--from vice-dump|siddump] [--clock PAL|NTSC] [--seconds <s>] [--title <text>] [-o <score.yaml>] [--json]
sidwave import <file> [--format midi|musicxml|goattracker|furnace|mod|jch|swm|swi] [-o <out.yaml>] [--grid <beats>] [--voices 1-3] [--song <n>] [--subtune <n>]
                      [--sids 1-10] [--transpose <n>] [--quality]
                      [--no-drums] [--no-bend] [--title <text>] [--mode PAL|NTSC] [--no-validate] [--force] [--json]
sidwave render <score> --stems [-o <dir>] [--force] [--seconds <s>] [--rate <hz>] [--engine residfp|sidlite] [--model 6581|8580] [--song <n>]
```

Library entry point: `sidwave/export` (`exportEvents`, `exportMidi`, `importMidi`, `exportMusicXml`, `importMusicXml`, `parseGoatTracker`, `writeGoatTracker`, `importGoatTracker`, `exportGoatTracker`, `parseFurnace`, `writeFurnace`, `importFurnace`, `exportFurnace`, `parseCheeseCutter`, `writeCheeseCutter`, `importCheeseCutter`, `exportCheeseCutter`, `parseSf2`, `importSf2`, `exportSf2`, `parseSmf`, `writeSmf`, `renderStems`, `writeWav`).

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

## ABC notation

Read-only subset of ABC 2.1 (`.abc`), through `sidwave convert` and the library function `importAbc`. A file is
detected by an `X:` tune line followed by a `K:` line.

`sidwave convert book.abc tune.mid [--song <X number>] [--grid <beats>] [--voices 1-3]`

`--song n` selects the tune with `X:n`; the default is the first tune of the file. `sidwave info book.abc` lists the
tunes. A tune ends at an empty line, the next `X:` line or the end of the file, and the file header applies to every
tune. The text is UTF-8; any other file is read as Latin-1 (`abc.charset`).

Supported:

| ABC | Handling |
|---|---|
| `T:`, `C:` | first title and first composer |
| `M:` | `n/d`, `(2+3+2)/8`, `C`, `C\|`, `none`; a metre without a SIDWave metre of the same bar length is written as two bars (`3/8` as `6/8`) or as `4/4` (`meter.approximated`) |
| `L:` | and the default from the metre (below `0.75`: `1/16`, else `1/8`) |
| `Q:` | `1/4=120`, several note lengths, text with or without a number, the old forms `120` and `C3=40`; default 120 BPM; SIDWave limits the tempo to 30 to 220 BPM (`abc.tempo.clamped`) |
| `K:` | all keys with up to seven sharps or flats, all modes (three letters count), `none`, `HP`, `Hp`, `exp`, added accidentals, `octave=`, `transpose=`, clefs with `+8` or `-8` |
| `V:` | header and body, `[V:id]`; `octave=`, `transpose=` and `+8`/`-8` clefs |
| Fields in the body | `K:`, `L:`, `M:`, `Q:`, `V:` on their own line or inline. A field line before the first note and the first `V:` applies to every voice, otherwise to the current voice |
| Notes | accidentals, octave marks, lengths such as `2`, `/`, `//`, `3/2`; an accidental lasts to the bar line for all octaves, or as set by `propagate-accidentals` |
| Rests | `z`, `x`, and `Z`, `X` for whole bars |
| Broken rhythm, tuplets | `>` to `>>>`, `(p`, `(p:q:r`; the default `q` follows the metre |
| Ties | within and across bars, in chords and into repeated sections; a tie to another pitch is counted |
| Repeats | `\|:`, `:\|`, `::`, three or more passes (`\|::`), `[1`, `\|1`, `:\|2`, lists and ranges such as `[1,3` and `[1-3`; without `\|:` the repeat starts after the previous repeat or double bar |
| Chords `[CEG]` | the highest note stays in the voice, the others get further voices when there are free ones (`abc.chords`); the length is that of the first note |
| Line ends | `\` continuation, comments, CR, LF and CRLF |

A first bar that is shorter than the metre is a pickup: rest is added before it so that the bar lines of the score
match (`abc.pickup.padded`). Voices keep their own time; a voice with a bar too long or too short drifts against the
others. The metre of the score changes only at a bar line.

Not imported, each with a counted loss: grace notes, decorations, slurs, chord symbols and annotations, lyrics
(`abc.notation.dropped`), unsupported fields, `I:` instructions and `%%` directives (including macros and MIDI
directives, also `abc.notation.dropped`), voice overlays after `&` (`abc.overlay.dropped`) and the part order of `P:`
(`abc.parts.ignored`; the tune plays as written). Voices and chord notes beyond the voice limit are dropped
(`voices.dropped`, `abc.chord-tones.dropped`); the first line of every voice is allocated before any further chord
note. Also counted: grid quantisation (`abc.timing.quantized`; use `--grid` for triplets), notes outside the SID range
moved by octaves, tempo or metre changes inside a bar, titles longer than 80 characters.

Limits (untrusted input): 8 MiB and 500,000 lines per file, 100,000 lines per tune, 4096 characters per field, 64
voices, 32 notes per chord, 200,000 written and 400,000 played notes and rests, 8192 written and played bars per voice,
4096 score bars and 400,000 grid cells, nine passes of a repeat. Parsing time is linear in the input size. Malformed
input raises `AbcImportError` with the line number where one applies.

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

## CheeseCutter

`.ct` song files of CheeseCutter 2.x (revisions 6 and above, the current editor writes 12) import and export. The format is the three bytes `CC2` followed by a zlib stream that holds a 64 KiB C64 memory image (the player, its tables and the sequences) and a trailer (header fields, 32 subtune speeds, titles, instrument labels, and three order lists per subtune). The layout and the player's behaviour were read from CheeseCutter's sources (`src/ct/base.d`, `src/c64/player_v4.acme`, GPL-2.0, upstream `theyamo/CheeseCutter`). No code is copied, and SIDWave contains no CheeseCutter player or song.

`sidwave import song.ct` finds the format by the `CC2` magic or the `.ct` extension. `--song <n>` selects a subtune (1-based, default 1; the report lists how many exist). `sidwave export score.yaml --driver song.ct -o out.ct` writes a song. `--driver` is required. It names either any `.ct` file (its player and layout are reused and its song data is cleared) or the raw CheeseCutter player binary (a PRG with load address `$0E00`, the `player.bin` that CheeseCutter builds). The raw binary path is verified: the test assembles `player_v4.acme` with the ACME sources that ship in the local checkout (compiled with the system C compiler and a 10-line program of our own; skipped when either is missing), exports with that binary and compares the result in the player: gate 1.00/1.00, note 0.91/0.98, best shift 4. The exported file embeds that driver, so the GPL-2.0 licence of the driver applies to the output, as it does to every song CheeseCutter saves. Without `--driver` the command stops and says so.

### Import

The importer follows the player: order list entries (transposition byte `$81`-`$EF` is `value - $A0` semitones, `$80` keeps the last value, `$F0`-`$F7` wraps), the sequence byte stream (instrument `$C0`-`$EF`, duration `$F0`-`$FF`, tie `$5F`, note and command), and the instrument table (AD, SR, restart type and arpeggio delay, restart waveform, filter pointer, pulse pointer, restart SR, wave pointer). Both the editor's four-byte rows and the packed streams the packer writes are read.

| CheeseCutter | SIDWave |
| --- | --- |
| note `3..` | note, MIDI `12 + value + transposition` |
| `---` (value 0) | the note continues |
| `===` (value 1) | gate off, rest |
| tie `5F` with a new pitch | `legato: true` note |
| row duration `F0`-`FF` | rows of one tick each, ties for the remaining ticks |
| song speed `s` (and speed commands `F1`-`FF`) | `s + 1` video frames per row, as the bar tempo; a speed of 0 or 1 reads the speed list of the chord table and averages it per bar |
| multiplier 2..4 | top-level `speed` |
| wave table program | `wavetable` steps found by running the program call by call (waveform, relative or absolute pitch, delays, jumps and loops) |
| chord command `80`-`9F` | the instrument is converted once per chord, the chord table is folded into the wavetable pitches |
| pulse program | `pulsetable` (set, add, frames, jumps); a direct pulse value becomes `pulse_width` |
| filter program | `filtertable` (cutoff, resonance, type, add) |
| restart type | `hard_restart` (frames 2 with the restart ADSR for type `$80`, frames 0 otherwise) |
| vibrato commands (hi-fi and lo-fi) | `vibrato` on an instrument variant: depth and rate from the player's counters, starting at the note |
| slide up and down | `bend` of the note to the pitch the slide reaches by the end of the note (whole semitones, at most 255 frames); not on an instrument whose wavetable sets pitches, because SIDWave rejects that |
| portamento and stop portamento | `portamento` frames from the preceding note's pitch, from the speed and the distance |

Exact for the first six rows; approximate for tables that depend on the note (lo-fi vibrato depth), the filter (global in CheeseCutter, routed per voice in SIDWave), and the bar tempo of alternating speeds (the mean row length of each bar; each row is within one frame of its true start). Lost, and listed in the report with the number of uses: chord and vibrato changes on a note that continues (a SIDWave legato note keeps its instrument), slides on instruments with pitch steps in the wave table, slides under half a semitone, detune, set ADSR, set attack, decay, sustain and release, pulse and filter pointer commands in a sequence, main volume, and the first frame of every note (CheeseCutter writes the restart waveform and the previous pitch on the first frame, SIDWave cannot express the old pitch). A voice that loops back to a position other than the start is reported (SIDWave loops the whole score). If the chord variants of the instruments would exceed the 255 wavetable steps or the 63 instruments of a SIDWave score, the importer repeats the conversion without chords (or without vibrato) and says so in the report.

Input bounds: the file is at most 1,000,000 bytes and inflates to at most 400,000 bytes (CheeseCutter writes 300,000, and every example song inflates to exactly that; the 167,832 in the loader is only the initial size of the buffer it hands to zlib, which grows as needed, so it is not a limit; a larger stream is refused without being fully expanded). The two highlight bytes after the speeds are read only for revisions above 10, as the loader does. Every pointer in the pointer table that the importer follows must leave room for the table it points to. An order list has at most 511 entries (the player's limit), sequences are 256 bytes, there are at most 128 sequences, 48 instruments and 32 subtunes, and at most 100,000 ticks per voice are imported. Stereo songs (revision 128 and above) and revisions below 6 are refused with a message.

### Export

First three voices of the first SID. The row length is the largest frame count from 3 to 12 at which every note start and end is within one frame of a row; the song speed is that value minus one. Sequences are the editor's four-byte rows, 16 rows long (32 or 64 when 128 sequences are not enough), and the last one ends with the song, so the last note keeps its length; identical sequences are shared, so a score whose beats are a whole number of frames long (125.3114 BPM on PAL is 24 frames per beat) repeats them exactly. A legato note that changes the pitch is written as a tie note. Instruments: ADSR, waveform, ring and sync, a fixed pulse width, arpeggios as a wave table loop, and wavetable programs as wave and delay rows; the restart is a two-frame hard restart with zero ADSR. The player writes a restart waveform on the first call of every note, so a wavetable program whose first step has the gate on gives that call to the restart waveform, and the rest of the program plays on the same calls as in SIDWave. Lost, and listed in the report: filter, pulse modulation, vibrato, glides and portamento, levels, volume changes, wavetable offsets below the note (the wave table adds only upwards), wavetable programs that do not fit the 255 rows, more than three voices, two notes on one row. A score that exceeds a capacity of the format (instruments, wave table rows, sequences) exits 5.

### Differential check against the player

`test/helpers/ctDifferential.mjs` turns a `.ct` file into a PSID that runs the player stored in the file (two stubs switch the BASIC ROM out, because the song data lies above `$A000`) and the tests compare its trace with the trace of the compiled SIDWave score. The reference is the real player, not a model of it. The alignment is fixed, not searched: the player spends one call on its own initialisation and one on loading the first sequence, and the gate rises two calls after a row starts (the restart takes two calls), so the player lags by 4 calls. A search over -12 to 12 confirms this (the best shift is -4 on every example song with a constant speed). The tests skip with a message when no CheeseCutter checkout is at `~/.c64bridge/sidwave-standalone/research-src/theyamo_CheeseCutter` (the example songs there are read at test time and are not committed). `ct2util` could not be used as the oracle because no D compiler is installed; the player inside the file is the same code `ct2util` packs.

Results on the 12 example songs of upstream with a multiplier of 1 (8 seconds, voices with at least 50 comparable calls for the note median; the two multiplier-2 songs are not compared): gate median 0.989, note median 0.849 over 31 voices. The note agreement counts only calls where both gates are on. It is lowered by the first frame of each note (the player still plays the previous pitch while it writes the restart waveform) and by slides on instruments with pitch steps in the wave table, which are not imported. The pitch class of the F-diff is about 0 for every song because the frequency table of SIDWave differs from CheeseCutter's (the notes are the same, the register values are not). The ladder levels T0, T1 and A0 do not apply (different players). The test asserts floors: every voice gate agreement at least 0.5, per song mean at least 0.75, median at least 0.95; note agreement per song mean at least 0.35 and median at least 0.75.

The export direction is checked three ways. A score of two voices, exported with the player of an example song and run in it: gate 0.95/0.98, note 0.94/0.98, best shift +4. A score with two wavetable programs: gate 1.00/0.96, note 0.90/0.96. Each of the 12 example songs, imported, exported with itself as the driver and compared with the imported score: gate median 0.997, note median 0.883 over 31 voices; the test asserts floors of 0.85 per voice gate, 0.9 per song mean gate, 0.97 gate median, 0.45 per song mean note and 0.8 note median. The lowest note agreements are guyshavitt-dustandrust voice 1 (0.28; its rows alternate between 7 and 8 frames, the export writes rows of a constant 3 frames, and about two thirds of its note starts move by one frame; its wave table changes pitch on every frame, so a moved note disagrees on most calls; counting a match within one call, the agreement of this voice is 0.81) and tempest-soyoudied voice 1 (0.50, of 38 calls: its notes hold the gate for two calls, and the first of them plays the previous pitch).

Round trip over the 14 example songs (import, export with the original as the driver, import again; pitch, start and end per voice, one frame tolerance): all 16,764 notes equal and no note added. The comparison does not cover sound: the export loses 823 glide and portamento notes (9 songs), vibrato (7 songs), filter programs (8 songs), pulse tables, wavetable offsets below the note (6 instruments in 2 songs) and one wavetable program that does not fit (1 song).

CPU time (`process.cpuUsage`): import of the largest allowed song (3 voices of 511 order list entries, 32,704 ticks each, 128 sequences of 64 rows) 0.27 s without validation, export of 4,800 rows 0.08 s. For the 14 example songs the import takes on average 0.04 s with `validate: false` (maximum 0.09 s), 0.18 s with the default check (maximum 0.64 s) and 0.23 s with a full parse and compile (maximum 0.67 s); the slowest song, abaddon-trouble (84 KB of score text), takes 0.14 s, 0.29 s and 0.86 s. The default check parses the score (from the object, not the text) and arranges it, which applies every timing and pitch rule of the compiler, and compiles only when the table sizes could exceed the 255 steps or 63 instruments of the player (`needsCompile` in `gridScore.ts`). The fuzz test runs 1,500 mutated songs (pointer table, sequences, tables, order lists, header, truncation); all failures are typed errors and the slowest case takes 7 ms.

## SID Factory II

`.sf2` song files of SID Factory II import and export for drivers 11.00 to 11.05 (the default driver of the editor, and its 2-, 3- and 4-SID variants with 6, 9 and 12 tracks; a driver above 11.05 is refused with a message). An `.sf2` file is a C64 PRG: a load address and a memory image that holds a 6502 driver, header blocks that describe it (id `0x1337` at the load address, then descriptor, driver common addresses, tables, instrument descriptor and music data blocks), and the song data. The container layout, the order list coding and the sequence coding were read from SID Factory II's loader and data sources (`driver_info.cpp`, `datasource_orderlist.cpp`, `datasource_sequence.cpp`; upstream `Chordian/sidfactory2`, GPL-2.0). The table semantics follow the driver notes (`dist/documentation/notes_driver11.txt`) and were checked against the driver in each example song. No code is copied, and SIDWave contains no driver and no song.

`sidwave import song.sf2` finds the format by the `0x1337` id or the `.sf2` extension (a file is read as one song, so `--song` accepts only 1: of a file with several songs, the editor's order list pointers select the song that was current when it was saved, that song is imported, and the report says how many songs are not). `sidwave export score.yaml --driver sf2driver11_05.prg -o out.sf2` writes a song. `--driver` is required and names an `.sf2` file (its driver is reused, its song data cleared) or a driver 11 PRG from the SID Factory II distribution (`SIDFactoryII/drivers/sf2driver11_*.prg`). The output embeds the driver, so the driver's licence (GPL-2.0) applies to the file, as for every song the editor saves. Without `--driver` the command stops and says so.

### Other drivers

Drivers 12 to 16 and NP20 share the container and are read by the same header parser, but their tables differ (4 to 7 tables instead of 9, other instrument bytes and command sets: Barber, Hubbard emulation, Experiment, Tiny I and II). Their notes are short (29 to 60 lines each) and cannot be checked without a driver-specific decoder, so import and export refuse them with a message (`driver 14.00; only driver 11.xx ... is supported so far`) that points to `sidwave reconstruct` on a `.sid` exported from the editor. This is the blocked part of this work package: no verified decoder exists for 12 to 16.

### Import

| SID Factory II | SIDWave |
| --- | --- |
| tracks 1-3, 4-6, 7-9, 10-12 | voices of SID 1, 2, 3, 4 (a `sids` list at `$D400`, `$D420`, ...); on export, voice `n` of SID `k` becomes track `3k + n` |
| order list: transposition `(value & 7F) - 20`, sequence numbers, `FE` end, `FF` loop | one pass; a loop to another position than the start is reported |
| note `01`-`6F` | note, MIDI `12 + value + transposition` |
| `00` | gate off, rest |
| `7E`, duration events | the note continues (ties) |
| tie flag on a duration byte | `legato: true` for a new pitch |
| tempo value `t` of the init table's tempo chain | `t + 1` video frames per row as the bar tempo; a chain of several values (shuffle) takes the mean per bar |
| instrument: AD, SR, flags, filter, pulse and wave indexes | instrument with the same ADSR |
| wave table rows (waveform, semitones or absolute note, `7F` jump) | `wavetable` steps found by running the program one row per frame |
| arpeggio command `T3 XX YY` (speed, start row) | the instrument is converted once per arpeggio; the arpeggio table is folded into the wave table pitches (`XX + 1` frames per step) |
| pulse program | `pulsetable`; filter program: `filtertable` (cutoff, passband, resonance, add) |
| hard restart flag and HR table row | `hard_restart` of 2 frames with the HR ADSR (0 frames without the flag) |
| vibrato `T1 XX YY`, set local ADSR `T8`, wave program `Tb` | instrument variants. The vibrato is a triangle of `XX + 1` frames in each direction that moves by the distance to the next semitone divided by `2^YY` per frame (measured in the driver) |
| slide `T0` (signed 16-bit speed per frame), portamento `T2` (`02 80 00` ends it) | `bend` to the pitch the slide reaches by the end of the note, `portamento` frames from the speed and the distance; the same limits as for CheeseCutter (no bend on an instrument whose wavetable sets pitches, whole semitones) |

How long a command lasts follows the driver (measured in versions 11.00, 11.02, 11.04 and 11.05, and in the Tie Notes example): a track has one pitch effect at a time (slide, vibrato, portamento or arpeggio). A note of a new pitch ends a slide and a vibrato. A note that sets an instrument ends an arpeggio and a portamento. A local ADSR and a wave program end at the next note that is not tied.

Lost, and counted in the report: changes of arpeggio, vibrato, wave program or ADSR on a note that continues (hold rows and tied notes), because a SIDWave legato note keeps its instrument; slides on instruments with pitch steps in the wave table, fret slide, set instrument ADSR, filter and tempo program commands, main volume, demo value, the first frame of a note (the driver keeps the previous pitch while it writes the first waveform), the oscillator reset flag. The filter is global in SID Factory II; SIDWave routes the voice of the instrument. A song whose effect variants would exceed the 63 instruments or 255 wavetable steps of a SIDWave score is imported again without set-local-ADSR, then without arpeggios, then without vibrato, and the report says which. Rows shorter than 3 frames that cannot hold SIDWave's two-frame restart are imported with a restart of zero frames. A song that SIDWave still rejects (a very fast tempo chain) fails with the compiler's message.

Input bounds: the file is at most 1,000,000 bytes; every header block, table and pointer is checked against the 64 KiB image; at most 32 tables, 12 tracks, 128 sequences of at most 256 bytes and order lists of at most 256 entries; a sequence expands to at most 1,024 events and an import to at most 100,000 ticks per track. A driver 11 table with fewer columns than the driver defines is refused, and a table index beyond the rows reads as 0. At most 1,024 instrument variants are converted; a song with more counts as above the 63 instruments of a score. A missing end marker, a loop to a position that holds no entry and a sequence without an address are errors that name the track or sequence.

### Export

Up to the tracks of the driver (3, 6, 9 or 12; use `sf2driver11_05_2sid.prg` and the like for more than one SID), one song. A score that exceeds a capacity of the driver (instruments, table rows, sequences) exits 5. The row length is the largest frame count from 3 to 12 at which every note start and end is within one frame of a row; the tempo table holds that value minus one. When no whole-frame length is exact, a row length that is a fraction of a frame (for example 2.75 frames, a tempo table of 3, 3, 3, 2) is used if it fits better, and the tempo table repeats the matching chain of values. Sequences are 16 rows (32 or 64 when 128 sequences are not enough) in the editor's packed coding with the instrument on every note, so identical chunks share one sequence. A score whose bars are not a power of two rows (a swing, or 14.67 rows per bar) is cut at every 1st, 2nd, 4th or 8th bar start instead, so repeated bars still share sequences. Instruments: one driver instrument per distinct waveform, ring and sync, fixed pulse width, ADSR and wavetable. A wavetable becomes rows of the driver's wave table, one row per frame, with the closing jump to the loop step; instruments with the same program share the rows, and a first step that only sets the test bit becomes the driver's oscillator reset flag. The driver starts the wave program on the second frame of a note, so an exported program plays one frame later than in SIDWave unless it starts with that test step; the rows are not shortened, so a program read from a song is written back as it was. When the programs need more than the 32 instruments or 256 wave table rows, the least used ones are left out (reported). The importer expands every effect variant of an instrument into an instrument of its own, so a score read from a song can hold more than the 32 instruments of the driver. Notes that differ only in a vibrato, a local ADSR or a `type: arpeggio` pattern share one driver instrument, and the effect is written as a command (`T3` arpeggio with its arpeggio table rows, `T1` vibrato, `T8` set local ADSR) on every note that has it: the instrument set by the next note ends an arpeggio and a new note ends a vibrato, so no command ends an effect. An arpeggio that was imported from a song is part of the instrument's wavetable and is exported as wave table rows. If the commands make the repeats differ so much that 128 sequences are not enough, a second attempt leaves the effect commands out and folds a local ADSR into the most used ADSR of its instrument (reported as a loss). The output uses the order lists of the first song, whatever song the driver file had selected. Hard restart flag with a zero-ADSR row. Lost, and listed in the report: filter, pulse modulation, slides and glides, levels, volume, wavetable steps below the note, voices beyond the driver's tracks, two notes on one row (one command per row: a second wanted command is dropped and counted), C0 (the driver's lowest note is C#0; the importer reaches C0 only through order list transposition, which the exporter does not write), the title and author (the editor keeps them in data the exporter does not write). The last note of a song keeps its length: no release row is written at the song end. The command line refuses to write the output over the driver file.

### Differential check against the driver

`test/helpers/sf2Differential.mjs` makes a PSID that runs the driver stored in the file (two stubs switch the BASIC ROM out; init is called with the song number, update once per frame), and the tests compare its trace with the compiled SIDWave score. The reference is the real driver. The alignment is fixed, not searched: the driver's first gate rises on call 4 (call 0 is its init, the note starts two calls after its row), SIDWave's on call 1, so the driver lags by 3 calls; the best shift of a search over -12 to 12 is printed next to it and is -3 or -4 (the choice between them depends on the instruments' restart flag). The tests skip with a message when there is no SID Factory II checkout at `~/.c64bridge/sidwave-standalone/research-src/Chordian_sidfactory2`; its driver 11 example songs are read at test time and are not committed.

Results over the driver 11 example songs (8 seconds each; 53 of 54 import, and Pipes and Pearls is rejected because a wavetable pitch of its imported score leaves the SIDWave range): gate median 0.957 over 159 voices, note median 0.595 over the 110 voices with at least 50 comparable calls (semitone within 0.6, counted only where both gates are on). Note agreement is lowered by the first frame of every note and by slides, portamento and vibrato depth, which are approximated or not imported. The pitch class of the F-diff is about 0 because the frequency tables differ.

The export direction (two voices, exported with the driver of Tie Notes, run in that driver, compared with the compiled score): gate 1.00/1.00, note 0.91/0.98, best shift 3 (the fixed alignment), F-diff adsr 1.00, volume 0.95, timing 0.84. The ladder levels T0, T1 and A0 do not apply (different players).

Round trip over the 53 driver 11 example songs that import (import, export with the original as the driver, import again; pitch, start and end per voice, one frame tolerance): all 53 export and import again, and 81,277 of 81,285 notes are equal. The other 8 are C0 notes in 3 songs, which the export moves up an octave. The comparison does not cover sound: the export loses 4,604 glide and portamento notes (33 songs), filter programs (46 songs), pulse tables (50 songs) and wavetable steps other than arpeggios (53 songs).

CPU time (`process.cpuUsage`): import of a song of 16,000 ticks by 3 tracks 0.24 s without validation, export of 4,800 rows 0.10 s; the example songs import in 0.3 s on average (maximum 1.1 s) with the default check, which parses the score from the object and arranges it (every timing and pitch rule of the compiler) and compiles only when table sizes could exceed the player's limits; `validate: false` skips it. The fuzz test runs 1,500 mutated songs; every failure is a typed error and the slowest case takes 15 ms.

### SIDWave 1.5

Not used yet: both importers could write the driver's own frequency table as `tuning.registers` and the first frame of a note (the previous pitch while the restart waveform is written) as a wavetable `reg` step. Those two account for most of the remaining note disagreement (for example the extreme drum pitches that SIDWave clamps, and the first call of every note). Until then the importers write equal-tempered pitches and skip the first frame.

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

## Conversion hub: `sidwave convert`

`sidwave convert <in> [<out>]` converts between the formats of this document, the SIDWave score, the compiled PRG
and PSID, and (as a source) a PSID. One command replaces the two-step `import` then `export`; the same conversion is
available as `convert()` from the package root.

A score that exceeds a fixed capacity of the target format (patterns, instruments, orderlist length) exits 5.

```
sidwave convert song.sng song.mid          # GoatTracker song to MIDI
sidwave convert tune.mid tune.sid          # MIDI to a playable SID file
sidwave convert tune.sid tune.sng          # SID to GoatTracker (traces the tune: slower, approximate)
sidwave convert song.fur song.sng --dry-run --json
sidwave convert tune.mod tune.yaml --sids 2   # MOD input only: 1 to 10 SIDs, three voices each
sidwave convert song.sf2 song.mid          # SID Factory II (driver 11) to MIDI
sidwave convert song.ct song.sng           # CheeseCutter to GoatTracker
sidwave convert song.sng out.sf2 --driver other.sf2   # a CheeseCutter or SID Factory II output needs --driver
sidwave formats                            # the format table below, from the registry
sidwave info unknown.bin                   # detect and describe any supported file
```

### Formats

| Id | Reads | Writes | Extensions | Detected by |
|---|---|---|---|---|
| `sidwave` | yes | yes | `.yaml` `.yml` `.sidwave` | top-level key `sidwave:` (older scores: `song:` and `voices:`) |
| `sid` | approximate (reconstruct) | yes | `.sid` | magic `PSID` or `RSID` |
| `midi` | yes | yes | `.mid` `.midi` `.smf` | header chunk `MThd` |
| `musicxml` | yes (uncompressed) | yes | `.musicxml` `.xml` (`.mxl` input only) | root element `score-partwise` or `score-timewise` |
| `abc` | yes | no | `.abc` | an `X:` tune line followed by a `K:` line |
| `goattracker` | yes | yes | `.sng` | magic `GTS!`, `GTS2` to `GTS5` |
| `sidwizard` | yes | yes | `.swm` `.sws` | identifier `SWM1` or `SWMS` at offset 2 (`.swi` instruments are not handled by convert) |
| `basic` | no | yes | `.bas` | a numbered BASIC listing with the extension `.bas` |
| `vice-dump` | approximate (reconstruct) | yes | `.dump` | lines of three decimal numbers |
| `siddump` | approximate (reconstruct) | no | `.siddump` | a table with `|` rows and a Frame column |
| `furnace` | yes | yes | `.fur` | header `-Furnace module-`, also inside zlib |
| `cheesecutter` | yes (2.x; stereo not yet) | yes (needs `--driver`) | `.ct` | magic `CC2` |
| `sf2` | yes (driver 11) | yes (needs `--driver`) | `.sf2` | id `0x1337` after the load address |
| `wav` | no | yes (mix, mono 48 kHz) | `.wav` | `RIFF` and `WAVE` |
| `mod` | yes | no | `.mod` | signature at offset 1080; a 15-sample module needs the extension `.mod` |
| `jch` | yes | no | none | load address `$0F00` and a version mark at `$0FEE` (only `20.G` is read) |
| `prg` | no | yes | `.prg` | extension only |
| `events` | no | yes (lossy JSON view) | `.json` | JSON key `schema: sidwave.events/1` |

`sidwave formats` prints the same table with a loss summary per format. Reading events JSON, WAV and PRG is not
supported by design or not yet: events are a lossy view, a PRG has no score, and audio transcription is planned.

## Commodore BASIC V2 (`.bas`)

`sidwave convert score.yaml score.bas` writes a self-contained BASIC V2 program that plays the score on the SID at
`$D400`. The format is write only. The listing is upper case, numbered in steps of 10, with at most 80 characters per
line: eight lines of player and the DATA statements.

**Using it.** Type the listing in, paste it into an emulator, or tokenise it with VICE's `petcat`, which reads lower
case ASCII as the unshifted letters of the C64:

```
tr A-Z a-z < score.bas > score.txt && petcat -w2 -o score.prg -- score.txt
```

`RUN` first reads all DATA and compares the number and the sum of the values with the program's checksum; a typing
error stops it with `DATA ERROR` (a missing or non-numeric value can stop it with a BASIC error instead). The check
takes about 7.5 ms per value: 4 s for Für Elise and about 50 s for the 20 KB Chamber Waltz program. The report gives
the estimate as `checkSeconds`. To skip the check once the listing is known to be right, delete lines 20 and 30.
Stopping the program with RUN/STOP leaves the notes that are sounding; RUN/STOP and RESTORE silences them.

**Data.** Each record is `D,N` followed by `N` pairs of SID register offset (0 to 24) and value. `D` is the delay in
jiffies since the previous record. The program waits until `TI` reaches the sum of the delays and writes the pairs. A
record with `N` = 0 ends the program. Only registers that change are written.

**Register values.** BASIC V2 writes about 100 registers per second, while the compiled player writes up to 25 in
every call. The program therefore holds one value per note: the writer runs the compiled player and takes, for each
note of the score, the pitch, waveform, pulse width and envelope that the player holds during the note (the waveform
that sounds longest, at the first call that has the pitch of the score). Wavetable steps, attack transients, vibrato,
arpeggios, glides and pulse sweeps are not played (`basic.modulation.dropped` counts the notes). Filter and volume
registers are updated at note starts only (`basic.filter.sampled`), without the lowest three bits of the cutoff.
Digi samples are not played. One SID plays at most three voices; `voices.dropped` reports the rest, and voices taken
from other SIDs share one filter and volume (`basic.sid.moved`). The program plays the score once, without its loop.
One second after the last record it clears the SID and ends, which cuts a longer release.

**Timing.** The clock is `TI`, which runs at 60 Hz on PAL and NTSC machines, so a record starts on a 16.7 ms step. The
writer predicts the interpreter time of each record (9.7 ms per register, 16 ms per record, measured on a PAL C64 in
VICE 3.10) and starts the record early so that the last gate it opens is on time. Delays are measured from the start
of the program, so the error does not accumulate. Errors of the note starts against the score, measured in VICE 3.10
(PAL) from the SID writes, with the first note 0.5 s after `TI` is reset:

| Score | Note starts | Mean | 95 % | Maximum |
|---|---|---|---|---|
| `fuer_elise` (25 s) | 47 | 6 ms | 15 ms | 19 ms |
| `chamber_waltz` (139 s) | 655 | 11 ms | 24 ms | 34 ms |
| `chiptune_drive --seconds 60` (too dense) | 796 | 144 ms | 426 ms | 659 ms |

In all three runs the program made exactly the register writes of its DATA, every gate-on of the compiled player
appeared, and the frequency, waveform and envelope at each of them were values that the compiled player holds during
that note.

A gate that closes is less exact than a note start: it shares the record with the notes that start around it, and a
gate-off less than 65 ms before the next note of the same voice is written together with that note. The envelope still
sees the gate closed while the new values are written. In these runs gate-offs differed from the player's by up to
105 ms in the first two scores.

In a dense passage a record cannot be finished before the next one is due. The notes are then late until the passage
ends. `basic.timing.dense` reports how many records are predicted to be more than 25 ms late and the largest delay;
pulse width and filter writes are left out while the program is more than 50 ms behind (`basic.timing.shed`). The
program does not play such a score in time. `--voices 2` or `--voices 1` writes fewer registers. The predictions in
the report (`predictedMeanErrorMs`, `predictedMaxErrorMs`, `maxDelayMs`) do not include the phase of `TI` when the
program resets it, which shifts all notes together by up to 17 ms, nor the variation of the interpreter.

An NTSC score gets NTSC frequency values, and a PAL score PAL values: run the program on a machine of the same
standard to keep the pitch.

**Size.** The tokenised program (one byte per keyword and operator, five bytes of overhead per line) and nine numeric
variables of seven bytes must fit into the 38,911 bytes of BASIC RAM; otherwise the conversion exits 5 and writes no
file. As a guide, about 1,000 notes fit. The message names the `--seconds` value that fits: `--seconds n` writes the
notes that start in the first `n` seconds (`basic.truncated`). `--voices` also shortens the program.

### Detection

The content decides. Each format has a magic detector that returns a confidence from 0 to 1. A weak match gains 0.35
when the extension agrees. If nothing matches the content, the extension alone gives confidence 0.5. The best
candidate is used when its confidence is at least 0.6 and the second best is more than 0.2 behind. Otherwise
`convert` exits 3 and lists the candidates with the `--from` option that fixes it. When the extension contradicts a
clear magic (0.9 or more), the content wins and a warning is printed.

### Chain

`read` (importer, or reconstruct for a `.sid`) then `normalise` (the result is parsed as a SIDWave score) then `plan`
(ScorePlan, below) then `write` (exporter). With `--verify` the output is read again and compared with the score.
Converting a SIDWave score to the same format is a plain copy through the writer. The input and output of a
converted pair are always checked first: nothing is written when any output file exists (without `--force`) or when
the output is the input.

### ScorePlan

Every exporter receives its score from `planScore()` (`interchange/scorePlan.ts`). The plan decides, from the
capabilities of the target (`TargetCaps`):

- Voices: when the target holds fewer voices than the score has (GoatTracker and Furnace: three), the voices with the
  highest notes x pitch range are kept; ties keep the voice that comes first. The dropped voices are reported
  (`voices.dropped`, severity `lost`). `--voices n` lowers the limit further.
- Tempo: a target with a tempo map gets the tempo map; a tracker with one tempo folds tempo changes into its row grid
  (`tempo.folded`). Tempo ramps are reported for every target (`tempo.ramp`): they become steps in a tempo map and
  are not stored in a single-tempo format.
- Glides, slides and vibrato are reported when the target writes plain notes (`bend.dropped`).
- A loop point that the target cannot store (`loop.restart`) and title and author that the target does not store
  (`metadata.dropped`).
- Row grid: the GoatTracker and Furnace exporters pick the largest row length of 3 to 12 calls that fits every note
  start. They always count time in video frames: a score with `speed: 2` has its notes rounded to frames
  (`timing.multispeed`).

Drum hits that share a voice with pitched notes are written as pitched notes in MIDI and MusicXML, because a part with
both kinds is read back as a drum part and loses its pitched notes.

### Losses

Each stage returns losses `{ stage, code, severity, count, where?, message }`. The hub groups them by stage and code.
Severity `info`: nothing musical is lost. `approx`: the result is close, not equal. `lost`: content is missing in the
output. `--strict` exits 1 and writes nothing when any loss is `lost`. The sentences that importers and exporters
report are mapped to codes by `interchange/loss.ts`; a sentence with no rule gets the code `note` and severity `approx`, and a test fails on every `note` code.

### Quality measure (`--verify`)

The output is read back with the target's importer and its notes are compared with a reference note by note. The
reference is the score after the import, with all voices and before any reduction. It is not the source file: an
import that drops notes is already in the reference, and only `sourceVsOutput` (below) sees it. A note matches when
its pitch (for a drum hit: its drum name) is equal and the onsets differ by at most the tolerance. The tolerance is one
video frame (20 ms) for a format without a grid. For a target with a row grid (GoatTracker, Furnace, SID-Wizard) it is half
a row, and for an importer that quantises to a grid (MIDI, MusicXML, ABC: 0.25 beat by default) half a grid cell, each plus 10 ms
for rounding, at most 100 ms, because rounding a note start to the nearest row moves it by up to half a row (a sawtooth: the error of each note
is bounded and does not accumulate). It is printed with the result (`onsetToleranceMs`). There is no wildcard for drums.

Reported: `noteF1` with `precision` and `recall`; `noteF1PitchOnly` (drum identity ignored); `noteF1OctaveTolerant` and
`octaveShifted` (matches that differ by whole octaves); mean and maximum onset error; `durationOverlap` (mean of
intersection over union of the note intervals of matched notes, so it sees changed note ends); `voiceAgreement` (the
share of matched notes whose output voice is the voice that most notes of the same reference voice went to; it does not
change when the voices are permuted, so `voiceAgreementIdentity`, the share that keep their voice number, is reported with it);
`drumIdentity` (drum hits that matched as the same drum); the length of the reference and of the output in seconds
(`durationSeconds`: a tracker or grid import pads the last bar, so the length can grow by up to a bar without any tempo
drift); voices dropped; instruments mapped; for a `.sid` or trace input the F-diff of the reconstruct. A1 is not
computed by `convert`; use `sidwave verify` for compiled tunes. Targets that cannot be read back (`prg`, `sid`, `wav`,
`events`, `vice-dump`) report `available: false` with the reason.

For a source that carries notes, `sourceVsOutput` repeats the comparison against the notes of the source file itself,
read independently of the importer (pitch only, no drum identity). It exists for MIDI. For MusicXML and the trackers
the reference is the imported score only, because their notes are read by the importers and there is no second reader.

Quality thresholds of the conversion test matrix (`test/convertMatrix.test.mjs`), per source and target format. Every
pair is converted for each committed fixture, read back, and must reach the note F1, the duration overlap and the voice
agreement of its row. Each value is the lowest measured over the fixtures of the pair, rounded down to two digits, so
that a change that makes a pair worse fails the test; the reason column names what limits the value. The second F1
column applies to scores with more than three voices (the fixture `title_fanfare`, five voices). A `sid`, `vice-dump`
and `siddump` source is read by reconstruct with a 4 s horizon. The tables are per source, in one block each.

<!-- quality:sidwave:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| sidwave | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| sidwave | midi | 0.92 | 0.66 | 0.84 | 0.92 | drum identity is lost (drum hits of the five-voice fixture sit in voices beyond the importer's three); the importer gives one of its 3 voices to the drum part and drops the notes of the weakest pitched part (listed in the read losses); voices beyond three are dropped (trackers) or not read back (MIDI and MusicXML: three voices per SID) |
| sidwave | musicxml | 0.92 | 0.66 | 0.84 | 0.92 | drum identity is lost (drum hits of the five-voice fixture sit in voices beyond the importer's three); the importer gives one of its 3 voices to the drum part and drops the notes of the weakest pitched part (listed in the read losses); voices beyond three are dropped (trackers) or not read back (MIDI and MusicXML: three voices per SID) |
| sidwave | goattracker | 0.69 | 0.68 | 0.86 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); voices beyond three are dropped (trackers) or not read back (MIDI and MusicXML: three voices per SID); notes and ends move to the row grid |
| sidwave | furnace | 0.69 | 0.68 | 0.86 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); voices beyond three are dropped (trackers) or not read back (MIDI and MusicXML: three voices per SID); notes and ends move to the row grid |
| sidwave | sidwizard | 0.57 | 0.61 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); voices beyond three are dropped (trackers) or not read back (MIDI and MusicXML: three voices per SID); notes and ends move to the row grid; speed-2 scores need one-call rows, merged to 3-frame cells |
| sidwave | cheesecutter | 0.57 | 0.73 | 0.86 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| sidwave | sf2 | 1.00 | 0.79 | 0.86 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:sidwave:end -->

<!-- quality:cheesecutter:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| cheesecutter | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | midi | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | goattracker | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | furnace | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | sidwizard | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | cheesecutter | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| cheesecutter | sf2 | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
<!-- quality:cheesecutter:end -->

<!-- quality:sf2:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| sf2 | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | midi | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | goattracker | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | furnace | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | sidwizard | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | cheesecutter | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
| sf2 | sf2 | 1.00 | 1.00 | 1.00 | 1.00 | exact on the fixture; the fixture song has one tempo and plain instruments |
<!-- quality:sf2:end -->

<!-- quality:sid:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| sid | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | recovered by reconstruct from a 4 s horizon |
| sid | midi | 1.00 | 1.00 | 0.82 | 1.00 | recovered by reconstruct from a 4 s horizon |
| sid | musicxml | 1.00 | 1.00 | 0.82 | 1.00 | recovered by reconstruct from a 4 s horizon |
| sid | goattracker | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| sid | furnace | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| sid | sidwizard | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| sid | cheesecutter | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
| sid | sf2 | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
<!-- quality:sid:end -->

<!-- quality:midi:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| midi | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| midi | midi | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| midi | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| midi | goattracker | 0.64 | 0.64 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid |
| midi | furnace | 0.64 | 0.64 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid |
| midi | sidwizard | 0.78 | 0.78 | 0.89 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid; speed-2 scores need one-call rows, merged to 3-frame cells |
| midi | cheesecutter | 0.64 | 0.64 | 0.90 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| midi | sf2 | 0.64 | 0.64 | 0.90 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:midi:end -->

<!-- quality:musicxml:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| musicxml | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| musicxml | midi | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| musicxml | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| musicxml | goattracker | 0.64 | 0.64 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid |
| musicxml | furnace | 0.64 | 0.64 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid |
| musicxml | sidwizard | 0.78 | 0.78 | 0.89 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid; speed-2 scores need one-call rows, merged to 3-frame cells |
| musicxml | cheesecutter | 0.64 | 0.64 | 0.90 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| musicxml | sf2 | 0.64 | 0.64 | 0.90 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:musicxml:end -->

<!-- quality:abc:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| abc | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| abc | midi | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| abc | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| abc | goattracker | 1.00 | 1.00 | 0.97 | 1.00 | the tracker's row grid shortens some note ends |
| abc | furnace | 1.00 | 1.00 | 0.97 | 1.00 | the tracker's row grid shortens some note ends |
| abc | sidwizard | 1.00 | 1.00 | 0.97 | 1.00 | the tracker's row grid shortens some note ends |
<!-- quality:abc:end -->

<!-- quality:goattracker:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| goattracker | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| goattracker | midi | 1.00 | 1.00 | 0.77 | 0.93 | the tracker's row grid is read back on the 0.25 beat grid |
| goattracker | musicxml | 1.00 | 1.00 | 0.77 | 0.93 | the tracker's row grid is read back on the 0.25 beat grid |
| goattracker | goattracker | 1.00 | 1.00 | 0.87 | 1.00 | notes and ends move to the row grid |
| goattracker | furnace | 1.00 | 1.00 | 0.87 | 1.00 | notes and ends move to the row grid |
| goattracker | sidwizard | 1.00 | 1.00 | 0.76 | 1.00 | notes and ends move to the row grid |
| goattracker | cheesecutter | 1.00 | 1.00 | 0.87 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| goattracker | sf2 | 1.00 | 1.00 | 0.87 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:goattracker:end -->

<!-- quality:furnace:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| furnace | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| furnace | midi | 1.00 | 1.00 | 0.77 | 0.93 | the tracker's row grid is read back on the 0.25 beat grid |
| furnace | musicxml | 1.00 | 1.00 | 0.77 | 0.93 | the tracker's row grid is read back on the 0.25 beat grid |
| furnace | goattracker | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid |
| furnace | furnace | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid |
| furnace | sidwizard | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid |
| furnace | cheesecutter | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| furnace | sf2 | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:furnace:end -->

<!-- quality:sidwizard:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| sidwizard | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| sidwizard | midi | 1.00 | 1.00 | 0.92 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| sidwizard | musicxml | 1.00 | 1.00 | 0.92 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| sidwizard | goattracker | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid |
| sidwizard | furnace | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid |
| sidwizard | sidwizard | 1.00 | 1.00 | 0.83 | 1.00 | notes and ends move to the row grid |
| sidwizard | cheesecutter | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| sidwizard | sf2 | 1.00 | 1.00 | 0.96 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:sidwizard:end -->

<!-- quality:mod:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| mod | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| mod | midi | 1.00 | 1.00 | 0.95 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| mod | musicxml | 1.00 | 1.00 | 0.95 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| mod | goattracker | 0.55 | 0.55 | 0.90 | 1.00 | a MOD note rate that the GoatTracker row length (3 to 12 calls) cannot hold moves notes; notes and ends move to the row grid |
| mod | furnace | 0.55 | 0.55 | 0.90 | 1.00 | notes and ends move to the row grid |
| mod | sidwizard | 0.70 | 0.70 | 0.90 | 1.00 | notes and ends move to the row grid |
| mod | cheesecutter | 0.55 | 0.55 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid; three voices; no drums, filter tables or glides |
| mod | sf2 | 0.55 | 0.55 | 0.90 | 1.00 | drum identity is lost (no drum channel: hits become pitched notes); notes and ends move to the row grid; three voices; no drums, filter tables or glides |
<!-- quality:mod:end -->

<!-- quality:jch:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| jch | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | exact round trip |
| jch | midi | 1.00 | 1.00 | 0.95 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| jch | musicxml | 1.00 | 1.00 | 0.95 | 1.00 | the tracker's row grid is read back on the 0.25 beat grid |
| jch | goattracker | 1.00 | 1.00 | 0.85 | 1.00 | notes and ends move to the row grid |
| jch | furnace | 1.00 | 1.00 | 0.85 | 1.00 | notes and ends move to the row grid |
| jch | sidwizard | 1.00 | 1.00 | 0.85 | 1.00 | notes and ends move to the row grid |
| jch | cheesecutter | 1.00 | 1.00 | 0.85 | 1.00 | notes and ends move to the row grid |
| jch | sf2 | 1.00 | 1.00 | 0.85 | 1.00 | notes and ends move to the row grid |
<!-- quality:jch:end -->

<!-- quality:vice-dump:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| vice-dump | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | recovered by reconstruct from a 4 s horizon |
| vice-dump | midi | 1.00 | 1.00 | 1.00 | 1.00 | recovered by reconstruct from a 4 s horizon |
| vice-dump | musicxml | 1.00 | 1.00 | 1.00 | 1.00 | recovered by reconstruct from a 4 s horizon |
| vice-dump | goattracker | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| vice-dump | furnace | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| vice-dump | sidwizard | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; recovered by reconstruct from a 4 s horizon |
| vice-dump | cheesecutter | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
| vice-dump | sf2 | 1.00 | 1.00 | 1.00 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
<!-- quality:vice-dump:end -->

<!-- quality:siddump:start -->
| Source | Target | Note F1, at most 3 voices | Note F1, more than 3 voices | Duration overlap | Voice agreement | Reason |
|---|---|---|---|---|---|---|
| siddump | sidwave | 1.00 | 1.00 | 1.00 | 1.00 | siddump is sampled once per frame (approximate) |
| siddump | midi | 0.80 | 0.80 | 0.53 | 1.00 | siddump is sampled once per frame (approximate) |
| siddump | musicxml | 0.80 | 0.80 | 0.53 | 1.00 | siddump is sampled once per frame (approximate) |
| siddump | goattracker | 0.80 | 0.80 | 0.38 | 1.00 | notes and ends move to the row grid; siddump is sampled once per frame (approximate) |
| siddump | furnace | 0.80 | 0.80 | 0.38 | 1.00 | notes and ends move to the row grid; siddump is sampled once per frame (approximate) |
| siddump | sidwizard | 0.80 | 0.80 | 0.75 | 1.00 | notes and ends move to the row grid; speed-2 scores need one-call rows, merged to 3-frame cells; siddump is sampled once per frame (approximate) |
| siddump | cheesecutter | 0.80 | 0.80 | 0.38 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
| siddump | sf2 | 0.80 | 0.80 | 0.38 | 1.00 | notes and ends move to the row grid; three voices; no drums, filter tables or glides; recovered by reconstruct from a 4 s horizon |
<!-- quality:siddump:end -->

The golden losses of every pair are in `test/fixtures/convert/golden/`, one file per input. The files are generated by
`scripts/regenerate-convert-golden.mjs`, never by hand. The binary fixtures are generated by
`scripts/make-convert-fixtures.mjs` from the committed scores.

### Adding a format

Create one file `interchange/formats/<name>.ts` that exports a `FormatDefinition` (`interchange/formatTypes.ts`): `id`,
`extensions`, `magic(bytes)`, `caps`, a `detection` and `lossSummary` text, and `read` and/or `write` that wrap the
format's importer and exporter (see `builtinFormats.ts` and `formats/sidwizard.ts`). The registry loads every module
in `interchange/formats/` at start-up and registers each exported definition, so no existing file is edited. A format
whose writer renders audio or traces sets `writeNeedsEngine`; a reader that reconstructs a tune sets
`readIsApproximate`. Detection, `convert`, `formats`, `info` and the conversion test matrix pick the format up: add
fixtures for it to `test/helpers/convertMatrix.mjs` (the matrix test fails on a readable format without a fixture), a
block for it to the threshold tables below, and run `scripts/regenerate-convert-golden.mjs`.

## ProTracker MOD (`.mod`)

`sidwave import tune.mod -o tune.yaml [--sids n] [--transpose n] [--quality] [--mode PAL|NTSC]`. `import` detects the format from the extension `.mod` or the signature at offset 1080. `convert` and `info` detect it from the signature, or, for a 15-sample module, from the extension `.mod` together with the plausibility check below. `sidwave convert` accepts `--sids 1-10` for a MOD input (any other input with `--sids` is a usage error). The mapping is written from the published ProTracker module format description. SID Factory II ships a MOD converter (`converter_mod`, GPL-2.0); it was read to find out which behaviour users expect, nothing was copied, and the importer differs from it on purpose (see the table at the end of this section).

Variants: 31-sample files with the signatures `M.K.`, `M!K!`, `M&K!`, `N.T.`, `FLT4`, `4CHN`, `6CHN`, `8CHN`, `CD81`, `OCTA`, `nCHN` (1 to 9), `nnCH` (10 to 32), `TDZ1` to `TDZ3`; `FLT8` (every pattern is two stored 4-channel patterns and the order list holds even numbers, which are halved); and the 15-sample Soundtracker layout, which has no signature and is accepted only when every pattern cell is plausible (no sample number above 15, periods 0 or 28 to 1712). Not supported: Oktalyzer, other 8-channel formats, and files above 8 MiB.

Input bounds: 8 MiB, 32 channels, 128 patterns (pattern number at most 127), 64 rows per pattern, at most 100,000 played rows before the song repeats. A file that ends inside the pattern data, has a song length of 0, names more than 128 patterns or has no recognisable layout is a `ModError` (exit 3). A file that is short inside the sample data is read as far as it goes (warning). A song length above 128 is clamped (warning). A fuzz test (1500 cases for the parser, 400 for the importer) checks that every mutation gives a result or a typed error.

### What is played

The importer follows the order list through position jumps (`Bxx`), pattern breaks (`Dxx`), pattern loops (`E6x`, per channel), pattern delays (`EEx`), speed (`F01` to `F1F`) and tempo (`F20` to `FFF`). A tick lasts 2.5 / BPM seconds (125 BPM is 50 ticks per second), a row lasts speed x ticks (times one plus the pattern delay). `F00` ends the song. The song ends when a jump or the order list reaches a position that was already played (the loop target is reported; a loop to a position other than the first row is reported as a loss because SIDWave loops the whole timeline) or when the order list ends.

### Timing

Every played row is one grid cell. The score is divided into bars of 4 beats. When the row length changes at a row that is a whole number of beats (2 to 5) before the end of a bar, the bar ends there (meter 2/4, 3/4 or 5/4), so the change is exact. Every bar gets the tempo `60 x beats / seconds`, where seconds is the real duration of its rows.

The rows per beat are chosen from 4, 8, 2, 16 and 1: the value with the fewest bars outside 30 to 220 BPM (clamped bars), then the fewest mistimed rows, then the first in that order. A value that needs more than the 2048 bars of a score is chosen only when every value does.

A bar that is not clamped has the exact length. A row length change or pattern delay that is not on a beat moves note onsets inside its bar. The report counts these rows as `mistimedRows`, and the loss text states the largest onset error in milliseconds. That figure is measured over all rows as the difference between the real start time of a row and the bar start plus the row index times the mean row length of the bar; it does not include the drift of clamped bars. SIDWave counts whole player calls per cell, so a row of 6 frames at 125 BPM is 119.8 ms in the player and 120 ms in the MOD; the score runs 0.2 % fast on PAL (measured: 0.958 s against 0.960 s for the first eight rows).

### Voice reduction (4 or more channels to 3 voices per SID)

The policy is deterministic:

1. A channel is a drum channel when at least 60 % of its notes use a percussion sample (see below). The other channels are melodic.
2. Each channel gets a score: for a melodic channel the number of notes times (1 + pitch range in semitones / 24); for a drum channel the number of hits times 1.25.
3. With `--sids n` the score has `3 n` voices. When there are more channels, the drum channels are merged into one drum voice (when there is more than one), a drum voice with at least 4 hits keeps a place, and the remaining places go to the highest scores (ties: the lower channel number). A kept channel is never mixed into another.
4. Every other channel is dropped and reported with its note count (`droppedNotes`, `losses`, `voicePolicy.ranking`).
5. Voices are ordered by channel number, the drum voice last. Voice `i` is on SID `ceil(i / 3)`, at `$D400`, `$D420`, `$D440` and so on.

`--sids 2` keeps four to six channels, `--sids 3` up to nine. Drum hits that fall on the same row in a merged drum voice keep the hit with the higher priority (kick, snare, clap, tom, crash, open hat, hat) and count the other as dropped.

### Samples to instruments (approximate)

The Amiga sample is not reproduced. Each sample that a note uses is measured once (at most 2048 points for the periodicity and the harmonics, one pass for the envelope) and becomes a SIDWave instrument:

| Measurement | SIDWave |
| --- | --- |
| Periodic (normalised autocorrelation of at least 0.55): harmonics 2 and 3 weak | `triangle` |
| Periodic: harmonic 2 weak, harmonic 3 present (a square wave) | `pulse`, width 0.5 |
| Periodic: harmonics 2 and 3 strong (a ramp) | `sawtooth` |
| Periodic with other spectra | `pulse`, width 0.25 |
| Not periodic | `noise` |
| Looped sample | ADSR with a sustain from the loop level relative to the peak (4 to 15), decay from the length of the part before the loop, attack from the time to the peak, release 4 |
| One-shot sample | Sustain 0, decay from twice the time the envelope needs to fall to 10 %, attack from the time to the peak, release 3 |
| Percussion (below) | the SIDWave library drum `lib:kick`, `lib:snare`, `lib:hat`, `lib:open_hat`, `lib:tom`, `lib:clap` or `lib:crash` |

Percussion is recognised by the sample name (`bd`, `kick`, `bassdrum`, `sn`, `snare`, `sd`, `clap`, `hh`, `hat`, `hihat`, `oh`, `ch`, `open hat`, `openhat`, `tom`, `tomtom`, `crash`, `cym`, `splash`, `cymbal`, `ride`) or, without such a name, by a one-shot sample of at most 1.2 s that decays to a quarter of its peak and is either not periodic (zero-crossing rate above 0.35: hat, open hat or crash by length; below 0.15: kick or tom; between: snare) or short and low (at most 0.35 s, period of 55 points or more: kick or tom). White-noise snares and open hats cannot be told apart by the measurements, so an unnamed noise burst of 0.12 to 0.4 s is an open hat. In a drum voice the hit is a letter of a `drums:` pattern; in a pitched voice it is a note with the library instrument.

A name matches as a whole word: the characters around it are not letters (digits and underscores are allowed), so `kick1` is a kick and `Kickstart`, `Clapton` and `Bride` are not drums. `hihat`, `hi-hat`, `tomtom` and `cymbal` match anywhere in a name. `ride` names a drum only when the name has no other word of three or more letters apart from `cymbal` and `bell`.

Samples with identical SIDWave definitions share one instrument. SIDWave holds at most 63 distinct compiled instruments (waveform, ADSR, pulse width, vibrato and arpeggio together), so when a song needs more, the least used instruments merge into the nearest (same waveform first, then the ADSR distance) and only the most frequent vibrato and arpeggio variants are kept; the report lists what was merged or lost. Digi playback of the samples (CIA2 volume digis, `samples:` in SIDWave) is not used: it needs a dedicated SID, a base rate of at most 8 kHz and 2,000 to 4,000 bytes per second of sound, and it plays 4-bit samples that sound unlike the MOD samples on a 6581.

### Notes, levels and effects

Notes: the period is converted to the nearest semitone (`MIDI = 48 + 12 log2(428 / period x 2^(finetune / 96))`, period 428 is MIDI 48, `C3`); `--transpose` adds semitones, and notes outside C0 to A#7 move by octaves (counted). A note without a sample number uses the last sample of the channel; a sample number without a note only resets the volume. A note stays until the next note on the channel, a cut or the end of the song (a looped sample sounds until then, a one-shot sample fades by the ADSR decay).

Level: `level = round(15 x volume / 64)`, at least 1, from the time-weighted mean volume over the note, so `Cxx` at the start sets it exactly and slides and later changes average. A note whose volume reaches 0 (`C00`, a slide to 0, `EC0`) ends there.

| Effect | SIDWave | Status |
| --- | --- | --- |
| `0xy` arpeggio | instrument variant with a wavetable `+0, +x, +y` that loops, one step per tick (`frames`) | approximate: the table runs from the note start, not restarted at each row; exact when the row has a multiple of three ticks |
| `1xx`, `2xx`, `E1x`, `E2x` slides | `bend: { to, frames }` with the total movement rounded to whole semitones over the time the slide ran | approximate; slides below half a semitone and slides on an arpeggio note are dropped |
| `3xx`, `5xy` tone portamento | note with `legato: true, portamento: frames`, the time `ceil(distance / speed)` ticks | approximate: the glide is linear in SID frequency, the MOD glide is linear in period |
| `4xy`, `6xy` vibrato | per-note `vibrato` with rate `x x tick rate / 64` Hz (at most 12), depth from `y x 255 / 128` period units at the note period (at least 0.03 semitones), the delay from the first vibrato row; parameters snap to 8 depths, 8 rates and 4 delays | approximate: only when the vibrato covers half of the note |
| `Axy`, `5xy`, `6xy`, `EAx`, `EBx`, `Cxx` volume | note level (mean) and the end of the note at volume 0 | approximate |
| `ECx` note cut | `gate_off` in frames before the end of the row | exact to one frame |
| `EDx` note delay | the note starts on the nearest row | approximate (error up to half a row) |
| `Bxx`, `Dxx`, `E6x`, `EEx`, `Fxx` | the sequence of rows and the bar tempo (see above) | exact in length, within the bar for changes not on a beat |
| `7xy` tremolo, `8xx` and `E8x` panning, `9xx` sample offset, `E3x`, `E4x`, `E5x`, `E7x`, `E9x`, `EFx` | not imported | counted by effect in `effects` and listed in `losses` |

If SIDWave does not accept the score with all features, the importer drops vibrato, then slides, then tone portamento, then arpeggios one after the other and says so in `losses`. For notes shorter than 3 frames the instruments use the plain gate restart.

### Quality measure

`--quality` (or `quality: true`, or `measureModQuality`) adds `report.quality`. The reference note list is built from the MOD itself: for each kept channel, each trigger or tone portamento target with its onset and end in seconds, after the speed, tempo, jump, loop and delay effects (so a note ends at the next note, a cut or the end of the song). The imported score is read back through the structured event export, which gives the notes as SIDWave schedules them. A reference note matches an imported note of the same voice with the same pitch (a slide matches at its start or end pitch; drum hits match regardless of pitch) whose onset is within 60 ms. The report gives precision, recall, F1, the absolute onset error (mean, 95th percentile, maximum), the mean intersection over union of the sounding intervals of matched pitched notes (the gate-off time is subtracted), the figures per voice and the recall over the notes of all channels, which includes the notes the voice reduction dropped.

Measured on the committed fixtures (`test/fixtures/mod`, hand-built, written by `test/helpers/modKit.mjs`; every figure is printed by the test): `four-channel.mod` (bass, lead, harmony and drums, 160 kept notes of 192, 3 voices): F1 1.00, onset error 5.1 ms (95th percentile 9.5 ms), duration overlap 0.98, recall over all channels 0.83 (the dropped channel is 32 notes); with `--sids 2` all four channels are kept and F1 is 1.00. `effects.mod` (every mapped effect, speed and tempo changes, a jump loop, 24 notes): F1 0.96 (the delayed note, 68 ms from its row, is the one miss), onset error 4.7 ms, duration overlap 0.97. The onset error is the frame rounding of SIDWave (at most one frame, 20 ms), not an error of the mapping.

### CPU time

Measured with `process.cpuUsage` on Node 24 (`test/interchangeMod.test.mjs`): a 230 KB module with 100 patterns (6400 played rows, 31 samples of 4 KB, effects on a third of the notes) imports without SIDWave validation in 0.5 s in a warmed-up process and 1.0 s as the first import of a process, and in 2.7 s with validation (compiling the score is the largest part); a 100 KB module with 30 patterns (1920 rows) takes 0.13 to 0.21 s without validation; the four-channel fixture takes 0.02 to 0.11 s. Sample analysis is 0.09 s for 31 samples of 4 KB (0.14 s before the energy sums came from prefix sums); a sample that was analysed before costs a hash of its data. `--no-validate` skips the compile; the score is checked again when it is compiled.

### Where this differs from the SID Factory II converter

SID Factory II (`converter_mod`) converts only `M.K.` and `FLT` modules, asks the user to name the one channel to ignore, gives every instrument a triangle with a fixed envelope, tunes slides by a fixed factor, turns `Cxx` into a sustain/release command, and reports `5xy`, `6xy`, `7xy`, `8xx`, `9xx`, `Axx`, `E#x` and BPM tempo as unsupported. Matched here: the 4-channel to 3-voice reduction (the channel to drop is chosen by the score above instead of by the user), the nearest-note rule for periods, the arpeggio, slide, portamento, vibrato, set-volume and speed commands, the cut of a pattern at `Bxx` and `Dxx`, and a report of the commands that were used and not converted. Added: all 31-sample variants with 6 or 8 channels and the 15-sample layout, samples chosen by their waveform, drums, ADSR from the sample envelope, volume slides, fine slides, note cut and delay, tempo in BPM, the loop, the quality measure, and two SIDs.

## JCH NewPlayer 20.G (`sidwave import tune.prg`, `tune.sid`)

SID Factory II ships a converter for the editor data of JCH NewPlayer 20.G (`converter_jch`, GPL-2.0, read for behaviour only). It accepts a file loaded at `$0F00` with the mark `20.G` at `$0FEE`: the memory dump that the JCH editor saves (player code, a pointer block at `$0FA0` and the song data). SIDWave reads the same input: a PRG with load address `$0F00`, or a PSID/RSID file with that load address (an unpacked rip; HVSC holds about 250 of them, 201 of version `20.G4`, 28 of `20.G2`, 19 of `20.G0`). The format is detected by content: that load address and a plausible version mark at `$0FEE` (two digits, then a digit or a dot, then a digit or an upper-case letter). A detected image with another mark than `20.G` is the typed error of the JCH reader. Packed or relocated tunes (load address other than `$0F00`, the larger HVSC share of JCH NewPlayer tunes, and other player versions such as 21.G5 and NP22 to NP25) are not supported. The JCH reader rejects them with a typed error (exit 3) that says why; an image that is not loaded at `$0F00` reaches the reader only with `--from jch` or `--format jch`. The layout is taken from the published description of the editor format (pointer block, 8-byte instrument records, two-column wave table, 4-byte pulse entries, order list pairs, 2-byte sequence events); no player code is read or reproduced.

Input bounds: 64 KiB, 104 sequences of at most 128 events, order lists of at most 512 entries, at most 20,000 rows per voice, pointers inside `$1000-$CFFF`.

| JCH | SIDWave |
| --- | --- |
| Order lists 1 to 3 (pairs of transposition and sequence number; transposition is the byte minus `$80`; the list ends at `$FE` or `$FF`) | Voices 1 to 3, one pass, expanded to one grid cell per sequence row |
| Sequence event (byte0, note): note 1 to `$7D` plays MIDI note `12 + note + transposition`; `0` is gate off; `$7E` holds | Note, rest, tie |
| byte0 `$A0`-`$BF` | Selects instrument 0 to 31 for the notes that follow |
| byte0 `$90` | Legato note (no new gate) |
| byte0 `$C0`-`$DF` | Command from the command table (below) |
| Tempo: a value of 2 or more lasts value + 1 frames per row; 0 or 1 reads the break-speed table (the first filter table entry) as a groove | Per bar tempo from the real length of its rows, bars split at tempo changes as for MOD (`planBars`), 4 rows per beat unless the tempo needs another value; `e0 xx` sets the speed from its row |
| Instrument: AD, SR, restart byte, wave pointer, pulse pointer | ADSR; wave table rows as wavetable steps (waveform bits, gate, ring, sync, test; relative notes `+n`, absolute notes, `$7F` jump as the loop, `$7E` stop); pulse table entries as `set` and `add` steps with loop; hard restart omitted only for the hard-restart mode `$8x`, otherwise the plain gate restart |
| Commands `60 xy` vibrato, `8x xx` portamento, `0x yy` / `2x yy` slides | Per-note vibrato (depth `0.15 y` semitones, rate `1 + 0.75 x` Hz), legato note with `portamento` frames from the frequency distance and speed, `bend` from the speed and the length of the note (at most 12 semitones). Approximate: the units were estimated, not measured |

Not imported, counted in `commands` and `losses`: instrument alternate wave pointer (`4x`), set AD/SR (`9x`, `ax`), wave pointer (`c0`), filter and pulse pointer commands (`dx`), master volume (`f0`), the filter (instrument filter setting and filter table), the wave table dwell (low nibble of the restart byte), per-voice looping (each JCH voice loops on its own; SIDWave plays one pass and pads shorter voices), pitch offsets of wave table rows that would leave the playable range (limited to it).

Verification (`test/interchangeJch.test.mjs`): the committed image is hand-built (`test/helpers/jchKit.mjs`) without the player code, which is third-party, so it parses and imports but does not play. The differential test runs the tune's own player (libsidplayfp, SIDLite) on local HVSC tunes of versions 20.G0, 20.G2 and 20.G4 (not committed; skipped without HVSC and the engine; none of the held-out reconstruct tunes) against the compiled import and compares gate and note per player call after a search for the best start shift (2 or 3 calls). Measured, gate agreement / pitch agreement of voices 1/2/3: `24th_Amaranth_Grand_Prix_3` (20.G4) 0.57/0.96/1.00 and 0.52/0.78/-; `5KJ5` (20.G0) 0.97/0.80/0.86 and 0.26/0.82/0.86; `24th_Amaranth_GP_2_channels` (20.G2) 0.69/0.86/1.00 and 0.29/0.28/-. Rhythm agrees well and pitch less, because of unmapped commands, the dwell and the units of the pitch commands. The A1 level fails on all of them (status approximate). Across all 254 JCH NewPlayer tunes of the HVSC catalogue with load address `$0F00` and `20.G` mark, every one imports without error (the same score is compiled), median 53 ms and 95th percentile 214 ms of CPU, maximum 569 ms. The step from `20.G` to later versions was not attempted: their table bases differ and the layout was not verified.

