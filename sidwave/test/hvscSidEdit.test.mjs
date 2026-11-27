import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { editSidHeader } from "../src/sidEdit.ts";
import { HvscError, walkSidFiles } from "../src/hvsc.ts";
import { SidFileError, md5ForSonglengths, parseSidFile, writeSidFile } from "../src/sidFile.ts";
import { legacyMd5ForSonglengths } from "../src/songlengths.ts";

const HVSC = process.env.HVSC_ROOT ?? process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const hvscPresent = fs.existsSync(path.join(HVSC, "DOCUMENTS", "Songlengths.md5"));
const PAYLOAD = Uint8Array.from([0x4c, 0x08, 0x10, 0x4c, 0x0b, 0x10, 0x60, 0x60, 0xa9, 0x00, 0x8d, 0x18, 0xd4, 0x60]);

function make(over = {}) {
  return writeSidFile({
    magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 3, startSong: 1, speed: 0b101,
    name: "Name", author: "Author", released: "2026 Somebody", payload: PAYLOAD, ...over,
  });
}

const changedFields = (result) => result.changes.map((c) => c.field);

test("an edit changes only the bytes of the edited field", () => {
  const input = make();
  const result = editSidHeader(input, { name: "New name" });
  assert.deepEqual(changedFields(result), ["name"]);
  assert.equal(result.bytes.length, input.length);
  assert.ok(result.changedRanges.length > 0 && result.changedRanges.every(([from, to]) => from >= 0x16 && to <= 0x36), JSON.stringify(result.changedRanges));
  // Every byte outside the 32 byte name field is identical.
  for (let i = 0; i < input.length; i++) if (i < 0x16 || i >= 0x36) assert.equal(result.bytes[i], input[i], `byte ${i}`);
  assert.equal(parseSidFile(result.bytes).name, "New name");
  assert.notEqual(result.md5.old, result.md5.new);
  assert.equal(result.md5.old, md5ForSonglengths(input));
  assert.equal(result.md5.new, md5ForSonglengths(result.bytes));
  // The name does not take part in the legacy key.
  assert.equal(result.legacyMd5.old, result.legacyMd5.new);
});

test("an edit that sets the value a field already has changes nothing", () => {
  const input = make();
  const result = editSidHeader(input, { name: "Name", songs: 3, clock: "unknown", initAddress: 0x1000 });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.bytes, input);
  assert.equal(result.md5.old, result.md5.new);
});

test("untouched bytes survive, including text after the terminator and reserved flag bits", () => {
  const input = make({ name: "A" });
  input[0x16 + 5] = 0x58; // garbage after the zero terminator of the name
  input[0x76] |= 0xfc; // reserved flag bits (high byte of the big endian word is at 0x76)
  input[0x7a] = 0x42; // ignored in version 2
  const result = editSidHeader(input, { author: "Somebody" });
  assert.equal(result.bytes[0x16 + 5], 0x58);
  assert.equal(result.bytes[0x76], input[0x76]);
  assert.equal(result.bytes[0x7a], 0x42);
  assert.deepEqual(result.changedRanges.map(([a]) => a), [0x36]);
});

test("every field can be set and reads back", () => {
  const input = make({ version: 2 });
  const result = editSidHeader(input, {
    name: "N", author: "A", released: "R", songs: 5, startSong: 2, speed: 0x11, clock: "PAL", sidModel: "8580", sid2Model: "6581", sid3Model: "6581+8580",
    secondSidAddress: 0xd420, thirdSidAddress: 0xde00, musPlayer: false, psidSpecific: true, loadAddress: 0x2000, initAddress: 0x2000, playAddress: 0x2003, startPage: 0x30, pageLength: 4,
  });
  const out = parseSidFile(result.bytes);
  assert.equal(out.name, "N");
  assert.equal(out.songs, 5);
  assert.equal(out.startSong, 2);
  assert.equal(out.speed, 0x11);
  assert.equal(out.clock, "PAL");
  assert.deepEqual(out.sidModels, ["8580", "6581", "6581+8580"]);
  assert.equal(out.secondSidAddress, 0xd420);
  assert.equal(out.thirdSidAddress, 0xde00);
  assert.equal(out.psidSpecific, true);
  assert.equal(out.loadAddress, 0x2000);
  assert.equal(out.initAddress, 0x2000);
  assert.equal(out.playAddress, 0x2003);
  assert.equal(out.startPage, 0x30);
  assert.equal(out.pageLength, 4);
  assert.equal(out.version, 4);
  assert.deepEqual(result.version, { from: 2, to: 4 });
  assert.match(result.warnings.join("\n"), /raised the header version from 2 to 4/);
  assert.deepEqual(out.payload, PAYLOAD);
});

