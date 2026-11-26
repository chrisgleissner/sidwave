import test from "#test/runner";
import assert from "#test/assert";
import { readFile, readdir } from "node:fs/promises";
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
  const result = transpose(text, { semitones: 2, validate: "none" });
  assert.ok(result.text.includes(`          - "Dm7@arp D4 ~ ~"\n          - {chord: "Asus4", arp: "0,5,7", speed: 2}\n`), result.text);
  assert.deepEqual(result.report.changed, ["/voices/0/patterns/A/groove/0", "/voices/0/patterns/A/groove/1/chord"]);
  const odd = text.replace("Gsus4", "G/B");
  assert.throws(() => transpose(odd, { semitones: 2, validate: "none" }), (e) => e instanceof SidwaveTransformError && e.code === "unsupported" && e.message === "Cannot transpose chord G/B at /voices/0/patterns/A/groove/1");
});

// ---- Exact results on a small canonical score ----
const score = (o = {}) => {
  const p = { tempo: 120, lead: "lead", a: ["C3", "D3", "E3", "F3"], lens: [1.3, 0.7, 1.6, 0.4], b: "C3 ~ D3 ~ E3 ~ F3 ~", bass: "C2 ~ ~ ~ G1 ~ ~ ~", c: "G1 ~ ~ ~ C2 ~ ~ ~", timeline: '["intro", "main", "intro"]', ...o };
  return `sidwave: 1.2
title: "T"
tempo: ${p.tempo}
sids: [{id: "sid1", address: "$D400", model: "8580"}]
instruments:
  lead: {waveform: "saw", adsr: [0, 4, 10, 4]}
  pad: {waveform: "triangle", adsr: [2, 4, 10, 4]}
voices:
  - id: 1
    name: "Lead"
    instrument: "${p.lead}"
    patterns:
      A:
        groove:
          - {note: "${p.a[0]}", inst: "${p.lead}", len: ${p.lens[0]}}
          - {note: "${p.a[1]}", len: ${p.lens[1]}}
          - {note: "${p.a[2]}", len: ${p.lens[2]}}
          - {note: "${p.a[3]}", len: ${p.lens[3]}}
        length: 0.25
      B: {groove: "${p.b}", length: 0.5}
  - id: 2
    name: "Bass"
    instrument: "pad"
    patterns:
      A: {groove: "${p.bass}", length: 0.5}
      C: {groove: "${p.c}", length: 0.5}
sections:
  intro:
    bars: 1
    layers: {v1: "A", v2: "A"}
  main:
    bars: 1
    layers: {v1: "B", v2: "C"}
timeline: ${p.timeline}
`;
};

const base = score();


const fails = (fn, code, message) => assert.throws(fn, (e) => e instanceof SidwaveTransformError && e.code === code && (message === undefined || e.message === message));

test("the fixture score is canonical, valid and compiles", () => {
  assert.equal(formatSidwave(base), base);
  valid(base);
});

test("transpose shifts every pitched note of every non-drum voice", () => {
  const r = transpose(base, { semitones: 2 });
  assert.equal(r.text, score({ a: ["D3", "E3", "F#3", "G3"], b: "D3 ~ E3 ~ F#3 ~ G3 ~", bass: "D2 ~ ~ ~ A1 ~ ~ ~", c: "A1 ~ ~ ~ D2 ~ ~ ~" }));
  assert.deepEqual(r.report, {
    changed: ["/voices/0/patterns/A/groove/0/note", "/voices/0/patterns/A/groove/1/note", "/voices/0/patterns/A/groove/2/note", "/voices/0/patterns/A/groove/3/note", "/voices/0/patterns/B/groove", "/voices/1/patterns/A/groove", "/voices/1/patterns/C/groove"],
    preserved: ["rhythm", "percussion", "instruments", "voices outside scope"],
    warnings: [],
  });
  valid(r.text);
  assert.equal(transpose(r.text, { semitones: -2 }).text, base);
});

