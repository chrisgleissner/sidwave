# A1 calibration: limitations and requirements for a second version

This file belongs to the frozen rule file `a1-rules.json` (SHA-256 `841cdae0df92ada5bc30182ad7664db1f540d19a539631c6e88cd51c18a3b1a1`) and to the held-out report `a1-heldout-report.json`. The rule file was not changed after the freeze, so its hash did not change. Status of A1: **approximate**.

## What the measured rates do and do not show

- Material defects (false accepts): development 42 of 166, held out 15 of 98.
- Benign changes (false rejects): development 4 of 32, held out 4 of 18. These counts are small, and most benign controls were vacuous (next section). The false-reject rate is therefore not a measurement of how often A1 rejects equivalent tunes in general. Its interval (held out 9.0-45.2 %) is wide for the same reason.

## Benign controls were mostly vacuous

Of the benign classes in the design, only three tested anything:

| Control | Why it tested little |
| --- | --- |
| identical recompile | The candidate compiled to the same SID as the base tune, so the render cache returned the same PCM. A1 compared a render with itself. |
| 1-sample PCM delay | A synthetic shift of the reference PCM. It tests the alignment, not the engine. |
| detune 3 cents | A real audio change, the only effective benign control. All four applicable tunes in both sets were rejected. |
| refactor: rename instrument, duplicate pattern | The refactored scores compile to byte-identical SIDs. The script skips a mutation whose compiled SID equals the base ("the compiled SID is identical to the base tune"), so these were skipped and scored nothing. |

The effective benign set was 7 identical, 7 delay and 4 detune items in the held-out run (18) and 14, 14 and 4 in the development run (32).

## Deviations from the design

1. The benign class "register writes reordered within one player call" is not implemented. A score-level refactor cannot reorder the writes of one player call without changing the compiler; no such control was run.
2. The benign class "volume of an inaudible (gated-off) voice changed" is not implemented.
3. The grid has 648 points (6 x 4 x 3 x 3 x 3), not the 432 stated in the design text.
4. Bases that do not compile to a PSID are excluded and listed in the development report: `digi_groove` (CIA2 digi samples need PRG output) and `wall_of_sid` (more than three SID chips). In the held-out set `ultisid_orchestra` was excluded for the same reason (more than three SID chips). The held-out JSON does not list it; the script does not write unsupported bases into the held-out report.
5. Many mutation classes apply to few tunes (for example sync and ring only to `metal_sync`); several classes have fewer than ten scored items, so their per-class intervals are wide.

## Held-out once-guard

The rule that the held-out set is evaluated once is enforced by `~/.c64bridge/sidwave-standalone/a1-cache/a1-state.json`, a file outside the repository. Deleting or editing it removes the guard; the guard is a protection against accidents, not against a person. The held-out run happened on 2026-11-27 (log `~/.c64bridge/sidwave-standalone/verify-heldout.log`) and is recorded in commit `72ddde2` ("Record the held-out A1 evaluation and mark A1 approximate"; the hash is that of the rebased branch). The rule file hash was recorded in the orchestrator's ledger before the run.

## Requirements for A1 version 2

- Benign controls must be rendered independently of the base tune and must differ from it in the SID bytes. A control whose SID equals the base is a failed control, not a skipped one, and the run must fail.
- Include the two missing benign classes above, and further benign changes that alter register values without changing the sound (for example equivalent envelope or pulse-width encodings).
- Add enough benign items per class for a false-reject interval narrower than 10 percentage points.
- Rendering the reference and candidate in different engine instances (or processes) so that a shared cache cannot hide a difference.
- Consider finer frequency resolution (longer windows or a second analysis for tonal content), because pitch and timbre changes that keep the band energies similar (waveform swaps, small detunes, pulse width) were the weakest area.
- New held-out tunes (generator seeds not used before) and a new freeze, as the design requires for any change to rules or features.
