# Changelog

Changes to the two npm packages are listed in their own changelogs:

- [`sidwave/CHANGELOG.md`](sidwave/CHANGELOG.md)
- [`6502-toolkit/CHANGELOG.md`](6502-toolkit/CHANGELOG.md)

This file lists repository-level changes (CI, licences, documentation of the repository).

## Unreleased

### Added

- Standalone repository for SIDWave, extracted from c64bridge with the history of the moved files.
- CI runs the tests on the oldest supported Node.js version and on Node.js 24, and on Bun 1.3.1. CI also type-checks a consumer project that imports every exported subpath of the packed packages, and runs `npx sidwave --help` after `npm ci` and `npm run build`.
- `scripts/check-types-consumer.mjs` (`npm run check:types`) and `scripts/check-fresh-clone.mjs` (`npm run check:fresh-clone`).
- Documentation drafts: repository README, package READMEs, licensing notes.
- `.github/workflows/release.yaml`, started only by a tag `6502-toolkit@<version>` or `sidwave@<version>`. See "Releases" in the README.

### Changed

- `actions/checkout` and `actions/setup-node` are v5, and `codecov/codecov-action` is v7, so the workflows no longer use the deprecated Node 20 runtime.
- The root licence overview is `LICENSES.md` (was `LICENSE.md`), so that GitHub detects the GPL-2.0 text in `COPYING` as the repository licence. No licence terms changed.
- Licences: `6502-toolkit` is MIT. `sidwave` is GPL-2.0-or-later with the SIDWave Player Exception. The former root `LICENSE` is replaced by `LICENSES.md`; the GPL text is in `COPYING`.

### Documentation

- Repository README restructured: tagline, "Choose your path" table, install and first-tune commands, repository layout.
