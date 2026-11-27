// SIDWave 1.5 player options `start` (writes of the first calls) and `idle_writes: control` (a voice that has not played writes
// only its control register), and their recovery (S5d part 3, call-0 differences).
import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { irOfTrace } from "../src/reconstruct/reconstruct.ts";
import { sharedEngine, roundTrip } from "./helpers/reconstructRoundTrip.mjs";

const doc = (version, player) => `sidwave: "${version}"
title: T
tempo: 120
player: ${player}
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
  - { id: 2, instrument: lead, patterns: { r: { length: 1, bars: 1, groove: "- - - -" }, a: { length: 1, bars: 1, groove: "A3 - C4 -" } } }
instruments:
  lead: { waveform: pulse, adsr: [0, 4, 12, 3] }
timeline:
  - { section: Intro, bars: 1, layers: { v1: a, v2: r } }
  - { section: Main, bars: 1, layers: { v1: a, v2: a } }
`;

async function trace(text, seconds = 1) {
  const bytes = new Uint8Array(compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true }).bytes);
  return irOfTrace(await sharedEngine().trace({ sid: bytes, seconds, clock: "PAL" }));
}

test("player.start and idle_writes control are 1.5 constructs: a 1.4 document names the version", () => {
  assert.throws(() => parseSidwave(doc("1.4", "{ start: [[{ reg: $D404, value: 8 }]] }")), /sidwave: 1\.5/);
});

test("player.start is validated: registers $D400-$D418, byte values, at most 8 steps of at most 32 writes", () => {
  const bad = (player, pattern) => assert.throws(() => parseSidwave(doc("1.5", player)), pattern);
  bad('{ start: [[{ reg: "$D419", value: 1 }]] }', /start/);
  bad('{ start: [[{ reg: "$D404", value: 256 }]] }', /start/);
  bad(`{ start: [${Array.from({ length: 9 }, () => '[{ reg: "$D404", value: 1 }]').join(", ")}] }`, /start/);
  bad(`{ start: [[${Array.from({ length: 33 }, () => '{ reg: "$D404", value: 1 }').join(", ")}]] }`, /start/);
  bad("{ start: 5 }", /start/);
  bad('{ idle_writes: "all" }', /idle_writes/);
  assert.equal(parseSidwave(doc("1.5", '{ idle_writes: control }')).player.idleWrites, "control");
});

test("the first calls write exactly the listed registers in the listed order, and the song starts after them", async () => {
  const withStart = doc("1.5", '{ soft_start: false, start: [[{ reg: "$D404", value: 8 }, { reg: "$D40B", value: 8 }, { reg: "$D417", value: 4 }], [{ reg: "$D404", value: 0 }, { reg: "$D404", value: 8 }]] }');
  const plain = doc("1.5", "{ soft_start: false }");
  const a = await trace(withStart);
  const b = await trace(plain);
  // call 0 is the init; calls 1 and 2 are the start steps; the song begins at call 3 of `a`, call 1 of `b`
  assert.deepEqual(a.calls[1].sids[0].control, [[8], [8], []]);
  assert.equal(a.calls[1].sids[0].regs[0x0b], 8);
  assert.equal(a.calls[1].sids[0].regs[0x17], 4);
  assert.deepEqual(a.calls[2].sids[0].control, [[0, 8], [], []]);
  assert.equal(a.calls[1].sids[0].written, (1 << 4) | (1 << 0x0b) | (1 << 0x17));
  const song = a.calls[3].sids[0];
  const first = b.calls[1].sids[0];
  assert.equal(song.regs[0], first.regs[0]);
  assert.equal(song.regs[1], first.regs[1]);
  assert.equal(song.regs[4], first.regs[4]);
});

test("a score without start compiles to the same bytes with and without the 1.5 option fields it does not use", () => {
  const a = compileSidwaveBytes(parseSidwave(doc("1.5", "{ soft_start: true }")), { format: "sid", loop: true }).bytes;
  const b = compileSidwaveBytes(parseSidwave(doc("1.5", "{ soft_start: true, idle_writes: true }")), { format: "sid", loop: true }).bytes;
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("idle_writes control: a voice that has not played writes only its control register, every call", async () => {
  const ir = await trace(doc("1.5", "{ soft_start: false, idle_writes: control }"));
  const call = ir.calls[2].sids[0];
  assert.ok(call.written & (1 << 0x0b), "the control register of an idle voice is written");
  for (const reg of [0x07, 0x08, 0x09, 0x0a, 0x0c, 0x0d]) assert.equal(call.written & (1 << reg), 0, `register ${reg} of an idle voice is not written`);
  assert.deepEqual(call.control[1], [0]);
  const normal = await trace(doc("1.5", "{ soft_start: false }"));
  assert.ok(normal.calls[2].sids[0].written & (1 << 0x07), "by default an idle voice writes its frequency");
});

test("recovery emits start for the writes before the first note and the round trip is strict exact", { timeout: 60_000 }, async () => {
  const score = `sidwave: "1.5"
title: T
tempo: 120
player: { soft_start: false, idle_writes: control, start: [[{ reg: "$D404", value: 8 }, { reg: "$D40B", value: 8 }, { reg: "$D412", value: 8 }]] }
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 0.5, bars: 1, groove: ["A4", "C5", "A4", "C5", "E5", "C5", "A4", "C5"] } } }
instruments:
  lead: { waveform: pulse, adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } }
timeline:
  - { section: Main, bars: 4, layers: { v1: a } }
`;
  const r = await roundTrip(score, 3);
  assert.match(r.score, /start:/);
  assert.equal(r.report.registerStateExact, true, JSON.stringify(r.report.fdiffState.first));
  assert.equal(r.report.strictExact, true, JSON.stringify(r.report.fdiff.first));
});

test("eight steps of 32 writes assemble (the branches over a long step are in range)", async () => {
  const step = "[" + Array.from({ length: 32 }, (_, i) => `{ reg: ${54272 + (i % 25)}, value: ${i} }`).join(", ") + "]";
  const text = doc("1.5", `{ start: [${Array.from({ length: 8 }, () => step).join(", ")}] }`);
  const ir = await trace(text, 1);
  assert.equal(ir.calls[8].sids[0].written > 0, true);
});