test("transpose limits changes to the selected voices by id or by name", () => {
  const bass = score({ bass: "D2 ~ ~ ~ A1 ~ ~ ~", c: "A1 ~ ~ ~ D2 ~ ~ ~" });
  assert.equal(transpose(base, { semitones: 2, scope: { voices: ["Bass"] } }).text, bass);
  assert.equal(transpose(base, { semitones: 2, scope: { voices: ["2"] } }).text, bass);
  const lead = transpose(base, { semitones: -1, scope: { voices: ["1"] } });
  assert.equal(lead.text, score({ a: ["B2", "C#3", "D#3", "E3"], b: "B2 ~ C#3 ~ D#3 ~ E3 ~" }));
  assert.deepEqual(lead.report.changed, ["/voices/0/patterns/A/groove/0/note", "/voices/0/patterns/A/groove/1/note", "/voices/0/patterns/A/groove/2/note", "/voices/0/patterns/A/groove/3/note", "/voices/0/patterns/B/groove"]);
});

test("transpose limits changes to patterns that only the selected sections play", () => {
  const main = transpose(base, { semitones: 2, scope: { sections: ["main"] } });
  assert.equal(main.text, score({ b: "D3 ~ E3 ~ F#3 ~ G3 ~", c: "A1 ~ ~ ~ D2 ~ ~ ~" }));
  assert.deepEqual(main.report.changed, ["/voices/0/patterns/B/groove", "/voices/1/patterns/C/groove"]);
  const intro = transpose(base, { semitones: 2, scope: { sections: ["intro"] } });
  assert.equal(intro.text, score({ a: ["D3", "E3", "F#3", "G3"], bass: "D2 ~ ~ ~ A1 ~ ~ ~" }));
  const both = transpose(base, { semitones: 2, scope: { sections: ["intro"], voices: ["Bass"] } });
  assert.deepEqual(both.report.changed, ["/voices/1/patterns/A/groove"]);
  assert.throws(() => transpose(base, { semitones: 2, scope: { sections: ["missing"] } }), (e) => e instanceof SidwaveTransformError && e.code === "precondition" && e.message === "Unknown section missing");
});

test("transpose follows sections named by timeline entries with layers and uses", () => {
  const text = base.replace('timeline: ["intro", "main", "intro"]', 'timeline:\n  - {use: "main", layers: {v1: "B"}}\n  - {section: "coda", bars: 1, layers: {v1: "A"}}');
  const main = transpose(text, { semitones: 1, scope: { sections: ["main"] } });
  assert.deepEqual(main.report.changed, ["/voices/0/patterns/B/groove", "/voices/1/patterns/C/groove"]);
  assert.throws(() => transpose(text, { semitones: 1, scope: { sections: ["coda"], voices: ["1"] } }), (e) => e.code === "unsupported");
});

test("transpose rejects bad arguments and notes outside the playable range", () => {
  const fails = (fn, code, message) => assert.throws(fn, (e) => e instanceof SidwaveTransformError && e.name === "SidwaveTransformError" && e.code === code && (message === undefined || e.message === message));
  fails(() => transpose(base, { semitones: 1.5 }), "precondition", "semitones must be an integer");
  fails(() => transpose(base, { semitones: Number.NaN }), "precondition", "semitones must be an integer");
  fails(() => transpose(base, { semitones: 200 }), "out_of_range", "Offending note at /voices/0/patterns/A/groove/0/note");
  fails(() => transpose(base, { semitones: -60 }), "out_of_range", "Offending note at /voices/0/patterns/A/groove/0/note");
  fails(() => transpose("a: [", { semitones: 1 }), "input");
});

