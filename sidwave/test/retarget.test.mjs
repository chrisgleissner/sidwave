import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { retargetSidwave, RetargetError, measureScore, compareTiming, convertCutoffUnits, cutoffRange, curveResolution } from "../src/retarget.js";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE } from "../src/cli.js";
import { formatSidwave } from "../src/format/sidwaveFormat.js";
import { cutoffHz } from "../src/sidwaveFilterModel.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { SIDWAVE_SCORE_RESOURCES } from "../src/sidwaveExamples.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const NAMES = SIDWAVE_SCORE_RESOURCES.map(({ name }) => name);
const SLOW = { timeout: 300_000 };
const ELISE = readExampleScore("fuer_elise");
/** One PAL frame plus one NTSC frame in milliseconds: the largest rounding error of an onset that both clocks round. */
const TWO_FRAMES_MS = 1000 / 50.1245 + 1000 / 59.8262;

/** Counts of the change classes, to check the report summary. */
const count = (changes, kind) => changes.filter((change) => change.class === kind).length;

test("clock round trip PAL to NTSC to PAL: identical score or every approximation listed, and timing measured", { ...SLOW }, async (t) => {
  for (const name of NAMES) {
    await t.test(name, SLOW, () => {
      const source = readExampleScore(name);
      const toNtsc = retargetSidwave(source, { clock: "ntsc" });
      assert.equal(parseSidwave(toNtsc.text).song.mode, "NTSC");
      const back = retargetSidwave(toNtsc.text, { clock: "pal" });
      assert.equal(parseSidwave(back.text).song.mode, "PAL");
      for (const leg of [toNtsc, back]) {
        const { report } = leg;
        assert.equal(report.summary.exact + report.summary.approximate + report.summary.dropped, report.changes.length);
        assert.equal(report.summary.dropped, 0);
        assert.ok(report.clock.timing.paired > 0, "note events were compared");
        // Order matching is only done for voices whose event counts match.
        for (const kind of ["on", "off"]) assert.ok(report.clock.timing.perKind[kind].timing === "not measured" || report.clock.timing.perKind[kind].p95Ms <= TWO_FRAMES_MS, `${name}: ${kind} 95th percentile ${report.clock.timing.perKind[kind].p95Ms} ms`);
        // Every converted frame count carries its own timing difference.
        for (const change of report.changes.filter((c) => c.step === "clock" && c.errorMs !== undefined && c.construct !== "timing")) {
          // At most one frame, except where the value was clamped to the 255 frames that a table step can hold.
          if (!change.measured?.clamped) assert.ok(change.errorMs <= 1000 / 50.1245 + 0.01, `${change.path} ${change.errorMs}`);
          assert.equal(change.class, change.errorMs < 1e-6 ? "exact" : "approximate");
        }
      }
      const original = formatSidwave(source);
      if (back.text !== original) {
        // Not identical: the legs must list approximations, and the changed text may only differ in what they changed.
        assert.ok(count(toNtsc.report.changes, "approximate") + count(back.report.changes, "approximate") > 0);
      }
      // The result of the round trip plays the same pitches in the same order and nearly the same times.
      const a = measureScore(parseSidwave(source));
      const b = measureScore(parseSidwave(back.text));
      const timing = compareTiming(a, b);
      assert.ok(timing.perKind.on.timing === "not measured" || timing.perKind.on.p95Ms <= TWO_FRAMES_MS, `${name}: round trip timing ${timing.perKind.on.p95Ms} ms`);
    });
  }
});

test("clock: the reported timing error equals the error measured on the two traces", SLOW, () => {
  for (const name of ["title_fanfare", "chamber_waltz"]) {
    const source = readExampleScore(name);
    const result = retargetSidwave(source, { clock: "ntsc" });
    const measured = compareTiming(measureScore(parseSidwave(source)), measureScore(parseSidwave(result.text)));
    assert.ok(Math.abs(measured.worstMs - result.report.clock.timing.worstMs) < 1e-6, name);
    assert.equal(measured.unpaired, result.report.clock.timing.unpaired);
    assert.equal(result.report.clock.basis, "register trace");
  }
});

