import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SidFileError, parseSidFile, writeSidFile, subtunes, songSpeed, md5ForSonglengths, effectiveInitAddress,
} from "../src/sidFile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HVSC = process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const PAYLOAD = Uint8Array.from([0xa9, 0x00, 0x60, 0x60, 0x4c, 0xe8, 0x07]); // 7 bytes of code

function psid(over = {}) {
  return {
    magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 1, startSong: 1,
    speed: 0, name: "Name", author: "Author", released: "1990 Rel", payload: PAYLOAD, ...over,
  };
}
function rsid(over = {}) {
  return psid({ magic: "RSID", version: 3, loadAddress: 0x0800, initAddress: 0x0800, playAddress: 0, ...over });
}
const bad = (code, fn, msg) => assert.throws(fn, (e) => e instanceof SidFileError && e.name === "SidFileError" && e.code === code, msg ?? code);
// Builds bytes for a raw header edit.
function patched(input, edit) {
  const b = writeSidFile(input, { strict: false });
  edit(b, new DataView(b.buffer));
  return b;
}
function norm(f) {
  const { warnings, dataOffset, ...rest } = f;
  return { ...rest, payload: [...rest.payload] };
}

test("round trip for every version and both magics", () => {
  const cases = [
    psid({ version: 1 }),
    psid({ version: 2, musPlayer: true, psidSpecific: true, clock: "PAL", sidModels: ["6581", "unknown", "unknown"] }),
    psid({ version: 3, clock: "NTSC", sidModels: ["8580", "6581+8580", "unknown"], secondSidAddress: 0xd420 }),
    psid({ version: 4, clock: "PAL+NTSC", sidModels: ["6581+8580", "6581", "8580"], secondSidAddress: 0xd420, thirdSidAddress: 0xdfe0, startPage: 0x20, pageLength: 4 }),
    psid({ version: 3, headerLoadAddress: 0x1000 }),
    rsid({ version: 2 }),
    rsid({ version: 3, secondSidAddress: 0xde00 }),
    rsid({ version: 4, secondSidAddress: 0xd420, thirdSidAddress: 0xd7e0, clock: "PAL", sidModels: ["8580", "8580", "6581"] }),
    rsid({ version: 4, basic: true, initAddress: 0 }),
  ];
  for (const x of cases) {
    const bytes = writeSidFile(x);
    const parsed = parseSidFile(bytes);
    const expect = { dataOffset: 0, ...x };
    assert.deepEqual(parsed.warnings, []);
    for (const k of Object.keys(x)) {
      if (k === "payload") assert.deepEqual([...parsed.payload], [...x.payload]);
      else assert.deepEqual(parsed[k], expect[k], `${x.magic} v${x.version} ${k}`);
    }
    assert.equal(parsed.dataOffset, x.version === 1 ? 0x76 : 0x7c);
    assert.equal(Buffer.compare(Buffer.from(writeSidFile(parsed)), Buffer.from(bytes)), 0);
    assert.deepEqual(norm(parseSidFile(writeSidFile(parsed))), norm(parsed));
  }
});

test("effective load address comes from the data when the header load is 0", () => {
  const bytes = writeSidFile(psid());
  assert.equal(bytes.length, 0x7c + 2 + PAYLOAD.length);
  assert.equal(bytes[0x7c], 0x00);
  assert.equal(bytes[0x7d], 0x10);
  const p = parseSidFile(bytes);
  assert.equal(p.headerLoadAddress, 0);
  assert.equal(p.loadAddress, 0x1000);
  assert.equal(p.payload.length, PAYLOAD.length);
  const explicit = parseSidFile(writeSidFile(psid({ headerLoadAddress: 0x1000 })));
  assert.equal(explicit.loadAddress, 0x1000);
  assert.equal(explicit.payload.length, PAYLOAD.length);
  assert.equal(effectiveInitAddress({ initAddress: 0, loadAddress: 0x2000 }), 0x2000);
});

test("error: truncated", () => {
  const good = writeSidFile(psid());
  bad("truncated", () => parseSidFile(new Uint8Array(3)));
  bad("truncated", () => parseSidFile(good.subarray(0, 5)));
  bad("truncated", () => parseSidFile(good.subarray(0, 0x7b)));
  bad("truncated", () => parseSidFile(good.subarray(0, 0x7c))); // no load address bytes
  bad("truncated", () => parseSidFile(good.subarray(0, 0x7d)));
  parseSidFile(good.subarray(0, 0x7e)); // empty payload is allowed (warning)
  assert.ok(parseSidFile(good.subarray(0, 0x7e)).warnings.some((w) => w.startsWith("truncated")));
  const v1 = writeSidFile(psid({ version: 1 }));
  bad("truncated", () => parseSidFile(v1.subarray(0, 0x75)));
});