test("transpose uses the SID frequency range of the selected clock", () => {
  const high = (mode) => `sidwave: 1.2\ntitle: "T"\ntempo: 120\nmode: "${mode}"\nvoices:\n  - id: 1\n    patterns:\n      A: {groove: "A#6 ~ ~ ~", length: 1}\ntimeline: [{bars: 1, layers: {v1: "A"}}]\n`;
  const offending = (e) => e.code === "out_of_range" && e.message === "Offending note at /voices/0/patterns/A/groove";
  assert.ok(transpose(high("PAL"), { semitones: 12 }).text.includes('groove: "A#7 ~ ~ ~"'));
  assert.throws(() => transpose(high("PAL"), { semitones: 13 }), offending);
  assert.ok(transpose(high("NTSC"), { semitones: 13 }).text.includes('groove: "B7 ~ ~ ~"'));
  assert.throws(() => transpose(high("NTSC"), { semitones: 14 }), offending);
});

test("transpose handles slides, bends, note lists, drums, kit notes and unsupported constructs", () => {
  const doc = (pattern, role = "") => `sidwave: 1.2\ntitle: "T"\ntempo: 120\nvoices:\n  - id: 1\n${role}    patterns:\n      A:\n${pattern}\ntimeline: [{bars: 1, layers: {v1: "A"}}]\n`;
  const groove = doc(`        length: 1
        groove:
          - {note: "C4", len: 1, slide_from: "A3"}
          - {note: "E4", len: 1, bend: {to: "G4", frames: 4}}
          - {note: "C2", len: 1, kitNote: true, slide_from: "C2", bend: {to: "D2"}}
          - {note: "A4", len: 1, bend: {to: -2, frames: 4}}
          - "D4 ~"`);
  const r = transpose(groove, { semitones: 2, validate: "none" });
  assert.ok(r.text.includes(`          - {note: "D4", len: 1, slide_from: "B3"}\n          - {note: "F#4", len: 1, bend: {to: "A4", frames: 4}}\n          - {note: "C2", len: 1, slide_from: "C2", bend: {to: "D2"}, kitNote: true}\n          - {note: "B4", len: 1, bend: {to: -2, frames: 4}}\n          - "E4 ~"\n`), r.text);
  assert.deepEqual(r.report.changed, ["/voices/0/patterns/A/groove/0/note", "/voices/0/patterns/A/groove/0/slide_from", "/voices/0/patterns/A/groove/1/note", "/voices/0/patterns/A/groove/1/bend/to", "/voices/0/patterns/A/groove/3/note", "/voices/0/patterns/A/groove/4"]);
  const notes = transpose(doc(`        length: 1\n        notes: ["C4", "E4", "~", "-"]`), { semitones: -2, validate: "none" });
  assert.ok(notes.text.includes(`notes: ["A#3", "D4", "~", "-"]`), notes.text);
  assert.deepEqual(notes.report.changed, ["/voices/0/patterns/A/notes/0", "/voices/0/patterns/A/notes/1"]);
  const drums = doc(`        groove: "C2 D2 ~ ~"\n        length: 1`, `    role: "drums"\n`);
  assert.equal(transpose(drums, { semitones: 5, validate: "none" }).text, drums);
  assert.deepEqual(transpose(drums, { semitones: 5, validate: "none" }).report.changed, []);
  assert.throws(() => transpose(doc(`        groove:\n          - {rest: 1}`), { semitones: 1, validate: "none" }), (e) => e.code === "unsupported" && e.message === "Cannot transpose groove construct at /voices/0/patterns/A/groove/0");
});

