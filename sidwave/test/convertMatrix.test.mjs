import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/interchange/convert.ts";
import { classifyError } from "../src/cliCore.ts";
import { GOLDEN_FILE, READABLE_TARGETS, TARGETS, caseKey, caseList, inputs, runCase } from "./helpers/convertMatrix.mjs";
import { haveEngine } from "./helpers/trackerDifferential.mjs";

// The conversion test matrix (W11): every importer x exporter pair on the committed fixtures. Cases are shared with
// scripts/regenerate-convert-golden.mjs. Budget: the whole file runs in well under 60 s of CPU time.

const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../doc/interchange.md"), "utf8");
const withEngine = await haveEngine();
const startedAt = process.cpuUsage();
const results = new Map(); // case key -> { ok, golden, result, ms }
const TYPED = new Set(["input", "validation", "usage", "limit_exceeded"]);
const PER_CASE_BOUND_MS = 2000;

const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));

test("every importer x exporter pair converts or fails with a typed error within 2 s", { timeout: 120_000 }, async () => {
  const cases = caseList({ withEngine });
  assert.ok(cases.length >= (withEngine ? 150 : 140), `only ${cases.length} cases`);
  for (const { input, target } of cases) {
    const key = caseKey(input, target);
    const start = performance.now();
    const outcome = await runCase(input, target, { verify: READABLE_TARGETS.includes(target) });
    const ms = performance.now() - start;
    results.set(key, { ...outcome, ms });
    assert.ok(ms < PER_CASE_BOUND_MS, `${key} took ${ms.toFixed(0)} ms`);
    if (!outcome.ok) assert.ok(TYPED.has(outcome.category), `${key}: untyped failure ${outcome.category}: ${outcome.error?.stack}`);
  }
  // Every format of the registry has been read and written by at least one case.
  const read = new Set(cases.map((c) => c.input.format));
  for (const format of ["sidwave", "midi", "musicxml", "goattracker", "furnace"]) assert.ok(read.has(format), `no input of ${format}`);
});

test("the reported losses match the golden file (regenerate with scripts/regenerate-convert-golden.mjs)", () => {
  assert.ok(results.size > 0, "the matrix test did not run");
  for (const [key, outcome] of results) {
    assert.ok(golden[key], `${key} has no golden entry; run scripts/regenerate-convert-golden.mjs`);
    assert.deepEqual(outcome.golden, golden[key], `${key}: the reported losses changed. Review the change, then run scripts/regenerate-convert-golden.mjs`);
  }
  // No golden entry is stale.
  const known = new Set(caseList({ withEngine: true }).map((c) => caseKey(c.input, c.target)));
  for (const key of Object.keys(golden)) assert.ok(known.has(key), `${key} is in the golden file but not in the matrix`);
});

function thresholds() {
  const body = /<!-- quality-thresholds:start -->([\s\S]*?)<!-- quality-thresholds:end -->/.exec(doc)?.[1];
  assert.ok(body, "doc/interchange.md has no quality threshold table");
  const table = new Map();
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !/^\d/.test(cells[3] ?? "")) continue;
    table.set(`${cells[1]} -> ${cells[2]}`, { upTo3: Number(cells[3]), over3: Number(cells[4]) });
  }
  return table;
}

test("re-import note F1 of each pair reaches the threshold of the table in doc/interchange.md", () => {
  const table = thresholds();
  for (const source of ["sidwave", "midi", "musicxml", "goattracker", "furnace", ...(withEngine ? ["sid"] : [])]) {
    for (const target of READABLE_TARGETS) assert.ok(table.has(`${source} -> ${target}`), `the table has no row ${source} -> ${target}`);
  }
  let checked = 0;
  for (const [key, outcome] of results) {
    const [inputId, target] = key.split(" -> ");
    if (!READABLE_TARGETS.includes(target) || !outcome.ok) continue;
    const source = inputId.split(":")[0];
    const metrics = outcome.result.metrics;
    assert.ok(metrics?.available, `${key}: no metrics`);
    const row = table.get(`${source} -> ${target}`);
    const needed = outcome.result.plan.summary.voicesWithNotes > 3 ? row.over3 : row.upTo3;
    assert.ok(metrics.noteF1 >= needed, `${key}: note F1 ${metrics.noteF1} is below ${needed} (precision ${metrics.precision}, recall ${metrics.recall})`);
    checked++;
  }
  assert.ok(checked >= 60, `only ${checked} pairs were measured`);
});

