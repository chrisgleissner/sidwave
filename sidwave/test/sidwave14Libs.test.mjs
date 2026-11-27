// SIDWave 1.4 asset libraries: namespaces, pins, confinement, lock and bundle. A score that uses a library compiles to
// the bytes of the equivalent flattened score; a score without imports is unchanged.
import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import YAML from "yaml";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { SIDWAVE_SCORE_RESOURCES, readSidwaveExample } from "../src/sidwaveExamples.js";
import { compileSidwaveBytes, confinedReadOptions } from "../src/sidwaveOps.js";
import { SIDWAVE_LIBRARY_LIMITS, bundleScore, canonicalLibraryHash, libraryClosure, lockScore, readImportEntries, satisfiesVersion } from "../src/sidwaveLibs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "projects", "sidwave-libs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A fresh copy of the fixture project (its `pkgs` directory becomes `node_modules`, which git ignores). */
function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-libs-")));
  fs.cpSync(fixture, dir, { recursive: true });
  fs.renameSync(path.join(dir, "pkgs"), path.join(dir, "node_modules"));
  return { dir, score: path.join(dir, "score.yaml"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function parseFile(file, allowedDirs = []) {
  return parseSidwave(fs.readFileSync(file, "utf8"), confinedReadOptions(path.dirname(file), allowedDirs, file));
}

function expectError(fn, pattern) {
  assert.throws(fn, (error) => { assert.match(error.message, pattern); return true; });
}

function withProject(fn) {
  const p = project();
  try { return fn(p); } finally { p.done(); }
}

function writeLib(dir, file, { name = "lib", version = "1.0.0", imports = "", body = "" } = {}) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `sidwave: 1.4\nlibrary:\n  name: ${name}\n  version: ${version}\n  licence: CC0-1.0\n  provenance: { author: t, source: original, created: 2026-11-27 }\n${imports}${body}`);
}

const SCORE_HEAD = "sidwave: 1.4\ntitle: T\ntempo: 120\nmode: PAL\nsids:\n  - { id: sid1, address: \"$D400\", model: \"8580\" }\n";
const SCORE_TAIL = "voices:\n  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: \"C4 E4 G4 E4\" } } }\ninstruments:\n  lead: { waveform: pulse, adsr: [0, 5, 10, 4], pulse_width: 0.4 }\ntimeline: [{ bars: 1, layers: { v1: a } }]\n";
const scoreWith = (imports) => `${SCORE_HEAD}imports:\n${imports}\n${SCORE_TAIL}`;

// ---------------------------------------------------------------------------
// Resolution

test("a score resolves library instruments, patterns and effects under their namespaces and reports the libraries", () => {
  withProject(({ score }) => {
    const doc = parseFile(score);
    assert.deepEqual(Object.keys(doc.instruments), ["lead", "drums.snare", "drums.base.kick", "drums.base.hat", "pads.pad"]);
    assert.deepEqual(doc.effects.map((e) => e.name), ["drums_pew"]);
    assert.deepEqual(doc.libraries.map((l) => [l.namespace, l.name, l.version, l.licence]), [
      ["drums", "fixture-drums", "1.2.0", "MIT OR Apache-2.0"],
      ["drums.base", "fixture-base", "1.0.2", "CC0-1.0"],
      ["pads", "sidwave-lib-pad", "0.3.1", "CC-BY-4.0"],
    ]);
    for (const l of doc.libraries) assert.match(l.sha256, /^[0-9a-f]{64}$/);
    const compiled = compileSidwaveBytes(doc);
    assert.deepEqual(compiled.summary.libraries, doc.libraries);
    assert.equal(compiled.summary.effects.length, 1);
  });
});

test("a score with imports compiles to the bytes of the flattened score", () => {
  withProject(({ score }) => {
    const imported = compileSidwaveBytes(parseFile(score), { format: "sid" }).bytes;
    const flat = `${SCORE_HEAD.replace("title: T", "title: Library Fixture")}instruments:
  lead: { waveform: pulse, adsr: [0, 5, 10, 4], pulse_width: 0.4 }
  drums.snare: { waveform: noise, adsr: [0, 6, 0, 0], wavetable: [{ wave: noise, note: C6 }, { gate: false }] }
  drums.base.kick: { waveform: pulse, adsr: [0, 8, 0, 0], wavetable: [{ wave: noise, note: A6 }, { wave: pulse, note: A3, slide_to: D2, frames: 3 }, { gate: false }] }
  drums.base.hat: { waveform: noise, adsr: [0, 4, 0, 0], wavetable: [{ wave: noise, note: G7 }, { gate: false }] }
  pads.pad: { waveform: triangle, adsr: [6, 8, 12, 8] }
voices:
  - { id: 1, name: Lead, instrument: lead, patterns: { tune: { length: 1, bars: 1, groove: "C4 E4 G4 E4" } } }
  - { id: 2, name: Pad, instrument: pads.pad, patterns: { hold: { length: 4, bars: 1, groove: "C3" } } }
  - id: 3
    name: Drums
    patterns:
      drums.beat: { length: 0.5, bars: 1, drums: { kit: { k: drums.base.kick, h: drums.base.hat, s: drums.snare }, steps: "k.h. s.h." } }
      drums.rock: { length: 0.5, bars: 1, groove: "C2@drums.base.kick C2@drums.base.hat C2@drums.snare C2@drums.base.hat C2@drums.base.kick C2@drums.base.hat C2@drums.snare C2@drums.base.hat" }
sections:
  a: { bars: 2, layers: { v1: tune, v2: hold, v3: drums.beat } }
  b: { bars: 2, layers: { v1: tune, v2: hold, v3: drums.rock } }
timeline: [a, b]
effects:
  drums_pew:
    priority: 8
    voices: [3]
    steps:
      - { freq: 2400, wave: pulse, pulse: 0.25, adsr: [0, 0, 15, 6] }
      - { freq: 900, wait: 2 }
      - { gate: false, wait: 3 }
`;
    const flattened = compileSidwaveBytes(parseSidwave(flat), { format: "sid" }).bytes;
    assert.ok(imported.equals(flattened));
  });
});

