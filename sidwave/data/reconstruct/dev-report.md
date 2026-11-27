# SIDWave reconstruction: development corpus report (S5d part 3 final)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code 4d1898059a7a627c, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 0
- A1 pass (approximate status): 0 of 15 evaluated (turbo-fallback tunes are not evaluated)
- Turbo fallback: 8 of 24. Each of these recovered scores does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers. The saved score includes `cpu: turbo` with a warning comment. They are never strict matches and are excluded from the A1 counts.
- Horizon shorter than the design horizon: 0
- Verification: 0 of 24 tunes were verified over the whole horizon; 24 were compared over the first 10 s only because their 10 s probe was not register-state exact. "Calls that differ" for those tunes counts the first 10 s only.
- First difference at call 0 (start-up): 10 of 24
- Reconstruct CPU time: 4.73 s per minute of music with staged verification (traces of both the tune and the recompiled score included). This figure includes the saving from skipping the full retrace of tunes that fail the 10 s probe. With full verification of every tune (--verify full): 7.88 s per minute of music. Recovery step alone: 2130.4 ms per minute of music.

Turbo-fallback tunes:

- MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1
- MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1
- MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1
- MUSICIANS/D/Dgazz/Icy_Slide.sid:1
- DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1
- DEMOS/A-F/City_of_New_Orleans.sid:1
- MUSICIANS/S/Sad/Pahos.sid:1
- MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1

Source revision ec7c680173fd; `scripts/check-reconstruct-repro.mjs` reruns tunes with an empty cache and compares them with this report.

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| pitch | 8 |
| gate/hard restart | 7 |
| timing/call rate | 7 |
| filter | 1 |
| ADSR | 1 |

## Tunes

| Tune | Horizon s | Verified | Strict | State | Turbo | A1 | Class | First difference | Calls that differ | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | first 10 s | no | no | no | fail | gate/hard restart | gate call 1 (0.02 s) voice 1 reg $4 9->1 | 501 of 502 | 68240 | 3.97 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 19239->19668 | 496 of 502 | 148742 | 4.38 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | first 10 s | no | no | yes | excluded | filter | filter call 1 (0.00 s) reg $16 2->128 | 2004 of 2005 | 80742 | 4.75 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->undefined | 502 of 502 | 33699 | 6.05 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.01 s) 6139->6563 | 1497 of 1504 | 75725 | 4.67 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | first 10 s | no | no | no | fail | gate/hard restart | gate call 1 (0.29 s) voice 1 reg $4 | 65 of 66 | 74234 | 3.88 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 17627->19668 | 500 of 502 | 80009 | 4.53 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | first 10 s | no | no | no | error | timing/call rate | timing call 1 (0.01 s) 10829->9882 | 1002 of 1003 | 89751 | 4.11 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | first 10 s | no | no | no | fail | pitch | pitch call 8 (0.16 s) voice 1 reg $0 158->124 | 15 of 23 | 27166 | 3.69 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | first 10 s | no | no | yes | excluded | pitch | pitch call 1 (0.02 s) voice 1 reg $0 22->0 | 2910 of 2912 | 222452 | 5.48 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 2 (0.01 s) 2500->2469 | 2450 of 2455 | 117562 | 7.79 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $e 224->22 | 164 of 164 | 21191 | 4.93 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 4 (0.02 s) 3870->3941 | 2501 of 2507 | 222612 | 5.7 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | first 10 s | no | no | no | fail | pitch | pitch call 1 (0.02 s) voice 2 reg $7 239->30 | 2503 of 2504 | 161921 | 6.03 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | first 10 s | no | no | yes | excluded | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $e 48->97 | 80 of 80 | 29192 | 5.53 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | first 10 s | no | no | no | fail | ADSR | adsr (start-up) call 0 (0.00 s) voice 1 reg $5 15->0 | 2504 of 2505 | 233240 | 5.03 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->1 | 645 of 645 | 56753 | 3.97 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 8->0 | 2504 of 2504 | 97308 | 5.28 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | first 10 s | no | no | no | fail | pitch | pitch call 3 (0.06 s) voice 3 reg $e 0->29 | 499 of 502 | 20480 | 4.41 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $f 2->0 | 502 of 502 | 40482 | 4.61 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 | 502 of 502 | 16404 | 4.4 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 16236->3942 | 2003 of 2004 | 114653 | 4.75 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $f 2->0 | 502 of 502 | 28360 | 3.94 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->undefined | 2977 of 2978 | 126232 | 4.87 |

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

