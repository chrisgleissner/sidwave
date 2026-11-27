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