test("only the library items a score refers to are included, and an unused library is not reported", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/big.yaml", { name: "big", body: "instruments:\n  a: { waveform: pulse, adsr: [0, 5, 10, 4] }\n  b: { waveform: noise, adsr: [0, 5, 0, 0] }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: big, from: ./libs/big.yaml }"));
    const plain = parseFile(file);
    assert.deepEqual(Object.keys(plain.instruments), ["lead"]);
    assert.equal(plain.libraries, undefined);
    assert.equal(compileSidwaveBytes(plain).summary.libraries, undefined);
    fs.writeFileSync(file, scoreWith("  - { as: big, from: ./libs/big.yaml }").replace("instrument: lead", "instrument: big.b"));
    const used = parseFile(file);
    assert.deepEqual(Object.keys(used.instruments), ["lead", "big.b"]);
    assert.deepEqual(used.libraries.map((l) => l.name), ["big"]);
  });
});

test("built-in lib: instruments keep working in a score that imports libraries", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/x.yaml", { body: "instruments:\n  x: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: x, from: ./libs/x.yaml }").replace("instrument: lead", "instrument: lib:bass_pluck"));
    assert.ok(compileSidwaveBytes(parseFile(file)).bytes.length > 0);
  });
});

test("effects are included only when the import lists them, and an unknown effect is an error", () => {
  withProject(({ dir, score }) => {
    assert.equal(parseFile(score).effects.length, 1);
    const text = fs.readFileSync(score, "utf8");
    fs.writeFileSync(score, text.replace(", effects: [pew]", ""));
    assert.equal(parseFile(score).effects, undefined);
    fs.writeFileSync(score, text.replace("effects: [pew]", "effects: [nope]"));
    expectError(() => parseFile(score), /\$\.imports\[0\]\.effects.*no effect nope/);
    void dir;
  });
});

test("name collisions are errors that name the path", () => {
  withProject(({ dir, score }) => {
    const text = fs.readFileSync(score, "utf8");
    fs.writeFileSync(score, text.replace("lead: {", "drums.snare: { waveform: noise }\n  lead: {"));
    expectError(() => parseFile(score), /\$\.instruments\.drums\.snare.*collides/);
    fs.writeFileSync(score, text.replace("- { id: 3, name: Drums }", "- { id: 3, name: Drums, patterns: { drums.beat: { length: 1, bars: 1, groove: \"C2 C2 C2 C2\" } } }"));
    expectError(() => parseFile(score), /\$\.voices\[2\]\.patterns\.drums\.beat.*collides/);
    fs.writeFileSync(score, text.replace("timeline: [a, b]", "timeline: [a, b]\neffects:\n  drums_pew: { priority: 1, steps: [{ freq: 100 }] }"));
    expectError(() => parseFile(score), /\$\.effects\.drums_pew.*collides/);
    fs.writeFileSync(score, text.replace("as: pads", "as: drums"));
    expectError(() => parseFile(score), /\$\.imports\[1\]\.as.*imported twice/);
    fs.writeFileSync(score, text.replace("as: pads", "as: lib"));
    expectError(() => parseFile(score), /\$\.imports\[1\]\.as.*reserved/);
    fs.writeFileSync(score, text.replace("as: pads", "as: \"bad name\""));
    expectError(() => parseFile(score), /\$\.imports\[1\]\.as/);
    void dir;
  });
});

