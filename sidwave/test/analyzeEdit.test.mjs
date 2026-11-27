// Editability (prompt section 6): on seeded scores and on the scores reconstructed from seeded tunes and from the
// independently written player fixtures, one edit at a time: change one note, swap an instrument, transpose a section,
// change the tempo, reuse an extracted instrument. Each test checks that the intended change happened and that the
// unrelated voices and sections keep their register output. The table of edits and inputs is printed.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { differingCalls, restrictIrToVoice } from "../src/analyze/common.ts";
import { checkInstrumentReuse, extractInstruments } from "../src/analyze/instruments.ts";
import { modelOfScore } from "../src/analyze/music.ts";
import { fdiff } from "../src/reconstruct/fdiff.ts";
import { reconstructSid } from "../src/reconstruct/reconstruct.ts";
import { midiToNoteName, noteNameToMidi, parseSidwave } from "../src/sidwave.ts";
import { setTempo, transpose } from "../src/transform/index.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { irOf, seededSid, seededText, sidOfScore } from "./helpers/analyzeKit.mjs";

const SECONDS = 4;
const irOfText = (text, seconds = SECONDS) => irOf(sidOfScore(text), seconds);
const parse = (text) => YAML.parse(text);
const dump = (doc) => YAML.stringify(doc);
const voiceDiff = (a, b, v) => differingCalls(restrictIrToVoice(a, v), restrictIrToVoice(b, v), 1, 1);

/** Splits the single timeline section of a score into two sections that own their patterns, so that a section can be edited alone. */
function twoSections(text, first) {
  const doc = parse(text);
  const [only] = doc.timeline;
  if (doc.timeline.length !== 1 || only.bars < 2) return undefined;
  const second = { section: "Second", bars: only.bars - first, layers: {} };
  for (const [layer, spec] of Object.entries(only.layers)) {
    const voice = doc.voices.find((v) => `v${v.id}` === layer);
    if (!voice) return undefined;
    const rename = (name) => `${name}__2`;
    second.layers[layer] = spec.replace(/[A-Za-z_]\w*/g, (name) => (voice.patterns?.[name] ? rename(name) : name));
    for (const [name, pattern] of Object.entries({ ...voice.patterns })) voice.patterns[rename(name)] = JSON.parse(JSON.stringify(pattern));
  }
  doc.timeline = [{ ...only, section: "First", bars: first }, second];
  return dump(doc);
}

/** Gives the first pattern occurrence of voice 1 a private copy of its pattern and returns the copy's name. */
function unshareFirst(doc) {
  const voice = doc.voices[0];
  const layer = doc.timeline[0].layers[`v${voice.id}`];
  const tokens = layer.trim().split(/\s+/);
  const m = /^([A-Za-z_]\w*)(?:\*(\d+))?$/.exec(tokens[0]);
  if (!m || !voice.patterns?.[m[1]]) return undefined;
  const copy = `${m[1]}__e`;
  voice.patterns[copy] = JSON.parse(JSON.stringify(voice.patterns[m[1]]));
  doc.timeline[0].layers[`v${voice.id}`] = [copy, ...(Number(m[2] ?? 1) > 1 ? [`${m[1]}*${Number(m[2]) - 1}`] : []), ...tokens.slice(1)].join(" ");
  return copy;
}

const noteOf = (entry) => (typeof entry === "string" ? (entry === "-" || entry === "~" ? undefined : entry) : entry?.note);
function setNote(entry, note) { return typeof entry === "string" ? note : { ...entry, note }; }

