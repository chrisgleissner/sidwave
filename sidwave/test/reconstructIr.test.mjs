import test from "#test/runner";
import assert from "#test/assert";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { buildIr, controlRegister, IR_FRAME_CYCLES } from "../src/reconstruct/ir.ts";
import { buildFixture, FIXTURE_NAMES, TABLES } from "./helpers/reconstructFixtures.mjs";

const packed = (writes) => new Float64Array(writes.flat());
const FRAME = IR_FRAME_CYCLES.PAL;
const ALL_REGISTERS = 0x1ffffff;

// ---- synthetic traces ---------------------------------------------------------------------------------------------

test("buildIr groups a hand-made trace into calls with exact per-call state, written sets and control order", () => {
  // Call 0 at cycle 1000, call 1 at 1000 + FRAME, call 2 at 1000 + 2 * FRAME + 10 (jitter of 10 cycles).
  const ir = buildIr(
    packed([
      [0, 4, 0x08, 1000],
      [0, 4, 0x41, 1010],
      [0, 0, 0x34, 1020],
      [1, 7, 0x12, 1030],
      [0, 4, 0x40, 1000 + FRAME],
      [0, 5, 0x09, 1010 + FRAME],
      [1, 11, 0x11, 1020 + FRAME],
      [0, 4, 0x41, 1010 + 2 * FRAME],
      [0, 24, 0x0f, 1020 + 2 * FRAME],
    ]),
    { clock: "PAL" },
  );
  assert.equal(ir.calls.length, 3);
  assert.equal(ir.sidCount, 2);
  assert.equal(ir.totalWrites, 9);
  assert.deepEqual(
    ir.calls.map((c) => [c.index, c.startCycle, c.endCycle, c.writes]),
    [
      [0, 1000, 1030, 4],
      [1, 1000 + FRAME, 1020 + FRAME, 3],
      [2, 1010 + 2 * FRAME, 1020 + 2 * FRAME, 2],
    ],
  );
  // Call 0.
  assert.deepEqual(ir.calls[0].sids[0].control, [[0x08, 0x41], [], []]);
  assert.equal(ir.calls[0].sids[0].written, (1 << 4) | (1 << 0));
  assert.equal(ir.calls[0].sids[0].regs[0], 0x34);
  assert.equal(ir.calls[0].sids[0].regs[4], 0x41);
  assert.equal(ir.calls[0].sids[1].regs[7], 0x12);
  assert.equal(ir.calls[0].sids[1].written, 1 << 7);
  assert.deepEqual(ir.calls[0].sids[1].control, [[], [], []]);
  // Call 1: the register state carries over; SID 1 voice 2 control is register 11.
  assert.equal(ir.calls[1].sids[0].regs[0], 0x34);
  assert.equal(ir.calls[1].sids[0].regs[4], 0x40);
  assert.equal(ir.calls[1].sids[0].regs[5], 0x09);
  assert.equal(ir.calls[1].sids[0].written, (1 << 4) | (1 << 5));
  assert.deepEqual(ir.calls[1].sids[0].control, [[0x40], [], []]);
  assert.deepEqual(ir.calls[1].sids[1].control, [[], [0x11], []]);
  assert.equal(ir.calls[1].sids[1].regs[7], 0x12);
  // Call 2: SID 1 is not written, so it shares the register array of the previous call.
  assert.equal(ir.calls[2].sids[1].written, 0);
  assert.equal(ir.calls[2].sids[1].regs, ir.calls[1].sids[1].regs);
  assert.equal(ir.calls[2].sids[0].regs[24], 0x0f);
  assert.equal(ir.calls[2].sids[0].regs.length, 25);
  // Timing: spacings are FRAME and FRAME + 10, so the median period is FRAME + 5.
  assert.equal(ir.periodCycles, FRAME + 5);
  assert.equal(ir.callsPerFrame, 1);
  assert.equal(ir.jitter.jitterCycles, 5);
  assert.equal(ir.jitter.irregularSpacings, 0);
  assert.equal(ir.unsupported.writes, 0);
  assert.equal(controlRegister(2), 18);
});

test("buildIr reports call spacing jitter, irregular spacings and calls per frame", () => {
  const starts = [0, 9828, 19656, 29484 + 600, 39312, 49140];
  const ir = buildIr(packed(starts.map((c, i) => [0, 0, i, c])), { clock: "PAL" });
  assert.equal(ir.calls.length, 6);
  assert.equal(ir.periodCycles, 9828);
  assert.equal(ir.callsPerFrame, 2);
  assert.equal(ir.callsPerFrameExact, 2);
  // Spacings: 9828, 9828, 10428, 9228, 9828; the median is 9828 and the tolerance 98 cycles.
  assert.equal(ir.jitter.toleranceCycles, 98);
  assert.equal(ir.jitter.irregularSpacings, 2);
  assert.equal(ir.jitter.irregularShare, 0.4);
  assert.equal(ir.jitter.maxDeviationCycles, 600);
  assert.equal(ir.jitter.jitterCycles, 0);
});

