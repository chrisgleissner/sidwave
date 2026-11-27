import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateSidwave } from "../src/audio/generateSidwave.js";

// The version 1 generator must keep its bytes for every existing style and seed. The hashes were recorded from the
// generator before the composer 2 option existed (test/fixtures/compose/generator-v1-baseline.json).
const baseline = JSON.parse(readFileSync(new URL("./fixtures/compose/generator-v1-baseline.json", import.meta.url), "utf8"));

test("the version 1 generator output is unchanged for the recorded styles, seeds and options", () => {
  assert.ok(baseline.length >= 70);
  for (const { options, sha256 } of baseline) {
    const digest = createHash("sha256").update(JSON.stringify(generateSidwave(options))).digest("hex");
    assert.equal(digest, sha256, JSON.stringify(options));
  }
});

test("composer: 1 is the same as leaving the option out", () => {
  for (const { options } of baseline.slice(0, 12)) {
    assert.equal(JSON.stringify(generateSidwave({ ...options, composer: 1 })), JSON.stringify(generateSidwave(options)));
  }
});
