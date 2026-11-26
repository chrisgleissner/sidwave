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
async function tune(name = "funk_bass", transform) {
  let yaml = await readFile(path.join(root, `${name}.yaml`), "utf8");
  if (transform) yaml = transform(yaml);
  const doc = parseSidwave(yaml);
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
