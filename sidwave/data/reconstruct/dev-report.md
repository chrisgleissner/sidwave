# SIDWave reconstruction: development corpus report (S5d part 3 final)

Development tunes only (24); held-out tunes are not run. Manifest SHA-256 a555e5955e28c138, code fcb20655cf529d3c, engine libsidplayfp-wasm 1.1.1.

- Strict exact: 0 of 24
- Register state exact (secondary, weaker): 0 of 24
- Recovered score did not compile: 1
- A1 pass (approximate status): 0 of 14 evaluated (turbo-fallback tunes are not evaluated)
- Turbo fallback: 8 of 24. Each of these recovered scores does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers. The saved score includes `cpu: turbo` with a warning comment. They are never strict matches and are excluded from the A1 counts.
- Horizon shorter than the design horizon: 0
- Verification: 1 of 24 tunes were verified over the whole horizon; 23 were compared over the first 10 s only because their 10 s probe was not register-state exact. "Calls that differ" for those tunes counts the first 10 s only.
- First difference at call 0 (start-up): 12 of 24
- Reconstruct CPU time: 1.71 s per minute of music with staged verification (traces of both the tune and the recompiled score included). This figure includes the saving from skipping the full retrace of tunes that fail the 10 s probe. With full verification of every tune (--verify full): 7.88 s per minute of music. Recovery step alone: 1602.2 ms per minute of music.

Turbo-fallback tunes:

- MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1
- MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1
- MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1
- MUSICIANS/D/Dgazz/Icy_Slide.sid:1
- DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1
- DEMOS/A-F/City_of_New_Orleans.sid:1
- MUSICIANS/S/Sad/Pahos.sid:1
- MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1

Source revision 331ae838f89c; `scripts/check-reconstruct-repro.mjs` reruns tunes with an empty cache and compares them with this report.

## Root-cause classes (first material difference)

| Class | Tunes |
| --- | ---: |
| gate/hard restart | 7 |
| pitch | 7 |
| timing/call rate | 5 |
| volume | 2 |
| filter | 1 |
| ADSR | 1 |
| unsupported | 1 |

## Tunes

