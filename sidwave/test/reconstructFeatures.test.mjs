import test from "#test/runner";
import assert from "#test/assert";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { parseSidFile, writeSidFile } from "../src/sidFile.ts";
import { buildIr, IR_FRAME_CYCLES, IR_CLOCK_HZ } from "../src/reconstruct/ir.ts";
import {
  extractFeatures,
  featureBins,
  FEATURE_CODE_VERSION,
  headerFeatures,
  styleBins,
  styleFromSidflow,
  traceFeatures,
} from "../src/reconstruct/features.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";

const FRAME = IR_FRAME_CYCLES.PAL;
const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const cache = new Map();
function fixture(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      (async () => {
        const f = buildFixture(name);
        const trace = await engine.trace({ sid: f.sid, seconds: 2, maxRecords: 1_000_000 });
        const ir = buildIr(trace.records, { clock: trace.clock, horizonCycles: trace.horizonCycles, originCycle: trace.originCycle });
        const header = headerFeatures(parseSidFile(f.sid), 1);
        const features = extractFeatures(ir, header);
        return { ...f, ir, header, features, bins: featureBins(features) };
      })(),
    );
  }
  return cache.get(name);
}

test("feature code version is a positive integer", () => {
  assert.ok(Number.isInteger(FEATURE_CODE_VERSION) && FEATURE_CODE_VERSION >= 1);
});

test("header features: model, clock, SID count and speed", () => {
  const sid = (extra, speed = 0) =>
    parseSidFile(
      writeSidFile({
        magic: "PSID",
        version: 4,
        loadAddress: 0x1000,
        initAddress: 0x1000,
        playAddress: 0x1003,
        songs: 2,
        startSong: 1,
        speed,
        name: "x",
        author: "y",
        released: "z",
        payload: new Uint8Array([0x60, 0x60, 0x60, 0x60]),
        ...extra,
      }),
    );
  assert.deepEqual(headerFeatures(sid({ clock: "PAL+NTSC", sidModels: ["6581+8580", "unknown", "unknown"] }), 1), {
    magic: "PSID",
    model: "both",
    clock: "both",
    sidCount: 1,
    speed: "VBI",
  });
  const h = headerFeatures(
    sid({ clock: "NTSC", sidModels: ["8580", "8580", "8580"], secondSidAddress: 0xd420, thirdSidAddress: 0xd440 }, 2),
    2,
  );
  assert.deepEqual(h, { magic: "PSID", model: "8580", clock: "NTSC", sidCount: 3, speed: "CIA" });
  assert.equal(headerFeatures(sid({}, 2), 1).speed, "VBI");
  assert.equal(headerFeatures(sid({}), 1).model, "unknown");
});

test("hard restart fixture: 17 gate-ons, 16 of them after a hard restart, two distinct note programs", async () => {
  const { features, bins } = await fixture("hardRestart");
  const t = features.trace;
  assert.equal(t.gateOns, 17);
  assert.equal(t.hardRestarts, 16);
  assert.equal(t.hardRestartRate, 16 / 17);
  assert.equal(t.testBitWrites, 16);
  assert.equal(t.notePrograms.distinct, 2);
  assert.equal(t.callsPerFrame, 1);
  assert.equal(t.writesPerCall, 2);
  assert.ok(bins.includes("hr:most"));
  assert.ok(bins.includes("testbit"));
  assert.ok(bins.includes("wave:pulse"));
});

test("fixtures without hard restart have one gate-on per voice and no hard restart bin", async () => {
  for (const name of ["arpeggio", "vibrato", "pulseSweep", "filterSweep", "multispeed", "testBit", "nmiSampler"]) {
    const { features, bins } = await fixture(name);
    assert.equal(features.trace.gateOns, 1, name);
    assert.equal(features.trace.hardRestarts, 0, name);
    assert.ok(bins.includes("hr:none"), name);
  }
});

test("filter sweep fixture: voice 1 routed through a low-pass filter in every call", async () => {
  const { features, bins } = await fixture("filterSweep");
  assert.deepEqual(features.trace.filterRoutedShare, [1, 0, 0]);
  assert.deepEqual(features.trace.filterModeCalls, { lp: 101, bp: 0, hp: 0 });
  assert.equal(features.trace.filterMultiModeCalls, 0);
  assert.ok(bins.includes("filter:v1") && bins.includes("filter:lp"));
  assert.ok(!bins.includes("filter:v2") && !bins.includes("filter:bp") && !bins.includes("filter:multimode"));
});

test("sync, ring and test-bit fixtures set exactly their own bin", async () => {
  const sync = await fixture("sync");
  assert.equal(sync.features.trace.syncWrites, 101);
  assert.ok(sync.bins.includes("sync") && !sync.bins.includes("ring") && !sync.bins.includes("testbit"));
  assert.ok(sync.bins.includes("wave:sawtooth"));
  const ring = await fixture("ring");
  assert.equal(ring.features.trace.ringWrites, 101);
  assert.ok(ring.bins.includes("ring") && !ring.bins.includes("sync"));
  assert.ok(ring.bins.includes("wave:triangle"));
  const test = await fixture("testBit");
  assert.equal(test.features.trace.testBitWrites, 25);
  assert.ok(test.bins.includes("testbit") && !test.bins.includes("sync"));
});

