import test from "#test/runner";
import assert from "#test/assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.ts";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { MAX_VERIFY_SECONDS, VerifyError, verifySid } from "../src/verify/index.ts";
import { unfrozenRules } from "../src/verify/a1.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/sound/examples");
async function tune(name = "funk_bass", transform) {
  let yaml = await readFile(path.join(root, `${name}.yaml`), "utf8");
  if (transform) yaml = transform(yaml);
  const doc = parseSidwave(yaml);
  const prg = compileSidwaveToPrg(doc);
  return new Uint8Array(compileSidwaveToSid(doc, prg.prg, { initAddress: prg.initAddress, playAddress: prg.playAddress }).sid);
}

const sidlite = createLibsidplayfpEngine({ emulation: "sidlite" });
const residfp = createLibsidplayfpEngine({ emulation: "residfp" });

test("A1 passes identical tunes and fails a changed melody on reSIDfp, naming the first difference", async () => {
  const original = await tune();
  const changed = await tune("funk_bass", (yaml) => yaml.replace(/(groove:\s*"[^"]*)E1/, "$1F1"));
  const same = await verifySid(original, original, { engine: sidlite, seconds: 2, a1: { engine: residfp, rules: unfrozenRules() } });
  assert.equal(same.levels.A1, "pass");
  assert.equal(same.level, "T0");
  assert.equal(same.a1.badWindows, 0);
  assert.equal(same.a1.windows, 186);
  assert.equal(same.a1.horizonSeconds, 2);
  assert.equal(same.a1.rulesSha256, "unfrozen");
  assert.equal(same.engines.a1.emulation, "residfp");
  const different = await verifySid(original, changed, { engine: sidlite, seconds: 3, a1: { engine: residfp, rules: unfrozenRules({ thetaSpec: 3, thetaLevel: 3, sGap: 10, k: 2, m: 3 }) } });
  assert.equal(different.levels.T0, "fail");
  assert.equal(different.levels.A1, "fail");
  assert.equal(different.level, "none");
  assert.ok(different.a1.badWindows > 0);
  assert.equal(different.a1.firstBad.class, "spectral");
});

test("A1 reports why it was not evaluated", async () => {
  const original = await tune();
  const pinned = (patch) => ({ ...unfrozenRules(), conditions: { sampleRate: 48000, channels: 1, engine: { id: "libsidplayfp-wasm", version: "1.1.1", emulation: "residfp" }, roms: { kernal: "k", basic: "b", chargen: "c" }, ...patch } });
  const wrongEngine = await verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: sidlite, rules: unfrozenRules() } });
  assert.equal(wrongEngine.levels.A1, "not evaluated");
  assert.match(wrongEngine.a1.reason, /requires reSIDfp rendering, not sidlite/);
  const version = await verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: residfp, rules: pinned({ engine: { id: "libsidplayfp-wasm", version: "0.0.1", emulation: "residfp" } }) } });
  assert.equal(version.levels.A1, "not evaluated");
  assert.match(version.a1.reason, /differs from the pinned libsidplayfp-wasm 0\.0\.1/);
  const rom = await verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: residfp, rules: pinned(), romHashes: { basic: "other" } } });
  assert.equal(rom.levels.A1, "not evaluated");
  assert.match(rom.a1.reason, /basic ROM differs/);
  const matching = await verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: residfp, rules: pinned({ engine: { id: "libsidplayfp-wasm", version: residfp.version === "unknown" ? "1.1.1" : residfp.version, emulation: "residfp" } }), romHashes: { basic: "b" } } });
  assert.equal(matching.levels.A1, "pass");
  const none = await verifySid(original, original, { engine: sidlite, seconds: 1 });
  assert.equal(none.levels.A1, "not evaluated");
  assert.equal(none.a1, undefined);
});

test("A1 and verify seconds are bounded", async () => {
  const original = await tune();
  await assert.rejects(verifySid(original, original, { engine: sidlite, seconds: MAX_VERIFY_SECONDS + 1 }), (e) => e instanceof VerifyError && e.code === "invalid_options");
  await assert.rejects(verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: residfp, rules: unfrozenRules(), seconds: 181 } }), /A1 seconds/);
});