| Tune | Horizon s | Verified | Strict | State | Turbo | A1 | Class | First difference | Calls that differ | Score bytes | CPU s/min |
| --- | ---: | :-: | :-: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |
| MUSICIANS/A/Ass_It/DLL-Sound.sid:1 | 139 | first 10 s | no | no | no | fail | gate/hard restart | gate call 1 (0.02 s) voice 1 reg $4 9->1 | 501 of 502 | 68240 | 1.2 |
| MUSICIANS/M/Mythus/Odd_Jam.sid:1 | 153.219 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.02 s) 19239->19666 | 496 of 502 | 148742 | 1.61 |
| MUSICIANS/D/Dr_Piotr/Defibrylacja.sid:1 | 180 | first 10 s | no | no | yes | excluded | filter | filter call 1 (0.00 s) reg $16 2->128 | 2004 of 2005 | 80742 | 1.65 |
| MUSICIANS/W/Wijnhoven_Joachim/Bomb_Jack_Title_Deluxe_2SID.sid:1 | 49.797 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->undefined | 502 of 502 | 33699 | 2.95 |
| MUSICIANS/N/Nordischsound/Ninjas_Delight.sid:1 | 148.129 | first 10 s | no | no | no | fail | timing/call rate | timing call 1 (0.01 s) 6139->6564 | 1497 of 1504 | 75725 | 1.61 |
| MUSICIANS/B/Beggerow_Alan/Meet_Me_in_St_Louis.sid:1 | 135.988 | first 10 s | no | no | no | fail | gate/hard restart | gate call 1 (0.29 s) voice 1 reg $4 | 65 of 66 | 74234 | 0.99 |
| MUSICIANS/H/Hubbard_Rob/Skate_or_Die_intro.sid:1 | 180 | first 10 s | no | no | no | fail | volume | volume (start-up) call 0 (0.00 s) reg $18 15->0 | 502 of 502 | 80009 | 1.28 |
| MUSICIANS/T/Toggle/Cheers_and_Tributes.sid:1 | 180 | first 10 s | no | no | no | error | timing/call rate | timing call 1 (0.01 s) 10829->9883 | 1002 of 1003 | 89751 | 1.3 |
| MUSICIANS/Z/Zonzo/Xcellent_part_3.sid:1 | 180 | first 10 s | no | no | no | fail | volume | volume (start-up) call 0 (0.00 s) reg $18 9->0 | 23 of 23 | 27166 | 0.77 |
| MUSICIANS/S/SIDwave/Electro_Mechanica.sid:1 | 180 | first 10 s | no | no | yes | excluded | pitch | pitch call 1 (0.02 s) voice 1 reg $0 22->0 | 2911 of 2912 | 222452 | 2.21 |
| MUSICIANS/L/Linus/Your_Time_Is_Running_Thin.sid:1 | 61.289 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 2 (0.01 s) 2500->2467 | 2450 of 2455 | 117562 | 4.63 |
| MUSICIANS/H/Hancock_John/Die_Hard_2_Die_Harder.sid:3 | 40 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $e 224->22 | 164 of 164 | 21191 | 2.35 |
| MUSICIANS/D/Dgazz/Icy_Slide.sid:1 | 180 | first 10 s | no | no | yes | excluded | timing/call rate | timing call 4 (0.02 s) 3870->3944 | 2501 of 2507 | 222612 | 2.33 |
| MUSICIANS/P/PCH/Music_Dream.sid:1 | 103 | first 10 s | no | no | no | fail | pitch | pitch call 1 (0.02 s) voice 2 reg $7 239->30 | 2503 of 2504 | 161921 | 2.95 |
| DEMOS/UNKNOWN/Music_Shop/At_the_Hop.sid:1 | 49 | first 10 s | no | no | yes | excluded | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $e 48->97 | 80 of 80 | 29192 | 2.51 |
| MUSICIANS/B/Bakewell_Dwayne/Experiment_2.sid:1 | 180 | first 10 s | no | no | no | fail | ADSR | adsr (start-up) call 0 (0.00 s) voice 1 reg $5 15->0 | 2503 of 2505 | 233240 | 2.18 |
| DEMOS/A-F/City_of_New_Orleans.sid:1 | 159 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->1 | 645 of 645 | 56753 | 1.19 |
| MUSICIANS/S/Sad/Pahos.sid:1 | 112 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 8->0 | 2504 of 2504 | 97308 | 2.4 |
| MUSICIANS/Z/Zirias/EX_Beach.sid:1 | 66.555 | first 10 s | no | no | no | fail | pitch | pitch call 3 (0.06 s) voice 3 reg $e 0->29 | 499 of 502 | 20480 | 1.8 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:15 | 67.034 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $f 2->0 | 502 of 502 | 40482 | 1.96 |
| MUSICIANS/C/Chiummo_Gaetano/A_Walk_in_the_Countryside_3SID.sid:1 | 180 | first 10 s | no | no | no | fail | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 | 502 of 502 | 16404 | 0.99 |
| MUSICIANS/P/PRI/Hit_n_Run.sid:1 | 158 | - | no | no | no | not evaluated | unsupported | no compile: Invalid SIDWAVE at $.timeline[0].layers.v1: the note needs a | 31634 of 31634 | 114697 | 1.26 |
| MUSICIANS/A/Avory_Sarah_Jane/Soul_Force.sid:14 | 88.979 | first 10 s | no | no | no | fail | pitch | pitch (start-up) call 0 (0.00 s) voice 3 reg $f 2->0 | 502 of 502 | 28360 | 1.34 |
| MUSICIANS/S/SIDwave/Gnumpf_Espresso.sid:1 | 167 | first 10 s | no | no | yes | excluded | gate/hard restart | gate (start-up) call 0 (0.00 s) voice 1 reg $4 0->undefined | 2977 of 2978 | 126232 | 1.97 |

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

