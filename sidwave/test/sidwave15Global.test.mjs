// SIDWave 1.5 `global_table` (per-call filter and volume registers) and the wavetable waveform `none`, and their recovery.
import test from "#test/runner";
import assert from "#test/assert";
import { readFileSync } from "node:fs";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { irOfTrace } from "../src/reconstruct/reconstruct.ts";
import { globalTableSteps } from "../src/reconstruct/recover.ts";
import { sharedEngine, roundTrip } from "./helpers/reconstructRoundTrip.mjs";

const doc = (version, extra, instrument = "{ waveform: pulse, adsr: [0, 4, 12, 3] }") => `sidwave: "${version}"
title: T
tempo: 120
${extra}
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
instruments:
  lead: ${instrument}
timeline:
  - { section: Main, bars: 1, layers: { v1: a } }
`;
const TABLE = `player: { soft_start: false }
global_table:
  loop: 2
  steps:
    - { d415: 3, d416: 16, d417: 0xF1, d418: 0x1F, calls: 2 }
    - { d416_add: -4, calls: 3 }
    - { d415: 1, d416: 100, d417: 0x21, d418: 0x3A }
    - { d416_add: 7, d418: 9, calls: 2 }`;

const compile = (text) => new Uint8Array(compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true }).bytes);
const trace = async (text) => irOfTrace(await sharedEngine().trace({ sid: compile(text), seconds: 1, clock: "PAL" }));
const globals = (call) => Array.from(call.sids[0].regs.subarray(0x15, 0x19));

test("global_table and the waveform none are 1.5 constructs: an older document names the version", () => {
  assert.throws(() => parseSidwave(doc("1.4", TABLE.replace("player: { soft_start: false }\n", ""))), /global_table requires sidwave: 1\.5/);
  assert.throws(() => parseSidwave(doc("1.4", "", "{ waveform: pulse, wavetable: [{ wave: none, test: true }] }")), /waveform none requires sidwave: 1\.5/);
});

test("global_table is validated", () => {
  const bad = (extra, pattern) => assert.throws(() => parseSidwave(doc("1.5", extra)), pattern);
  bad("global_table: { steps: [] }", /steps/);
  bad("global_table: { steps: [{ calls: 1 }] }", /no step sets a register/);
  bad("global_table: { steps: [{ d417: 1 }, { d416: 2 }] }", /first step sets every register/);
  bad("global_table: { steps: [{ d416: 1, d416_add: 1 }] }", /choose d416 or d416_add/);
  bad("global_table: { steps: [{ d417: 256 }] }", /d417/);
  bad("global_table: { steps: [{ d417: 1, calls: 256 }] }", /calls/);
  bad("global_table: { loop: 1, steps: [{ d417: 1 }] }", /loop/);
  bad("global_table: { steps: [{ d418: 15 }] }", /soft_start: false/);
});

test("the player writes the table values call by call, continues at the loop step and writes the register order unchanged", async () => {
  const ir = await trace(doc("1.5", TABLE));
  const expected = [
    [3, 16, 0xf1, 0x1f], [3, 16, 0xf1, 0x1f], [3, 12, 0xf1, 0x1f], [3, 8, 0xf1, 0x1f], [3, 4, 0xf1, 0x1f],
    [1, 100, 0x21, 0x3a], [1, 107, 0x21, 9], [1, 114, 0x21, 9], [1, 100, 0x21, 0x3a], [1, 107, 0x21, 9],
  ];
  assert.deepEqual(ir.calls.slice(1, 11).map(globals), expected);
});

test("without a loop the last values are held; registers the table does not set stay with the player", async () => {
  const ir = await trace(doc("1.5", "global_table: { steps: [{ d417: 4 }, { d417: 9 }] }"));
  assert.deepEqual(ir.calls.slice(1, 5).map((c) => c.sids[0].regs[0x17]), [4, 9, 9, 9]);
  const plain = await trace(doc("1.5", "player: { soft_start: true }"));
  assert.equal(ir.calls[30].sids[0].regs[0x18], plain.calls[30].sids[0].regs[0x18]);
});

test("the waveform none writes the control register without waveform bits", async () => {
  const ir = await trace(doc("1.5", "", "{ waveform: pulse, wavetable: [{ wave: none, test: true, calls: 1 }, { wave: pulse }] }"));
  assert.deepEqual(ir.calls[1].sids[0].control[0], [0x09]);
  assert.deepEqual(ir.calls[2].sids[0].control[0], [0x41]);
});

test("globalTableSteps encodes runs and linear cutoff sweeps", () => {
  const values = [[16, 0xf1], [16, 0xf1], [20, 0xf1], [24, 0xf1], [24, 0x21]];
  const ir = { calls: values.map(([cut, res]) => { const regs = new Uint8Array(25); regs[0x16] = cut; regs[0x17] = res; return { sids: [{ regs }] }; }) };
  assert.deepEqual(globalTableSteps(ir, 0, [0x16, 0x17]), [
    { d416: 16, d417: 0xf1, calls: 2 }, { d416_add: 4, calls: 2 }, { d417: 0x21, calls: 1 },
  ]);
});

