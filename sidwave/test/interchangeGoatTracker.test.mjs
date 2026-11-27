import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { parseGoatTracker, writeGoatTracker, GoatTrackerError, MAX_SNG_BYTES } from "../src/interchange/goattracker.js";
import { importGoatTracker } from "../src/interchange/goattrackerImport.js";
import { exportGoatTracker } from "../src/interchange/goattrackerExport.js";
import { runCli } from "../src/cli.js";
import { VERSIONS, gts } from "./helpers/gtFixtures.mjs";
import { haveGt2reloc, haveEngine, differential, differentialExport, GT2RELOC, GT_STARTUP_CALLS } from "./helpers/trackerDifferential.mjs";

const pitches = (text) => exportEvents(parseSidwave(text)).voices.map((v) => v.notes.map((n) => n.pitch));
const expected = [[60, 64, 67, 72], [36, 36, 41, 36], []];

test("every GoatTracker version imports through one path to the same notes", () => {
  const families = { "GTS!": "GoatTracker 1.x", GTS2: "GoatTracker 2.0 beta", GTS3: "GoatTracker 2.x", GTS4: "GoatTracker 2.x", GTS5: "GoatTracker 2.x" };
  for (const [magic, make] of Object.entries(VERSIONS)) {
    const result = importGoatTracker(make());
    assert.equal(result.report.magic, magic);
    assert.equal(result.report.family, families[magic]);
    assert.equal(result.report.rows, 16);
    assert.equal(result.report.voices.map((v) => v.notes).join(), "4,4,0");
    const got = pitches(result.yaml);
    // The rest-only third channel has no voice notes in the score.
    assert.deepEqual(got.filter((p) => p.length), expected.filter((p) => p.length), magic);
    compileSidwaveToPrg(parseSidwave(result.yaml));
    // Per-version loss: older formats report their load-time conversions, GTS5 none.
    assert.equal(result.report.conversions.length, { "GTS!": 3, GTS2: 3, GTS3: 2, GTS4: 1, GTS5: 0 }[magic], magic);
  }
  assert.ok(importGoatTracker(VERSIONS["GTS!"]()).report.conversions.some((c) => c.startsWith("GTS!")));
  assert.ok(importGoatTracker(VERSIONS.GTS2()).report.conversions.some((c) => c.startsWith("GTS2")));
  const detail = importGoatTracker(gts());
  assert.equal(detail.report.tempo.initialTicksPerRow, 6);
  assert.equal(detail.report.rowsPerBeat, 4);
  const doc = parseSidwave(detail.yaml);
  assert.equal(doc.song.title, "Fixture");
  assert.equal(doc.song.author, "Tester");
  // 6 calls per row, 4 rows per beat: 60 * 50.1245 / 24 = 125.31 BPM.
  assert.ok(Math.abs(doc.song.tempo - 125.3114) < 1e-3);
  assert.ok(detail.report.losses.some((l) => /Master volume/.test(l)));
});

test("GoatTracker 1.x pulse parameters, filter table and arpeggio are converted as GoatTracker does", () => {
  const song = parseGoatTracker(VERSIONS["GTS!"]());
  // Instrument 2 had pulse 0x80 without modulation: set 0x0800 then a stop jump.
  const inst = song.instruments[2];
  assert.equal(inst.ptr[1], 1);
  assert.deepEqual([song.ltable[1][0], song.rtable[1][0], song.ltable[1][1], song.rtable[1][1]], [0x88, 0x00, 0xff, 0x00]);
  assert.equal(song.instruments[1].ptr[0], 1);
  assert.equal(song.instruments[2].ptr[0], 3);
  // Notes: GTS! note 0x30 + FIRSTNOTE = C-4; the old rest and key off codes map to REST and KEYOFF.
  assert.equal(song.patterns[0][0], 0x90);
  assert.equal(song.patterns[0][1 * 4], 0xbd);
  assert.equal(song.patterns[0][10 * 4], 0xbe);
  // Flags derived on load (before GTS5): an instrument whose first waveform is 0 gets the no-gate-off flag.
  assert.equal(song.instruments[1].gatetimer & 0x40, 0x40);
});

