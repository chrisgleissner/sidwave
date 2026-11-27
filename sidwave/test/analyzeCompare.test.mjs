// compare: F-diff (total, per class, per voice), the verification ladder with the A1 status, and the semantic diff of two scores.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { compare, formatCompare } from "../src/analyze/compare.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { seededText, sidOfScore } from "./helpers/analyzeKit.mjs";

const score = (text) => ({ kind: "score", text, source: "score.yaml" });
const opts = { engine: sharedEngine(), seconds: 3, level: "A0" };

/** The first groove entry of the first pattern of voice 1 with its pitch moved by `by` semitones. */
function editFirstNote(text, note) {
  const doc = YAML.parse(text);
  const pattern = Object.values(doc.voices[0].patterns)[0];
  const first = pattern.groove.find((e) => e !== "-" && (typeof e === "string" || e.note));
  const index = pattern.groove.indexOf(first);
  pattern.groove[index] = typeof first === "string" ? note : { ...first, note };
  return YAML.stringify(doc);
}

test("a score against itself and against its compiled SID: the F-diff is equal and the ladder passes through A0", { timeout: 120_000 }, async () => {
  const text = seededText("combined", 1);
  const twice = await compare(score(text), score(text), opts);
  assert.equal(twice.equal, true);
  assert.equal(twice.fdiff.differingCalls, 0);
  assert.ok(twice.voices.length === 3 && twice.voices.every((v) => v.equal && v.differingCalls === 0));
  assert.equal(twice.ladder.levels.A0, "pass");
  assert.equal(twice.ladder.verdict, "pass");
  assert.equal(twice.musical.changes, 0);
  assert.equal(twice.musical.compiledEqual, true);
  const mixed = await compare({ kind: "sid", bytes: sidOfScore(text), source: "tune.sid" }, score(text), opts);
  assert.equal(mixed.equal, true);
  assert.equal(mixed.musical, undefined, "the semantic diff needs two scores");
  assert.ok(mixed.ladder.notes.some((n) => /T0 and T1/.test(n)));
  assert.match(formatCompare(mixed), /F-diff: equal/);
});

test("one changed note: the F-diff is different, only the edited voice differs, and the semantic diff names the change", { timeout: 120_000 }, async () => {
  const text = seededText("basic", 2);
  const changed = editFirstNote(text, "G5");
  assert.notEqual(changed, text);
  const r = await compare(score(text), score(changed), opts);
  assert.equal(r.equal, false);
  assert.equal(r.voices[0].equal, false);
  assert.equal(r.voices[0].first.class, "pitch");
  assert.ok(r.voices[1].equal && r.voices[2].equal, "voices 2 and 3 are unchanged");
  assert.equal(r.fdiff.classes.pitch.differingCalls > 0, true);
  assert.equal(r.musical.compiledEqual, false);
  assert.equal(r.musical.changes, 1);
  assert.equal(r.musical.byClass.musical, 1);
  assert.match(r.musical.first[0].path, /^\/voices\/0\/patterns\//);
  assert.equal(r.ladder.verdict, "fail");
  assert.ok(r.ladder.firstDifference);
  const text2 = formatCompare(r);
  assert.match(text2, /voice 1: \d+ differing calls/);
  assert.match(text2, /Musical diff: 1 changes/);
});

test("a formatting-only change leaves the F-diff equal and is classed as formatting", { timeout: 120_000 }, async () => {
  const text = seededText("basic", 3);
  const reformatted = `# a comment\n${text}\n`;
  const r = await compare(score(text), score(reformatted), { ...opts, noLadder: true });
  assert.equal(r.equal, true);
  assert.equal(r.ladder, undefined);
  assert.equal(r.musical.compiledEqual, true);
  assert.equal(r.musical.byClass.formatting, 1);
  assert.equal(r.musical.byClass.musical, 0);
});

test("A1 is reported with its calibration status; without the pinned ROMs it is not evaluated and says why", { timeout: 120_000 }, async () => {
  const text = seededText("basic", 1);
  const r = await compare(score(text), score(text), { engine: sharedEngine(), seconds: 2, level: "A1" });
  assert.equal(r.ladder.levels.A1, "not evaluated");
  assert.equal(r.ladder.a1.status, "approximate");
  assert.match(r.ladder.a1.reason, /ROM/);
  assert.ok(r.ladder.notes.some((n) => /A1 calibration status: approximate/.test(n)));
});

test("a horizon outside 0 to 180 s is a usage error", async () => {
  await assert.rejects(() => compare(score(seededText("basic", 1)), score(seededText("basic", 1)), { engine: sharedEngine(), seconds: 400, noLadder: true }), /horizon/);
});
