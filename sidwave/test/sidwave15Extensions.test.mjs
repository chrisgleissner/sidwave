// SIDWave 1.5 language extensions (S5d): player options (soft start), pulse tables with width 0 and wrap. Each extension is
// gated by `sidwave: 1.5`, and a score that does not use it compiles to the same bytes under 1.4 and 1.5.
import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";

const score = (version, extra = "", instrument = "{ waveform: pulse, adsr: [0, 4, 12, 3] }") => `sidwave: "${version}"
title: T
tempo: 120
${extra}voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
instruments:
  lead: ${instrument}
timeline:
  - { section: Main, bars: 2, layers: { v1: a } }
`;
const compile = (text) => new Uint8Array(compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true }).bytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function writes(text, seconds = 2) {
  const trace = await sharedEngine().trace({ sid: compile(text), seconds });
  const out = [];
  for (let i = 0; i < trace.records.length; i += 4) out.push({ sid: trace.records[i], reg: trace.records[i + 1], value: trace.records[i + 2], cycle: trace.records[i + 3] });
  return out;
}

const PULSE_FIVE = (table) => `{ waveform: pulse, adsr: [0, 4, 12, 3], pulsetable: ${table} }`;

test("a score without 1.5 constructs compiles to the same bytes under 1.4 and 1.5", () => {
  const a = compile(score("1.4"));
  const b = compile(score("1.5"));
  assert.equal(sha(a), sha(b));
  const pulse = PULSE_FIVE("{ steps: [{ set: 1000 }, { add: 100, frames: 4 }], loop: 1 }");
  assert.equal(sha(compile(score("1.4", "", pulse))), sha(compile(score("1.5", "", pulse))));
});

test("player and pulse-table extensions in a 1.4 document are errors that name the version and the field", () => {
  assert.throws(() => parseSidwave(score("1.4", "player: { soft_start: false }\n")), /\$\.player.*sidwave: 1\.5.*sidwave: 1\.4/);
  assert.throws(() => parseSidwave(score("1.4", "", PULSE_FIVE("{ wrap: true, steps: [{ set: 1000 }] }"))), /pulsetable\.wrap.*sidwave: 1\.5/);
  assert.throws(() => parseSidwave(score("1.4", "", PULSE_FIVE("[{ set: 0 }]"))), /pulsetable\[0\]\.set/);
  assert.throws(() => parseSidwave(score("1.5", "player: { soft_start: 1 }\n")), /soft_start/);
  assert.throws(() => parseSidwave(score("1.5", "player: { volume: 1 }\n")), /volume/);
});

test("soft_start: false removes the volume ramp of the first calls", async () => {
  const volumes = async (text) => (await writes(text)).filter((w) => w.reg === 0x18).map((w) => w.value & 15);
  const withRamp = await volumes(score("1.5"));
  const without = await volumes(score("1.5", "player: { soft_start: false }\n"));
  const explicitDefault = await volumes(score("1.5", "player: { soft_start: true }\n"));
  assert.deepEqual(explicitDefault, withRamp);
  assert.ok(withRamp.some((v, i) => i > 0 && v > withRamp[i - 1]), "the default player ramps the volume up");
  // The first two writes belong to the player's init (volume 15, then cleared); the play calls follow.
  assert.deepEqual(withRamp.slice(2, 17), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].slice(0, withRamp.length - 2));
  assert.ok(without.slice(2).every((v) => v === 15), `without the ramp the first play call writes volume 15: ${without.slice(0, 6)}`);
});

test("a pulse table accepts width 0", async () => {
  const text = score("1.5", "", PULSE_FIVE("[{ set: 0 }, { add: 300, frames: 3 }]"));
  const w = (await writes(text)).filter((x) => x.reg === 2 || x.reg === 3);
  const widths = [];
  let lo = 0;
  for (const x of w) {
    if (x.reg === 2) lo = x.value;
    else widths.push(lo | ((x.value & 15) << 8));
  }
  assert.ok(widths.includes(0), `a width of 0 is written: ${widths.slice(0, 8)}`);
});

test("wrap: true wraps a pulse width modulo 4096; without it the width clamps to 4094", async () => {
  const widthsOf = async (table) => {
    const w = (await writes(score("1.5", "", PULSE_FIVE(table)))).filter((x) => x.reg === 2 || x.reg === 3);
    const out = [];
    let lo = 0;
    for (const x of w) {
      if (x.reg === 2) lo = x.value;
      else out.push(lo | ((x.value & 15) << 8));
    }
    return out;
  };
  const wrapped = await widthsOf("{ wrap: true, steps: [{ set: 3900 }, { add: 150, frames: 4 }] }");
  const clamped = await widthsOf("{ steps: [{ set: 3900 }, { add: 150, frames: 4 }] }");
  assert.ok(wrapped.slice(0, 6).join() === "3900,4050,104,254,404" || wrapped.slice(0, 8).some((v) => v === 104), `wrapped: ${wrapped.slice(0, 8)}`);
  assert.ok(clamped.every((v) => v <= 4094) && clamped.some((v) => v === 4094), `clamped: ${clamped.slice(0, 8)}`);
});