test("GoatTracker writer reproduces a GTS5 file byte for byte and the parser rejects bad files", () => {
  const original = gts("GTS5");
  const parsed = parseGoatTracker(original);
  assert.deepEqual(Buffer.from(writeGoatTracker(parsed)), original);
  assert.throws(() => parseGoatTracker(Buffer.from("GTS9....")), /not a GoatTracker song/);
  assert.throws(() => parseGoatTracker(Buffer.from("GT")), GoatTrackerError);
  assert.throws(() => parseGoatTracker(original.subarray(0, original.length - 10)), /truncated/);
  assert.throws(() => parseGoatTracker(Buffer.alloc(MAX_SNG_BYTES + 1)), /limit/);
  // Too many songs and instruments, a truncated order list and an oversized pattern.
  const head = Buffer.concat([Buffer.from("GTS5"), Buffer.alloc(96)]);
  assert.throws(() => parseGoatTracker(Buffer.concat([head, Buffer.from([200])])), /songs/);
  assert.throws(() => parseGoatTracker(Buffer.concat([head, Buffer.from([1, 255]), Buffer.alloc(30)])), /truncated/);
  const noSong = Buffer.concat([head, Buffer.from([0, 200])]);
  assert.throws(() => parseGoatTracker(noSong), /instruments/);
  const longPattern = Buffer.concat([head, Buffer.from([0, 0, 0, 0, 0, 0, 1, 200]), Buffer.alloc(1000)]);
  assert.throws(() => parseGoatTracker(longPattern), /rows/);
  assert.throws(() => importGoatTracker(original, { song: 2 }), /does not exist/);
});

test("a long song and an order list that repeats patterns stay bounded", () => {
  const bytes = [...Buffer.from("GTS5"), ...new Array(96).fill(0), 1];
  // Each channel: REPEAT 15, pattern 0 (16 plays), twice; then LOOPSONG to 0.
  for (let c = 0; c < 3; c++) bytes.push(5, 0xdf, 0, 0xdf, 0, 0xff, 0);
  bytes.push(0, 0, 0, 0, 0); // no instruments, four empty tables
  bytes.push(1, 17);
  for (let r = 0; r < 16; r++) bytes.push(r === 0 ? 0x90 : 0xbd, 0, 0, 0);
  bytes.push(0xff, 0, 0, 0);
  assert.throws(() => importGoatTracker(Buffer.from(bytes), { maxRows: 100 }), /more than 100 rows/);
  assert.equal(importGoatTracker(Buffer.from(bytes)).report.rows, 512);
});

test("GoatTracker export: GTS5 that the parser reads back, with losses listed", () => {
  const doc = parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Exp", tempo: 125,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "lead", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  }));
  const result = exportGoatTracker(doc);
  assert.equal(String.fromCharCode(...result.bytes.subarray(0, 4)), "GTS5");
  const song = parseGoatTracker(result.bytes);
  assert.equal(song.name, "Exp");
  assert.equal(song.songs.length, 1);
  assert.equal(song.instruments[1].ad, 0x04);
  assert.equal(song.instruments[1].sr, 0x83);
  assert.ok(result.losses.some((l) => /Filter|Vibrato|Pulse width modulation/.test(l)));
  const back = importGoatTracker(result.bytes);
  const original = exportEvents(doc).voices.map((v) => v.notes.map((n) => n.pitch));
  assert.deepEqual(pitches(back.yaml).filter((p) => p.length), original);
  assert.ok(result.maxTimingErrorCalls <= 1);
});

