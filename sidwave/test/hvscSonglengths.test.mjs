import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HvscError } from "../src/hvsc.ts";
import { md5ForSonglengths, writeSidFile } from "../src/sidFile.ts";
import {
  SonglengthsError, legacyMd5ForSonglengths, parseDuration, parseSonglengths, parseSonglengthsWithPaths, scanSonglengths,
} from "../src/songlengths.ts";
import {
  formatSonglength, lookupSonglengthEntries, parseSonglengthList, songlengthsFormatOf, songlengthsKey, verifySonglengths, writeSonglengthsEntry,
} from "../src/songlengthsFile.ts";

const HVSC = process.env.HVSC_ROOT ?? process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const DB = path.join(HVSC, "DOCUMENTS", "Songlengths.md5");
const present = fs.existsSync(DB);
const A = "5f08a730b280e54fd1e75a7046b93fdc";
const B = "2727236ead44a62f0c6e01f6dd4dc484";
const C = "c7c299ce06ec5ccffb2261fb11b42a73";
const cpuMs = (fn) => { const before = process.cpuUsage(); const value = fn(); const used = process.cpuUsage(before); return { ms: (used.user + used.system) / 1000, value }; };

function sid(over = {}) {
  return writeSidFile({
    magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 2, startSong: 1, speed: 0b10,
    name: "N", author: "A", released: "R", payload: Uint8Array.from([0x4c, 0x08, 0x10, 0x4c, 0x0b, 0x10, 0x60, 0x60]), ...over,
  });
}

test("the scanner accepts exactly the durations of parseDuration (1000 random tokens)", () => {
  let seed = 99;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const alphabet = "0123456789012345678901234567890123456789::..(()GMZB)x";
  let accepted = 0;
  for (let i = 0; i < 1000; i++) {
    let token = "";
    const length = 1 + Math.floor(rnd() * 12);
    for (let k = 0; k < length; k++) token += alphabet[Math.floor(rnd() * alphabet.length)];
    // Bias a share of the tokens towards the real grammar.
    if (i % 3 === 0) token = `${Math.floor(rnd() * 100)}:${String(Math.floor(rnd() * 100)).padStart(rnd() < 0.8 ? 2 : 1, "0")}${rnd() < 0.5 ? `.${Math.floor(rnd() * 10000)}` : ""}${rnd() < 0.3 ? "(G)" : ""}`;
    const expected = parseDuration(token);
    const text = `${A}=${token}`;
    if (expected === undefined) assert.throws(() => parseSonglengths(text), (e) => e instanceof SonglengthsError && e.code === "bad_line", token);
    else { assert.deepEqual(parseSonglengths(text).get(A), [expected], token); accepted++; }
  }
  assert.ok(accepted > 100, `accepted ${accepted}`);
});

test("the scanner reports offsets, line numbers and the comment line above an entry", () => {
  const text = `[Database]\r\n; /X/One.sid\r\n${A}=0:10\r\n; Songlengths 2026\r\n; /X/Two.sid\r\n${B}=0:20 0:30\r\n${C}=1:00\r\n`;
  const entries = [];
  scanSonglengths(text, (e) => entries.push(e));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, "/X/One.sid");
  assert.equal(entries[0].line, 3);
  assert.equal(text.slice(entries[0].lineStart, entries[0].lineEnd), `${A}=0:10`);
  assert.equal(text.slice(entries[0].valueStart, entries[0].lineEnd), "0:10");
  assert.equal(text.slice(entries[0].commentStart, entries[0].commentStart + 6), "; /X/O");
  assert.equal(entries[1].commentStart, text.indexOf("; /X/Two.sid"));
  assert.equal(entries[2].commentStart, -1);
  assert.equal(entries[2].path, "/X/Two.sid");
  assert.throws(() => scanSonglengths(`${A}=0:10`, () => {}, { maxBytes: 5 }), (e) => e.code === "too_large");
});

test("formatting and parsing of song lengths", () => {
  assert.equal(formatSonglength(77000), "1:17");
  assert.equal(formatSonglength(273108), "4:33.108");
  assert.equal(formatSonglength(166930), "2:46.93");
  assert.equal(formatSonglength(60500), "1:00.5");
  assert.equal(formatSonglength(90400, "txt"), "1:30");
  assert.equal(formatSonglength(90600, "txt"), "1:31");
  assert.equal(formatSonglength(0), "0:00");
  assert.equal(formatSonglength(3_600_000), "60:00");
  assert.throws(() => formatSonglength(-1), HvscError);
  assert.deepEqual(parseSonglengthList("3:57,1:02.5 90 237.5"), [237000, 62500, 90000, 237500]);
  assert.throws(() => parseSonglengthList(""), (e) => e instanceof HvscError && /one time per subtune/.test(e.message));
  assert.throws(() => parseSonglengthList("1:xx"), (e) => e instanceof HvscError && /not a song length/.test(e.message));
  assert.equal(songlengthsFormatOf("x/Songlengths.TXT"), "txt");
  assert.equal(songlengthsFormatOf("x/Songlengths.md5"), "md5");
});

