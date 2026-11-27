// SIDWave 1.5 `global_table` (per-call filter and volume registers) and the wavetable waveform `none`, and their recovery.
import test from "#test/runner";
import assert from "#test/assert";
import { readFileSync } from "node:fs";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { SIDWAVE_INIT_ADDRESS, SIDWAVE_PLAY_ADDRESS, compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { Cpu6502 } from "../src/sidwaveEmulator.ts";
import { exportEvents } from "../src/interchange/events.ts";
import { candidateCost, irOfTrace, reconstructSid } from "../src/reconstruct/reconstruct.ts";
import { globalTableSteps, recoverScore } from "../src/reconstruct/recover.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
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

const dense = (version, extra = "") => {
  const grooves = ["A4@v C5 E5@w G5@s", "A4 C5@w E5@v G5@w", "A4@w C5@s E5 G5@v"];
  return `sidwave: "${version}"
title: T
tempo: 120
speed: 3
${extra}
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
};

test("a 1.5 score whose cycle estimate exceeds the 1 MHz budget compiles when the measured worst call fits", () => {
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

test("an instrument that never opens the gate stays silent when the instrument budget drops its tables", () => {
  const frame = 19_656;
  const writes = [];
  // Voice 1 modulates its pitch without ever gating; voice 2 plays 400 notes, each with a different 4-call program.
  for (let call = 0; call < 2400; call++) {
    const at = 10_000 + call * frame;
    writes.push(0, 0, (call * call) % 251, at, 0, 1, 1, at + 10, 0, 4, 0, at + 20);
    const note = Math.floor(call / 6);
    const k = call % 6;
    writes.push(0, 7, (note * 5 + k * 3) & 255, at + 30, 0, 8, 20, at + 40, 0, 13, 0xf0, at + 50, 0, 11, k < 4 ? 0x41 : 0x40, at + 60);
  }
  const recovered = recoverScore(buildIr(Float64Array.from(writes), { clock: "PAL" }));
  const voice = recovered.document.voices.find((v) => v.id === 1);
  const used = new Set(JSON.stringify(voice).match(/i\d+/g));
  for (const name of used) assert.ok(recovered.document.instruments[name].wavetable.every((step) => step.gate === false), name);
});

test("global_table is rejected with samples when it sets d418", () => {
  const text = doc("1.5", `${TABLE}
samples: { rate: 2500, defs: { kick: { kit: kick } }, voices: [{ sample: kick, bar: 1, beat: 1 }] }`);
  assert.throws(() => parseSidwave(text), /cannot be combined with samples/);
});

test("player.init and player.start write the first SID at its address", async () => {
  const text = doc("1.5", `player: { soft_start: false, init: [{ reg: "$D40C", value: 15 }], start: [[{ reg: "$D417", value: 2 }]] }
sids: [{ id: left, address: "$D420" }]`);
  const prg = compileSidwaveToPrg(parseSidwave(text)).prg;
  const mem = new Uint8Array(0x10000);
  mem.set(prg.subarray(2), prg[0] | (prg[1] << 8));
  mem[1] = 0x37;
  const cpu = new Cpu6502(mem);
  cpu.call(SIDWAVE_INIT_ADDRESS);
  assert.equal(mem[0xd42c], 15);
  assert.equal(mem[0xd40c], 0);
  cpu.call(SIDWAVE_PLAY_ADDRESS);
  assert.equal(mem[0xd437], 2);
  assert.equal(mem[0xd417], 0);
});

test("a looping global_table whose alignments are too many to run is measured with its variation added", () => {
  // The song loop is 301 calls. A table loop of 602 calls stays in step with it; one of 509 calls needs 153,209 calls for all
  // alignments, more than the measured limit.
  const measured = (calls) => {
    const steps = ["{ d416: 1, calls: 45 }", ...calls.map((n) => `{ d416_add: 1, calls: ${n} }`)].join(", ");
    const result = compileSidwaveToPrg(parseSidwave(dense("1.5", `player: { soft_start: false }
global_table: { loop: 1, steps: [${steps}] }`)));
    return Number(result.warnings.map((w) => /measured at (\d+) cycles/.exec(w)?.[1]).find(Boolean));
  };
  const inStep = measured([255, 255, 92]);
  assert.ok(inStep > 0);
  assert.ok(measured([255, 254]) >= inStep + 100, `${measured([255, 254])} against ${inStep}`);
});

test("an event export reports the global_table and waveform-less wavetable steps as losses", () => {
  const text = doc("1.5", TABLE, "{ waveform: pulse, wavetable: [{ wave: none, test: true, calls: 1 }, { wave: pulse }] }");
  const losses = exportEvents(parseSidwave(text)).losses.join("\n");
  assert.match(losses, /global_table/);
  assert.match(losses, /wave: none/);
});

test("recovery keeps to the first SID when a further SID has an address that a score cannot declare", () => {
  const writes = [];
  for (let call = 0; call < 200; call++) {
    const at = 10_000 + call * 19_656;
    for (const sid of [0, 1]) writes.push(sid, 1, 20, at + sid * 100, sid, 6, 240, at + sid * 100 + 10, sid, 4, call % 12 < 8 ? 0x21 : 0x20, at + sid * 100 + 20);
  }
  const ir = buildIr(Float64Array.from(writes), { clock: "PAL" });
  const recovered = recoverScore(ir, { sids: [{ address: 0xd400 }, { address: 0xde00 }] });
  assert.equal(recovered.document.sids, undefined);
  assert.ok(recovered.unsupported.some((u) => u.kind === "multi_sid"));
  assert.doesNotThrow(() => compileSidwaveBytes(parseSidwave(recovered.text), { format: "sid", loop: true }));
  assert.ok(recoverScore(ir, { sids: [{ address: 0xd400 }, { address: 0xd420 }] }).document.sids);
});

test("a candidate score whose trace compares almost nothing is not closer than one that compares every call", () => {
  const lost = { differingCalls: 5, comparedCalls: 1, expectedCalls: 4012 };
  const whole = { differingCalls: 9000, comparedCalls: 4012, expectedCalls: 4012 };
  assert.ok(candidateCost(whole) < candidateCost(lost));
});

test("reconstruction falls back to the first SID when the voices of all SIDs do not fit one score", { timeout: 60_000 }, async () => {
  const header = compile(`sidwave: "1.5"
title: T
tempo: 120
sids:
  - { id: a, address: "$D400" }
  - { id: b, address: "$D420" }
  - { id: c, address: "$D440" }
instruments: { lead: { waveform: pulse } }
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
timeline:
  - { section: Main, bars: 1, layers: { v1: a } }
`);
  // Plain notes on the first SID; random writes on the others, whose voices need more than 63 instrument variants.
  let seed = 7;
  const random = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const writes = [];
  for (let call = 0, at = 20_000; call < 500; call++, at += 19_656) {
    writes.push(0, 1, 20, at, 0, 6, 240, at + 10, 0, 4, call % 12 < 8 ? 0x21 : 0x20, at + 20);
    for (let i = 0; i < 12; i++) {
      const reg = random(21);
      writes.push(1 + (i % 2), reg, reg % 7 === 4 ? [0x41, 0x40, 0x09, 0x81, 0x21, 0x20][random(6)] : random(256), at + 100 + i * 40);
    }
  }
  const records = Float64Array.from(writes);
  assert.throws(() => compileSidwaveBytes(parseSidwave(`${recoverScore(buildIr(records, { clock: "PAL" }), { sids: [{ address: 0xd400 }, { address: 0xd420 }, { address: 0xd440 }] }).text}cpu: turbo\n`), { format: "sid", loop: true }));
  const engine = { trace: async () => ({ records, clock: "PAL", horizonCycles: 500 * 19_656, originCycle: 0 }) };
  const result = await reconstructSid(header, { engine, seconds: 10 });
  assert.equal(result.report.compile.ok, true, result.report.compile.error);
  assert.doesNotMatch(result.score, /^sids:/m);
  assert.ok(result.report.unsupported.some((u) => u.kind === "multi_sid"));
});
