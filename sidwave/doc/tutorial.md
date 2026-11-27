# Writing music with SIDWave: eight lessons

This tutorial goes through eight small scores in `data/sound/examples/learn/`. Each one adds one or two ideas to the
one before. Every score is under 120 lines, begins with a comment that explains what it teaches, compiles to a PRG and a
PSID file, and produces no lint findings. They are separate from the larger showpieces in `data/sound/examples/`.

You need Node 20 or later and the `sidwave` command (`npm install -g sidwave`, or run `npx sidwave`). Compile any
lesson and play the result in VICE, on a C64 Ultimate or in a SID player:

```sh
sidwave compile data/sound/examples/learn/01_one_voice.yaml -o lesson1.prg
sidwave compile data/sound/examples/learn/01_one_voice.yaml -o lesson1.sid
sidwave lint data/sound/examples/learn/01_one_voice.yaml
```

The complete reference is the [specification](../data/sound/sidwave.md). Each lesson links to the sections it uses.

## 1. One voice, one melody

File: `data/sound/examples/learn/01_one_voice.yaml`

A score has a few settings at the top (`tempo`, `mode` for the video standard, the `sids` chip), then `voices` and a
`timeline`. A pattern is a list of notes; each entry lasts `length` beats.

```yaml
      tune:
        length: 1          # every entry lasts one beat
        bars: 4            # the pattern has four bars of four beats (the compiler checks this)
        groove: "C4 C4 G4 G4 | A4 A4 G4 ~ | F4 F4 E4 E4 | D4 D4 C4 ~"
```

`|` ends a bar, `~` holds the previous note, `-` is a rest. See [Patterns](../data/sound/sidwave.md#patterns) and
[Timeline](../data/sound/sidwave.md#timeline).

## 2. Two voices and named instruments

File: `data/sound/examples/learn/02_bass_and_melody.yaml`

An instrument is a named sound. Voices choose a default with `instrument:`, and one note can choose another with
`@name`. A section `level` makes a section louder or softer.

```yaml
instruments:
  lead: { waveform: pulse, pulse_width: 0.35, adsr: [1, 6, 10, 5] }
  bass: { waveform: sawtooth, adsr: [0, 6, 8, 4] }
```

`adsr` is the volume envelope: attack, decay, sustain and release, each from 0 to 15. See
[Voices](../data/sound/sidwave.md#voices) and [Dynamics](../data/sound/sidwave.md#dynamics-level-and-chip-volume).

## 3. Drums from a library

File: `data/sound/examples/learn/03_drums_from_a_library.yaml`, which imports `data/sound/examples/learn/libs/chip_kit.yaml`.

A library is a file of instruments, patterns and effects with a name, a version, a licence and its provenance. A score
imports it under a namespace and uses its items as `namespace.name`.

```yaml
imports:
  - { as: kit, from: ./libs/chip_kit.yaml, version: "^1.0.0", sha256: 0108b8d40862ad5cf295e8593cd2ad8876225925256082dd9fb73231302a9337 }
```

```yaml
  groove: { bars: 2, level: mf, layers: { v1: riff, v2: root, v3: kit.beat } }
```

`sidwave lock <score>` wrote the `sha256` of the library into the import, so that a changed library is noticed.
`sidwave bundle <score> -o folder` copies the score and every library it needs into one folder that compiles without
anything else. Compiling prints the licence of each library the score used. See
[Asset libraries](../data/sound/sidwave.md#asset-libraries-sidwave-14).

## 4. Patterns, sections and a loop

File: `data/sound/examples/learn/04_patterns_and_sections.yaml`

Named `sections` combine patterns of several voices. The `timeline` lists sections, and `loop_to` says where the song
starts again, so an intro can play once.

```yaml
sections:
  intro: { bars: 2, layers: { v1: "-", v2: walk } }
  verse: { bars: 2, layers: { v1: tune, v2: walk } }
  chorus: { bars: 2, layers: { v1: high, v2: drive } }
  lift: { bars: 2, layers: { v1: "tune+5", v2: "walk+5" } }
timeline: [intro, "verse*2", chorus, lift, chorus]
loop_to: verse
```

See [Sequences, named sections and the timeline](../data/sound/sidwave.md#sequences-named-sections-and-the-timeline).

## 5. Arpeggios and vibrato

File: `data/sound/examples/learn/05_arpeggios_and_vibrato.yaml`

An arpeggio plays the notes of a chord in quick succession on one voice. Vibrato bends a note up and down.

```yaml
      am: { type: arpeggio, notes: [A3, C4, E4], frame_rate: 2, length: 4, bars: 1 }
```

```yaml
        fx:
          vibrato: { depth: 0.35, rate: 5.5, delay: 12 }
```

See [Patterns](../data/sound/sidwave.md#patterns) and [Pattern effects](../data/sound/sidwave.md#pattern-effects-fx).

## 6. Filter sweep and pulse width modulation

File: `data/sound/examples/learn/06_filter_and_pwm.yaml`

The SID has one filter. `filter_mod` moves its cutoff while a pattern plays, and `pwm_sweep` moves the width of a pulse
wave.

```yaml
          pwm_sweep: { depth: 0.3, speed: 0.5 }
```

```yaml
          filter_mod: { sweep: "+900 over 8 steps" }
```

The chip declares which voice owns the filter: `filter: { owner: v2, route: [2] }`. See
[Filter model](../data/sound/sidwave.md#filter-model-cutoffs-in-hz-and-ownership).

## 7. Songs and a sound effect for a game

File: `data/sound/examples/learn/07_songs_and_effects.yaml`

`songs` puts several songs into one player, selected by number. `effects` defines short sounds that a game starts at any
time without stopping the music.

```yaml
songs:
  - name: title
    timeline: [intro, verse, verse]
  - name: gameover
    tempo: 93.98
    loop: false
    timeline: [fallen]
```

```yaml
  coin:                          # effect number 0
    priority: 8                  # a more important effect may interrupt a less important one (0-15)
    voices: [3]                  # only voice 3 may play it
```

See [Songs](../data/sound/sidwave.md#songs) and [Effects](../data/sound/sidwave.md#effects), and
[Using the player in a game](../README.md#using-the-player-in-a-game).

## 8. Two SIDs and an echo

File: `data/sound/examples/learn/08_two_sids_and_echo.yaml`

A second SID chip adds three voices and a stereo position. An `echo` voice repeats another voice later and softer.

```yaml
  - id: 4
    name: Echo of the melody (right)
    echo: { voice: 1, delay_beats: 0.75, volume: 0.5 }
```

See [Multiple SIDs](../data/sound/sidwave.md#multiple-sids-12) and [Echo and unison](../data/sound/sidwave.md#echo-and-unison).

## Where to go next

The larger scores in `data/sound/examples/` show the same ideas at full length: `chiptune_drive` for a complete tune,
`arp_ballad` for chord arpeggios, `stereo_echo` for two SIDs, and `game_songs` for songs in a game. Run
`sidwave examples` for the list. The header of each one explains what to listen for.
