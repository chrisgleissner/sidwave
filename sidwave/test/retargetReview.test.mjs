import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { retargetSidwave, measureScore, compareTiming } from "../src/retarget.js";
import { WriteRecorder } from "../src/retarget/trace.js";
import { unitsForHz } from "../src/retarget/model.js";
import { cutoffHz, parseHz } from "../src/sidwaveFilterModel.js";
import { parseSidwave } from "../src/sidwave.js";
import { runCli } from "../src/cli.js";
import { readExampleScore } from "../src/sidwaveOps.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SLOW = { timeout: 300_000 };

/** Frequency (Hz, on `model`) at the given frame offsets from the first add step of a filter table, frame by frame. */
function tableHz(table, model, offsets) {
  const steps = Array.isArray(table) ? table : table.steps;
  let code;
  const track = [];
  for (const step of steps) {
    if (step.cutoff !== undefined) code = typeof step.cutoff === "number" ? step.cutoff : unitsForHz(parseHz(step.cutoff), model);
    else if (step.add !== undefined && code !== undefined) {
      for (let k = 0; k < (step.frames ?? step.calls ?? 1); k++) { code = Math.max(0, Math.min(2047, code + step.add)); track.push(cutoffHz(code, model)); }
    }
  }
  return offsets.map((offset) => track[offset - 1]);
}

test("model: a filter table step is converted from the Hz at its start and end, not per frame", () => {
  const make = (cutoff, add, frames) => `sidwave: "1.3"
title: Slow
tempo: 120
mode: PAL
sids: [{ id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }]
instruments:
  slow: { waveform: saw, adsr: [0, 6, 9, 2], filtertable: [{ cutoff: ${cutoff}, resonance: 8, type: lowpass }, { add: ${add}, frames: ${frames} }, { add: ${-add}, frames: ${frames} }] }
voices:
  - id: 1
    instrument: slow
    patterns:
      a: { length: 1, groove: ["C3", "E3", "G3", "C4"] }
sections:
  s: { bars: 2, layers: { v1: a } }
timeline: [s, s]
`;
  for (const [cutoff, add, frames] of [[600, -1, 255], [300, 2, 150], [700, 3, 100]]) {
    const source = make(cutoff, add, frames);
    const result = retargetSidwave(source, { model: "6581" });
    const offsets = [frames, 2 * frames];
    const before = tableHz(YAML.parse(source).instruments.slow.filtertable, "8580", offsets);
    const outTable = YAML.parse(result.text).instruments.slow.filtertable;
    const after = tableHz(outTable, "6581", offsets);
    before.forEach((hz, i) => assert.ok(Math.abs(after[i] - hz) <= 0.04 * hz + 40, `${cutoff}/${add}/${frames}: step ${i} ends at ${after[i]} Hz, expected ${hz} Hz`));
    assert.notEqual(outTable[1].add, 0, `${cutoff}/${add}/${frames}: the sweep is kept`);
    const change = result.report.changes.find((c) => c.construct === "filtertable.add");
    assert.equal(change.class, "approximate");
    assert.equal(typeof change.measured.worstPercent, "number");
  }
});

test("trace: the compared trace keeps every write of a call in order, only writes of the current value are dropped", SLOW, () => {
  const recorder = new WriteRecorder();
  // A gate retrigger inside one call: gate on, off, on again; and a test-bit pulse on another voice.
  recorder.write(0xd404, 0x41);
  recorder.commit();
  recorder.write(0xd404, 0x40);
  recorder.write(0xd404, 0x41);
  recorder.write(0xd40b, 0x41);
  recorder.write(0xd40b, 0x49);
  recorder.write(0xd40b, 0x41);
  recorder.write(0xd400, 0);
  recorder.commit();
  assert.deepEqual(recorder.writes[0], [0xd404, 0x41]);
  assert.deepEqual(recorder.writes[1], [0xd404, 0x40, 0xd404, 0x41, 0xd40b, 0x41, 0xd40b, 0x49, 0xd40b, 0x41], "retrigger and pulse stay visible, the write of 0 to a register holding 0 is dropped");
  assert.deepEqual(recorder.changes[1], [0xd40b, 0x41], "the net change of the call hides them");
  // On a real score: no write stores the value the register already holds, and the net trace has one entry per register.
  const trace = measureScore(parseSidwave(readExampleScore("stereo_echo"))).songs[0];
  const live = new Map();
  for (const call of trace.writes) for (let i = 0; i < call.length; i += 2) {
    assert.notEqual(live.get(call[i]) ?? 0, call[i + 1]);
    live.set(call[i], call[i + 1]);
  }
  for (const call of trace.changes) {
    const addresses = call.filter((_, i) => i % 2 === 0);
    assert.equal(new Set(addresses).size, addresses.length);
  }
});