test("the legacy key follows the FAQ: data, init, play, songs, speed bytes, NTSC marker", () => {
  const bytes = sid({ songs: 2, speed: 0b10 });
  const hash = createHash("md5");
  hash.update(Uint8Array.from([0x4c, 0x08, 0x10, 0x4c, 0x0b, 0x10, 0x60, 0x60]));
  hash.update(Uint8Array.from([0x00, 0x10, 0x03, 0x10, 0x02, 0x00, 0, 60]));
  assert.equal(legacyMd5ForSonglengths(bytes), hash.digest("hex"));
  const ntsc = sid({ songs: 2, speed: 0b10, clock: "NTSC" });
  const h2 = createHash("md5");
  h2.update(Uint8Array.from([0x4c, 0x08, 0x10, 0x4c, 0x0b, 0x10, 0x60, 0x60]));
  h2.update(Uint8Array.from([0x00, 0x10, 0x03, 0x10, 0x02, 0x00, 0, 60, 2]));
  assert.equal(legacyMd5ForSonglengths(ntsc), h2.digest("hex"));
  assert.equal(songlengthsKey(bytes, "md5"), md5ForSonglengths(bytes));
  assert.equal(songlengthsKey(bytes, "txt"), legacyMd5ForSonglengths(bytes));
});

test("lookup finds every entry of a key", () => {
  const text = `[Database]\n; /A/One.sid\n${A}=0:10\n; /B/Two.sid\n${A}=0:10\n`;
  const found = lookupSonglengthEntries(text, A.toUpperCase());
  assert.deepEqual(found.map((e) => e.path), ["/A/One.sid", "/B/Two.sid"]);
  assert.deepEqual(lookupSonglengthEntries(text, B), []);
});

const DB_TEXT = `[Database]\r\n; /A/One.sid\r\n${A}=0:10\r\n; /C/Three.sid\r\n${C}=4:33.108 1:00\r\n`;

test("write: new durations replace the value in place and nothing else changes", () => {
  const result = writeSonglengthsEntry(DB_TEXT, { md5: C, durations: [60000, 61500] });
  assert.equal(result.action, "updated");
  assert.equal(result.text, DB_TEXT.replace("4:33.108 1:00", "1:00 1:01.5"));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].line, 5);
  assert.equal(writeSonglengthsEntry(DB_TEXT, { md5: C, durations: [273108, 60000] }).action, "unchanged");
});

test("write: a new entry is inserted in path order with the line break style of the file", () => {
  const added = writeSonglengthsEntry(DB_TEXT, { md5: B, durations: [56000], path: "/B/Two.sid" });
  assert.equal(added.action, "added");
  assert.equal(added.text, `[Database]\r\n; /A/One.sid\r\n${A}=0:10\r\n; /B/Two.sid\r\n${B}=0:56\r\n; /C/Three.sid\r\n${C}=4:33.108 1:00\r\n`);
  const last = writeSonglengthsEntry(DB_TEXT, { md5: B, durations: [56000], path: "/Z/Last.sid" });
  assert.equal(last.text, `${DB_TEXT}; /Z/Last.sid\r\n${B}=0:56\r\n`);
  const noEol = writeSonglengthsEntry(`[Database]\n; /A/One.sid\n${A}=0:10`, { md5: B, durations: [1000], path: "/B/Two.sid" });
  assert.equal(noEol.text, `[Database]\n; /A/One.sid\n${A}=0:10\n; /B/Two.sid\n${B}=0:01\n`);
  assert.equal(writeSonglengthsEntry("", { md5: B, durations: [1000], path: "/B/Two.sid" }).text, `; /B/Two.sid\n${B}=0:01\n`);
});

test("write: a changed file is re-keyed by its old key or by its path, keeping the comment line", () => {
  const NEW = "11111111111111111111111111111111";
  const byOld = writeSonglengthsEntry(DB_TEXT, { md5: NEW, fromMd5: C });
  assert.equal(byOld.action, "rekeyed");
  assert.equal(byOld.text, DB_TEXT.replace(C, NEW));
  const withTimes = writeSonglengthsEntry(DB_TEXT, { md5: NEW, fromMd5: C, durations: [1000, 2000] });
  assert.equal(withTimes.text, DB_TEXT.replace(`${C}=4:33.108 1:00`, `${NEW}=0:01 0:02`));
  const byPath = writeSonglengthsEntry(DB_TEXT, { md5: NEW, path: "/C/Three.sid", durations: [5000, 6000] });
  assert.equal(byPath.action, "rekeyed");
  assert.equal(byPath.text, DB_TEXT.replace(`${C}=4:33.108 1:00`, `${NEW}=0:05 0:06`));
});