// ---- typed errors on damaged input ------------------------------------------------------------------------------

function xorshift(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

function damaged(bytes) {
  const out = [["truncated to half", bytes.subarray(0, bytes.length >> 1)], ["truncated to 3 bytes", bytes.subarray(0, 3)], ["empty", bytes.subarray(0, 0)]];
  for (const seed of [1, 2]) {
    const copy = Buffer.from(bytes);
    const next = xorshift(seed * 7919);
    for (let i = 0; i < Math.max(4, copy.length / 50); i++) copy[next() % copy.length] = next() & 255;
    out.push([`corrupted (seed ${seed})`, copy]);
  }
  return out;
}

test("truncated and corrupted files of every importer give a result or a typed error within 2 s", { timeout: 120_000 }, async () => {
  const picked = inputs().filter((i) => (/fuer-elise|hand-authored/.test(i.id)) && (withEngine || !i.sid));
  assert.ok(picked.length >= 7);
  let failures = 0, runs = 0;
  for (const input of picked) {
    for (const [label, bytes] of damaged(input.bytes)) {
      for (const to of input.sid ? ["sidwave"] : ["sidwave", "goattracker", "midi"]) {
        const start = performance.now();
        try {
          await convert(bytes, { from: input.format, to, inputName: input.name, ...(input.sid ? { seconds: 2 } : {}) });
        } catch (error) {
          failures++;
          const report = classifyError(error);
          assert.ok(TYPED.has(report.category), `${input.id} ${label} -> ${to}: ${report.category}: ${error.stack}`);
        }
        runs++;
        const ms = performance.now() - start;
        assert.ok(ms < PER_CASE_BOUND_MS, `${input.id} ${label} -> ${to} took ${ms.toFixed(0)} ms`);
      }
    }
  }
  assert.ok(runs >= 60);
  assert.ok(failures >= runs / 3, `only ${failures} of ${runs} damaged files were refused`);
});

// ---- identity ---------------------------------------------------------------------------------------------------

test("a chain gives the same bytes as the two-step import then export", { timeout: 120_000 }, async () => {
  let compared = 0;
  for (const input of inputs().filter((i) => !i.sid && !/chamber-waltz|digi-groove/.test(i.id))) {
    const toScore = await convert(input.bytes, { to: "sidwave", inputName: input.name });
    for (const target of TARGETS) {
      if (input.format === target && target === "sid") continue;
      const direct = results.get(caseKey(input, target))?.result?.output ?? (await runCase(input, target)).result?.output;
      const ok = direct !== undefined;
      const twoStep = await convert(toScore.output, { from: "sidwave", to: target, inputName: "intermediate.yaml" }).then((r) => r.output, () => undefined);
      assert.equal(twoStep !== undefined, ok, `${input.id} -> ${target}: one path fails and the other does not`);
      if (!ok) continue;
      assert.ok(Buffer.from(direct).equals(Buffer.from(twoStep)), `${input.id} -> ${target}: the chain and the two-step conversion differ`);
      compared++;
    }
  }
  assert.ok(compared >= 100, `only ${compared} chains compared`);
});

test("the matrix stays within its time budget", () => {
  const used = process.cpuUsage(startedAt);
  const seconds = (used.user + used.system) / 1e6;
  console.log(`# cpu convert matrix: ${seconds.toFixed(1)} s for ${results.size} conversions`);
  assert.ok(seconds < 60, `the matrix used ${seconds} s of CPU`);
  const slow = [...results].sort((a, b) => b[1].ms - a[1].ms)[0];
  console.log(`# slowest case: ${slow[0]} ${slow[1].ms.toFixed(0)} ms`);
});
