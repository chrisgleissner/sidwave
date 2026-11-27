import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/interchange/convert.ts";
import { classifyError } from "../src/cliCore.ts";
import { ENGINE_SOURCES, ENGINE_TARGETS, MISSING_FIXTURES, READABLE_FORMATS, READABLE_TARGETS, WRITABLE_FORMATS, caseKey, caseList, goldenFile, inputs, runCase } from "./helpers/convertMatrix.mjs";
import { haveEngine } from "./helpers/trackerDifferential.mjs";

// The conversion test matrix: every readable format of the registry x every writable format, on committed fixtures.
// The formats come from the registry, so a new format joins the matrix when its module is added; a readable format
// without a fixture fails the first test. Cases are shared with scripts/regenerate-convert-golden.mjs. The matrix
// runs in about 30 s of CPU time (budget 60 s).

const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../doc/interchange.md"), "utf8");
const withEngine = await haveEngine();
const startedAt = process.cpuUsage();
const results = new Map(); // case key -> { ok, golden, result, ms }
const TYPED = new Set(["input", "validation", "usage", "limit_exceeded"]);
const PER_CASE_BOUND_MS = 2000;
// Targets and sources that start the audio engine pay its start-up (WebAssembly compile) once, in the first case that uses it.
const ENGINE_BOUND_MS = 10_000;
// Bounds are CPU time, not wall time: the test files of the package run in parallel on shared machines.
const cpuMs = (since) => { const u = process.cpuUsage(since); return (u.user + u.system) / 1000; };

test("every format of the registry that can be read has a fixture, and every one that can be written is a target", () => {
  assert.deepEqual(MISSING_FIXTURES, [], `add fixtures for ${MISSING_FIXTURES.join(", ")} in test/helpers/convertMatrix.mjs`);
  const sources = new Set(inputs().map((i) => i.format));
  for (const id of READABLE_FORMATS) assert.ok(sources.has(id), `${id} has no input`);
  for (const id of ["sidwave", "sid", "midi", "musicxml", "goattracker", "furnace", "sidwizard", "basic", "wav", "prg", "events", "vice-dump", "siddump"]) {
    assert.ok(READABLE_FORMATS.includes(id) || WRITABLE_FORMATS.includes(id), `${id} is not in the registry`);
  }
});

test("every importer x exporter pair converts or fails with a typed error within 2 s of CPU time", { timeout: 180_000 }, async () => {
  const cases = caseList({ withEngine });
  assert.ok(cases.length >= (withEngine ? 190 : 150), `only ${cases.length} cases`);
  for (const { input, target } of cases) {
    const key = caseKey(input, target);
    const start = process.cpuUsage();
    const outcome = await runCase(input, target, { verify: READABLE_TARGETS.includes(target) });
    const ms = cpuMs(start);
    results.set(key, { ...outcome, ms });
    assert.ok(ms < (ENGINE_TARGETS.includes(target) || input.engine ? ENGINE_BOUND_MS : PER_CASE_BOUND_MS), `${key} used ${ms.toFixed(0)} ms of CPU`);
    if (!outcome.ok) assert.ok(TYPED.has(outcome.category), `${key}: untyped failure ${outcome.category}: ${outcome.error?.stack}`);
  }
});

test("no loss of the matrix has the code `note` (a sentence without a rule in loss.ts)", () => {
  assert.ok(results.size > 0);
  for (const [key, outcome] of results) {
    if (!outcome.ok) continue;
    const unmapped = outcome.result.losses.filter((l) => l.code === "note");
    assert.deepEqual(unmapped.map((l) => l.message), [], `${key}: add a rule for these sentences to src/interchange/loss.ts`);
  }
});

test("the reported losses match the golden files (regenerate with scripts/regenerate-convert-golden.mjs)", () => {
  assert.ok(results.size > 0, "the matrix test did not run");
  const byInput = new Map(inputs().map((i) => [i.id, i]));
  const files = new Map();
  for (const [key, outcome] of results) {
    const input = byInput.get(key.split(" -> ")[0]);
    const file = goldenFile(input);
    assert.ok(fs.existsSync(file), `${file} is missing; run scripts/regenerate-convert-golden.mjs`);
    const golden = files.get(file) ?? files.set(file, JSON.parse(fs.readFileSync(file, "utf8"))).get(file);
    assert.ok(golden[key], `${key} has no golden entry; run scripts/regenerate-convert-golden.mjs`);
    assert.deepEqual(outcome.golden, golden[key], `${key}: the reported losses changed. Review the change, then run scripts/regenerate-convert-golden.mjs`);
  }
  // No golden entry is stale.
  const known = new Set(caseList({ withEngine: true }).map((c) => caseKey(c.input, c.target)));
  for (const golden of files.values()) for (const key of Object.keys(golden)) assert.ok(known.has(key), `${key} is in a golden file but not in the matrix`);
});