test("transpose shifts motif notes, semitone offsets and chord symbols and checks their range", () => {
  const motif = (text, root = "") => `sidwave: 1.2\ntitle: "T"\ntempo: 120\nvoices:\n  - id: 1\n    patterns:\n      A: {motif: "${text}",${root} length: 1}\ntimeline: [{bars: 1, layers: {v1: "A"}}]\n`;
  const up = transpose(motif("Cm7, 0 4 -1 C4 Bbmaj7 - ~"), { semitones: 3, validate: "none" });
  assert.ok(up.text.includes(`motif: "D#m7, 3 7 2 D#4 C#maj7 - ~"`), up.text);
  assert.deepEqual(up.report.changed, ["/voices/0/patterns/A/motif"]);
  assert.equal(transpose(motif("- ~ pad"), { semitones: 3, validate: "none" }).text, motif("- ~ pad"));
  assert.deepEqual(transpose(motif("- ~ pad"), { semitones: 3, validate: "none" }).report.changed, []);
  const offsets = (e) => e.code === "out_of_range" && e.message === "Offending note at /voices/0/patterns/A/motif";
  assert.throws(() => transpose(motif("0 4 7"), { semitones: 200, validate: "none" }), offsets);
  assert.throws(() => transpose(motif("0 4 7", ' root: "C3",'), { semitones: -100, validate: "none" }), offsets);
  assert.throws(() => transpose(motif("C4 E4"), { semitones: 200, validate: "none" }), offsets);
  assert.throws(() => transpose(motif("Cm7"), { semitones: 200, validate: "none" }), offsets);
  assert.throws(() => transpose(motif("Cm7"), { semitones: -40, validate: "none" }), offsets);
});

test("setTempo replaces the tempo key, the song tempo, or adds a tempo", () => {
  const r = setTempo(base, { bpm: 90 });
  assert.equal(r.text, score({ tempo: 90 }));
  assert.deepEqual(r.report, { changed: ["/tempo"], preserved: ["notes", "pitches"], warnings: [] });
  valid(r.text);
  assert.equal(setTempo(base, { bpm: 30 }).text, score({ tempo: 30 }));
  assert.equal(setTempo(base, { bpm: 220 }).text, score({ tempo: 220 }));
  assert.equal(setTempo(base, { bpm: 100.5 }).text, score({ tempo: 100.5 }));
  const song = setTempo('song:\n  title: "x"\n  tempo: 100\n', { bpm: 90, validate: "none" });
  assert.equal(song.text, 'song:\n  title: "x"\n  tempo: 90\n');
  assert.deepEqual(song.report.changed, ["/song/tempo"]);
  const none = setTempo('sidwave: 1.2\ntitle: "x"\n', { bpm: 90, validate: "none" });
  assert.equal(none.text, 'sidwave: 1.2\ntitle: "x"\ntempo: 90\n');
  assert.deepEqual(none.report.changed, ["/tempo"]);
});

test("setTempo rejects tempos outside the SIDWave range", () => {
  for (const bpm of [29.9, 220.1, 0, -5, Number.NaN, Infinity]) fails(() => setTempo(base, { bpm }), "out_of_range", "bpm must be 30..220");
  fails(() => setTempo("a: [", { bpm: 90 }), "input");
});

test("scaleTempo multiplies the current tempo, the song tempo or the default tempo of 100", () => {
  assert.equal(scaleTempo(base, { factor: 0.75 }).text, score({ tempo: 90 }));
  assert.deepEqual(scaleTempo(base, { factor: 0.75 }).report, { changed: ["/tempo"], preserved: ["notes", "pitches"], warnings: [] });
  assert.equal(scaleTempo(base, { factor: 1 }).text, base);
  assert.equal(scaleTempo('song:\n  tempo: 100\n', { factor: 0.5, validate: "none" }).text, 'song:\n  tempo: 50\n');
  assert.equal(scaleTempo('title: "x"\n', { factor: 2, validate: "none" }).text, 'title: "x"\ntempo: 200\n');
  valid(scaleTempo(base, { factor: 0.75 }).text);
});

test("scaleTempo rejects bad factors and results outside the tempo range", () => {
  for (const factor of [0, -1, Number.NaN, Infinity]) fails(() => scaleTempo(base, { factor }), "precondition", "factor must be positive and finite");
  fails(() => scaleTempo(base, { factor: 100 }), "out_of_range", "scaled tempo 12000 is outside 30..220");
  fails(() => scaleTempo(base, { factor: 0.1 }), "out_of_range", "scaled tempo 12 is outside 30..220");
});

