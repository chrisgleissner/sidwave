import test from "#test/runner";
import assert from "#test/assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.ts";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { compareTraces, verifySid } from "../src/verify/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/sound/examples");
async function tune(name = "funk_bass", transform, mode) {
  let yaml = await readFile(path.join(root, `${name}.yaml`), "utf8");
  if (transform) yaml = transform(yaml);
  const doc = parseSidwave(yaml);
  if (mode) doc.song.mode = mode;
  const prg = compileSidwaveToPrg(doc);
  const options = { initAddress: prg.initAddress, playAddress: prg.playAddress };
  return new Uint8Array(compileSidwaveToSid(doc, prg.prg, options).sid);
}
const packed = (writes) => new Float64Array(writes.flat());

test("synthetic trace comparison reports missing, extra, order, and length categories", () => {
  const base = packed([[0,1,10,0],[1,2,20,30000]]);
  assert.equal(compareTraces(base, packed([[0,1,10,0]])).t1.firstDifference.category, "length");
  assert.equal(compareTraces(base, packed([[0,1,10,0]])).t0.firstDifference.category, "missing_write");
  assert.equal(compareTraces(base, packed([[0,1,10,0],[1,2,20,30000],[2,3,30,60000]])).t0.firstDifference.category, "extra_write");
  assert.equal(compareTraces(packed([[0,1,10,0],[0,2,10,5]]), packed([[0,2,10,0],[0,1,10,5]])).t0.firstDifference.category, "order");
  assert.equal(compareTraces(packed([[0,1,10,0],[0,2,20,30000]]), packed([[0,1,10,0],[0,2,21,30000]])).t0.firstDifference.category, "value");
});

test("identical compiled tune passes T0 and A0; one note edit changes call and voice", async () => {
  const original = await tune();
  const changed = await tune("funk_bass", yaml => yaml.replace(/(groove:\s*"[^"]*)E1/, "$1F1"));
  const sidlite = createLibsidplayfpEngine({ emulation: "sidlite" });
  const identical = await verifySid(original, original, { engine: sidlite, pcmEngine: sidlite, seconds: 0.35 });
  assert.equal(identical.levels.T0, "pass");
  assert.equal(identical.levels.A0, "pass");
  const different = await verifySid(original, changed, { engine: sidlite, pcmEngine: sidlite, seconds: 3 });
  assert.equal(different.levels.T0, "fail");
  assert.ok(different.firstDifference.call >= 0);
  assert.ok(different.firstDifference.voice >= 1 && different.firstDifference.voice <= 3);
  assert.equal(different.levels.A0, "fail");
});

test("timing offset can preserve writes while failing T1 tolerance", () => {
  const a = packed([[0,0,1,0],[0,1,2,30000],[0,2,3,60000]]);
  const b = packed([[0,0,1,0],[0,1,2,31000],[0,2,3,62000]]);
  const result = compareTraces(a,b,{ toleranceCycles: 500 });
  assert.equal(result.t0.equal, true);
  assert.equal(result.t1.equal, false);
  assert.equal(result.t1.maxOffsetCycles, 2000);
  assert.equal(result.t1.firstDifference.category, "timing");
});

test("a PSID speed patch changes call writes and exceeds T1 timing tolerance", async () => {
  const normal = await tune();
  const patched = await tune("funk_bass", yaml => yaml.replace("speed: 2", "speed: 1"));
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const result = await verifySid(normal, patched, { engine, seconds: 2, toleranceCycles: 2_000 });
  assert.equal(result.levels.T0, "fail");
  assert.equal(result.levels.T1, "fail");
  assert.ok(result.horizon.calls > 1);
});

const identity = { id: "fake", version: "0", emulation: "sidlite" };
function fakeEngine(records) {
  return {
    id: "fake",
    version: "0",
    async trace(req) {
      const cycles = Math.round(req.seconds * 985_248);
      return { records: records(req), count: 0, droppedRecords: 0, clock: "PAL", originCycle: 0, horizonCycles: cycles, cycles, seconds: req.seconds, samples: new Int16Array(0), sampleRate: 44_100, channels: 1, engine: identity };
    },
    async render() { throw new Error("not used"); },
  };
}

test("an empty trace fails T0 and T1 with category empty_trace instead of passing", () => {
  const base = packed([[0, 1, 10, 1000], [1, 2, 20, 31000]]);
  const empty = new Float64Array(0);
  for (const [a, b] of [[base, empty], [empty, base], [empty, empty]]) {
    const result = compareTraces(a, b);
    assert.equal(result.t0.equal, false);
    assert.equal(result.t1.equal, false);
    assert.equal(result.t0.firstDifference.category, "empty_trace");
    assert.equal(result.t1.firstDifference.category, "empty_trace");
  }
  // Writes that all lie after the horizon leave no player call inside it.
  const late = compareTraces(base, base, { horizonCycles: 500 });
  assert.equal(late.t0.firstDifference.category, "empty_trace");
});

test("verifySid reports an empty trace as a failure at every trace level", async () => {
  const engine = fakeEngine(() => new Float64Array(0));
  const result = await verifySid(new Uint8Array(8), new Uint8Array(8), { engine, seconds: 1 });
  assert.equal(result.level, "none");
  assert.equal(result.levels.T0, "fail");
  assert.equal(result.levels.T1, "fail");
  assert.equal(result.firstDifference.category, "empty_trace");
});

