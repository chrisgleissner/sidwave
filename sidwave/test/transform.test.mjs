import test from "#test/runner";
import assert from "#test/assert";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { transpose, setTempo, scaleTempo, substituteInstrument, quantise, restructure, humanise, SidwaveTransformError } from "../src/transform/index.js";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg } from "../src/sidwaveCompiler.js";

const source = await readFile(new URL("../data/sound/examples/title_fanfare.yaml", import.meta.url), "utf8");
const valid = text => compileSidwaveToPrg(parseSidwave(text), { loop: false });
const arrangement = text => arrangeSidwave(parseSidwave(text));
const pitches = text => arrangement(text).voices.map(v => v.notes.map(n => n.midi));
test("SIDWave deterministic score transformations", () => {
  const original = YAML.parse(source);
  const before = arrangement(source);
  const transposed = transpose(source, { semitones: 1, scope: { voices: ["1"] } });
  valid(transposed.text);
  assert.ok(transposed.report.changed.length > 0);
  assert.deepEqual(arrangement(transposed.text).voices.slice(1).map(v => v.notes), before.voices.slice(1).map(v => v.notes));
  assert.throws(() => transpose(source, { semitones: 200 }), e => e instanceof SidwaveTransformError && e.code === "out_of_range");

  const tempo = setTempo(source, { bpm: 110 }); valid(tempo.text);
  assert.equal(parseSidwave(tempo.text).song.tempo, 110);
  assert.deepEqual(pitches(tempo.text), pitches(source));
  const scaled = scaleTempo(source, { factor: 0.9 }); valid(scaled.text);
  assert.equal(parseSidwave(scaled.text).song.tempo, original.tempo * 0.9);
  assert.throws(() => setTempo(source, { bpm: 999 }), SidwaveTransformError);
  assert.throws(() => scaleTempo(source, { factor: 0 }), SidwaveTransformError);

  const replaced = substituteInstrument(source, { from: "trumpet", to: "horn" }); valid(replaced.text);
  assert.ok(replaced.report.changed.length > 0);
  assert.throws(() => substituteInstrument(source, { from: "trumpet", to: "missing" }), SidwaveTransformError);

  const quantised = quantise(source, { grid: 0.4 }); valid(quantised.text);
  assert.ok(quantised.report.changed.length > 0);
  assert.deepEqual(YAML.parse(quantised.text).sections, original.sections);
  assert.throws(() => quantise(source, { grid: 0 }), SidwaveTransformError);

  const reshaped = restructure(source, { order: ["gate", "summons", "gate"] }); valid(reshaped.text);
  assert.deepEqual(YAML.parse(reshaped.text).sections, original.sections);
  assert.deepEqual(YAML.parse(reshaped.text).timeline, ["gate", "summons", "gate"]);
  assert.throws(() => restructure(source, { order: ["missing"] }), SidwaveTransformError);

  const a = humanise(source, { seed: 4, maxShift: 0.1 });
  const b = humanise(source, { seed: 4, maxShift: 0.1 });
  const c = humanise(source, { seed: 5, maxShift: 0.1 });
  valid(a.text);
  assert.equal(a.text, b.text); assert.notEqual(a.text, c.text);
  assert.deepEqual(pitches(a.text).map(v => v.map(n => n[2])), pitches(source).map(v => v.map(n => n[2])));
  assert.ok(a.report.changed.length > 0);
  assert.throws(() => humanise(source, { seed: 4, maxShift: -1 }), SidwaveTransformError);
});