test("error: bad_magic", () => {
  const b = writeSidFile(psid());
  b[0] = 0x58;
  bad("bad_magic", () => parseSidFile(b));
  bad("bad_magic", () => writeSidFile({ ...psid(), magic: "XSID" }));
});

test("error: bad_version", () => {
  const dvPatch = (v) => patched(psid(), (_b, dv) => dv.setUint16(4, v));
  bad("bad_version", () => parseSidFile(dvPatch(0)));
  bad("bad_version", () => parseSidFile(dvPatch(5)));
  bad("bad_version", () => writeSidFile(psid({ version: 5 })));
  bad("bad_version", () => writeSidFile(rsid({ version: 1 })));
  const r1 = patched(rsid(), (b, dv) => dv.setUint16(4, 1));
  bad("bad_version", () => parseSidFile(r1));
});

test("error: bad_data_offset", () => {
  bad("bad_data_offset", () => parseSidFile(patched(psid(), (_b, dv) => dv.setUint16(6, 0x76))));
  bad("bad_data_offset", () => parseSidFile(patched(psid({ version: 1 }), (_b, dv) => dv.setUint16(6, 0x7c))));
  bad("bad_data_offset", () => parseSidFile(patched(psid(), (_b, dv) => dv.setUint16(6, 0))));
});

test("songs and startSong boundaries", () => {
  assert.equal(parseSidFile(writeSidFile(psid({ songs: 1 }))).songs, 1);
  const s256 = parseSidFile(writeSidFile(psid({ songs: 256, startSong: 256 })));
  assert.equal(s256.songs, 256);
  assert.equal(s256.startSong, 256);
  assert.equal(subtunes(s256).length, 256);
  assert.equal(subtunes(s256)[0], 1);
  assert.equal(subtunes(s256)[255], 256);
  bad("bad_song_count", () => parseSidFile(patched(psid(), (_b, dv) => dv.setUint16(0x0e, 0))));
  bad("bad_song_count", () => parseSidFile(patched(psid(), (_b, dv) => dv.setUint16(0x0e, 257))));
  bad("bad_song_count", () => writeSidFile(psid({ songs: 0 })));
  bad("bad_song_count", () => writeSidFile(psid({ songs: 257 })));
  bad("bad_start_song", () => parseSidFile(patched(psid({ songs: 3 }), (_b, dv) => dv.setUint16(0x10, 4))));
  bad("bad_start_song", () => writeSidFile(psid({ songs: 3, startSong: 4 })));
  assert.equal(parseSidFile(writeSidFile(psid({ songs: 3, startSong: 3 }))).startSong, 3);
});

test("error: rsid_constraint", () => {
  bad("rsid_constraint", () => writeSidFile(rsid({ headerLoadAddress: 0x0800 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ playAddress: 0x0803 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ speed: 1 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ loadAddress: 0x07e7, initAddress: 0x07e7 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ initAddress: 0x07e8 }))); // below load image start 0x0800
  bad("rsid_constraint", () => writeSidFile(rsid({ initAddress: 0x0800 + PAYLOAD.length }))); // past image
  bad("rsid_constraint", () => writeSidFile(rsid({ loadAddress: 0xa000, initAddress: 0xa000 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ loadAddress: 0xd000, initAddress: 0xd000 })));
  bad("rsid_constraint", () => writeSidFile(rsid({ basic: true, initAddress: 0x0800 })));
  // header fields of a parsed file
  bad("rsid_constraint", () => parseSidFile(patched(rsid(), (_b, dv) => dv.setUint16(0x0c, 0x0803))));
  bad("rsid_constraint", () => parseSidFile(patched(rsid(), (_b, dv) => dv.setUint32(0x12, 1))));
  bad("rsid_constraint", () => parseSidFile(patched(rsid(), (_b, dv) => dv.setUint16(8, 0x0800))));
  // valid edge: $C000-$CFFF init, init 0 means load address, BASIC with init 0
  writeSidFile(rsid({ loadAddress: 0xc000, initAddress: 0xc000 }));
  writeSidFile(rsid({ loadAddress: 0x07e8, initAddress: 0 }));
  writeSidFile(rsid({ basic: true, initAddress: 0 }));
  writeSidFile(rsid({ loadAddress: 0x9ffa, initAddress: 0x9ffa }));
});

