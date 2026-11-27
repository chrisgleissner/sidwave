// Technique detection on traces: synthetic register traces with a known technique each, the independently written
// player fixtures, and CPU-time bounds.
import test from "#test/runner";
import assert from "#test/assert";
import { techniquesFromIr } from "../src/analyze/techniques.ts";
import { analyzeSid } from "../src/analyze/analysis.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { checkMarks, freqWrites, syntheticIr } from "./helpers/analyzeKit.mjs";
import { cpuMicros } from "../src/analyze/common.ts";

const names = (ir) => techniquesFromIr(ir).map((t) => t.name);
const A4 = 0x1d45;

test("a note with the gate on and a steady pitch has no technique", () => {
  const ir = syntheticIr(100, (c) => (c === 1 ? [...freqWrites(0, A4), [4, 0x41]] : freqWrites(0, A4)));
  assert.deepEqual(names(ir), []);
});

test("arpeggio: a gate-on run that cycles through three frequencies, with one to three calls per step", () => {
  const steps = [A4, Math.round(A4 * 2 ** (4 / 12)), Math.round(A4 * 2 ** (7 / 12))];
  const ir = syntheticIr(80, (c) => (c === 1 ? [[4, 0x41], ...freqWrites(0, steps[0])] : freqWrites(0, steps[Math.floor((c - 1) / 2) % 3])));
  const t = techniquesFromIr(ir).find((x) => x.name === "arpeggio");
  assert.ok(t, "arpeggio found");
  assert.deepEqual(t.voices, [1]);
  assert.equal(t.basis, "inferred", "a threshold classification is inferred");
  assert.match(t.method, /threshold detector arpeggio/);
  assert.equal(t.evidence.cycleSteps, 3);
  assert.equal(t.evidence.example, "0,4,7");
});

test("vibrato: a regular oscillation of under a semitone is a vibrato, not an arpeggio", () => {
  const ir = syntheticIr(120, (c) => (c === 1 ? [[4, 0x41], ...freqWrites(0, A4)] : freqWrites(0, A4 + Math.round(40 * Math.sin((c / 50) * 2 * Math.PI * 5)))));
  const found = techniquesFromIr(ir);
  const vibrato = found.find((x) => x.name === "vibrato");
  assert.ok(vibrato, "vibrato found");
  assert.ok(Math.abs(vibrato.evidence.medianRateHz - 5) < 1, `rate ${vibrato.evidence.medianRateHz}`);
  assert.ok(!found.some((x) => x.name === "arpeggio"));
});

test("pitch slide: a monotone frequency change over many calls", () => {
  const ir = syntheticIr(60, (c) => (c === 1 ? [[4, 0x21], ...freqWrites(0, 2000)] : freqWrites(0, 2000 + c * 40)));
  assert.deepEqual(names(ir), ["pitch slide"]);
});

test("pulse width sweep: a monotone pulse width while the pulse waveform is selected, and not otherwise", () => {
  const sweep = (wave) => syntheticIr(60, (c) => (c === 1 ? [[4, wave | 1], ...freqWrites(0, A4)] : [[2, (c * 24) & 0xff], [3, (c * 24) >> 8]]));
  assert.deepEqual(names(sweep(0x40)), ["pulse width sweep"]);
  assert.deepEqual(names(sweep(0x20)), []);
});

test("filter sweep: cutoff moves while a voice is routed; routing alone is reported without a sweep", () => {
  const ir = syntheticIr(80, (c) => (c === 1 ? [[0x17, 0xf1], [0x18, 0x1f], [4, 0x21], ...freqWrites(0, A4)] : [[0x15, (c * 20) & 7], [0x16, (c * 20) >> 3]]));
  const t = techniquesFromIr(ir).find((x) => x.name === "filter sweep");
  assert.ok(t && t.evidence.swept === true, "sweep");
  assert.deepEqual(t.voices, [1]);
  assert.deepEqual(t.evidence.modes, ["lowpass"]);
  const still = syntheticIr(80, (c) => (c === 1 ? [[0x17, 0x91], [0x18, 0x1f], [4, 0x21], ...freqWrites(0, A4)] : freqWrites(0, A4)));
  const s = techniquesFromIr(still).find((x) => x.name === "filter sweep");
  assert.ok(s && s.evidence.swept === false);
});