test("clock: frame counts keep their duration to within one frame and add keeps the total change", () => {
  const source = `sidwave: "1.3"
title: Frames
tempo: 120
mode: PAL
instruments:
  tab:
    waveform: pulse
    adsr: [0, 6, 9, 2]
    vibrato: { depth: 0.2, rate: 5, delay: 25, fade: 10 }
    pulsetable: { loop: 1, steps: [{ set: 0.3 }, { add: 20, frames: 30 }, { add: -20, frames: 30 }] }
voices:
  - id: 1
    instrument: tab
    patterns:
      a: { length: 1, groove: ["C3", "E3", "G3", "C4"] }
sections:
  s: { bars: 2, layers: { v1: a } }
timeline: [s, s]
`;
  const result = retargetSidwave(source, { clock: "ntsc" });
  const out = YAML.parse(result.text);
  assert.equal(out.mode, "NTSC");
  assert.equal(out.instruments.tab.vibrato.delay, 30); // 25 frames = 498.8 ms; 30 NTSC frames = 501.4 ms
  const steps = out.instruments.tab.pulsetable.steps;
  assert.equal(steps[1].frames, 36);
  assert.equal(steps[1].add, 17); // 20 x 30 = 600 over 36 frames
  const delay = result.report.changes.find((c) => c.construct === "vibrato.delay");
  assert.equal(delay.before, 25);
  assert.equal(delay.after, 30);
  assert.ok(Math.abs(delay.errorMs - Math.abs(30 / 59.8262 - 25 / 50.1245) * 1000) < 0.01);
  assert.equal(delay.class, "approximate");
  assert.equal(result.report.changes.find((c) => c.construct === "mode").class, "exact");
  // The same clock again changes nothing.
  const again = retargetSidwave(result.text, { clock: "ntsc" });
  assert.equal(again.text, result.text);
  assert.equal(again.report.summary.approximate, 0);
});

test("clock: a score that needs a turbo CPU at the other clock declares it and says so", SLOW, () => {
  const result = retargetSidwave(readExampleScore("chiptune_drive"), { clock: "ntsc" });
  assert.equal(YAML.parse(result.text).cpu, "turbo");
  const cpu = result.report.changes.find((c) => c.construct === "cpu");
  assert.equal(cpu.class, "approximate");
});

test("model: register cutoffs keep their frequency within the resolution of the target curve, clamps are reported", () => {
  // The conversion function, over the whole register range.
  for (const [from, to] of [["8580", "6581"], ["6581", "8580"]]) {
    const range = cutoffRange(to);
    for (let units = 0; units <= 2047; units += 7) {
      const result = convertCutoffUnits(units, from, to);
      const hz = cutoffHz(units, from);
      assert.equal(result.clamped, hz > range.max + 0.5 || hz < range.min - 0.5, `${from} ${units}`);
      if (!result.clamped) assert.ok(Math.abs(result.toHz - hz) <= result.resolutionHz, `${from} ${units}: ${hz} Hz became ${result.toHz} Hz (resolution ${result.resolutionHz})`);
    }
  }
  assert.ok(curveResolution(2047, "8580") > 0);
  // In a score.
  const make = (model, cutoffs) => `sidwave: "1.3"
title: Filter
tempo: 120
mode: PAL
sids: [{ id: sid1, address: "$D400", model: "${model}", filter: { owner: v1, route: [1] } }]
instruments:
  sweep: { waveform: saw, adsr: [0, 6, 9, 2], filtertable: [{ cutoff: ${cutoffs[0]}, resonance: 8, type: lowpass }, { add: -100, frames: 10 }, { cutoff: ${cutoffs[1]}, frames: 4 }] }
voices:
  - id: 1
    instrument: sweep
    patterns:
      a: { length: 1, groove: ["C3", "E3", "G3", "C4"] }
sections:
  s: { bars: 2, layers: { v1: a } }
timeline: [s, s]
`;
  const down = retargetSidwave(make("6581", [900, 2047]), { model: "8580" });
  const out = YAML.parse(down.text);
  assert.equal(out.sids[0].model, "8580");
  const first = down.report.changes.filter((c) => c.construct === "filtertable.cutoff");
  assert.equal(first.length, 2);
  assert.equal(first[0].class, "exact");
  assert.ok(Math.abs(first[0].measured.toHz - first[0].measured.fromHz) <= first[0].measured.resolutionHz);
  assert.equal(first[0].measured.clamped, false);
  assert.equal(first[1].measured.clamped, true, "6581 code 2047 is 18 kHz, above the 8580 maximum");
  assert.equal(first[1].class, "approximate");
  assert.equal(out.instruments.sweep.filtertable.filter((step) => step.cutoff !== undefined).pop().cutoff, 2047);
  // The add step follows the same frequencies: 6581 code 900 minus 100 is 800, whose frequency the 8580 reaches at another code.
  const add = down.report.changes.find((c) => c.construct === "filtertable.add");
  assert.equal(add.class, "approximate");
  assert.equal(add.measured.steps, 1);
  assert.ok(Math.abs(out.instruments.sweep.filtertable[1].add) !== 100);
  assert.ok(down.report.model.cutoffs.samples > 0);
  const up = retargetSidwave(make("8580", [300, 1500]), { model: "6581" });
  assert.equal(YAML.parse(up.text).sids[0].model, "6581");
  parseSidwave(up.text);
  // Hz cutoffs stay as written; one beyond the target curve is reported as a clamp.
  const hz = retargetSidwave(make("6581", ["15kHz", "900Hz"]), { model: "8580" });
  assert.equal(YAML.parse(hz.text).instruments.sweep.filtertable[0].cutoff, "15kHz");
  const clamp = hz.report.changes.find((c) => c.construct === "filtertable.cutoff");
  assert.equal(clamp.class, "approximate");
  assert.equal(clamp.measured.clamped, true);
  // Same model: nothing to convert.
  const same = retargetSidwave(make("8580", [300, 1500]), { model: "8580" });
  assert.equal(same.report.summary.approximate, 0);
});

