# Interchange formats

SIDWave scores can be exported to and imported from other formats. Every mapping below lists what maps exactly, what maps approximately and what is lost. No import embeds the source file in the score to fake a lossless round trip: an imported score contains only notes, tempos and metres that SIDWave plays.

All commands read at most 16 MiB, never modify their input, never overwrite the input file, never use the network, and refuse to overwrite an existing output without `--force` (imports and `render`; `render` checks every target before it writes any). Parsers bound their work (see each section). Exit codes and the `--json` envelope are those of the command line (`{ ok, command, result | error }`): a malformed or unreadable input file is exit 3 (`input`), a refused score for stems is exit 5 (`limit_exceeded`), a usage mistake is exit 2.

```
sidwave export <file> [--format events|midi|musicxml] [-o <out>] [--song <n>] [--ppq <n>] [--bend] [--json]
sidwave import <file> [--format midi|musicxml|goattracker|furnace] [-o <out.yaml>] [--grid <beats>] [--voices 1-3]
                      [--no-drums] [--no-bend] [--title <text>] [--mode PAL|NTSC] [--no-validate] [--force] [--json]
sidwave render <score> --stems [-o <dir>] [--force] [--seconds <s>] [--rate <hz>] [--engine residfp|sidlite] [--model 6581|8580] [--song <n>]
```

Library entry point: `sidwave/export` (`exportEvents`, `exportMidi`, `importMidi`, `parseSmf`, `writeSmf`, `renderStems`, `writeWav`).

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

## WAV and stems

`sidwave render` renders the mix through the libsidplayfp engine (the optional `libsidplayfp-wasm` package) as a 16-bit mono WAV. `--engine sidlite` selects the fast SIDLite model (default `residfp`; `--emulation` is an alias), `--model` forces the SID model, `--seconds` and `--rate` set the length and rate (default 48000 Hz; `--sample-rate` is an alias). `--song` is 1-based like the other run commands.

`sidwave render score.yaml --stems -o dir` (`-o -` is refused; the default directory is `<name>-stems`) writes `<name>.mix.wav`, one `<name>.v<id>.wav` per voice and `<name>.stems.json`. Each stem is a compile of the score in which the layers of all other voices are rests, rendered through the same player. The idle SID is not silent in the emulation (a constant offset for each voice and the master volume), so a score with every voice muted is rendered as well and subtracted from the stems; a stem holds only what its voice adds. A voice that echoes, follows or doubles another voice cannot be separated from its source and is rendered together with it (`voices` in the manifest lists both).

The manifest labels the stems `additive: true` or `false`. Stems are non-additive when voices influence each other, which the tool detects from the score: the SID filter in use (a filter table, a filter owner, `filter_env` or `filter_mod`; the routed voices share one filter), ring modulation, hard sync, and copies of other voices. `additive` is true only when nothing couples the voices and the measured energy ratio is within the tolerance: the summed energy of the stems must be within 15 % of the energy of the mix after removing the baseline. The manifest records `energyRatio` and `energyWithinTolerance` (measured on SIDLite: 0.97 for a three-voice test score); a score without coupling whose ratio is outside the tolerance is labelled non-additive. They do not add up sample by sample. A muted voice makes the play call shorter, so the register writes of the voices after it land a few hundred cycles earlier in the call, which shifts oscillator phases (relative RMS difference 0.3 to 0.4, reported as `sumError.relativeRms`). Scores with digi samples (the PSID player omits them) and scores with more than three SIDs are refused.

The tests check the WAV header and samples with the independent `wavefile` parser (MIT, dev dependency only).
