# Authoring commands

Five commands change, compare and create scores. Every command has `--help` with examples, accepts `--json`
(`{ "ok", "command", "result" }` or `{ "ok": false, "command", "error" }`) and uses the exit codes of the command line:
0 done, 1 a verdict (not formatted, scores differ, merge conflict), 2 usage, 3 unreadable file or invalid score.
Each command produces the same result as the library function it calls (`formatSidwave`, `diffSidwave`,
`mergeSidwave`, `transpose` and the other `transform` operations, `generateSidwave`); the tests compare the output
with a direct call.

## format

```sh
sidwave format song.yaml                 # canonical text on standard output (the file must be a valid score)
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
`--force`. The result is checked before it is written: by default it is parsed and every check of the compiler runs
without assembling the note data (`--validate arrange`), which finds a valid score that cannot be compiled;
`--validate compile` also assembles the note data, and `--validate parse` only parses it (fastest).

## diff

```sh
sidwave diff song-v1.yaml song-v2.yaml
sidwave diff a.yaml b.yaml --json
sidwave diff a.yaml b.yaml --compile      # also compare the compiled PRG (several times slower)
```

The comparison is on parsed values. Each change has a class (`musical`, `synthesis`, `hardware`, `structural`,
`formatting`), a JSON pointer path and the values before and after (a long value is shown around the changed tokens),
and with `--compile` the last line tells whether both scores compile to the same PRG. Input that is not a valid score
is an error (exit 3). The compile is off by default. Exit 0 when equal, 1 when different (like `diff(1)`); `--ignore-formatting` counts a difference of
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

A value that only one side changed takes that side's change; lists of equal length merge entry by entry. The edits are
applied in place to `mine.yaml`, so its comments, anchors and aliases stay except those inside a value the merge
replaced; comments that exist only in the base or theirs are not carried over. The result must be a valid score. When both
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

## Using a score in an assembler project

`compile --target game --format asm` writes one include file that holds the player and its data at the addresses you
choose, together with the symbols (`sidwave_init`, `sidwave_play`, `sidwave_stop`, `sidwave_sfx` and the others of the
symbol files). The comment header of the include lists the memory it uses, the zero page bytes, the registers each
entry point takes and clobbers, and the cycles of one play call. Include it once; no binary or symbol file is needed
beside it.

```sh
sidwave compile tune.yaml --target game --origin '$2000' --format asm -o tune.inc
```

`--asm` selects the syntax: `64tass` (default), `acme`, `kickass` or `ca65`. Without `-o` the include is
`<input name>.inc`. `--data-origin` places the streams and tables in a second block.

Each program below starts the tune, then calls `sidwave_play` once per video frame at raster line `$FA`. A score with
several play calls per frame needs that many calls, spread over the frame; the include header states the number. With
64tass, ACME and KickAssembler the include sets the program counter, so put it behind your own code or set the program
counter again after it. The examples use `$2000` as the origin; keep your code and data outside the ranges the header
lists, including the variables, which the include does not fill with bytes.

### 64tass

`main.asm`, assembled with `64tass -o game.prg main.asm`:

<!-- example: 64tass main.asm -->
```asm
        * = $0801
        .byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061
start:  sei
        lda #0                  ; A = song 0
        ldx #$ff                ; X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
frame:  lda #$fa
wait:   cmp $d012
        bne wait
leave:  cmp $d012
        beq leave
        jsr sidwave_play
        jmp frame

        .include "tune.inc"
```

### ACME

```sh
sidwave compile tune.yaml --target game --origin '$2000' --format asm --asm acme -o tune.inc
```

`main.a`, assembled with `acme -f cbm -o game.prg main.a`:

<!-- example: acme main.a -->
```asm
        * = $0801
        !byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061
start   sei
        lda #0                  ; A = song 0
        ldx #$ff                ; X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
frame   lda #$fa
wait    cmp $d012
        bne wait
leave   cmp $d012
        beq leave
        jsr sidwave_play
        jmp frame

        !source "tune.inc"
```

### KickAssembler

```sh
sidwave compile tune.yaml --target game --origin '$2000' --format asm --asm kickass -o tune.inc
```

`main.asm`, assembled with `java -jar KickAss.jar main.asm -o game.prg`:

<!-- example: kickass main.asm -->
```asm
* = $0801
        .byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   // 10 SYS2061
start:  sei
        lda #0                  // A = song 0
        ldx #$ff                // X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
