# Authoring commands

Five commands change, compare and create scores. Every command has `--help` with examples, accepts `--json`
(`{ "ok", "command", "result" }` or `{ "ok": false, "command", "error" }`) and uses the exit codes of the command line:
0 done, 1 a verdict (not formatted, scores differ, merge conflict), 2 usage, 3 unreadable file or invalid score.
Each command produces the same result as the library function it calls (`formatSidwave`, `diffSidwave`,
`mergeSidwave`, `transpose` and the other `transform` operations, `generateSidwave`); the tests compare the output
with a direct call.

## format

```sh
sidwave format song.yaml                 # canonical text on standard output
sidwave format songs/*.yaml --check      # exit 1 and list the files that are not formatted
sidwave format songs/*.yaml --write      # rewrite them in place
```

Formatting is idempotent and keeps comments, anchors and aliases. A pre-commit hook that rejects unformatted scores:

```sh
#!/bin/sh
# .git/hooks/pre-commit
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.yaml')
[ -z "$files" ] || sidwave format $files --check
```

## transform

```sh
sidwave transform song.yaml --transpose 2 -o song-d.yaml
sidwave transform song.yaml --transpose -5 --voice 3 --tempo 140 -o out.yaml
sidwave transform song.yaml --swap-instrument bass=lib:bass_pluck --quantise 0.25
sidwave transform song.yaml --order intro,verse,chorus,verse,chorus -o long.yaml
```

Operations are `--transpose`, `--tempo`, `--tempo-factor`, `--swap-instrument`, `--quantise`, `--humanise` (with
`--seed`) and `--order`; several can be given and run in the order written. Without `-o` the score goes to standard
output and the report to standard error, so nothing is overwritten; an existing `-o` file, and the input file, need
`--force`. The result is parsed and compiled before it is written; `--validate parse` skips the compile and is
several times faster on a large score.

## diff

```sh
sidwave diff song-v1.yaml song-v2.yaml
sidwave diff a.yaml b.yaml --json
sidwave diff a.yaml b.yaml --no-compile   # skip the compile of both scores: about ten times faster on a large score
```

The comparison is on parsed values. Each change has a class (`musical`, `synthesis`, `hardware`, `structural`,
`formatting`), a JSON pointer path and the values before and after, and the last line tells whether both scores compile
to the same PRG. Exit 0 when equal, 1 when different (like `diff(1)`); `--ignore-formatting` counts a difference of
formatting alone as equal.

### As a git diff driver

```gitattributes
# .gitattributes
*.sidwave.yaml diff=sidwave
```

```sh
git config diff.sidwave.command "sidwave diff --git"
```

`git diff`, `git log -p` and `git show` then print the semantic changes of each score. `sidwave diff --git` takes the seven
arguments git passes to an external diff driver and always exits 0, as git requires. To keep git's own line diff and
only normalise the text first, use `git config diff.sidwave.textconv "sidwave format"` instead (set one of the two).

## merge

```sh
sidwave merge base.yaml mine.yaml theirs.yaml -o merged.yaml
```

A value that only one side changed takes that side's change; lists of equal length merge entry by entry; the result
keeps the comments and aliases of `mine.yaml` where the merge did not touch them and must be a valid score. When both
sides changed the same value differently, or the result is not valid, the command exits 1, writes nothing and lists each
conflict with the path and the base, ours and theirs values.

### As a git merge driver

```gitattributes
# .gitattributes
*.sidwave.yaml merge=sidwave
```

```sh
git config merge.sidwave.name "SIDWave semantic merge"
git config merge.sidwave.driver "sidwave merge %O %A %B -o %A --force"
```

Git passes the common ancestor (`%O`), the current version (`%A`) and the other version (`%B`) and reads the result
from `%A`. On a conflict the driver exits 1 and leaves `%A` unchanged, so git reports the conflict and the working copy keeps
your version. To see the conflicting paths, merge the three stages by hand:

```sh
git show :1:song.sidwave.yaml > base.yaml; git show :2:song.sidwave.yaml > ours.yaml; git show :3:song.sidwave.yaml > theirs.yaml
sidwave merge base.yaml ours.yaml theirs.yaml
```

`sidwave` must be on the `PATH` of the shell that git starts; otherwise give the full path, for example
`node /path/to/sidwave/dist/bin.js merge %O %A %B -o %A --force`. `test/cliAuthoring.test.mjs` runs this configuration
in a temporary repository.

## generate

```sh
sidwave generate --list
sidwave generate --style funk --seed 7 -o funk7.yaml
sidwave generate --profile soft-arch-lydian --seed 3 --prg tune.prg --sid tune.sid
sidwave generate --composer 1 --minutes 2 -o long.yaml
```

The same options and seed give the same score. The default is composer 2 (see `data/compose/`), whose length follows the
profile (8 to 36 bars). `--bars` and `--minutes` apply to composer 1 and select it when `--composer` is not given;
to extend a composed score use `sidwave complete --op continue --bars <n>`. `--prg` and `--sid` write the same bytes
as `sidwave compile` of the written score. Without `-o` the score is printed, unless `--prg` or `--sid` is given.
