# SIDWave reconstruction corpus

`corpus-manifest.json` lists the 30 HVSC subtunes (24 development, 6 held out) that SIDWave reconstruction is developed and measured on. It holds paths, MD5 values, subtune numbers, lengths, header and trace features, feature bins, groups and the split. It contains no SID data. HVSC itself is not part of this repository: corpus runs need a local copy, and the tests that use it skip when it is missing.

The manifest is frozen. Its SHA-256 is recorded in the project ledger before any tuning. Held-out results are recorded once. If a held-out tune is used for tuning, new held-out tunes are drawn with the same procedure, excluding the used ones.

## Procedure

`scripts/select-corpus.mjs` runs these steps:

1. Pool: every Songlengths entry (MD5 and subtune) with a length of at least 30 s.
2. Candidates: the pool ordered by SHA-256 of the MD5 (lower-case hex) followed by the decimal subtune number. The first 3,000 are traced on the SIDLite engine of libsidplayfp-wasm for min(60 s, Songlengths length). The clock and model come from the PSID header.
3. Features: header features (magic, model, clock, SID count, speed flag) and trace features from the frame-state IR (`sidwave/reconstruct`, `features.ts`): calls per frame, writes per call, sync, ring, test bit, filter routing and modes, waveform combinations, hard restart rate, note programs per minute, non-periodic `$D418` sample writes and intro length before the first repetition. Style features come from the SIDFlow full export (sidflow-data release 1.0.0, `sidcorr-hvsc-full-features-1.jsonl.gz`, verified against `SHA256SUMS`).
4. Cover: greedy selection. Each pick maximises the number of bin slots that still have fewer than two tunes. Ties are broken by hash order. At most two tunes per composer. When all bins are covered before 30 tunes are selected, the rest are picked by bin rarity.
5. Groups: composer plus player signature (SHA-256 of 512 bytes at the init address and 512 bytes at the play address). Groups are ordered by SHA-256 of the group id. Six held-out tunes are taken from the lowest groups, provided each held-out tune has a bin that the development set also covers.
6. The selected tunes are traced a second time. The run fails if any feature differs.

Traces and features are cached by content in `~/.c64bridge/sidwave-standalone/corpus-cache/`. The key is MD5, subtune, engine version, horizon, record limit and feature code version. A rerun traces only what is missing.

## Rerun

```
npm ci && npm run build
HVSC_DIR=/path/to/C64Music nice -n 10 node scripts/select-corpus.mjs
```

Options: `--out`, `--cache`, `--sidflow DIR` (default `~/.c64bridge/sidwave-standalone/sidflow-data`, containing the bundle and `SHA256SUMS`), `--no-sidflow`, `--candidates`, `--seconds`, `--workers` (at most 4), `--skip-verify`. A full run took about two hours on a loaded machine. The result must be identical for the same HVSC, Songlengths file, engine version and feature code version; compare the SHA-256 of the manifest.
