# SIDWave reconstruction: development corpus report (S5d part 4)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code 48625f3b0de50149, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 0
- A1 pass (approximate status): 0 of 20 evaluated (turbo-fallback tunes are not evaluated)
- Turbo fallback: 3 of 24. Each of these recovered scores does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers. The saved score includes `cpu: turbo` with a warning comment. They are never strict matches and are excluded from the A1 counts.
- Horizon shorter than the design horizon: 0
- Verification: 0 of 24 tunes were verified over the whole horizon; 24 were compared over the first 10 s only because their 10 s probe was not register-state exact. "Calls that differ" for those tunes counts the first 10 s only.
- First difference at call 0 (start-up): 6 of 24
- Reconstruct CPU time: 5.66 s per minute of music with staged verification (traces of both the tune and the recompiled score included). This figure includes the saving from skipping the full retrace of tunes that fail the 10 s probe. Recovery step alone: 1548.8 ms per minute of music.

Turbo-fallback tunes:

- MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1
- MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1
- MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1

Source revision f8771b50d306; `scripts/check-reconstruct-repro.mjs` reruns tunes with an empty cache and compares them with this report.

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| timing/call rate | 11 |
| pitch | 8 |
| gate/hard restart | 4 |
| filter | 1 |

## Tunes

| Tune | Horizon s | Verified | Strict | State | Turbo | A1 | Class | First difference | Calls that differ | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 19496->20157 | 450 of 502 | 90478 | 4.41 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 19239->19668 | 496 of 502 | 230158 | 4.76 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.00 s) 4600->5539 | 2004 of 2005 | 109014 | 5.81 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | first 10 s | no | no | no | fail | filter | filter (start-up) call 0 (0.00 s) reg $16 0->128 | 500 of 502 | 85414 | 6.91 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.01 s) 6139->6563 | 1497 of 1504 | 143157 | 4.98 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | first 10 s | no | no | no | fail | gate/hard restart | gate call 1 (0.29 s) voice 1 reg $4 | 65 of 66 | 74234 | 3.71 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 17627->19668 | 236 of 502 | 81894 | 4.93 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | first 10 s | no | no | no | error | timing/call rate | timing call 1 (0.01 s) 10829->9882 | 1002 of 1003 | 156619 | 4.76 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | first 10 s | no | no | no | fail | pitch | pitch call 8 (0.16 s) voice 1 reg $0 158->124 | 15 of 23 | 28996 | 4.06 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 1 (0.02 s) 17166->3329 | 3003 of 3004 | 118335 | 5.65 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | first 10 s | no | no | yes | excluded | pitch | pitch (start-up) call 0 (0.00 s) voice 1 reg $0 0->190 | 1 of 1 | 135852 | 9.17 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 | 164 of 164 | 22083 | 6.04 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | first 10 s | no | no | no | fail | timing/call rate | timing call 4 (0.02 s) 3870->3941 | 2186 of 2507 | 263939 | 7.48 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | first 10 s | no | no | no | fail | pitch | pitch call 1 (0.02 s) voice 2 reg $7 239->30 | 2503 of 2504 | 186826 | 7.68 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->1 | 80 of 80 | 30471 | 7.62 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | first 10 s | no | no | no | fail | timing/call rate | timing call 2 (0.01 s) 3932->3983 | 2503 of 2507 | 231877 | 5.64 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->1 | 645 of 645 | 58079 | 4.88 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | first 10 s | no | no | no | fail | pitch | pitch call 1 (0.02 s) voice 1 reg $0 193->12 | 2503 of 2504 | 133347 | 8.14 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | first 10 s | no | no | no | fail | pitch | pitch call 3 (0.06 s) voice 1 reg $0 0->29 | 499 of 502 | 35351 | 5.45 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | first 10 s | no | no | no | fail | pitch | pitch call 3 (0.06 s) voice 1 reg $0 0->160 | 494 of 502 | 63342 | 6.36 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 1 reg $0 0->23 | 502 of 502 | 107392 | 5.97 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 16236->15767 | 2003 of 2004 | 108233 | 6.83 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | first 10 s | no | no | no | fail | pitch | pitch call 3 (0.06 s) voice 1 reg $0 0->165 | 499 of 502 | 47928 | 4.18 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 1 (0.02 s) 16974->3329 | 3003 of 3004 | 120975 | 5.77 |

## Unsupported features and language-extension candidates

| Kind | Tunes |
| --- | ---: |
| unsupported: pitch | 22 |
| extension: a note given as an exact frequency register value (or a per-note cents offset) | 20 |
| extension: per-call frequency register values (pitch table, portamento or a vibrato shape the language lacks) | 19 |
| unsupported: instrument_budget | 18 |
| unsupported: hard_restart | 14 |
| unsupported: long_note | 12 |
| extension: hard_restart that the language cannot express | 8 |
| unsupported: wavetable | 7 |
| extension: wavetable that the language cannot express | 7 |
| unsupported: call_timing | 7 |
| unsupported: global_table | 6 |
| unsupported: short_note | 6 |
| unsupported: filtertable | 5 |
| extension: filtertable that the language cannot express | 5 |
| unsupported: call_rate | 5 |
| unsupported: non_periodic_writes | 2 |
| unsupported: global_state | 2 |
| extension: per-call global filter and volume register sequence | 2 |
| unsupported: tuning | 1 |
| unsupported: pulsetable | 1 |
| extension: pulsetable that the language cannot express | 1 |