frame:  lda #$fa
wait:   cmp $d012
        bne wait
leave:  cmp $d012
        beq leave
        jsr sidwave_play
        jmp frame

#import "tune.inc"
```

### ca65 and ld65

```sh
sidwave compile tune.yaml --target game --origin '$2000' --format asm --asm ca65 -o tune.inc
```

With ca65 the linker places the bytes. The include puts them into the segment `SIDWAVE_PLAYER` (and `SIDWAVE_DATA`
with `--data-origin`) and returns to the segment that was active. Its header contains the `MEMORY` and `SEGMENTS`
lines for the linker configuration; copy them from your include, because the sizes depend on the score.

`main.s`:

<!-- example: ca65 main.s -->
```asm
.segment "LOADADDR"
        .word $0801

.segment "CODE"
        .byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061
start:  sei
        lda #0                  ; A = song 0
        ldx #$ff                ; X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
frame:  lda #$fa
wait:   cmp $d012
        bne wait
leave:  cmp $d012
        beq leave
        jsr sidwave_play
        jmp frame

.include "tune.inc"
```

`game.cfg`. `MAIN` is filled up to `$2000`, so that the player follows at its address in the PRG file. The two lines
that mention `SIDWAVE_PLAYER` are the ones from the include header; the size shown here is that of a one-voice example
tune.

<!-- example: ca65 game.cfg -->
```
MEMORY {
  HEADER: start = $0000, size = 2, file = %O;
  MAIN: start = $0801, size = $17FF, file = %O, fill = yes;
  SIDWAVE_PLAYER_RAM: start = $2000, size = $0E3F, file = %O;
}
SEGMENTS {
  LOADADDR: load = HEADER, type = ro;
  CODE: load = MAIN, type = ro;
  SIDWAVE_PLAYER: load = SIDWAVE_PLAYER_RAM, type = rw;
}
```

```sh
ca65 main.s -o main.o
ld65 -C game.cfg -o game.prg main.o
```

### Symbol files, cycle limit and relocation

- `--symbols 64tass,acme,kickass,ca65,vice,json` writes symbol files next to the output, for builds that load the
  binaries instead of including the bytes.
- 64tass ignores the case of symbols unless it runs with `-C`. A score with two effects whose names differ only in
  case (`zap`, `Zap`) is therefore rejected for the 64tass include and symbol file.
- `--max-cycles <n>` writes nothing and exits 5 when the worst measured cycles of a play call (calls with sound
  effects included) exceed `n`. With `--no-measure` the estimated upper bound is compared instead. Library: the option
  `maxCycles` of `compileSidwave` throws `SidwaveGameCycleLimitError`.
- `--reloc` also writes `<out>.reloc.json` (with `--format bin` or `asm`). Library: `sidwaveRelocationTable`.

```json
{ "origin": 8192, "dataOrigin": null, "granularity": 256, "player": [2, 5, 8], "data": [] }
```

`player` and `data` are byte offsets into the player image and the data block. To move a build by `p` pages, load it
`p * 256` bytes higher (or lower, `p` negative) and add `p`, modulo 256, to every listed byte; the address symbols of the
build (entry points, variables, data) move with their block. With `--data-origin`, `player` and `data` apply when both blocks move by the same number
of pages. The table then also has `independent`, for moving them by different amounts, `p` pages for the player and `d`
pages for the data block:

- add `p` to the bytes listed in `independent.playerPages.player` and `independent.playerPages.data`;
- add `d` to the bytes listed in `independent.dataPages.player` and `independent.dataPages.data`.

The zero page and SID addresses do not move. The relocated build must satisfy the usual layout rules (`$0200` to
below `$D000`, no overlap of the player, its variables and the data). The table is written only if applying it to the
build reproduces, byte for byte, another build with different page differences.

## generate

```sh
sidwave generate --list
sidwave generate --style funk --seed 7 -o funk7.yaml
sidwave generate --profile soft-arch-lydian --seed 3 --prg tune.prg --sid tune.sid
sidwave generate --composer 1 --minutes 2 -o long.yaml
```

The same options and seed give the same score. The default is composer 2 (see `data/compose/`), whose length follows the
profile (8 to 36 bars). `--bars` and `--minutes` need `--composer 1`;
to extend a composed score use `sidwave complete --op continue --bars <n>`. `--prg` and `--sid` write the same bytes
as `sidwave compile` of the written score. Without `-o` the score is printed, unless `--prg` or `--sid` is given.