test("sidwave import and export handle GoatTracker files on the command line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-gt-"));
  try {
    const run = async (...args) => {
      const out = [], err = [];
      const code = await runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "a.sng"), gts());
    const imported = await run("import", "a.sng", "-o", "a.yaml", "--json");
    assert.equal(imported.code, 0, imported.err);
    assert.equal(JSON.parse(imported.out).result.format, "goattracker");
    const exported = await run("export", "a.yaml", "-o", "b.sng", "--json");
    assert.equal(exported.code, 0, exported.err);
    assert.ok(JSON.parse(exported.out).result.losses.length > 0);
    assert.equal(parseGoatTracker(fs.readFileSync(path.join(dir, "b.sng"))).songs.length, 1);
    fs.writeFileSync(path.join(dir, "bad.sng"), "GTS5");
    const bad = await run("import", "bad.sng", "--json");
    assert.equal(bad.code, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const have = haveGt2reloc();
const engineOk = have ? await haveEngine() : false;
const reason = !have ? `gt2reloc not found at ${GT2RELOC}` : !engineOk ? "libsidplayfp-wasm not available" : undefined;

for (const [magic, make] of Object.entries(VERSIONS)) {
  test(`differential: gt2reloc of a ${magic} file against the imported score`, { skip: reason }, async () => {
    const result = importGoatTracker(make());
    const diff = await differential({ sng: make(), yamlText: result.yaml, seconds: 6 });
    // gt2reloc converts older formats on load as the importer does; the sequences agree call by call after the
    // startup offset of the SIDWave player. The register levels of the ladder are reported, not required.
    assert.equal(diff.agree.bestShift, -GT_STARTUP_CALLS, "the startup offset is the best alignment");
    assert.ok(diff.agree.gate[0] >= 0.9 && diff.agree.gate[1] >= 0.9, JSON.stringify(diff.agree));
    assert.ok(diff.agree.pitch[0] >= 0.9 && diff.agree.pitch[1] >= 0.9, JSON.stringify(diff.agree));
    assert.equal(diff.ladder.levels.A1 === "pass" || diff.ladder.levels.A1 === "fail", true);
    assert.equal(diff.ladder.a1.status, "approximate");
  });
}

test("differential: the exported GTS5 file in gt2reloc against the compiled score", { skip: reason }, async () => {
  const text = yaml.stringify({
    sidwave: 1.3, title: "Exp", tempo: 125,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  });
  const result = exportGoatTracker(parseSidwave(text));
  const diff = await differentialExport({ sng: result.bytes, yamlText: text, seconds: 6 });
  assert.equal(diff.agree.bestShift, GT_STARTUP_CALLS);
  assert.ok(diff.agree.gate[0] >= 0.9 && diff.agree.gate[1] >= 0.9, JSON.stringify(diff.agree));
  assert.ok(diff.agree.pitch[0] >= 0.9 && diff.agree.pitch[1] >= 0.9, JSON.stringify(diff.agree));
});

const EXAMPLES = path.join(os.homedir(), ".c64bridge/sidwave-standalone/tools/goattracker2-upstream-2.77/examples");
test("the 14 example songs of GoatTracker 2.77 import when they are available locally", { skip: fs.existsSync(EXAMPLES) ? undefined : "examples not installed" }, () => {
  const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".sng"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const result = importGoatTracker(fs.readFileSync(path.join(EXAMPLES, file)));
    assert.ok(result.report.rows > 0, file);
  }
});

test("a pattern row with an instrument above 63 is an input error, and mutated songs only raise typed errors", () => {
  const bad = Buffer.from(gts());
  const at = bad.indexOf(Buffer.from([0x90, 1, 0, 0]), 100);
  assert.ok(at > 0);
  bad[at + 1] = 200;
  assert.throws(() => importGoatTracker(bad), (e) => e instanceof GoatTrackerError && /instrument 200/.test(e.message));
  let seed = 99;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const makers = Object.values(VERSIONS);
  let typed = 0;
  for (let i = 0; i < 2000; i++) {
    const copy = Buffer.from(makers[i % makers.length]());
    for (let k = 0; k < 1 + rnd(5); k++) copy[rnd(copy.length)] = rnd(256);
    const input = rnd(8) === 0 ? copy.subarray(0, rnd(copy.length)) : copy;
    try { importGoatTracker(input, { validate: false }); } catch (error) {
      assert.ok(error instanceof GoatTrackerError, `${error.name}: ${error.message}`);
      typed++;
    }
  }
  assert.ok(typed > 50);
});

test("differential on example songs of GoatTracker 2.77 (local; per-song figures are printed)", { skip: reason ?? (fs.existsSync(EXAMPLES) ? undefined : "examples not installed") }, async () => {
  for (const name of ["dojo", "consultant", "sanction", "funktest", "transylvanian"]) {
    const sng = fs.readFileSync(path.join(EXAMPLES, `${name}.sng`));
    const result = importGoatTracker(sng);
    const diff = await differential({ sng, yamlText: result.yaml, seconds: 8 });
    const f = (list) => list.map((x) => x.toFixed(2)).join("/");
    console.log(`# ${name}: best shift ${diff.agree.bestShift}, gate ${f(diff.agree.gate)}, note ${f(diff.agree.pitch)}, A1 bad windows ${(diff.ladder.a1.badWindows / diff.ladder.a1.windows).toFixed(2)}`);
    assert.ok(diff.agree.bestShift >= -9 && diff.agree.bestShift <= -6, `${name}: best shift ${diff.agree.bestShift}`);
    assert.ok(Math.min(...diff.agree.gate) >= 0.75, `${name}: gate ${f(diff.agree.gate)}`);
  }
});
