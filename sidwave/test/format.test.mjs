import test from "#test/runner";
import assert from "#test/assert";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { formatSidwave, diffSidwave, mergeSidwave } from "../src/format/sidwaveFormat.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const exampleDir = join(root, "data/sound/examples");
const fixtureDir = join(root, "test/fixtures");
const minimal = (patch = {}) => ({ sidwave: "1.0", title: "Test", tempo: 100, voices: [{ id: 1, patterns: { A: { groove: ["C3", "D3"] } } }], timeline: [{ bars: 1, layers: { v1: "A" } }], ...patch });
const yaml = (o) => import("yaml").then(({ default: Y }) => Y.stringify(o));

const exampleFiles = (await readdir(exampleDir)).filter((f) => f.endsWith(".yaml")).sort();
const fixtureFiles = await (async function walk(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await walk(p)); else if (p.endsWith(".yaml")) out.push(p); } return out; })(fixtureDir);

test("the bundled example directory holds the 14 scores the formatter tests cover", () => {
  assert.equal(exampleFiles.length, 14);
});

for (const name of exampleFiles) {
  test(`formatter is idempotent and keeps parser and PRG output for ${name}`, { timeout: 120000 }, async () => {
    const source = await readFile(join(exampleDir, name), "utf8"), formatted = formatSidwave(source);
    assert.equal(formatSidwave(formatted), formatted);
    assert.deepEqual(parseSidwave(formatted), parseSidwave(source));
    assert.deepEqual(compileSidwaveToPrg(parseSidwave(formatted), { loop: false }).prg, compileSidwaveToPrg(parseSidwave(source), { loop: false }).prg);
  });
}