test("RSID BASIC flag decodes into basic, not psidSpecific", () => {
  const r = parseSidFile(writeSidFile(rsid({ basic: true, initAddress: 0 })));
  assert.equal(r.basic, true);
  assert.equal(r.psidSpecific, false);
  const p = parseSidFile(writeSidFile(psid({ psidSpecific: true })));
  assert.equal(p.psidSpecific, true);
  assert.equal(p.basic, false);
  bad("bad_field", () => writeSidFile(rsid({ psidSpecific: true })));
  bad("bad_field", () => writeSidFile(psid({ basic: true })));
});

test("SID address bytes: $D420/$D7E0/$DE00/$DFE0 valid, $D400/$D430 invalid", () => {
  for (const a of [0xd420, 0xd7e0, 0xde00, 0xdfe0, 0xd440]) {
    assert.equal(parseSidFile(writeSidFile(psid({ version: 3, secondSidAddress: a }))).secondSidAddress, a);
  }
  for (const a of [0xd400, 0xd430, 0xd410, 0xd800, 0xddf0, 0xdff0, 0xd421, 0xd7f0 + 0x10, 0xe000]) {
    bad("bad_sid_address", () => writeSidFile(psid({ version: 3, secondSidAddress: a })), `0x${a.toString(16)}`);
  }
  // 0xD7F0 is byte 0x7F: odd, therefore invalid
  bad("bad_sid_address", () => writeSidFile(psid({ version: 3, secondSidAddress: 0xd7f0 })));
  // Invalid header bytes mean "no SID" with a warning, the parse still succeeds.
  for (const byte of [0x41, 0x43, 0x80, 0xdf, 0xff]) {
    const p = parseSidFile(patched(psid({ version: 3 }), (b) => (b[0x7a] = byte)));
    assert.equal(p.secondSidAddress, undefined, `byte ${byte}`);
    assert.ok(p.warnings.some((w) => w.startsWith("bad_sid_address")));
  }
  assert.equal(parseSidFile(patched(psid({ version: 3 }), (b) => (b[0x7a] = 0x42))).secondSidAddress, 0xd420);
  assert.equal(parseSidFile(patched(psid({ version: 3 }), (b) => (b[0x7a] = 0xfe))).secondSidAddress, 0xdfe0);
  assert.deepEqual(parseSidFile(patched(psid({ version: 3 }), (b) => (b[0x7a] = 0))).warnings, []);
});

test("SID address version requirements and uniqueness", () => {
  bad("bad_sid_address", () => writeSidFile(psid({ version: 2, secondSidAddress: 0xd420 })));
  bad("bad_sid_address", () => writeSidFile(psid({ version: 3, secondSidAddress: 0xd420, thirdSidAddress: 0xd440 })));
  bad("bad_sid_address", () => writeSidFile(psid({ version: 4, secondSidAddress: 0xd420, thirdSidAddress: 0xd420 })));
  // Parsing is lenient: equal second and third addresses give a warning and the third SID is ignored.
  const same = parseSidFile(patched(psid({ version: 4 }), (b) => { b[0x7a] = 0x42; b[0x7b] = 0x42; }));
  assert.equal(same.secondSidAddress, 0xd420);
  assert.equal(same.thirdSidAddress, undefined);
  assert.deepEqual(same.warnings, ["bad_sid_address: third SID address equals the second and is ignored"]);
});

test("version < 3 ignores the second SID byte and version < 4 the third", () => {
  const v2 = parseSidFile(writeSidFile(psid({ version: 2, secondSidAddress: 0xd420 }), { strict: false }));
  assert.equal(v2.secondSidAddress, undefined);
  assert.deepEqual(v2.warnings, ["bad_sid_address: second SID byte $42 is ignored in version 2"]);
  const v3 = parseSidFile(patched(psid({ version: 3, secondSidAddress: 0xd420 }), (b) => (b[0x7b] = 0x44)));
  assert.equal(v3.secondSidAddress, 0xd420);
  assert.equal(v3.thirdSidAddress, undefined);
  assert.deepEqual(v3.warnings, ["bad_sid_address: third SID byte $44 is ignored in version 3"]);
  assert.deepEqual(parseSidFile(patched(psid({ version: 2 }), (b) => (b[0x7a] = 0))).warnings, []);
});