test("buildIr removes dense sample writes and reports their rate and share", () => {
  const writes = [];
  for (let i = 0; i < 6; i++) writes.push([0, 0, i, 5000 + i * FRAME]);
  // 100 writes to $D418 every 250 cycles, from cycle 40,000 (a sample played between two calls).
  for (let i = 0; i < 100; i++) writes.push([0, 24, i & 15, 40_000 + i * 250]);
  writes.sort((a, b) => a[3] - b[3]);
  const ir = buildIr(packed(writes), { clock: "PAL", originCycle: 0, horizonCycles: 6 * FRAME });
  assert.equal(ir.calls.length, 6);
  assert.equal(ir.totalWrites, 106);
  assert.equal(ir.unsupported.writes, 100);
  assert.equal(ir.unsupported.share, 100 / 106);
  assert.equal(ir.unsupported.ratePerSecond, 100 / ((6 * FRAME) / 985_248));
  assert.deepEqual(ir.unsupported.streams, [
    {
      sid: 0,
      register: 24,
      writes: 100,
      runs: 1,
      firstCycle: 40_000,
      lastCycle: 40_000 + 99 * 250,
      ratePerSecond: 100 / ((6 * FRAME) / 985_248),
    },
  ]);
  assert.equal(ir.periodCycles, FRAME);
  for (const call of ir.calls) assert.equal(call.sids[0].regs[24], 0);
  // Fewer than 32 dense writes stay in the call structure.
  const short = buildIr(packed(writes.filter((w) => w[1] !== 24 || w[3] < 40_000 + 20 * 250)), { clock: "PAL" });
  assert.equal(short.unsupported.writes, 0);
});

test("buildIr ignores writes to $D419-$D41F and counts them", () => {
  const ir = buildIr(packed([[0, 0, 1, 100], [0, 0x19, 7, 110], [0, 0x1f, 8, 120], [0, 1, 2, 130], [0, 0x1c, 9, 999_999]]), {
    horizonCycles: 500,
  });
  assert.equal(ir.ignoredWrites, 2);
  assert.equal(ir.totalWrites, 2);
  assert.equal(ir.calls.length, 1);
  assert.equal(ir.calls[0].writes, 2);
  assert.equal(ir.calls[0].sids[0].written, 0b11);
  assert.equal(buildIr(packed([[0, 0, 1, 100]])).ignoredWrites, 0);
  // Higher offsets are still rejected as invalid traces.
  assert.throws(() => buildIr(packed([[0, 0x20, 1, 100]])), /Invalid SID write/);
});

test("buildIr validates its options and traces", () => {
  assert.throws(() => buildIr(new Float64Array(3)), /groups of four/);
  assert.throws(() => buildIr(new Float64Array(0), { clock: "SECAM" }), /PAL or NTSC/);
  assert.throws(() => buildIr(new Float64Array(0), { burstGapCycles: 0 }), /at least 1/);
  assert.throws(() => buildIr(packed([[1, 0, 0, 0]]), { sidCount: 1 }), /SID 1/);
  const empty = buildIr(new Float64Array(0), { clock: "NTSC" });
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.callsPerFrame, 0);
  assert.equal(empty.frameCycles, 17_095);
  assert.deepEqual(empty.warnings, ["no periodic call found"]);
  const ignored = buildIr(packed([[0, 0, 1, 10], [0, 0, 2, 900_000]]), { horizonCycles: 100 });
  assert.equal(ignored.totalWrites, 1);
});

// ---- synthetic players, traced on SIDLite -----------------------------------------------------------------------

const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const cache = new Map();
/** IR and raw trace of a fixture, 2 seconds of PAL. Call 0 is the init routine, call f + 1 is play call f. */
function fixture(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      (async () => {
        const f = buildFixture(name);
        const trace = await engine.trace({ sid: f.sid, seconds: 2, maxRecords: 1_000_000 });
        const ir = buildIr(trace.records, { clock: trace.clock, horizonCycles: trace.horizonCycles, originCycle: trace.originCycle });
        return { ...f, trace, ir };
      })(),
    );
  }
  return cache.get(name);
}

const lo = (v) => v & 0xff;
const hi = (v) => (v >> 8) & 0xff;
/** Asserts expected register values of play call f. */
function assertPlay(ir, f, expected, label) {
  const regs = ir.calls[f + 1].sids[0].regs;
  for (const [r, v] of Object.entries(expected)) {
    assert.equal(regs[Number(r)], v, `${label} play call ${f} register ${r}`);
  }
}