test("substituteInstrument replaces voice and note references and keeps the definitions", () => {
  const r = substituteInstrument(base, { from: "lead", to: "pad" });
  assert.equal(r.text, score({ lead: "pad" }));
  assert.deepEqual(r.report, { changed: ["/voices/0/instrument", "/voices/0/patterns/A/groove/0/inst"], preserved: ["instrument definitions", "all references other than the selected source"], warnings: [] });
  valid(r.text);
  const lib = substituteInstrument(base, { from: "lead", to: "lib:kick" });
  assert.equal(lib.text, score({ lead: "lib:kick" }));
  for (const name of ["kick", "snare", "hat", "bass_pluck", "filter_bass", "lead_pwm", "chip_arp_major", "chip_arp_minor", "bell_ring", "sync_lead", "pad_slow"]) {
    assert.ok(substituteInstrument(base, { from: "pad", to: `lib:${name}` }).text.includes(`instrument: "lib:${name}"`), name);
  }
});

test("substituteInstrument rejects unknown instruments", () => {
  fails(() => substituteInstrument(base, { from: "lead", to: "missing" }), "precondition", "Instrument missing does not exist");
  fails(() => substituteInstrument(base, { from: "lead", to: "lib:nothing" }), "precondition", "Instrument lib:nothing does not exist");
  fails(() => substituteInstrument(base, { from: "ghost", to: "pad" }), "precondition", "Instrument reference ghost does not exist");
  fails(() => substituteInstrument("a: [", { from: "a", to: "b" }), "input");
});

test("quantise moves explicit durations to the grid and keeps every pattern length", () => {
  const r = quantise(base, { grid: 0.5 });
  assert.equal(r.text, score({ lens: [1.5, 0.5, 1.5, 0.5] }));
  assert.deepEqual(r.report, {
    changed: ["/voices/0/patterns/A/groove/0/len", "/voices/0/patterns/A/groove/1/len", "/voices/0/patterns/A/groove/2/len", "/voices/0/patterns/A/groove/3/len"],
    preserved: ["total length of every pattern"],
    warnings: ["/voices/0/patterns/B/groove uses implicit entry lengths; unchanged", "/voices/1/patterns/A/groove uses implicit entry lengths; unchanged", "/voices/1/patterns/C/groove uses implicit entry lengths; unchanged"],
  });
  valid(r.text);
  const grid = quantise(base, { grid: 0.4 });
  assert.deepEqual(YAML.parse(grid.text).voices[0].patterns.A.groove.map((e) => e.len), [1.2, 0.8, 1.6, 0.4]);
  const unchanged = quantise(score({ lens: [1.5, 0.5, 1.5, 0.5] }), { grid: 0.5 });
  assert.deepEqual(unchanged.report.changed, []);
});

test("quantise rejects a grid that is not positive and finite and a grid that cannot keep the length", () => {
  for (const grid of [0, -0.5, Number.NaN, Infinity]) fails(() => quantise(base, { grid }), "precondition", "grid must be positive and finite");
  fails(() => quantise(score({ lens: [1.25, 0.75, 1.5, 0.5] }), { grid: 0.5 }), "unsupported", "Grid cannot preserve pattern length at /voices/0/patterns/A");
  fails(() => quantise("a: [", { grid: 1 }), "input");
});

test("restructure reorders the timeline of a sectioned score", () => {
  const r = restructure(base, { order: ["main", "intro", "main"] });
  assert.equal(r.text, score({ timeline: '["main", "intro", "main"]' }));
  assert.deepEqual(r.report, { changed: ["/timeline"], preserved: ["section definitions and contents"], warnings: [] });
  valid(r.text);
  const withEntries = base.replace('timeline: ["intro", "main", "intro"]', 'timeline:\n  - {use: "main", layers: {v1: "A"}}\n  - "intro"');
  assert.deepEqual(YAML.parse(restructure(withEntries, { order: ["intro", "main"] }).text).timeline, ["intro", { use: "main", layers: { v1: "A" } }]);
});