test("sync, ring, test bit, noise and combined waveforms are read from the control register", () => {
  const ir = syntheticIr(40, (c) => (c === 1 ? [[4, 0x23], [11, 0x75], [18, 0x89], ...freqWrites(0, A4)] : freqWrites(0, A4)));
  const found = new Map(techniquesFromIr(ir).map((t) => [t.name, t.voices]));
  assert.deepEqual(found.get("oscillator sync"), [1]);
  assert.deepEqual(found.get("ring modulation"), [2]);
  assert.deepEqual(found.get("test bit"), [3]);
  assert.deepEqual(found.get("noise"), [3]);
  assert.deepEqual(found.get("combined waveforms"), [2]);
});

test("hard restart: a gate-off gap before each note with the envelope zeroed and then restored", () => {
  const ir = syntheticIr(90, (c) => {
    const k = (c - 1) % 12;
    if (k === 0) return [[5, 0x28], [6, 0xa4], [4, 0x41], ...freqWrites(0, A4)];
    if (k === 9) return [[4, 0x40]];
    if (k === 10) return [[5, 0], [6, 0]];
    return freqWrites(0, A4);
  });
  const t = techniquesFromIr(ir).find((x) => x.name === "hard restart");
  assert.ok(t, "hard restart found");
  assert.ok(t.evidence.edgesWithEnvelopeChange >= 3);
});

test("a hard restart is not reported for notes that follow each other without a gap or an envelope change", () => {
  const ir = syntheticIr(90, (c) => ((c - 1) % 12 === 0 ? [[5, 0x28], [6, 0xa4], [4, 0x41], ...freqWrites(0, A4 + c)] : (c - 1) % 12 === 6 ? [[4, 0x40]] : (c - 1) % 12 === 7 ? [[4, 0x41]] : freqWrites(0, A4)));
  assert.ok(!names(ir).includes("hard restart"));
});

test("independently written player fixtures: the techniques of each tune are found in its trace", { timeout: 180_000 }, async () => {
  const expected = {
    hardRestart: "hard restart", arpeggio: "arpeggio", vibrato: "vibrato", pulseSweep: "pulse width sweep", filterSweep: "filter sweep",
    sync: "oscillator sync", ring: "ring modulation", multispeed: "multispeed", nmiSampler: "sample playback", testBit: "test bit",
  };
  for (const [fixture, technique] of Object.entries(expected)) {
    const report = await analyzeSid(new Uint8Array(buildFixture(fixture).sid), { engine: sharedEngine(), seconds: 3 });
    assert.ok(report.techniques.some((t) => t.name === technique), `${fixture}: ${technique} in ${report.techniques.map((t) => t.name).join(", ")}`);
    const RAW = ["oscillator sync", "ring modulation", "test bit", "noise", "combined waveforms", "multispeed", "sample playback"];
    assert.ok(report.techniques.every((t) => t.source === "trace" && (RAW.includes(t.name) ? t.basis === "observed" : t.basis === "inferred" && /^threshold detector/.test(t.method))));
    checkMarks(report);
  }
});

test("CPU time of the technique detector grows linearly: 9,000 calls on three voices in well under a second", () => {
  const calls = 9_000;
  const ir = syntheticIr(calls, (c) => {
    const w = [];
    for (let v = 0; v < 3; v++) w.push([v * 7 + 4, (c % 20) < 15 ? 0x41 : 0x40], ...freqWrites(v, A4 + ((c * (v + 3)) % 90)), [v * 7 + 2, (c * 7) & 0xff]);
    w.push([0x15, c & 7], [0x16, (c >> 3) & 0xff], [0x17, 0xf7], [0x18, 0x1f]);
    return w;
  });
  const t0 = cpuMicros();
  techniquesFromIr(ir);
  const small = cpuMicros() - t0;
  assert.ok(small < 600_000, `${small} us of CPU time`);
  const bigIr = syntheticIr(calls * 4, (c) => [[4, (c % 20) < 15 ? 0x41 : 0x40], ...freqWrites(0, A4 + ((c * 3) % 90)), [2, (c * 7) & 0xff]]);
  const smallIr = syntheticIr(calls, (c) => [[4, (c % 20) < 15 ? 0x41 : 0x40], ...freqWrites(0, A4 + ((c * 3) % 90)), [2, (c * 7) & 0xff]]);
  const a = cpuMicros(); techniquesFromIr(smallIr); const ta = cpuMicros() - a;
  const b = cpuMicros(); techniquesFromIr(bigIr); const tb = cpuMicros() - b;
  assert.ok(tb < Math.max(ta, 20_000) * 10, `4x the calls took ${tb} us against ${ta} us (linear would be about 4x)`);
});