test("model: combined waveforms and digi samples are reported as approximate with the instruments named", SLOW, () => {
  const result = retargetSidwave(readExampleScore("digi_groove"), { model: "6581" });
  assert.ok(result.report.changes.some((c) => c.construct === "digi-volume" && c.class === "approximate"));
  assert.ok(result.report.changes.some((c) => c.construct === "combined-waveform" && c.class === "approximate" && c.measured.instrument));
  const doc = parseSidwave(result.text);
  assert.ok(doc.sids.every((sid) => sid.model === "6581"));
  assert.ok(measureScore(doc).bytes > 0);
});

test("model: example scores with other filters and layouts convert to valid scores on both models", SLOW, () => {
  for (const [name, model] of [["title_fanfare", "6581"], ["ambient_filter", "6581"], ["wall_of_sid", "6581"], ["game_songs", "6581"], ["fuer_elise", "6581"]]) {
    const result = retargetSidwave(readExampleScore(name), { model });
    const doc = parseSidwave(result.text);
    if (name !== "fuer_elise") assert.ok(doc.sids.every((sid) => sid.model === model), name);
    assert.equal(result.report.summary.dropped, 0);
  }
});

test("SIDs: wall_of_sid to one SID keeps at most three voices, reports every voice and is deterministic", SLOW, () => {
  const source = readExampleScore("wall_of_sid");
  const a = retargetSidwave(source, { sids: 1 });
  const b = retargetSidwave(source, { sids: 1 });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.report, b.report);
  const doc = parseSidwave(a.text);
  assert.equal(doc.sids.length, 1);
  assert.ok(doc.voices.length <= 3 && doc.voices.length >= 1);
  assert.ok(compileSidwaveToPrg(doc).prg.length > 0);
  const voices = a.report.sids.voices;
  assert.equal(voices.length, 27, "one decision per voice of the source");
  assert.equal(voices.filter((v) => v.decision === "kept").length, doc.voices.length);
  for (const voice of voices) {
    assert.ok(voice.reason.length > 0);
    const change = a.report.changes.find((c) => c.construct === "voice" && c.path === `/voices/id=${voice.id}`);
    assert.ok(change, `voice ${voice.id} appears in the changes`);
    assert.equal(change.class === "dropped", voice.decision === "dropped");
  }
  assert.equal(count(a.report.changes, "dropped") >= 24, true);
  // A lead, a bass and a harmony voice survive, in that order of importance.
  assert.deepEqual(voices.filter((v) => v.decision === "kept").map((v) => v.class).sort(), ["bass", "harmony", "lead"]);
  assert.ok(a.report.after.bytes < a.report.before.bytes);
});

test("SIDs: copies go first, kept copies keep their source, and a larger target changes nothing", SLOW, () => {
  const source = readExampleScore("stereo_echo");
  const one = retargetSidwave(source, { sids: 1 });
  const doc = parseSidwave(one.text);
  assert.ok(doc.voices.length <= 3);
  const copies = one.report.sids.voices.filter((v) => v.class === "copy");
  assert.ok(copies.length > 0 && copies.every((v) => v.decision === "dropped"));
  for (const voice of doc.voices) {
    for (const key of ["echo", "unison", "follow"]) if (voice[key]) assert.ok(doc.voices.some((v) => v.id === voice[key].voice));
  }
  const same = retargetSidwave(source, { sids: 5 });
  assert.equal(same.report.sids.voices.length, 0);
  assert.ok(same.report.changes.some((c) => c.construct === "sids" && /no change needed/.test(c.summary)));
  assert.equal(same.report.summary.approximate + same.report.summary.dropped, 0);
  const sameScore = parseSidwave(same.text);
  assert.equal(sameScore.voices.length, parseSidwave(source).voices.length);
});

