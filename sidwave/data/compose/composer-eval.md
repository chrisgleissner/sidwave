# Composer 2 evaluation

These are proxy measures. They count properties of the generated notes and of the compiled scores. None of them measures
musical quality, and nothing here claims that composer 2 sounds better or worse than the version 1 generator.

- Package version: 0.1.0
- Profiles: 33; held-out seeds per profile: 8; scores per version: 264
- Seed rule: first 4 bytes (big endian) of SHA-256("sidwave-composer-eval:heldout-v1:<i>"), i = 0..7. The seeds are 3209333012, 492371764, 2810774459, 3899300216, 3797515682, 4049110642, 2475909327, 2496590011.
- Version 1 mapping: style from the profile palette (chip and saw: chiptune, soft: ambient, funk: funk); root is the profile tonic; preset classic; PAL; the same seeds.
- Budget: 80 percent of a video frame divided by the score's speed, in cycles of the worst player call of up to 3000 calls on the bundled 6502 interpreter.
- Regenerate with `nice -n 10 node scripts/evaluate-composer.mjs`; the JSON file next to this one has every score's numbers.

## Technical correctness and lint

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
| Parse, compile to PRG and PSID | 264 / 264 | 264 / 264 |
| Lint clean (no finding except informational notes) | 264 / 264 | 264 / 264 |
| Worst player call within the budget | 264 / 264 | 264 / 264 |
| Mean worst player call (cycles) | 3528 | 4164 |


## Structure

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
| Mean bars | 8 | 26.242 |
| Mean timeline sections | 1 | 4.03 |
| Mean pitched voices | 3 | 2.97 |
| Mean lead notes | 34.667 | 136.58 |
| Repetition: share of lead bars equal to an earlier lead bar | 0.021 | 0.046 |
| Motif recurrence: share of lead 3-interval windows (or their inversions) that occur more than once | 0.512 | 0.449 |

## Variation

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
| Pitch-class entropy of the lead (bits, at most 3.58) | 2.495 | 2.754 |
| Interval entropy of the lead (bits) | 2.708 | 3.577 |
| Distinct lead note durations | 3.508 | 6.045 |
| Entropy of lead note durations (bits) | 1.704 | 1.614 |
| Inter-seed distinctness (mean over profiles of 1 - Jaccard similarity of lead 4-note windows) | 0.965 | 0.998 |

## Counterpoint rule violations

Lead against the lowest voice, and against the counter line where there is one, on strong beats (beats 1 and 3 in 4/4, beat 1 in 3/4).
The rules are consonance, no parallel fifths or octaves between consecutive strong beats, and no voice crossing.

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
| Strong-beat sonorities compared | 448 | 14643 |
| Violations | 0 | 29 |
| Violations per 100 sonorities | 0 | 0.2 |
| By kind | {} | {"dissonance":29} |

## Completion operations and protected material

Each operation ran on every composer 2 profile (first held-out seed, second seed for the generated material). The original
and the completed score were run on the bundled 6502 interpreter and the SID register writes of every protected voice were
compared call by call.

| Operation | Runs | Completed | Protected material identical | Player calls compared |
| --- | --- | --- | --- | --- |
| continue | 33 | 33 | 33 | 327244 |
| fill-section | 33 | 33 | 33 | 327244 |
| harmonise | 33 | 33 | 33 | 97767 |
| accompany | 33 | 33 | 33 | 97767 |
