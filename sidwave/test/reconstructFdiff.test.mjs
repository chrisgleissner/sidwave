import test from "#test/runner";
import assert from "#test/assert";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { buildIr, IR_FRAME_CYCLES } from "../src/reconstruct/ir.ts";
import { fdiff, registerClass, REGISTER_CLASSES } from "../src/reconstruct/fdiff.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";

const FRAME = IR_FRAME_CYCLES.PAL;
/** Builds an IR from calls given as lists of [sid, register, value]; call i starts at 1000 + i * FRAME + shift[i]. */
function make(calls, shift = {}) {
  const writes = [];
  calls.forEach((call, i) => {
    call.forEach(([sid, reg, value], k) => writes.push([sid, reg, value, 1000 + i * FRAME + (shift[i] ?? 0) + k * 10]));
  });
  return buildIr(new Float64Array(writes.flat()), { clock: "PAL" });
}
const base = () => [
  [[0, 0, 1], [0, 4, 0x41], [0, 5, 0x09], [0, 24, 0x0f]],
  [[0, 0, 2], [0, 7, 0x10]],
  [[0, 0, 3], [0, 7, 0x20]],
  [[0, 0, 4], [0, 7, 0x30]],
];
const edited = (change) => {
  const calls = base().map((c) => c.map((w) => [...w]));
  change(calls);
  return calls;
};

test("registerClass maps every register to its class", () => {
  const classes = Array.from({ length: 25 }, (_, r) => registerClass(r));
  assert.deepEqual(classes.slice(0, 7), ["pitch", "pitch", "pulse", "pulse", "waveform", "adsr", "adsr"]);
  assert.deepEqual(classes.slice(7, 14), classes.slice(0, 7));
  assert.deepEqual(classes.slice(14, 21), classes.slice(0, 7));
  assert.deepEqual(classes.slice(21), ["filter", "filter", "filter", "volume"]);
  assert.throws(() => registerClass(25), /outside/);
  assert.deepEqual([...REGISTER_CLASSES], ["pitch", "gate", "waveform", "pulse", "adsr", "filter", "volume", "timing"]);
});

test("equal IRs have no difference and a match share of one in every class", () => {
  const result = fdiff(make(base()), make(base()));
  assert.equal(result.equal, true);
  assert.equal(result.first, undefined);
  assert.deepEqual(result.firsts, []);
  assert.deepEqual(result.alignment, { expectedCall: 0, observedCall: 0, compared: 4, expectedCalls: 4, observedCalls: 4 });
  for (const cls of REGISTER_CLASSES) {
    assert.equal(result.classes[cls].matchShare, 1);
    assert.equal(result.classes[cls].differingCalls, 0);
  }
  assert.equal(result.maxCumulativeOffsetCycles, 0);
});

test("a pitch difference in voice 2 names call, time, SID, voice, register, expected and observed", () => {
  const result = fdiff(make(base()), make(edited((c) => (c[2][1][2] = 0x11))));
  assert.equal(result.equal, false);
  assert.deepEqual(result.first, {
    class: "pitch",
    call: 2,
    cycle: 1000 + 2 * FRAME,
    timeSeconds: (2 * FRAME) / 985_248,
    sid: 0,
    voice: 2,
    register: 7,
    expected: 0x20,
    observed: 0x11,
  });
  assert.equal(result.classes.pitch.matchShare, 0.75);
  assert.equal(result.classes.pitch.differingCalls, 1);
  assert.equal(result.classes.gate.matchShare, 1);
  assert.deepEqual(result.classes.pitch.first, result.first);
});

test("gate, test bit and waveform differences are separate classes with masked values", () => {
  const gate = fdiff(make(base()), make(edited((c) => (c[1].push([0, 4, 0x40])))));
  assert.deepEqual(
    [gate.first.class, gate.first.call, gate.first.voice, gate.first.register, gate.first.expected, gate.first.observed],
    ["gate", 1, 1, 4, 0x01, 0x00],
  );
  const wave = fdiff(make(base()), make(edited((c) => (c[2].push([0, 4, 0x21])))));
  assert.deepEqual(
    [wave.first.class, wave.first.call, wave.first.expected, wave.first.observed],
    ["waveform", 2, 0x40, 0x20],
  );
  assert.equal(wave.classes.gate.matchShare, 1);
  // Voice 3 control is register 18; the test bit belongs to the gate class.
  const expected = edited((c) => c[1].push([0, 18, 0x49]));
  const observed = edited((c) => c[1].push([0, 18, 0x41]));
  const test = fdiff(make(expected), make(observed));
  assert.deepEqual(
    [test.first.class, test.first.voice, test.first.register, test.first.expected, test.first.observed],
    ["gate", 3, 18, 0x09, 0x01],
  );
  // The observed waveform byte stays 0x21 in call 3, which writes no control register.
  assert.equal(wave.classes.waveform.differingCalls, 2);
  assert.equal(wave.classes.waveform.matchShare, 0.5);
});

