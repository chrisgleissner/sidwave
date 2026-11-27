# SIDWave reconstruction: development corpus report (S5d after repairs)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code e308b993aa0b0980, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 8
- A1 pass (approximate status): 0 of 15 evaluated
- Horizon shorter than the design horizon: 0
- Reconstruct CPU time: 3.17 s per minute of music (traces of both the tune and the recompiled score included); recovery step alone 605.9 ms per minute of music

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| pitch | 12 |
| unsupported | 8 |
| gate/hard restart | 4 |

## Tunes

| Tune | Horizon s | Strict | State | A1 | Class | First difference | Differing calls | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->28 | 19066 | 68824 | 4.02 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 35971 | 148620 | 4.14 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 4510 cycles | 288344 | 80985 | 0.98 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 17927 | 28648 | 5 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 112284 | 71992 | 4.91 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | no | no | fail | gate/hard restart | gate call 1 (0.29 s) voice 1 reg $4 | 1903 | 74220 | 3.55 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->22 | 37278 | 80414 | 3.95 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | no | no | error | pitch | pitch call 0 (0.00 s) voice 1 reg $0 7->16 | 90966 | 85965 | 4.29 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | no | no | fail | pitch | pitch call 1 (0.01 s) voice 1 reg $0 158->0 | 58803 | 22427 | 3.33 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 2921 cycles | 399424 | 220604 | 1.46 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 2543 cycles | 196336 | 107851 | 2.66 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 3 reg $e 224->22 | 2415 | 21191 | 4.11 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 3538 cycles | 360448 | 213385 | 1.37 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 145581 | 161515 | 6.53 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 | 34580 | 29265 | 5.98 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 9->0 | 261236 | 224329 | 5.93 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 2762 cycles | 119592 | 55108 | 0.53 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 4148 cycles | 224264 | 96971 | 1.29 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->29 | 8005 | 19619 | 4.24 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->22 | 15750 | 40484 | 4.28 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 64716 | 10028 | 3.86 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v1: the note needs a | 253072 | 115218 | 1.01 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 1 reg $0 0->23 | 21327 | 30951 | 3.88 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.cpu: the player needs up to 2921 cycles | 396440 | 124761 | 1.04 |

## Unsupported features and language-extension candidates

| Kind | Tunes |
| --- | ---: |
| unsupported: pitch | 22 |
| extension: a note given as an exact frequency register value (or a per-note cents offset) | 20 |
| extension: per-call frequency register values (pitch table, portamento or a vibrato shape the language lacks) | 20 |
| unsupported: waveform | 16 |
| extension: waveform that the language cannot express | 16 |
| unsupported: hard_restart | 16 |
| unsupported: filtertable | 15 |
| extension: filtertable that the language cannot express | 15 |
| unsupported: instrument_budget | 14 |
| unsupported: long_note | 11 |
| extension: hard_restart that the language cannot express | 11 |
| unsupported: global_state | 10 |
| extension: per-call global filter and volume register sequence | 10 |
| unsupported: call_timing | 7 |
| unsupported: short_note | 6 |
| unsupported: wavetable | 5 |
| extension: wavetable that the language cannot express | 5 |
| unsupported: call_rate | 5 |
| unsupported: multi_sid | 2 |
| extension: SID address map from the trace | 2 |
| unsupported: non_periodic_writes | 2 |
| unsupported: tuning | 1 |
| unsupported: pulsetable | 1 |
| extension: pulsetable that the language cannot express | 1 |