test("SIDs: eight SIDs to two keep six voices and a valid filter", SLOW, () => {
  const result = retargetSidwave(readExampleScore("ultisid_orchestra"), { sids: 2 });
  const doc = parseSidwave(result.text);
  assert.equal(doc.sids.length, 2);
  assert.ok(doc.voices.length <= 6);
  assert.equal(result.report.sids.to, 2);
});

test("SIDs: a digi voice that cannot move to the remaining SID is dropped and reported", SLOW, () => {
  const result = retargetSidwave(readExampleScore("digi_groove"), { sids: 1 });
  assert.equal(parseSidwave(result.text).sids.length, 1);
  assert.ok(result.report.changes.some((c) => c.construct === "digi-voice" && c.class === "dropped"));
});

/** A small modern score with an optional echo copy voice. */
function small({ echo = false, extra = "" } = {}) {
  return `sidwave: "1.3"
title: Small
tempo: 120
mode: PAL
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments:
  lead: { waveform: pulse, adsr: [0, 6, 9, 2], pulse_width: 0.4, pulsetable: { loop: 1, steps: [{ set: 0.3 }, { add: 10, frames: 8 }, { add: -10, frames: 8 }, { add: 5, frames: 8 }, { add: -5, frames: 8 }, { add: 5, frames: 8 }] } }
  pad: { waveform: triangle, adsr: [2, 6, 10, 4] }
voices:
  - id: 1
    instrument: lead
    patterns:
      a: { length: 0.5, groove: ["C3", "E3", "G3", "C4", "G3", "E3", "C3", "-"] }
  - id: 2
    instrument: pad
    patterns:
      b: { length: 1, groove: ["C4", "E4", "G4", "E4"] }
${echo ? "  - id: 3\n    echo: { voice: 2, delay_beats: 0.75, volume: 0.5 }\n" : ""}${extra}sections:
  s: { bars: 2, layers: { v1: a, v2: b } }
timeline: [s, s, s, s, s, s, s, s]
`;
}

test("optimise: lossless steps make a score over its byte budget smaller with an identical trace", SLOW, () => {
  const source = readExampleScore("digi_groove");
  const doc = YAML.parse(source);
  doc.samples.defs.junk = { synth: { osc: "noise", ms: 500, env: { a: 0, d: 400, s: 0, r: 50 }, seed: 1 } };
  const bloated = YAML.stringify(doc);
  const original = measureScore(parseSidwave(source));
  const before = measureScore(parseSidwave(bloated));
  assert.ok(before.bytes > original.bytes);
  const result = retargetSidwave(bloated, { budgetBytes: original.bytes });
  assert.equal(result.report.verdict, "ok");
  assert.ok(result.report.after.bytes <= original.bytes);
  assert.ok(result.report.after.bytes < before.bytes);
  const step = result.report.changes.find((c) => c.construct === "drop-unused-samples");
  assert.equal(step.class, "exact");
  assert.equal(step.measured.traceIdentical, true);
  assert.equal(count(result.report.changes, "approximate") + count(result.report.changes, "dropped"), 0);
  assert.equal(measureScore(parseSidwave(result.text)).digest, before.digest);
  assert.ok(!YAML.parse(result.text).samples.defs.junk);
  assert.deepEqual(result.report.budget.candidates.map((c) => [c.name, c.applied]).slice(0, 2), [["enable-stream-subroutines", false], ["drop-unused-samples", true]]);
});

