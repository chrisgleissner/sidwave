# SIDWave reconstruction: development corpus report (baseline)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code 7f32f5dc115c1453, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 22
- A1 pass (approximate status): 0 of 2 evaluated
- Horizon shorter than the design horizon: 0
- Reconstruct CPU time: 6.08 s per minute of music (traces of both the tune and the recompiled score included); recovery step alone 10153.1 ms per minute of music

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| unsupported | 22 |
| pitch | 2 |

## Tunes

| Tune | Horizon s | Strict | State | A1 | Class | First difference | Differing calls | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.voices[2].patterns.P22.length: -42.9375 | 55680 | 57329 | 4.14 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v1: note B7 (after t | 61376 | 160458 | 5.2 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i1.hard_restart: zero frame | 288344 | 110262 | 5.04 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v1: note B7 (after t | 19952 | 35480 | 5.89 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i3.hard_restart: zero frame | 177976 | 99168 | 4.91 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v2: the note needs a | 9752 | 73277 | 3.87 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i22.hard_restart.frames: 64 | 72096 | 38651 | 4.49 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i99.pulsetable.steps: expec | 144192 | 320807 | 7.91 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i28.hard_restart.frames: 18 | 72104 | 47584 | 3.87 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.voices[0].patterns.P3.length: 0.0104166 | 399424 | 399301 | 6.09 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i1.hard_restart: zero frame | 196336 | 103388 | 7.5 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 104->101 | 3283 | 21113 | 7.57 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i189.filtertable.steps: exp | 360448 | 540856 | 9.99 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i1.hard_restart: zero frame | 206240 | 159642 | 5.76 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i18.hard_restart: zero fram | 55096 | 64977 | 5.52 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i217.hard_restart: zero fra | 359904 | 238320 | 6.84 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i10.hard_restart: zero fram | 119592 | 104553 | 4 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i2.hard_restart: zero frame | 224264 | 73560 | 5.17 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.voices[0].patterns.P18.length: -1.25 is | 26664 | 26361 | 4.42 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.voices: more than 63 distinct voice/pat | 26792 | 68859 | 5.04 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 64444 | 14927 | 7.64 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i1.hard_restart: zero frame | 253072 | 175509 | 13.52 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments: pulsetable data exceeds 25 | 35584 | 74938 | 4.45 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.instruments.i87.hard_restart.frames: 27 | 396440 | 152737 | 4.84 |

## Unsupported features and language-extension candidates

| Kind | Tunes |
| --- | ---: |
| unsupported: pitch | 23 |
| extension: a note given as an exact frequency register value (or a per-note cents offset) | 23 |
| extension: per-call frequency register values (pitch table, portamento or a vibrato shape the language lacks) | 20 |
| unsupported: pulsetable | 19 |
| extension: pulsetable that the language cannot express | 19 |
| unsupported: tuning | 16 |
| unsupported: waveform | 16 |
| extension: waveform that the language cannot express | 16 |
| unsupported: filtertable | 15 |
| extension: filtertable that the language cannot express | 15 |
| unsupported: hard_restart | 11 |
| extension: hard_restart that the language cannot express | 11 |
| unsupported: global_state | 10 |
| extension: per-call global filter and volume register sequence | 10 |
| unsupported: call_timing | 7 |
| unsupported: call_rate | 5 |
| unsupported: multi_sid | 2 |
| extension: SID address map from the trace | 2 |
| unsupported: non_periodic_writes | 2 |
| unsupported: wavetable | 1 |
| extension: wavetable that the language cannot express | 1 |

