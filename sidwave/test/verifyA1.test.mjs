import test from "#test/runner";
import assert from "#test/assert";
import {
  A1_CLASSES, A1_GRID, A1_STARTING_PARAMETERS, A1Error, analyzeAudioA1, compareAudioA1, decideWindows, extractFeatures,
  fft, findLag, loadA1Rules, parseA1Rules, tuneVerdict, unfrozenRules, windowCount,
} from "../src/verify/a1.ts";
import { createHash } from "node:crypto";

const SR = 48_000;
const NOTES = [262, 330, 392, 523, 440, 349, 294, 392, 330, 262, 494, 587];

/** Phase-continuous tone with 5 ms raised-cosine edges, so that note boundaries carry no clicks. */
function tone(freq, seconds, amplitude = 0.3) {
  const n = Math.round(seconds * SR);
  const out = new Int16Array(n);
  const ramp = Math.round(0.005 * SR);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    const gain = edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
    out[i] = Math.round(amplitude * 32767 * gain * Math.sin((2 * Math.PI * freq * i) / SR));
  }
  return out;
}

function melody({ cents = 0, shiftSeconds = 0 } = {}) {
  const parts = NOTES.map((f) => tone(f * 2 ** (cents / 1200), 0.2));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  if (!shiftSeconds) return out;
  const shift = Math.round(shiftSeconds * SR);
  const shifted = new Int16Array(total);
  shifted.set(out.subarray(0, total - shift), shift);
  return shifted;
}

const strict = { thetaSpec: 2.5, thetaLevel: 3, sGap: 10, k: 2, m: 8 };
const reference = melody();

test("fft matches a direct transform and rejects bad lengths", () => {
  const re = Float64Array.from({ length: 8 }, (_, i) => Math.sin(i) + i * 0.1);
  const im = new Float64Array(8);
  const expected = [];
  for (let k = 0; k < 8; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < 8; n++) { sr += re[n] * Math.cos((2 * Math.PI * k * n) / 8); si -= re[n] * Math.sin((2 * Math.PI * k * n) / 8); }
    expected.push([sr, si]);
  }
  fft(re, im);
  for (let k = 0; k < 8; k++) {
    assert.ok(Math.abs(re[k] - expected[k][0]) < 1e-9 && Math.abs(im[k] - expected[k][1]) < 1e-9, `bin ${k}`);
  }
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)), A1Error);
  assert.throws(() => fft(new Float64Array(2048), new Float64Array(2048)), /power of two/);
});

test("windowCount and features: a full-scale sine is -3 dBFS and a quiet band sits at the floor", () => {
  assert.equal(windowCount(1023), 0);
  assert.equal(windowCount(1024), 1);
  assert.equal(windowCount(1536), 2);
  const sine = new Int16Array(4096);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.round(32767 * Math.sin((2 * Math.PI * 1500 * i) / SR));
  const features = extractFeatures(sine, 2);
  assert.ok(Math.abs(features.level[0] - -3.01) < 0.01, `level ${features.level[0]}`);
  const loudest = Math.max(...features.bands.subarray(0, 48));
  assert.ok(loudest > -8 && loudest < -3, `band ${loudest}`);
  const silent = extractFeatures(new Int16Array(2048), 1);
  assert.equal(silent.level[0], -120);
  assert.ok(silent.bands.every((v) => v === -120));
});

test("identical renders pass with no bad window and lag 0", () => {
  const result = compareAudioA1(reference, melody(), unfrozenRules());
  assert.deepEqual(result, {
    verdict: "pass", lagMs: 0, windows: 224, badWindows: 0,
    badByClass: { spectral: 0, level: 0, sound_in_silence: 0, missing_sound: 0, truncated: 0 },
    horizonSeconds: 2.4, truncated: false, rulesSha256: "unfrozen",
  });
});

test("silence against a tone fails in every window, in both directions", () => {
  const silent = new Int16Array(reference.length);
  const missing = compareAudioA1(reference, silent, unfrozenRules());
  assert.equal(missing.verdict, "fail");
  assert.equal(missing.badByClass.missing_sound, 224);
  assert.deepEqual(missing.firstBad, { timeSeconds: 0, class: "missing_sound" });
  const extra = compareAudioA1(silent, reference, unfrozenRules());
  assert.equal(extra.badByClass.sound_in_silence, 224);
  assert.deepEqual(extra.firstBad, { timeSeconds: 0, class: "sound_in_silence" });
  const both = compareAudioA1(silent, new Int16Array(silent.length), unfrozenRules());
  assert.equal(both.verdict, "pass");
  assert.equal(both.badWindows, 0);
});