test("formatter is idempotent and keeps parser and PRG output for the compatibility fixtures", { timeout: 120000 }, async () => {
  assert.ok(fixtureFiles.length > 0);
  for (const file of fixtureFiles) {
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

test("three-way merge joins edits to different entries of the same list", () => {
  const base = `sidwave: 1.2\ntitle: "T"\ntempo: 120\nvoices:\n  - id: 1\n    waveform: "pulse"\n    patterns:\n      A: {groove: "C4 ~ ~ ~", length: 1}\n  - id: 2\n    waveform: "saw"\n    patterns:\n      A: {groove: "C3 ~ ~ ~", length: 1}\nsections:\n  s: {bars: 1, layers: {v1: "A", v2: "A"}}\ntimeline: ["s"]\n`;
  const ours = base.replace('"pulse"', '"triangle"');
  const theirs = base.replace('"C4 ~ ~ ~"', '"D4 ~ ~ ~"').replace('"saw"', '"noise"');
  const merged = mergeSidwave(base, ours, theirs);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.merged, `sidwave: 1.2
title: "T"
tempo: 120
voices:
  - id: 1
    waveform: "triangle"
    patterns:
      A:
        groove: "D4 ~ ~ ~"
        length: 1
  - id: 2
    waveform: "noise"
    patterns:
      A:
        groove: "C3 ~ ~ ~"
        length: 1
sections:
  s:
    bars: 1
    layers:
      v1: "A"
      v2: "A"
timeline: ["s"]
`);
});

test("formatter keeps a file header comment at the top when keys are sorted", () => {
  const source = `# Header comment

# Comment on tempo
tempo: 120 # beats per minute
title: T
sidwave: 1.2
`;
  const formatted = formatSidwave(source);
  assert.equal(formatted, `# Header comment

sidwave: 1.2
title: "T"
# Comment on tempo
tempo: 120 # beats per minute
`);
  assert.equal(formatSidwave(formatted), formatted);
});

test("formatter writes canonical quoting, flow lists and indentation and keeps comments", () => {
  const source = `# Header comment, kept first

# Second block of comment
tempo: 120 # beats per minute
title: 'It''s single quoted'
sidwave: 1.2
# note about voices
voices:
  - id: 1
    # inside voice
    patterns:
      A: {groove: [C4, D4, E4, F4, G4, A4, B4], length: 1}
    short: [x, y, z]
    block_short:
    - one
    - two
    block_seven:
    - a
    - b
    - c
    - d
    - e
    - f
    - g
    block_long:
    - aaaaaaaaaaaaaaaaaaaaaaaa
    - bbbbbbbbbbbbbbbbbbbbbbbbbb
    - cccccccccccccccccccccccccc
    nested: [[1, 2], [3, 4]]
    mixed: [1, "two", 3.5, true, null]
    empty: []
    text: |
      multi
      line
`;
  assert.equal(formatSidwave(source), `# Header comment, kept first

sidwave: 1.2
title: "It's single quoted"
# Second block of comment
tempo: 120 # beats per minute
# note about voices
voices:
  - id: 1
    # inside voice
    patterns:
      A: {groove: ["C4", "D4", "E4", "F4", "G4", "A4", "B4"], length: 1}
    short: ["x", "y", "z"]
    block_short: ["one", "two"]
    block_seven:
      - "a"
      - "b"
      - "c"
      - "d"
      - "e"
      - "f"
      - "g"
    block_long:
      - "aaaaaaaaaaaaaaaaaaaaaaaa"
      - "bbbbbbbbbbbbbbbbbbbbbbbbbb"
      - "cccccccccccccccccccccccccc"
    nested: [[1, 2], [3, 4]]
    mixed: [1, "two", 3.5, true, null]
    empty: []
    text: "multi\\nline\\n"
`);
});

test("formatter rejects text that is not valid YAML", () => {
  assert.throws(() => formatSidwave("a: ["), (e) => e.name === "YAMLParseError" && e.code === "BAD_INDENT");
});

test("formatter orders the top-level keys and the song, sid and fx keys", () => {
  const source = `timeline: ["s"]
sids:
  - {pan: "Left 4", id: sid1}
song: {global_fx: {vibrato: {depth: 1}}, tempo: 100, title: T}
global_fx: {filter_mod: {x: 1}, vibrato: {y: 2}}
unknown: 1
tempo: 100
`;
  assert.equal(formatSidwave(source), `song: {title: "T", tempo: 100, global_fx: {vibrato: {depth: 1}}}
tempo: 100
sids:
  - {id: "sid1", pan: "Left 4"}
global_fx: {vibrato: {y: 2}, filter_mod: {x: 1}}
timeline: ["s"]
unknown: 1
`);
});

const diffBase = `sidwave: 1.2
title: "Test"
tempo: 120
mode: "PAL"
voices:
  - id: 1
    waveform: "pulse"
    patterns:
      A: {groove: "C4 ~ ~ ~", length: 1}
sections:
  s: {bars: 1, layers: {v1: "A"}}
timeline: ["s"]
`;
const change = (path, before, after, cls) => ({ class: cls, path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), summary: `${path} changed` });

test("diff reports each change class with exact paths and values", () => {
  const cases = [
    ["musical note", diffBase.replace("C4 ~ ~ ~", "D4 ~ ~ ~"), [change("/voices/0/patterns/A/groove", "C4 ~ ~ ~", "D4 ~ ~ ~", "musical")], false],
    ["musical tempo", diffBase.replace("tempo: 120", "tempo: 100"), [change("/tempo", 120, 100, "musical")], false],
    ["musical timeline", diffBase.replace('["s"]', '["s", "s"]'), [change("/timeline", ["s"], ["s", "s"], "musical")], false],
    ["musical section", diffBase.replace("bars: 1", "bars: 2"), [change("/sections/s/bars", 1, 2, "musical")], false],
    ["synthesis waveform", diffBase.replace("pulse", "triangle"), [change("/voices/0/waveform", "pulse", "triangle", "synthesis")], false],
    ["hardware mode", diffBase.replace("PAL", "NTSC"), [change("/mode", "PAL", "NTSC", "hardware")], false],
    ["hardware sids added", diffBase.replace("mode:", 'sids: [{id: "sid1", address: "$D400", model: "6581"}]\nmode:'), [change("/sids", undefined, [{ id: "sid1", address: "$D400", model: "6581" }], "hardware")], true],
    ["structural title", diffBase.replace("Test", "Other"), [change("/title", "Test", "Other", "structural")], true],
    ["structural key added", `${diffBase}author: "Me"\n`, [change("/author", undefined, "Me", "structural")], true],
    ["structural key removed", diffBase.replace('title: "Test"\n', ""), [change("/title", "Test", undefined, "structural")], true],
  ];
  for (const [name, after, expected, compiledEqual] of cases) {
    const diff = diffSidwave(diffBase, after);
    assert.deepEqual(diff.changes, expected, name);
    assert.equal(diff.compiledEqual, compiledEqual, name);
  }
});

test("diff lists several changes in key order and compares lists of different length as one value", () => {
  const after = diffBase.replace("Test", "X").replace("PAL", "NTSC").replace("pulse", "saw").replace("C4 ~ ~ ~", "E4 ~ ~ ~");
  assert.deepEqual(diffSidwave(diffBase, after).changes.map((c) => [c.class, c.path]), [
    ["structural", "/title"], ["hardware", "/mode"], ["synthesis", "/voices/0/waveform"], ["musical", "/voices/0/patterns/A/groove"],
  ]);
  const longer = diffBase.replace('["s"]', '["s", "s"]');
  assert.deepEqual(diffSidwave(diffBase, longer).changes, [change("/timeline", ["s"], ["s", "s"], "musical")]);
});

test("diff escapes ~ and / in key names in paths", () => {
  const a = `sidwave: 1.2\ninstruments:\n  "a/b~c": {waveform: "saw"}\n`;
  const b = `sidwave: 1.2\ninstruments:\n  "a/b~c": {waveform: "pulse"}\n`;
  assert.deepEqual(diffSidwave(a, b).changes, [change("/instruments/a~1b~0c/waveform", "saw", "pulse", "synthesis")]);
});

test("diff of identical text has no changes and equal compiled output", () => {
  assert.deepEqual(diffSidwave(diffBase, diffBase), { changes: [], compiledEqual: true });
});

test("diff reports text that differs only in layout as a formatting change with equal output", () => {
  assert.equal(formatSidwave(diffBase), diffBase);
  for (const reformatted of [diffBase.replace('title: "Test"', "title:   Test   # note"), diffBase.replace('sidwave: 1.2\ntitle: "Test"', 'title: "Test"\nsidwave: 1.2')]) {
    assert.deepEqual(diffSidwave(diffBase, reformatted), { changes: [{ class: "formatting", path: "", summary: "YAML formatting changed" }], compiledEqual: true });
  }
});

test("diff reports compiledEqual false when either score does not compile", () => {
  const broken = "sidwave: 1.2\n";
  const diff = diffSidwave(diffBase, broken);
  assert.equal(diff.compiledEqual, false);
  assert.deepEqual(diff.changes.map((c) => [c.class, c.path]), [
    ["structural", "/title"], ["musical", "/tempo"], ["hardware", "/mode"], ["structural", "/voices"], ["musical", "/sections"], ["musical", "/timeline"],
  ]);
  assert.deepEqual(diffSidwave(broken, broken), { changes: [], compiledEqual: false });
});

const mergeBase = diffBase;
const edited = (a, b) => mergeBase.replace(a, b);

test("merge joins edits to different keys and returns canonical text", () => {
  const result = mergeSidwave(mergeBase, edited("Test", "Ours"), edited("tempo: 120", "tempo: 110"));
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged, `sidwave: 1.2
title: "Ours"
tempo: 110
mode: "PAL"
voices:
  - id: 1
    waveform: "pulse"
    patterns:
      A:
        groove: "C4 ~ ~ ~"
        length: 1
sections:
  s:
    bars: 1
    layers:
      v1: "A"
timeline: ["s"]
`);
  assert.deepEqual(compileSidwaveToPrg(parseSidwave(result.merged), { loop: false }).prg.length > 0, true);
});

