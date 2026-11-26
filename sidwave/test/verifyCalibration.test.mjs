import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import {
  classify, decodeStats, encodeStats, gridPoints, manifestHash, objective, preferLarger, rateOf, scoreItems, selectParameters, splitSide,
} from "../src/verify/calibration.ts";

/** Statistics of a render pair with the given per-window spectral differences, all windows loud. */
function stats(dSpec, { dLevel = 0, truncated } = {}) {
  const n = dSpec.length;
  return {
    windows: n, dSpec: Float32Array.from(dSpec), dLevel: Float32Array.from({ length: n }, () => dLevel),
    levelReference: new Float32Array(n).fill(-20), levelCandidate: new Float32Array(n).fill(-20),
    truncated: Uint8Array.from(truncated ?? new Array(n).fill(0)),
  };
}
const item = (tune, cls, severity, label, d) => ({ tune, class: cls, severity, label, stats: stats(d) });
const quiet = new Array(100).fill(0);
const loud = (from, len, value) => quiet.map((v, i) => (i >= from && i < from + len ? value : v));

test("splitSide: the SHA-256 of the tune id modulo 10 decides, below 7 is development", () => {
  for (const id of ["example:funk_bass", "example:fuer_elise", "gen:funk:121", "gen:ambient:111"]) {
    const expected = Number(BigInt("0x" + createHash("sha256").update(id).digest("hex")) % 10n) < 7 ? "development" : "heldout";
    assert.equal(splitSide(id), expected);
  }
  assert.equal(splitSide("x"), Number(BigInt("0x2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881") % 10n) < 7 ? "development" : "heldout");
  const sides = Array.from({ length: 200 }, (_, i) => splitSide(`tune-${i}`));
  const dev = sides.filter((s) => s === "development").length;
  assert.ok(dev > 110 && dev < 170, `development ${dev}`);
});

test("rateOf gives Wilson 95 % intervals", () => {
  const half = rateOf(5, 10);
  assert.ok(Math.abs(half.low - 0.2366) < 0.001 && Math.abs(half.high - 0.7634) < 0.001, JSON.stringify(half));
  const none = rateOf(0, 20);
  assert.equal(none.rate, 0);
  assert.equal(none.low, 0);
  assert.ok(Math.abs(none.high - 0.1611) < 0.001, `${none.high}`);
  const all = rateOf(20, 20);
  assert.equal(all.high, 1);
  assert.deepEqual(rateOf(0, 0), { count: 0, total: 0, rate: 0, low: 0, high: 1 });
});

test("classify applies the window rules and names the first bad window", () => {
  const p = { thetaSpec: 10, thetaLevel: 6, sGap: 10, k: 2, m: 3 };
  const pass = classify(item("t", "c", "1", "M", loud(10, 1, 30)), p);
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.badWindows, 1);
  const fail = classify(item("t", "c", "1", "M", loud(10, 2, 30)), p);
  assert.equal(fail.verdict, "fail");
  assert.deepEqual(fail.firstBad, { timeSeconds: (10 * 512) / 48000, class: "spectral" });
});

test("scoreItems counts false accepts and rejects by class and lists the misclassified cases", () => {
  const p = { thetaSpec: 10, thetaLevel: 6, sGap: 10, k: 2, m: 3 };
  const items = [
    item("a", "wrong_note", "1", "M", loud(5, 3, 40)),
    item("b", "wrong_note", "1", "M", quiet),
    item("a", "detune_voice", "3", "B", loud(5, 3, 40)),
    item("b", "detune_voice", "3", "B", quiet),
    item("c", "detune_voice", "8", "X", loud(5, 3, 40)),
    item("c", "tempo_drift", "0.5", "X", quiet),
  ];
  const report = scoreItems(items, p);
  assert.deepEqual([report.falseAccept.count, report.falseAccept.total, report.falseReject.count, report.falseReject.total], [1, 2, 1, 2]);
  assert.deepEqual(report.borderline, { passed: 1, total: 2 });
  assert.deepEqual(report.misclassified, [
    { tune: "b", class: "wrong_note", severity: "1", label: "M", verdict: "pass", firstBad: "no bad window" },
    { tune: "a", class: "detune_voice", severity: "3", label: "B", verdict: "fail", firstBad: `${((5 * 512) / 48000).toFixed(3)} s (spectral)` },
  ]);
  assert.equal(report.byClass.wrong_note.falseAccept.count, 1);
  assert.equal(report.byClass.wrong_note.falseReject, undefined);
  assert.equal(report.byClass.detune_voice.falseReject.total, 2);
  assert.ok(Math.abs(objective(report) - (3 * 0.5 + 0.5)) < 1e-12);
});

