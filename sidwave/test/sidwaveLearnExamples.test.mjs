// The graded example scores for human authors (data/sound/examples/learn) and the tutorial that walks through them.
// They are kept apart from the showpiece examples, whose count and recorded hashes other tests pin.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidFile } from "../src/sidFile.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveBytes, confinedReadOptions, lintSidwave } from "../src/sidwaveOps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const learnDir = path.join(root, "data", "sound", "examples", "learn");
const lessons = fs.readdirSync(learnDir).filter((f) => /^\d\d_.*\.yaml$/.test(f)).sort();

function load(file) {
  const full = path.join(learnDir, file);
  return parseSidwave(fs.readFileSync(full, "utf8"), confinedReadOptions(learnDir, [], full));
}

test("there are eight lessons, numbered 01 to 08, and the showpiece directory is unchanged", () => {
  assert.deepEqual(lessons.map((f) => f.slice(0, 2)), ["01", "02", "03", "04", "05", "06", "07", "08"]);
  const main = fs.readdirSync(path.join(root, "data", "sound", "examples"), { withFileTypes: true });
  assert.equal(main.filter((e) => e.isFile()).length, 15, "the main directory keeps its 15 scores");
  assert.deepEqual(main.filter((e) => e.isDirectory()).map((e) => e.name), ["learn"]);
});

for (const file of lessons) {
  test(`${file} is under 120 lines, explains itself, compiles to PRG and PSID and has no lint findings`, () => {
    const text = fs.readFileSync(path.join(learnDir, file), "utf8");
    assert.ok(text.split("\n").length <= 120, "under 120 lines");
    const header = text.split("\n").filter((l, i, all) => l.startsWith("#") && all.slice(0, i).every((p) => p.startsWith("#"))).join("\n");
    assert.match(header, /^# Lesson \d: /, "starts with the lesson title");
    assert.match(header, /Concepts?: /, "names the concepts");
    assert.match(header, /Try this: /, "suggests a change to try");
    assert.ok(header.split(/\s+/).length > 60, "the header explains the lesson");
    const doc = load(file);
    assert.equal(doc.version, "1.4");
    const prg = compileSidwaveBytes(doc, { format: "prg" });
    assert.ok(prg.bytes.length > 1000 && prg.summary.durationSeconds > 3);
    const sid = compileSidwaveBytes(doc, { format: "sid" });
    assert.equal(parseSidFile(sid.bytes).magic, "PSID");
    const lint = lintSidwave(doc);
    assert.deepEqual(lint.findings.filter((f) => f.code !== "TEMPO-GRID").map((f) => f.code), [], lint.formatted.join("\n"));
  });
}

test("lesson 3 uses its library, lesson 7 has two songs and an effect, lesson 8 has two SIDs and an echo", () => {
  const three = load("03_drums_from_a_library.yaml");
  assert.deepEqual(three.libraries.map((l) => [l.namespace, l.name, l.licence]), [["kit", "learn-chip-kit", "CC0-1.0"]]);
  assert.ok(Object.keys(three.instruments).includes("kit.kick"));
  const pinned = /sha256: ([0-9a-f]{64})/.exec(fs.readFileSync(path.join(learnDir, "03_drums_from_a_library.yaml"), "utf8"));
  assert.ok(pinned, "lesson 3 pins its library with sha256");
  assert.equal(pinned[1], three.libraries[0].sha256, "the pin is the current hash of the library");
  const seven = load("07_songs_and_effects.yaml");
  assert.equal(seven.songs.length, 2);
  assert.equal(seven.songs[1].loopTo, undefined, "the jingle plays once");
  assert.equal(seven.effects.length, 1);
  const eight = load("08_two_sids_and_echo.yaml");
  assert.equal(eight.sids.length, 2);
  assert.ok(compileSidwaveBytes(eight).summary.sidCount === 2);
  const one = load("01_one_voice.yaml");
  assert.equal(one.voices.length, 1);
  assert.equal(load("02_bass_and_melody.yaml").voices.length, 2);
});

test("the lesson library has the metadata that a library needs", () => {
  const text = fs.readFileSync(path.join(learnDir, "libs", "chip_kit.yaml"), "utf8");
  for (const field of ["name: learn-chip-kit", "version: 1.0.0", "licence: CC0-1.0", "provenance:"]) assert.ok(text.includes(field), field);
});

test("the tutorial names every lesson in order, and each code block is an excerpt of the file it follows", () => {
  const tutorial = fs.readFileSync(path.join(root, "doc", "tutorial.md"), "utf8");
  const sections = tutorial.split(/^## /m).slice(1).filter((s) => /^\d\. /.test(s));
  assert.equal(sections.length, 8);
  let blocks = 0;
  sections.forEach((section, i) => {
    const named = /File: `data\/sound\/examples\/learn\/([^`]+\.yaml)`/.exec(section);
    assert.ok(named, `lesson ${i + 1} names its file`);
    assert.equal(named[1], lessons[i], `lesson ${i + 1} is ${lessons[i]}`);
    const source = fs.readFileSync(path.join(learnDir, named[1]), "utf8");
    for (const [, block] of section.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      assert.ok(source.includes(block), `the code block in lesson ${i + 1} is not a verbatim excerpt of ${named[1]}:\n${block}`);
      blocks++;
    }
  });
  assert.ok(blocks >= 8);
});

test("the tutorial links point at files and headings that exist", () => {
  const tutorial = fs.readFileSync(path.join(root, "doc", "tutorial.md"), "utf8");
  const slug = (heading) => heading.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  const headings = (file) => [...fs.readFileSync(file, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]));
  let links = 0;
  for (const m of tutorial.matchAll(/\]\((\.\.\/[^)#]+)(?:#([^)]+))?\)/g)) {
    const file = path.join(root, "doc", m[1]);
    assert.ok(fs.existsSync(file), m[1]);
    if (m[2]) assert.ok(headings(file).includes(m[2]), `${m[1]}#${m[2]} exists`);
    links++;
  }
  assert.ok(links >= 10);
});
