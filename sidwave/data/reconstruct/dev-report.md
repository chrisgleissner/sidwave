# SIDWave reconstruction: development corpus report (S5d part 2)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code 7edf80101cade8f5, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 1
- A1 pass (approximate status): 0 of 22 evaluated
- Horizon shorter than the design horizon: 0
- Reconstruct CPU time: 4.74 s per minute of music (traces of both the tune and the recompiled score included); recovery step alone 550.2 ms per minute of music

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| gate/hard restart | 13 |
| pitch | 5 |
| filter | 3 |
| volume | 2 |
| unsupported | 1 |

## Tunes

| Tune | Horizon s | Strict | State | A1 | Class | First difference | Differing calls | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 19065 | 68845 | 3.83 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | no | no | fail | filter | filter call 0 (0.00 s) reg $16 0->128 | 35968 | 148641 | 4.09 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 137789 | 81006 | 5.31 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | no | no | fail | filter | filter call 0 (0.00 s) reg $16 0->128 | 17923 | 28669 | 5.13 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 0->undefined | 112230 | 72013 | 5.01 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | no | no | fail | gate/hard restart | gate call 1 (0.29 s) voice 1 reg $4 | 1903 | 74241 | 3.53 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | no | no | fail | volume | volume call 0 (0.00 s) reg $18 15->1 | 37999 | 80415 | 3.82 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | no | no | error | pitch | pitch call 0 (0.00 s) voice 1 reg $0 7->16 | 90966 | 85965 | 4.39 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | no | no | fail | volume | volume call 0 (0.00 s) reg $18 15->1 | 67 | 22428 | 2.99 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | no | no | fail | pitch | pitch call 1 (0.02 s) voice 1 reg $0 22->0 | 310594 | 220625 | 6.62 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 0->undefined | 84299 | 107852 | 7.99 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | no | no | fail | pitch | pitch call 0 (0.00 s) voice 3 reg $e 224->22 | 2415 | 21191 | 4.43 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 237662 | 213385 | 6.03 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 145574 | 161536 | 6.59 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 | 34576 | 29266 | 6.06 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 9->0 | 261852 | 224350 | 5.94 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 | 87378 | 55109 | 4.84 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 8->0 | 142782 | 96992 | 6.39 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | no | no | fail | filter | filter call 0 (0.00 s) reg $16 0->128 | 8774 | 19640 | 3.92 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | no | no | fail | pitch | pitch call 1 (0.15 s) voice 3 reg $f 2->0 | 15755 | 40505 | 4.32 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | no | no | fail | gate/hard restart | gate call 1 (0.01 s) voice 1 reg $4 0->undefined | 64714 | 10049 | 3.77 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v1: the note needs a | 253072 | 115218 | 1.07 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | no | no | fail | pitch | pitch call 1 (0.13 s) voice 3 reg $f 2->0 | 21332 | 30972 | 3.93 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | no | no | fail | gate/hard restart | gate call 0 (0.00 s) voice 1 reg $4 0->undefined | 318170 | 124782 | 6.21 |

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