test("selectParameters minimises 3 FA + FR and prefers larger thresholds on ties", () => {
  assert.equal(gridPoints().length, 648);
  // Material defects differ by 12 dB in 4 windows; benign changes differ by 4 dB: every thetaSpec from 6 to 10 separates them.
  const items = [
    item("a", "wrong_note", "1", "M", loud(10, 4, 12)), item("b", "wrong_note", "1", "M", loud(30, 4, 12)),
    item("a", "detune_voice", "3", "B", loud(10, 4, 4)), item("b", "detune_voice", "3", "B", loud(30, 4, 4)),
  ];
  let seen = 0;
  const selection = selectParameters(items, () => { seen++; });
  assert.equal(seen, 648);
  assert.equal(selection.evaluated, 648);
  assert.equal(selection.best.falseAccept.count, 0);
  assert.equal(selection.best.falseReject.count, 0);
  assert.deepEqual(selection.best.parameters, { thetaSpec: 10, thetaLevel: 9, sGap: 15, k: 4, m: 8 });
  assert.equal(selection.top.length, 5);
  assert.ok(selection.top.every((t) => t.objective === 0));
  assert.ok(preferLarger({ thetaSpec: 10, thetaLevel: 3, sGap: 6, k: 2, m: 3 }, { thetaSpec: 8, thetaLevel: 9, sGap: 15, k: 4, m: 8 }) < 0);
  assert.equal(preferLarger({ thetaSpec: 8, thetaLevel: 3, sGap: 6, k: 2, m: 3 }, { thetaSpec: 8, thetaLevel: 3, sGap: 6, k: 2, m: 3 }), 0);
  assert.ok(preferLarger({ thetaSpec: 8, thetaLevel: 3, sGap: 6, k: 2, m: 3 }, { thetaSpec: 8, thetaLevel: 3, sGap: 6, k: 3, m: 3 }) > 0);
});

test("window statistics survive a round trip through the cache format", () => {
  const original = stats([0, 1.5, 22, 3], { dLevel: 2.5, truncated: [0, 0, 1, 0] });
  const decoded = decodeStats(encodeStats(original, 4));
  assert.equal(decoded.lagMs, 4);
  assert.equal(decoded.stats.windows, 4);
  assert.deepEqual([...decoded.stats.dSpec], [0, 1.5, 22, 3]);
  assert.deepEqual([...decoded.stats.dLevel], [2.5, 2.5, 2.5, 2.5]);
  assert.deepEqual([...decoded.stats.levelReference], [-20, -20, -20, -20]);
  assert.deepEqual([...decoded.stats.truncated], [0, 0, 1, 0]);
  assert.throws(() => decodeStats(Buffer.alloc(4)), /not an A1 statistics file/);
  const bad = encodeStats(original, 0).subarray(0, 30);
  assert.throws(() => decodeStats(bad), /wrong size/);
});

test("manifestHash is the SHA-256 of the canonical JSON", () => {
  const manifest = { bases: [{ id: "a", sha256: "00" }], mutations: [{ class: "c", severity: "1", label: "M" }], horizonMaxSeconds: 180, sampleRate: 48000 };
  assert.equal(manifestHash(manifest), createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
});
