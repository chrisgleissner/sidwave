import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { HvscError } from "../src/hvsc.ts";
import { SidFileError, writeSidFile } from "../src/sidFile.ts";
import {
  identifyPlayerInData, identifySidPlayer, loadSidIdSignatures, matchSignature, parseSidIdConfig, parseSidIdInfo,
} from "../src/sidId.ts";

const CFG = [
  "Alpha",
  "A9 00 8D ?? ?? 4C END",
  "A9 1F 8D 18 D4 AND 8D 04 D4 END",
  "",
  "Group/Beta",
  "12 34 56 78 9A BC DE F0 11 22 33 44 55 66 77 88 END",
  "Gamma",
  "20 ?? ?? END",
  "",
].join("\r\n");

const bytes = (...list) => Uint8Array.from(list);

test("parseSidIdConfig reads players, wildcards, AND fragments and END", () => {
  const db = parseSidIdConfig(CFG);
  assert.deepEqual(db.players.map((p) => p.name), ["Alpha", "Group/Beta", "Gamma"]);
  assert.equal(db.signatures, 4);
  const second = db.players[0].signatures[1];
  assert.equal(second.fragments.length, 2);
  assert.deepEqual([...second.fragments[0]], [0xa9, 0x1f, 0x8d, 0x18, 0xd4]);
  assert.equal(second.fixedBytes, 8);
  assert.deepEqual([...db.players[0].signatures[0].fragments[0]], [0xa9, 0x00, 0x8d, -1, -1, 0x4c]);
  // A signature of wildcards only, and one without a player, are dropped.
  assert.equal(parseSidIdConfig("X\n?? ?? END\n").signatures, 0);
  assert.equal(parseSidIdConfig("A9 00 END\n").signatures, 0);
});

test("the newer file format has one signature per line, '&&' between fragments and no END", () => {
  const db = parseSidIdConfig("Player\nA9 01 && 8D 04 D4\n4C ?? ??\n");
  assert.equal(db.players[0].signatures.length, 2);
  assert.equal(db.players[0].signatures[0].fragments.length, 2);
  assert.equal(db.players[0].signatures[1].fixedBytes, 1);
});

test("matching: fragments in order, wildcards, no overlap, first fragment offset", () => {
  const db = parseSidIdConfig(CFG);
  const [alpha, beta] = db.players;
  const data = bytes(0x00, 0x00, 0xa9, 0x00, 0x8d, 0x12, 0x34, 0x4c, 0x01);
  assert.equal(matchSignature(data, alpha.signatures[0]), 2);
  // AND: both fragments must be present, the second after the first.
  assert.equal(matchSignature(bytes(0xa9, 0x1f, 0x8d, 0x18, 0xd4, 0x00, 0x8d, 0x04, 0xd4), alpha.signatures[1]), 0);
  assert.equal(matchSignature(bytes(0x8d, 0x04, 0xd4, 0xa9, 0x1f, 0x8d, 0x18, 0xd4), alpha.signatures[1]), -1);
  assert.equal(matchSignature(bytes(0xa9, 0x1f, 0x8d, 0x18, 0xd4), alpha.signatures[1]), -1);
  // The second fragment may not overlap the end of the first.
  assert.equal(matchSignature(bytes(0xa9, 0x1f, 0x8d, 0x18, 0xd4, 0x04, 0xd4), alpha.signatures[1]), -1);
  assert.equal(matchSignature(bytes(0x12, 0x34, 0x56), beta.signatures[0]), -1);
  assert.equal(matchSignature(bytes(0x01, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88), beta.signatures[0]), 1);
  // A fragment that starts too late to fit is not a match, and the end of the data is respected.
  assert.equal(matchSignature(bytes(0x20, 0x01), db.players[2].signatures[0]), -1);
  assert.equal(matchSignature(bytes(0x20, 0x01, 0x02), db.players[2].signatures[0]), 0);
});

test("identifyPlayerInData: first match in file order, all matches, address and confidence", () => {
  const db = parseSidIdConfig(CFG);
  const data = bytes(0x20, 0x00, 0x00, 0xa9, 0x00, 0x8d, 0x00, 0x00, 0x4c, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88);
  const first = identifyPlayerInData(data, db, { loadAddress: 0x1000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].player, "Alpha");
  assert.equal(first[0].offset, 3);
  assert.equal(first[0].address, 0x1003);
  assert.equal(first[0].fixedBytes, 4);
  assert.equal(first[0].confidence, "low");
  const all = identifyPlayerInData(data, db, { all: true, loadAddress: 0x1000 });
  assert.deepEqual(all.map((m) => m.player), ["Alpha", "Group/Beta", "Gamma"]);
  assert.equal(all[1].fixedBytes, 16);
  assert.equal(all[1].confidence, "high");
  assert.deepEqual(identifyPlayerInData(bytes(1, 2, 3), db), []);
});