test("write: the old format rounds to seconds and keeps the attributes of a subtune", () => {
  const text = `[Database]\n; /A/One.sid\n${A}=3:57 1:02 0:06(G) 0:02(G)\n`;
  const result = writeSonglengthsEntry(text, { md5: A, durations: [237400, 62000, 6400, 2600] }, "txt");
  assert.equal(result.text, `[Database]\n; /A/One.sid\n${A}=3:57 1:02 0:06(G) 0:03(G)\n`);
  const shorter = writeSonglengthsEntry(text, { md5: A, durations: [237000, 62000] }, "txt");
  assert.equal(shorter.text, `[Database]\n; /A/One.sid\n${A}=3:57 1:02\n`);
});

test("write: errors say what is missing", () => {
  const error = (write, pattern) => assert.throws(() => writeSonglengthsEntry(DB_TEXT, write), (e) => e instanceof HvscError && pattern.test(e.message), JSON.stringify(write));
  error({ md5: "xyz" }, /not a 32 digit MD5/);
  error({ md5: B }, /give the HVSC path/);
  error({ md5: B, path: "/B/Two.sid" }, /needs its song lengths/);
  error({ md5: A }, /already listed; give --times/);
  error({ md5: B, fromMd5: "2".repeat(32), durations: [1000] }, /no entry with the MD5/);
  error({ md5: B, path: "B/Two.sid", durations: [1000] }, /must start with/);
  error({ md5: B, path: "/B", durations: [] }, /1 to 256 durations/);
});

test("write: every other byte of a real Songlengths.md5 stays", { skip: present ? false : `no database at ${DB}` }, () => {
  const text = fs.readFileSync(DB, "latin1");
  const key = "6d019ecba831a9f853675aac29a61c10";
  const edited = writeSonglengthsEntry(text, { md5: key, durations: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000] });
  assert.equal(edited.action, "updated");
  const before = text.split("\r\n");
  const after = edited.text.split("\r\n");
  assert.equal(after.length, before.length);
  const differing = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing.push(i);
  assert.equal(differing.length, 1);
  assert.ok(before[differing[0]].startsWith(key));
  const added = writeSonglengthsEntry(text, { md5: "0".repeat(32), durations: [90000], path: "/MUSICIANS/H/Hubbard_Rob/Commando_Zero.sid" });
  const addedLines = added.text.split("\r\n");
  assert.equal(addedLines.length, before.length + 2);
  const at = addedLines.indexOf("; /MUSICIANS/H/Hubbard_Rob/Commando_Zero.sid");
  assert.ok(at > 0);
  assert.deepEqual([...addedLines.slice(0, at), ...addedLines.slice(at + 2)], before);
  assert.ok(addedLines[at - 1] === "" || addedLines[at - 2].startsWith("; /MUSICIANS/H/Hubbard_Rob/") || addedLines[at - 1].includes("="), "inserted after an entry of the same area");
});

