import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJch, looksLikeJch, JchError } from "../src/interchange/jch.js";
import { importJch } from "../src/interchange/jchImport.js";
import { InterchangeUsageError } from "../src/interchange/errors.js";
import { parseSidwave } from "../src/sidwave.js";
import { runCli } from "../src/cli.js";
import { fuzz } from "./helpers/formatKit.mjs";
import { handBuilt } from "./helpers/jchKit.mjs";
import { haveEngine, compileScoreToSid, irOf, agreement } from "./helpers/trackerDifferential.mjs";

const fixtures = new URL("./fixtures/jch/", import.meta.url);
const HVSC = process.env.SIDWAVE_HVSC_DIR ?? path.join(os.homedir(), "dev/c64/C64Music");
const REAL = ["MUSICIANS/D/DRAX/Worktunes/24th_Amaranth_Grand_Prix_3.sid", "MUSICIANS/D/DRAX/Worktunes/5KJ5.sid", "MUSICIANS/D/DRAX/Worktunes/24th_Amaranth_GP_2_channels.sid"].map((p) => path.join(HVSC, p));
const typed = [JchError, InterchangeUsageError, RangeError];
function cli(args, cwd) {
  let out = "", err = "";
  const io = { cwd, out: (t) => { out += t; }, err: (t) => { err += t; }, outBytes: () => {} };
  return Promise.resolve(runCli(args, io)).then((code) => ({ code, out, err }));
}

test("committed hand-built image is the bytes of the test kit", () => {
  assert.deepEqual(new Uint8Array(fs.readFileSync(new URL("hand-built.prg", fixtures))), handBuilt());
});

test("reader: pointer block, tables, order lists, sequences", () => {
  const s = parseJch(handBuilt());
  assert.equal(s.version, "20.G4");
  assert.equal(s.name, "HAND BUILT");
  assert.equal(s.tempo, 5);
  assert.deepEqual(s.groove, [4, 3]);
  assert.deepEqual(s.orderLists.map((l) => l.map((e) => [e.transpose, e.sequence])), [[[0, 0], [8, 0]], [[0, 1], [0, 1]], []]);
  assert.equal(s.sequences[0].length, 16);
  assert.deepEqual(s.sequences[0][0], { b0: 0xa0, note: 0x24 });
  assert.equal(s.instruments[1].wavePointer, 4);
  assert.equal(s.commandA[2], 0xe0);
  assert.ok(looksLikeJch(handBuilt()));
});

test("reader: a PSID with load address $0F00 holds the same image; other files are typed errors", () => {
  const prg = handBuilt();
  const sid = new Uint8Array(0x7c + prg.length - 2);
  sid.set([0x50, 0x53, 0x49, 0x44, 0, 2, 0, 0x7c, 0x0f, 0x00]);
  sid.set(prg.subarray(2), 0x7c);
  assert.equal(parseJch(sid).name, "HAND BUILT");
  assert.ok(looksLikeJch(sid));
  const wrong = Uint8Array.from(prg); wrong[1] = 0x10;
  assert.throws(() => parseJch(wrong), /load address/);
  const other = Uint8Array.from(prg); other[2 + 0xfee - 0xf00 + 2] = 0x30;
  assert.throws(() => parseJch(other), /20\.G/);
  assert.throws(() => parseJch(new Uint8Array(10)), JchError);
  const badPtr = Uint8Array.from(prg); badPtr[2 + 0xfbd - 0xf00] = 0xe0;
  assert.throws(() => parseJch(badPtr), /outside the song data/);
  assert.ok(!looksLikeJch(new Uint8Array(500)));
});

test("fuzz: 1500 mutated images give a result or a typed error", () => {
  const r = fuzz({ seed: 61, cases: 1500, base: [handBuilt()], parse: (b) => importJch(b, { validate: false }), typed, limitMs: 3000 });
  assert.equal(r.accepted + r.rejected, 1500);
  assert.ok(r.accepted > 0 && r.rejected > 0);
});

test("import: notes with transposition, ties, instruments, tempo command, portamento, vibrato, pulse table", () => {
  const r = importJch(handBuilt());
  const doc = parseSidwave(r.yaml);
  assert.equal(doc.voices.length, 3);
  assert.match(r.yaml, /groove: \[C3, "~", "~", "~", E3, "~", \{note: G3, legato: true\}/, "note 0x24 is C3; a tie is legato");
  assert.match(r.yaml, /G#3/, "the second order entry is transposed by +8");
  assert.match(r.yaml, /vibrato: \{depth: 0\.6/);
  assert.match(r.yaml, /legato: true, portamento: 9/);
  assert.match(r.yaml, /set: 2048/);
  assert.equal(doc.instruments.i00.wavetable[0].wave, "tri");
  // Speed 5 lasts 6 frames, the E0 04 command makes it 5 frames from its row.
  assert.deepEqual(r.report.tempo.framesPerRow, [5, 6]);
  assert.equal(r.report.tempo.changes, 2);
  assert.ok(r.report.losses.some((l) => /set AD and SR/.test(l) && /not imported/.test(l)));
  assert.equal(r.report.voices[0].notes, 10);
});

test("CLI: detection by content and report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jchtest-"));
  fs.writeFileSync(path.join(dir, "tune.prg"), handBuilt());
  const r = await cli(["import", "tune.prg", "-o", "a.yaml", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).result.format, "jch");
  fs.writeFileSync(path.join(dir, "bad.bin"), new Uint8Array(300));
  assert.equal((await cli(["import", "bad.bin", "--format", "jch", "--json"], dir)).code, 3);
});

const haveHvsc = REAL.every((f) => fs.existsSync(f)) && await haveEngine();
test("differential: the tune's own player against the imported score (local HVSC tunes; skipped without them)", { skip: !haveHvsc }, async () => {
  for (const file of REAL) {
    const ref = fs.readFileSync(file);
    const r = importJch(ref);
    const [x, y] = [await irOf(ref, 10), await irOf(compileScoreToSid(r.yaml), 10)];
    const a = agreement(x, y, agreement(x, y, 0).bestShift);
    console.log(`${path.basename(file)}: best shift ${a.bestShift} calls, gate ${a.gate.map((x) => x.toFixed(2)).join("/")}, pitch ${a.pitch.map((x) => x.toFixed(2)).join("/")}`);
    assert.ok(Math.max(...a.gate) >= 0.7, `${file}: no voice has gate agreement of 0.7`);
  }
});
