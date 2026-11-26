import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { SIDWAVE_SCORE_RESOURCES, readSidwaveExample } from "../src/sidwaveExamples.js";

// SHA-256 of the PRG (looping and play-once) and of the PSID of all 14 bundled examples, computed on origin/main
// before the S4a game build existed (fixtures/sidwave-s4a/example-hashes.json). A score that cannot be written
// in a format records the error message. The game build must not change any of these bytes.
const fixture = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sidwave-s4a", "example-hashes.json"), "utf8"));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const attempt = (fn) => { try { return fn(); } catch (error) { return `error: ${error.message}`; } };

test("the fixture covers all 14 examples", () => {
  assert.equal(SIDWAVE_SCORE_RESOURCES.length, 14);
  assert.deepEqual(Object.keys(fixture).sort(), SIDWAVE_SCORE_RESOURCES.map(({ name }) => name).sort());
});

for (const { name } of SIDWAVE_SCORE_RESOURCES) {
  test(`example ${name} keeps its PRG and PSID bytes`, () => {
    const doc = () => parseSidwave(readSidwaveExample(name));
    assert.equal(attempt(() => sha(compileSidwaveToPrg(doc()).prg)), fixture[name].prg);
    assert.equal(attempt(() => sha(compileSidwaveToPrg(doc(), { loop: false }).prg)), fixture[name].prgNoLoop);
    assert.equal(attempt(() => { const d = doc(); return sha(compileSidwaveToSid(d, compileSidwaveToPrg(d).prg).sid); }), fixture[name].sid);
  });
}
