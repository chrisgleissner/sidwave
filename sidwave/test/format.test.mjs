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

test("formatter orders the fields of voices, patterns, instruments, sections and notes", () => {
  const source = `timeline: [intro]
voices:
  - patterns:
      A:
        length: 0.25
        groove:
          - {len: 1, inst: lead, note: C4}
          - "D4 ~ ~ ~"
    instrument: lead
    name: Lead
    id: 1
sections:
  intro:
    layers: {v1: A}
    bars: 1
instruments:
  lead: {adsr: [0, 4, 10, 4], waveform: saw}
sids: [{model: "8580", address: "$D400", id: sid1}]
tempo: 120
title: T
sidwave: 1.2
`;
  assert.equal(formatSidwave(source), `sidwave: 1.2
title: "T"
tempo: 120
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  lead: {waveform: "saw", adsr: [0, 4, 10, 4]}
voices:
  - id: 1
    name: "Lead"
    instrument: "lead"
    patterns:
      A:
        groove:
          - {note: "C4", inst: "lead", len: 1}
          - "D4 ~ ~ ~"
        length: 0.25
sections:
  intro:
    bars: 1
    layers: {v1: "A"}
timeline: ["intro"]
`);
});

test("diff classifies instrument definition changes as synthesis", () => {
  const score = (instruments) => `sidwave: 1.2\ntitle: "T"\ntempo: 120\n${instruments}voices:\n  - id: 1\n    patterns:\n      A: {groove: "C4 ~ ~ ~", length: 1}\nsections:\n  s: {bars: 1, layers: {v1: "A"}}\ntimeline: ["s"]\n`;
  const plain = score(""), lead = score(`instruments:\n  lead: {waveform: "saw", portamento: 2}\n`), slow = score(`instruments:\n  lead: {waveform: "saw", portamento: 5}\n`);
  assert.deepEqual(diffSidwave(plain, lead).changes, [{ class: "synthesis", path: "/instruments", after: { lead: { waveform: "saw", portamento: 2 } }, summary: "/instruments changed" }]);
  assert.deepEqual(diffSidwave(lead, slow).changes, [{ class: "synthesis", path: "/instruments/lead/portamento", before: 2, after: 5, summary: "/instruments/lead/portamento changed" }]);
});