test("in-call control order is compared when the final control value is equal", () => {
  const expected = edited((c) => c[1].push([0, 4, 0x49], [0, 4, 0x41]));
  const observed = edited((c) => c[1].push([0, 4, 0x41]));
  const result = fdiff(make(expected), make(observed));
  assert.equal(result.first.class, "gate");
  assert.equal(result.first.call, 1);
  assert.equal(result.first.expected, 0x09);
  assert.equal(result.first.observed, 0x01);
  assert.match(result.first.detail, /in-call control write 1: 2 expected, 1 observed/);
  // A different waveform in the first of two writes is a waveform difference.
  const w = fdiff(
    make(edited((c) => c[1].push([0, 4, 0x21], [0, 4, 0x41]))),
    make(edited((c) => c[1].push([0, 4, 0x41], [0, 4, 0x41]))),
  );
  assert.equal(w.first.class, "waveform");
  assert.equal(w.first.expected, 0x20);
  assert.equal(w.first.observed, 0x40);
});

test("pulse, ADSR, filter and volume differences are classified", () => {
  const pulse = fdiff(make(edited((c) => c[1].push([0, 3, 8]))), make(edited((c) => c[1].push([0, 3, 9]))));
  assert.deepEqual([pulse.first.class, pulse.first.register, pulse.first.voice], ["pulse", 3, 1]);
  const adsr = fdiff(make(edited((c) => c[1].push([0, 13, 0xf0]))), make(edited((c) => c[1].push([0, 13, 0xf1]))));
  assert.deepEqual([adsr.first.class, adsr.first.register, adsr.first.voice], ["adsr", 13, 2]);
  const filter = fdiff(make(edited((c) => c[2].push([0, 0x17, 0xf1]))), make(edited((c) => c[2].push([0, 0x17, 0xf2]))));
  assert.deepEqual([filter.first.class, filter.first.register, filter.first.voice, filter.first.call], ["filter", 0x17, undefined, 2]);
  const mode = fdiff(make(edited((c) => c[1].push([0, 0x18, 0x1f]))), make(edited((c) => c[1].push([0, 0x18, 0x2f]))));
  assert.deepEqual([mode.first.class, mode.first.expected, mode.first.observed], ["filter", 0x10, 0x20]);
  assert.equal(mode.classes.volume.matchShare, 1);
  const volume = fdiff(make(edited((c) => c[1].push([0, 0x18, 0x0f]))), make(edited((c) => c[1].push([0, 0x18, 0x0e]))));
  assert.deepEqual([volume.first.class, volume.first.expected, volume.first.observed], ["volume", 0x0f, 0x0e]);
  // Registers of another SID are reported with that SID.
  const second = fdiff(make(edited((c) => c[1].push([1, 0, 5]))), make(edited((c) => c[1].push([1, 0, 6]))));
  assert.deepEqual([second.first.sid, second.first.register, second.first.class], [1, 0, "pitch"]);
});

test("the first difference is kept per class, SID and voice and listed by time", () => {
  const observed = edited((c) => {
    c[3][1][2] = 0x31; // voice 2 pitch, call 3
    c[2][0][2] = 0x13; // voice 1 pitch, call 2
    c[1].push([0, 6, 0x11]); // voice 1 SR, call 1
  });
  const result = fdiff(make(base()), make(observed));
  assert.deepEqual(
    result.firsts.map((d) => [d.class, d.call, d.voice]),
    [
      ["adsr", 1, 1],
      ["pitch", 2, 1],
      ["pitch", 3, 2],
    ],
  );
  assert.deepEqual(result.first, result.firsts[0]);
  assert.equal(result.classes.pitch.differingCalls, 2);
  assert.equal(result.classes.pitch.matchShare, 0.5);
  assert.equal(result.classes.adsr.differingCalls, 3);
});

