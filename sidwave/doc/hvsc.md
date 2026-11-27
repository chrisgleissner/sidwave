# HVSC tools

The commands `sidwave sid`, `sidwave songlengths` and `sidwave stil` read and edit the files that make up the High Voltage SID Collection (HVSC): PSID and RSID files, `Songlengths.md5` (and the old `Songlengths.txt`), and `STIL.txt`. They are written for curators and for anyone who maintains a SID collection. Everything runs offline. No command changes a file unless you name the output or pass `--in-place` or, for the Songlengths database, name the database to write.

## Quick start for curators

Point the tools at your HVSC directory once:

```bash
export HVSC_ROOT=~/C64Music          # the directory that contains DOCUMENTS, DEMOS, GAMES and MUSICIANS
```

Every command that takes `--hvsc <root>` uses `HVSC_ROOT` when the option is left out. A command that looks at a file below an HVSC directory also finds the root by itself (the closest directory above the file with `DOCUMENTS/Songlengths.md5` or `DOCUMENTS/STIL.txt`).

**Look at a tune**

```bash
sidwave sid info MUSICIANS/H/Hubbard_Rob/Commando.sid
```

prints the header, the MD5 key, the song lengths from `DOCUMENTS/Songlengths.md5` and the STIL entry.

**Fix a header field and keep the song lengths**

```bash
sidwave sid edit MUSICIANS/H/Hubbard_Rob/Commando.sid --released "1985 Elite Systems" --dry-run
sidwave sid edit MUSICIANS/H/Hubbard_Rob/Commando.sid --released "1985 Elite Systems" --in-place
```

The first command shows the field change, the old and new MD5 keys and, because the old key is listed in the database, the command that carries the song lengths over:

```bash
sidwave songlengths write ~/C64Music/DOCUMENTS/Songlengths.md5 MUSICIANS/H/Hubbard_Rob/Commando.sid --from-md5 <old key>
```

That command changes only the line of the entry (the old key is replaced by the new one); every other byte of the database, including the line breaks, comments and `; /path` lines, stays as it was.

**Check a collection after an update**

```bash
sidwave songlengths verify ~/C64Music/DOCUMENTS/Songlengths.md5 ~/C64Music --unlisted
```

reports entries whose file is missing, files whose MD5 differs from the entry, entries whose number of times differs from the number of songs of the file, and SID files that have no entry. The exit code is 1 when there is a problem (not for unlisted files). On the HVSC #83 files all 59,886 entries verify and no SID file is unlisted.

**Make a table of the collection**

```bash
sidwave sid info ~/C64Music/MUSICIANS/H --json > hubbard.jsonl
```

writes one JSON object per line for every SID file below the directory, with the header, the MD5, the song lengths, the HVSC path and the STIL entry. A file that cannot be read gives a line with an `error` and the run goes on; the exit code is 1 when any file failed. Over all of HVSC (59,886 files, with Songlengths and STIL) this takes about 6 s with a warm file cache and about 15 s with a cold one.

**Ask STIL**

```bash
sidwave stil query /MUSICIANS/H/Hubbard_Rob/Commando.sid
sidwave stil query MUSICIANS/H/Hubbard_Rob/Commando.sid --subtune 3 --json
```

**Find out which player a tune uses**

```bash
sidwave sid player MUSICIANS/H/Hubbard_Rob/Commando.sid --sidid ~/tools/sidid/sidid.cfg
```

## `sidwave sid info <file|directory>`

Prints the header in readable form: magic and version, songs and start song, name, author, released, load, init and play addresses, clock, SID models, the speed (VBI or CIA) of every song, the MD5 key, size, second and third SID address, flags, relocation range, and any warning from the parser. With a Songlengths database it adds the length of every subtune in seconds, and with `STIL.txt` the STIL entry.

| Option | Meaning |
| --- | --- |
| `--hvsc <root>` | HVSC root; the databases are `<root>/DOCUMENTS/Songlengths.md5` (else `Songlengths.txt`) and `<root>/DOCUMENTS/STIL.txt`. Default: `HVSC_ROOT`, else a root above the file. |
| `--songlengths <file>`, `--stil <file>` | Use these files instead of the ones under the root. |
| `--hvsc-path <path>` | The HVSC path of the file, for a file that is not below the root. |
| `--max-bytes <n>` | Refuse SID files larger than `<n>` bytes (default 65,662). |
| `--json` | One envelope for a file; for a directory one JSON object per line. |

For a directory the text output has one line per file and a summary on standard error. The old command `sidwave sid-info <file> [--songlengths <file>]` is an alias; its text and JSON output keep their earlier lines and fields (the JSON `command` is `sid-info`).

## `sidwave sid edit <file.sid>`

Changes header fields and writes a new file. Fields that are not named keep their bytes; this includes bytes that a parser would normalise: text after the zero terminator of a string, reserved flag bits, and header bytes that the version ignores. The edit patches the file instead of writing it again from parsed values. Parse and write without changes gives byte-identical files for all 59,886 files of HVSC #83 (`test/hvscSidEdit.test.mjs`, local test).

