// The plain-language summary of `sidwave reconstruct` (review fixes of S5d part 3): a clear verdict, "K of M calls differ",
// start-up differences with the register named, a likely cause from the class of the first difference, and the turbo fallback.
import test from "#test/runner";
import assert from "#test/assert";
import { plainSummary, summaryLine } from "../src/cliReconstruct.ts";
import { withTurbo, TURBO_MESSAGE } from "../src/reconstruct/reconstruct.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { roundTrip } from "./helpers/reconstructRoundTrip.mjs";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";

const CLASSES = ["pitch", "gate", "waveform", "pulse", "adsr", "filter", "volume", "timing"];

function report(overrides = {}) {
  const classes = Object.fromEntries(CLASSES.map((c) => [c, { differingCalls: 0, matchShare: 1 }]));
  const fdiff = { alignment: { expectedCall: 1, observedCall: 1 }, standardAlignment: true, compileOk: true, equal: true, comparedCalls: 1000, expectedCalls: 1001, observedCalls: 1001, differingCalls: 0, callsWithDifference: 0, classes };
  return {
    horizon: { seconds: 20, cycles: 0, calls: 1001, clock: "PAL", song: 1 },
    callRate: { periodCycles: 19656, callsPerFrame: 1, callsPerFrameExact: 1, irregularShare: 0 },
    unsupported: [], fdiff, fdiffState: fdiff, strictExact: true, registerStateExact: true, languageExtensions: [],
    recovery: { noteCount: 10, instrumentCount: 2, patternCount: 3, languageVersion: "1.5" },
    compile: { ok: true },
    ...overrides,
  };
}

function different(first, extra = {}) {
  const base = report();
  const classes = { ...base.fdiff.classes, [first.class]: { differingCalls: 40, matchShare: 0.96 }, volume: { differingCalls: 40, matchShare: 0.96 } };
  const fdiff = { ...base.fdiff, equal: false, differingCalls: 80, callsWithDifference: 40, classes, first };
  return report({ strictExact: false, registerStateExact: false, fdiff, fdiffState: fdiff, ...extra });
}

test("a strict match says so in the first sentences", () => {
  const text = plainSummary(report());
  assert.match(text, /matches the original/i);
  assert.match(text, /a strict match/);
});

test("a difference is counted as K of M calls, once per call and not once per class", () => {
  const text = plainSummary(different({ class: "pitch", call: 5, timeSeconds: 0.1, voice: 2, register: 7, expected: 3, observed: 4 }));
  assert.match(text, /does not match the original/i);
  assert.match(text, /40 of 1000 player calls differ/);
  assert.ok(!/80 register differences/.test(text));
});

test("a difference at call 0 is a start-up difference and names the register", () => {
  const text = plainSummary(different({ class: "gate", call: 0, timeSeconds: 0, voice: 1, register: 4, expected: 8, observed: 0 }));
  assert.match(text, /start-up difference/i);
  assert.match(text, /voice 1 control register \(\$D404\)/);
  assert.match(text, /\$08/);
});

test("the likely cause follows from the class of the first difference", () => {
  const gate = plainSummary(different({ class: "gate", call: 9, timeSeconds: 0.2, voice: 1, register: 4, expected: 1, observed: 0 }));
  assert.match(gate, /Likely cause: .*(hard restart|gate)/);
  const pitch = plainSummary(different({ class: "pitch", call: 9, timeSeconds: 0.2, voice: 3, register: 14, expected: 224, observed: 22 }));
  assert.match(pitch, /Likely cause: .*(frequenc|pitch)/);
  assert.match(pitch, /voice 3 frequency low register \(\$D40E\)/);
});

test("the turbo fallback names itself, says the saved score includes cpu: turbo, and is not a match", () => {
  const text = plainSummary(different({ class: "pitch", call: 9, timeSeconds: 0.2, voice: 1, register: 0, expected: 1, observed: 2 }, {
    compile: { ok: true, cycleBudgetExceeded: "needs more", turboFallback: { scoreIncludesTurbo: true, message: TURBO_MESSAGE } },
  }));
  assert.ok(text.includes("does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers"));
  assert.match(text, /saved score includes `cpu: turbo`/);
});

test("the one-line summary uses K of M calls too", () => {
  const line = summaryLine(different({ class: "pitch", call: 9, timeSeconds: 0.2, voice: 1, register: 0, expected: 1, observed: 2 }));
  assert.match(line, /40 of 1000 calls differ/);
});

test("withTurbo appends a warning and cpu: turbo, and the result still parses", () => {
  const base = `sidwave: "1.4"\ntitle: T\ntempo: 120\nvoices:\n  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }\ninstruments:\n  lead: { waveform: pulse }\ntimeline:\n  - { section: Main, bars: 4, layers: { v1: a } }\n`;
  const text = withTurbo(base);
  assert.match(text, /# Warning: does not run at 1 MHz/);
  assert.equal(parseSidwave(text).cpu, "turbo");
});

test("a recovered score that exceeds the cycle budget is saved with cpu: turbo, reported, and never a strict pass", { timeout: 120_000 }, async () => {
  // The original needs about 2400 cycles per call at speed 6 and compiles at 1 MHz (2592 available). The recovered score
  // needs more and does not.
  const g = Array.from({ length: 32 }, (_, i) => ({ note: i % 2 ? "C5" : "A4", len: 0.125 }));
  const base = { waveform: "pulse", adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } };
  const score = {
    sidwave: "1.5", title: "six", tempo: 60 * 50.1245 / 16, mode: "PAL", speed: 6, player: { soft_start: false },
    instruments: { a: { ...base, pulsetable: { steps: [{ set: 1000 }, { add: 5, calls: 20 }], loop: 1 } }, b: base },
    voices: [1, 2, 3].map((id) => ({ id, instrument: id === 1 ? "a" : "b", patterns: { p: { length: 1 / 96, bars: 1, groove: g } } })),
    timeline: [{ section: "Main", bars: 1, layers: { v1: "p", v2: "p", v3: "p" } }],
  };
  const result = await roundTrip(score, 2);
  assert.ok(result.report.compile?.cycleBudgetExceeded, "the fallback must be reached");
  assert.equal(result.report.compile.ok, true, result.report.compile.error);
  assert.equal(result.report.strictExact, false);
  assert.equal(result.report.compile.turboFallback.scoreIncludesTurbo, true);
  assert.equal(parseSidwave(result.score).cpu, "turbo");
  compileSidwaveBytes(parseSidwave(result.score), { format: "sid", loop: true });
  assert.match(plainSummary(result.report), /does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers/);
});
