// analyzeSid: the report of a reconstructed SID tune, its marks, and the reconstruction it rests on.
import test from "#test/runner";
import assert from "#test/assert";
import { analyzeSid, formatAnalysis } from "../src/analyze/analysis.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { checkMarks, seededSid } from "./helpers/analyzeKit.mjs";

test("a reconstructed SIDWave tune: observed trace facts, inferred musical facts, every inferred fact names its method", { timeout: 120_000 }, async () => {
  const sid = seededSid("combined", 1);
  const report = await analyzeSid(sid, { engine: sharedEngine(), seconds: 3 });
  assert.equal(report.schema, "sidwave-analysis/1");
  assert.equal(report.source.kind, "sid");
  assert.equal(report.source.md5.length, 32);
  assert.deepEqual({ seconds: report.horizon.seconds, song: report.horizon.song, clock: report.horizon.clock }, { seconds: 3, song: 1, clock: "PAL" });
  assert.equal(report.reconstruction.strictExact, true);
  const marks = checkMarks(report);
  assert.ok(marks.observed >= 8 && marks.inferred >= 6, JSON.stringify(marks));
  assert.equal(report.key.basis, "inferred");
  assert.equal(report.metre.declared.basis, "inferred");
  assert.match(report.metre.declared.method, /reconstruction/);
  assert.equal(report.form.declaredSections[0].basis, "inferred");
  assert.ok(report.techniques.length >= 4 && report.techniques.every((t) => t.basis === "observed"));
  const names = report.techniques.map((t) => t.name);
  for (const expected of ["hard restart", "vibrato", "pulse width sweep", "filter sweep", "arpeggio"]) assert.ok(names.includes(expected), `${expected} in ${names}`);
  assert.equal(report.resources.trace.basis, "observed");
  assert.equal(report.resources.trace.callsPerFrame, 1);
  assert.equal(report.resources.memory.basis, "observed");
  assert.ok(report.resources.memory.bytes > 1000);
  assert.ok(report.resources.trace.callSpanCycles.max >= report.resources.trace.callSpanCycles.median);
  assert.equal(report.voices.length, 3);
  assert.ok(report.voices.every((v) => v.trace.basis === "observed" && v.trace.frequencyRange));
  const text = formatAnalysis(report);
  assert.match(text, /\[observed\]/);
  assert.match(text, /\[inferred: /);
  assert.match(text, /Key /);
});

test("the report is deterministic: two analyses of the same tune give identical JSON", { timeout: 120_000 }, async () => {
  const sid = seededSid("pulse", 2);
  const a = await analyzeSid(sid, { engine: sharedEngine(), seconds: 2 });
  const b = await analyzeSid(sid, { engine: sharedEngine(), seconds: 2 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("sample playback and two SIDs: the trace facts that the language cannot express are reported, not hidden", { timeout: 120_000 }, async () => {
  const sampler = await analyzeSid(new Uint8Array(buildFixture("nmiSampler").sid), { engine: sharedEngine(), seconds: 3 });
  const digi = sampler.techniques.find((t) => t.name === "sample playback");
  assert.ok(digi && digi.evidence.writesPerSecond > 1000, JSON.stringify(digi));
  assert.ok(sampler.limits.some((l) => /cannot express/.test(l)));
  const two = await analyzeSid(new Uint8Array(buildFixture("twoSids").sid), { engine: sharedEngine(), seconds: 3 });
  assert.equal(two.resources.memory.sidCount, 2);
  const second = two.voices.filter((v) => v.sid === 1);
  assert.ok(second.length >= 1 && second.every((v) => v.trace.gateShare > 0 && v.role.value === "unreconstructed" && v.role.basis === "inferred"), "the voices of the second SID are traced and marked as not reconstructed");
});

test("a tune whose reconstruction does not parse still gets the observed facts, with the reason in the limits", { timeout: 120_000 }, async () => {
  const report = await analyzeSid(new Uint8Array(buildFixture("testBit").sid), { engine: sharedEngine(), seconds: 3 });
  assert.equal(report.key, undefined);
  assert.equal(report.metre, undefined);
  assert.ok(report.limits.some((l) => /could not be used for musical facts/.test(l)));
  assert.ok(report.techniques.some((t) => t.name === "test bit"));
  assert.match(formatAnalysis(report), /Techniques/);
});

test("the subtune argument selects the tune that is traced", { timeout: 120_000 }, async () => {
  await assert.rejects(() => analyzeSid(seededSid("basic", 1), { engine: sharedEngine(), song: 5, seconds: 1 }));
});