test("trace: waveform, pitch and pulse-width jumps are timing events", SLOW, () => {
  const kinds = new Set(measureScore(parseSidwave(readExampleScore("title_fanfare"))).timing[0].map((e) => e.kind));
  for (const kind of ["on", "off", "wave", "freq"]) assert.ok(kinds.has(kind), kind);
});

test("clock: table steps round by cumulative time and the table reports its total drift", () => {
  const steps = Array.from({ length: 20 }, (_, i) => `{ add: ${i % 2 ? -4 : 4}, frames: 3 }`).join(", ");
  const source = `sidwave: "1.3"
title: Drift
tempo: 120
mode: PAL
instruments:
  t: { waveform: pulse, adsr: [0, 6, 9, 2], pulsetable: { loop: 1, steps: [{ set: 0.3 }, ${steps}] } }
voices:
  - id: 1
    instrument: t
    patterns:
      a: { length: 1, groove: ["C3", "E3", "G3", "C4"] }
sections:
  s: { bars: 2, layers: { v1: a } }
timeline: [s, s]
`;
  const result = retargetSidwave(source, { clock: "ntsc" });
  const out = YAML.parse(result.text).instruments.t.pulsetable.steps;
  const total = out.slice(1).reduce((sum, step) => sum + step.frames, 0);
  const ideal = 60 * 59.8262 / 50.1245; // 71.6 frames
  assert.ok(Math.abs(total - ideal) <= 1, `${total} frames, ideal ${ideal}`);
  const drift = result.report.changes.find((c) => c.construct === "pulsetable.drift");
  assert.ok(drift.errorMs < 1000 / 59.8262 + 0.01, `drift ${drift.errorMs} ms`);
  assert.equal(drift.measured.steps, 21);
  // Steps vary in length because the rounding error is carried along.
  assert.ok(new Set(out.slice(1).map((s) => s.frames)).size > 1);
});

test("SIDs: every discarded SID attribute is reported and a summary that drops voices is dropped", SLOW, () => {
  const result = retargetSidwave(readExampleScore("stereo_echo"), { sids: 1 });
  const removed = result.report.changes.find((c) => c.construct === "sid");
  assert.ok(removed, "the removed SID is reported");
  assert.notEqual(removed.class, "exact");
  assert.match(removed.summary, /address \$D420/);
  assert.match(removed.summary, /model 8580/);
  assert.match(removed.summary, /volume 15/);
  assert.match(removed.summary, /pan "Right 3"/);
  const pan = result.report.changes.find((c) => c.construct === "sid-pan");
  assert.equal(pan.class, "dropped");
  assert.equal(result.report.changes.find((c) => c.construct === "sids").class, "dropped");
});

test("SIDs: the filter route follows a voice that moves to another SID", () => {
  const voice = (id, role, notes) => `  - id: ${id}
    role: ${role}
    instrument: i
    patterns:
      p${id}: { length: 1, groove: ${JSON.stringify(notes)} }
`;
  const source = `sidwave: "1.3"
title: Route
tempo: 120
mode: PAL
sids:
  - { id: a, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }
  - { id: b, address: "$D420", model: "8580", filter: { owner: v4, route: [1, 2] } }
instruments:
  i: { waveform: saw, adsr: [0, 6, 9, 2], filtertable: [{ cutoff: 900Hz, resonance: 8, type: lowpass }, { add: -6, frames: 10 }] }
voices:
${voice(1, "lead", ["C5", "E5", "G5", "C6"])}${voice(2, "pad", ["C4", "E4", "G4", "E4"])}${voice(3, "drums", ["C3", "C3", "C3", "C3"])}${voice(4, "bass", ["C2", "G2", "C2", "G2"])}${voice(5, "pad", ["E4", "G4", "B4", "G4"])}sections:
  s: { bars: 2, layers: { v1: p1, v2: p2, v3: p3, v4: p4, v5: p5 } }
timeline: [s, s]
`;
  const result = retargetSidwave(source, { sids: 1 });
  const kept = Object.fromEntries(result.report.sids.voices.filter((v) => v.decision === "kept").map((v) => [v.id, v.newId]));
  assert.deepEqual(Object.keys(kept).sort(), ["1", "2", "4"]);
  assert.equal(kept[1], 1);
  assert.equal(kept[2], 2);
  assert.equal(kept[4], 3, "the bass moves to the free third channel");
  const doc = parseSidwave(result.text);
  assert.deepEqual([...doc.sids[0].filter.route].sort(), [1, 3], "the bass keeps its route membership, the pad (not routed) does not gain one");
  assert.equal(doc.sids[0].filter.owner, 1);
});

