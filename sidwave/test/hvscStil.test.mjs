import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { HvscError } from "../src/hvsc.ts";
import { STIL_MAX_CHARS, findStilEntry, formatStilQuery, lookupStil, parseStil, queryStil } from "../src/stil.ts";

const HVSC = process.env.HVSC_ROOT ?? process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const FILE = path.join(HVSC, "DOCUMENTS", "STIL.txt");
const present = fs.existsSync(FILE);
const cpuMs = (fn) => { const before = process.cpuUsage(); const value = fn(); const used = process.cpuUsage(before); return { ms: (used.user + used.system) / 1000, value }; };

const SAMPLE = [
  "##############################################################################",
  "#  STIL v83 - SID Tune Information List (June 28, 2025)",
  "##############################################################################",
  "",
  "### /DEMOS/ ##################################################################",
  "",
  "/DEMOS/A-F/Single.sid",
  "   NAME: Als de sterre",
  " AUTHOR: Somebody",
  "  TITLE: Hit That Beat [from Truthdare Doubledare] (0:00-1:15)",
  " ARTIST: Bronski Beat",
  "COMMENT: First line of a comment",
  "         that continues here.",
  "",
  "/DEMOS/A-F/Multi.sid",
  "COMMENT: File wide.",
  "(#1)",
  "   NAME: Blue Danube",
  "  TITLE: An der blauen Donau",
  " ARTIST: Johann Strauss",
  "(#3)",
  "COMMENT: Only a comment for tune 3.",
  "  TITLE: Cover one (0:00)",
  " ARTIST: A",
  "  TITLE: Cover two (1:00-2:00, 3:00)",
  " ARTIST: B",
  "",
].join("\r\n");

test("parseStil reads entries, subtune blocks, fields, continuation lines, album and timestamp", () => {
  const db = parseStil(SAMPLE);
  assert.equal(db.version, "83");
  assert.deepEqual([...db.entries.keys()], ["/DEMOS/A-F/Single.sid", "/DEMOS/A-F/Multi.sid"]);
  assert.deepEqual(db.warnings, []);
  const single = db.entries.get("/DEMOS/A-F/Single.sid");
  assert.equal(single.line, 7);
  assert.equal(single.blocks.length, 1);
  assert.equal(single.blocks[0].subtune, null);
  assert.deepEqual(single.blocks[0].fields.map((f) => f.kind), ["NAME", "AUTHOR", "TITLE", "ARTIST", "COMMENT"]);
  const title = single.blocks[0].fields[2];
  assert.equal(title.text, "Hit That Beat [from Truthdare Doubledare] (0:00-1:15)");
  assert.equal(title.album, "Truthdare Doubledare");
  assert.equal(title.timestamp, "0:00-1:15");
  assert.equal(single.blocks[0].fields[4].text, "First line of a comment\nthat continues here.");
  const multi = db.entries.get("/DEMOS/A-F/Multi.sid");
  assert.deepEqual(multi.blocks.map((b) => b.subtune), [null, 1, 3]);
  assert.equal(multi.blocks[2].fields.filter((f) => f.kind === "TITLE").length, 2);
  assert.equal(multi.blocks[2].fields[3].timestamp, "1:00-2:00, 3:00");
});