test("a field of a later version raises the version with a warning; an explicit lower version is an error", () => {
  const input = make({ version: 2 });
  const raised = editSidHeader(input, { secondSidAddress: 0xd420 });
  assert.equal(parseSidFile(raised.bytes).version, 3);
  assert.match(raised.warnings[0], /from 2 to 3 for a second SID address/);
  assert.throws(() => editSidHeader(input, { secondSidAddress: 0xd420, version: 2 }), (e) => e instanceof HvscError && e.code === "bad_combination" && /needs header version 3/.test(e.message));
  const explicit = editSidHeader(input, { version: 4 });
  assert.equal(parseSidFile(explicit.bytes).version, 4);
  assert.deepEqual(explicit.warnings, []);
});

test("version 1 gets a longer header when a flag is set, and a version 2 file goes back to 1 only when no later field is in use", () => {
  const v1 = make({ version: 1 });
  assert.equal(parseSidFile(v1).version, 1);
  const up = editSidHeader(v1, { clock: "NTSC" });
  assert.equal(up.layoutChanged, true);
  assert.equal(up.changedRanges, undefined);
  assert.equal(up.bytes.length, v1.length + 6);
  const parsed = parseSidFile(up.bytes);
  assert.equal(parsed.clock, "NTSC");
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.payload, PAYLOAD);
  assert.throws(() => editSidHeader(up.bytes, { version: 1 }), (e) => e instanceof HvscError && /no room for the flags/.test(e.message));
  const down = editSidHeader(up.bytes, { version: 1, clock: "unknown" });
  assert.deepEqual(down.bytes, v1);
});

test("RSID: switching needs the RSID constraints in the same edit", () => {
  const input = make({ version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, speed: 1 });
  assert.throws(() => editSidHeader(input, { magic: "RSID" }), (e) => e instanceof SidFileError && e.code === "rsid_constraint" && /set these in the same edit/.test(e.message));
  const ok = editSidHeader(input, { magic: "RSID", playAddress: 0, speed: 0 });
  const out = parseSidFile(ok.bytes);
  assert.equal(out.magic, "RSID");
  assert.equal(out.playAddress, 0);
  assert.throws(() => editSidHeader(input, { basic: true }), (e) => e instanceof HvscError && /psidSpecific/.test(e.message));
});

test("invalid values are rejected with a typed error that names the allowed range", () => {
  const input = make();
  const bad = (fields, pattern) => assert.throws(() => editSidHeader(input, fields), (e) => (e instanceof HvscError || e instanceof SidFileError) && pattern.test(e.message), JSON.stringify(fields));
  bad({ songs: 0 }, /songs must be a whole number from 1 to 256/);
  bad({ songs: 257 }, /songs/);
  bad({ songs: 1.5 }, /songs/);
  bad({ startSong: 4 }, /startSong 4 is not 1\.\.3/);
  bad({ clock: "PAL+NTSC+X" }, /clock must be one of/);
  bad({ secondSidAddress: 0xd400 }, /not a valid SID address/);
  bad({ secondSidAddress: 0xd430 }, /not a valid SID address/);
  bad({ initAddress: 0x10000 }, /initAddress/);
  bad({ name: "x".repeat(33) }, /32 byte limit/);
  bad({ name: "中" }, /Windows-1252/);
  bad({ startPage: 0, pageLength: 3 }, /page count must be 0/);
  bad({ startPage: 0xf0, pageLength: 0x20 }, /past page \$FF/);
  bad({ speedSongs: { 9: "CIA" } }, /song 9/);
  bad({ colour: "red" }, /unknown field/);
  assert.throws(() => editSidHeader(input, { secondSidAddress: 0xd420, thirdSidAddress: 0xd420 }), (e) => e instanceof HvscError && /must differ/.test(e.message));
});