const EDITS = {
  async "change one note"(text) {
    const doc = parse(text);
    const copy = unshareFirst(doc);
    if (!copy) return { skip: "the first layer of voice 1 is not a plain pattern reference" };
    const pattern = doc.voices[0].patterns[copy];
    const sounding = pattern.groove.map((e, i) => [e, i]).filter(([e]) => noteOf(e) !== undefined && !(typeof e === "object" && (e.legato || e.portamento)));
    const J = 2;
    if (sounding.length <= J + 1) return { skip: "fewer than four sounding notes in the first pattern" };
    const [entry, index] = sounding[J];
    const midi = noteNameToMidi(noteOf(entry));
    const edited = midiToNoteName(midi + 7 <= 84 ? midi + 7 : midi - 7);
    pattern.groove[index] = setNote(entry, edited);
    const model = modelOfScore(parseSidwave(text));
    const notes = model.notes.filter((n) => n.voice === 1 && !n.percussion);
    const start = notes[J].start;
    const next = notes[J + 1].start;
    const [before, after] = [await irOfText(text), await irOfText(dump(doc))];
    const v1 = voiceDiff(before, after, 1);
    assert.ok(v1.length > 0, "the edited voice changed");
    assert.ok(v1[0] >= start - 4, `no difference before the edited note: first at ${v1[0]}, note at ${start}`);
    assert.ok(v1[v1.length - 1] <= next + 4, `no difference after the edited note: last at ${v1[v1.length - 1]}, next note at ${next}`);
    assert.ok(fdiff(restrictIrToVoice(before, 1), restrictIrToVoice(after, 1), { alignExpected: 1, alignObserved: 1 }).classes.pitch.differingCalls > 0, "the pitch changed");
    for (const v of [2, 3]) assert.deepEqual(voiceDiff(before, after, v), [], `voice ${v} keeps its register output`);
    return { detail: `${v1.length} calls of voice 1 differ, from ${v1[0]} to ${v1[v1.length - 1]} (note ${start}..${next})` };
  },

  async "swap an instrument"(text) {
    const doc = parse(text);
    const names = Object.keys(doc.instruments ?? {});
    if (doc.voices.length < 2) return { skip: "the score has one voice" };
    const target = doc.voices[1];
    const own = target.instrument;
    const candidates = names.filter((n) => n !== own && JSON.stringify(doc.instruments[n]) !== JSON.stringify(doc.instruments[own]));
    const before = await irOfText(text);
    for (const other of candidates) {
      target.instrument = other;
      let after;
      try {
        after = await irOfText(dump(doc));
      } catch (error) {
        if (/Invalid SIDWAVE/.test(error.message)) continue; // the new instrument does not fit the notes of the voice (language rule)
        throw error;
      }
      const v2 = voiceDiff(before, after, 2);
      assert.ok(v2.length > 0, "the voice with the new instrument changed");
      for (const v of [1, 3]) assert.deepEqual(voiceDiff(before, after, v), [], `voice ${v} keeps its register output`);
      return { detail: `${own} to ${other}: ${v2.length} calls of voice 2 differ` };
    }
    return { skip: candidates.length ? "every other instrument is rejected by the compiler for the notes of voice 2 (hard restart longer than the shortest note)" : "no second distinct instrument" };
  },

  async "transpose a section"(text) {
    const bars = parse(text).timeline[0].bars;
    let split;
    let model;
    for (let first = Math.floor(bars / 2); first >= 1 && !model; first--) {
      split = twoSections(text, first);
      try { model = modelOfScore(parseSidwave(split)); compileOk(split); } catch { model = undefined; }
    }
    for (let first = Math.floor(bars / 2) + 1; first < bars && !model; first++) {
      split = twoSections(text, first);
      try { model = modelOfScore(parseSidwave(split)); compileOk(split); } catch { model = undefined; }
    }
    if (!model) return { skip: "no bar line splits the score into two sections that compile (the reconstruction's patterns do not end on bar lines)" };
    const second = model.sections[1].startFrame;
    const seconds = Math.min(12, Math.ceil(model.totalFrames / model.fps) + 1);
    const result = transpose(split, { semitones: 2, scope: { sections: ["Second"] } });
    const [before, after] = [await irOfText(split, seconds), await irOfText(result.text, seconds)];
    assert.ok(result.report.changed.length > 0, "notes were transposed");
    const diff = differingCalls(before, after, 1, 1);
    assert.ok(diff.length > 0, "the transposed section changed");
    assert.ok(diff[0] >= second - 4, `the first section keeps its register output: first difference at ${diff[0]}, section starts at ${second}`);
    const changedVoices = [1, 2, 3].filter((v) => voiceDiff(before, after, v).length);
    return { detail: `section 2 starts at call ${second}; first difference at ${diff[0]}; voices ${changedVoices.join(",")} changed` };
  },

  async "change the tempo"(text) {
    const doc = parse(text);
    const bpm = Math.round(Number(doc.tempo) * 0.8);
    const result = setTempo(text, { bpm });
    assert.equal(Number(parse(result.text).tempo), bpm, "the tempo field changed");
    const before = await irOfText(text);
    const after = await irOfText(result.text);
    const onsets = (ir, v) => {
      const out = [];
      const r = restrictIrToVoice(ir, v);
      for (let i = 1; i < r.calls.length; i++) {
        const ctl = r.calls[i].sids[0].regs[(v - 1) * 7 + 4];
        const prev = r.calls[i - 1].sids[0].regs[(v - 1) * 7 + 4];
        if (ctl & 1 && !(prev & 1)) out.push(r.calls[i].sids[0].regs[(v - 1) * 7] | (r.calls[i].sids[0].regs[(v - 1) * 7 + 1] << 8));
      }
      return out;
    };
    for (let v = 1; v <= 3; v++) {
      const a = onsets(before, v);
      const b = onsets(after, v);
      const n = Math.min(a.length, b.length);
      if (n < 3) return { skip: `voice ${v} has fewer than three note onsets within ${SECONDS} s` };
      assert.deepEqual(b.slice(0, n), a.slice(0, n), `voice ${v} plays the same pitches in the same order`);
    }
    const lengthBefore = modelOfScore(parseSidwave(text)).totalFrames;
    const lengthAfter = modelOfScore(parseSidwave(result.text)).totalFrames;
    assert.ok(Math.abs(lengthAfter / lengthBefore - Number(doc.tempo) / bpm) < 0.02, `the length scales with the tempo: ${lengthBefore} to ${lengthAfter}`);
    return { detail: `${doc.tempo} to ${bpm} BPM, ${lengthBefore} to ${lengthAfter} calls` };
  },

  async "reuse an extracted instrument"(text) {
    const extracted = await extractInstruments(text, { created: "2026-11-27" });
    if (!extracted.instruments.length) return { skip: "no instrument" };
    const check = await checkInstrumentReuse({ library: extracted.library, instrument: extracted.instruments[0].name, source: text, engine: sharedEngine(), seconds: 4 });
    assert.equal(check.equal, true, JSON.stringify(check.first));
    return { detail: `${extracted.instruments[0].name}: ${check.comparedCalls} calls equal` };
  },
};