test("the same library under two namespaces gives two independent copies", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/x.yaml", { body: "instruments:\n  x: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: p, from: ./libs/x.yaml }\n  - { as: q, from: ./libs/x.yaml }").replace("instrument: lead", "instrument: p.x").replace("timeline:", "timeline:").replace("v1: a", "v1: a"));
    const doc = parseFile(file);
    assert.deepEqual(Object.keys(doc.instruments), ["lead", "p.x"]);
    assert.equal(doc.libraries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Cycles, depth and size

test("an import cycle is an error that names the cycle", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/a.yaml", { name: "a", imports: "imports:\n  - { as: b, from: ./b.yaml }\n" });
    writeLib(dir, "libs/b.yaml", { name: "b", imports: "imports:\n  - { as: a, from: ./a.yaml }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: a, from: ./libs/a.yaml }"));
    expectError(() => parseFile(file), /import cycle: libs\/a\.yaml -> libs\/b\.yaml -> libs\/a\.yaml/);
    writeLib(dir, "libs/self.yaml", { name: "self", imports: "imports:\n  - { as: me, from: ./self.yaml }\n" });
    fs.writeFileSync(file, scoreWith("  - { as: s, from: ./libs/self.yaml }"));
    expectError(() => parseFile(file), /import cycle: libs\/self\.yaml -> libs\/self\.yaml/);
  });
});

function chain(dir, count) {
  for (let i = 1; i <= count; i++) {
    writeLib(dir, `libs/l${i}.yaml`, {
      name: `l${i}`,
      imports: i < count ? `imports:\n  - { as: n, from: ./l${i + 1}.yaml }\n` : "",
      body: i === count ? "instruments:\n  leaf: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" : "",
    });
  }
  const file = path.join(dir, "s.yaml");
  fs.writeFileSync(file, scoreWith("  - { as: top, from: ./libs/l1.yaml }"));
  return file;
}

test("the depth of nested imports is capped at 16", () => {
  withProject(({ dir }) => {
    assert.equal(SIDWAVE_LIBRARY_LIMITS.maxDepth, 16);
    assert.ok(parseFile(chain(dir, 16)).voices.length === 1);
    expectError(() => parseFile(chain(dir, 17)), /more than 16 levels deep/);
  });
});

test("a diamond of shared libraries resolves each file once", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/base.yaml", { name: "base", body: "instruments:\n  x: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
    writeLib(dir, "libs/left.yaml", { name: "left", imports: "imports:\n  - { as: base, from: ./base.yaml }\n" });
    writeLib(dir, "libs/right.yaml", { name: "right", imports: "imports:\n  - { as: base, from: ./base.yaml }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: l, from: ./libs/left.yaml }\n  - { as: r, from: ./libs/right.yaml }").replace("instrument: lead", "instrument: r.base.x"));
    assert.deepEqual(parseFile(file).libraries.map((l) => l.name), ["base"]);
    assert.equal(libraryClosure(file, readImportEntries([{ as: "l", from: "./libs/left.yaml" }, { as: "r", from: "./libs/right.yaml" }])).length, 3);
  });
});

test("library file size and file count are capped", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/huge.yaml", { name: "huge", body: `# ${"x".repeat(SIDWAVE_LIBRARY_LIMITS.maxFileBytes)}\n` });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: h, from: ./libs/huge.yaml }"));
    expectError(() => parseFile(file), /bytes; the limit is 262144/);
    const lines = [];
    for (let i = 0; i <= SIDWAVE_LIBRARY_LIMITS.maxFiles; i++) {
      writeLib(dir, `libs/m${i}.yaml`, { name: `m${i}` });
      lines.push(`  - { as: m${i}, from: ./libs/m${i}.yaml }`);
    }
    fs.writeFileSync(file, scoreWith(lines.join("\n")));
    expectError(() => parseFile(file), /at most 64 library files/);
  });
});

// ---------------------------------------------------------------------------
// Confinement

