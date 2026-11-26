import test from "#test/runner";
import assert from "#test/assert";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { transpose, setTempo, scaleTempo, substituteInstrument, quantise, restructure, humanise, SidwaveTransformError } from "../src/transform/index.js";
import { parseSidwave } from "../src/sidwave.js";
import { formatSidwave } from "../src/format/sidwaveFormat.js";
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

test("transpose leaves @instrument references that look like note names unchanged", () => {
  const text = `sidwave: 1.2
title: "T"
tempo: 120
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  a1: {waveform: "saw", adsr: [0, 4, 10, 4]}
voices:
  - id: 1
    instrument: "a1"
    patterns:
      A: {groove: "B3@a1 ~ C3@a1 ~", length: 0.5}
sections:
  s: {bars: 1, layers: {v1: "A"}}
timeline: ["s"]
`;
  const result = transpose(text, { semitones: 1 });
  assert.ok(result.text.includes(`groove: "C4@a1 ~ C#3@a1 ~"`), result.text);
  assert.deepEqual(result.report.changed, ["/voices/0/patterns/A/groove"]);
  valid(result.text);
});

test("transpose with a section scope refuses a pattern that other sections also play", () => {
  const text = `sidwave: 1.2
title: "T"
tempo: 120
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  lead: {waveform: "saw", adsr: [0, 4, 10, 4]}
voices:
  - id: 1
    instrument: "lead"
    patterns:
      A: {groove: "C3 ~ D3 ~ E3 ~ F3 ~", length: 0.5}
      B: {groove: "G3 ~ A3 ~ B3 ~ C4 ~", length: 0.5}
sections:
  intro: {bars: 1, layers: {v1: "A"}}
  main: {bars: 1, layers: {v1: "A"}}
  coda: {bars: 1, layers: {v1: "B"}}
timeline: ["intro", "main", "coda"]
`;
  assert.throws(
    () => transpose(text, { semitones: 2, scope: { sections: ["main"] } }),
    (e) => e instanceof SidwaveTransformError && e.code === "unsupported" && e.message === "Pattern A of voice 1 is also played outside the selected sections",
  );
  const coda = transpose(text, { semitones: 2, scope: { sections: ["coda"] } });
  assert.deepEqual(coda.report.changed, ["/voices/0/patterns/B/groove"]);
  assert.ok(coda.text.includes(`B: {groove: "A3 ~ B3 ~ C#4 ~ D4 ~", length: 0.5}`), coda.text);
  assert.ok(coda.text.includes(`A: {groove: "C3 ~ D3 ~ E3 ~ F3 ~", length: 0.5}`), coda.text);
});

test("humanise pairs durations inside one bar group so every bar keeps its length", () => {
  const text = `sidwave: 1.2
title: "T"
tempo: 120
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  lead: {waveform: "saw", adsr: [0, 4, 10, 4]}
voices:
  - id: 1
    instrument: "lead"
    patterns:
      A:
        groove:
          - {note: "C4", len: 1}
          - {note: "D4", len: 1}
          - {note: "E4", len: 2}
          - "|"
          - {note: "F4", len: 4}
sections:
  s: {bars: 2, layers: {v1: "A"}}
timeline: ["s"]
`;
  const result = humanise(text, { seed: 7, maxShift: 0.1 });
  assert.deepEqual(result.report.changed, ["/voices/0/patterns/A/groove/0/len", "/voices/0/patterns/A/groove/1/len"]);
  const groove = YAML.parse(result.text).voices[0].patterns.A.groove;
  assert.equal(groove[0].len + groove[1].len, 2);
  assert.notEqual(groove[0].len, 1);
  assert.deepEqual([groove[2].len, groove[4].len], [2, 4]);
  valid(result.text);
});

const quantiseScore = (groove) => `sidwave: 1.2
title: "T"
tempo: 120
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  lead: {waveform: "saw", adsr: [0, 4, 10, 4]}
voices:
  - id: 1
    instrument: "lead"
    patterns:
      A:
        groove:
${groove}
sections:
  s: {bars: 2, layers: {v1: "A"}}
timeline: ["s"]
`;

test("quantise keeps the length of every bar group and reports each changed duration", () => {
  const text = quantiseScore(`          - {note: "C4", len: 1.25}
          - {note: "D4", len: 0.75}
          - {note: "E4", len: 2}
          - "|"
          - {note: "F4", len: 1.6}
          - {note: "G4", len: 2.4}`);
  const result = quantise(text, { grid: 0.5 });
  const groove = YAML.parse(result.text).voices[0].patterns.A.groove;
  assert.deepEqual(groove.filter((e) => typeof e === "object").map((e) => e.len), [1.5, 1, 1.5, 1.5, 2.5]);
  assert.deepEqual(result.report.changed, ["/voices/0/patterns/A/groove/0/len", "/voices/0/patterns/A/groove/1/len", "/voices/0/patterns/A/groove/2/len", "/voices/0/patterns/A/groove/4/len", "/voices/0/patterns/A/groove/5/len"]);
  assert.deepEqual(result.report.warnings, []);
  valid(result.text);
});

test("quantise leaves a pattern untouched when a bar group cannot keep its length", () => {
  const text = quantiseScore(`          - {note: "C4", len: 1.25}
          - "D4 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~"`);
  const result = quantise(text, { grid: 0.5 });
  assert.equal(result.text, formatSidwave(text));
  assert.deepEqual(result.report.changed, []);
  assert.deepEqual(result.report.warnings, ["/voices/0/patterns/A has no second explicit duration for length-preserving quantisation; unchanged"]);
});

const motifScore = (motif) => `sidwave: 1.2
title: "T"
tempo: 120
voices:
  - id: 1
    patterns:
      A: {motif: "${motif}", length: 1}
timeline: [{bars: 1, layers: {v1: "A"}}]
`;

test("transpose writes motif chord symbols without an octave", () => {
  for (const [semitones, expected] of [[0, "Cm7 G 0 4"], [2, "Dm7 A 2 6"], [-1, "Bm7 F# -1 3"]]) {
    const result = transpose(motifScore("Cm7 G 0 4"), { semitones });
    assert.ok(result.text.includes(`motif: "${expected}"`), result.text);
    valid(result.text);
  }
});

test("transpose shifts chord symbols in groove strings and chord entries", () => {
  const text = `sidwave: 1.2
title: "T"
tempo: 120
voices:
  - id: 1
    patterns:
      A:
        groove:
          - "Cm7@arp C4 ~ ~"
          - {chord: "Gsus4", arp: "0,5,7", speed: 2}
        length: 1
timeline: [{bars: 1, layers: {v1: "A"}}]
`;
  const result = transpose(text, { semitones: 2 });
  assert.ok(result.text.includes(`          - "Dm7@arp D4 ~ ~"\n          - {chord: "Asus4", arp: "0,5,7", speed: 2}\n`), result.text);
  assert.deepEqual(result.report.changed, ["/voices/0/patterns/A/groove/0", "/voices/0/patterns/A/groove/1/chord"]);
  const odd = text.replace("Gsus4", "G/B");
  assert.throws(() => transpose(odd, { semitones: 2 }), (e) => e instanceof SidwaveTransformError && e.code === "unsupported" && e.message === "Cannot transpose chord G/B at /voices/0/patterns/A/groove/1");
});
