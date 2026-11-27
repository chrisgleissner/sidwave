import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
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
  const image = (fill, size = 8192) => new Uint8Array(size).fill(fill);
  const roms = { kernal: image(1), basic: image(2), chargen: image(3, 4096) };
  // The images are placeholders, not runnable ROMs, so the engine renders without them; only their hashes matter here.
  const ignoringRoms = { id: residfp.id, get version() { return residfp.version; }, render: (req) => residfp.render({ ...req, roms: undefined }), trace: (req) => residfp.trace(req) };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const pinnedRoms = { kernal: hash(roms.kernal), basic: hash(roms.basic), chargen: hash(roms.chargen) };
  const version = residfp.version === "unknown" ? "1.1.1" : residfp.version;
  const pinned = (patch = {}) => ({ ...unfrozenRules(), conditions: { sampleRate: 48000, channels: 1, engine: { id: "libsidplayfp-wasm", version, emulation: "residfp" }, roms: pinnedRoms, ...patch } });
  const run = (a1) => verifySid(original, original, { engine: sidlite, seconds: 1, a1 });
  const wrongEngine = await run({ engine: sidlite, rules: unfrozenRules() });
  assert.equal(wrongEngine.levels.A1, "not evaluated");
  assert.match(wrongEngine.a1.reason, /requires reSIDfp rendering, not sidlite/);
  assert.equal(wrongEngine.a1.status, "approximate");
  const badVersion = await run({ engine: ignoringRoms, roms, rules: pinned({ engine: { id: "libsidplayfp-wasm", version: "0.0.1", emulation: "residfp" } }) });
  assert.equal(badVersion.levels.A1, "not evaluated");
  assert.match(badVersion.a1.reason, /differs from the pinned libsidplayfp-wasm 0\.0\.1/);
  const unknown = await run({ engine: residfp, rules: pinned() });
  assert.equal(unknown.levels.A1, "not evaluated");
  assert.match(unknown.a1.reason, /pins the kernal ROM and none was supplied/);
  const partial = await run({ engine: residfp, roms: { kernal: roms.kernal }, rules: pinned() });
  assert.match(partial.a1.reason, /pins the basic ROM and none was supplied/);
  const different = await run({ engine: residfp, roms: { ...roms, basic: image(9) }, rules: pinned() });
  assert.equal(different.levels.A1, "not evaluated");
  assert.match(different.a1.reason, /^The basic ROM differs from the ROM pinned/);
  const matching = await run({ engine: ignoringRoms, roms, rules: pinned() });
  assert.equal(matching.levels.A1, "pass");
  const unpinnedRules = await run({ engine: residfp, rules: unfrozenRules() });
  assert.equal(unpinnedRules.levels.A1, "pass");
  const none = await verifySid(original, original, { engine: sidlite, seconds: 1 });
  assert.equal(none.levels.A1, "not evaluated");
  assert.equal(none.a1, undefined);
});

test("A1 and verify seconds are bounded", async () => {
  const original = await tune();
  await assert.rejects(verifySid(original, original, { engine: sidlite, seconds: MAX_VERIFY_SECONDS + 1 }), (e) => e instanceof VerifyError && e.code === "invalid_options");
  await assert.rejects(verifySid(original, original, { engine: sidlite, seconds: 1, a1: { engine: residfp, rules: unfrozenRules(), seconds: 181 } }), /A1 seconds/);
});
