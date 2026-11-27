// Seeded round trip: generate a score, compile it, trace it on SIDLite, reconstruct it, recompile and trace again.
// The strict F-diff of the two traces (register state, in-call control writes, call timing) must show no differing call. All eight fixed seeds run for every feature. A feature that does not round trip is a failing test marked `todo`, with the reason;
// it is never skipped silently, and the first difference is part of the test name's failure message.
import test from "#test/runner";
import assert from "#test/assert";
import { readdirSync, readFileSync } from "node:fs";
import { buildScore, roundTrip, shrink, stateDifferences, verdict } from "./helpers/reconstructRoundTrip.mjs";
import { fitVibrato, simulateVibrato } from "../src/reconstruct/recover.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
import { fdiff } from "../src/reconstruct/fdiff.ts";
import { bestFdiff, stateOnlyIr } from "../src/reconstruct/reconstruct.ts";
import { mantissaShift } from "../src/sidwaveCompiler.ts";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const EXACT = ["basic", "pulse", "arpeggio", "hard_restart", "vibrato", "filter"];

for (const feature of EXACT) {
  test(`round trip of ${feature} scores is exact for seeds ${SEEDS.join(", ")}`, { timeout: 180_000 }, async () => {
    for (const seed of SEEDS) {
      const r = await roundTrip(buildScore(feature, seed));
      assert.equal(verdict(r.report), "exact", `${feature} seed ${seed}: ${JSON.stringify(r.report.fdiff.first)}`);
      assert.equal(r.report.strictExact, true);
      // Instruments are not fragmented by note duration: each voice of the source score has one instrument.
      assert.equal(r.report.recovery.instrumentCount, 3, `${feature} seed ${seed}`);
      assert.equal(r.report.fdiff.standardAlignment, true);
    }
  });
}

test("strict round trip of multispeed scores", {
  timeout: 180_000,
  todo: "failing for seeds 1, 2, 4, 6, 7 and 8 (only seeds 3 and 5 are exact): the register state matches but a few calls start tens of cycles apart, because the recompiled score specialises the player code differently from the original",
}, async () => {
  for (const seed of SEEDS) {
    const r = await roundTrip(buildScore("multispeed", seed));
    assert.equal(verdict(r.report), "exact", `seed ${seed}: ${JSON.stringify(r.report.fdiff.first)}`);
  }
});

// Relaxed: this test is NOT a strict pass. It only requires registerStateExact, which ignores call timing.
test("relaxed round trip of multispeed scores: register state only, call timing ignored", { timeout: 180_000 }, async () => {
  for (const seed of SEEDS) {
    const r = await roundTrip(buildScore("multispeed", seed));
    assert.equal(r.report.registerStateExact, true, `seed ${seed}: ${JSON.stringify(r.report.fdiffState.first)}`);
  }
});

test("round trip of combined features (pulse, arpeggio, hard restart, vibrato and filter tables in different voices) at speed 1", { timeout: 180_000 }, async () => {
  for (const seed of [1, 3, 5]) {
    const r = await roundTrip(buildScore("combined", seed));
    assert.equal(verdict(r.report), "exact", `combined seed ${seed}: ${JSON.stringify(r.report.fdiff.first)}`);
  }
});

test("round trip of combined features, all 8 seeds", {
  timeout: 180_000,
  todo: "measured verdicts for seeds 1 to 8: exact, different, exact, state_exact, exact, state_exact, state_exact, call_count. Seed 2 differs in register state (the shrunk fixture combined-seed2.yaml isolates a failed vibrato fit on a note of an instrument with vibrato delay 4, a pulse table and a test-bit hard restart); seeds 4, 6 and 7 differ only in the control-write order or call timing; seed 8 has a call count mismatch",
}, async () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = await roundTrip(buildScore("combined", seed));
    assert.equal(verdict(r.report), "exact", `combined seed ${seed}: ${JSON.stringify(r.report.fdiffState.first)}`);
  }
});

