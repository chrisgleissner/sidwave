import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { md5ForSonglengths, parseSidFile } from "../src/sidFile.js";
import {
  SonglengthsError, parseDuration, parseSonglengths, parseSonglengthsWithPaths, lookupSonglength,
} from "../src/songlengths.js";

const HVSC = "/home/chris/dev/c64/C64Music";
const DB = path.join(HVSC, "DOCUMENTS", "Songlengths.md5");
const A = "5f08a730b280e54fd1e75a7046b93fdc";
const B = "2727236ead44a62f0c6e01f6dd4dc484";

test("parseDuration formats", () => {
  assert.equal(parseDuration("1:17"), 77000);
  assert.equal(parseDuration("0:56"), 56000);
  assert.equal(parseDuration("4:33.108"), 273108);
  assert.equal(parseDuration("0:40.9"), 40900);
  assert.equal(parseDuration("10:07"), 607000);
  assert.equal(parseDuration("1:02:03.5"), 3723500);
  assert.equal(parseDuration("2:05(G)"), 125000);
  assert.equal(parseDuration("2:05.250(G)"), 125250);
  assert.equal(parseDuration("abc"), undefined);
  assert.equal(parseDuration("1:2x"), undefined);
});

test("parseSonglengths: comments, CRLF, multiple subtunes, attributes", () => {
  const text = `[Database]\r\n; /DEMOS/0-9/10_Orbyte.sid\r\n${A}=1:17\r\n; /X/Y.sid\n${B}=0:56 1:00.500 2:03(G) 3:04.001(M)\n\nnot-an-entry=1\n`;
  const db = parseSonglengths(text);
  assert.equal(db.size, 2);
  assert.deepEqual(db.get(A), [77000]);
  assert.deepEqual(db.get(B), [56000, 60500, 123000, 184001]);
  const { paths } = parseSonglengthsWithPaths(text);
  assert.equal(paths.get(A), "/DEMOS/0-9/10_Orbyte.sid");
  assert.equal(paths.get(B), "/X/Y.sid");
  assert.equal(parseSonglengths(`${A.toUpperCase()}=0:01`).get(A)?.[0], 1000);
});

test("parseSonglengths errors", () => {
  assert.throws(() => parseSonglengths(`${A}=1:xx`), (e) => e instanceof SonglengthsError && e.code === "bad_line");
  assert.throws(() => parseSonglengths(`${A}=1:17`, { maxBytes: 10 }), (e) => e instanceof SonglengthsError && e.code === "too_large");
  assert.throws(() => parseSonglengths("ä".repeat(8), { maxBytes: 10 }), (e) => e.code === "too_large"); // bytes, not chars
  assert.equal(parseSonglengths("").size, 0);
});

test("lookupSonglength uses the MD5 of the file bytes", () => {
  const bytes = new TextEncoder().encode("abc");
  const md5 = md5ForSonglengths(bytes);
  const db = parseSonglengths(`${md5}=0:10 0:20.5`);
  assert.equal(lookupSonglength(db, bytes, 1), 10000);
  assert.equal(lookupSonglength(db, bytes, 2), 20500);
  assert.equal(lookupSonglength(db, bytes, 3), undefined);
  assert.equal(lookupSonglength(db, bytes, 0), undefined);
  assert.equal(lookupSonglength(db, new Uint8Array(1), 1), undefined);
});

const present = fs.existsSync(DB);
test("real Songlengths.md5: MD5 of sampled tunes matches the path comment", { skip: present ? false : `Songlengths.md5 not found at ${DB}` }, () => {
  const text = fs.readFileSync(DB, "latin1");
  const { db, paths } = parseSonglengthsWithPaths(text);
  assert.ok(db.size > 50000, `db size ${db.size}`);
  const entries = [...paths.entries()];
  assert.ok(entries.length > 50000);
  let checked = 0;
  const mismatches = [];
  for (let i = 0; i < entries.length && checked < 200; i += Math.floor(entries.length / 200)) {
    const [md5, p] = entries[i];
    const file = path.join(HVSC, p);
    if (!fs.existsSync(file)) continue;
    const bytes = new Uint8Array(fs.readFileSync(file));
    checked++;
    if (md5ForSonglengths(bytes) !== md5) mismatches.push(p);
  }
  console.log(`songlengths: ${checked} files checked, ${mismatches.length} mismatches, ${db.size} entries`);
  assert.ok(checked >= 100, `only ${checked} files found`);
  assert.deepEqual(mismatches, []);
  // Three named tunes from the head of the database.
  for (const [md5, p] of entries.slice(0, 3)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(HVSC, p)));
    assert.equal(md5ForSonglengths(bytes), md5, p);
    const sid = parseSidFile(bytes);
    const lens = db.get(md5);
    assert.ok(lens.length >= 1 && lens.length <= sid.songs, `${p}: ${lens.length} lengths for ${sid.songs} songs`);
    assert.equal(lookupSonglength(db, bytes, 1), lens[0]);
  }
});