test("merge takes the changed side when only one side edits", () => {
  const ours = edited("tempo: 120", "tempo: 90");
  for (const [o, t] of [[ours, mergeBase], [mergeBase, ours], [ours, ours]]) {
    const result = mergeSidwave(mergeBase, o, t);
    assert.deepEqual(result.conflicts, []);
    assert.equal(YAML.parse(result.merged).tempo, 90);
  }
  const unchanged = mergeSidwave(mergeBase, mergeBase, mergeBase);
  assert.deepEqual(unchanged.conflicts, []);
  assert.deepEqual(YAML.parse(unchanged.merged), YAML.parse(mergeBase));
});

test("merge reports a conflict when both sides change the same value differently", () => {
  assert.deepEqual(mergeSidwave(mergeBase, edited("tempo: 120", "tempo: 110"), edited("tempo: 120", "tempo: 130")), {
    conflicts: [{ path: "/tempo", base: 120, ours: 110, theirs: 130, summary: "Concurrent edits at /tempo" }],
  });
  const noteConflict = mergeSidwave(mergeBase, edited("C4 ~ ~ ~", "D4 ~ ~ ~"), edited("C4 ~ ~ ~", "E4 ~ ~ ~"));
  assert.deepEqual(noteConflict, {
    conflicts: [{ path: "/voices/0/patterns/A/groove", base: "C4 ~ ~ ~", ours: "D4 ~ ~ ~", theirs: "E4 ~ ~ ~", summary: "Concurrent edits at /voices/0/patterns/A/groove" }],
  });
});

