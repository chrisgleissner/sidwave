import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import { parseSidwave } from "../src/sidwave.js";
import { exportEvents, EVENT_SCHEMA } from "../src/interchange/events.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const BASE = {
  sidwave: 1.4,
  tempo: 120,
  instruments: { p: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, b: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [
    { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" }, c: { length: 0.5, bars: 1, groove: "E5 D5 C5 B4 A4 G4 F4 E4" } } },
    { id: 2, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" }, q: { length: 1, bars: 1, groove: "F2 F2 A2 A2" } } },
  ],
  sections: { x: { bars: 2, layers: { v1: "a", v2: "r" } }, y: { bars: 2, layers: { v1: "c", v2: "q" } } },
  songs: [{ name: "one", timeline: ["x", "y"] }, { name: "two", timeline: ["y", "x", "y"], tempo: 90 }],
};
const parse = (obj) => parseSidwave(yaml.stringify(obj));

test("event export has a documented shape and consistent times", () => {
  const exported = exportEvents(parseSidwave(readExampleScore("fuer_elise")));
  assert.equal(exported.schema, EVENT_SCHEMA);
  assert.equal(exported.ppq, 480);
  assert.ok(exported.voices.length >= 1);
  assert.ok(exported.tempoMap.length >= 1 && exported.tempoMap[0].tick === 0);
  assert.ok(exported.timeSignatures[0].numerator > 0);
  const byId = new Map();
  for (const voice of exported.voices) {
    let previousEnd = -1;
    for (const note of voice.notes) {
      byId.set(note.id, note);
      assert.ok(note.velocity >= 1 && note.velocity <= 127);
      assert.ok(note.off.tick > note.on.tick, "positive duration");
      assert.ok(note.off.time > note.on.time);
      assert.ok(note.on.tick >= previousEnd, "a voice is monophonic");
      previousEnd = note.off.tick;
      assert.ok(exported.instruments.some((inst) => inst.index === note.instrument));
    }
  }
  // The flat event list pairs every noteOn with one noteOff of the same note and is in time order.
  const ons = exported.events.filter((e) => e.type === "noteOn");
  const offs = exported.events.filter((e) => e.type === "noteOff");
  assert.equal(ons.length, byId.size);
  assert.equal(offs.length, byId.size);
  for (let i = 1; i < exported.events.length; i++) assert.ok(exported.events[i].tick >= exported.events[i - 1].tick);
  for (const off of offs) assert.equal(off.tick, byId.get(off.note).off.tick);
  // Seconds agree with the tempo map: the tick of a time is within a few ticks of the integrated map.
  const last = exported.tempoMap[exported.tempoMap.length - 1];
  const sample = ons[ons.length - 1];
  const expectedTick = last.tick + (sample.time - last.time) * last.bpm / 60 * exported.ppq;
  assert.ok(Math.abs(expectedTick - sample.tick) < 12, `${expectedTick} vs ${sample.tick}`);
  assert.ok(Array.isArray(exported.losses) && exported.losses.length > 0);
  assert.doesNotThrow(() => JSON.stringify(exported));
});

test("song selection, tempo of the song and ppq", () => {
  const doc = parse(BASE);
  const one = exportEvents(doc, { song: 0 });
  const two = exportEvents(doc, { song: 1, ppq: 96 });
  assert.equal(one.tempoMap[0].bpm, 120);
  assert.equal(two.tempoMap[0].bpm, 90);
  assert.equal(two.ppq, 96);
  assert.ok(two.durationSeconds > one.durationSeconds, "song two is 3 sections at 90 BPM");
  assert.equal(one.voices[0].notes.length, 4 * 2 + 8 * 2);
  assert.throws(() => exportEvents(doc, { song: 2 }), /does not exist/);
  assert.throws(() => exportEvents(doc, { ppq: 5 }), /ppq/);
});

test("section metre and tempo ramps appear in the maps", () => {
  const doc = parse({
    sidwave: 1.3, tempo: 100,
    voices: [{ id: 1, waveform: "pulse", patterns: { w: { length: 1, bars: 1, groove: "C4 E4 G4" }, v: { length: 0.5, bars: 1, groove: "C4 D4 E4 F4 G4 A4" } } }],
    timeline: [
      { section: "waltz", bars: 2, meter: "3/4", layers: { v1: "w" } },
      { section: "six", bars: 2, meter: "6/8", tempo: { to: 140 }, layers: { v1: "v" } },
    ],
  });
  const exported = exportEvents(doc);
  assert.deepEqual(exported.timeSignatures.map((s) => `${s.numerator}/${s.denominator}@${s.bar}`), ["3/4@1", "6/8@3"]);
  assert.ok(exported.tempoMap.length > 2, "a ramp becomes one tempo per beat");
  assert.equal(exported.tempoMap[0].bpm, 100);
  const bpms = exported.tempoMap.map((t) => t.bpm);
  assert.ok(bpms[bpms.length - 1] > 100 && bpms.every((b, i) => i === 0 || b >= bpms[i - 1]));
  assert.deepEqual(exported.sections.map((s) => [s.name, s.bar, s.bars]), [["waltz", 1, 2], ["six", 3, 2]]);
  assert.ok(exported.losses.some((l) => /ramp/i.test(l)));
});

test("bends, legato and accents are exported as note effects", () => {
  const doc = parse({
    sidwave: 1.3, tempo: 100, accent: 2,
    voices: [{ id: 1, waveform: "pulse", patterns: { a: { length: 1, bars: 1, groove: [{ note: "C4", bend: { to: 2, frames: 6 } }, { note: "E4", accented: true }, "G4", "-"] } } }],
    timeline: [{ section: "a", bars: 1, layers: { v1: "a" } }],
  });
  const notes = exportEvents(doc).voices[0].notes;
  assert.equal(notes[0].effects.bend.from, 60);
  assert.equal(notes[0].effects.bend.to, 62);
  assert.ok(notes[0].effects.bend.seconds > 0);
  assert.equal(notes[1].effects.accented, true);
});
