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
// compared with the CPU time of a fixed reference workload measured the same way in the same process. A slow or busy
// machine scales both, so the bound is a multiple of the reference and not an absolute time. The multiples are
// about five times the measured ratio: they catch a complexity regression (a quadratic scan, a repeated parse), not
// a few percent of drift. resolveCutoff is far below the reference when it is fast (0.03 x) and about 15 x with the
// old scan of 2048 codes per lookup, so its bound is 3 x.

function cpuMs(fn) {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

// A mixed workload of allocation, sorting and JSON, the kind of work the measured operations do. A tight arithmetic
// loop was tried first and rejected: in the same Node version it took 3 ms in one process and 15 ms in another.
function referenceLoop() {
  const items = [];
  let seed = 7;
  for (let i = 0; i < 30_000; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    items.push({ k: seed % 1000, name: `n${seed % 977}`, v: [seed & 255, i] });
  }
  items.sort((x, y) => x.k - y.k || (x.name < y.name ? -1 : 1));
  const json = JSON.stringify(items);
  return JSON.parse(json).length + json.length;
}

/**
 * The smallest CPU time of `runs` runs of `fn` and of the reference loop. The two are run alternately, so that a
 * period of contention on a shared machine raises both and the smallest values come from similar conditions.
 */
function measure(fn, runs = 5) {
  // The reference loop is warmed up in this call, because its first runs are several times slower than the optimised
  // ones (the engine tiers up the loop), and the budgets are checked one after the other.
  for (let i = 0; i < 3; i++) referenceLoop();
  fn();
  let op = Infinity;
  let reference = Infinity;
  for (let i = 0; i < Math.max(runs, 5); i++) {
    reference = Math.min(reference, cpuMs(() => { if (referenceLoop() < 0) throw new Error("unreachable"); }));
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
  within("parse", () => parseSidwave(text), 5.5);
});

test("compile to PRG stays within its budget", () => {
  const doc = parseSidwave(text);
  within("compile", () => compileSidwaveToPrg(doc), 13, 3);
});

test("format and semantic diff stay within their budgets", () => {
  within("format", () => formatSidwave(text), 5.5);
  const changed = text.replace(/tempo: *(\d+)/, (_, t) => `tempo: ${Number(t) + 1}`);
  assert.ok(changed !== text);
  within("diff", () => diffSidwave(text, changed), 50, 3);
});

test("a filter cutoff given in Hz resolves without scanning every register code each time", () => {
  within("resolveCutoff", () => { for (let i = 0; i < 3000; i++) resolveCutoff(`${300 + i * 5}Hz`, "6581", "$"); }, 3);
});

test("Songlengths parsing is linear", () => {
  const lines = ["[Database]"];
  for (let i = 0; i < 20_000; i++) lines.push(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${(i * 40503 >>> 0).toString(16).padStart(8, "0")}${"0".repeat(16)}=3:${String(i % 60).padStart(2, "0")}`);
  within("parseSonglengths", () => parseSonglengths(lines.join("\n")), 3.5, 3);
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
  within("compareTraces", () => compareTraces(a, b), 4.5, 3);
  const minute = syntheticTrace(60);
  within("buildIr", () => buildIr(minute), 1.5, 3);
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
  within("A1", () => compareAudioA1(reference_, candidate, rules), 30, 3);
});