test("multispeed, two SID and sample fixtures set their header and trace bins", async () => {
  const multi = await fixture("multispeed");
  assert.deepEqual(multi.header, { magic: "PSID", model: "6581", clock: "PAL", sidCount: 1, speed: "CIA" });
  assert.ok(multi.bins.includes("cpf:2") && multi.bins.includes("speed:cia"));
  const two = await fixture("twoSids");
  assert.equal(two.header.sidCount, 2);
  assert.ok(two.bins.includes("sids:2"));
  const nmi = await fixture("nmiSampler");
  assert.equal(nmi.features.trace.sampleWrites, 7978);
  assert.ok(nmi.features.trace.sampleShare > 0.97);
  assert.ok(nmi.bins.includes("sample:heavy"));
  assert.ok(multi.bins.includes("sample:none"));
});

test("bins are sorted and unique", async () => {
  const { bins } = await fixture("hardRestart");
  assert.deepEqual(bins, [...new Set(bins)].sort());
  assert.ok(bins.includes("magic:PSID") && bins.includes("model:6581") && bins.includes("clock:PAL"));
});

// ---- synthetic IRs --------------------------------------------------------------------------------------------

const hz = IR_CLOCK_HZ.PAL;
function irOf(callWrites) {
  const writes = [];
  callWrites.forEach((list, i) => list.forEach(([sid, reg, value], k) => writes.push([sid, reg, value, 1000 + i * FRAME + k * 10])));
  return buildIr(new Float64Array(writes.flat()), { clock: "PAL" });
}
const lo = (v) => v & 0xff;
const hi = (v) => v >> 8;

/** Three ten-call notes; call k of a note writes the frequency, k = 0 starts the note, k = 8 releases it. */
function notes(freqs, mod = () => 0) {
  const calls = [];
  freqs.forEach((f, n) => {
    for (let k = 0; k < 10; k++) {
      const freq = f + mod(n, k);
      const w = [[0, 0, lo(freq)], [0, 1, hi(freq)]];
      if (k === 0) w.push([0, 5, 0x09], [0, 6, 0xa0], [0, 4, 0x41]);
      if (k === 8) w.push([0, 4, 0x40]);
      calls.push(w);
    }
  });
  return calls;
}

test("note programs are equal after base-note normalisation and differ for a different modulation", () => {
  const same = traceFeatures(irOf(notes([0x1000, 0x2000, 0x1000])));
  assert.equal(same.gateOns, 3);
  assert.equal(same.notePrograms.distinct, 1);
  const varied = traceFeatures(irOf(notes([0x1000, 0x2000, 0x1000], (n, k) => (n === 2 && k === 3 ? 16 : 0))));
  assert.equal(varied.notePrograms.distinct, 2);
  // The last write is at cycle 1000 + 29 frames + 10; the origin is cycle 0.
  assert.equal(varied.seconds, (1000 + 29 * FRAME + 10) / hz);
  assert.equal(varied.notePrograms.perMinute, 2 / (varied.seconds / 60));
  // Setting the instrument in the call that starts the note is not a hard restart, even after a release.
  assert.equal(varied.hardRestarts, 0);
});

test("a gate-on within three calls of a gate-off and after an ADSR write is a hard restart; the test bit also counts", () => {
  const calls = [];
  for (let n = 0; n < 4; n++) {
    for (let k = 0; k < 8; k++) {
      const w = [[0, 0, n]];
      if (k === 0) w.push([0, 4, 0x41]);
      if (k === 4) w.push([0, 4, 0x40]);
      if (k === 5 && n % 2 === 0) w.push([0, 5, 0x00]);
      if (k === 5 && n % 2 === 1) w.push([0, 4, 0x08]);
      if (k === 6 && n === 3) w.push([0, 4, 0x08]);
      calls.push(w);
    }
  }
  const t = traceFeatures(irOf(calls));
  assert.equal(t.gateOns, 4);
  // Gate-ons of notes 2, 3 and 4 follow a gate-off by 4 calls (k = 4 to k = 0 of the next note): too far.
  assert.equal(t.hardRestarts, 0);
  const near = [];
  for (let n = 0; n < 3; n++) {
    for (let k = 0; k < 4; k++) {
      const w = [[0, 0, n]];
      if (k === 0) w.push([0, 4, 0x41]);
      if (k === 2) w.push([0, 4, 0x40]);
      if (k === 3) w.push([0, 5, 0x00]);
      near.push(w);
    }
  }
  const h = traceFeatures(irOf(near));
  assert.equal(h.gateOns, 3);
  assert.equal(h.hardRestarts, 2);
  assert.equal(h.hardRestartRate, 2 / 3);
});