| Option | Field |
| --- | --- |
| `--title`, `--author`, `--released` | name, author, released (up to 32 characters in Windows-1252) |
| `--songs`, `--start-song` | number of songs (1-256), start song |
| `--speed <0x..\|0b..\|n\|vbi\|cia>`, `--speed-song <n>=vbi\|cia` | the 32 speed bits, or the speed of one song (repeatable) |
| `--clock pal\|ntsc\|both\|unknown` | video standard flag |
| `--model`, `--model2`, `--model3` `6581\|8580\|both\|unknown` | SID model of the first, second and third SID |
| `--sid2`, `--sid3 <address\|none>` | address of the second and third SID (`$D420`-`$D7E0` or `$DE00`-`$DFE0`, steps of `$20`) |
| `--mus-player`, `--playsid`, `--basic` `on\|off` | flag bits: MUS player, PlaySID specific (PSID), BASIC (RSID) |
| `--version <1-4>`, `--magic psid\|rsid` | header version, PSID or RSID |
| `--load`, `--init`, `--play <address>` | header addresses |
| `--reloc-start <page>`, `--reloc-pages <n>`, `--reloc none` | relocation range |

Output: `-o <file>` (default `<name>.edited.sid` in the current directory), `-o -` for standard output, or `--in-place`. An existing output needs `--force`. `--dry-run` prints the changes and writes nothing. `--strict` turns a result that deviates from the PSID specification into an error. `--json` prints the changes, warnings, version change, byte ranges that differ and the MD5 values.

Validation follows `DOCUMENTS/SID_file_format.txt`:

- The result must parse: version 1-4 with the header size that belongs to it, 1-256 songs, a start song in range, the data inside 64 KB, and for an RSID the constraints (version 2 or later, play address 0, speed 0, load address of at least `$07E8`, an init address of `$07E8`-`$9FFF` or `$C000`-`$CFFF` inside the data unless the BASIC flag is set, and init 0 with the BASIC flag). An invalid result is an error that names the field and says what to change in the same edit.
- A field of a later version raises the version, with a warning: the flags, clock, first SID model, relocation range and RSID need version 2; the second SID address and its model need 3; the third need 4. `--version` with a lower number than a field needs is an error. Lowering the version is only possible when no field of the later versions is in use.
- The relocation range needs a page count of 0 for a start page of 0 or `$FF`, and must end before page `$100`; a range that overlaps the load image is a warning (an error with `--strict`).
- The second and third SID address must differ. A SID address outside `$D420`-`$D7E0` and `$DE00`-`$DFE0`, or one that is not a multiple of `$20`, is rejected.
- Songs above 32 share bit 31 of the speed field in PSID v2NG and later unless the PlaySID flag is set (then the bits wrap). `--speed-song` follows the rule of the header it writes and warns when a song above 32 shares a bit.
- `--load` changes where the data is loaded and does not relocate the code in it; the command says so.

The command prints the Songlengths key before and after. `Songlengths.md5` keys are the MD5 of the whole file, so every change of the file changes its key. The key of the old `Songlengths.txt` format is calculated from the data, the init and play addresses, the song count, the speed of each song and the NTSC flag, so editing a text field leaves it unchanged. With `--songlengths <file>` or `--hvsc <root>` the command also says whether the old key is listed and prints the `songlengths write --from-md5` command that moves the entry to the new key.

## `sidwave songlengths`

```
sidwave songlengths lookup <file.sid> | --md5 <hash> [--db <file>|--hvsc <root>] [--song <n>] [--json]
sidwave songlengths verify [<Songlengths.md5>] [<hvsc-root>] [--unlisted] [--limit <n>] [--json]
sidwave songlengths write  <database> <file.sid> --times <list> [--path <hvsc path>] [--dry-run] [-o <out>]
sidwave songlengths write  <database> <file.sid> --from-md5 <old key> [--times <list>]
```

The format of a database follows its extension (`.txt` is the old format) or `--format md5|txt`. The two formats differ in the key (MD5 of the whole file, or the older calculation), in the time precision (milliseconds, or whole seconds) and in the optional attributes `(G)`, `(M)`, `(Z)`, `(B)` after a time of the old format.

- `lookup` prints the song lengths and the path comments of every entry with the key; exit 1 when the key is not listed.
- `verify` reads every file named by a `; /path` line. An entry without a path line directly above it cannot be checked and is listed. Over the HVSC #83 files this takes about 3 s.
- `write` takes one time per subtune, separated by commas: `m:ss`, `m:ss.SSS`, `h:mm:ss` or a number of seconds. An entry that is already listed gets its times in place. `--from-md5` finds the entry that the file had before an edit and gives it the new key; the times stay unless `--times` is given. Otherwise the entry is added in HVSC path order with a `; /path` line (new entries are inserted in HVSC order, which compares paths upper-cased, so `_` sorts after letters), which needs `--path` or a file below the HVSC root. The new text keeps the line break style of the file (CRLF in HVSC). In the old format the times are rounded to whole seconds and the attributes of a subtune stay. The database is replaced in place through a temporary file and a rename; `-o` writes another file and `--dry-run` writes nothing.

