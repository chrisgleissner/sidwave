import test from "#test/runner";
import assert from "#test/assert";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSidwave, diffSidwave, mergeSidwave } from "../src/format/sidwaveFormat.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const exampleDir = join(root, "data/sound/examples");
const fixtureDir = join(root, "test/fixtures");
const minimal = (patch = {}) => ({ sidwave: "1.0", title: "Test", tempo: 100, voices: [{ id: 1, patterns: { A: { groove: ["C3", "D3"] } } }], timeline: [{ bars: 1, layers: { v1: "A" } }], ...patch });
const yaml = (o) => import("yaml").then(({ default: Y }) => Y.stringify(o));

test("formatter is idempotent and preserves parser and PRG semantics across bundled scores", { timeout: 120000 }, async () => {
  const files = [
    ...(await readdir(exampleDir)).filter((f) => f.endsWith(".yaml")).map((f) => join(exampleDir, f)),
    ...(await (async function walk(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await walk(p)); else if (p.endsWith(".yaml")) out.push(p); } return out; })(fixtureDir)),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8"), formatted = formatSidwave(source);
    assert.equal(formatSidwave(formatted), formatted, file);
    assert.deepEqual(parseSidwave(formatted), parseSidwave(source), file);
    assert.deepEqual(compileSidwaveToPrg(parseSidwave(formatted), { loop: false }).prg, compileSidwaveToPrg(parseSidwave(source), { loop: false }).prg, file);
  }
});

test("diff table assigns domain classes; reformat is formatting only", async () => {
  const cases = [
    ["musical", { voices: [{ id: 1, patterns: { A: { groove: ["C3"] } } }] }, { voices: [{ id: 1, patterns: { A: { groove: ["D3"] } } }] }],
    ["synthesis", { voices: [{ id: 1, waveform: "pulse", patterns: { A: { groove: ["C3"] } } }] }, { voices: [{ id: 1, waveform: "triangle", patterns: { A: { groove: ["C3"] } } }] }],
    ["hardware", { mode: "PAL" }, { mode: "NTSC" }],
    ["structural", { title: "Before" }, { title: "After" }],
  ];
  for (const [kind, a, b] of cases) {
    const d = diffSidwave(await yaml(minimal(a)), await yaml(minimal(b)));
    assert.ok(d.changes.some((c) => c.class === kind), kind);
  }
  const source = await yaml(minimal()), reformatted = formatSidwave(source);
  const d = diffSidwave(source, reformatted);
  assert.ok(d.compiledEqual);
  assert.deepEqual(d.changes.map((c) => c.class), ["formatting"]);
});

test("three-way merge joins disjoint edits, refuses concurrent note edits, accepts identical edits", async () => {
  const b = minimal();
  const base = await yaml(b), ours = await yaml({ ...b, title: "Ours" }), theirs = await yaml({ ...b, tempo: 110 });
  const merged = mergeSidwave(base, ours, theirs);
  assert.equal(merged.conflicts.length, 0);
  assert.ok(merged.merged);
  assert.ok(compileSidwaveToPrg(parseSidwave(merged.merged), { loop: false }).prg.length);
  const note = (n) => ({ ...b, voices: [{ id: 1, patterns: { A: { groove: [n, "D3"] } } }] });
  assert.ok(mergeSidwave(await yaml(b), await yaml(note("E3")), await yaml(note("F3"))).conflicts.length);
  const same = mergeSidwave(await yaml(b), await yaml(note("E3")), await yaml(note("E3")));
  assert.equal(same.conflicts.length, 0);
  assert.ok(same.merged);
});