function thresholds() {
  const table = new Map();
  for (const block of doc.matchAll(/<!-- quality:(\S+):start -->([\s\S]*?)<!-- quality:\1:end -->/g)) {
    for (const line of block[2].split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 8 || !/^\d/.test(cells[3] ?? "")) continue;
      table.set(`${cells[1]} -> ${cells[2]}`, { upTo3: Number(cells[3]), over3: Number(cells[4]), overlap: Number(cells[5]), voices: Number(cells[6]), reason: cells[7] });
    }
  }
  return table;
}

test("re-import note F1, duration overlap and voice agreement of each pair reach the thresholds of doc/interchange.md", () => {
  const table = thresholds();
  for (const source of READABLE_FORMATS.filter((f) => withEngine || !ENGINE_SOURCES.includes(f))) {
    for (const target of READABLE_TARGETS) {
      if (source === target && source === "sid") continue;
      assert.ok(table.has(`${source} -> ${target}`), `the table has no row ${source} -> ${target}`);
    }
  }
  let checked = 0;
  for (const [key, outcome] of results) {
    const [inputId, target] = key.split(" -> ");
    if (!READABLE_TARGETS.includes(target) || !outcome.ok) continue;
    const source = inputId.split(":")[0];
    const m = outcome.result.metrics;
    assert.ok(m?.available, `${key}: no metrics`);
    const row = table.get(`${source} -> ${target}`);
    const needed = outcome.result.plan.summary.voicesWithNotes > 3 ? row.over3 : row.upTo3;
    const fail = (what, got, want) => assert.ok(got >= want, `${key}: ${what} ${got} is below ${want} (${row.reason}); precision ${m.precision}, recall ${m.recall}, drum identity ${m.drumIdentity}`);
    fail("note F1", m.noteF1, needed);
    fail("duration overlap", m.durationOverlap, row.overlap);
    fail("voice agreement", m.voiceAgreement, row.voices);
    checked++;
  }
  assert.ok(checked >= 60, `only ${checked} pairs were measured`);
});

test("--verify compares a MIDI source with the output through the notes of the MIDI file itself", () => {
  let seen = 0;
  for (const [key, outcome] of results) {
    if (!key.startsWith("midi:") || !READABLE_TARGETS.includes(key.split(" -> ")[1]) || !outcome.ok) continue;
    const s = outcome.result.metrics.sourceVsOutput;
    assert.ok(s, `${key}: no source-vs-output metric`);
    assert.ok(s.noteF1PitchOnly >= 0.5, `${key}: ${s.noteF1PitchOnly}`);
    seen++;
  }
  assert.ok(seen >= 20);
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

test("truncated and corrupted files of every importer give a result or a typed error within 2 s of CPU time", { timeout: 180_000 }, async () => {
  const picked = inputs().filter((i) => (i.first || /hand/.test(i.id)) && !/digi|title|chamber/.test(i.id) && (withEngine || !i.engine));
  assert.ok(picked.length >= READABLE_FORMATS.length - (withEngine ? 0 : ENGINE_SOURCES.length));
  let failures = 0, runs = 0;
  for (const input of picked) {
    for (const [label, bytes] of damaged(input.bytes)) {
      for (const to of input.engine ? ["sidwave"] : ["sidwave", "goattracker", "midi"]) {
        const start = process.cpuUsage();
        try {
          await convert(bytes, { from: input.format, to, inputName: input.name, ...(input.engine ? { seconds: 2 } : {}) });
        } catch (error) {
          failures++;
          const report = classifyError(error);
          // An invalid score recovered from a tune is reported as internal on purpose (a defect of the reconstruct, not of the input).
          const allowed = TYPED.has(report.category) || (input.engine && /reconstruction produced an invalid score/.test(report.message));
          assert.ok(allowed, `${input.id} ${label} -> ${to}: ${report.category}: ${error.stack}`);
        }
        runs++;
        const ms = cpuMs(start);
        assert.ok(ms < (input.engine ? ENGINE_BOUND_MS : PER_CASE_BOUND_MS), `${input.id} ${label} -> ${to} used ${ms.toFixed(0)} ms of CPU`);
      }
    }
  }
  assert.ok(runs >= 60);
  assert.ok(failures >= runs / 3, `only ${failures} of ${runs} damaged files were refused`);
});

// ---- identity ---------------------------------------------------------------------------------------------------

test("a chain gives the same bytes as the two-step import then export", { timeout: 180_000 }, async () => {
  let compared = 0;
  for (const input of inputs().filter((i) => !i.engine && !/chamber-waltz|digi-groove/.test(i.id))) {
    const toScore = await convert(input.bytes, { to: "sidwave", inputName: input.name });
    for (const target of WRITABLE_FORMATS) {
      if (target === "sid" && input.format === "sid") continue;
      if (ENGINE_TARGETS.includes(target) || !results.has(caseKey(input, target))) continue; // engine targets are not part of the identity check
      const direct = results.get(caseKey(input, target)).result?.output;
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
