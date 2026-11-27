// CPU-time bounds (process CPU time, not wall time) of the trace-level operations of the analysis, comparison and
// preservation code. SIDWave must be fast: every operation is linear (or n log n) in the number of player calls.
import test from "#test/runner";
import assert from "#test/assert";
import { cpuMicros, differingCalls, irFingerprint, restrictIrToVoice, sliceIr } from "../src/analyze/common.ts";
import { traceResources, traceVoiceFacts } from "../src/analyze/analysis.ts";
import { detectCoupling } from "../src/analyze/isolate.ts";
import { techniquesFromIr } from "../src/analyze/techniques.ts";
import { fdiff } from "../src/reconstruct/fdiff.ts";
import { freqWrites, syntheticIr } from "./helpers/analyzeKit.mjs";

const A4 = 0x1d45;
const tune = (calls, shift = 0) => syntheticIr(calls, (c) => {
  const w = [];
  for (let v = 0; v < 3; v++) w.push([v * 7 + 4, c % 20 < 15 ? 0x41 : 0x40], ...freqWrites(v, A4 + ((c * (v + 3)) % 90) + shift), [v * 7 + 2, (c * 7) & 0xff]);
  w.push([0x15, c & 7], [0x16, (c >> 3) & 0xff], [0x17, 0xf7], [0x18, 0x1f]);
  return w;
});

function time(fn) {
  fn();
  const t0 = cpuMicros();
  fn();
  return cpuMicros() - t0;
}

test("CPU time of the trace operations: 36,000 calls (12 minutes of a 50 Hz tune) take well under a second each", () => {
  const ir = tune(36_000);
  const other = tune(36_000, 1);
  const budgets = {
    "irFingerprint": [() => irFingerprint(ir), 600_000],
    "restrictIrToVoice": [() => restrictIrToVoice(ir, 2), 600_000],
    "differingCalls": [() => differingCalls(ir, other, 1, 1), 600_000],
    "traceVoiceFacts": [() => traceVoiceFacts(ir), 800_000],
    "traceResources": [() => traceResources(ir), 600_000],
    "detectCoupling": [() => detectCoupling(ir, 1), 600_000],
    "sliceIr": [() => sliceIr(ir, 1, 30_000), 600_000],
    "techniquesFromIr": [() => techniquesFromIr(ir), 1_000_000],
    "fdiff": [() => fdiff(ir, other, { alignExpected: 1, alignObserved: 1 }), 2_000_000],
  };
  const results = {};
  for (const [name, [fn, budget]] of Object.entries(budgets)) {
    results[name] = time(fn);
    assert.ok(results[name] < budget, `${name}: ${results[name]} us CPU, budget ${budget} us`);
  }
  console.log(`CPU time for 36,000 calls (us): ${JSON.stringify(results)}`);
});

test("the trace operations scale about linearly: four times the calls takes at most ten times the CPU time", () => {
  const small = tune(9_000);
  const large = tune(36_000);
  for (const [name, fn] of [["irFingerprint", (ir) => irFingerprint(ir)], ["traceVoiceFacts", (ir) => traceVoiceFacts(ir)], ["techniquesFromIr", (ir) => techniquesFromIr(ir)], ["restrictIrToVoice", (ir) => restrictIrToVoice(ir, 1)]]) {
    const a = time(() => fn(small));
    const b = time(() => fn(large));
    assert.ok(b < Math.max(a, 15_000) * 10, `${name}: ${a} us for 9,000 calls, ${b} us for 36,000 (linear would be about 4x)`);
  }
});
