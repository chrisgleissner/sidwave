// Key, metre, form, motifs and voice use of scores, and CPU-time bounds of the music analysis.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { analyzeScore } from "../src/analyze/analysis.ts";
import { analyzeForm, estimateKey, estimateMetre, mineMotifs, modelOfScore, voiceUse } from "../src/analyze/music.ts";
import { cpuMicros } from "../src/analyze/common.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { confinedReadOptions } from "../src/sidwaveOps.ts";
import { checkMarks } from "./helpers/analyzeKit.mjs";

const INSTRUMENTS = { lead: { waveform: "pulse", pulse_width: 2048, adsr: [0, 4, 10, 2] }, bass: { waveform: "sawtooth", adsr: [0, 4, 10, 2] } };
const bar = (...notes) => ({ length: 1, groove: notes.map((n) => (n === "-" ? "-" : { note: n, len: 1 })) });

function score({ patterns, timeline, bassPatterns, role, meter }) {
  return YAML.stringify({
    sidwave: "1.4", title: "Test", tempo: 120, mode: "PAL", ...(meter ? { meter } : {}), instruments: INSTRUMENTS,
    voices: [{ id: 1, instrument: "lead", ...(role ? { role } : {}), patterns }, ...(bassPatterns ? [{ id: 2, instrument: "bass", patterns: bassPatterns }] : [])],
    timeline,
  });
}

const modelOf = (text) => modelOfScore(parseSidwave(text));

test("key: a C major melody gives C major and an A minor melody gives A minor, with the method named", () => {
  const major = modelOf(score({ patterns: { P: bar("C4", "E4", "G4", "C5"), Q: bar("D4", "F4", "A4", "G4") }, timeline: [{ section: "A", bars: 4, layers: { v1: "P Q P Q" } }] }));
  const k = estimateKey(major.notes);
  assert.equal(`${k.tonic} ${k.mode}`, "C major");
  assert.equal(k.basis, "inferred");
  assert.match(k.method, /Krumhansl/);
  const minor = modelOf(score({ patterns: { P: bar("A3", "C4", "E4", "A4"), Q: bar("B3", "D4", "F4", "E4") }, timeline: [{ section: "A", bars: 4, layers: { v1: "P Q P Q" } }] }));
  const m = estimateKey(minor.notes);
  assert.equal(`${m.tonic} ${m.mode}`, "A minor");
  assert.ok(m.correlation > 0.5 && m.margin >= 0);
  assert.equal(estimateKey([]), undefined);
});

test("form: sections, bar labels, repetitions and the loop of a score with the form A B A B A B", () => {
  const text = score({
    patterns: { P: bar("C4", "E4", "G4", "C5"), Q: bar("D4", "F4", "A4", "D5") },
    timeline: [{ section: "A", bars: 2, layers: { v1: "P P" } }, { section: "B", bars: 2, layers: { v1: "Q Q" } }, { section: "A", bars: 2, layers: { v1: "P P" } }, { section: "B", bars: 2, layers: { v1: "Q Q" } }, { section: "A", bars: 2, layers: { v1: "P P" } }, { section: "B", bars: 2, layers: { v1: "Q Q" } }],
  });
  const form = analyzeForm(modelOf(text), "observed");
  assert.equal(form.barLabels, "AABBAABBAABB");
  assert.equal(form.distinctBars, 2);
  assert.deepEqual(form.runs.map((r) => `${r.label}${r.bars}`), ["A2", "B2", "A2", "B2", "A2", "B2"]);
  assert.equal(form.declaredSections.length, 6);
  assert.equal(form.declaredSections[1].startBar, 2);
  assert.ok(form.declaredSections.every((s) => s.basis === "observed"));
  assert.ok(form.loop, "periodic tail found");
  assert.equal(form.loop.basis, "inferred");
  assert.equal(form.loop.periodBars, 4);
  assert.equal(form.loop.startBar, 0);
  assert.equal(form.loop.repeats, 3);
  assert.equal(form.repeatShare, 0.8333);
});

test("form: a score without repetition has no loop, and a declared loop_to is reported as observed", () => {
  const patterns = { P: bar("C4", "E4", "G4", "C5"), Q: bar("D4", "F4", "A4", "D5"), R: bar("E4", "G4", "B4", "E5"), S: bar("F4", "A4", "C5", "F5") };
  const text = score({ patterns, timeline: [{ section: "I", bars: 2, layers: { v1: "P Q" } }, { section: "V", bars: 2, layers: { v1: "R S" } }] });
  const flat = analyzeForm(modelOf(text), "observed");
  assert.equal(flat.loop, undefined);
  assert.equal(flat.barLabels, "ABCD");
  const looped = YAML.parse(text);
  looped.loop_to = 2;
  const f = analyzeForm(modelOf(YAML.stringify(looped)), "observed");
  assert.equal(f.declaredLoop.basis, "observed");
  assert.equal(f.declaredLoop.startBar, 2);
});