test("the T1 first difference is the earliest one, not the last order or value mismatch", () => {
  const a = packed([[0, 0, 1, 1000], [0, 1, 2, 31000], [0, 2, 3, 61000]]);
  // The second write is 1000 cycles late (timing); the third has another value.
  const b = packed([[0, 0, 1, 1000], [0, 1, 2, 32000], [0, 2, 9, 61000]]);
  const result = compareTraces(a, b, { toleranceCycles: 500 });
  assert.equal(result.t1.firstDifference.category, "timing");
  assert.equal(result.t1.firstDifference.cycle, 31000);
  assert.equal(result.t1.firstDifference.register, 1);
  assert.equal(result.t1.maxOffsetCycles, 1000);
});

test("T1 compares cycles from engine start, so a late first write fails at the first write", () => {
  const a = packed([[0, 1, 10, 1000], [0, 2, 20, 31000]]);
  const b = packed([[0, 1, 10, 6000], [0, 2, 20, 36000]]);
  const result = compareTraces(a, b, { toleranceCycles: 100 });
  assert.equal(result.t0.equal, true);
  assert.equal(result.t1.equal, false);
  assert.equal(result.t1.firstDifference.category, "timing");
  assert.equal(result.t1.firstDifference.cycle, 1000);
  assert.equal(result.t1.firstDifference.call, undefined);
  assert.equal(result.t1.firstWriteOffsetCycles, 5000);
  assert.equal(result.t1.maxOffsetCycles, 5000);
  assert.equal(compareTraces(a, a, { toleranceCycles: 100 }).t1.firstWriteOffsetCycles, 0);
});

test("every difference carries an absolute cycle and timeSeconds on the same clock", () => {
  const base = packed([[0, 1, 10, 1000], [1, 2, 20, 31000]]);
  const cases = [
    [compareTraces(base, packed([[0, 1, 10, 1000]])), "t0", "missing_write", 31000],
    [compareTraces(base, packed([[0, 1, 10, 1000]])), "t1", "length", 31000],
    [compareTraces(base, packed([[0, 1, 10, 1000], [1, 2, 20, 31000], [2, 3, 30, 61000]])), "t0", "extra_write", 61000],
    [compareTraces(packed([[0, 1, 10, 1000], [0, 2, 10, 1005]]), packed([[0, 2, 10, 1000], [0, 1, 10, 1005]])), "t0", "order", 1000],
    [compareTraces(packed([[0, 1, 10, 1000], [0, 2, 20, 31000]]), packed([[0, 1, 10, 1000], [0, 2, 21, 31000]])), "t0", "value", 31000],
    [compareTraces(base, packed([[0, 1, 10, 1000], [1, 2, 20, 32000]])), "t1", "timing", 31000],
  ];
  for (const [result, level, category, cycle] of cases) {
    const difference = result[level].firstDifference;
    assert.equal(difference.category, category);
    assert.equal(difference.cycle, cycle);
    assert.equal(difference.timeSeconds, cycle / 985_248);
  }
  const ntsc = compareTraces(base, packed([[0, 1, 10, 1000], [1, 2, 20, 32000]]), { clockHz: 1_022_727 });
  assert.equal(ntsc.t1.firstDifference.timeSeconds, 31000 / 1_022_727);
  const empty = compareTraces(base, new Float64Array(0));
  assert.equal(empty.t0.firstDifference.cycle, 0);
  assert.equal(empty.t0.firstDifference.timeSeconds, 0);
});

test("an NTSC tune is verified on the NTSC clock taken from its PSID header", async () => {
  const original = await tune("funk_bass", undefined, "NTSC");
  const changed = await tune("funk_bass", (yaml) => yaml.replace(/(groove:\s*"[^"]*)E1/, "$1F1"), "NTSC");
  const sidlite = createLibsidplayfpEngine({ emulation: "sidlite" });
  const identical = await verifySid(original, original, { engine: sidlite, pcmEngine: sidlite, seconds: 0.35 });
  assert.equal(identical.levels.T0, "pass");
  assert.equal(identical.levels.T1, "pass");
  assert.equal(identical.levels.A0, "pass");
  const different = await verifySid(original, changed, { engine: sidlite, seconds: 3 });
  assert.equal(different.levels.T0, "fail");
  assert.equal(different.firstDifference.timeSeconds, different.firstDifference.cycle / 1_022_727);
  const forced = await verifySid(original, changed, { engine: sidlite, seconds: 3, clock: "PAL" });
  assert.equal(forced.firstDifference.timeSeconds, forced.firstDifference.cycle / 985_248);
});

test("comparing 120,000 call bursts takes linear time", () => {
  const writes = [];
  for (let i = 0; i < 120_000; i++) writes.push([0, 1, i & 255, 1000 + i * 10_000]);
  const trace = packed(writes);
  const started = performance.now();
  const result = compareTraces(trace, trace);
  const elapsed = performance.now() - started;
  assert.equal(result.t0.equal, true);
  assert.equal(result.t0.calls, 120_000);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});