test("round trip of generator tunes (SIDWave 1.1 library instruments), strict, all 8 seeds", {
  timeout: 180_000,
  todo: "failing for all 8 seeds: legato notes with portamento (pitch), the soft-start volume ramp of the 1.4 player (volume), and hz cutoffs of library filter tables are not recovered",
}, async () => {
  for (const seed of SEEDS) {
    const r = await roundTrip(buildScore("generator", seed));
    assert.equal(verdict(r.report), "exact", `generator seed ${seed}: ${JSON.stringify(r.report.fdiff.first)}`);
  }
});

// Relaxed, not a strict pass: only the register-state classes (timing excluded) are required to match.
test("relaxed round trip of generator tunes: register state only", {
  timeout: 180_000,
  todo: "failing: same causes as the strict generator test",
}, async () => {
  for (const seed of SEEDS) {
    const r = await roundTrip(buildScore("generator", seed));
    assert.equal(stateDifferences(r.report), 0, `generator seed ${seed}: ${JSON.stringify(r.report.fdiffState.first)}`);
  }
});

// Shrunk regression fixtures of failing round trips are kept in test/fixtures/reconstruct-regressions. Each one is a
// score that did not reconstruct exactly when it was added; the test is `todo` until the cause is fixed.
const REGRESSIONS = new URL("./fixtures/reconstruct-regressions/", import.meta.url);
for (const file of readdirSync(REGRESSIONS).filter((name) => name.endsWith(".yaml")).sort()) {
  test(`regression fixture ${file} round trips exactly`, { timeout: 120_000, ...(file === "combined-seed2.yaml" ? {} : { todo: `known failure: see the header comment of ${file}` }) }, async () => {
    const r = await roundTrip(readFileSync(new URL(file, REGRESSIONS), "utf8"));
    assert.equal(stateDifferences(r.report), 0, JSON.stringify(r.report.fdiffState.first));
  });
}

test("simulateVibrato follows the player arithmetic: triangle phase, rounded amplitudes, delay", () => {
  const up = mantissaShift((128 / 126) * (2 ** (0.4 / 12) - 1));
  const down = mantissaShift((128 / 126) * (1 - 2 ** (-0.4 / 12)));
  // Registers observed from the compiled player for E5 (0x2bda) with depth 0.4, rate 4.5 (phase step 23), no delay.
  const expected = [0x2bda, 0x2c3a, 0x2c9a, 0x2ccc, 0x2c6c, 0x2c0c, 0x2bb1, 0x2b54, 0x2af6, 0x2b17];
  assert.deepEqual(simulateVibrato(0x2bda, up, down, 23, 0, 10), expected);
  // A delay of 3 calls holds the note pitch for 3 calls and then continues from phase 0.
  assert.deepEqual(simulateVibrato(0x2bda, up, down, 23, 3, 6), [0x2bda, 0x2bda, 0x2bda, 0x2bda, 0x2c3a, 0x2c9a]);
});

test("fitVibrato finds depth, rate and delay that reproduce the registers of two notes of different pitch", () => {
  const up = mantissaShift((128 / 126) * (2 ** (0.25 / 12) - 1));
  const down = mantissaShift((128 / 126) * (1 - 2 ** (-0.25 / 12)));
  const clock = 985_248;
  const reg = (midi) => Math.round((440 * 2 ** ((midi - 69) / 12) * 16_777_216) / clock);
  const members = [64, 52].map((midi) => ({ midi, freqs: simulateVibrato(reg(midi), up, down, 30, 4, 40) }));
  const fit = fitVibrato(members, 0, clock, 1, 50.1245);
  assert.ok(fit);
  assert.equal(fit.delayCalls, 4);
  assert.equal(Math.round((fit.rate * 256) / 50.1245), 30);
  // The fit reproduces both notes exactly.
  for (const m of members) {
    const f = mantissaShift((128 / 126) * (2 ** (fit.depth / 12) - 1));
    const d = mantissaShift((128 / 126) * (1 - 2 ** (-fit.depth / 12)));
    assert.deepEqual(simulateVibrato(reg(m.midi), f, d, 30, 4, 40), m.freqs);
  }
});

