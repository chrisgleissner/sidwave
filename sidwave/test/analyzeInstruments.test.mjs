// Instrument extraction into a SIDWave library, and the reuse test: an extracted instrument placed in a new score
// compiles to the same register sequence per note-relative call.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstrumentReuse, extractInstruments, replaceWithImports, reuseProbes } from "../src/analyze/instruments.ts";
import { irFingerprint, restrictIrToVoice } from "../src/analyze/common.ts";
import { fdiff } from "../src/reconstruct/fdiff.ts";
import { irOfTrace, reconstructSid } from "../src/reconstruct/reconstruct.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes, confinedReadOptions } from "../src/sidwaveOps.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { seededSid, seededText } from "./helpers/analyzeKit.mjs";

const CREATED = "2026-11-27";

test("a score's instruments become a valid SIDWave 1.4 library with provenance", async () => {
  const text = seededText("combined", 1);
  const result = await extractInstruments(text, { created: CREATED, author: "Test Author" });
  assert.deepEqual(result.instruments.map((i) => i.name), ["lead1", "lead2", "lead3"]);
  assert.deepEqual(result.instruments.map((i) => i.usedByVoices), [[1], [2], [3]]);
  assert.deepEqual(result.instruments[0].programs, ["pulsetable", "filtertable"]);
  assert.deepEqual(result.external, []);
  assert.equal(result.provenance.source.kind, "score");
  assert.match(result.library, /^# SIDWave instrument library extracted by sidwave\. Source score: sha256 [0-9a-f]{64}/);
  const doc = YAML.parse(result.library);
  assert.equal(String(doc.sidwave), "1.4");
  assert.deepEqual(Object.keys(doc.library).sort(), ["licence", "name", "provenance", "version"]);
  assert.equal(doc.library.licence, "LicenseRef-unknown");
  assert.equal(doc.library.provenance.author, "Test Author");
  assert.match(doc.library.provenance.source, /sha256 [0-9a-f]{64}/);
  // The same input and options give the same bytes.
  assert.equal((await extractInstruments(text, { created: CREATED, author: "Test Author" })).library, result.library);
});

test("the library loads through the production import resolver and a score can use its instruments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-extract-"));
  try {
    const { library } = await extractInstruments(seededText("pulse", 3), { created: CREATED });
    writeFileSync(join(dir, "lib.yaml"), library);
    const score = YAML.stringify({
      sidwave: "1.4", title: "Uses extracted", tempo: 120, mode: "PAL", imports: [{ as: "ex", from: "./lib.yaml" }],
      voices: [{ id: 1, instrument: "ex.lead2", patterns: { P: { length: 1, groove: [{ note: "C4", len: 2 }, { note: "E4", len: 2 }] } } }], timeline: [{ section: "A", bars: 1, layers: { v1: "P" } }],
    });
    writeFileSync(join(dir, "score.yaml"), score);
    const doc = parseSidwave(score, confinedReadOptions(dir, [], join(dir, "score.yaml")));
    assert.ok(compileSidwaveBytes(doc, { format: "sid" }).bytes.length > 100);
    assert.equal(doc.libraries.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a 1.5 source gives a 1.5 library, and a score that imports it needs 1.5 only for the 1.5 constructs", async () => {
  const text = `sidwave: "1.5"
title: T
tempo: 120
voices:
  - { id: 1, instrument: drum, patterns: { a: { length: 1, bars: 1, groove: "A4 - C5 -" } } }
instruments:
  drum: { waveform: pulse, adsr: [0, 4, 12, 3], wavetable: [{ wave: noise, reg: $10C3 }, { wave: pulse, note: A4 }], pulsetable: { wrap: true, steps: [{ set: 1024 }, { add: 64, frames: 4 }] } }
timeline:
  - { section: Main, bars: 1, layers: { v1: a } }
`;
  const result = await extractInstruments(text, { created: CREATED });
  assert.equal(String(YAML.parse(result.library).sidwave), "1.5");
  const replaced = replaceWithImports(text, ["drum"]);
  assert.equal(String(YAML.parse(replaced).sidwave), "1.5");
  const dir = mkdtempSync(join(tmpdir(), "sidwave-extract-"));
  try {
    writeFileSync(join(dir, "lib.yaml"), result.library);
    const file = join(dir, "score.yaml");
    const parse = (score) => parseSidwave(score, confinedReadOptions(dir, [], file));
    writeFileSync(file, replaced);
    assert.ok(compileSidwaveBytes(parse(replaced), { format: "sid" }).bytes.length > 100);
    const older = replaced.replace(/sidwave: .*/, 'sidwave: "1.4"');
    assert.throws(() => parse(older), /requires sidwave: 1\.5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const check = await checkInstrumentReuse({ library: result.library, instrument: "drum", source: text, engine: sharedEngine(), seconds: 2 });
  assert.equal(check.equal, true, JSON.stringify(check.first));
});

test("invalid library names, dates and non-score input are rejected", async () => {
  const text = seededText("basic", 1);
  await assert.rejects(() => extractInstruments(text, { name: "bad name" }), /library name/);
  await assert.rejects(() => extractInstruments(text, { created: "yesterday" }), /created must be a date/);
  await assert.rejects(() => extractInstruments("- a\n- b\n"), /not a YAML mapping/);
});

const FULL = process.env.SIDWAVE_FULL_REUSE === "1";
test(`reuse: extracted instruments of seeded scores give the same register output of their voice in a new score (${FULL ? "all" : "a sample of 3; SIDWAVE_FULL_REUSE=1 runs every instrument"})`, { timeout: 300_000 }, async () => {
  const results = [];
  const scores = FULL
    ? [["basic", 1], ["arpeggio", 3], ["hard_restart", 4], ["vibrato", 5], ["filter", 6], ["combined", 3]]
    : [["arpeggio", 3], ["filter", 6], ["combined", 3]];
  for (const [feature, seed] of scores) {
    const text = seededText(feature, seed);
    const extracted = await extractInstruments(text, { created: CREATED });
    for (const inst of FULL ? extracted.instruments : extracted.instruments.slice(0, 1)) {
      const check = await checkInstrumentReuse({ library: extracted.library, instrument: inst.name, sourceInstrument: inst.sourceName, source: text, engine: sharedEngine() });
      assert.equal(check.equal, true, `${feature} seed ${seed} ${inst.name}: ${JSON.stringify(check.first)}`);
      assert.ok(check.comparedCalls > 100);
      results.push(`${feature}/${seed}/${inst.name}`);
    }
  }
  assert.ok(results.length >= 3, `${results.length} instruments checked`);
});

test("reuse: the source side is the source score's own definition, so a corrupted extraction fails the check", { timeout: 120_000 }, async () => {
  const text = seededText("pulse", 2);
  const extracted = await extractInstruments(text, { created: CREATED });
  const probes = reuseProbes({ library: extracted.library, instrument: "lead1", source: text });
  assert.deepEqual(YAML.parse(probes.inline).instruments.X, YAML.parse(text).instruments.lead1, "the inline probe holds the source score's definition");
  const good = await checkInstrumentReuse({ library: extracted.library, instrument: "lead1", source: text, engine: sharedEngine(), seconds: 3 });
  assert.equal(good.equal, true);
  // Corrupt the extraction (the library), not the inline copy.
  const lib = YAML.parse(extracted.library);
  lib.instruments.lead1.adsr = [0, 0, 15, 0];
  const bad = await checkInstrumentReuse({ library: YAML.stringify(lib), instrument: "lead1", source: text, engine: sharedEngine(), seconds: 3 });
  assert.equal(bad.equal, false);
  assert.ok(bad.differingCalls > 0 && bad.first);
  // Corrupting the source side the same way is also detected: the two sides are independent.
  const source = YAML.parse(text);
  source.instruments.lead1.adsr = [0, 0, 15, 0];
  assert.equal((await checkInstrumentReuse({ library: extracted.library, instrument: "lead1", source: YAML.stringify(source), engine: sharedEngine(), seconds: 3 })).equal, false);
  await assert.rejects(() => checkInstrumentReuse({ library: extracted.library, instrument: "lead1", sourceInstrument: "missing", source: text, engine: sharedEngine() }), /source score has no instrument missing/);
});

test("reuse in the whole source: replacing every instrument by an import from the library keeps all voices identical", { timeout: 300_000 }, async () => {
  for (const [feature, seed] of [["combined", 1], ["arpeggio", 2], ["hard_restart", 5]]) {
    const text = seededText(feature, seed);
    const extracted = await extractInstruments(text, { created: CREATED });
    const dir = mkdtempSync(join(tmpdir(), "sidwave-replace-"));
    try {
      writeFileSync(join(dir, "lib.yaml"), extracted.library);
      const replaced = replaceWithImports(text, extracted.instruments.map((i) => i.name));
      writeFileSync(join(dir, "score.yaml"), replaced);
      const bytes = (t, file) => new Uint8Array(compileSidwaveBytes(parseSidwave(t, confinedReadOptions(dir, [], file)), { format: "sid", loop: true }).bytes);
      const a = irOfTrace(await sharedEngine().trace({ sid: bytes(text), seconds: 4 }));
      const b = irOfTrace(await sharedEngine().trace({ sid: bytes(replaced, join(dir, "score.yaml")), seconds: 4 }));
      for (const v of [1, 2, 3]) {
        const r = fdiff(restrictIrToVoice(a, v), restrictIrToVoice(b, v), { alignExpected: 1, alignObserved: 1 });
        assert.equal(r.equal, true, `${feature} seed ${seed} voice ${v}: ${JSON.stringify(r.first)}`);
      }
      assert.equal(irFingerprint(a), irFingerprint(b));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("SID input: the library comes from the reconstruction with the source checksums, subtune and horizon in its provenance", { timeout: 120_000 }, async () => {
  const sid = seededSid("combined", 3);
  const result = await extractInstruments(sid, { engine: sharedEngine(), seconds: 3, created: CREATED });
  assert.equal(result.provenance.source.kind, "sid");
  assert.equal(result.provenance.source.md5.length, 32);
  assert.equal(result.provenance.subtune, 1);
  assert.equal(result.provenance.horizonSeconds, 3);
  assert.equal(typeof result.provenance.reconstructionStrictExact, "boolean");
  assert.ok(result.instruments.length >= 3);
  const doc = YAML.parse(result.library);
  assert.match(doc.library.provenance.source, /reconstructed from SID file md5 [0-9a-f]{32} sha256 [0-9a-f]{64}, subtune 1, horizon 3 s/);
  assert.match(result.library, /# Subtune 1, horizon 3 s, reconstruction (strictly exact|not strictly exact)\./);
  // An extracted instrument of the reconstruction is reusable.
  const rec = await reconstructSid(sid, { engine: sharedEngine(), seconds: 3 });
  const check = await checkInstrumentReuse({ library: result.library, instrument: result.instruments[0].name, sourceInstrument: result.instruments[0].sourceName, source: rec.score, engine: sharedEngine() });
  assert.equal(check.equal, true, JSON.stringify(check.first));
  await assert.rejects(() => extractInstruments(sid, { created: CREATED }), /needs an engine/);
});
