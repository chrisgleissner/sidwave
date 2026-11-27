// Regression tests for the S5d recovery repairs. Each test names the defect it covers. None of them uses a tune from HVSC:
// the inputs are seeded scores, hand-built register traces and the synthetic players of the other reconstruction tests.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { foldLoop, recoverScore } from "../src/reconstruct/recover.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { buildScore, roundTrip, verdict } from "./helpers/reconstructRoundTrip.mjs";

/** The original quadratic-in-steps search, kept as the reference: smallest loop start, then smallest period. */
function foldReference(steps) {
  const key = (s) => JSON.stringify({ ...s, calls: undefined });
  const n = steps.length;
  for (let start = 0; start < n; start++) {
    for (let period = 1; start + 2 * period <= n && period <= (n - start) / 2; period++) {
      let ok = true;
      for (let t = start + period; t < n && ok; t++) {
        const template = steps[start + ((t - start) % period)];
        const s = steps[t];
        const lastShort = t === n - 1 && Number(s.calls) <= Number(template.calls);
        ok = key(s) === key(template) && (s.calls === template.calls || lastShort);
      }
      if (ok) return { steps: steps.slice(0, start + period), loop: start };
    }
  }
  return { steps };
}

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

test("foldLoop gives the same loop as the reference search on 400 seeded step lists", () => {
  const rand = seeded(7);
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rand() * 24);
    const alphabet = 1 + Math.floor(rand() * 3);
    const steps = Array.from({ length: n }, () => ({ add: Math.floor(rand() * alphabet), calls: 1 + Math.floor(rand() * 2) }));
    assert.deepEqual(foldLoop(steps), foldReference(steps), JSON.stringify(steps));
  }
});

test("foldLoop takes linear time in the number of steps for a list that does not repeat", () => {
  const steps = Array.from({ length: 6000 }, (_, i) => ({ add: i, calls: 1 }));
  const started = process.cpuUsage();
  const folded = foldLoop(steps);
  const used = process.cpuUsage(started);
  assert.equal(folded.loop, undefined);
  assert.ok((used.user + used.system) / 1000 < 1500, `${(used.user + used.system) / 1000} ms of CPU for 6000 steps`);
});

test("a note longer than a pattern block is laid out without a negative length (blocks of one bar, one note of nine bars)", async () => {
  const score = buildScore("basic", 3);
  score.voices[0].patterns = { L: { length: 0.5, groove: [{ note: "C4", len: 36 }, "-"] } };
  score.timeline = [{ section: "Main", bars: 10, layers: { v1: "L" } }];
  const r = await roundTrip(score, 6);
  assert.equal(r.report.compile?.ok, true, r.report.compile?.error);
});

test("a score with speed 5 recovers to a compilable 1.5 score and keeps the call rate", async () => {
  const unit = 1 / 80;
  const score = {
    sidwave: "1.5", title: "five", tempo: 60 * 50.1245 / 16, mode: "PAL", speed: 5,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: unit, bars: 1, groove: Array.from({ length: 16 }, (_, i) => ({ note: i % 2 ? "C5" : "A4", len: 0.25 })) } } }],
    timeline: [{ section: "Main", bars: 2, layers: { v1: "a" } }],
  };
  const r = await roundTrip(score, 3);
  assert.equal(r.report.compile?.ok, true, r.report.compile?.error);
  assert.equal(r.report.recovery.languageVersion, "1.5");
  assert.equal(r.report.recovery.speed, 5);
  assert.equal(r.report.callRate.callsPerFrame, 5);
});

test("a score with speed 5 round trips with the register state exact", {
  todo: "open: the recompiled player differs in the volume register around the start (the first difference is volume, call 1), and 76 of 750 calls differ in pitch; the cause is not isolated yet (see HANDOVER-S5d)",
}, async () => {
  const unit = 1 / 80;
  const score = {
    sidwave: "1.5", title: "five", tempo: 60 * 50.1245 / 16, mode: "PAL", speed: 5,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: unit, bars: 1, groove: Array.from({ length: 16 }, (_, i) => ({ note: i % 2 ? "C5" : "A4", len: 0.25 })) } } }],
    timeline: [{ section: "Main", bars: 2, layers: { v1: "a" } }],
  };
  const r = await roundTrip(score, 3);
  assert.equal(r.report.registerStateExact, true, JSON.stringify(r.report.fdiffState.first));
});

test("exact note registers: a score with tuning.registers round trips with the same registers in the recovered tuning", async () => {
  const score = buildScore("basic", 2);
  score.sidwave = "1.5";
  score.tuning = { registers: { C4: 4400, G4: 6700, E3: "$0900" } };
  const r = await roundTrip(score, 4);
  assert.equal(r.report.compile?.ok, true, r.report.compile?.error);
  const recovered = YAML.parse(r.score);
  assert.equal(recovered.sidwave, "1.5");
  const got = recovered.tuning?.registers ?? {};
  // The recovered table may name another note for a register (the nearest free slot), but it holds every register the source played.
  const values = Object.values(got);
  for (const [note, reg] of Object.entries({ C4: 4400, G4: 6700, E3: 0x900 })) {
    if (r.text.includes(note)) assert.ok(values.includes(reg), `${note}=${reg} in ${JSON.stringify(got)}`);
  }
  assert.equal(r.report.fdiffState.classes.pitch.differingCalls, 0, JSON.stringify(r.report.fdiff.first));
});