test("every fixture assembles and produces one init call plus periodic play calls", async () => {
  assert.deepEqual(FIXTURE_NAMES, [
    "hardRestart",
    "arpeggio",
    "vibrato",
    "pulseSweep",
    "filterSweep",
    "sync",
    "ring",
    "multispeed",
    "twoSids",
    "testBit",
    "nmiSampler",
  ]);
  for (const name of FIXTURE_NAMES) {
    const { ir, trace } = await fixture(name);
    assert.equal(trace.droppedRecords, 0);
    const multispeed = name === "multispeed";
    assert.equal(ir.callsPerFrame, multispeed ? 2 : 1, `${name} calls per frame`);
    assert.equal(ir.calls.length, multispeed ? 200 : 101, `${name} calls`);
    const nominal = multispeed ? 9828 : FRAME;
    assert.ok(Math.abs(ir.periodCycles - nominal) <= 4, `${name} period ${ir.periodCycles}`);
    assert.ok(ir.jitter.jitterCycles <= 50, `${name} jitter ${ir.jitter.jitterCycles}`);
    // The only irregular spacing is the one between the init call and the first play call.
    assert.equal(ir.jitter.irregularSpacings, 1, `${name} irregular spacings`);
    assert.ok(Math.abs(ir.calls[1].startCycle - ir.calls[0].startCycle - nominal) > ir.jitter.toleranceCycles);
    assert.equal(ir.sidCount, name === "twoSids" ? 2 : 1);
    assert.deepEqual(ir.warnings, []);
    if (name !== "nmiSampler") assert.equal(ir.unsupported.writes, 0, `${name} unsupported`);
  }
});

test("hard restart fixture: gate, test bit and ADSR sequence of every six-call note", async () => {
  const { ir } = await fixture("hardRestart");
  for (let f = 0; f < 100; f++) {
    const k = f % 6;
    const note = TABLES.hardRestartNotes[Math.floor(f / 6) % 2];
    assertPlay(
      ir,
      f,
      {
        0: lo(note),
        1: hi(note),
        2: 0,
        3: 8,
        4: [0x41, 0x41, 0x41, 0x41, 0x40, 0x08][k],
        5: k === 5 ? 0 : 0x09,
        6: k === 5 ? 0 : 0xa0,
        0x18: 0x0f,
      },
      "hardRestart",
    );
    const call = ir.calls[f + 1].sids[0];
    assert.deepEqual(call.control, [k === 0 ? [0x41] : k === 4 ? [0x40] : k === 5 ? [0x08] : [], [], []], `control ${f}`);
    const written = 0b11 | (k === 0 ? 0b1110000 : k === 4 ? 0b10000 : k === 5 ? 0b1110000 : 0);
    assert.equal(call.written, written, `written ${f}`);
  }
  // The init routine clears all 25 registers.
  assert.equal(ir.calls[0].sids[0].written, ALL_REGISTERS);
});

test("arpeggio fixture: voice 1 steps through three frequencies and nothing else changes", async () => {
  const { ir } = await fixture("arpeggio");
  assert.deepEqual(ir.calls[0].sids[0].control, [[0, 0x11], [0], [0]]);
  for (let f = 0; f < 100; f++) {
    const note = TABLES.arpeggio[f % 3];
    assertPlay(ir, f, { 0: lo(note), 1: hi(note), 4: 0x11, 5: 0x09, 6: 0xf0 }, "arpeggio");
    assert.equal(ir.calls[f + 1].sids[0].written, 0b11);
    assert.deepEqual(ir.calls[f + 1].sids[0].control, [[], [], []]);
  }
});

test("vibrato fixture: frequency follows the eight-entry table", async () => {
  const { ir } = await fixture("vibrato");
  for (let f = 0; f < 100; f++) {
    const value = TABLES.vibratoBase + TABLES.vibratoOffsets[f % 8];
    assertPlay(ir, f, { 0: lo(value), 1: hi(value) }, "vibrato");
  }
  assert.equal(ir.calls[1].sids[0].regs[0], 0x67);
  assert.equal(ir.calls[3].sids[0].regs[0], 0x71);
});

test("pulse sweep fixture: the 12-bit pulse width grows by $40 per call from $0200", async () => {
  const { ir } = await fixture("pulseSweep");
  for (let f = 0; f < 100; f++) {
    const pw = (0x200 + 0x40 * f) & 0xfff;
    assertPlay(ir, f, { 2: lo(pw), 3: hi(pw), 4: 0x41 }, "pulseSweep");
    assert.equal(ir.calls[f + 1].sids[0].written, 0b1100);
  }
  assertPlay(ir, 99, { 2: 0xc0, 3: 0x0a }, "pulseSweep last");
});

