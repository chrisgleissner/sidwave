# Preservation bundles

`sidwave preserve <file.sid> [--song n] [--seconds s] [-o dir]` writes a bundle that keeps a SID tune as a SIDWave score together with everything needed to check, offline and later, what the score is and how well it reproduces the tune. `sidwave preserve --verify dir` checks a bundle.

The bundle describes a reconstruction of the tune within a stated horizon. It does not claim that the score is the tune.

## Layout

| File | Content |
| --- | --- |
| `score.yaml` | The reconstructed SIDWave score |
| `reconstruction-report.json` | The full report of `reconstructSid`: horizon, call rate, unsupported features, F-diff summaries, language-extension candidates |
| `original.sid` | The original SID, only with `--include-original --rights-permitted` |
| `preservation.json` | The manifest |

The output directory must not exist or must be empty.

## Rights

The original SID is never stored unless the caller asserts that redistribution is permitted: `--include-original` is refused (exit 2) without `--rights-permitted`, and `--rights-permitted` alone changes the `redistribution` field but adds no file. SIDWave does not check the assertion. The manifest holds the author, name and released (copyright) fields of the PSID header, and with `--stil STIL.txt --stil-path /MUSICIANS/...` the STIL entry for the tune from a local STIL file. The `redistribution` field is `unknown` unless the caller asserted `permitted`. The score and the manifest hold no SID bytes; the tests check this. The score of a copyrighted tune is a reconstruction of that work and may need the rights holder's permission to publish.

## Manifest `preservation.json`, schema `sidwave-preservation/1`

The file is JSON with two-space indentation. It holds no time stamp, so the same inputs, tools and options give the same bytes.

| Field | Content |
| --- | --- |
| `schema` | `sidwave-preservation/1` |
| `files` | Map from file name to `{ sha256, bytes, role }` for every file of the bundle except the manifest. Roles: `score`, `report`, `original`. File names are plain names, not paths |
| `source` | `md5`, `sha256` and `bytes` of the SID file, `subtune` (1-based), `songs`, `magic` (PSID or RSID), `version`, `originalIncluded` |
| `referenceConfiguration` | `clock` (the clock the traces used), `headerClock`, `sidModels` from the header, `sidCount` (SIDs that wrote registers), `sidAddresses`, `loadAddress`, `initAddress`, `playAddress`, `speed` (VBI or CIA for the subtune), `emulation` (`sidlite`), `roms`: `"no ROMs"` or the SHA-256 of each ROM image that was supplied |
| `identities` | `sidwavePackage` and `compiler` (name and version; the compiler and player are part of the package), `engine` (id, version, emulation), `irCodeVersion` (the version of the frame-state IR), `compileOptions` (`format: "sid"`, `loop`) |
| `horizon` | `seconds`, `cycles`, `calls`, `clock`, `song`: the part of the tune that the verdict covers. It is never shortened silently |
| `verdict` | `strict` (the strict F-diff: register state, in-call control-write order and call timing show no difference, standard alignment, equal call count), `registerStateExact` (weaker: register state after each call only), `t0` and `t1` (always `not applicable`: they compare the writes of one player), `a1` (`status`: `approximate`, the calibration status of A1; `result`: `pass`, `fail`, `not evaluated` or `not run`; `reason` when it was not evaluated, for example because the pinned ROMs were not supplied), `ladder` (T0, T1, A0, A1 and the highest level, when the ladder ran), `differingCalls`, `firstDifference`, `callCountMismatch` |
| `fingerprints` | `reference` and `recompiled`: SHA-256 over the call count and the SID count, then for each compared call and SID the 25 registers and the control-write sequence of each voice. `calls` is the number of compared calls, `referenceFirstCall` and `recompiledFirstCall` are the call indexes where the comparison starts (the init call is skipped). The cycle of a call is not part of the fingerprint. When the verdict is strict, the two values are equal |
| `compiled` | `sha256` and `bytes` of the PSID that the score compiles to, or `null` when it did not compile |
| `ambiguities` | List of `{ kind, detail }`: unsupported features (for example non-periodic writes), language-extension candidates, phantom notes inferred from a hard restart at the horizon, note frequencies that are not equal-temperament notes, irregular call timing, a call-count mismatch, the first difference of an inexact reconstruction, a compile failure |
| `rights` | `title`, `author`, `released`, `stil` (`path`, `text`; only when given), `redistribution` (`unknown` or `permitted`), `note` |

## Verification

`sidwave preserve --verify dir` runs these checks and exits 0 only when all of them pass.

1. For each file of the manifest: the file exists and its SHA-256 and size match. A file with a name that is not plain, or that is missing, fails.
2. No file in the directory is missing from the manifest.
3. `original.sid`, when present, matches the MD5 and SHA-256 of `source`; `source.originalIncluded` agrees with the file list.
4. `score.yaml` is compiled with the recorded options. The compiled bytes must have the recorded SHA-256 and size. When the SIDWave version differs from the recorded one, the check can fail for that reason, and the report says so in `identityNotes`.
5. The compiled SID is traced for the recorded horizon on SIDLite. The fingerprint of the compared calls must equal `fingerprints.recompiled`.
6. A strict verdict needs equal `reference` and `recompiled` fingerprints.
7. With `original.sid`: the F-diff of the original and the recompiled trace is computed again and its strict result must equal `verdict.strict`.

What the verification proves: the files are the ones the manifest lists, the score recompiles offline to the recorded program, that program produces the recorded register trace, and (with the original) the recorded verdict. Without the original it cannot recompute `strict` for a bundle that says `strict: false`; it checks that the recompiled trace matches its fingerprint. The audio level A1 is not recomputed offline: it needs the original SID and the pinned ROM images, so only the recorded status is kept.

A bundle of an inexact reconstruction still verifies: it states what it does not reproduce in `verdict` and `ambiguities`, and `verify` checks that the statement is true of the files.

## Library

`createPreservation(sidBytes, options)` returns `{ manifest, files, report }`, `writePreservation(bundle, dir)` writes it, `verifyPreservation(dir, { engine })` returns `{ ok, checks, identityNotes, verdict }`, and `lookupStil(text, path)` reads a STIL entry. They are exported from `sidwave/analyze`.

## Status

Verified within declared bounds. The tests build bundles of seeded tunes and of the player fixtures, verify them, change every kind of file and field (score, report, manifest hash, extra file, missing file, fingerprint, compiled hash, verdict) and check that the verification fails with the matching check. On four development tunes of the corpus manifest (20 s horizon) bundles were created and verified; the reconstruction of those tunes is not strictly exact at this commit, and the bundles say so. A1 was not evaluated in the tests because the pinned ROM images are not part of the repository.