test("parse: startSong 0 is a warning and becomes 1; the writer still rejects it", () => {
  const p = parseSidFile(patched(psid(), (b, dv) => dv.setUint16(0x10, 0)));
  assert.equal(p.startSong, 1);
  assert.deepEqual(p.warnings, ["bad_start_song: startSong 0 is treated as 1"]);
  bad("bad_start_song", () => writeSidFile(psid({ startSong: 0 })));
});

test("parse: invalid relocation ranges are warnings and the range is ignored", () => {
  const a = parseSidFile(patched(psid(), (b) => { b[0x78] = 0; b[0x79] = 4; }));
  assert.equal(a.pageLength, 0);
  assert.deepEqual(a.warnings, ["bad_reloc: pageLength 4 with startPage $00 is ignored"]);
  const b2 = parseSidFile(patched(psid(), (b) => { b[0x78] = 0xff; b[0x79] = 1; }));
  assert.equal(b2.pageLength, 0);
  assert.deepEqual(b2.warnings, ["bad_reloc: pageLength 1 with startPage $FF is ignored"]);
  const c = parseSidFile(patched(psid(), (b) => { b[0x78] = 0xf0; b[0x79] = 0x20; }));
  assert.equal(c.pageLength, 0);
  assert.equal(c.startPage, 0xf0);
  assert.deepEqual(c.warnings, ["bad_reloc: relocation range $F0+32 pages runs past page $FF and is ignored"]);
});

test("songSpeed clamps songs above 32 to bit 31 for PSID v2 without the PlaySID flag", () => {
  const f = { version: 2, magic: "PSID", psidSpecific: false, speed: 0x80000000, songs: 40 };
  assert.equal(songSpeed(f, 40), "CIA");
  assert.equal(songSpeed({ ...f, psidSpecific: true }, 40), "VBI");
});

test("startPage / pageLength rules and load_overlap", () => {
  bad("bad_reloc", () => writeSidFile(psid({ startPage: 0, pageLength: 1 })));
  bad("bad_reloc", () => writeSidFile(psid({ startPage: 0xff, pageLength: 1 })));
  bad("bad_reloc", () => writeSidFile(psid({ startPage: 0xf0, pageLength: 0x20 })));
  writeSidFile(psid({ startPage: 0xff, pageLength: 0 }));
  writeSidFile(psid({ startPage: 0x20, pageLength: 8 }));
  // overlap with the load image $1000-$1006
  bad("load_overlap", () => writeSidFile(psid({ startPage: 0x0f, pageLength: 4 })));
  bad("load_overlap", () => writeSidFile(psid({ startPage: 0x10, pageLength: 1 })));
  writeSidFile(psid({ startPage: 0x11, pageLength: 1 })); // adjacent page: fine
  const p = parseSidFile(writeSidFile(psid({ startPage: 0x10, pageLength: 1 }), { strict: false }));
  assert.ok(p.warnings.some((w) => w.startsWith("load_overlap")));
  // RSID reserved memory
  bad("bad_reloc", () => writeSidFile(rsid({ startPage: 0x02, pageLength: 1 })));
  bad("bad_reloc", () => writeSidFile(rsid({ startPage: 0xa0, pageLength: 2 })));
  bad("bad_reloc", () => writeSidFile(rsid({ startPage: 0xcf, pageLength: 2 })));
  writeSidFile(rsid({ startPage: 0x20, pageLength: 4 }));
  writeSidFile(psid({ startPage: 0xa0, pageLength: 2 })); // PSID may use that range
});

test("error: too_large", () => {
  bad("too_large", () => parseSidFile(new Uint8Array(0x10000 + 0x7c + 3)));
  bad("too_large", () => parseSidFile(writeSidFile(psid()), { maxBytes: 10 }));
  bad("too_large", () => writeSidFile(psid({ loadAddress: 0xfff0, initAddress: 0xfff0, playAddress: 0, payload: new Uint8Array(0x11) })));
  writeSidFile(psid({ loadAddress: 0xfff0, initAddress: 0xfff0, playAddress: 0, payload: new Uint8Array(0x10) }));
  const full = writeSidFile(psid({ loadAddress: 0x0000, initAddress: 0x1000, payload: new Uint8Array(0x10000) }));
  assert.equal(full.length, 0x7c + 2 + 0x10000);
  assert.equal(parseSidFile(full).payload.length, 0x10000);
  // header says load $0002 but the data is a full 64K: overflows
  bad("too_large", () => parseSidFile(patched(psid({ loadAddress: 0x0000, initAddress: 0x1000, payload: new Uint8Array(0x10000) }), (b) => { b[0x7c] = 2; })));
});

