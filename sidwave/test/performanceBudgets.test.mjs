import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { readSidwaveExample } from "../src/sidwaveExamples.ts";
import { formatSidwave, diffSidwave } from "../src/format/sidwaveFormat.ts";
import { compareTraces } from "../src/verify/index.ts";
import { compareAudioA1, loadA1Rules } from "../src/verify/a1.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
import { parseSonglengths } from "../src/songlengths.ts";
import { resolveCutoff } from "../src/sidwaveFilterModel.ts";

// CPU-time budgets (see doc/performance.md). Each operation is measured as the smallest CPU time of a few runs, and
// compared with the CPU time of a fixed reference loop measured the same way in the same process. A slow or busy
// machine scales both, so the bound is a multiple of the reference and not an absolute time. The multiples are
// several times the typical value: they catch a complexity regression (a quadratic scan, a repeated parse), not
// a few percent of drift. On a machine shared with other busy processes the two measurements can differ by a
// factor of four, so the bounds flag order-of-magnitude regressions only.

function cpuMs(fn) {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

function referenceLoop() {
  let x = 1;
  for (let i = 0; i < 3_000_000; i++) x = (Math.imul(x, 31) + i) | 0;
  return x;
}

/**
 * The smallest CPU time of `runs` runs of `fn` and of the reference loop. The two are run alternately, so that a
 * period of contention on a shared machine raises both and the smallest values come from similar conditions.
 */
function measure(fn, runs = 5) {
  fn();
  let op = Infinity;
  let reference = Infinity;
  for (let i = 0; i < runs; i++) {
    reference = Math.min(reference, cpuMs(() => { if (referenceLoop() === 0.5) throw new Error("unreachable"); }));
    op = Math.min(op, cpuMs(fn));
  }
  return { op, reference };
}

function within(name, fn, multiple, runs) {
  const { op, reference } = measure(fn, runs);
  if (process.env.SIDWAVE_PERF_REPORT) console.log(`${name}: ${op.toFixed(1)} ms = ${(op / reference).toFixed(1)} x reference (${reference.toFixed(2)} ms), limit ${multiple} x`);
  const limit = multiple * reference;
  assert.ok(op <= limit, `${name} took ${op.toFixed(1)} ms CPU, over ${limit.toFixed(1)} ms (${multiple} x the reference loop of ${reference.toFixed(2)} ms)`);
}

const text = readSidwaveExample("chiptune_drive");

test("parse of a normal example stays within its budget", () => {
  within("parse", () => parseSidwave(text), 50);
});

test("compile to PRG stays within its budget", () => {
  const doc = parseSidwave(text);
  within("compile", () => compileSidwaveToPrg(doc), 100, 3);
});

test("format and semantic diff stay within their budgets", () => {
  within("format", () => formatSidwave(text), 45);
  const changed = text.replace(/tempo: *(\d+)/, (_, t) => `tempo: ${Number(t) + 1}`);
  assert.ok(changed !== text);
  within("diff", () => diffSidwave(text, changed), 300, 3);
});

test("a filter cutoff given in Hz resolves without scanning every register code each time", () => {
  within("resolveCutoff", () => { for (let i = 0; i < 2000; i++) resolveCutoff(`${300 + (i % 20) * 50}Hz`, "6581", "$"); }, 20);
});

test("Songlengths parsing is linear", () => {
  const lines = ["[Database]"];
  for (let i = 0; i < 20_000; i++) lines.push(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${(i * 40503 >>> 0).toString(16).padStart(8, "0")}${"0".repeat(16)}=3:${String(i % 60).padStart(2, "0")}`);
  within("parseSonglengths", () => parseSonglengths(lines.join("\n")), 30, 3);
});

function syntheticTrace(seconds) {
  const out = [];
  for (let f = 0; f < seconds * 50; f++) {
    let c = f * 19656 + 40;
    for (let v = 0; v < 3; v++) {
      const note = (f >> 3) % 7 + v * 5;
      out.push(0, v * 7, (note * 37) & 0xff, c, 0, v * 7 + 1, (note * 11) & 0xff, c + 8, 0, v * 7 + 4, f % 8 === 0 ? 0x41 : 0x40, c + 16);
      c += 40;
    }
  }
  return Float64Array.from(out);
}

test("T0/T1 comparison of 3-minute traces and trace IR of one minute stay within their budgets", () => {
  const a = syntheticTrace(180);
  const b = syntheticTrace(180);
  within("compareTraces", () => compareTraces(a, b), 50, 3);
  const minute = syntheticTrace(60);
  within("buildIr", () => buildIr(minute), 25, 3);
});

test("A1 comparison of 10 seconds of audio stays within its budget", () => {
  const pcm = (seed) => {
    const out = new Int16Array(48_000 * 10);
    let s = seed;
    for (let i = 0; i < out.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = Math.round(6000 * Math.sin(i / 21.7) + ((s >>> 20) - 2048) * 0.3);
    }
    return out;
  };
  const rules = loadA1Rules();
  const reference_ = pcm(3);
  const candidate = pcm(9);
  within("A1", () => compareAudioA1(reference_, candidate, rules), 150, 3);
});