test("merge reports every conflicting path", () => {
  const ours = edited("tempo: 120", "tempo: 110").replace("Test", "A");
  const theirs = edited("tempo: 120", "tempo: 130").replace("Test", "B");
  assert.deepEqual(mergeSidwave(mergeBase, ours, theirs).conflicts.map((c) => c.path), ["/title", "/tempo"]);
});

test("merge treats delete against modify as a conflict and delete against delete as a deletion", () => {
  const withAuthor = `${mergeBase}author: "Me"\n`;
  const deleted = mergeBase, modified = `${mergeBase}author: "You"\n`;
  assert.deepEqual(mergeSidwave(withAuthor, deleted, modified), { conflicts: [{ path: "/author", base: "Me", theirs: "You", summary: "Concurrent edits at /author" }] });
  assert.deepEqual(mergeSidwave(withAuthor, modified, deleted), { conflicts: [{ path: "/author", base: "Me", ours: "You", summary: "Concurrent edits at /author" }] });
  const both = mergeSidwave(withAuthor, deleted, deleted);
  assert.deepEqual(both.conflicts, []);
  assert.equal(YAML.parse(both.merged).author, undefined);
  const oneDeletes = mergeSidwave(withAuthor, deleted, withAuthor);
  assert.equal(YAML.parse(oneDeletes.merged).author, undefined);
});

test("merge treats two different additions of one key as a conflict and different keys as a join", () => {
  assert.deepEqual(mergeSidwave(mergeBase, `${mergeBase}author: "A"\n`, `${mergeBase}author: "B"\n`), { conflicts: [{ path: "/author", ours: "A", theirs: "B", summary: "Concurrent edits at /author" }] });
  const joined = mergeSidwave(mergeBase, `${mergeBase}author: "A"\n`, edited("mode: \"PAL\"", 'mode: "NTSC"'));
  assert.deepEqual([YAML.parse(joined.merged).author, YAML.parse(joined.merged).mode], ["A", "NTSC"]);
});

test("merge treats lists of different length changed on both sides as a conflict", () => {
  const ours = edited('["s"]', '["s", "s"]'), theirs = edited('["s"]', '["s", "s", "s"]');
  assert.deepEqual(mergeSidwave(mergeBase, ours, theirs), { conflicts: [{ path: "/timeline", base: ["s"], ours: ["s", "s"], theirs: ["s", "s", "s"], summary: "Concurrent edits at /timeline" }] });
});

test("merge reports a conflict when the merged score is not valid SIDWave", () => {
  const withoutVoices = mergeBase.replace(/voices:[\s\S]*?sections:/, "sections:");
  const result = mergeSidwave(mergeBase, withoutVoices, edited("Test", "Theirs"));
  assert.deepEqual(result, { conflicts: [{ path: "", summary: "Invalid SIDWAVE at $.voices: missing voices (expected a list of 1 to 30 voices)" }] });
});

test("merge throws on text that is not valid YAML", () => {
  assert.throws(() => mergeSidwave(mergeBase, "a: [", mergeBase));
});

