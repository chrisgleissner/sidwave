// The reproducibility check of the development report compares verdicts, call counts, the first difference and the score hash.
import test from "#test/runner";
import assert from "#test/assert";
import { comparable, differences } from "../../scripts/check-reconstruct-repro.mjs";

const result = (over = {}) => ({
  strictExact: false, registerStateExact: false, compileOk: true, calls: 100, scoreSha256: "ab",
  fdiff: { differingCalls: 5, callsWithDifference: 4, comparedCalls: 99, first: { class: "gate", call: 0, voice: 1, register: 4, expected: 8, observed: 0 } },
  ...over,
});

test("equal results have no differing field", () => {
  assert.deepEqual(differences(comparable(result()), comparable(result())), []);
});

test("a changed first difference, call count or score hash is named", () => {
  const changed = result({ scoreSha256: "cd", fdiff: { ...result().fdiff, callsWithDifference: 7, first: { class: "pitch", call: 0, voice: 3, register: 14, expected: 224, observed: 22 } } });
  assert.deepEqual(differences(comparable(result()), comparable(changed)).sort(), ["callsWithDifference", "first", "scoreSha256"]);
});

test("the turbo flag defaults to false so that a report from before the flag compares equal to a non-turbo rerun", () => {
  assert.deepEqual(differences(comparable(result()), comparable(result({ turbo: false }))), []);
});