test("recovery writes a global_table for a changing filter and volume, and the round trip is strict exact", { timeout: 60_000 }, async () => {
  const r = await roundTrip(doc("1.5", TABLE));
  assert.equal(r.report.fdiff.classes.filter.differingCalls, 0, JSON.stringify(r.report.fdiff.first));
  assert.equal(r.report.fdiff.classes.volume.differingCalls, 0);
  assert.match(r.score, /global_table:/);
  assert.equal(r.report.strictExact, true, JSON.stringify(r.report.fdiff.first));
});

test("global_table and none are documented in the schema, the spec chapter and the changelog", () => {
  const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const schema = JSON.parse(read("data/sound/sidwave.schema.json"));
  assert.ok(schema.properties.global_table.properties.steps);
  assert.match(read("data/sound/sidwave.md"), /#### Global registers: `global_table`/);
  assert.match(read("CHANGELOG.md"), /`global_table`/);
});

test("player.init writes its registers in init, and an empty start step writes nothing in its call", async () => {
  const ir = await trace(doc("1.5", 'player: { soft_start: false, idle_writes: false, init: [{ reg: "$D40C", value: 15 }], start: [[], [{ reg: "$D417", value: 2 }]] }'));
  assert.equal(ir.calls[0].sids[0].regs[0x0c], 15);
  // The empty step leaves no call: the next call is two periods after init's neighbour and writes only $D417.
  assert.equal(ir.calls[1].sids[0].written, 1 << 0x17);
  assert.equal(ir.calls[2].sids[0].regs[0x0c], 15);
});

test("a 1.5 score whose cycle estimate exceeds the 1 MHz budget compiles when the measured worst call fits", () => {
  const grooves = ["A4@v C5 E5@w G5@s", "A4 C5@w E5@v G5@w", "A4@w C5@s E5 G5@v"];
  const dense = (version) => `sidwave: "${version}"
title: T
tempo: 120
speed: 3
voices:
${grooves.map((groove, i) => `  - { id: ${i + 1}, instrument: p, patterns: { a: { length: 1, bars: 1, groove: "${groove}" } } }`).join("\n")}
instruments:
  v: { waveform: pulse, vibrato: { depth: 0.4, rate: 5 } }
  p: { waveform: pulse, pulsetable: [{ set: 100 }, { add: 3, calls: 200 }] }
  w: { waveform: pulse, wavetable: [{ wave: pulse, calls: 2 }, { wave: tri, note: "+12" }] }
  s: { waveform: pulse, filtertable: [{ cutoff: 100, type: lowpass, resonance: 4 }, { add: 3, calls: 200 }] }
timeline:
  - { section: Main, bars: 1, layers: { v1: a, v2: a, v3: a } }
`;
  assert.throws(() => compileSidwaveToPrg(parseSidwave(dense("1.4"))), /use cpu: turbo/);
  const result = compileSidwaveToPrg(parseSidwave(dense("1.5")));
  assert.ok(result.warnings.some((w) => /measured at \d+ cycles/.test(w)), JSON.stringify(result.warnings));
  assert.equal(result.requiresTurbo, false);
});

test("recovery keeps the modulation of a voice before its first gate as a gate-off note", { timeout: 60_000 }, async () => {
  const score = doc("1.5", "player: { soft_start: false }", "{ waveform: pulse, wavetable: [{ wave: none, gate: false, calls: 4 }, { wave: none, gate: false, note: \"+12\", calls: 4 }, { wave: pulse, calls: 8 }] }");
  const r = await roundTrip(score);
  assert.equal(r.report.compile.ok, true, r.report.compile.error);
  assert.equal(r.report.fdiffState.classes.pitch.differingCalls, 0, JSON.stringify(r.report.fdiffState.first));
});

test("recovery of a two-SID tune with known addresses declares sids and recovers the voices of both", { timeout: 60_000 }, async () => {
  const score = `sidwave: "1.5"
title: T
tempo: 120
player: { soft_start: false }
sids:
  - { id: left, address: "$D400" }
  - { id: right, address: "$D420" }
instruments:
  lead: { waveform: pulse, adsr: [0, 4, 12, 3] }
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
  - { id: 4, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "E3 - G3 -" } } }
timeline:
  - { section: Main, bars: 1, layers: { v1: a, v4: a } }
`;
  const r = await roundTrip(score);
  assert.match(r.score, /sids:/);
  assert.match(r.score, /\$D420/);
  assert.equal(r.report.unsupported.some((u) => u.kind === "multi_sid"), false);
  assert.equal(r.report.fdiffState.classes.pitch.differingCalls, 0, JSON.stringify(r.report.fdiffState.first));
  assert.equal(r.report.fdiffState.classes.gate.differingCalls, 0, JSON.stringify(r.report.fdiffState.first));
});

test("hard_restart wave none writes the test bit without waveform bits, and requires 1.5", async () => {
  const instrument = "{ waveform: pulse, hard_restart: { frames: 1, test: true, wave: none } }";
  assert.throws(() => parseSidwave(doc("1.4", "", instrument)), /wave/);
  const ir = await trace(doc("1.5", "", instrument));
  assert.ok(ir.calls.some((c) => c.sids[0].regs[4] === 0x08));
  assert.equal(ir.calls[1].sids[0].regs[4], 0x41);
});