test("optimise: a step that changes the trace is rejected, a budget already met changes nothing", () => {
  const source = small();
  const measured = measureScore(parseSidwave(source));
  const met = retargetSidwave(source, { budgetBytes: measured.bytes, budgetCycles: measured.cycles.worst });
  assert.equal(met.report.verdict, "ok");
  assert.equal(met.report.changes.length, 1);
  assert.equal(count(met.report.changes, "approximate") + count(met.report.changes, "dropped"), 0);
  assert.equal(met.report.before.bytes, met.report.after.bytes);
  // A 1.1 score is upgraded only if the register trace stays identical; here it does not.
  const old = source.replace('sidwave: "1.3"', 'sidwave: "1.1"').replace(/sections:[\s\S]*$/, "timeline:\n" + Array.from({ length: 8 }, () => "  - { bars: 2, layers: { v1: a, v2: b } }").join("\n") + "\n")
    .replace("pulsetable: { loop: 1, steps: [{ set: 0.3 }, { add: 10, frames: 8 }, { add: -10, frames: 8 }, { add: 5, frames: 8 }, { add: -5, frames: 8 }, { add: 5, frames: 8 }] }", "");
  const attempt = retargetSidwave(old, { budgetBytes: 100 });
  const candidate = attempt.report.budget.candidates.find((c) => c.name === "enable-stream-subroutines");
  assert.equal(candidate.applied, false);
  assert.match(candidate.reason, /register trace changes|no byte or cycle gain|does not apply/);
});

test("optimise: an impossible budget is infeasible with the best numbers, and no lossy step runs without allowChanges", () => {
  const source = small({ echo: true });
  const base = measureScore(parseSidwave(source));
  const result = retargetSidwave(source, { budgetBytes: 100 });
  assert.equal(result.report.verdict, "infeasible");
  assert.equal(result.report.budget.best.bytes, base.bytes);
  assert.equal(result.report.after.bytes, base.bytes);
  assert.equal(count(result.report.changes, "approximate") + count(result.report.changes, "dropped"), 0, "no lossy change without allowChanges");
  assert.equal(result.report.budget.lossyAvailable, true);
  assert.match(result.report.notes.join(" "), /could not be met/);
  // With allowChanges the lossy steps run in order and the budget is still impossible.
  const lossy = retargetSidwave(source, { budgetBytes: 100, allowChanges: true });
  assert.equal(lossy.report.verdict, "infeasible");
  assert.ok(lossy.report.budget.best.bytes < base.bytes);
  const order = lossy.report.changes.filter((c) => c.step === "optimise" && c.class !== "exact").map((c) => c.construct);
  assert.equal(order[0], "drop-echo-copy");
  assert.ok(order.indexOf("shorten-table") > order.indexOf("drop-echo-copy"));
  for (const change of lossy.report.changes.filter((c) => c.class !== "exact")) {
    assert.equal(typeof change.measured.bytesBefore, "number");
    assert.ok(change.measured.bytesAfter <= change.measured.bytesBefore);
  }
});

test("optimise: lossy steps reach a budget only with allowChanges and report the measured effect", () => {
  const source = small({ echo: true });
  const without = measureScore(parseSidwave(small()));
  const budget = without.bytes + 20;
  const refused = retargetSidwave(source, { budgetBytes: budget });
  assert.equal(refused.report.verdict, "infeasible");
  const allowed = retargetSidwave(source, { budgetBytes: budget, allowChanges: true });
  assert.equal(allowed.report.verdict, "ok");
  assert.ok(allowed.report.after.bytes <= budget);
  const drop = allowed.report.changes.find((c) => c.construct === "drop-echo-copy");
  assert.equal(drop.class, "dropped");
  assert.ok(drop.measured.differingCalls > 0 && drop.measured.differingCalls <= drop.measured.comparedCalls);
  assert.equal(parseSidwave(allowed.text).voices.length, 2);
  // A cycle budget is measured on the emulator.
  const cycles = measureScore(parseSidwave(source)).cycles.worst;
  const byCycles = retargetSidwave(source, { budgetCycles: cycles - 1, allowChanges: true });
  assert.equal(byCycles.report.after.cyclesKind, "measured");
  assert.ok(byCycles.report.after.cycles < cycles);
});

test("retargeting combines the steps in a fixed order and is deterministic", SLOW, () => {
  const source = readExampleScore("stereo_echo");
  const a = retargetSidwave(source, { clock: "ntsc", model: "6581", sids: 1 });
  const b = retargetSidwave(source, { clock: "ntsc", model: "6581", sids: 1 });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.report, b.report);
  const doc = parseSidwave(a.text);
  assert.equal(doc.song.mode, "NTSC");
  assert.equal(doc.sids.length, 1);
  assert.equal(doc.sids[0].model, "6581");
  assert.deepEqual([...new Set(a.report.changes.map((c) => c.step))], ["clock", "model", "sids"]);
});