test("timing: a known shift is measured at its size, and voices with different event counts are not measured", () => {
  const measurement = (times, kind = "on") => ({ timing: [times.map((time) => ({ voice: 0, kind, time }))] });
  const shifted = compareTiming(measurement([1, 2, 3, 4]), measurement([1.03, 2.03, 3.03, 4.03]));
  assert.ok(Math.abs(shifted.worstMs - 30) < 1e-6, `worst ${shifted.worstMs}`);
  assert.ok(Math.abs(shifted.perKind.on.p95Ms - 30) < 1e-6);
  assert.equal(shifted.perKind.on.unmatched, 0);
  // Different event counts: the order says nothing, so the group is not measured and reports both counts.
  const far = compareTiming(measurement([1.0, 2.0, 3.0], "freq"), measurement([1.5, 2.001, 3.0, 4.0], "freq"));
  assert.equal(far.perKind.freq.timing, "not measured");
  assert.equal(far.perKind.freq.paired, 0);
  assert.equal(far.perKind.freq.worstMs, null);
  assert.deepEqual(far.perKind.freq.mismatches, [{ voice: 0, before: 3, after: 4 }]);
  assert.equal(far.worstMs, 0);
});

test("sidwave retarget: invalid input exits 3, usage 2, an infeasible budget 1", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-retarget-exit-")));
  try {
    fs.writeFileSync(path.join(dir, "bad.yaml"), "voices: nope\n");
    fs.writeFileSync(path.join(dir, "ok.yaml"), readExampleScore("fuer_elise"));
    const run = (...args) => runCli(args, { cwd: dir, out: () => {}, err: () => {}, outBytes: () => {} });
    assert.equal(run("retarget", "bad.yaml", "--clock", "ntsc"), 3);
    assert.equal(run("retarget", "ok.yaml"), 2);
    assert.equal(run("retarget", "ok.yaml", "--budget-bytes", "100"), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A one-voice score with a three-step wavetable, an optional shared loop and a filter table. */
function loopScore({ model, table, shared, objectForm }) {
  const filtertable = objectForm ? `{ steps: ${table}${shared === undefined ? "" : `, loop: ${shared}`} }` : table;
  return `sidwave: "1.3"
title: Loop
tempo: 120
mode: PAL
sids: [{ id: sid1, address: "$D400", model: "${model}", filter: { owner: v1, route: [1] } }]
instruments:
  i: { waveform: pulse, adsr: [0, 6, 9, 2], wavetable: [{ wave: tri, frames: 2 }, { wave: pulse, frames: 2 }, { wave: saw }], ${!objectForm && shared !== undefined ? `loop: ${shared}, ` : ""}filtertable: ${filtertable} }
voices:
  - id: 1
    instrument: i
    patterns:
      a: { length: 1, groove: ["C3", "E3", "G3", "C4"] }
sections:
  s: { bars: 2, layers: { v1: a } }
timeline: [s]
`;
}

test("model: splitting a filter-table step never moves the loop shared with the other tables", () => {
  const table = "[{ cutoff: 100, resonance: 8, type: lowpass }, { add: 3, frames: 40 }, { cutoff: 500, frames: 4 }, { add: -3, frames: 40 }]";
  const source = loopScore({ model: "8580", table, shared: 2 });
  const result = retargetSidwave(source, { model: "6581" });
  const out = YAML.parse(result.text).instruments.i;
  assert.equal(out.loop, 2, "the shared loop stays where it was");
  assert.equal(out.wavetable.length, 3);
  assert.equal(out.filtertable.length, 4, "the table is not split when its loop is shared");
  const add = result.report.changes.find((c) => c.construct === "filtertable.add");
  assert.equal(add.class, "approximate");
  assert.equal(add.measured.split, 0);
  parseSidwave(result.text);
});

test("model: filter table conversions of 100 combinations all compile and keep shared loops", () => {
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 100; i++) {
    const cutoffs = [100, 300, 500, 700, 900, 1200, 1800];
    const add = (next(2) ? 1 : -1) * (1 + next(6));
    const frames = 10 + next(110);
    const table = `[{ cutoff: ${cutoffs[next(7)]}, resonance: 8, type: lowpass }, { add: ${add}, frames: ${frames} }, { cutoff: ${cutoffs[next(7)]}, frames: 4 }, { add: ${-add}, frames: ${10 + next(110)} }]`;
    const objectForm = next(3) === 0;
    const shared = next(4) === 3 ? undefined : next(3);
    const [from, to] = next(2) ? ["8580", "6581"] : ["6581", "8580"];
    const source = loopScore({ model: from, table, shared, objectForm });
    let result;
    try { result = retargetSidwave(source, { model: to }); } catch (error) { assert.fail(`combination ${i} (${from}->${to}, ${objectForm ? "object" : "array"} form, loop ${shared}, ${table}): ${error.message}`); }
    const out = YAML.parse(result.text).instruments.i;
    if (!objectForm) assert.equal(out.loop, shared, `combination ${i}: the shared loop`);
    else {
      assert.ok(out.filtertable.loop === undefined || out.filtertable.loop < out.filtertable.steps.length, `combination ${i}: own loop in range`);
    }
  }
});

test("clock: the turbo note gives the cycles per frame of both clocks and the direction", SLOW, () => {
  const result = retargetSidwave(readExampleScore("chiptune_drive"), { clock: "ntsc" });
  const cpu = result.report.changes.find((c) => c.construct === "cpu");
  assert.match(cpu.summary, /19656 cycles per frame on PAL/);
  assert.match(cpu.summary, /17095 on NTSC/);
  assert.match(cpu.summary, /needs up to \d+ cycles per call at speed 2, \d+ are available/);
  assert.match(cpu.summary, /fewer/);
});

test("report: dropped voices are tallied apart, an infeasible budget is not an exact change, a clamp has no percentage", SLOW, () => {
  const wall = retargetSidwave(readExampleScore("stereo_echo"), { sids: 1 });
  assert.equal(wall.report.summary.voicesDropped, wall.report.sids.voices.filter((v) => v.decision === "dropped").length);
  assert.ok(wall.report.summary.voicesDropped > 0);
  const infeasible = retargetSidwave(readExampleScore("fuer_elise"), { budgetBytes: 100 });
  assert.equal(infeasible.report.verdict, "infeasible");
  assert.equal(infeasible.report.summary.exact, 0);
  const clamp = retargetSidwave(loopScore({ model: "6581", table: "[{ cutoff: 2000, resonance: 8, type: lowpass }, { add: -5, frames: 40 }]" }), { model: "8580" });
  const add = clamp.report.changes.find((c) => c.construct === "filtertable.add");
  assert.equal(add.measured.clamped, true);
  assert.equal(add.measured.worstPercent, undefined);
  assert.match(add.summary, /clamped at \d+ Hz/);
});

test("SIDs: a voice that becomes filtered because the filter owner was replaced is reported", () => {
  const voice = (id, role, notes) => `  - id: ${id}
    role: ${role}
    instrument: i
    patterns:
      p${id}: { length: 1, groove: ${JSON.stringify(notes)} }
`;
  const source = `sidwave: "1.3"
title: Owner
tempo: 120
mode: PAL
sids:
  - { id: a, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }
  - { id: b, address: "$D420", model: "8580" }
instruments:
  i: { waveform: saw, adsr: [0, 6, 9, 2], filtertable: [{ cutoff: 900Hz, resonance: 8, type: lowpass }, { add: -6, frames: 10 }] }
voices:
${voice(1, "drums", ["C3", "C3", "C3", "C3"])}${voice(2, "lead", ["C5", "E5", "G5", "C6"])}${voice(3, "bass", ["C2", "G2", "C2", "G2"])}${voice(4, "pad", ["E4", "G4", "B4", "G4"])}sections:
  s: { bars: 2, layers: { v1: p1, v2: p2, v3: p3, v4: p4 } }
timeline: [s, s]
`;
  const result = retargetSidwave(source, { sids: 1 });
  const owner = result.report.changes.find((c) => c.construct === "filter-owner");
  assert.ok(owner, "the owner change");
  const route = result.report.changes.find((c) => c.construct === "filter-route");
  assert.ok(route, "the newly filtered voice is reported");
  assert.match(route.summary, /voice 2 is now routed through the filter/);
});