test("call spacing, cumulative offset and call count are timing differences", () => {
  const shifted = fdiff(make(base()), make(base(), { 2: 500 }));
  assert.deepEqual(
    [shifted.first.class, shifted.first.call, shifted.first.expected, shifted.first.observed, shifted.first.detail],
    ["timing", 2, FRAME, FRAME + 500, "call spacing in cycles"],
  );
  assert.equal(shifted.maxCumulativeOffsetCycles, 500);
  assert.equal(shifted.classes.timing.differingCalls, 2);
  assert.equal(shifted.classes.pitch.matchShare, 1);
  // A shift inside the tolerance of 1 percent of the period is not a difference.
  assert.equal(fdiff(make(base()), make(base(), { 2: 150 })).equal, true);
  // Drift of 150 cycles per call stays within the spacing tolerance but exceeds half a frame in total.
  const calls = Array.from({ length: 80 }, (_, i) => [[0, 0, i & 0xff]]);
  const drift = {};
  for (let i = 0; i < 80; i++) drift[i] = i * 150;
  const slow = fdiff(make(calls), make(calls, drift));
  assert.equal(slow.first.call, 66);
  assert.equal(slow.first.detail, "cumulative call offset in cycles");
  assert.equal(slow.first.observed, 66 * 150);
  // A missing call.
  const missing = fdiff(make(base()), make(base().slice(0, 3)));
  assert.deepEqual(
    [missing.first.class, missing.first.call, missing.first.expected, missing.first.observed, missing.first.detail],
    ["timing", 3, 4, 3, "number of calls"],
  );
  assert.equal(missing.equal, false);
  assert.equal(missing.classes.timing.comparedCalls, 3);
});

test("alignment skips leading calls and tolerates registers written in a different set", () => {
  const withLead = [[[0, 24, 0x0f]], ...base()];
  const result = fdiff(make(base()), make(withLead), { alignObserved: 1 });
  assert.equal(result.equal, true);
  assert.equal(result.alignment.compared, 4);
  assert.equal(result.alignment.observedCalls, 5);
  assert.throws(() => fdiff(make(base()), make(base()), { alignExpected: -1 }), /nonnegative/);
  // Same state reached with a redundant write: only the written-set counter reports it.
  const redundant = edited((c) => c[1].push([0, 5, 0x09]));
  const r = fdiff(make(base()), make(redundant));
  assert.equal(r.equal, true);
  assert.equal(r.writtenSetMismatchCalls, 1);
});

// ---- fixtures ------------------------------------------------------------------------------------------------

const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
async function fixtureIr(name) {
  const f = buildFixture(name);
  const trace = await engine.trace({ sid: f.sid, seconds: 2, maxRecords: 1_000_000 });
  return buildIr(trace.records, { clock: trace.clock, horizonCycles: trace.horizonCycles, originCycle: trace.originCycle });
}

test("F-diff of a fixture against itself is empty, against another fixture it names the first pitch difference", async () => {
  const arpeggio = await fixtureIr("arpeggio");
  const vibrato = await fixtureIr("vibrato");
  assert.equal(fdiff(arpeggio, arpeggio).equal, true);
  const result = fdiff(arpeggio, vibrato);
  // Both play $1167 in play call 0; play call 1 is $15E8 against $116D.
  assert.deepEqual(
    [result.first.class, result.first.call, result.first.sid, result.first.voice, result.first.register, result.first.expected, result.first.observed],
    ["pitch", 2, 0, 1, 0, 0xe8, 0x6d],
  );
  assert.equal(result.classes.adsr.matchShare, 1);
  assert.equal(result.classes.gate.matchShare, 1);
  assert.equal(result.classes.timing.matchShare, 1);
  // 100 play calls: arpeggio frequency low byte E8, 9C, 67 against 6D, 71, 67, 61, 67, ...
  assert.ok(result.classes.pitch.differingCalls > 50);
});

test("F-diff separates a hard restart player from a player without gate changes", async () => {
  const hardRestart = await fixtureIr("hardRestart");
  const testBit = await fixtureIr("testBit");
  const result = fdiff(hardRestart, testBit);
  assert.equal(result.equal, false);
  assert.ok(result.classes.gate.differingCalls > 0);
  assert.ok(result.classes.adsr.differingCalls > 0);
  assert.equal(result.classes.filter.matchShare, 1);
  assert.equal(result.classes.volume.matchShare, 1);
});