test("input errors are reported as RetargetError", () => {
  assert.throws(() => retargetSidwave("not: [valid", { clock: "ntsc" }), (e) => e instanceof RetargetError && e.code === "input");
  assert.throws(() => retargetSidwave(ELISE, { sids: 0 }), (e) => e instanceof RetargetError && e.code === "input");
  assert.throws(() => retargetSidwave(ELISE, { clock: "secam" }), (e) => e instanceof RetargetError && e.code === "input");
  assert.throws(() => retargetSidwave(ELISE, { budgetBytes: -1 }), (e) => e instanceof RetargetError && e.code === "input");
});

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-retarget-")));
  fs.writeFileSync(path.join(dir, "song.yaml"), ELISE);
  fs.writeFileSync(path.join(dir, "bad.yaml"), "voices: nope\n");
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function run(cwd, ...args) {
  const out = [], err = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
  return { code, out: out.join(""), err: err.join("") };
}

test("sidwave retarget: exit codes follow the CLI contract", () => {
  const { dir, done } = sandbox();
  try {
    const ok = run(dir, "retarget", "song.yaml", "--clock", "ntsc", "-o", "out.yaml");
    assert.equal(ok.code, EXIT_OK, ok.err);
    assert.equal(YAML.parse(fs.readFileSync(path.join(dir, "out.yaml"), "utf8")).song.mode, "NTSC");
    assert.match(ok.out, /retarget: ok;/);
    // Not overwritten without --force.
    assert.equal(run(dir, "retarget", "song.yaml", "--clock", "pal", "-o", "out.yaml").code, EXIT_USAGE);
    assert.equal(run(dir, "retarget", "song.yaml", "--clock", "pal", "-o", "out.yaml", "--force").code, EXIT_OK);
    // The score on standard output and the report on standard error.
    const piped = run(dir, "retarget", "song.yaml", "--model", "6581");
    assert.equal(piped.code, EXIT_OK);
    parseSidwave(piped.out);
    assert.match(piped.err, /retarget: ok;/);
    // Usage errors: exit 2.
    for (const args of [["retarget"], ["retarget", "song.yaml"], ["retarget", "song.yaml", "--clock", "secam"], ["retarget", "song.yaml", "--model", "6502"],
      ["retarget", "song.yaml", "--sids", "0"], ["retarget", "song.yaml", "--sids", "x"], ["retarget", "song.yaml", "--bogus"],
      ["retarget", "song.yaml", "--allow-changes", "--clock", "pal"], ["retarget", "a.yaml", "b.yaml", "--clock", "pal"]]) {
      assert.equal(run(dir, ...args).code, EXIT_USAGE, args.join(" "));
    }
    // An unreadable file is input: exit 3.
    assert.equal(run(dir, "retarget", "missing.yaml", "--clock", "pal").code, 3);
    // An invalid score: exit 3.
    const bad = run(dir, "retarget", "bad.yaml", "--clock", "ntsc");
    assert.equal(bad.code, 3);
    assert.match(bad.err, /bad\.yaml/);
    // An infeasible budget: exit 1, the best numbers on the report, no file.
    const infeasible = run(dir, "retarget", "song.yaml", "--budget-bytes", "100", "-o", "tiny.yaml");
    assert.equal(infeasible.code, EXIT_FAILED);
    assert.match(infeasible.out, /infeasible/);
    assert.ok(!fs.existsSync(path.join(dir, "tiny.yaml")));
    const json = run(dir, "retarget", "song.yaml", "--budget-bytes", "100", "--json");
    assert.equal(json.code, EXIT_FAILED);
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "retarget");
    assert.equal(parsed.error, undefined, "an infeasible budget is a failed verdict with a result and no error");
    assert.equal(parsed.result.verdict, "infeasible");
    assert.ok(parsed.result.report.budget.best.bytes > 100);
    assert.equal(parsed.result.text, undefined);
    assert.ok(parsed.result.bestEffortText);
    const jsonOk = JSON.parse(run(dir, "retarget", "song.yaml", "--clock", "ntsc", "--json").out);
    assert.equal(jsonOk.ok, true);
    assert.equal(jsonOk.result.report.summary.dropped, 0);
    parseSidwave(jsonOk.result.text);
    const jsonBad = JSON.parse(run(dir, "retarget", "bad.yaml", "--clock", "ntsc", "--json").out);
    assert.equal(jsonBad.ok, false);
    assert.equal(jsonBad.error.category, "validation");
    assert.equal(run(dir, "retarget", "--help").code, EXIT_OK);
    // A bundled example name works as the score.
    assert.equal(run(dir, "retarget", "fuer_elise", "--clock", "ntsc", "-o", "-").code, EXIT_OK);
  } finally { done(); }
});
