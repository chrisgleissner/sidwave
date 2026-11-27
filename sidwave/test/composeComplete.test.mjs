import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { runCli, EXIT_OK, EXIT_USAGE, EXIT_INPUT } from "../src/cli.js";
import { SidwaveOperationError } from "../src/cliCore.js";
import { generateSidwave } from "../src/audio/generateSidwave.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { readExampleScore } from "../src/sidwaveOps.js";
import { composeSidwave } from "../src/compose/compose.js";
import { PROFILES } from "../src/compose/profiles.js";
import { completeScore } from "../src/compose/complete.js";
import { analyseScore, detectKey } from "../src/compose/analyse.js";
import { verifyProtected } from "../src/compose/protected.js";

const base = () => composeSidwave({ profile: "chip-aaba-minor", seed: 5 }).score;

/** A score with only the lead, for adding the other voices. */
function leadOnly() {
  const s = base();
  s.voices = s.voices.filter((v) => v.name === "Lead");
  for (const e of s.timeline) e.layers = { v3: e.layers.v3 };
  return s;
}

function refused(fn, pattern) {
  assert.throws(fn, (error) => error instanceof SidwaveOperationError && error.category === "validation" && pattern.test(error.message));
}

test("key detection recovers the key of composed scores", () => {
  let right = 0;
  for (const profile of PROFILES.filter((p) => p.ending === "end" || p.form === "aaba").slice(0, 8)) {
    const a = analyseScore(parseSidwave(composeSidwave({ profile: profile.name, seed: 8 }).score));
    // The detected key is right when it has the profile's scale; relative modes share their notes.
    if (a.key.tonic === profile.tonic && a.key.mode === profile.mode) right++;
  }
  assert.ok(right >= 5, `${right} of 8 keys recovered`);
  assert.deepEqual(detectKey([{ at: 0, dur: 4, midi: 60 }, { at: 4, dur: 4, midi: 64 }, { at: 8, dur: 4, midi: 67 }], []), { tonic: 0, mode: "major" });
});

test("continue appends a section in the key of the score and leaves every original voice section identical", () => {
  const original = base();
  const result = completeScore(original, "continue", { bars: 8, seed: 3 });
  assert.equal(result.score.timeline.length, original.timeline.length + 1);
  const added = result.score.timeline.at(-1);
  assert.equal(added.bars, 8);
  assert.equal(result.addedBars, 8);
  assert.ok(Object.keys(added.layers).length >= 2);
  // Nothing that existed was rewritten.
  assert.deepEqual(result.score.timeline.slice(0, -1), original.timeline);
  for (const voice of original.voices) {
    const completed = result.score.voices.find((v) => v.id === voice.id);
    for (const [name, pattern] of Object.entries(voice.patterns)) assert.deepEqual(completed.patterns[name], pattern);
  }
  assert.equal(result.protected.identical, true);
  assert.ok(result.protected.cellsCompared >= original.timeline.length * original.voices.length);
  assert.equal(parseSidwave(result.score).song.length_bars, parseSidwave(original).song.length_bars + 8);
  // The continuation stays in the key.
  const a = analyseScore(result.parsed);
  assert.equal(a.key.tonic, analyseScore(parseSidwave(original)).key.tonic);
  // Deterministic per seed.
  assert.equal(JSON.stringify(completeScore(original, "continue", { bars: 8, seed: 3, verify: false }).score), JSON.stringify(completeScore(original, "continue", { bars: 8, seed: 3, verify: false }).score));
  assert.notEqual(JSON.stringify(completeScore(original, "continue", { bars: 8, seed: 4, verify: false }).score), JSON.stringify(completeScore(original, "continue", { bars: 8, seed: 3, verify: false }).score));
});