test("a detuned tone is judged by the spectral threshold: 8 cents passes, 50 cents fails", () => {
  const a = analyzeAudioA1(reference, melody({ cents: 8 }));
  const b = analyzeAudioA1(reference, melody({ cents: 50 }));
  const mean = (stats) => stats.dSpec.reduce((s, v) => s + v, 0) / stats.windows;
  assert.ok(Math.abs(mean(a.stats) - 0.79) < 0.05, `8 cents ${mean(a.stats)}`);
  assert.ok(Math.abs(mean(b.stats) - 4.14) < 0.1, `50 cents ${mean(b.stats)}`);
  assert.equal(compareAudioA1(reference, melody({ cents: 8 }), unfrozenRules(strict)).verdict, "pass");
  const fifty = compareAudioA1(reference, melody({ cents: 50 }), unfrozenRules(strict));
  assert.equal(fifty.verdict, "fail");
  assert.equal(fifty.firstBad.class, "spectral");
});

test("a 5 ms shift is aligned (lag within 2 ms of the shift) and passes; a 40 ms shift is outside the lag range and fails", () => {
  const near = compareAudioA1(reference, melody({ shiftSeconds: 0.005 }), unfrozenRules(strict));
  assert.equal(near.verdict, "pass");
  assert.ok(Math.abs(near.lagMs - 5) <= 2, `lag ${near.lagMs}`);
  const far = compareAudioA1(reference, melody({ shiftSeconds: 0.04 }), unfrozenRules(strict));
  assert.equal(far.verdict, "fail");
  assert.equal(far.lagMs, 24);
  assert.ok(far.badWindows >= 12, `bad windows ${far.badWindows}`);
});

test("findLag returns a multiple of 96 samples within 24 ms and reports a late candidate as positive", () => {
  const late = melody({ shiftSeconds: 0.012 });
  const lag = findLag({ samples: reference }, late, reference.length);
  assert.equal(lag, 576);
  assert.equal(lag % 96, 0);
  assert.equal(findLag({ samples: reference }, reference, reference.length), 0);
});

test("the cached lag flux is recomputed when the horizon changes", () => {
  const cache = { samples: reference };
  const late = melody({ shiftSeconds: 0.012 });
  findLag(cache, late, 24_000);
  const short = cache.flux.length;
  assert.equal(cache.fluxHorizon, 24_000);
  findLag(cache, late, reference.length);
  assert.equal(cache.fluxHorizon, reference.length);
  assert.ok(cache.flux.length > short, `${cache.flux.length} > ${short}`);
});

test("one 30 ms burst in a rest of the tune is isolated: it fails with K=2 but not with K=6", () => {
  const withRest = new Int16Array(SR * 2);
  withRest.set(tone(440, 0.6), 0);
  withRest.set(tone(440, 0.6), SR * 1.4);
  const burst = withRest.slice();
  const noise = Math.round(0.03 * SR);
  for (let i = 0; i < noise; i++) burst[Math.round(SR * 1.0) + i] = i % 2 ? 9000 : -9000;
  const failing = compareAudioA1(withRest, burst, unfrozenRules({ thetaSpec: 15, thetaLevel: 6, sGap: 10, k: 2, m: 8 }));
  assert.equal(failing.verdict, "fail");
  assert.equal(failing.firstBad.class, "sound_in_silence");
  assert.ok(Math.abs(failing.firstBad.timeSeconds - 1.0) < 0.03, `first bad ${failing.firstBad.timeSeconds}`);
  assert.equal(failing.badWindows, 5);
  const lenient = compareAudioA1(withRest, burst, unfrozenRules({ thetaSpec: 15, thetaLevel: 6, sGap: 10, k: 6, m: 8 }));
  assert.equal(lenient.verdict, "pass");
  assert.equal(lenient.badWindows, 5);
});

test("a render shorter than the horizon counts its missing windows as truncated", () => {
  const result = compareAudioA1(reference, reference.subarray(0, SR), unfrozenRules(), { horizonSeconds: 2.4 });
  assert.equal(result.truncated, true);
  assert.equal(result.verdict, "fail");
  assert.equal(result.badByClass.truncated, 224 - windowCount(SR));
  assert.equal(result.firstBad.class, "truncated");
  assert.ok(Math.abs(result.firstBad.timeSeconds - (SR - 1024) / SR) < 0.011);
});