test("verify: missing files, wrong keys, subtune mismatches, unlisted files and entries without path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-verify-sl-"));
  try {
    const put = (rel, bytes) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return bytes; };
    const good = put("MUSICIANS/A/Good.sid", sid({ songs: 2 }));
    put("MUSICIANS/A/Changed.sid", sid({ songs: 2, author: "changed" }));
    const mismatch = put("MUSICIANS/A/Mismatch.sid", sid({ songs: 3, name: "M" }));
    put("MUSICIANS/A/Unlisted.sid", sid({ songs: 2, name: "U" }));
    put("MUSICIANS/A/Broken.sid", Buffer.from("not a sid"));
    const k = (b) => md5ForSonglengths(b);
    const text = [
      "[Database]",
      "; /MUSICIANS/A/Good.sid", `${k(good)}=0:10 0:20`,
      "; /MUSICIANS/A/Changed.sid", `${k(sid({ songs: 2, author: "old" }))}=0:10 0:20`,
      "; /MUSICIANS/A/Mismatch.sid", `${k(mismatch)}=0:10 0:20`,
      "; /MUSICIANS/A/Gone.sid", `${"a".repeat(32)}=0:10`,
      "; /MUSICIANS/A/Broken.sid", `${"b".repeat(32)}=0:10`,
      `${"c".repeat(32)}=0:01`, "",
    ].join("\r\n");
    // The last entry has the path comment of the one above it; give it a break so that it has none.
    const withoutPath = text.replace(`${"c".repeat(32)}`, `; Songlengths note\r\n${"c".repeat(32)}`);
    const report = verifySonglengths(withoutPath, root, { unlisted: true });
    assert.equal(report.entries, 6);
    assert.equal(report.ok, 1);
    assert.deepEqual(report.missing.map((m) => m.path), ["/MUSICIANS/A/Gone.sid"]);
    assert.deepEqual(report.wrongMd5.map((w) => w.path), ["/MUSICIANS/A/Changed.sid", "/MUSICIANS/A/Broken.sid"]);
    assert.equal(report.wrongMd5[0].actual, k(sid({ songs: 2, author: "changed" })));
    assert.deepEqual(report.subtuneMismatch.map((m) => [m.path, m.songs, m.durations]), [["/MUSICIANS/A/Mismatch.sid", 3, 2]]);
    assert.equal(report.noPath.length, 1);
    assert.deepEqual(report.unlistedFiles.sort(), ["/MUSICIANS/A/Unlisted.sid"]);
    // In the old format the key needs a valid header, so a file that does not parse is unreadable.
    const oldFormat = verifySonglengths(`; /MUSICIANS/A/Broken.sid\n${"b".repeat(32)}=0:10\n`, root, { format: "txt" });
    assert.equal(oldFormat.unreadable.length, 1);
    assert.equal(oldFormat.wrongMd5.length, 0);
    const legacy = verifySonglengths(`; /MUSICIANS/A/Good.sid\n${legacyMd5ForSonglengths(good)}=0:10 0:20\n`, root, { format: "txt" });
    assert.equal(legacy.ok, 1);
    assert.throws(() => verifySonglengths("; /../x.sid\n" + `${"d".repeat(32)}=0:01\n`, root), (e) => e instanceof HvscError && /must not contain/.test(e.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fuzz: 1000 random database texts and writes end in a result or a typed error", () => {
  let seed = 4242;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const lines = [() => "[Database]", () => `; /${pick(["A", "B/C", "D"])}/${pick(["x", "Y", "z"])}.sid`, () => `${pick([A, B, C, "g".repeat(32), A.toUpperCase()])}=${pick(["0:10", "1:02.5 0:03", "", "0:10 0:20", "0:10(G) 0:20(M)", "3:57", "x", "1:2:3:4", "0:10(G) 0:20(", "99999999999:00"])}`,
    () => "; comment", () => "", () => "\ud800=0:01", () => "=", () => `${A}`];
  let typed = 0;
  let fine = 0;
  for (let i = 0; i < 1000; i++) {
    let text = "";
    const count = Math.floor(rnd() * 8);
    for (let k = 0; k < count; k++) text += pick(lines)() + pick(["\n", "\r\n", "", "\n"]);
    try {
      parseSonglengthsWithPaths(text);
      const write = { md5: pick([A, B, "x", C]), durations: pick([undefined, [1000], [], [5, 6]]), path: pick([undefined, "/A/x.sid", "bad", "/B/C/Y.sid"]), fromMd5: pick([undefined, A, "zz"]) };
      const result = writeSonglengthsEntry(text, write, pick(["md5", "txt"]));
      assert.equal(typeof result.text, "string");
      fine++;
    } catch (error) {
      assert.ok(error instanceof SonglengthsError || error instanceof HvscError, `untyped: ${error && error.stack}\n${JSON.stringify(text)}`);
      typed++;
    }
  }
  assert.ok(fine > 30 && typed > 30, `fine ${fine}, typed ${typed}`);
});

test("real Songlengths.md5: parses in under 250 ms CPU and a lookup takes under 1 ms", { skip: present ? false : `no database at ${DB}` }, () => {
  const text = fs.readFileSync(DB, "latin1");
  const first = cpuMs(() => parseSonglengths(text));
  // The first run includes JIT warm-up of the engine; the limit applies to the smaller of three runs so that a busy
  // machine does not fail the test, and the first run is printed.
  const best = Math.min(first.ms, cpuMs(() => parseSonglengths(text)).ms, cpuMs(() => parseSonglengths(text)).ms);
  console.log(`Songlengths.md5 parse: first run ${first.ms.toFixed(0)} ms CPU, best of three ${best.toFixed(0)} ms, ${first.value.size} entries, ${text.split("\n").length} lines`);
  assert.ok(first.value.size > 50000);
  assert.ok(best < 250, `parse took ${best.toFixed(0)} ms CPU`);
  const bytes = new Uint8Array(fs.readFileSync(path.join(HVSC, "MUSICIANS/H/Hubbard_Rob/Commando.sid")));
  const lookup = cpuMs(() => { let n = 0; for (let i = 0; i < 1000; i++) n += first.value.get(songlengthsKey(bytes, "md5"))?.length ?? 0; return n; });
  assert.equal(lookup.value, 19000);
  assert.ok(lookup.ms / 1000 < 1, `a lookup took ${(lookup.ms / 1000).toFixed(3)} ms CPU`);
});