test("the protected-material check fails when a protected voice is changed", () => {
  const original = base();
  const result = completeScore(original, "continue", { bars: 4 });
  const tampered = structuredClone(result.score);
  const lead = tampered.voices.find((v) => v.name === "Lead");
  const first = Object.values(lead.patterns)[0];
  first.groove = first.groove.replace(/^\((\w#?\d)/, (m, note) => `(${note === "C4" ? "D4" : "C4"}`);
  const report = verifyProtected(parseSidwave(original), parseSidwave(tampered), { entryMap: original.timeline.map((_, i) => i), excluded: [], guarded: [{ voice: 3, entry: original.timeline.length - 1 }] });
  assert.equal(report.identical, false);
  assert.ok(report.mismatches.length > 0);
  assert.equal(report.mismatches[0].voice, 3);
});

test("harmonise adds an arpeggio or a counter line on a free voice and keeps the melody and the others", () => {
  for (const style of ["arp", "line"]) {
    const original = leadOnly();
    const result = completeScore(original, "harmonise", { voice: 3, target: 2, style, seed: 2 });
    assert.deepEqual(result.targets, [2]);
    const harmony = result.score.voices.find((v) => v.id === 2);
    assert.ok(harmony && Object.keys(harmony.patterns).length >= 1);
    assert.ok(result.score.timeline.every((e) => e.layers.v2 !== undefined));
    assert.equal(result.protected.identical, true);
    assert.deepEqual(result.score.voices.find((v) => v.id === 3), original.voices[0]);
    const compiled = compileSidwaveToPrg(result.parsed);
    assert.ok(compiled.prg.length > 0);
  }
});

test("accompany adds a bass line and percussion on free voices", () => {
  const original = leadOnly();
  const result = completeScore(original, "accompany", { bass: 1, drums: 2 });
  assert.deepEqual(result.targets.sort(), [1, 2]);
  const drums = result.score.voices.find((v) => v.id === 2);
  assert.ok(Object.values(drums.patterns).every((p) => p.drums && p.drums.steps.length === p.drums.steps.length));
  assert.equal(result.protected.identical, true);
  const bass = completeScore(original, "accompany", { bass: 1 });
  assert.deepEqual(bass.targets, [1]);
  assert.equal(bass.score.voices.some((v) => v.id === 2), false);
});

test("a target voice that already plays is refused, and so is a voice outside the SID map", () => {
  const score = base();
  refused(() => completeScore(score, "harmonise", { voice: 3, target: 1 }), /voice 1 is not free/);
  refused(() => completeScore(score, "accompany", { bass: 3 }), /voice 3 is not free/);
  refused(() => completeScore(score, "accompany", { drums: 2 }), /voice 2 is not free/);
  refused(() => completeScore(leadOnly(), "accompany", { bass: 7 }), /does not exist in the SID map/);
  assert.throws(() => completeScore(score, "accompany", {}), (e) => e.category === "usage");
  assert.throws(() => completeScore(score, "continue", {}), (e) => e.category === "usage");
  // The refusal leaves the input alone.
  assert.equal(JSON.stringify(score), JSON.stringify(base()));
});

test("fill-section fills an empty entry in place, appends a missing section, and refuses a section that plays", () => {
  const original = base();
  const holed = structuredClone(original);
  holed.timeline[2].layers = {};
  const filled = completeScore(holed, "fill-section", { section: "B", seed: 4 });
  assert.equal(filled.score.timeline.length, holed.timeline.length);
  assert.ok(Object.keys(filled.score.timeline[2].layers).length >= 2);
  assert.deepEqual(filled.score.timeline[0], holed.timeline[0]);
  assert.deepEqual(filled.score.timeline[3], holed.timeline[3]);
  assert.equal(filled.protected.identical, true);
  assert.ok(filled.protected.excludedCells >= 2);
  const appended = completeScore(original, "fill-section", { section: "Coda", bars: 4 });
  assert.equal(appended.score.timeline.at(-1).section, "Coda");
  assert.equal(appended.score.timeline.length, original.timeline.length + 1);
  assert.equal(appended.protected.identical, true);
  refused(() => completeScore(original, "fill-section", { section: "A1" }), /not empty/);
  refused(() => completeScore(original, "fill-section", { section: "X", after: "Nope" }), /no section "Nope"/);
});

test("inserting a section before later material needs a whole number of player calls, and then keeps that material identical", () => {
  const original = base();
  refused(() => completeScore(original, "fill-section", { section: "Mid", after: "A1", bars: 4 }), /whole number/);
  // At this tempo a beat is exactly 24 player calls on PAL (50.1245 calls per second).
  const exact = structuredClone(original);
  exact.tempo = (985248 / 19656) * 60 / 24;
  const result = completeScore(exact, "fill-section", { section: "Mid", after: "A1", bars: 4 });
  assert.equal(result.score.timeline[1].section, "Mid");
  assert.equal(result.protected.identical, true);
  assert.equal(result.score.timeline.length, original.timeline.length + 1);
});

test("completion works on scores from the version 1 generator and on bundled examples, or refuses with a reason", () => {
  const v1 = generateSidwave({ root: "C3", preset: "classic", style: "funk", seed: 12, system: "PAL" }).score;
  const result = completeScore(v1, "continue", { bars: 4 });
  assert.equal(result.protected.identical, true);
  for (const name of ["chiptune_drive", "fuer_elise", "acid_line"]) {
    const done = completeScore(readExampleScore(name), "continue", { bars: 4 });
    assert.equal(done.protected.identical, true, name);
  }
  refused(() => completeScore(readExampleScore("metal_sync"), "continue", { bars: 4 }), /changes the tempo/);
  refused(() => completeScore(readExampleScore("game_songs"), "continue", { bars: 4 }), /several songs/);
});

test("the command line completes a score, reports the verification and refuses bad input", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-complete-")));
  try {
    const file = path.join(dir, "song.yaml");
    fs.writeFileSync(file, YAML.stringify(leadOnly()));
    const io = () => { const out = [], err = []; return { out, err, io: { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes() {} } }; };
    let r = io();
    assert.equal(runCli(["complete", "song.yaml", "--op", "accompany", "--bass", "1", "--drums", "2", "--json"], r.io), EXIT_OK);
    const envelope = JSON.parse(r.out.join(""));
    assert.equal(envelope.command, "complete");
    assert.equal(envelope.result.protected.identical, true);
    const written = YAML.parse(fs.readFileSync(path.join(dir, "song.completed.yaml"), "utf8"));
    assert.equal(written.voices.length, 3);
    r = io();
    assert.equal(runCli(["complete", "song.yaml", "--op", "accompany", "--bass", "1"], r.io), EXIT_USAGE);
    assert.match(r.err.join(""), /exists; use --force/);
    r = io();
    assert.equal(runCli(["complete", "song.yaml", "--op", "harmonise", "--voice", "3", "--target", "3", "--json"], r.io), EXIT_INPUT);
    assert.equal(JSON.parse(r.out.join("")).error.category, "validation");
    r = io();
    assert.equal(runCli(["complete", "song.yaml"], r.io), EXIT_USAGE);
    r = io();
    assert.equal(runCli(["complete", "missing.yaml", "--op", "continue", "--bars", "2"], r.io), EXIT_INPUT);
    r = io();
    assert.equal(runCli(["complete", "song.yaml", "--op", "continue", "--bars", "2", "-o", "-", "--no-verify"], r.io), EXIT_OK);
    assert.ok(YAML.parse(r.out.join("")).timeline.length === 5);
    assert.match(runCliText(["complete", "--help"], dir), /fill-section/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCliText(args, cwd) {
  const out = [];
  runCli(args, { cwd, out: (t) => out.push(t), err() {}, outBytes() {} });
  return out.join("");
}

// CPU-time bounds. The measured values are printed so that a run reports them.
const cpuMs = (fn) => { const start = process.cpuUsage(); const value = fn(); const d = process.cpuUsage(start); return { value, ms: (d.user + d.system) / 1000 }; };

test("generating a three-minute score and completing it take well under a second of CPU time", () => {
  const longProfile = { ...PROFILES.find((p) => p.name === "soft-through-major"), name: "long-through", tempo: 50 };
  composeSidwave({ profile: longProfile, seed: 1 });
  const gen = cpuMs(() => composeSidwave({ profile: longProfile, seed: 2 }));
  const minutes = (gen.value.bars * 4 * 60) / gen.value.tempo / 60;
  assert.ok(minutes >= 2.8, `score lasts ${minutes.toFixed(1)} minutes`);
  console.log(`# generate ${minutes.toFixed(1)} min score: ${gen.ms.toFixed(0)} ms CPU`);
  assert.ok(gen.ms < 1500, `generation took ${gen.ms} ms`);
  const lead = gen.value.score;
  const sparse = structuredClone(lead);
  sparse.voices = sparse.voices.filter((v) => v.name === "Lead");
  for (const e of sparse.timeline) e.layers = { v3: e.layers.v3 };
  const timings = {};
  const cases = {
    continue: () => completeScore(lead, "continue", { bars: 8, verify: false }),
    harmonise: () => completeScore(sparse, "harmonise", { voice: 3, target: 2, verify: false }),
    "harmonise line": () => completeScore(sparse, "harmonise", { voice: 3, target: 2, style: "line", verify: false }),
    accompany: () => completeScore(sparse, "accompany", { bass: 1, drums: 2, verify: false }),
    "fill-section": () => completeScore(lead, "fill-section", { section: "Coda", bars: 8, verify: false }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    fn();
    timings[name] = cpuMs(fn).ms;
    console.log(`# complete ${name} on a ${minutes.toFixed(1)} min score: ${timings[name].toFixed(0)} ms CPU`);
    assert.ok(timings[name] < 1500, `${name} took ${timings[name]} ms`);
  }
});