test("queryStil splits whole-file and subtune fields, selects a subtune and matches without regard to case", () => {
  const db = parseStil(SAMPLE);
  const all = queryStil(db, "/DEMOS/A-F/Multi.sid");
  assert.equal(all.found, true);
  assert.deepEqual(all.global.map((f) => f.kind), ["COMMENT"]);
  assert.deepEqual(all.subtunes.map((s) => s.subtune), [1, 3]);
  const three = queryStil(db, "/DEMOS/A-F/Multi.sid", 3);
  assert.deepEqual(three.subtunes.map((s) => s.subtune), [3]);
  assert.equal(queryStil(db, "/DEMOS/A-F/Multi.sid", 2).subtunes.length, 0);
  assert.equal(queryStil(db, "demos/a-f/multi.sid").found, true);
  assert.equal(findStilEntry(db, "DEMOS/A-F/Single.sid").path, "/DEMOS/A-F/Single.sid");
  const none = queryStil(db, "/DEMOS/Nope.sid");
  assert.equal(none.found, false);
  assert.deepEqual(none.subtunes, []);
  const text = formatStilQuery(all);
  assert.match(text, /^\/DEMOS\/A-F\/Multi\.sid\n  COMMENT: File wide\./);
  assert.match(text, /\(#3\)\n {4}COMMENT: Only a comment for tune 3\./);
});

test("parseStil reports what it does not understand and keeps going", () => {
  const db = parseStil(["/A/One.sid", "  TITLE: a", "nonsense here", "(#x)", "", "/A/One.sid", "COMMENT: dup", "orphan"].join("\n"));
  assert.equal(db.entries.size, 1);
  assert.equal(db.entries.get("/A/One.sid").blocks[0].fields.length, 1);
  assert.equal(db.warnings.length, 4);
  assert.match(db.warnings[0], /line 3: unrecognised line "nonsense here"/);
  assert.match(db.warnings[1], /bad subtune marker/);
  assert.match(db.warnings[2], /duplicate entry/);
  assert.match(db.warnings[3], /line 8: unrecognised line "orphan"/);
  assert.equal(parseStil("text before\n/X/Y.sid\nCOMMENT: c").warnings[0], "line 1: text before the first entry");
  assert.throws(() => parseStil("x".repeat(20), { maxChars: 10 }), (e) => e instanceof HvscError && e.code === "too_large");
  assert.equal(parseStil("").entries.size, 0);
});

test("lookupStil keeps its behaviour: the lines of the entry, truncated at STIL_MAX_CHARS", () => {
  const found = lookupStil(SAMPLE, "/DEMOS/A-F/Multi.sid");
  assert.equal(found.path, "/DEMOS/A-F/Multi.sid");
  assert.match(found.text, /^COMMENT: File wide\.\r?\n\(#1\)/);
  assert.equal(lookupStil(SAMPLE, "DEMOS/A-F/Multi.sid").path, "/DEMOS/A-F/Multi.sid");
  assert.equal(lookupStil(SAMPLE, "/Nope.sid"), undefined);
  const long = lookupStil(`/L/Long.sid\nCOMMENT: ${"x".repeat(STIL_MAX_CHARS + 10)}\n`, "/L/Long.sid");
  assert.match(long.text, /\[truncated at 16384 characters\]$/);
});

test("fuzz: 1000 random STIL texts parse without an untyped error and queries do not throw", () => {
  let seed = 777;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const lines = ["/A/B.sid", "/A/B.sid", "(#1)", "(#2)", "(#999)", "(#", "   NAME: n", "  TITLE: t [from x] (0:01)", " ARTIST: a", "COMMENT: c", "         more", "  ", "#### comment", "", "TITLE:", ":", "ä", "XYZ: q", "COMMENT: " + "y".repeat(300)];
  for (let i = 0; i < 1000; i++) {
    let text = "";
    for (let k = Math.floor(rnd() * 12); k > 0; k--) text += pick(lines) + pick(["\n", "\r\n", "\n"]);
    const db = parseStil(text);
    assert.ok(db.warnings.length <= 100);
    queryStil(db, pick(["/A/B.sid", "A/B.sid", "", "/", "/x"]), pick([undefined, 1, 2, 999]));
    for (const entry of db.entries.values()) formatStilQuery(queryStil(db, entry.path));
  }
});

test("real STIL.txt: parses in under 300 ms CPU, without warnings, and finds known entries", { skip: present ? false : `no STIL at ${FILE}` }, () => {
  const text = fs.readFileSync(FILE, "latin1");
  const first = cpuMs(() => parseStil(text));
  const best = Math.min(first.ms, cpuMs(() => parseStil(text)).ms, cpuMs(() => parseStil(text)).ms);
  const db = first.value;
  console.log(`STIL.txt parse: first run ${first.ms.toFixed(0)} ms CPU, best of three ${best.toFixed(0)} ms, ${db.entries.size} entries, v${db.version}`);
  assert.ok(db.entries.size > 15000);
  assert.deepEqual(db.warnings, []);
  assert.ok(best < 300, `parse took ${best.toFixed(0)} ms CPU`);
  const commando = queryStil(db, "/MUSICIANS/H/Hubbard_Rob/Commando.sid");
  assert.equal(commando.found, true);
  assert.equal(commando.global[0].kind, "COMMENT");
  assert.ok(commando.subtunes.some((s) => s.subtune === 1 && s.fields.some((f) => f.kind === "ARTIST" && f.text === "Tamayo Kawamoto")));
  const t0 = cpuMs(() => { for (let i = 0; i < 1000; i++) queryStil(db, "/MUSICIANS/H/Hubbard_Rob/Commando.sid"); });
  assert.ok(t0.ms / 1000 < 1, `a query took ${(t0.ms / 1000).toFixed(3)} ms`);
  // The old line-scan lookup and the parsed entry agree on which paths exist.
  assert.ok(lookupStil(text, "/MUSICIANS/H/Hubbard_Rob/Commando.sid").text.includes("Tamayo Kawamoto"));
});