test("restructure keeps timeline entries with their modifiers, overrides and inline definitions", () => {
  const text = 'sidwave: 1.0\ntimeline:\n  - {section: "a", bars: 1}\n  - "b+2"\n  - {use: "c"}\n';
  assert.equal(restructure(text, { order: ["c", "a"], validate: "none" }).text, 'sidwave: 1.0\ntimeline:\n  - use: "c"\n  - section: "a"\n    bars: 1\n');
  assert.equal(restructure(text, { order: ["b", "b", "a", "a"], validate: "none" }).text, 'sidwave: 1.0\ntimeline:\n  - "b+2"\n  - "b+2"\n  - section: "a"\n    bars: 1\n  - "a"\n');
  const sectioned = score({ timeline: '["intro", "main+2", "main*2"]' });
  assert.equal(restructure(sectioned, { order: ["main", "intro"] }).text, score({ timeline: '["main+2", "intro"]' }));
});

test("restructure rejects unknown names, bad orders and a sectioned score without timeline", () => {
  fails(() => restructure(base, { order: ["missing"] }), "precondition", "Unknown section or sequence item missing");
  fails(() => restructure(base, { order: "intro" }), "precondition", "order must be an array of names");
  fails(() => restructure(base, { order: [1] }), "precondition", "order must be an array of names");
  fails(() => restructure(base.replace(/timeline:.*\n/, ""), { order: ["intro"], validate: "none" }), "precondition", "Document has no timeline");
  fails(() => restructure("a: [", { order: [] }), "input");
});

test("humanise varies explicit durations deterministically and keeps pitches and pattern lengths", () => {
  const r = humanise(base, { seed: 1, maxShift: 0.1 });
  assert.equal(r.text, score({ lens: [1.3254147881176324, 0.6745852118823676, 1.5005471442360432, 0.4994528557639569] }));
  assert.deepEqual(r.report, {
    changed: ["/voices/0/patterns/A/groove/0/len", "/voices/0/patterns/A/groove/1/len", "/voices/0/patterns/A/groove/2/len", "/voices/0/patterns/A/groove/3/len"],
    preserved: ["note pitches", "instrument references", "pattern lengths"],
    warnings: ["/voices/0/patterns/B/groove uses implicit note lengths; unchanged", "/voices/1/patterns/A/groove uses implicit note lengths; unchanged", "/voices/1/patterns/C/groove uses implicit note lengths; unchanged"],
  });
  valid(r.text);
  const lens = YAML.parse(r.text).voices[0].patterns.A.groove.map((e) => e.len);
  assert.ok(Math.abs(lens[0] + lens[1] - 2) < 1e-9 && Math.abs(lens[2] + lens[3] - 2) < 1e-9);
  assert.equal(humanise(base, { seed: 1, maxShift: 0.1 }).text, r.text);
  assert.notEqual(humanise(base, { seed: 2, maxShift: 0.1 }).text, r.text);
  assert.equal(humanise(base, { seed: 1 + 2 ** 32, maxShift: 0.1 }).text, r.text);
});