test("fitVibrato refuses frequencies that are no vibrato (a stepped arpeggio)", () => {
  const members = [{ midi: 60, freqs: [0x1167, 0x1167, 0x15e8, 0x15e8, 0x1a9c, 0x1a9c] }];
  assert.equal(fitVibrato(members, 0, 985_248, 1, 50.1245), undefined);
});

test("the test-bit pulse counterexample: strict F-diff fails, register-state F-diff passes", () => {
  // Original: control written $09 (test + gate) then $41 in one call. Recompiled: $41 alone. The register state after
  // the call is identical; the sound is not, because the test bit resets the oscillator.
  const pack = (writes) => new Float64Array(writes.flat());
  const frame = 19_656;
  const original = buildIr(pack([[0, 4, 0x41, 1000], [0, 4, 0x09, 1000 + frame], [0, 4, 0x41, 1010 + frame]]), { clock: "PAL" });
  const recompiled = buildIr(pack([[0, 4, 0x41, 1000], [0, 4, 0x41, 1000 + frame]]), { clock: "PAL" });
  assert.equal(fdiff(original, recompiled).equal, false);
  assert.equal(fdiff(stateOnlyIr(original), stateOnlyIr(recompiled)).equal, true);
  const strict = bestFdiff(original, recompiled);
  assert.equal(strict.equal, false);
  assert.ok(strict.classes.gate.differingCalls > 0);
  assert.equal(bestFdiff(stateOnlyIr(original), stateOnlyIr(recompiled)).equal, true);
});

test("a score that does not compile is never equal-looking: every class counts all compared calls", async () => {
  const { reconstructSid } = await import("../src/reconstruct/reconstruct.ts");
  const { buildFixture } = await import("./helpers/reconstructFixtures.mjs");
  const { sharedEngine } = await import("./helpers/reconstructRoundTrip.mjs");
  const { report } = await reconstructSid(new Uint8Array(buildFixture("multispeed9").sid), { engine: sharedEngine(), seconds: 3 });
  assert.equal(report.compile.ok, false);
  assert.equal(report.fdiff.compileOk, false);
  assert.equal(report.fdiff.equal, false);
  assert.equal(report.strictExact, false);
  assert.equal(report.registerStateExact, false);
  for (const c of Object.values(report.fdiff.classes)) assert.equal(c.matchShare, 0);
});

test("shrink deletes parts of a failing score while the failure persists (synthetic predicate)", async () => {
  const score = buildScore("pulse", 1);
  // The synthetic failure: some voice still has a pulsetable instrument and a first pattern entry exists.
  const fails = async (candidate) => Object.values(candidate.instruments ?? {}).some((i) => i.pulsetable) && candidate.voices?.length > 0;
  const small = await shrink(score, fails, 200);
  assert.equal(await fails(small), true);
  assert.ok(JSON.stringify(small).length < JSON.stringify(score).length / 2, "the score became much smaller");
  assert.equal(small.voices.length, 1, "unneeded voices were removed");
  // A predicate that never fails leaves the score unchanged.
  assert.deepEqual(await shrink(score, async () => false, 5), score);
});

test("a tune without any gated note recovers to a compilable score with one resting voice", async () => {
  const { recoverScore } = await import("../src/reconstruct/recover.ts");
  const { parseSidwave } = await import("../src/sidwave.ts");
  const frame = 19_656;
  const ir = buildIr(new Float64Array([0, 0, 1, 1000, 0, 0, 2, 1000 + frame, 0, 0, 3, 1000 + 2 * frame]), { clock: "PAL" });
  const recovered = recoverScore(ir);
  assert.equal(recovered.noteCount, 0);
  parseSidwave(recovered.text);
});