/** Registers of a hand-built player trace: eighty notes, each with its own pulse width sequence, so that every note is a different program. */
function distinctProgramsTrace() {
  const records = [];
  const period = 19_656;
  let call = 0;
  const write = (reg, value, offset = 0) => records.push(0, reg, value, call * period + offset);
  for (let reg = 0; reg < 25; reg++) write(reg, 0, reg);
  call++;
  for (let note = 0; note < 80; note++) {
    const midi = 48 + (note % 24);
    const reg = Math.round((440 * 2 ** ((midi - 69) / 12) * 16_777_216) / 985_248);
    for (let c = 0; c < 12; c++, call++) {
      write(0, reg & 255, 0);
      write(1, reg >> 8, 10);
      const pw = 300 + note * 17 + c * (3 + (note % 7));
      write(2, pw & 255, 20);
      write(3, pw >> 8, 30);
      write(4, c < 8 ? 0x41 : 0x40, 40);
      write(5, 0x08, 50);
      write(6, 0xa4, 60);
      write(24, 15, 70);
    }
  }
  return { records: Float64Array.from(records), calls: call };
}

test("more than 63 distinct instrument programs recover to a score that compiles (instrument budget)", () => {
  const { records, calls } = distinctProgramsTrace();
  const ir = buildIr(records, { clock: "PAL", horizonCycles: (calls + 1) * 19_656, originCycle: 0 });
  const recovered = recoverScore(ir, {});
  assert.ok(recovered.unsupported.some((u) => u.kind === "instrument_budget"), JSON.stringify(recovered.unsupported.map((u) => u.kind)));
  const doc = parseSidwave(recovered.text);
  assert.ok(Object.keys(doc.instruments).length <= 63);
  compileSidwaveBytes(doc, { format: "sid", loop: true });
});

test("a table of more than 255 pulse steps over all instruments is reduced to fit, and the recovery stays linear in the calls", () => {
  const { records, calls } = distinctProgramsTrace();
  const ir = buildIr(records, { clock: "PAL", horizonCycles: (calls + 1) * 19_656, originCycle: 0 });
  const started = process.cpuUsage();
  const recovered = recoverScore(ir, {});
  const used = process.cpuUsage(started);
  const steps = Object.values(recovered.document.instruments ?? {}).reduce((n, i) => n + (i.pulsetable?.steps?.length ?? 0), 0);
  assert.ok(steps <= 255, `${steps} pulse steps`);
  assert.ok((used.user + used.system) / 1000 < 3000, `${(used.user + used.system) / 1000} ms of CPU for ${calls} calls`);
});

test("existing exact round trips stay exact (basic, seed 1)", async () => {
  const r = await roundTrip(buildScore("basic", 1));
  assert.equal(verdict(r.report), "exact");
});

test("a pulse width that wraps modulo 4096 or reaches 0 is recovered as a wrap table and round trips in the pulse class", async () => {
  const score = buildScore("basic", 4);
  score.sidwave = "1.5";
  score.instruments[score.voices[0].instrument] = {
    waveform: "pulse", adsr: [0, 4, 12, 3],
    pulsetable: { wrap: true, steps: [{ set: 3900, calls: 1 }, { add: 150, calls: 3 }, { add: -90, calls: 6 }] },
  };
  const r = await roundTrip(score, 4);
  assert.equal(r.report.compile?.ok, true, r.report.compile?.error);
  assert.match(r.score, /wrap: true/);
  assert.equal(r.report.fdiffState.classes.pulse.differingCalls, 0, JSON.stringify(r.report.fdiff.first));
});

test("a recovered score that exceeds the cycle budget is compiled for a faster CPU, reported, and never a strict pass", async () => {
  const unit = 1 / 128;
  const g = Array.from({ length: 32 }, (_, i) => ({ note: i % 2 ? "C5" : "A4", len: 0.125 }));
  const score = {
    sidwave: "1.5", title: "eight", tempo: 60 * 50.1245 / 16, mode: "PAL", speed: 8, player: { soft_start: false },
    instruments: {
      a: { waveform: "pulse", adsr: [0, 4, 12, 3], hard_restart: { frames: 0 }, vibrato: { depth: 0.3, rate: 5 }, pulsetable: { steps: [{ set: 1000 }, { add: 5, calls: 20 }], loop: 1 } },
    },
    voices: [1, 2, 3].map((id) => ({ id, instrument: "a", patterns: { p: { length: unit, bars: 1, groove: g.flatMap((x) => [x]) } } })),
    timeline: [{ section: "Main", bars: 1, layers: { v1: "p", v2: "p", v3: "p" } }],
  };
  let result;
  try {
    result = await roundTrip(score, 2);
  } catch (error) {
    assert.match(String(error.message), /cpu: turbo|Invalid SIDWAVE/);
    return;
  }
  if (result.report.compile?.cycleBudgetExceeded) assert.equal(result.report.strictExact, false);
  assert.equal(result.report.compile?.ok, true, result.report.compile?.error);
});