test("filter sweep fixture: cutoff steps by 3, routing and mode stay", async () => {
  const { ir } = await fixture("filterSweep");
  for (let f = 0; f < 100; f++) {
    assertPlay(ir, f, { 0x15: 0, 0x16: (0x10 + 3 * f) & 0xff, 0x17: 0xf1, 0x18: 0x1f }, "filterSweep");
    assert.equal(ir.calls[f + 1].sids[0].written, (1 << 0x15) | (1 << 0x16));
  }
});

test("sync fixture: control register keeps the sync bit and the frequency steps by $18", async () => {
  const { ir } = await fixture("sync");
  for (let f = 0; f < 100; f++) {
    assertPlay(ir, f, { 0: (0x18 * (f + 1)) & 0xff, 1: 8, 4: 0x23, 0x0e: 0x0b, 0x0f: 4, 0x12: 0x11 }, "sync");
    assert.deepEqual(ir.calls[f + 1].sids[0].control, [[0x23], [], []]);
  }
});

test("ring fixture: voice 1 keeps the ring bit while voice 3 frequency cycles", async () => {
  const { ir } = await fixture("ring");
  for (let f = 0; f < 100; f++) {
    const v3 = TABLES.ringVoice3[f % 4];
    assertPlay(ir, f, { 4: 0x15, 0x0e: lo(v3), 0x0f: hi(v3), 0x12: 0x11 }, "ring");
    assert.deepEqual(ir.calls[f + 1].sids[0].control, [[0x15], [], []]);
  }
});

test("multispeed fixture: two calls per frame, one counter step per call", async () => {
  const { ir } = await fixture("multispeed");
  assert.equal(ir.callsPerFrame, 2);
  assert.equal(ir.callsPerFrameExact > 1.99 && ir.callsPerFrameExact < 2.01, true);
  for (let c = 1; c < ir.calls.length; c++) {
    assert.equal(ir.calls[c].sids[0].regs[0], c & 0xff, `call ${c}`);
    assert.equal(ir.calls[c].sids[0].written, 1);
  }
  // Calls 2 and 3 are one CIA period apart, which is half a frame.
  const gap = ir.calls[3].startCycle - ir.calls[2].startCycle;
  assert.ok(Math.abs(gap - 9828) <= 4, `gap ${gap}`);
});

test("two SID fixture: both SIDs are written in every call", async () => {
  const { ir } = await fixture("twoSids");
  assert.equal(ir.sidCount, 2);
  assert.equal(ir.calls[0].sids[1].written, ALL_REGISTERS);
  for (let f = 0; f < 100; f++) {
    const call = ir.calls[f + 1];
    assert.equal(call.sids[0].regs[0], (f + 1) & 0xff);
    assert.equal(call.sids[1].regs[0], ~(f + 1) & 0xff);
    assert.equal(call.sids[0].written, 1);
    assert.equal(call.sids[1].written, 1);
    assert.equal(call.sids[1].regs[1], 0x20);
    assert.equal(call.sids[0].regs[1], 0x10);
    assert.equal(call.writes, 2);
  }
});

test("test-bit fixture: the control register is written twice in every fourth call", async () => {
  const { ir } = await fixture("testBit");
  for (let f = 0; f < 100; f++) {
    const call = ir.calls[f + 1].sids[0];
    assert.equal(call.regs[0], f & 0xff);
    assert.equal(call.regs[4], 0x41);
    assert.deepEqual(call.control, [f % 4 === 0 ? [0x49, 0x41] : [], [], []], `call ${f}`);
    assert.equal(call.written, f % 4 === 0 ? 0b10001 : 0b1);
  }
});

test("NMI sample fixture: the $D418 writes are unsupported, the play calls stay periodic", async () => {
  const { ir, trace } = await fixture("nmiSampler");
  let d418 = 0;
  for (let i = 0; i < trace.count; i++) if (trace.records[i * 4 + 1] === 0x18) d418++;
  assert.ok(d418 > 7000, `${d418} writes to $D418`);
  assert.equal(ir.unsupported.writes, d418);
  assert.equal(ir.totalWrites, trace.count);
  assert.equal(ir.unsupported.share, d418 / trace.count);
  assert.equal(ir.unsupported.streams.length, 1);
  assert.equal(ir.unsupported.streams[0].sid, 0);
  assert.equal(ir.unsupported.streams[0].register, 0x18);
  assert.equal(ir.unsupported.streams[0].runs, 1);
  // 985,248 Hz / 246 cycles per NMI, within a few percent.
  assert.ok(Math.abs(ir.unsupported.ratePerSecond - 985_248 / 246) < 100, `${ir.unsupported.ratePerSecond}`);
  for (let f = 0; f < 100; f++) {
    const call = ir.calls[f + 1].sids[0];
    assert.equal(call.regs[0], (f + 1) & 0xff);
    assert.equal(call.regs[1], 0x10);
    assert.equal(call.written, 0b11);
  }
});
