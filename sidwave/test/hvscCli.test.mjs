import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_INPUT, EXIT_LIMIT } from "../src/cli.ts";
import { md5ForSonglengths, parseSidFile, writeSidFile } from "../src/sidFile.ts";
import { legacyMd5ForSonglengths } from "../src/songlengths.ts";

async function run(cwd, args, env = {}) {
  const out = [], err = [], bytes = [];
  const saved = {};
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try {
    const code = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)) });
    return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const PAYLOAD = Uint8Array.from([0xa9, 0x00, 0x8d, 0x18, 0xd4, 0x4c, 0x03, 0x10, 0x60, 0x60]);
const sid = (over = {}) => writeSidFile({
  magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 2, startSong: 1, speed: 0b10,
  name: "Tune", author: "Somebody", released: "2026 Home", payload: PAYLOAD, ...over,
});

/** A small HVSC tree: DOCUMENTS with both databases and two tunes. */
function hvscTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-hvsc-cli-")));
  const put = (rel, content) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const one = sid({ name: "One" });
  const two = sid({ name: "Two", songs: 3 });
  put("MUSICIANS/X/Xyz/One.sid", one);
  put("MUSICIANS/X/Xyz/Two.sid", two);
  put("MUSICIANS/X/Xyz/note.txt", "ignored");
  put("DOCUMENTS/Songlengths.md5", `[Database]\r\n; /MUSICIANS/X/Xyz/One.sid\r\n${md5ForSonglengths(one)}=1:30 2:00.5\r\n; /MUSICIANS/X/Xyz/Two.sid\r\n${md5ForSonglengths(two)}=0:10 0:20 0:30\r\n`);
  put("DOCUMENTS/STIL.txt", "#  STIL v1\r\n\r\n/MUSICIANS/X/Xyz/One.sid\r\nCOMMENT: Global comment.\r\n(#2)\r\n  TITLE: Second tune [from Album]\r\n ARTIST: Someone\r\n");
  return { root, one, two, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("every command has --help with examples", async () => {
  const cwd = os.tmpdir();
  for (const [args, pattern] of [
    [["sid", "--help"], /sidwave sid info/], [["sid", "info", "--help"], /Examples:/], [["sid", "edit", "--help"], /Examples:/], [["sid", "player", "--help"], /Examples:/],
    [["songlengths", "--help"], /Examples:/], [["songlengths", "write", "--help"], /--from-md5/], [["stil", "--help"], /Examples:/], [["sid-info", "--help"], /Examples:/],
  ]) {
    const result = await run(cwd, args);
    assert.equal(result.code, EXIT_OK, args.join(" "));
    assert.match(result.out, pattern, args.join(" "));
  }
  assert.match((await run(cwd, ["--help"])).out, /sidwave songlengths lookup\|verify\|write/);
  assert.equal((await run(cwd, ["sid", "nope"])).code, EXIT_USAGE);
  assert.equal((await run(cwd, ["songlengths", "nope"])).code, EXIT_USAGE);
  assert.equal((await run(cwd, ["stil", "nope"])).code, EXIT_USAGE);
});

test("sid info reads the header, the Songlengths entry and the STIL entry of a tune below an HVSC root", async () => {
  const { root, one, done } = hvscTree();
  try {
    const file = path.join(root, "MUSICIANS/X/Xyz/One.sid");
    const text = await run(root, ["sid", "info", file], { HVSC_ROOT: undefined });
    assert.equal(text.code, EXIT_OK);
    assert.match(text.out, /: PSID v2, 2 songs, start song 1\nname: One\nauthor: Somebody\nreleased: 2026 Home\n/);
    assert.match(text.out, /HVSC path \/MUSICIANS\/X\/Xyz\/One\.sid/);
    assert.match(text.out, /song lengths: 90s, 120.5s/);
    assert.match(text.out, /STIL:\n  COMMENT: Global comment\.\n  \(#2\)\n {6}TITLE: Second tune \[from Album\]/);
    assert.match(text.out, new RegExp(`md5 ${md5ForSonglengths(one)}`));
    const json = JSON.parse((await run(root, ["sid", "info", file, "--json"])).out);
    assert.equal(json.command, "sid info");
    assert.deepEqual(json.result.songlengths, [90, 120.5]);
    assert.equal(json.result.hvscPath, "/MUSICIANS/X/Xyz/One.sid");
    assert.equal(json.result.stil.found, true);
    assert.equal(json.result.stil.subtunes[0].fields[0].album, "Album");
    // --hvsc and HVSC_ROOT name the root for a file elsewhere (copy in the cwd) with --hvsc-path.
    const copy = path.join(os.tmpdir(), `copy-${process.pid}.sid`);
    fs.writeFileSync(copy, one);
    try {
      const viaFlag = JSON.parse((await run(os.tmpdir(), ["sid", "info", copy, "--hvsc", root, "--hvsc-path", "/MUSICIANS/X/Xyz/One.sid", "--json"])).out);
      assert.deepEqual(viaFlag.result.songlengths, [90, 120.5]);
      const viaEnv = JSON.parse((await run(os.tmpdir(), ["sid", "info", copy, "--json"], { HVSC_ROOT: root })).out);
      assert.deepEqual(viaEnv.result.songlengths, [90, 120.5]);
      assert.equal(viaEnv.result.stil, undefined);
      assert.equal((await run(os.tmpdir(), ["sid", "info", copy, "--hvsc", path.join(root, "nope")])).code, EXIT_INPUT);
      const plain = JSON.parse((await run(os.tmpdir(), ["sid", "info", copy, "--json"], { HVSC_ROOT: undefined })).out);
      assert.equal(plain.result.songlengths, undefined);
    } finally { fs.rmSync(copy, { force: true }); }
  } finally { done(); }
});

test("sid info on a directory writes one JSON object per line, reports failures and exits 1 when a file failed", async () => {
  const { root, done } = hvscTree();
  try {
    const dir = path.join(root, "MUSICIANS");
    fs.writeFileSync(path.join(dir, "X/Xyz/Bad.sid"), "not a sid file");
    const result = await run(root, ["sid", "info", "MUSICIANS", "--json"], { HVSC_ROOT: root });
    assert.equal(result.code, EXIT_FAILED);
    const lines = result.out.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((l) => l.file), ["X/Xyz/Bad.sid", "X/Xyz/One.sid", "X/Xyz/Two.sid"]);
    assert.equal(lines[0].error.category, "input");
    assert.equal(lines[1].name, "One");
    assert.deepEqual(lines[2].songlengths, [10, 20, 30]);
    assert.match(result.err, /sid info: 3 files, 1 failed/);
    const text = await run(root, ["sid", "info", "MUSICIANS"], { HVSC_ROOT: undefined });
    assert.match(text.out, /X\/Xyz\/One\.sid: PSID v2, 2 songs, "One" by Somebody, 2026 Home, 1:30 2:00.5/);
    assert.match(text.out, /X\/Xyz\/Bad\.sid: error:/);
    fs.rmSync(path.join(dir, "X/Xyz/Bad.sid"));
    assert.equal((await run(root, ["sid", "info", "MUSICIANS"], { HVSC_ROOT: undefined })).code, EXIT_OK);
    fs.mkdirSync(path.join(root, "empty"));
    const empty = await run(root, ["sid", "info", "empty"], { HVSC_ROOT: undefined });
    assert.equal(empty.code, EXIT_OK);
    assert.match(empty.err, /no \.sid files/);
  } finally { done(); }
});

test("sid-info is the old name of sid info and keeps its output and its errors", async () => {
  const { root, one, done } = hvscTree();
  try {
    const old = await run(root, ["sid-info", "MUSICIANS/X/Xyz/One.sid"], { HVSC_ROOT: undefined });
    assert.equal(old.code, EXIT_OK);
    assert.match(old.out, /^MUSICIANS\/X\/Xyz\/One\.sid: PSID v2, 2 songs, start song 1\nname: One\n/);
    const json = JSON.parse((await run(root, ["sid-info", "MUSICIANS/X/Xyz/One.sid", "--json", "--songlengths", "DOCUMENTS/Songlengths.md5"])).out);
    assert.equal(json.command, "sid-info");
    assert.deepEqual(json.result.songlengths, [90, 120.5]);
    assert.equal(json.result.md5, md5ForSonglengths(one));
    assert.equal((await run(root, ["sid-info", "MUSICIANS/X/Xyz/One.sid", "--seconds", "3"])).code, EXIT_USAGE);
    assert.equal((await run(root, ["sid-info", "MUSICIANS/X/Xyz/One.sid", "--max-bytes", "10"])).code, EXIT_LIMIT);
    assert.equal((await run(root, ["sid-info", "missing.sid"])).code, EXIT_INPUT);
    assert.equal((await run(root, ["sid-info", "a.sid", "b.sid"])).code, EXIT_USAGE);
    fs.writeFileSync(path.join(root, "junk.sid"), "not a sid file at all");
    const junk = await run(root, ["sid-info", "junk.sid", "--json"]);
    assert.equal(junk.code, EXIT_INPUT);
    assert.equal(JSON.parse(junk.out).error.category, "input");
    assert.equal(JSON.parse(junk.out).command, "sid-info");
  } finally { done(); }
});

test("sid edit writes a new file with only the named bytes changed and prints the old and new MD5", async () => {
  const { root, one, done } = hvscTree();
  try {
    const input = path.join(root, "MUSICIANS/X/Xyz/One.sid");
    const dry = await run(root, ["sid", "edit", input, "--author", "New Author", "--released", "2027 Y", "--dry-run"], { HVSC_ROOT: undefined });
    assert.equal(dry.code, EXIT_OK);
    assert.match(dry.out, /\(dry run, nothing written\)/);
    assert.match(dry.out, /author: "Somebody" -> "New Author"  \(bytes \$36-\$55\)/);
    assert.match(dry.out, new RegExp(`old ${md5ForSonglengths(one)}`));
    assert.match(dry.out, /md5 \(Songlengths.txt\)  unchanged/);
    assert.equal(fs.existsSync(path.join(root, "One.edited.sid")), false);
    const done1 = await run(root, ["sid", "edit", input, "--author", "New Author", "--json"], { HVSC_ROOT: undefined });
    assert.equal(done1.code, EXIT_OK);
    const record = JSON.parse(done1.out).result;
    const out = new Uint8Array(fs.readFileSync(path.join(root, "One.edited.sid")));
    assert.equal(record.written, true);
    assert.equal(parseSidFile(out).author, "New Author");
    assert.equal(record.md5.new, md5ForSonglengths(out));
    assert.equal(record.md5.old, md5ForSonglengths(one));
    for (let i = 0; i < one.length; i++) if (i < 0x36 || i >= 0x56) assert.equal(out[i], one[i], `byte ${i}`);
    assert.deepEqual(record.changes.map((c) => c.field), ["author"]);
    // The input is untouched, an existing output is not overwritten, and --force allows it.
    assert.deepEqual(new Uint8Array(fs.readFileSync(input)), new Uint8Array(one));
    assert.equal((await run(root, ["sid", "edit", input, "--author", "Again"], { HVSC_ROOT: undefined })).code, EXIT_USAGE);
    assert.equal((await run(root, ["sid", "edit", input, "--author", "Again", "--force"], { HVSC_ROOT: undefined })).code, EXIT_OK);
    assert.equal(parseSidFile(new Uint8Array(fs.readFileSync(path.join(root, "One.edited.sid")))).author, "Again");
  } finally { done(); }
});

test("sid edit: -o, standard output, --in-place and no-change cases", async () => {
  const { root, one, done } = hvscTree();
  try {
    const copy = path.join(root, "copy.sid");
    fs.writeFileSync(copy, one);
    const toStdout = await run(root, ["sid", "edit", "copy.sid", "--songs", "3", "-o", "-"]);
    assert.equal(toStdout.code, EXIT_OK);
    assert.equal(parseSidFile(new Uint8Array(toStdout.bytes)).songs, 3);
    assert.match(toStdout.err, /songs: 2 -> 3/);
    assert.equal(toStdout.out, "");
    assert.equal((await run(root, ["sid", "edit", "copy.sid", "--songs", "3", "-o", "copy.sid"])).code, EXIT_USAGE);
    assert.equal((await run(root, ["sid", "edit", "copy.sid", "--songs", "3", "--in-place", "-o", "x.sid"])).code, EXIT_USAGE);
    const inPlace = await run(root, ["sid", "edit", "copy.sid", "--songs", "3", "--clock", "ntsc", "--model", "8580", "--in-place"]);
    assert.equal(inPlace.code, EXIT_OK);
    const edited = parseSidFile(new Uint8Array(fs.readFileSync(copy)));
    assert.equal(edited.songs, 3);
    assert.equal(edited.clock, "NTSC");
    assert.equal(edited.sidModels[0], "8580");
    const nothing = await run(root, ["sid", "edit", "copy.sid", "--songs", "3", "--in-place"]);
    assert.equal(nothing.code, EXIT_OK);
    assert.match(nothing.out, /nothing to change/);
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
    const a = await run(root, ["sid", "edit", "copy.sid", "--sid2", "$D420", "--model2", "6581", "--dry-run", "--json"]);
    const rec = JSON.parse(a.out).result;
    assert.deepEqual(rec.version, { from: 2, to: 3 });
    assert.match(rec.warnings[0], /raised the header version from 2 to 3/);
  } finally { done(); }
});

test("sid edit: errors say what to do", async () => {
  const { root, done } = hvscTree();
  try {
    const bad = async (args, code, pattern) => {
      const result = await run(root, ["sid", "edit", "MUSICIANS/X/Xyz/One.sid", ...args, "--dry-run"], { HVSC_ROOT: undefined });
      assert.equal(result.code, code, args.join(" "));
      assert.match(result.err, pattern, args.join(" "));
    };
    await bad([], EXIT_USAGE, /needs at least one field to change/);
    await bad(["--clock", "pal+"], EXIT_USAGE, /--clock must be one of/);
    await bad(["--songs", "0"], EXIT_USAGE, /--songs needs a whole number from 1 to 256/);
    await bad(["--start-song", "9"], EXIT_INPUT, /startSong 9 is not 1\.\.2/);
    await bad(["--sid2", "$D400"], EXIT_USAGE, /not a valid SID address/);
    await bad(["--magic", "rsid"], EXIT_INPUT, /set these in the same edit/);
    await bad(["--version", "1", "--clock", "pal"], EXIT_USAGE, /needs header version 2 or later/);
    await bad(["--title", "x".repeat(40)], EXIT_INPUT, /32 byte limit/);
    await bad(["--speed", "fast"], EXIT_USAGE, /--speed needs vbi, cia/);
    await bad(["--speed-song", "9=cia"], EXIT_USAGE, /song 9/);
    await bad(["--speed-song", "x"], EXIT_USAGE, /--speed-song needs/);
    await bad(["--playsid", "maybe"], EXIT_USAGE, /on or off/);
    await bad(["--bogus", "1"], EXIT_USAGE, /unknown option --bogus/);
    await bad(["--author"], EXIT_USAGE, /--author needs a value/);
    const missing = await run(root, ["sid", "edit", "nope.sid", "--author", "x"]);
    assert.equal(missing.code, EXIT_INPUT);
    fs.writeFileSync(path.join(root, "junk.sid"), "junk junk junk junk");
    const junk = await run(root, ["sid", "edit", "junk.sid", "--author", "x"]);
    assert.equal(junk.code, EXIT_INPUT);
    assert.match(junk.err, /is it a PSID or RSID file\?/);
    assert.equal((await run(root, ["sid", "edit", "MUSICIANS/X/Xyz/One.sid", "--author", "x", "--max-bytes", "10"])).code, EXIT_LIMIT);
  } finally { done(); }
});

test("sid edit tells whether the old key is listed in a database and the command in the hint carries the times over", async () => {
  const { root, one, done } = hvscTree();
  try {
    const db = path.join(root, "DOCUMENTS/Songlengths.md5");
    const before = fs.readFileSync(db, "latin1");
    const edit = await run(root, ["sid", "edit", "MUSICIANS/X/Xyz/One.sid", "--author", "Moved On", "-o", "fixed.sid", "--songlengths", db]);
    assert.equal(edit.code, EXIT_OK);
    assert.match(edit.out, /songlengths: the old key is listed/);
    const newKey = md5ForSonglengths(new Uint8Array(fs.readFileSync(path.join(root, "fixed.sid"))));
    const written = await run(root, ["songlengths", "write", db, "fixed.sid", "--from-md5", md5ForSonglengths(one)]);
    assert.equal(written.code, EXIT_OK);
    assert.match(written.out, /entry rekeyed/);
    const after = fs.readFileSync(db, "latin1");
    assert.equal(after, before.replace(md5ForSonglengths(one), newKey));
    const looked = await run(root, ["songlengths", "lookup", "fixed.sid", "--db", db]);
    assert.match(looked.out, /song 1: 1:30 \(90 s\)/);
    assert.match(looked.out, /song 2: 2:00.5 \(120.5 s\)/);
    // Only the key of the old Songlengths.txt format ignores a text edit.
    const legacy = await run(root, ["sid", "edit", "MUSICIANS/X/Xyz/One.sid", "--author", "Z", "-o", "z.sid", "--json"]);
    const rec = JSON.parse(legacy.out).result;
    assert.equal(rec.legacyMd5.old, rec.legacyMd5.new);
    assert.equal(rec.legacyMd5.old, legacyMd5ForSonglengths(new Uint8Array(one)));
  } finally { done(); }
});

test("songlengths lookup: by file, by key, per song, not listed", async () => {
  const { root, two, done } = hvscTree();
  try {
    const db = path.join(root, "DOCUMENTS/Songlengths.md5");
    const byFile = await run(root, ["songlengths", "lookup", "MUSICIANS/X/Xyz/Two.sid", "--json"], { HVSC_ROOT: root });
    const rec = JSON.parse(byFile.out).result;
    assert.equal(rec.found, true);
    assert.equal(rec.songs, 3);
    assert.deepEqual(rec.entries[0].durationsMs, [10000, 20000, 30000]);
    assert.equal(rec.entries[0].path, "/MUSICIANS/X/Xyz/Two.sid");
    const byKey = await run(root, ["songlengths", "lookup", "--md5", md5ForSonglengths(two).toUpperCase(), "--db", db, "--song", "2"]);
    assert.match(byKey.out, /song 2: 0:20 \(20 s\)/);
    assert.doesNotMatch(byKey.out, /song 1/);
    const missing = await run(root, ["songlengths", "lookup", "--md5", "0".repeat(32), "--db", db, "--json"]);
    assert.equal(missing.code, EXIT_FAILED);
    assert.equal(JSON.parse(missing.out).ok, false);
    assert.match((await run(root, ["songlengths", "lookup", "--md5", "0".repeat(32), "--db", db])).out, /not listed in/);
    assert.equal((await run(root, ["songlengths", "lookup"])).code, EXIT_USAGE);
    assert.equal((await run(root, ["songlengths", "lookup", "--md5", "xyz", "--db", db])).code, EXIT_USAGE);
    assert.equal((await run(root, ["songlengths", "lookup", "MUSICIANS/X/Xyz/Two.sid"], { HVSC_ROOT: undefined, PWD: undefined })).code, EXIT_OK, "a root above the file is found");
    assert.equal((await run(os.tmpdir(), ["songlengths", "lookup", "--md5", "0".repeat(32)], { HVSC_ROOT: undefined })).code, EXIT_USAGE);
  } finally { done(); }
});

test("songlengths write: add a new entry in path order, in the old format too, and refuse a wrong number of times", async () => {
  const { root, done } = hvscTree();
  try {
    const db = path.join(root, "DOCUMENTS/Songlengths.md5");
    fs.writeFileSync(path.join(root, "New.sid"), sid({ name: "New", songs: 2 }));
    const before = fs.readFileSync(db, "latin1");
    const dry = await run(root, ["songlengths", "write", db, "New.sid", "--path", "/MUSICIANS/X/Xyz/Mid.sid", "--times", "2:30,1:10.5", "--dry-run"]);
    assert.equal(dry.code, EXIT_OK);
    assert.match(dry.out, /entry added \(dry run, nothing written\)/);
    assert.equal(fs.readFileSync(db, "latin1"), before);
    const written = await run(root, ["songlengths", "write", db, "New.sid", "--path", "/MUSICIANS/X/Xyz/Mid.sid", "--times", "2:30,1:10.5"]);
    assert.equal(written.code, EXIT_OK);
    const after = fs.readFileSync(db, "latin1");
    const newKey = md5ForSonglengths(new Uint8Array(fs.readFileSync(path.join(root, "New.sid"))));
    assert.equal(after, before.replace("; /MUSICIANS/X/Xyz/One.sid", `; /MUSICIANS/X/Xyz/Mid.sid\r\n${newKey}=2:30 1:10.5\r\n; /MUSICIANS/X/Xyz/One.sid`));
    assert.equal((await run(root, ["songlengths", "write", db, "New.sid", "--times", "1:00"])).code, EXIT_USAGE);
    assert.match((await run(root, ["songlengths", "write", db, "New.sid", "--times", "1:00"])).err, /has 2 songs, but --times has 1 time/);
    const noPath = await run(os.tmpdir(), ["songlengths", "write", db, path.join(root, "New.sid"), "--times", "1:00,2:00", "-o", path.join(root, "out.md5")], { HVSC_ROOT: undefined });
    assert.equal(noPath.code, EXIT_OK, "the file is below a root, so the path is known");
    assert.equal(fs.readFileSync(path.join(root, "out.md5"), "latin1"), after.replace("2:30 1:10.5", "1:00 2:00"), "an entry that is listed gets its times in place");
    assert.equal(fs.readFileSync(db, "latin1"), after, "-o leaves the database alone");
    const old = path.join(root, "Songlengths.txt");
    fs.writeFileSync(old, "[Database]\n");
    const legacy = await run(root, ["songlengths", "write", old, "New.sid", "--path", "/MUSICIANS/X/Xyz/Mid.sid", "--times", "2:30.4,1:10.6", "--json"]);
    assert.equal(legacy.code, EXIT_OK);
    assert.equal(JSON.parse(legacy.out).result.format, "txt");
    assert.equal(fs.readFileSync(old, "latin1"), `[Database]\n; /MUSICIANS/X/Xyz/Mid.sid\n${legacyMd5ForSonglengths(new Uint8Array(fs.readFileSync(path.join(root, "New.sid"))))}=2:30 1:11\n`);
  } finally { done(); }
});

test("songlengths verify reports problems with exit 1 and takes its arguments in any order", async () => {
  const { root, done } = hvscTree();
  try {
    const db = path.join(root, "DOCUMENTS/Songlengths.md5");
    const ok = await run(root, ["songlengths", "verify", db, root, "--unlisted"]);
    assert.equal(ok.code, EXIT_OK);
    assert.match(ok.out, /ok: 2\n {2}no problems/);
    fs.writeFileSync(path.join(root, "MUSICIANS/X/Xyz/Two.sid"), sid({ name: "Changed", songs: 3 }));
    fs.rmSync(path.join(root, "MUSICIANS/X/Xyz/One.sid"));
    fs.writeFileSync(path.join(root, "MUSICIANS/X/Xyz/Extra.sid"), sid({ name: "Extra" }));
    const bad = await run(root, ["songlengths", "verify", "--unlisted", "--json"], { HVSC_ROOT: root });
    assert.equal(bad.code, EXIT_FAILED);
    const rec = JSON.parse(bad.out).result;
    assert.equal(rec.problems, 2);
    assert.equal(rec.missing[0].path, "/MUSICIANS/X/Xyz/One.sid");
    assert.equal(rec.wrongMd5[0].path, "/MUSICIANS/X/Xyz/Two.sid");
    assert.deepEqual(rec.unlistedFiles, ["/MUSICIANS/X/Xyz/Extra.sid"]);
    const text = await run(root, ["songlengths", "verify", root, db, "--limit", "0"]);
    assert.match(text.out, /missing files: 1\n {4}\.\.\. 1 more/);
    assert.equal((await run(root, ["songlengths", "verify", db], { HVSC_ROOT: undefined })).code, EXIT_USAGE);
  } finally { done(); }
});

test("stil parse and query by HVSC path or by file", async () => {
  const { root, done } = hvscTree();
  try {
    const parse = await run(root, ["stil", "parse", "--json"], { HVSC_ROOT: root });
    const rec = JSON.parse(parse.out).result;
    assert.equal(rec.version, "1");
    assert.equal(rec.entries, 1);
    assert.equal(rec.items[0].blocks[1].subtune, 2);
    assert.match((await run(root, ["stil", "parse", "DOCUMENTS/STIL.txt"])).out, /STIL v1, 1 entries, 2 blocks, 3 fields/);
    const byPath = await run(root, ["stil", "query", "/MUSICIANS/X/Xyz/One.sid"], { HVSC_ROOT: root });
    assert.equal(byPath.code, EXIT_OK);
    assert.match(byPath.out, /^\/MUSICIANS\/X\/Xyz\/One\.sid\n {2}COMMENT: Global comment\.\n {2}\(#2\)\n {6}TITLE: Second tune \[from Album\]\n {5}ARTIST: Someone/);
    const byFile = JSON.parse((await run(root, ["stil", "query", "MUSICIANS/X/Xyz/One.sid", "--subtune", "2", "--json"], { HVSC_ROOT: undefined })).out);
    assert.equal(byFile.result.found, true);
    assert.equal(byFile.result.subtunes.length, 1);
    const relative = await run(root, ["stil", "query", "MUSICIANS/X/Xyz/One.sid", "--stil", "DOCUMENTS/STIL.txt"], { HVSC_ROOT: undefined });
    assert.equal(relative.code, EXIT_OK);
    const none = await run(root, ["stil", "query", "/MUSICIANS/X/Xyz/Two.sid"], { HVSC_ROOT: root });
    assert.equal(none.code, EXIT_FAILED);
    assert.match(none.out, /no STIL entry for/);
    assert.equal((await run(root, ["stil", "query", "nothing-here.txt"], { HVSC_ROOT: root })).code, EXIT_INPUT);
    assert.equal((await run(root, ["stil", "query", "/MUSICIANS/X/Xyz/One.sid"], { HVSC_ROOT: undefined, PWD: undefined })).code, EXIT_USAGE);
    assert.equal((await run(root, ["stil", "query"])).code, EXIT_USAGE);
  } finally { done(); }
});

test("sid player needs a signature file, reads it from --sidid or SIDID_CFG, and lists matches", async () => {
  const { root, done } = hvscTree();
  try {
    fs.writeFileSync(path.join(root, "sig.cfg"), "Toy\r\nA9 00 8D 18 D4 4C END\r\nOther\r\n60 60 END\r\n");
    fs.writeFileSync(path.join(root, "sig.nfo"), "Toy\r\n     NAME: Toy Player\r\n   AUTHOR: Nobody\r\n");
    const none = await run(root, ["sid", "player", "MUSICIANS/X/Xyz/One.sid"], { SIDID_CFG: undefined, SIDIDCFG: undefined });
    assert.equal(none.code, EXIT_USAGE);
    assert.match(none.err, /no SIDId signature file given/);
    const one = await run(root, ["sid", "player", "MUSICIANS/X/Xyz/One.sid", "--sidid", "sig.cfg", "--sidid-info", "sig.nfo", "--all"]);
    assert.equal(one.code, EXIT_OK);
    assert.match(one.out, /Toy \(Toy Player, Nobody\), confidence low, 6 fixed bytes in 1 fragment, at \$1000 \(data offset 0\)\n {2}also Other/);
    const envJson = JSON.parse((await run(root, ["sid", "player", "MUSICIANS/X/Xyz/One.sid", "--json"], { SIDID_CFG: path.join(root, "sig.cfg") })).out);
    assert.equal(envJson.result.identified, true);
    assert.equal(envJson.result.matches[0].player, "Toy");
    assert.equal(envJson.result.matches.length, 1);
    const dir = await run(root, ["sid", "player", "MUSICIANS", "--sidid", "sig.cfg", "--json"]);
    assert.equal(dir.code, EXIT_OK);
    assert.deepEqual(dir.out.trim().split("\n").map((l) => JSON.parse(l).player), ["Toy", "Toy"]);
    fs.writeFileSync(path.join(root, "empty.cfg"), "nothing\n");
    assert.equal((await run(root, ["sid", "player", "MUSICIANS/X/Xyz/One.sid", "--sidid", "empty.cfg"])).code, EXIT_INPUT);
    assert.equal((await run(root, ["sid", "player", "MUSICIANS/X/Xyz/One.sid", "--sidid", "missing.cfg"])).code, EXIT_INPUT);
    fs.writeFileSync(path.join(root, "noplayer.sid"), sid({ payload: Uint8Array.from([1, 2, 3]) }));
    assert.match((await run(root, ["sid", "player", "noplayer.sid", "--sidid", "sig.cfg"])).out, /no player identified/);
  } finally { done(); }
});

const HVSC = process.env.HVSC_ROOT ?? process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const hvscPresent = fs.existsSync(path.join(HVSC, "DOCUMENTS", "Songlengths.md5")) && fs.existsSync(path.join(HVSC, "DOCUMENTS", "STIL.txt"));

test("HVSC (local only): sid info over the whole collection with Songlengths and STIL, and the Songlengths file verifies", { skip: hvscPresent ? false : `no HVSC at ${HVSC}` }, async () => {
  const started = Date.now();
  const before = process.cpuUsage();
  const info = await run(os.tmpdir(), ["sid", "info", HVSC, "--json"], { HVSC_ROOT: undefined });
  const cpu = process.cpuUsage(before);
  const seconds = (Date.now() - started) / 1000;
  const lines = info.out.trim().split("\n");
  const failed = lines.filter((l) => l.startsWith('{"file":') && l.includes('"error"'));
  const withLengths = lines.filter((l) => l.includes('"songlengths":[')).length;
  const withStil = lines.filter((l) => l.includes('"stil":{')).length;
  console.log(`HVSC sid info: ${lines.length} files, ${failed.length} failed, ${withLengths} with Songlengths, ${withStil} with STIL, ${seconds.toFixed(1)} s wall, ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s CPU`);
  assert.equal(info.code, EXIT_OK);
  assert.ok(lines.length > 50000);
  assert.equal(failed.length, 0);
  assert.ok(withLengths > 50000 && withStil > 10000);
  assert.ok(seconds < 120, `${seconds} s`);
  const verify = await run(os.tmpdir(), ["songlengths", "verify", path.join(HVSC, "DOCUMENTS/Songlengths.md5"), HVSC, "--unlisted", "--json"]);
  const result = JSON.parse(verify.out).result;
  console.log(`HVSC songlengths verify: ${result.entries} entries, ${result.ok} ok, ${result.problems} problems, ${result.unlistedFiles.length} unlisted`);
  assert.equal(verify.code, EXIT_OK);
  assert.equal(result.ok, result.entries);
});