test("error: bad_field", () => {
  bad("bad_field", () => writeSidFile(psid({ initAddress: 0x10000 })));
  bad("bad_field", () => writeSidFile(psid({ speed: -1 })));
  bad("bad_field", () => writeSidFile(psid({ startPage: 256 })));
  bad("bad_field", () => writeSidFile(psid({ headerLoadAddress: 0x2000 })));
  bad("bad_field", () => writeSidFile(psid({ clock: "SECAM" })));
  bad("bad_field", () => writeSidFile(psid({ version: 1, clock: "PAL" }))); // flags undefined in v1 (strict)
  const p = parseSidFile(writeSidFile(psid({ version: 2 }), { strict: false }));
  assert.equal(p.version, 2);
  // reserved flag bits are only a warning
  const w = parseSidFile(patched(psid(), (_b, dv) => dv.setUint16(0x76, 0x8000)));
  assert.ok(w.warnings.some((x) => x.startsWith("bad_field")));
});

test("speed field: song 1, 32 and bit 31 for song 33+", () => {
  const f = parseSidFile(writeSidFile(psid({ songs: 40, startSong: 1, speed: 0x80000001 })));
  assert.equal(songSpeed(f, 1), "CIA");
  assert.equal(songSpeed(f, 2), "VBI");
  assert.equal(songSpeed(f, 31), "VBI");
  assert.equal(songSpeed(f, 32), "CIA"); // bit 31
  assert.equal(songSpeed(f, 33), "CIA"); // v2NG, psidSpecific=0: bit 31 for every higher song
  assert.equal(songSpeed(f, 40), "CIA");
  const wrap = parseSidFile(writeSidFile(psid({ songs: 40, speed: 0x80000001, psidSpecific: true })));
  assert.equal(songSpeed(wrap, 33), "CIA"); // wraps to bit 0
  assert.equal(songSpeed(wrap, 34), "VBI"); // bit 1
  assert.equal(songSpeed(wrap, 32), "CIA");
  const v1 = parseSidFile(writeSidFile(psid({ version: 1, songs: 40, speed: 2 })));
  assert.equal(songSpeed(v1, 34), "CIA");
  assert.equal(songSpeed(v1, 33), "VBI");
  const low = parseSidFile(writeSidFile(psid({ songs: 40, speed: 0x7fffffff })));
  assert.equal(songSpeed(low, 40), "VBI");
  assert.throws(() => songSpeed(f, 0), RangeError);
  assert.throws(() => songSpeed(f, 41), RangeError);
});

test("Windows-1252 strings", () => {
  const s = "€ äöüß é ’ “” ™  ÿ ŒœŠŽ";
  const p = parseSidFile(writeSidFile(psid({ name: s, author: "Åke", released: "© 1985" })));
  assert.equal(p.name, s);
  assert.equal(p.author, "Åke");
  assert.equal(p.released, "© 1985");
  const raw = writeSidFile(psid({ name: "€™" }));
  assert.equal(raw[0x16], 0x80);
  assert.equal(raw[0x17], 0x99);
  assert.equal(raw[0x18], 0);
  bad("bad_string", () => writeSidFile(psid({ name: "中" })));
  bad("bad_string", () => writeSidFile(psid({ name: "\u{1f600}" })));
  bad("bad_string", () => writeSidFile(psid({ author: "a\0b" })));
  bad("bad_string", () => writeSidFile(psid({ released: "x".repeat(33) })));
  // exactly 32 bytes: no terminator needed
  const full = "y".repeat(32);
  assert.equal(parseSidFile(writeSidFile(psid({ name: full, author: full }))).name, full);
  // undefined cp1252 bytes round-trip as C1 controls
  const bytes = writeSidFile(psid());
  bytes[0x16] = 0x81;
  bytes[0x17] = 0;
  assert.equal(parseSidFile(bytes).name, "\u0081");
  assert.equal(writeSidFile(parseSidFile(bytes))[0x16], 0x81);
  // trailing NULs removed; garbage after the terminator is reported
  const g = writeSidFile(psid({ name: "AB" }));
  g[0x20] = 0x5a;
  const pg = parseSidFile(g);
  assert.equal(pg.name, "AB");
  assert.ok(pg.warnings.some((w) => w.startsWith("bad_string")));
});