test("speed of single songs follows the wrap rule of the header", () => {
  const input = make({ songs: 40, speed: 0, version: 2 });
  const plain = editSidHeader(input, { speedSongs: { 3: "CIA" } });
  assert.equal(parseSidFile(plain.bytes).speed, 0b100);
  const clamp = editSidHeader(input, { speedSongs: { 40: "CIA" } });
  assert.equal(parseSidFile(clamp.bytes).speed >>> 0, 0x80000000);
  assert.match(clamp.warnings.join(" "), /shares speed bit 31/);
  const wrapped = editSidHeader(input, { psidSpecific: true, speedSongs: { 40: "CIA" } });
  assert.equal(parseSidFile(wrapped.bytes).speed, 1 << 7);
});

test("load address in the header or embedded in the data", () => {
  const embedded = make();
  const r1 = editSidHeader(embedded, { loadAddress: 0x1800, initAddress: 0x1800, playAddress: 0x1803 });
  assert.equal(parseSidFile(r1.bytes).loadAddress, 0x1800);
  assert.match(r1.warnings.join(" "), /does not relocate/);
  assert.deepEqual(r1.changes.find((c) => c.field === "loadAddress").offset, 0x7c);
  const header = make({ headerLoadAddress: 0x1000 });
  const r2 = editSidHeader(header, { loadAddress: 0x1800 });
  assert.equal(parseSidFile(r2.bytes).headerLoadAddress, 0x1800);
});

test("the legacy key ignores text fields but follows speed, init, play and songs", () => {
  const input = make();
  assert.equal(editSidHeader(input, { author: "X" }).legacyMd5.new, legacyMd5ForSonglengths(input));
  assert.notEqual(editSidHeader(input, { speed: 7 }).legacyMd5.new, legacyMd5ForSonglengths(input));
  assert.notEqual(editSidHeader(input, { songs: 4 }).legacyMd5.new, legacyMd5ForSonglengths(input));
  assert.notEqual(editSidHeader(input, { clock: "NTSC" }).legacyMd5.new, legacyMd5ForSonglengths(input));
  assert.equal(editSidHeader(input, { clock: "PAL" }).legacyMd5.new, legacyMd5ForSonglengths(input));
});

test("--strict turns a new deviation into an error", () => {
  const input = make({ payload: Uint8Array.from(new Array(512).fill(0x60)) });
  // A relocation range inside the load image is a warning in the parser.
  const lenient = editSidHeader(input, { startPage: 0x10, pageLength: 1 });
  assert.match(lenient.warnings.join(" "), /overlaps the load image/);
  assert.throws(() => editSidHeader(input, { startPage: 0x10, pageLength: 1 }, { strict: true }), (e) => e instanceof SidFileError);
});

test("input that is not a SID file is a typed error", () => {
  assert.throws(() => editSidHeader(new Uint8Array(10), { name: "x" }), (e) => e instanceof SidFileError);
  assert.throws(() => editSidHeader(make(), { name: "x" }, { maxBytes: 20 }), (e) => e instanceof SidFileError && e.code === "too_large");
});