test("README example: format, diff and merge", () => {
  const base = formatSidwave(`title: Demo
sidwave: 1.2
tempo: 120
voices:
  - id: 1
    patterns:
      A: { groove: "C4 ~ ~ ~", length: 1 }
timeline: [{ bars: 1, layers: { v1: A } }]
`);
  assert.equal(base, `sidwave: 1.2
title: "Demo"
tempo: 120
voices:
  - id: 1
    patterns:
      A: {groove: "C4 ~ ~ ~", length: 1}
timeline: [{bars: 1, layers: {v1: "A"}}]
`);
  const ours = base.replace("Demo", "Demo tune"), theirs = base.replace("C4", "D4");
  assert.deepEqual(diffSidwave(base, theirs).changes, [{ class: "musical", path: "/voices/0/patterns/A/groove", before: "C4 ~ ~ ~", after: "D4 ~ ~ ~", summary: "/voices/0/patterns/A/groove changed" }]);
  const merged = YAML.parse(mergeSidwave(base, ours, theirs).merged);
  assert.deepEqual([merged.title, merged.voices[0].patterns.A.groove], ["Demo tune", "D4 ~ ~ ~"]);
  assert.deepEqual(mergeSidwave(base, base.replace("C4", "E4"), theirs).conflicts, [{ path: "/voices/0/patterns/A/groove", base: "C4 ~ ~ ~", ours: "E4 ~ ~ ~", theirs: "D4 ~ ~ ~", summary: "Concurrent edits at /voices/0/patterns/A/groove" }]);
});

test("diff classifies by schema position, not by key names found at any depth", () => {
  const classOf = (a, b) => diffSidwave(a, b).changes.map((c) => [c.class, c.path]);
  // User chosen names that equal schema keys.
  assert.deepEqual(classOf("instruments:\n  sid: {note: 1}\n", "instruments:\n  sid: {note: 2}\n"), [["synthesis", "/instruments/sid/note"]]);
  assert.deepEqual(classOf("instruments:\n  timeline: {x: 1}\n", "instruments:\n  timeline: {x: 2}\n"), [["synthesis", "/instruments/timeline/x"]]);
  assert.deepEqual(classOf("sections:\n  mode: {x: 1}\n", "sections:\n  mode: {x: 2}\n"), [["musical", "/sections/mode/x"]]);
  assert.deepEqual(classOf("sections:\n  sids: {bars: 1}\n", "sections:\n  sids: {bars: 2}\n"), [["musical", "/sections/sids/bars"]]);
  assert.deepEqual(classOf("voices:\n  - id: 1\n    patterns:\n      mode: {groove: C4}\n", "voices:\n  - id: 1\n    patterns:\n      mode: {groove: D4}\n"), [["musical", "/voices/0/patterns/mode/groove"]]);
  // Hardware keys at their real position.
  assert.deepEqual(classOf("mode: PAL\n", "mode: NTSC\n"), [["hardware", "/mode"]]);
  assert.deepEqual(classOf("voices:\n  - {id: 1, sid: 1}\n", "voices:\n  - {id: 1, sid: 2}\n"), [["hardware", "/voices/0/sid"]]);
  // Effects and instrument choices are decided before the pattern rule.
  const pattern = (body) => `voices:\n  - id: 1\n    patterns:\n      A:\n${body}\n`;
  assert.deepEqual(classOf(pattern("        fx: {vibrato: {depth: 1}}"), pattern("        fx: {vibrato: {depth: 2}}")), [["synthesis", "/voices/0/patterns/A/fx/vibrato/depth"]]);
  assert.deepEqual(classOf(pattern("        groove:\n          - {note: C4, inst: a}"), pattern("        groove:\n          - {note: C4, inst: b}")), [["synthesis", "/voices/0/patterns/A/groove/0/inst"]]);
  assert.deepEqual(classOf(pattern("        groove:\n          - {note: C4, inst: a}"), pattern("        groove:\n          - {note: D4, inst: a}")), [["musical", "/voices/0/patterns/A/groove/0/note"]]);
  // Samples and kit are sound definitions.
  assert.deepEqual(classOf("samples: {defs: {a: 1}}\n", "samples: {defs: {a: 2}}\n"), [["synthesis", "/samples/defs/a"]]);
  assert.deepEqual(classOf("kit: {k: 1}\n", "kit: {k: 2}\n"), [["synthesis", "/kit/k"]]);
});