test("input bytes are not retained or modified", () => {
  const b = writeSidFile(psid());
  const copy = b.slice();
  const p = parseSidFile(b);
  b.fill(0xee);
  assert.deepEqual([...p.payload], [...PAYLOAD]);
  const x = psid();
  writeSidFile(x);
  assert.deepEqual([...x.payload], [...PAYLOAD]);
  assert.equal(copy.length, 0x7c + 2 + PAYLOAD.length);
  // views with a byteOffset parse correctly
  const wrapped = new Uint8Array(copy.length + 5);
  wrapped.set(copy, 5);
  assert.equal(parseSidFile(wrapped.subarray(5)).loadAddress, 0x1000);
});

test("committed fixtures parse to known values", () => {
  const dir = path.join(here, "fixtures", "sidfile");
  const read = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));
  const a = parseSidFile(read("psid_v2_basic.sid"));
  assert.equal(a.magic, "PSID");
  assert.equal(a.version, 2);
  assert.equal(a.name, "Fixture ä");
  assert.equal(a.loadAddress, 0x1000);
  assert.equal(a.songs, 2);
  assert.equal(a.clock, "PAL");
  const b = parseSidFile(read("rsid_v4_basic_flag.sid"));
  assert.equal(b.magic, "RSID");
  assert.equal(b.basic, true);
  assert.equal(b.secondSidAddress, 0xd420);
  assert.equal(b.thirdSidAddress, 0xdfe0);
  const c = parseSidFile(read("psid_v1.sid"));
  assert.equal(c.version, 1);
  assert.equal(c.dataOffset, 0x76);
  for (const n of ["psid_v2_basic.sid", "rsid_v4_basic_flag.sid", "psid_v1.sid"]) {
    assert.equal(Buffer.compare(Buffer.from(writeSidFile(parseSidFile(read(n)))), Buffer.from(read(n))), 0, n);
  }
});

test("md5ForSonglengths is the MD5 of the whole file", () => {
  assert.equal(md5ForSonglengths(new Uint8Array(0)), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5ForSonglengths(new TextEncoder().encode("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

const hvscPresent = fs.existsSync(HVSC) && fs.statSync(HVSC).isDirectory();
function listSid(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listSid(p, out);
    else if (e.name.toLowerCase().endsWith(".sid")) out.push(p);
  }
  return out;
}

test("HVSC corpus: parse and rewrite a deterministic sample of 500 files", { skip: hvscPresent ? false : `HVSC not found at ${HVSC}` }, () => {
  const all = listSid(HVSC).sort();
  const step = Math.max(1, Math.floor(all.length / 500));
  const sample = all.filter((_, i) => i % step === 0).slice(0, 500);
  assert.ok(sample.length >= 100, "sample too small");
  const failures = [];
  let canonical = 0;
  const noncanonical = [];
  let withWarnings = 0;
  for (const file of sample) {
    if (!fs.existsSync(file)) continue;
    const bytes = new Uint8Array(fs.readFileSync(file));
    let parsed;
    try {
      parsed = parseSidFile(bytes);
    } catch (e) {
      failures.push(`${file}: ${e.code ?? e.name} ${e.message}`);
      continue;
    }
    if (parsed.warnings.length) withWarnings++;
    const out = writeSidFile(parsed, { strict: false });
    if (Buffer.compare(Buffer.from(out), Buffer.from(bytes)) === 0) canonical++;
    else noncanonical.push(file);
    // Second generation is always stable, canonical or not.
    assert.deepEqual(norm(parseSidFile(out)), norm({ ...parsed, warnings: [] }), file);
  }
  console.log(`sidFile corpus: ${sample.length} sampled (of ${all.length}), ${failures.length} parse failures, ${canonical} canonical, ${noncanonical.length} non-canonical, ${withWarnings} with warnings`);
  assert.deepEqual(failures, []);
  for (const f of noncanonical) {
    // Non-canonical means the header carries something the model drops (reserved bits, invalid SID bytes, bytes after a string terminator).
    if (!fs.existsSync(f)) continue;
    const p = parseSidFile(new Uint8Array(fs.readFileSync(f)));
    assert.ok(p.warnings.length > 0, `${f} differs after rewrite without any warning`);
  }
});