test("fuzz: 1000 random edits of random headers end in a valid file or a typed error", () => {
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const addresses = [0, 0x07e8, 0x1000, 0x1003, 0x2000, 0xc000, 0xd420, 0xd430, 0xde00, 0xdfe0, 0xffff, 0x10000, -1, 1.5];
  const small = [0, 1, 2, 3, 40, 255, 256, 257, -1, 1.5, NaN];
  const bases = [make(), make({ version: 1 }), make({ version: 3, secondSidAddress: 0xd420 }), make({ version: 4, secondSidAddress: 0xd420, thirdSidAddress: 0xde00 }),
    make({ magic: "RSID", version: 3, playAddress: 0, speed: 0, initAddress: 0x1000 })];
  let valid = 0;
  let typed = 0;
  for (let i = 0; i < 1000; i++) {
    let input = pick(bases);
    if (rnd() < 0.3) { // damage a few bytes of the input
      input = input.slice();
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) input[Math.floor(rnd() * Math.min(input.length, 0x80))] = Math.floor(rnd() * 256);
    }
    const fields = {};
    const maybe = (key, value) => { if (rnd() < 0.25) fields[key] = value; };
    maybe("magic", pick(["PSID", "RSID", "XSID", 3]));
    maybe("version", pick([1, 2, 3, 4, 5, 0, "2"]));
    maybe("name", pick(["", "x", "x".repeat(32), "x".repeat(33), "äö", "中"]));
    maybe("author", pick(["", "y", 7]));
    maybe("songs", pick(small));
    maybe("startSong", pick(small));
    maybe("speed", pick([0, 1, 0xffffffff, 0x100000000, -1]));
    maybe("speedSongs", pick([{ 1: "CIA" }, { 99: "CIA" }, { 1: "FAST" }, null]));
    maybe("clock", pick(["unknown", "PAL", "NTSC", "PAL+NTSC", "x"]));
    maybe("sidModel", pick(["unknown", "6581", "8580", "6581+8580", "x"]));
    maybe("sid2Model", pick(["unknown", "6581"]));
    maybe("secondSidAddress", pick([...addresses, null]));
    maybe("thirdSidAddress", pick([...addresses, null]));
    maybe("musPlayer", pick([true, false, 1]));
    maybe("psidSpecific", pick([true, false]));
    maybe("basic", pick([true, false]));
    maybe("loadAddress", pick(addresses));
    maybe("initAddress", pick(addresses));
    maybe("playAddress", pick(addresses));
    maybe("startPage", pick(small));
    maybe("pageLength", pick(small));
    try {
      const result = editSidHeader(input, fields);
      const reread = parseSidFile(result.bytes);
      assert.ok(reread.songs >= 1);
      assert.equal(result.md5.new, md5ForSonglengths(result.bytes));
      valid++;
    } catch (error) {
      assert.ok(error instanceof HvscError || error instanceof SidFileError, `untyped error for ${JSON.stringify(fields)}: ${error && error.stack}`);
      typed++;
    }
  }
  assert.ok(valid > 50 && typed > 50, `valid ${valid}, typed ${typed}`);
});

test("HVSC: parse then write with no change reproduces every file byte for byte, and a no-op edit does too", { skip: hvscPresent ? false : `no HVSC at ${HVSC}` }, () => {
  let files = 0;
  const differ = [];
  const failed = [];
  for (const file of walkSidFiles(HVSC)) {
    files++;
    const bytes = new Uint8Array(fs.readFileSync(file));
    let parsed;
    try { parsed = parseSidFile(bytes); } catch (error) { failed.push(`${file}: ${error.message}`); continue; }
    const { warnings, dataOffset, ...input } = parsed;
    const written = writeSidFile(input, { strict: false });
    if (Buffer.compare(Buffer.from(written), Buffer.from(bytes)) !== 0) differ.push(file);
    const edited = editSidHeader(bytes, { name: parsed.name, songs: parsed.songs });
    if (edited.changes.length > 0 || Buffer.compare(Buffer.from(edited.bytes), Buffer.from(bytes)) !== 0) differ.push(`${file} (edit)`);
  }
  console.log(`HVSC round trip: ${files} files, ${differ.length} differ, ${failed.length} unparseable`);
  assert.ok(files > 50000, `files ${files}`);
  assert.deepEqual(failed, []);
  assert.deepEqual(differ, []);
});