## `sidwave stil`

```
sidwave stil parse [<STIL.txt>] [--hvsc <root>] [--json]
sidwave stil query <path-in-hvsc | file.sid> [--stil <file> | --hvsc <root>] [--subtune <n>] [--json]
```

`STIL.txt` is Latin-1 text. An entry is a line with an HVSC path followed by the fields NAME, AUTHOR, TITLE, ARTIST and COMMENT (a field may continue on indented lines); `(#n)` lines start the block of a subtune, and fields before the first marker apply to the whole file. A TITLE field is also split into its album (`[from Album]`) and timestamp (`(0:00-1:15)`) parts. `query` prints the whole-file fields and then the fields of each subtune, or of the one given by `--subtune`; exit 1 when the tune has no entry. Paths match exactly first, then without regard to case. `parse` prints the version, the number of entries, blocks and fields and the lines it did not understand; the full parse is in the JSON output. On the HVSC #83 `STIL.txt` (18,497 entries) the parser reports no unknown line.

## `sidwave sid player <file|directory> --sidid <sidid.cfg>`

Identifies the player or editor of a tune with the signatures of SIDId (by Cadaver). **sidwave contains no signature file.** Pass the `sidid.cfg` of SIDId with `--sidid`, or set `SIDID_CFG` (`SIDIDCFG`, the variable of SIDId itself, also works). SIDId and its `sidid.cfg` are distributed under the BSD 3-clause licence (see `SIDId-readme.txt` in the SIDId package); anyone redistributing the file must keep its copyright notice and licence. sidwave reads it at run time from the path you give and does not bundle it. A `sidid.nfo` beside it (or `--sidid-info`) adds the full name and author of the player.

A signature is a list of hexadecimal bytes with `??` for any byte; `AND` (or `&&` in the newer file format) separates fragments that must all be found, in order, each after the end of the one before; `END` ends the signature (optional in the newer format). The match runs over the C64 data of the tune, so the header cannot match. Without `--all` the answer is the first player in file order, as in SIDId; with `--all` every player that matches is listed, which finds a sample routine next to the main player.

The confidence is a measure of the matching signature. It is `high` for 14 or more fixed bytes (bytes that are not `??`), `medium` for 8 to 13 and `low` below that, one step higher when a second signature of the same player matches too. It says how specific the signature is, not how often it is right. For a check of the matcher, the first match of all 2,159 SID files below `MUSICIANS/H` equals the output of the SIDId program built from its source, with the same `sidid.cfg`.

## Library

`sidwave/hvsc` (also exported from the package root) has the functions behind the commands:

```ts
import { editSidHeader, parseStil, queryStil, scanSonglengths, writeSonglengthsEntry, identifySidPlayer, loadSidIdSignatures } from "sidwave/hvsc";

const edited = editSidHeader(bytes, { author: "Rob Hubbard", clock: "PAL" });
edited.bytes;          // the new file
edited.changes;        // [{ field, from, to, offset, length }]
edited.md5;            // { old, new }  Songlengths.md5 keys
edited.legacyMd5;      // { old, new }  Songlengths.txt keys

const db = parseStil(latin1Text);
queryStil(db, "/MUSICIANS/H/Hubbard_Rob/Commando.sid", 3);

const { text, action } = writeSonglengthsEntry(databaseText, { md5: edited.md5.new, fromMd5: edited.md5.old }, "md5");
```

`parseSonglengths`, `parseSonglengthsWithPaths`, `lookupSonglength` and `legacyMd5ForSonglengths` are in `sidwave/songlengths`. Read database files as Latin-1 (`readFileSync(file, "latin1")`) and write the result back as Latin-1 so that every byte round-trips.

## Limits and errors

Input from files is not trusted: a SID file larger than 65,662 bytes (`--max-bytes` changes it) and a database larger than 32 MB are refused before they are read; a directory walk stops at 32 levels and does not follow symbolic links; a SIDId signature longer than 4,096 bytes is an error. Errors have a category and an exit code: 2 for a wrong option or value, 3 for a file that is not valid, 5 for a limit, and 1 for a negative result (a key that is not listed, `verify` with problems, a directory run with failed files). With `--json` every command prints `{ "ok", "command", "result" }` or `{ "ok": false, "command", "error": { "category", "message", "details" } }`; a directory run prints one object per line instead.

The code is tested with 1,000 random cases each for the header editor, the Songlengths parser and writer, the STIL parser and the SIDId parser and matcher (`test/hvsc*.test.mjs`). The tests that need HVSC (round trip of all files, timings of the real databases, a run over the whole collection) read the directory named by `HVSC_ROOT` or `HVSC_DIR` and are skipped when it is not there. They read the collection and write nothing to it.

## Known limits

- The key of the old `Songlengths.txt` format follows the HVSC description and libsidplayfp's `PSID::createMD5`. It has not been compared with a Songlengths.txt generated by the HVSC script, because HVSC no longer ships that file and none was available.
- `sid edit` edits one file. A change to many files (for example a rename of an author) is a loop over `sid edit` and then `songlengths write --from-md5`.
- STIL is read, not written.