test("intro length is the time of the first window that repeats", () => {
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
  const unique = (n) => Array.from({ length: n }, () => [[0, 0, next() & 0xff], [0, 1, next() & 0xff]]);
  const pattern = unique(150);
  const calls = [...unique(100), ...pattern, ...pattern, ...pattern.slice(0, 60)];
  const ir = buildIr(new Float64Array(calls.flatMap((list, i) => list.map(([s, r, v], k) => [s, r, v, 1000 + i * FRAME + k * 10])).flat()), { clock: "PAL" });
  const t = traceFeatures(ir);
  assert.equal(t.repeats, true);
  assert.equal(t.introSeconds, (100 * FRAME) / hz);
  // Without repetition the intro covers the whole time.
  const none = buildIr(new Float64Array(unique(300).flatMap((list, i) => list.map(([s, r, v], k) => [s, r, v, 1000 + i * FRAME + k * 10])).flat()), { clock: "PAL" });
  const n = traceFeatures(none);
  assert.equal(n.repeats, false);
  assert.equal(n.introSeconds, none.seconds);
  // Silence repeats trivially and is not a repetition.
  const flat = irOf(Array.from({ length: 400 }, () => [[0, 0, 0]]));
  assert.equal(traceFeatures(flat).repeats, false);
});

test("bins follow the thresholds", () => {
  const t = {
    calls: 1000,
    seconds: 20,
    callsPerFrame: 3,
    callsPerFrameExact: 3,
    writesPerCall: 30,
    irregularShare: 0,
    syncWrites: 3,
    ringWrites: 2,
    testBitWrites: 3,
    waveformWrites: { 1: 5, 2: 2, 4: 3, 5: 3, 8: 7 },
    filterRoutedShare: [0.06, 0.04, 1],
    filterModeCalls: { lp: 50, bp: 49, hp: 0 },
    filterMultiModeCalls: 50,
    gateOns: 10,
    hardRestarts: 5,
    hardRestartRate: 0.5,
    notePrograms: { distinct: 100, perMinute: 300 },
    sampleWrites: 10,
    sampleShare: 0.2,
    introSeconds: 30,
    repeats: true,
  };
  const bins = featureBins({ trace: t });
  assert.deepEqual(bins, [
    "cpf:3-4",
    "filter:lp",
    "filter:multimode",
    "filter:v1",
    "filter:v3",
    "hr:some",
    "intro:long",
    "sample:some",
    "sync",
    "tables:high",
    "testbit",
    "wave:combined",
    "wave:noise",
    "wave:pulse",
    "wave:triangle",
    "wpc:high",
  ]);
  const low = featureBins({
    trace: { ...t, callsPerFrame: 0, writesPerCall: 7, syncWrites: 2, gateOns: 3, hardRestartRate: 1, introSeconds: 7.9, sampleShare: 0.21, notePrograms: { distinct: 1, perMinute: 19.9 }, waveformWrites: {}, filterRoutedShare: [0, 0, 0], filterModeCalls: { lp: 0, bp: 0, hp: 0 }, filterMultiModeCalls: 0, testBitWrites: 0, ringWrites: 0 },
  });
  assert.deepEqual(low, ["cpf:slow", "hr:none", "intro:short", "sample:heavy", "tables:low", "wpc:low"]);
});

test("style features are read from a SIDFlow record and binned", () => {
  const style = styleFromSidflow({
    bpm: 169.5,
    sidArpeggioActivity: 0.2,
    sidPwmActivity: 0.0299,
    sidFilterMotion: 0.15,
    sidPolyphonyMean: 0.6,
    sidAdsrPluckRatio: 0.36,
    sidTonalVariant: "tonal",
    sidKeyIsMinor: 1,
    other: "x",
  });
  assert.deepEqual(style, {
    bpm: 169.5,
    arpeggio: 0.2,
    pwm: 0.0299,
    filterMotion: 0.15,
    polyphony: 0.6,
    pluck: 0.36,
    tonal: true,
    keyIsMinor: true,
  });
  assert.deepEqual(styleBins(style), [
    "style:arpeggio",
    "style:dense",
    "style:filter-motion",
    "style:minor",
    "style:pluck",
    "style:tempo-fast",
  ]);
  const quiet = styleFromSidflow({ bpm: 89.9, sidPolyphonyMean: 0.19, sidTonalVariant: "insufficient", sidKeyIsMinor: 0, sidPwmActivity: 0.03 });
  assert.deepEqual(styleBins(quiet), ["style:pwm", "style:sparse", "style:tempo-slow"]);
  assert.deepEqual(styleBins(styleFromSidflow({ bpm: 150, sidTonalVariant: "tonal", sidKeyIsMinor: 0 })), ["style:major", "style:tempo-mid"]);
  assert.deepEqual(styleBins({}), []);
});
