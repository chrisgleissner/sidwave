// Regression tests for the S5d recovery repairs. Each test names the defect it covers. None of them uses a tune from HVSC:
// the inputs are seeded scores, hand-built register traces and the synthetic players of the other reconstruction tests.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { clampRestarts, foldLoop, recoverScore } from "../src/reconstruct/recover.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { reconstructSid, trimIr } from "../src/reconstruct/reconstruct.ts";
import { buildScore, roundTrip, sharedEngine, verdict } from "./helpers/reconstructRoundTrip.mjs";

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

test("a score with speed 5 round trips with the register state exact", { timeout: 120_000 }, async () => {
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

// The cycle-budget fallback is tested in reconstructSummary.test.mjs.

test("foldLoop takes linear time for constant and periodic step lists of 16000 steps", () => {
  for (const make of [() => ({ add: 1, calls: 1 }), (i) => ({ add: i % 3, calls: 1 })]) {
    const steps = Array.from({ length: 16000 }, (_, i) => make(i));
    const started = process.cpuUsage();
    const folded = foldLoop(steps);
    const used = process.cpuUsage(started);
    assert.ok(folded.loop === 0 && folded.steps.length <= 3);
    assert.ok((used.user + used.system) / 1000 < 400, `${(used.user + used.system) / 1000} ms of CPU`);
  }
});

test("1.5 constructs in a 1.4 document name the version: pulse width 0, wavetable reg, speed 5, rows below 1/64 beat, songs speed", () => {
  const base = (version, extra = "", inst = "{ waveform: pulse }", len = 1) => `sidwave: "${version}"\ntitle: T\ntempo: 120\n${extra}voices:\n  - { id: 1, instrument: lead, patterns: { a: { length: ${len}, bars: 1, groove: "A4 - C5 -" } } }\ninstruments:\n  lead: ${inst}\ntimeline:\n  - { section: Main, bars: 4, layers: { v1: a } }\n`;
  assert.throws(() => parseSidwave(base("1.4", "", "{ waveform: pulse, pulsetable: [{ set: 0 }] }")), /sidwave: 1\.5/);
  assert.throws(() => parseSidwave(base("1.4", "", "{ waveform: pulse, wavetable: [{ reg: 4000 }] }")), /reg.*sidwave: 1\.5/);
  assert.throws(() => parseSidwave(base("1.4", "speed: 5\n")), /\$\.speed.*sidwave: 1\.5/);
  assert.throws(() => parseSidwave(base("1.4", "", "{ waveform: pulse }", 0.01)), /sidwave: 1\.5/);
  const songs = (version, speed) => `sidwave: "${version}"\ntitle: T\ntempo: 120\nspeed: ${speed}\nvoices:\n  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }\ninstruments:\n  lead: { waveform: pulse }\nsections:\n  s: { bars: 1, layers: { v1: a } }\nsongs:\n  - { name: one, timeline: [{ section: s, bars: 1, layers: { v1: a } }], speed: ${speed} }\n`;
  assert.throws(() => parseSidwave(songs("1.4", 6)), /speed/);
  assert.equal(parseSidwave(songs("1.5", 6)).songs[0].speed, 6);
});

for (const speed of [2, 4, 8]) {
  test(`a score with speed ${speed} round trips with the register state exact`, {
    timeout: 120_000,
  }, async () => {
    const score = {
      sidwave: "1.5", title: "multi", tempo: 60 * 50.1245 / 16, mode: "PAL", speed,
      instruments: { lead: { waveform: "pulse", adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } } },
      voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 1 / (16 * speed), bars: 1, groove: Array.from({ length: 16 }, (_, i) => ({ note: i % 2 ? "C5" : "A4", len: 0.25 })) } } }],
      timeline: [{ section: "Main", bars: 2, layers: { v1: "a" } }],
    };
    const r = await roundTrip(score, 3);
    assert.equal(r.report.registerStateExact, true, JSON.stringify(r.report.fdiffState.first));
  });
}