test("a wavetable step with reg writes the exact frequency register value", async () => {
  const text = score("1.5", "", "{ waveform: pulse, adsr: [0, 4, 12, 3], wavetable: [{ reg: '$1CD6', calls: 3 }, { reg: 0x2001 }] }");
  const w = await writes(text);
  const freqs = [];
  let lo = 0;
  for (const x of w) {
    if (x.reg === 0) lo = x.value;
    else if (x.reg === 1) freqs.push(lo | (x.value << 8));
  }
  assert.ok(freqs.includes(0x1cd6), `0x1CD6 is written: ${freqs.slice(0, 8).map((f) => f.toString(16))}`);
  assert.ok(freqs.includes(0x2001), "0x2001 is written after the first step");
  assert.throws(() => parseSidwave(score("1.4", "", "{ waveform: pulse, wavetable: [{ reg: '$1CD6' }] }")), /wavetable\[0\]/);
  assert.throws(() => parseSidwave(score("1.5", "", "{ waveform: pulse, wavetable: [{ reg: 70000 }] }")), /reg/);
  assert.throws(() => parseSidwave(score("1.5", "", "{ waveform: pulse, wavetable: [{ reg: '$1CD6', note: C5 }] }")), /reg cannot be combined/);
});

const freqsOf = async (text) => {
  const w = await writes(text);
  const out = [];
  let lo = 0;
  for (const x of w) {
    if (x.reg === 0) lo = x.value;
    else if (x.reg === 1) out.push(lo | (x.value << 8));
  }
  return out;
};

test("tuning.registers replaces the register of single notes and tuning.cents shifts every note", async () => {
  const plain = await freqsOf(score("1.5"));
  const exact = await freqsOf(score("1.5", "tuning: { registers: { A4: '$1234', C5: 0x2222 } }\n"));
  const A4 = plain.find((f) => f > 0);
  assert.ok(A4 !== 0x1234 && plain.includes(A4));
  assert.ok(exact.includes(0x1234), `A4 is the exact register: ${exact.slice(0, 6).map((f) => f.toString(16))}`);
  assert.ok(exact.includes(0x2222), "C5 is the exact register");
  assert.ok(!exact.includes(A4), "the equal-temperament value of A4 is gone");
  const shifted = await freqsOf(score("1.5", "tuning: { cents: 50 }\n"));
  const a4Shifted = Math.round(440 * 2 ** (50 / 1200) * 16777216 / 985248);
  assert.ok(shifted.some((f) => Math.abs(f - a4Shifted) <= 1), `A4 +50 cents is ${a4Shifted}: ${shifted.slice(0, 4)}`);
});

test("tuning is rejected in a 1.4 document and for bad values; a score without it keeps its bytes", () => {
  assert.throws(() => parseSidwave(score("1.4", "tuning: { cents: 5 }\n")), /\$\.tuning.*sidwave: 1\.5.*sidwave: 1\.4/);
  assert.throws(() => parseSidwave(score("1.5", "tuning: { cents: 150 }\n")), /cents/);
  assert.throws(() => parseSidwave(score("1.5", "tuning: { registers: { C9: 100 } }\n")), /registers\.C9/);
  assert.throws(() => parseSidwave(score("1.5", "tuning: { registers: { A4: 0 } }\n")), /registers\.A4/);
  assert.equal(sha(compile(score("1.5", "tuning: {}\n"))), sha(compile(score("1.4"))));
});

test("speed up to 8 and rows of 1/128 beat are accepted from 1.5", async () => {
  const body = (speed, version) => `sidwave: "${version}"
title: T
tempo: ${60 * 50.1245 / 16}
speed: ${speed}
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: ${1 / (16 * speed)}, bars: 1, groove: [${Array.from({ length: 8 }, (_, i) => `{ note: ${i % 2 ? "C5" : "A4"}, len: 0.5 }`).join(", ")}] } } }
instruments:
  lead: { waveform: pulse, adsr: [0, 4, 12, 3], hard_restart: { frames: 0 } }
timeline:
  - { section: Main, bars: 2, layers: { v1: a } }
`;
  assert.throws(() => parseSidwave(body(8, "1.4")), /speed|length/);
  assert.throws(() => parseSidwave(body(5, "1.4")), /speed|length/);
  const calls = (await writes(body(8, "1.5"), 1)).filter((w) => w.reg === 4).length;
  assert.ok(calls > 8 * 40, `eight player calls per frame: ${calls} control writes in 1 s`);
});