test("motifs: a four-note figure that recurs in two voices is found with its locations", () => {
  const figure = ["C4", "D4", "F4", "E4"];
  const text = score({
    patterns: { P: bar(...figure), Q: bar("G3", "G3", "A3", "G3"), R: bar("C5", "-", "-", "-") },
    bassPatterns: { P: bar(...figure.map((n) => n.replace("4", "3"))), Q: bar("C2", "-", "-", "-") },
    timeline: [{ section: "A", bars: 6, layers: { v1: "P Q P R P Q", v2: "P Q P Q P Q" } }],
  });
  const motifs = mineMotifs(modelOf(text));
  assert.ok(motifs.length >= 1);
  const m = motifs.find((x) => x.intervals.join() === "2,3,-1");
  assert.ok(m, `figure 2,3,-1 in ${JSON.stringify(motifs.map((x) => x.intervals))}`);
  assert.ok(m.occurrenceCount >= 3);
  assert.deepEqual(m.voices, [1, 2]);
  assert.equal(m.basis, "inferred");
  assert.ok(m.occurrences.every((o) => Number.isInteger(o.bar) && o.beat >= 0));
});

test("metre: the declared metre is observed in a score, and a waltz accent pattern is detected as three beats", () => {
  const waltz = () => ({ length: 1, groove: [{ note: "C3", len: 1 }, "-", "E4"] });
  const text = YAML.stringify({
    sidwave: "1.4", title: "Waltz", tempo: 120, mode: "PAL", meter: 3, instruments: INSTRUMENTS,
    voices: [{ id: 1, instrument: "lead", patterns: { W: waltz() } }], timeline: [{ section: "A", bars: 16, layers: { v1: "W*16" } }],
  });
  const model = modelOf(text);
  const metre = estimateMetre(model, "observed");
  assert.equal(metre.declared.basis, "observed");
  assert.equal(metre.declared.beatsPerBar, 3);
  assert.equal(metre.detected.basis, "inferred");
  assert.equal(metre.detected.beatsPerBar, 3);
  assert.equal(metre.detected.agrees, true);
  assert.equal(estimateMetre(model, "inferred").declared.basis, "inferred");
});

test("voice use: ranges, density and roles; a declared role is observed and a derived role is inferred", () => {
  const text = score({
    role: "lead", patterns: { P: bar("C5", "E5", "G5", "C6") }, bassPatterns: { P: bar("C2", "-", "C2", "-") },
    timeline: [{ section: "A", bars: 4, layers: { v1: "P*4", v2: "P*4" } }],
  });
  const model = modelOf(text);
  const use = voiceUse(model, new Map([[1, "lead"]]));
  assert.equal(use[0].role.basis, "observed");
  assert.equal(use[0].role.value, "lead");
  assert.equal(use[0].range.lowest, "C5");
  assert.equal(use[0].range.highest, "C6");
  assert.equal(use[1].role.basis, "inferred");
  assert.equal(use[1].role.value, "bass");
  assert.ok(use[0].notesPerSecond > use[1].notesPerSecond);
  assert.ok(use[0].soundingShare > 0 && use[0].soundingShare <= 1);
});

test("analyzeScore marks every fact as observed or inferred with a method, for every bundled example", { timeout: 400_000 }, async () => {
  const dir = new URL("../data/sound/examples/", import.meta.url).pathname;
  let analysed = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const text = readFileSync(`${dir}${file}`, "utf8");
    const report = await analyzeScore(text, { read: confinedReadOptions(dir, [], `${dir}${file}`) });
    const marks = checkMarks(report);
    assert.ok(marks.observed > 0 && marks.inferred > 0, file);
    assert.ok(report.techniques.every((t) => t.basis === "observed" && t.source === "score"), file);
    assert.ok(report.voices.length >= 3, file);
    analysed++;
  }
  assert.ok(analysed >= 10, `${analysed} examples`);
});

function syntheticModel(noteCount) {
  const framesPerBeat = 12;
  const bars = Math.ceil(noteCount / 12);
  const notes = [];
  for (let i = 0; i < noteCount; i++) {
    const voice = (i % 3) + 1;
    const start = Math.floor(i / 3) * 6;
    notes.push({ voice, start, end: start + 5, midi: 48 + ((i * 7) % 24), inst: voice - 1, percussion: false, section: 0 });
  }
  const barFrames = framesPerBeat * 4;
  return {
    notes, fps: 50, framesPerBeat, tempo: 250, meterBeats: 4, barStarts: Array.from({ length: bars + 2 }, (_, i) => i * barFrames),
    sections: [{ name: "A", startFrame: 0, endFrame: bars * barFrames, bars }], totalFrames: bars * barFrames, voiceCount: 3, arrangement: undefined,
  };
}

test("CPU time: key, metre, form, motifs and voice use of 60,000 notes take well under two seconds and scale about linearly", () => {
  const run = (n) => {
    const model = syntheticModel(n);
    const t0 = cpuMicros();
    estimateKey(model.notes);
    estimateMetre(model);
    analyzeForm(model);
    mineMotifs(model);
    voiceUse(model);
    return cpuMicros() - t0;
  };
  run(2_000);
  const small = run(15_000);
  const large = run(60_000);
  assert.ok(large < 2_000_000, `${large} us for 60,000 notes`);
  assert.ok(large < Math.max(small, 20_000) * 12, `4x the notes took ${large} us against ${small} us (linear would be about 4x)`);
});