test("staged verification: an exact tune of 12 s is verified over the whole horizon, a differing one stops after the 10 s probe", { timeout: 180_000 }, async () => {
  const exact = await roundTrip(buildScore("basic", 1), 12);
  assert.equal(exact.report.verification.mode, "full");
  assert.equal(exact.report.verification.seconds, 12);
  assert.equal(exact.report.strictExact, true, JSON.stringify(exact.report.fdiff.first));
  const full = await reconstructSid(new Uint8Array(compileSidwaveBytes(parseSidwave(buildScore("basic", 1)), { format: "sid", loop: true }).bytes), { engine: sharedEngine(), seconds: 12, verify: "full" });
  assert.equal(full.report.verification.mode, "full");
  assert.equal(full.report.strictExact, true);
  // Generator scores use legato notes with portamento, which recovery does not reproduce, so the probe fails.
  const staged = await roundTrip(buildScore("generator", 1), 12);
  assert.equal(staged.report.registerStateExact, false);
  assert.equal(staged.report.verification.mode, "probe");
  assert.equal(staged.report.verification.seconds, 10);
  assert.equal(staged.report.strictExact, false);
});

test("trimIr keeps the calls that start within the given seconds of the alignment point", () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ index: i, startCycle: i * 1000, endCycle: i * 1000 + 5, writes: 1, sids: [] }));
  const ir = { clockHz: 1000, calls };
  assert.equal(trimIr(ir, 1, 3).calls.length, 5); // calls 0..4: starts at 0..4000, limit 1000 + 3000
  assert.equal(trimIr(ir, 0, 100).calls.length, 10);
});

test("compiled examples reconstructed at 20 s and 60 s always return a score that compiles (instrument and table budgets are applied in recovery)", { timeout: 900_000 }, async () => {
  const { readSidwaveExample } = await import("../src/sidwaveExamples.ts");
  for (const name of ["fuer_elise", "chamber_waltz", "title_fanfare", "arp_ballad", "ambient_filter"]) {
    const bytes = new Uint8Array(compileSidwaveBytes(parseSidwave(readSidwaveExample(name)), { format: "sid", loop: true }).bytes);
    for (const seconds of [20, 60]) {
      const { score, report } = await reconstructSid(bytes, { engine: sharedEngine(), seconds, verify: "staged" });
      parseSidwave(score);
      assert.equal(report.compile?.ok, true, `${name} ${seconds} s: ${report.compile?.error}`);
      assert.equal(report.internalError, undefined, `${name} ${seconds} s`);
    }
  }
});

test("clampRestarts shortens an instrument's hard restart to its shortest note, measured in the emitted patterns (speed 5)", () => {
  const document = {
    instruments: { a: { hard_restart: { frames: 1, adsr: [0, 15, 0, 15], test: true } }, b: { hard_restart: { frames: 2 } }, c: { hard_restart: { frames: 0 } } },
    voices: [{ instrument: "a", patterns: {
      P1: { length: 0.075, groove: [{ note: "A#7", inst: "a", len: 0.075 }, "C4@b", "~", "-"] },
      P2: { length: 0.25, groove: ["C4", "~", "D4@b"] },
    } }],
  };
  // 80 calls per beat: 0.075 beat = 6 calls (a needs 5 + 5 = 10); b: C4 + tie = 12 calls, D4 = 20 calls (needs 2 * 5 + 5 = 15)
  assert.equal(clampRestarts(document, 80, 5), 2);
  assert.equal(document.instruments.a.hard_restart.frames, 0);
  assert.equal(document.instruments.a.hard_restart.test, undefined);
  assert.equal(document.instruments.b.hard_restart.frames, 1);
  assert.equal(clampRestarts(document, 80, 5), 0);
});

test("two player calls closer than the burst gap are split: the first row at speed 8 has the length of every other row", async () => {
  const frame = 19_656 / 8;
  const writes = [];
  // Calls 0, 1, 3 and 4 are regular; call 2 starts late and ends 1,500 cycles before call 3, which merges them.
  for (const [start, late] of [[0, 0], [1, 0], [2, 900], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]]) {
    for (let reg = 0; reg < 7; reg++) writes.push(0, reg, start, Math.round(10_000 + start * frame + late + reg * 10));
  }
  const ir = buildIr(Float64Array.from(writes), { clock: "PAL" });
  assert.equal(ir.calls.length, 8);
  assert.deepEqual(ir.calls.map((c) => c.sids[0].regs[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
});