test("tuneVerdict: K consecutive windows, M windows within 2 s, and the first failing window", () => {
  const codes = (bad) => { const c = new Uint8Array(400); for (const w of bad) c[w] = 1; return c; };
  assert.equal(tuneVerdict(codes([5, 7, 9]), { k: 2, m: 4 }).verdict, "pass");
  const run = tuneVerdict(codes([5, 20, 21]), { k: 2, m: 4 });
  assert.equal(run.verdict, "fail");
  assert.equal(run.firstBadWindow, 20);
  const span = tuneVerdict(codes([5, 50, 100]), { k: 2, m: 3 });
  assert.equal(span.verdict, "fail");
  assert.equal(span.firstBadWindow, 5);
  assert.equal(tuneVerdict(codes([5, 50, 200]), { k: 2, m: 3 }).verdict, "pass");
  const mixed = tuneVerdict(codes([100, 101, 300, 310, 320]), { k: 2, m: 3 });
  assert.equal(mixed.firstBadWindow, 100);
  assert.equal(mixed.badByClass.spectral, 5);
});

test("decideWindows applies the silence, gap, spectral and level rules in order", () => {
  const stats = {
    windows: 6,
    dSpec: Float32Array.from([0, 20, 0, 5, 30, 0]),
    dLevel: Float32Array.from([0, 0, 8, 2, 0, 0]),
    levelReference: Float32Array.from([-80, -30, -30, -30, -55, -30]),
    levelCandidate: Float32Array.from([-80, -30, -37, -30, -30, -80]),
    truncated: Uint8Array.from([0, 0, 0, 0, 0, 1]),
  };
  const codes = decideWindows(stats, { thetaSpec: 15, thetaLevel: 6, sGap: 10 });
  assert.deepEqual([...codes].map((c) => (c ? A1_CLASSES[c - 1] : "equal")),
    ["equal", "spectral", "level", "equal", "spectral", "truncated"]);
  const gap = { ...stats, levelReference: Float32Array.from([-80, -30, -30, -30, -80, -30]), levelCandidate: Float32Array.from([-80, -30, -37, -30, -45, -80]) };
  assert.equal(A1_CLASSES[decideWindows(gap, { thetaSpec: 15, thetaLevel: 6, sGap: 10 })[4] - 1], "sound_in_silence");
  assert.equal(A1_CLASSES[decideWindows({ ...gap, levelReference: Float32Array.from([-30, -30, -30, -30, -45, -30]), levelCandidate: Float32Array.from([-30, -30, -37, -30, -80, -80]) }, { thetaSpec: 15, thetaLevel: 6, sGap: 10 })[4] - 1], "missing_sound");
});

test("invalid input is refused with A1Error", () => {
  assert.throws(() => compareAudioA1(reference, reference, unfrozenRules(), { sampleRate: 44100 }), /48000 Hz/);
  assert.throws(() => compareAudioA1(reference, reference, unfrozenRules(), { horizonSeconds: 0.01 }), /at least one/);
  assert.throws(() => compareAudioA1(reference, reference, unfrozenRules(), { horizonSeconds: -1 }), /positive/);
  assert.throws(() => compareAudioA1(reference, reference.slice(), unfrozenRules(), { reference: { samples: new Int16Array(10) } }), /another signal/);
});

test("a cached reference gives the same result", () => {
  const cache = { samples: reference };
  const a = compareAudioA1(reference, melody({ cents: 50 }), unfrozenRules(strict), { reference: cache });
  const b = compareAudioA1(reference, melody({ cents: 50 }), unfrozenRules(strict), { reference: cache });
  assert.deepEqual(a, b);
  assert.ok(cache.features && cache.flux);
});

test("rule files: parsing, hashing and validation", () => {
  const file = {
    schema: "sidwave-a1-rules/1", parameters: { thetaSpec: 10, thetaLevel: 6, sGap: 10, k: 3, m: 5 },
    conditions: { sampleRate: 48000, channels: 1, engine: { id: "libsidplayfp-wasm", version: "1.1.1", emulation: "residfp" } },
  };
  const text = JSON.stringify(file);
  const rules = parseA1Rules(text);
  assert.equal(rules.thetaSpec, 10);
  assert.equal(rules.sha256, createHash("sha256").update(text).digest("hex"));
  assert.throws(() => parseA1Rules("{"), /not valid JSON/);
  assert.throws(() => parseA1Rules(JSON.stringify({ ...file, schema: "x" })), A1Error);
  assert.throws(() => parseA1Rules(JSON.stringify({ ...file, parameters: { ...file.parameters, k: 2.5 } })), A1Error);
  assert.throws(() => parseA1Rules(JSON.stringify({ ...file, conditions: { sampleRate: 44100 } })), A1Error);
  assert.equal(unfrozenRules().sha256, "unfrozen");
  assert.deepEqual(unfrozenRules(), { ...A1_STARTING_PARAMETERS, sha256: "unfrozen" });
  assert.equal(Object.values(A1_GRID).reduce((n, v) => n * v.length, 1), 648);
  assert.throws(() => loadA1Rules("/nonexistent/a1-rules.json"), /ENOENT/);
});