test("library paths cannot leave the score directory: ../, absolute paths, URLs and symlinks are refused", () => {
  withProject(({ dir }) => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-outside-")));
    try {
      writeLib(outside, "evil.yaml", { name: "evil", body: "instruments:\n  x: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
      const sub = path.join(dir, "scores");
      fs.mkdirSync(sub);
      const file = path.join(sub, "s.yaml");
      const attempt = (from) => { fs.writeFileSync(file, scoreWith(`  - { as: e, from: ${JSON.stringify(from)} }`)); return () => parseFile(file); };
      expectError(attempt(path.relative(sub, path.join(outside, "evil.yaml"))), /outside the score directory/);
      expectError(attempt("../libs/base.yaml"), /outside the score directory/);
      expectError(attempt(path.join(outside, "evil.yaml")), /absolute library paths/);
      expectError(attempt("/etc/passwd"), /absolute library paths/);
      expectError(attempt("C:\\evil.yaml"), /absolute library paths/);
      expectError(attempt("\\\\host\\share\\evil.yaml"), /absolute library paths/);
      expectError(attempt("https://example.invalid/evil.yaml"), /never fetches libraries from the network/);
      expectError(attempt("http://example.invalid/evil.yaml"), /URL/);
      expectError(attempt("file:///etc/passwd"), /URL/);
      expectError(attempt("//example.invalid/evil.yaml"), /URL/);
      expectError(attempt("./missing.yaml"), /cannot be read \(ENOENT\)/);
      // A symbolic link inside the tree that points outside.
      fs.symlinkSync(path.join(outside, "evil.yaml"), path.join(sub, "link.yaml"));
      expectError(attempt("./link.yaml"), /outside the score directory/);
      fs.symlinkSync(outside, path.join(sub, "dirlink"));
      expectError(attempt("./dirlink/evil.yaml"), /outside the score directory/);
      // The same file is accepted once its directory is on the library search path.
      fs.writeFileSync(file, scoreWith(`  - { as: e, from: ${JSON.stringify(path.relative(sub, path.join(outside, "evil.yaml")))} }`));
      assert.equal(parseFile(file, [outside]).voices.length, 1);
      // A library cannot reach outside either, even when the score is inside.
      writeLib(dir, "libs/sneaky.yaml", { name: "sneaky", imports: `imports:\n  - { as: e, from: ${JSON.stringify(path.relative(path.join(dir, "libs"), path.join(outside, "evil.yaml")))} }\n` });
      fs.writeFileSync(file, scoreWith("  - { as: s, from: ../libs/sneaky.yaml }"));
      expectError(() => parseFile(file), /outside the score directory/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("pkg: libraries resolve through node_modules inside the score directory only", () => {
  withProject(({ dir, score }) => {
    const text = fs.readFileSync(score, "utf8");
    for (const bad of ["pkg:sidwave-lib-pad", "pkg:sidwave-lib-pad/../pad.yaml", "pkg:Sidwave Lib/pad.yaml", "pkg:/pad.yaml", "pkg:sidwave-lib-pad//pad.yaml"]) {
      fs.writeFileSync(score, text.replace("pkg:sidwave-lib-pad/pad.yaml", bad));
      expectError(() => parseFile(score), /must look like pkg:|was not found/);
    }
    fs.writeFileSync(score, text.replace("pkg:sidwave-lib-pad/pad.yaml", "pkg:sidwave-lib-pad/absent.yaml"));
    expectError(() => parseFile(score), /was not found in a node_modules directory/);
    // A package in node_modules of a parent directory is outside the score directory.
    const sub = path.join(dir, "nested");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "s.yaml"), scoreWith("  - { as: pads, from: \"pkg:sidwave-lib-pad/pad.yaml\" }"));
    expectError(() => parseFile(path.join(sub, "s.yaml")), /was not found in a node_modules directory/);
  });
});

test("a pkg: library whose node_modules entry is a link to outside is refused", () => {
  withProject(({ dir, score }) => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-pkg-")));
    try {
      writeLib(outside, "pad.yaml", { name: "evil", body: "instruments:\n  pad: { waveform: triangle, adsr: [6, 8, 12, 8] }\n" });
      fs.rmSync(path.join(dir, "node_modules", "sidwave-lib-pad"), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, "node_modules", "sidwave-lib-pad"));
      expectError(() => parseFile(score), /outside the score directory/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Pins

test("version ranges", () => {
  const yes = [["1.2.0", "^1.2.0"], ["1.9.9", "^1.2.0"], ["1.2.0", "1.2.0"], ["1.2.5", "~1.2.0"], ["0.3.1", "^0.3.0"], ["0.0.3", "^0.0.3"],
    ["2.0.0", ">=1.0.0"], ["1.2.3", "1"], ["1.2.3", "1.2"], ["1.2.3", "1.x"], ["9.9.9", "*"], ["1.5.0", ">=1.2.0 <2.0.0"], ["3.0.0", "^1.0.0 || ^3.0.0"], ["1.0.0", "<=1.0.0"], ["0.9.9", "<1.0.0"]];
  const no = [["1.1.9", "^1.2.0"], ["2.0.0", "^1.2.0"], ["1.3.0", "~1.2.0"], ["0.4.0", "^0.3.0"], ["0.0.4", "^0.0.3"], ["1.2.1", "1.2.0"], ["2.0.0", "1"],
    ["1.3.0", "1.2"], ["0.9.0", ">=1.0.0"], ["1.0.1", "<=1.0.0"], ["1.0.0", "<1.0.0"], ["2.0.0", ">=1.2.0 <2.0.0"], ["2.0.0", ">1.9.9 <2.0.0"]];
  for (const [v, r] of yes) assert.equal(satisfiesVersion(v, r), true, `${v} satisfies ${r}`);
  for (const [v, r] of no) assert.equal(satisfiesVersion(v, r), false, `${v} does not satisfy ${r}`);
  for (const bad of ["", "abc", "^1.2.3.4", "1.x.3", ">=", "1.2.3-beta"]) assert.throws(() => satisfiesVersion("1.0.0", bad), bad);
  assert.throws(() => satisfiesVersion("1.0", "^1.0.0"));
});

test("a version range that the library does not satisfy is an error naming both versions", () => {
  withProject(({ score }) => {
    const text = fs.readFileSync(score, "utf8");
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', 'version: "^2.0.0"'));
    expectError(() => parseFile(score), /\$\.imports\[0\]\.version: library fixture-drums \(libs\/drums\.yaml\) is version 1\.2\.0, which does not satisfy \^2\.0\.0/);
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', 'version: "nonsense"'));
    expectError(() => parseFile(score), /\$\.imports\[0\]\.version/);
    fs.writeFileSync(score, text);
    // A pin of a nested import is checked as well: drums.yaml needs fixture-base ^1.0.0.
    fs.writeFileSync(path.join(path.dirname(score), "libs", "base.yaml"), fs.readFileSync(path.join(path.dirname(score), "libs", "base.yaml"), "utf8").replace("1.0.2", "2.0.0"));
    expectError(() => parseFile(score), /fixture-base.*is version 2\.0\.0, which does not satisfy \^1\.0\.0/);
  });
});

test("a pinned hash must equal the hash of the canonical library text, and the error names both", () => {
  withProject(({ dir, score }) => {
    const real = parseFile(score).libraries[0].sha256;
    const wrong = "0".repeat(64);
    const text = fs.readFileSync(score, "utf8");
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', `version: "^1.2.0", sha256: "${real}"`));
    assert.equal(parseFile(score).libraries[0].sha256, real);
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', `version: "^1.2.0", sha256: "${real.toUpperCase()}"`));
    assert.equal(parseFile(score).libraries[0].sha256, real, "hexadecimal digits are case-insensitive");
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', `version: "^1.2.0", sha256: "${wrong}"`));
    expectError(() => parseFile(score), new RegExp(`\\$\\.imports\\[0\\]\\.sha256: library fixture-drums .* has sha256 ${real}, but the import pins ${wrong}`));
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', 'version: "^1.2.0", sha256: "abc"'));
    expectError(() => parseFile(score), /64 hexadecimal digits/);
    // Any change of the library content changes the hash; its location does not.
    fs.writeFileSync(score, text.replace('version: "^1.2.0"', `version: "^1.2.0", sha256: "${real}"`));
    const drums = path.join(dir, "libs", "drums.yaml");
    const original = fs.readFileSync(drums, "utf8");
    fs.writeFileSync(drums, original.replace("priority: 8", "priority: 9"));
    expectError(() => parseFile(score), /but the import pins/);
    fs.writeFileSync(drums, original.replace("./base.yaml", "../libs/base.yaml"));
    assert.equal(parseFile(score).libraries[0].sha256, real, "the from of an import is not part of the hash");
    fs.writeFileSync(drums, original.replace("{ author: SIDWave tests", "{   author:   SIDWave tests"));
    assert.equal(parseFile(score).libraries[0].sha256, real, "whitespace is canonicalised");
  });
});

test("a library file must be well formed: version, licence, provenance, allowed fields and no timeline", () => {
  withProject(({ dir }) => {
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: x, from: ./libs/x.yaml }"));
    const base = (extra = "") => `sidwave: 1.4\nlibrary:\n  name: x\n  version: 1.0.0\n  licence: CC0-1.0\n  provenance: { author: a, source: s, created: 2026-11-27 }\n${extra}`;
    const cases = [
      [base("timeline: []\n"), /\$\.timeline.*not allowed in a library/],
      [base("voices: []\n"), /\$\.voices.*not allowed/],
      [base().replace("sidwave: 1.4", "sidwave: 1.3"), /requires sidwave: 1\.4/],
      [base().replace("version: 1.0.0", "version: 1.0"), /\$\.library\.version/],
      [base().replace("version: 1.0.0", "version: v1.0.0"), /\$\.library\.version/],
      [base().replace("licence: CC0-1.0", "licence: not a licence!"), /\$\.library\.licence/],
      [base().replace("  licence: CC0-1.0\n", ""), /\$\.library\.licence/],
      [base().replace("created: 2026-11-27", "created: yesterday"), /provenance\.created/],
      [base().replace("source: s, ", ""), /provenance\.source/],
      [base().replace("author: a, ", ""), /provenance\.author/],
      [base().replace("name: x", "name: \"\""), /\$\.library\.name/],
      [base("instruments:\n  bad-name: { waveform: pulse }\n"), /\$\.instruments\.bad-name/],
      [base("patterns:\n  a.b: { groove: C4 }\n"), /\$\.patterns\.a\.b/],
      [base("instruments:\n  a: 3\n"), /\$\.instruments\.a.*expected a mapping/],
      [base("extra: 1\n"), /\$\.extra/],
      ["- not a mapping\n", /a library is a mapping/],
      ["sidwave: [", /could not be parsed/],
      [base().replace("provenance: { author: a, source: s, created: 2026-11-27 }", "provenance: x"), /provenance/],
      [base("imports: nope\n"), /\$\.imports.*expected a list/],
    ];
    for (const [text, pattern] of cases) {
      fs.mkdirSync(path.join(dir, "libs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "libs", "x.yaml"), text);
      expectError(() => parseFile(file), pattern);
    }
    for (const licence of ["MIT", "Apache-2.0 WITH LLVM-exception", "(MIT OR Apache-2.0)", "LicenseRef-Studio-1.0", "GPL-2.0-or-later"]) {
      fs.writeFileSync(path.join(dir, "libs", "x.yaml"), base().replace("CC0-1.0", licence));
      assert.equal(parseFile(file).voices.length, 1, licence);
    }
  });
});

test("import fields are validated", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/x.yaml");
    const file = path.join(dir, "s.yaml");
    const bad = (entry, pattern) => { fs.writeFileSync(file, scoreWith(`  - ${entry}`)); expectError(() => parseFile(file), pattern); };
    bad("{ as: x }", /\$\.imports\[0\]\.from/);
    bad("{ from: ./libs/x.yaml }", /\$\.imports\[0\]\.as/);
    bad("{ as: x, from: ./libs/x.yaml, token: 1 }", /\$\.imports\[0\]\.token.*unknown import field/);
    bad("{ as: x, from: ./libs/x.yaml, effects: [\"a b\"] }", /\$\.imports\[0\]\.effects/);
    bad("{ as: x, from: ./libs/x.yaml, version: 3 }", /\$\.imports\[0\]\.version/);
    bad("not a mapping", /\$\.imports\[0\].*expected an import mapping/);
    bad("{ as: x, from: \"\" }", /\$\.imports\[0\]\.from/);
    bad("{ as: x, from: \"./libs/x.yaml\\u0000\" }", /NUL/);
    fs.writeFileSync(file, `${SCORE_HEAD}imports: nope\n${SCORE_TAIL}`);
    expectError(() => parseFile(file), /\$\.imports.*expected a list/);
  });
});

test("imports need sidwave 1.4 and a resolver, and a library cannot be compiled as a score", () => {
  withProject(({ dir, score }) => {
    const text = fs.readFileSync(score, "utf8");
    expectError(() => parseSidwave(text), /\$\.imports: this score imports libraries, which needs a library resolver/);
    fs.writeFileSync(score, text.replace("sidwave: 1.4", "sidwave: 1.3"));
    expectError(() => parseFile(score), /\$\.imports: imports require sidwave: 1\.4/);
    expectError(() => parseSidwave(fs.readFileSync(path.join(dir, "libs", "base.yaml"), "utf8")), /\$\.library: this file is a library/);
    // Without imports a 1.3 or 1.4 score never needs a resolver.
    assert.ok(parseSidwave(`${SCORE_HEAD}${SCORE_TAIL}`).voices.length === 1);
  });
});

// ---------------------------------------------------------------------------
// lock

test("lock writes the hashes into the score, keeps its comments and is idempotent", () => {
  withProject(({ dir, score }) => {
    const text = fs.readFileSync(score, "utf8");
    assert.ok(!text.includes("sha256"));
    const first = lockScore(text, score);
    assert.deepEqual(first.imports.map((i) => [i.as, i.changed]), [["drums", true], ["pads", true]]);
    assert.ok(first.text.includes("# Fixture score"));
    const doc = parseSidwave(first.text, confinedReadOptions(dir, [], score));
    const hashes = Object.fromEntries(doc.libraries.map((l) => [l.namespace, l.sha256]));
    assert.match(first.text, new RegExp(`sha256: ${hashes.drums}`));
    assert.match(first.text, new RegExp(`sha256: ${hashes.pads}`));
    const second = lockScore(first.text, score);
    assert.equal(second.text, first.text);
    assert.deepEqual(second.imports.map((i) => i.changed), [false, false]);
    // After a library edit the locked score no longer compiles; locking again accepts the new content.
    fs.writeFileSync(score, first.text);
    const pad = path.join(dir, "node_modules", "sidwave-lib-pad", "pad.yaml");
    fs.writeFileSync(pad, fs.readFileSync(pad, "utf8").replace("adsr: [6, 8, 12, 8]", "adsr: [6, 8, 12, 9]"));
    expectError(() => parseFile(score), /but the import pins/);
    const relocked = lockScore(first.text, score);
    assert.deepEqual(relocked.imports.map((i) => i.changed), [false, true]);
    fs.writeFileSync(score, relocked.text);
    assert.ok(parseFile(score).libraries.length === 3);
  });
});

test("lock refuses a library that violates its version range and a score without imports", () => {
  withProject(({ score }) => {
    const text = fs.readFileSync(score, "utf8");
    expectError(() => lockScore(text.replace('version: "^1.2.0"', 'version: "^3.0.0"'), score), /does not satisfy \^3\.0\.0/);
    expectError(() => lockScore(`${SCORE_HEAD}${SCORE_TAIL}`, score), /no imports to lock/);
  });
});

// ---------------------------------------------------------------------------
// bundle

test("a bundle compiles offline to the same bytes and lists every library with hash, licence and provenance", () => {
  withProject(({ dir, score }) => {
    fs.writeFileSync(score, lockScore(fs.readFileSync(score, "utf8"), score).text);
    const out = path.join(dir, "out", "bundle");
    const manifest = bundleScore(fs.readFileSync(score, "utf8"), score, out);
    assert.equal(manifest.format, "sidwave-bundle");
    assert.deepEqual(fs.readdirSync(out).sort(), ["bundle.json", "libs", "score.yaml"]);
    assert.deepEqual(manifest.libraries.map((l) => l.file), ["libs/fixture-base-1.0.2.yaml", "libs/fixture-drums-1.2.0.yaml", "libs/sidwave-lib-pad-0.3.1.yaml"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "bundle.json"), "utf8")), manifest);
    const drums = manifest.libraries[1];
    assert.equal(drums.licence, "MIT OR Apache-2.0");
    assert.deepEqual(drums.provenance, { author: "SIDWave tests", source: "https://example.invalid/drums", created: "2026-11-27" });
    assert.deepEqual(drums.imports, [{ as: "base", file: "libs/fixture-base-1.0.2.yaml" }]);
    assert.equal(manifest.score.sha256, sha(fs.readFileSync(path.join(out, "score.yaml"))));
    for (const lib of manifest.libraries) assert.equal(canonicalLibraryHash(fs.readFileSync(path.join(out, lib.file), "utf8")), lib.sha256);
    // The original and the bundle compile to the same bytes. The bundle has no node_modules and sits elsewhere.
    const original = compileSidwaveBytes(parseFile(score), { format: "sid" });
    const copy = path.join(os.tmpdir(), `sidwave-bundle-copy-${process.pid}`);
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(out, copy, { recursive: true });
    try {
      const bundled = compileSidwaveBytes(parseFile(path.join(copy, "score.yaml")), { format: "sid" });
      assert.ok(original.bytes.equals(bundled.bytes));
      assert.deepEqual(bundled.summary.libraries, original.summary.libraries);
      assert.ok(!fs.existsSync(path.join(copy, "node_modules")));
      assert.ok(!fs.readFileSync(path.join(copy, "score.yaml"), "utf8").includes("pkg:"));
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
    // Bundling the bundle gives the same files.
    const again = path.join(dir, "again");
    const manifest2 = bundleScore(fs.readFileSync(path.join(out, "score.yaml"), "utf8"), path.join(out, "score.yaml"), again);
    assert.deepEqual(manifest2, { ...manifest, score: manifest2.score });
  });
});

test("bundle refuses a directory that is not empty unless forced, and a score that does not resolve", () => {
  withProject(({ dir, score }) => {
    const out = path.join(dir, "o");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep.txt"), "x");
    expectError(() => bundleScore(fs.readFileSync(score, "utf8"), score, out), /is not empty; use --force/);
    assert.ok(bundleScore(fs.readFileSync(score, "utf8"), score, out, [], true).libraries.length === 3);
    fs.writeFileSync(score, fs.readFileSync(score, "utf8").replace("./libs/drums.yaml", "../nope.yaml"));
    expectError(() => bundleScore(fs.readFileSync(score, "utf8"), score, path.join(dir, "o2")), /outside the score directory|cannot be read/);
    assert.ok(!fs.existsSync(path.join(dir, "o2")));
  });
});

test("two libraries with the same name and version get distinct file names in a bundle", () => {
  withProject(({ dir }) => {
    writeLib(dir, "libs/a/x.yaml", { name: "same", body: "instruments:\n  a: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
    writeLib(dir, "libs/b/x.yaml", { name: "same", body: "instruments:\n  b: { waveform: pulse, adsr: [0, 5, 10, 5] }\n" });
    const file = path.join(dir, "s.yaml");
    fs.writeFileSync(file, scoreWith("  - { as: p, from: ./libs/a/x.yaml }\n  - { as: q, from: ./libs/b/x.yaml }"));
    const manifest = bundleScore(fs.readFileSync(file, "utf8"), file, path.join(dir, "o"));
    assert.equal(new Set(manifest.libraries.map((l) => l.file)).size, 2);
  });
});

// ---------------------------------------------------------------------------
// Command line

function run(cwd, ...args) {
  const out = [], err = [], bytes = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)) });
  return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
}

test("the command line compiles a score with imports, reports the libraries, locks and bundles", () => {
  withProject(({ dir }) => {
    const json = run(dir, "compile", "score.yaml", "-o", "a.prg", "--json");
    assert.equal(json.code, 0, json.err);
    const report = JSON.parse(json.out);
    assert.deepEqual(report.libraries.map((l) => l.name), ["fixture-drums", "fixture-base", "sidwave-lib-pad"]);
    const text = run(dir, "compile", "score.yaml", "-o", "a.prg");
    assert.match(text.err, /library drums: fixture-drums 1\.2\.0, MIT OR Apache-2\.0, sha256 [0-9a-f]{64}/);
    assert.equal(run(dir, "validate", "score.yaml").code, 0);
    assert.equal(run(dir, "lint", "score.yaml").code, 0);

    const lock = run(dir, "lock", "score.yaml");
    assert.equal(lock.code, 0, lock.err);
    assert.match(lock.out, /^drums: sha256 [0-9a-f]{64}\npads: sha256/);
    assert.match(fs.readFileSync(path.join(dir, "score.yaml"), "utf8"), /sha256: [0-9a-f]{64}/);
    assert.match(run(dir, "lock", "score.yaml").out, /\(unchanged\)/);

    const bundle = run(dir, "bundle", "score.yaml", "-o", "dist");
    assert.equal(bundle.code, 0, bundle.err);
    assert.match(bundle.out, /bundle with 3 libraries/);
    const again = run(dir, "bundle", "score.yaml", "-o", "dist");
    assert.equal(again.code, 2);
    assert.match(again.err, /is not empty/);
    assert.equal(run(dir, "bundle", "score.yaml", "-o", "dist", "--force").code, 0);
    assert.equal(run(dir, "bundle", "score.yaml").code, 2);
    const a = run(dir, "compile", "score.yaml", "-o", "-");
    const b = run(path.join(dir, "dist"), "compile", "score.yaml", "-o", "-");
    assert.ok(a.bytes.length > 0 && a.bytes.equals(b.bytes));
  });
});

test("the command line reports library errors as invalid input with the path", () => {
  withProject(({ dir }) => {
    fs.writeFileSync(path.join(dir, "bad.yaml"), scoreWith("  - { as: x, from: \"../escape.yaml\" }"));
    const result = run(dir, "compile", "bad.yaml", "--json");
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.out).error.path, "$.imports[0].from");
    assert.match(run(dir, "lint", "bad.yaml").err, /outside the score directory/);
    assert.equal(run(dir, "lock", "bad.yaml").code, 1);
    assert.equal(run(dir, "bundle", "bad.yaml", "-o", "x").code, 1);
    const allow = run(dir, "lock", "nothing.yaml");
    assert.equal(allow.code, 2);
  });
});

test("--allow-dir adds a directory to the library search path", () => {
  withProject(({ dir }) => {
    const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-shared-")));
    try {
      writeLib(shared, "x.yaml", { body: "instruments:\n  x: { waveform: pulse, adsr: [0, 5, 10, 4] }\n" });
      fs.writeFileSync(path.join(dir, "s.yaml"), scoreWith(`  - { as: x, from: ${JSON.stringify(path.join("..", path.basename(shared), "x.yaml"))} }`).replace("instrument: lead", "instrument: x.x"));
      const sub = path.join(dir, "deeper");
      fs.mkdirSync(sub);
      assert.equal(run(dir, "compile", "s.yaml", "-o", "-").code, 1);
      void sub;
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Older documents are unchanged

test("scores without imports keep their recorded bytes when read with a library resolver", () => {
  const hashes = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "sidwave-s4a", "example-hashes.json"), "utf8"));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-noimp-")));
  try {
    let checked = 0;
    for (const { name } of SIDWAVE_SCORE_RESOURCES) {
      if (!hashes[name]) continue;
      const file = path.join(dir, `${name}.yaml`);
      fs.writeFileSync(file, readSidwaveExample(name));
      const doc = parseSidwave(readSidwaveExample(name), confinedReadOptions(dir, [], file));
      assert.equal(doc.libraries, undefined);
      assert.equal(sha(compileSidwaveToPrg(doc).prg), hashes[name].prg, name);
      checked++;
    }
    assert.equal(checked, 14);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the spec and the schema describe imports and library files", () => {
  const spec = fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.md"), "utf8");
  const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.schema.json"), "utf8"));
  assert.ok(schema.properties.imports && schema.$defs.import.properties.sha256 && schema.$defs.libraryFile.properties.library);
  assert.ok(spec.includes("## Asset libraries (SIDWave 1.4)"));
  for (const word of ["Observed need", "Rejected alternative", "sidwave lock", "sidwave bundle", "pkg:", "sha256"]) assert.ok(spec.includes(word), word);
});

test("the library file and the import shown in the specification load and compile", () => {
  const spec = fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.md"), "utf8");
  const chapter = spec.slice(spec.indexOf("## Asset libraries (SIDWave 1.4)"), spec.indexOf("## Authoring and Validation"));
  const [library, imports] = [...chapter.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  withProject(({ dir }) => {
    writeLib(dir, "base.yaml", { name: "base", version: "1.0.1", body: "instruments:\n  kick: { waveform: pulse, adsr: [0, 8, 0, 0], wavetable: [{ wave: noise, note: A6 }, { gate: false }] }\n" });
    fs.writeFileSync(path.join(dir, "my-drums.yaml"), library);
    const file = path.join(dir, "s.yaml");
    const doc = parseSidwave(`${SCORE_HEAD}imports:\n  - { as: d, from: ./my-drums.yaml, effects: [pew] }\nvoices:\n  - { id: 1, patterns: {} }\n  - { id: 2, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 E4" } } }\ninstruments:\n  lead: { waveform: pulse, adsr: [0, 5, 10, 4] }\ntimeline: [{ bars: 1, layers: { v1: d.beat, v2: a } }]\n`,
      confinedReadOptions(dir, [], file));
    assert.deepEqual(doc.libraries.map((l) => l.name), ["my-drums", "base"]);
    assert.equal(doc.effects[0].name, "d_pew");
    assert.ok(compileSidwaveBytes(doc).bytes.length > 0);
    // The import lines of the specification are well formed.
    const entries = readImportEntries(YAML.parse(imports.replace("<64 hexadecimal digits>", "0".repeat(64))).imports);
    assert.deepEqual(entries.map((e) => e.as), ["drums", "pads"]);
  });
});
