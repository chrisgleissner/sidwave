// The plain-language summary of `sidwave reconstruct` (review fixes of S5d part 3): a clear verdict, "K of M calls differ",
// start-up differences with the register named, a likely cause from the class of the first difference, and the turbo fallback.
import test from "#test/runner";
import assert from "#test/assert";
import { classifyError } from "../src/cliCore.ts";
import { EXIT_CODES } from "../src/cliCore.ts";
import { failOnInternalError, plainSummary, summaryLine } from "../src/cliReconstruct.ts";
import { assemblyToPrgDetailed } from "6502-toolkit/assembler";
import { reconstructSid, withTurbo, TURBO_MESSAGE } from "../src/reconstruct/reconstruct.ts";
import { writeSidFile } from "../src/sidFile.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
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
  // A hand-written player at eight calls per frame: a few hundred cycles per call. It starts a note on all three voices
  // every eighth call and moves the pulse width and, on the second call of a note, the pitch. The SIDWave player needs more
  // than the 1819 cycles of a call for the same notes, by the estimate and measured.
  const voice = (base) => `
        lda #$00
        sta $d4${base}5
        lda #$f0
        sta $d4${base}6
        lda $fb
        and #7
        cmp #6
        bcs off${base}
        asl
        asl
        asl
        sta $d4${base}2
        lda #$08
        sta $d4${base}3
        lda $fb
        and #15
        tay
        lda freq,y
        sta $d4${base}0
        lda #$10
        sta $d4${base}1
        lda #$41
        sta $d4${base}4
        jmp next${base}
off${base}:    lda #$40
        sta $d4${base}4
next${base}:
`;
  const asm = `
        .org $1000
init:   lda #<2457
        sta $dc04
        lda #>2457
        sta $dc05
        lda #0
        sta $fb
        lda #$0f
        sta $d418
        rts
play:   ${voice("0")}${voice("0")}
        inc $fb
        rts
freq:   .byte 16,48,16,16,16,16,16,16,80,120,80,80,80,80,80,80
`;
  const second = voice("0").replace(/\$d400/g, "$d407").replace(/\$d401/g, "$d408").replace(/\$d402/g, "$d409").replace(/\$d403/g, "$d40a").replace(/\$d404/g, "$d40b").replace(/\$d405/g, "$d40c").replace(/\$d406/g, "$d40d").replaceAll("off0", "off7").replaceAll("next0", "next7");
  const third = voice("0").replace(/\$d400/g, "$d40e").replace(/\$d401/g, "$d40f").replace(/\$d402/g, "$d410").replace(/\$d403/g, "$d411").replace(/\$d404/g, "$d412").replace(/\$d405/g, "$d413").replace(/\$d406/g, "$d414").replaceAll("off0", "off14").replaceAll("next0", "next14");
  const source = asm.replace(`${voice("0")}${voice("0")}`, `${voice("0")}${second}${third}`);
  const { prg, symbols } = assemblyToPrgDetailed(source, { loadAddress: 0x1000 });
  const sid = writeSidFile({ magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: symbols.get("play"), songs: 1, startSong: 1, speed: 1, name: "eight", author: "test", released: "test", clock: "PAL", payload: prg.subarray(2) });
  const result = await reconstructSid(new Uint8Array(sid), { engine: sharedEngine(), seconds: 2 });
  assert.ok(result.report.compile?.cycleBudgetExceeded, `the fallback must be reached: ${JSON.stringify(result.report.compile)}`);
  assert.equal(result.report.compile.ok, true, result.report.compile.error);
  assert.equal(result.report.strictExact, false);
  assert.equal(result.report.compile.turboFallback.scoreIncludesTurbo, true);
  assert.equal(parseSidwave(result.score).cpu, "turbo");
  compileSidwaveBytes(parseSidwave(result.score), { format: "sid", loop: true });
  assert.match(plainSummary(result.report), /does not run at 1 MHz; the saved file needs `cpu: turbo` and Ultimate Turbo Registers/);
});

test("an internal error of the recovery maps to the internal category (exit 70) with the field in the details", () => {
  const bad = report({ compile: { ok: false, error: "Invalid SIDWAVE at $.voices[2].patterns.P6.length: -1 is below the minimum" }, internalError: { field: "$.voices[2].patterns.P6.length", message: "-1 is below the minimum" } });
  assert.doesNotThrow(() => failOnInternalError(report(), "t.sid"));
  let caught;
  try { failOnInternalError(bad, "t.sid"); } catch (e) { caught = e; }
  const classified = classifyError(caught);
  assert.equal(classified.category, "internal");
  assert.equal(EXIT_CODES[classified.category], 70);
  assert.equal(classified.details.field, "$.voices[2].patterns.P6.length");
  assert.match(plainSummary(bad), /Internal error: .*\$\.voices\[2\]/);
});

test("a probe-only verification says that only the first seconds were compared", () => {
  const r = different({ class: "pitch", call: 5, timeSeconds: 0.1, voice: 2, register: 7, expected: 3, observed: 4 }, { verification: { mode: "probe", seconds: 10 }, horizon: { seconds: 90, cycles: 0, calls: 4500, clock: "PAL", song: 1 } });
  assert.match(plainSummary(r), /40 of 1000 player calls differ.*compared the first 10 s only, not the whole 90 s/);
  assert.match(summaryLine(r), /compared the first 10 s only/);
  const full = different({ class: "pitch", call: 5, timeSeconds: 0.1, voice: 2, register: 7, expected: 3, observed: 4 }, { verification: { mode: "full", seconds: 90 } });
  assert.ok(!/compared the first/.test(plainSummary(full)));
});