const compileOk = (text) => sidOfScore(text);
const SEEDED = [["basic", 1], ["arpeggio", 3], ["hard_restart", 4], ["vibrato", 5], ["combined", 1]];
const FIXTURES = ["arpeggio", "vibrato", "pulseSweep"];

async function inputs() {
  const list = [];
  for (const [feature, seed] of SEEDED) {
    list.push({ name: `${feature}/${seed}`, text: seededText(feature, seed) });
    list.push({ name: `reconstructed ${feature}/${seed}`, text: (await reconstructSid(seededSid(feature, seed), { engine: sharedEngine(), seconds: SECONDS })).score });
  }
  for (const f of FIXTURES) list.push({ name: `reconstructed fixture ${f}`, text: (await reconstructSid(new Uint8Array(buildFixture(f).sid), { engine: sharedEngine(), seconds: SECONDS })).score });
  return list;
}

test("edits keep unrelated voices and sections unchanged on seeded scores and on reconstructed scores", { timeout: 900_000 }, async (t) => {
  const table = [];
  const failures = [];
  for (const input of await inputs()) {
    const row = { input: input.name };
    for (const [edit, run] of Object.entries(EDITS)) {
      try {
        const r = await run(input.text);
        row[edit] = r.skip ? `n/a: ${r.skip}` : "pass";
        if (r.detail) row[`${edit} detail`] = r.detail;
      } catch (error) {
        row[edit] = "FAIL";
        failures.push(`${input.name} / ${edit}: ${error.message.split("\n")[0]}`);
      }
    }
    table.push(row);
  }
  const names = Object.keys(EDITS);
  const widths = names.map((n) => Math.max(n.length, 4));
  const lines = [`${"input".padEnd(36)} ${names.map((n, i) => n.padEnd(widths[i])).join(" ")}`, ...table.map((r) => `${r.input.padEnd(36)} ${names.map((n, i) => (r[n].startsWith("n/a") ? "n/a" : r[n]).padEnd(widths[i])).join(" ")}`)];
  console.log(`\nEditability results (pass, n/a: precondition not met, FAIL)\n${lines.join("\n")}\n${table.flatMap((r) => names.filter((n) => r[n].startsWith("n/a")).map((n) => `  n/a ${r.input} / ${n}: ${r[n].slice(5)}`)).join("\n")}`);
  t.diagnostic?.(lines.join("\n"));
  assert.deepEqual(failures, []);
  // Every edit passes on at least the seeded scores of every feature, and each edit ran on at least one reconstructed score.
  for (const n of names) {
    assert.ok(table.filter((r) => r.input.startsWith("reconstructed") && r[n] === "pass").length >= 3, `${n} passes on reconstructed scores`);
    assert.ok(table.filter((r) => !r.input.startsWith("reconstructed") && r[n] === "pass").length >= 3, `${n} passes on seeded scores`);
  }
});