test("confidence: 14 or more fixed bytes is high, 8 to 13 medium, fewer low, and a second matching signature raises it a step", () => {
  const db = parseSidIdConfig([
    "Low", "01 02 03 04 05 06 07 END",
    "Medium", "01 02 03 04 05 06 07 08 END",
    "High", "01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E END",
    "Two", "01 02 03 04 05 06 07 END", "05 06 07 08 09 0A 0B END", "",
  ].join("\n"));
  const data = bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
  const levels = Object.fromEntries(identifyPlayerInData(data, db, { all: true }).map((m) => [m.player, m.confidence]));
  assert.deepEqual(levels, { Low: "low", Medium: "medium", High: "high", Two: "medium" });
});

test("sidid.nfo: names, authors and continued comments", () => {
  const nfo = parseSidIdInfo("Alpha\r\n     NAME: Alpha Player\r\n   AUTHOR: Somebody\r\n  COMMENT: first\r\n           second\r\n\r\nBeta\r\n   AUTHOR: Other\r\nREFERENCE: nope\r\n");
  assert.equal(nfo.get("Alpha").name, "Alpha Player");
  assert.equal(nfo.get("Alpha").comment, "first\nsecond");
  assert.equal(nfo.get("Beta").author, "Other");
  const db = parseSidIdConfig(CFG);
  const match = identifyPlayerInData(bytes(0xa9, 0x00, 0x8d, 0x00, 0x00, 0x4c), db, { info: nfo })[0];
  assert.equal(match.info.name, "Alpha Player");
});

test("identifySidPlayer matches the data of a SID file, not its header", () => {
  const db = parseSidIdConfig("InHeader\n53 49 44 END\nInData\nA9 00 8D ?? ?? 4C END\n".replace("53 49 44", "50 53 49 44 00 02"));
  const file = writeSidFile({ magic: "PSID", version: 2, loadAddress: 0x2000, initAddress: 0x2000, playAddress: 0x2003, songs: 1, startSong: 1, speed: 0, name: "n", author: "a", released: "r", payload: bytes(0x60, 0xa9, 0x00, 0x8d, 0x18, 0xd4, 0x4c, 0x00, 0x20) });
  const matches = identifySidPlayer(file, db, { all: true });
  assert.deepEqual(matches.map((m) => m.player), ["InData"]);
  assert.equal(matches[0].address, 0x2001);
  assert.throws(() => identifySidPlayer(new Uint8Array(10), db), (e) => e instanceof SidFileError);
});

test("loadSidIdSignatures refuses a file without signatures and a file that is too large", () => {
  assert.throws(() => loadSidIdSignatures(Buffer.from("just text\n")), (e) => e instanceof HvscError && /holds no signature/.test(e.message));
  assert.throws(() => parseSidIdConfig("x".repeat(100), { maxBytes: 10 }), (e) => e instanceof HvscError && e.code === "too_large");
  assert.throws(() => parseSidIdConfig(`P\n${"AA ".repeat(5000)}END\n`), (e) => e instanceof HvscError && e.code === "bad_format");
  assert.equal(loadSidIdSignatures(Buffer.from(CFG, "latin1"), Buffer.from("Alpha\n   NAME: A\n", "latin1")).info.get("Alpha").name, "A");
});

test("fuzz: 1000 random signature files and data never throw an untyped error", () => {
  let seed = 31337;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const tokens = ["A9", "00", "??", "AND", "&&", "END", "Name", "4C", "zz", "8D", "D4", "\n", "\n", "\r\n", " "];
  for (let i = 0; i < 1000; i++) {
    let text = "";
    for (let k = Math.floor(rnd() * 40); k > 0; k--) text += pick(tokens) + " ";
    const data = new Uint8Array(Math.floor(rnd() * 64)).map(() => pick([0xa9, 0x00, 0x8d, 0x4c, 0xd4, 0x12]));
    try {
      const db = parseSidIdConfig(text);
      identifyPlayerInData(data, db, { all: true });
    } catch (error) {
      assert.ok(error instanceof HvscError, `untyped: ${error && error.stack}`);
    }
  }
});

const REAL_CFG = process.env.SIDID_CFG ?? "/home/chris/dev/c64/sid/deepsid/utility/sidid_100/sidid.cfg";
const HVSC = process.env.HVSC_ROOT ?? process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const COMMANDO = path.join(HVSC, "MUSICIANS/H/Hubbard_Rob/Commando.sid");
test("a real sidid.cfg identifies Rob Hubbard's player in Commando (local only)", { skip: fs.existsSync(REAL_CFG) && fs.existsSync(COMMANDO) ? false : "no sidid.cfg or HVSC here" }, () => {
  const { db } = loadSidIdSignatures(fs.readFileSync(REAL_CFG));
  assert.ok(db.players.length > 500);
  const matches = identifySidPlayer(new Uint8Array(fs.readFileSync(COMMANDO)), db);
  assert.equal(matches[0].player, "Rob_Hubbard");
});
