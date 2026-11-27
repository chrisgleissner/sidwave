import test from "#test/runner";
import assert from "#test/assert";
import { compareHits, onsetTolerance } from "../src/interchange/convertMetrics.ts";

const notes = () => [
  { time: 0, end: 0.5, pitch: 60, voice: 0 },
  { time: 1, end: 1.5, pitch: 62, voice: 0 },
  { time: 2, end: 2.5, pitch: 64, voice: 1 },
  { time: 3, end: 3.5, pitch: 65, voice: 1 },
];

test("compareHits reports perfect agreement for identical notes", () => {
  const result = compareHits(notes(), notes(), 0.02);
  assert.equal(result.noteF1, 1);
  assert.equal(result.durationOverlap, 1);
  assert.equal(result.voiceAgreement, 1);
  assert.equal(result.voiceAgreementIdentity, 1);
  assert.equal(result.onsetError.maxMs, 0);
});

test("compareHits measures shortened note durations", () => {
  const ref = notes();
  const out = ref.map((hit) => ({ ...hit, end: hit.end - 0.01 }));
  const result = compareHits(ref, out, 0.02);
  assert.equal(result.durationOverlap, 0.98);
  assert.equal(result.noteF1, 1);
});

test("compareHits applies onset tolerance", () => {
  const ref = notes();
  const out = ref.map((hit) => ({ ...hit, time: hit.time + 0.07, end: hit.end + 0.07 }));
  assert.equal(compareHits(ref, out, 0.02).noteF1, 0);
  const accepted = compareHits(ref, out, 0.0725);
  assert.equal(accepted.noteF1, 1);
  assert.equal(accepted.onsetError.meanMs, 70);
});

test("compareHits distinguishes voice mapping from voice identity", () => {
  const ref = notes();
  const out = ref.map((hit) => ({ ...hit, voice: hit.voice === 0 ? 1 : 0 }));
  const result = compareHits(ref, out, 0.02);
  assert.equal(result.voiceAgreement, 1);
  assert.equal(result.voiceAgreementIdentity, 0);
});

test("compareHits checks drum identity", () => {
  const ref = [{ time: 0, end: 0.5, pitch: 36, voice: 0, drum: "kick" }];
  const pitched = [{ time: 0, end: 0.5, pitch: 36, voice: 0 }];
  const mismatched = compareHits(ref, pitched, 0.02);
  assert.equal(mismatched.drumIdentity, 0);
  assert.equal(mismatched.noteF1, 0);
  assert.equal(compareHits(ref, [{ ...pitched[0], drum: "kick" }], 0.02).drumIdentity, 1);
});

test("compareHits reports octave tolerant matches", () => {
  const ref = notes();
  const out = ref.map((hit) => ({ ...hit, pitch: hit.pitch + 12 }));
  const result = compareHits(ref, out, 0.02);
  assert.equal(result.noteF1, 0);
  assert.equal(result.noteF1OctaveTolerant, 1);
  assert.equal(result.octaveShifted, ref.length);
});

test("compareHits treats two empty note lists as a perfect match", () => {
  const result = compareHits([], [], 0.02);
  assert.equal(result.noteF1, 1);
  assert.equal(result.durationOverlap, 1);
});

test("onsetTolerance uses a frame floor and a 100 ms cap", () => {
  assert.equal(onsetTolerance([], undefined), 0.02);
  assert.ok(Math.abs(onsetTolerance([], 0.125) - 0.0725) <= 1e-9);
  assert.equal(onsetTolerance([], 0.5), 0.1);
  assert.equal(onsetTolerance([], 0.01), 0.02);
});