test("humanise honours scope, a zero shift and patterns without explicit durations", () => {
  assert.deepEqual(humanise(base, { seed: 1, maxShift: 0.1, scope: { voices: ["Bass"] } }).report.changed, []);
  assert.deepEqual(humanise(base, { seed: 1, maxShift: 0.1, scope: { voices: ["Bass"] } }).report.warnings, ["/voices/1/patterns/A/groove uses implicit note lengths; unchanged", "/voices/1/patterns/C/groove uses implicit note lengths; unchanged"]);
  assert.equal(humanise(base, { seed: 1, maxShift: 0.1, scope: { voices: ["1"] } }).text, humanise(base, { seed: 1, maxShift: 0.1 }).text);
  const zero = humanise(base, { seed: 1, maxShift: 0 });
  assert.equal(zero.text, base);
  assert.deepEqual(zero.report, { changed: [], preserved: ["pitches", "pattern lengths"], warnings: ["maxShift is zero; no variation applied."] });
  const noLen = base.replace(/ len: [0-9.]+/g, "");
  assert.deepEqual(humanise(noLen, { seed: 1, maxShift: 0.1 }).report.warnings[0], "/voices/0/patterns/A has no explicit per-note len; unchanged");
  const notes = 'sidwave: 1.2\nvoices:\n  - id: 1\n    patterns:\n      A:\n        notes:\n          - {note: "C4", len: 1}\n          - {note: "D4", len: 3}\n          - "E4"\n';
  const r = humanise(notes, { seed: 5, maxShift: 0.5, validate: "none" });
  assert.deepEqual(r.report.changed, ["/voices/0/patterns/A/notes/0/len", "/voices/0/patterns/A/notes/1/len"]);
  const lens = YAML.parse(r.text).voices[0].patterns.A.notes.slice(0, 2).map((e) => e.len);
  assert.ok(Math.abs(lens[0] + lens[1] - 4) < 1e-9 && lens[0] !== 1);
});

test("humanise rejects bad arguments and shifts that would make a duration nonpositive", () => {
  fails(() => humanise(base, { seed: 1.5, maxShift: 0.1 }), "precondition", "seed must be an integer");
  fails(() => humanise(base, { seed: 1, maxShift: -1 }), "precondition", "maxShift must be finite and nonnegative");
  fails(() => humanise(base, { seed: 1, maxShift: Number.NaN }), "precondition", "maxShift must be finite and nonnegative");
  fails(() => humanise(base, { seed: 1, maxShift: 10 }), "unsupported", "Bounded variation would make duration nonpositive at /voices/0/patterns/A/groove/1/len");
  fails(() => humanise("a: [", { seed: 1, maxShift: 0.1 }), "input");
});

const allExamples = (await readdir(new URL("../data/sound/examples/", import.meta.url))).filter((f) => f.endsWith(".yaml")).sort();
const timelineNames = (text) => (YAML.parse(text).timeline ?? []).map((e) => (typeof e === "string" ? e.split(/[+*]/)[0] : e?.section ?? e?.use)).filter(Boolean);
const matrix = (text) => [
  ...[-12, -1, 1, 5, 7, 12].map((semitones) => [`transpose ${semitones}`, () => transpose(text, { semitones })]),
  ...[80, 200].map((bpm) => [`setTempo ${bpm}`, () => setTempo(text, { bpm })]),
  ...[0.9, 1.5, 2].map((factor) => [`scaleTempo ${factor}`, () => scaleTempo(text, { factor })]),
  ...[0.5, 1].map((grid) => [`quantise ${grid}`, () => quantise(text, { grid })]),
  ["restructure reversed", () => restructure(text, { order: timelineNames(text).reverse() })],
  ["humanise", () => humanise(text, { seed: 3, maxShift: 0.05 })],
];
const documented = ["precondition", "out_of_range", "unsupported"];
for (const name of allExamples) {
  test(`transformations of ${name} return a valid compiled score or a documented error`, { timeout: 900000 }, async () => {
    const text = await readFile(new URL(`../data/sound/examples/${name}`, import.meta.url), "utf8");
    let succeeded = 0;
    for (const [label, call] of matrix(text)) {
      let r;
      try { r = call(); } catch (e) {
        assert.ok(e instanceof SidwaveTransformError && documented.includes(e.code), `${name} ${label}: ${e?.stack ?? e}`);
        continue;
      }
      valid(r.text);
      assert.equal(formatSidwave(r.text), r.text, `${name} ${label} is canonical`);
      succeeded++;
    }
    assert.ok(succeeded >= 3, `${name}: ${succeeded} transformations succeeded`);
    assert.deepEqual(pitches(humanise(text, { seed: 3, maxShift: 0.05 }).text), pitches(text));
  });
}

test("transformations refuse results that the compiler rejects, naming the compiler message", () => {
  const read = (name) => readFile(new URL(`../data/sound/examples/${name}`, import.meta.url), "utf8");
  const refused = async (name, call, pattern) => {
    const text = await read(name);
    assert.throws(() => call(text), (e) => e instanceof SidwaveTransformError && e.code === "precondition" && pattern.test(e.message), `${name}: ${pattern}`);
  };
  return Promise.all([
    refused("drum_and_bass.yaml", (x) => transpose(x, { semitones: 1 }), /^The result does not compile: .*outside the playable SID frequency range on PAL/),
    refused("acid_line.yaml", (x) => setTempo(x, { bpm: 200 }), /^The result (does not compile|is not a valid SIDWave score): /),
    refused("ambient_filter.yaml", (x) => setTempo(x, { bpm: 120 }), /^The result (does not compile|is not a valid SIDWave score): /),
    refused("acid_line.yaml", (x) => scaleTempo(x, { factor: 1.1 }), /^The result does not compile: Invalid SIDWAVE at \$\.timeline\[6\]/),
    refused("chiptune_drive.yaml", (x) => quantise(x, { grid: 1 }), /^The result does not compile: /),
  ]);
});

test("validate: parse accepts a result that parses but does not compile, validate: none skips the check", async () => {
  const text = await readFile(new URL("../data/sound/examples/drum_and_bass.yaml", import.meta.url), "utf8");
  assert.throws(() => transpose(text, { semitones: 1 }), (e) => e.code === "precondition");
  const parsed = transpose(text, { semitones: 1, validate: "parse" });
  parseSidwave(parsed.text);
  assert.throws(() => compileSidwaveToPrg(parseSidwave(parsed.text), { loop: false }), /outside the playable SID frequency range/);
  assert.equal(transpose(text, { semitones: 1, validate: "none" }).text, parsed.text);
  assert.throws(() => transpose("sidwave: 1.2\ntitle: x\n", { semitones: 1 }), (e) => e.code === "input" && /^The input is not a valid SIDWave score: /.test(e.message));
});

test("README example: transpose and setTempo", () => {
  const demo = formatSidwave(`title: Demo
sidwave: 1.2
tempo: 120
voices:
  - id: 1
    patterns:
      A: { groove: "C4 ~ ~ ~", length: 1 }
timeline: [{ bars: 1, layers: { v1: A } }]
`);
  const up = transpose(demo, { semitones: 2 });
  assert.deepEqual(up.report.changed, ["/voices/0/patterns/A/groove"]);
  assert.ok(up.text.includes('groove: "D4 ~ ~ ~"'));
  assert.deepEqual(setTempo(up.text, { bpm: 90 }).report.changed, ["/tempo"]);
  valid(up.text);
});

test("every transformation rejects text that is not a score mapping with code input", () => {
  const calls = [
    (x) => transpose(x, { semitones: 1 }), (x) => setTempo(x, { bpm: 90 }), (x) => scaleTempo(x, { factor: 1 }),
    (x) => substituteInstrument(x, { from: "a", to: "lib:kick" }), (x) => quantise(x, { grid: 1 }),
    (x) => restructure(x, { order: [] }), (x) => humanise(x, { seed: 1, maxShift: 0.1 }),
  ];
  for (const call of calls) for (const input of ["- a\n", "plain text\n", "", "a: [\n"]) fails(() => call(input), "input");
  fails(() => transpose("- a\n", { semitones: 1 }), "input", "The input is not a SIDWave score: expected a YAML mapping at the top level");
});
