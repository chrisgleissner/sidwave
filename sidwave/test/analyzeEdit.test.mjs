// Editability (prompt section 6): on seeded scores and on the scores reconstructed from seeded tunes and from the
// independently written player fixtures, one edit at a time: change one note, swap an instrument, transpose a section,
// change the tempo, reuse an extracted instrument. Each test checks that the intended change happened and that the
// unrelated voices and sections keep their register output. The table of edits and inputs is printed.
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";
import { differingCalls, restrictIrToVoice } from "../src/analyze/common.ts";
import { checkInstrumentReuse, extractInstruments } from "../src/analyze/instruments.ts";
import { modelOfScore, modelOfScoreText } from "../src/analyze/music.ts";
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

/**
 * Gives one pattern occurrence a private copy of its pattern. Any voice, section and layer token is tried; the occurrence
 * is the one whose pattern has a plain sounding note, so every pattern layout of a reconstruction is covered.
 * Returns { doc, voice, copy } for the candidate at `skip`, or undefined.
 */
function unshare(text, skip) {
  let n = 0;
  const doc = parse(text);
  for (const [vi, voice] of doc.voices.entries()) {
    for (const [si, section] of doc.timeline.entries()) {
      const key = `v${voice.id ?? vi + 1}`;
      if (typeof section.layers?.[key] !== "string") continue;
      const tokens = section.layers[key].trim().split(/\s+/);
      for (const [ti, token] of tokens.entries()) {
        const m = /^([A-Za-z_]\w*)(?:\*(\d+))?$/.exec(token);
        const pattern = m && voice.patterns?.[m[1]];
        if (!pattern || !Array.isArray(pattern.groove)) continue;
        const plain = pattern.groove.map((e, i) => [e, i]).filter(([e]) => noteOf(e) !== undefined && !(typeof e === "object" && (e.legato || e.portamento || e.slide_from || e.bend)));
        if (!plain.length || n++ < skip) continue;
        const copy = `${m[1]}__e${ti}`;
        voice.patterns[copy] = JSON.parse(JSON.stringify(pattern));
        const count = Number(m[2] ?? 1);
        tokens.splice(ti, 1, copy, ...(count > 1 ? [`${m[1]}*${count - 1}`] : []));
        section.layers[key] = tokens.join(" ");
        return { doc, voice: vi + 1, copy, plain: plain.map(([, i]) => i), pattern: voice.patterns[copy] };
      }
    }
  }
  return undefined;
}

const noteOf = (entry) => (typeof entry === "string" ? (entry === "-" || entry === "~" || entry.includes(" ") || entry.includes("|") ? undefined : entry) : entry?.note);
function setNote(entry, note) { return typeof entry === "string" ? note : { ...entry, note }; }

const EDITS = {
  async "change one note"(text) {
    const before = await irOfText(text);
    const original = modelOfScoreText(text);
    const horizon = SECONDS * original.fps - 20;
    for (let skip = 0; skip < 40; skip++) {
      const c = unshare(text, skip);
      if (!c) break;
      // The note in the middle of the pattern's sounding entries, so that it has a predecessor and a successor when possible.
      const index = c.plain[c.plain.length >> 1];
      const entry = c.pattern.groove[index];
      const midi = noteNameToMidi(noteOf(entry));
      if (midi === undefined) continue;
      c.pattern.groove[index] = setNote(entry, midiToNoteName(midi + 7 <= 84 ? midi + 7 : midi - 7));
      const edited = dump(c.doc);
      const after = modelOfScoreText(edited);
      const changed = after.notes.map((n, i) => [n, original.notes[i]]).filter(([n, o]) => o && (n.midi !== o.midi || n.voice !== o.voice));
      if (after.notes.length !== original.notes.length || changed.length !== 1) continue;
      const [note] = changed[0];
      const later = after.notes.filter((n) => n.voice === note.voice && n.start > note.start).map((n) => n.start);
      const next = later.length ? later[0] : Infinity;
      if (note.start > horizon) continue;
      try { sidOfScore(edited); } catch { continue; }
      const after_ir = await irOfText(edited);
      const v = note.voice;
      const diff = voiceDiff(before, after_ir, v);
      assert.ok(diff.length > 0, "the edited voice changed");
      assert.ok(diff[0] >= note.start - 4, `no difference before the edited note: first at ${diff[0]}, note at ${note.start}`);
      assert.ok(diff[diff.length - 1] <= next + 4, `no difference after the edited note: last at ${diff[diff.length - 1]}, next note at ${next}`);
      assert.ok(fdiff(restrictIrToVoice(before, v), restrictIrToVoice(after_ir, v), { alignExpected: 1, alignObserved: 1 }).classes.pitch.differingCalls > 0, "the pitch changed");
      for (let other = 1; other <= 3; other++) if (other !== v) assert.deepEqual(voiceDiff(before, after_ir, other), [], `voice ${other} keeps its register output`);
      return { detail: `voice ${v}: ${diff.length} calls differ, from ${diff[0]} to ${diff[diff.length - 1]} (note ${note.start}..${next})` };
    }
    return { skip: "no sounding note inside the horizon that can be edited alone" };
  },

  async "swap an instrument"(text) {
    const doc = parse(text);
    const target = doc.voices[doc.voices.length > 1 ? 1 : 0];
    const own = target.instrument;
    const names = Object.keys(doc.instruments ?? {});
    const before = await irOfText(text);
    // Candidates: the other instruments of the score, then a variant of the voice's own instrument with another envelope.
    const candidates = names.filter((n) => n !== own && JSON.stringify(doc.instruments[n]) !== JSON.stringify(doc.instruments[own])).map((n) => [n, doc]);
    for (const adsr of [[0, 0, 15, 0], [2, 4, 8, 4]]) {
      const variant = parse(text);
      variant.instruments[`${own}_alt`] = { ...variant.instruments[own], adsr };
      candidates.push([`${own}_alt`, variant]);
    }
    for (const [other, base] of candidates) {
      const trial = JSON.parse(JSON.stringify(base));
      trial.voices[doc.voices.indexOf(target)].instrument = other;
      let after;
      try {
        after = await irOfText(dump(trial));
      } catch (error) {
        if (/Invalid SIDWAVE/.test(error.message)) continue; // the instrument does not fit the notes of the voice (language rule)
        throw error;
      }
      const v = doc.voices.indexOf(target) + 1;
      const diff = voiceDiff(before, after, v);
      if (!diff.length) continue;
      for (let o = 1; o <= 3; o++) if (o !== v) assert.deepEqual(voiceDiff(before, after, o), [], `voice ${o} keeps its register output`);
      return { detail: `${own} to ${other}: ${diff.length} calls of voice ${v} differ` };
    }
    return { skip: "every candidate instrument is rejected by the compiler for the notes of the voice or leaves its registers unchanged" };
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
    const m0 = modelOfScoreText(split);
    const m1 = modelOfScoreText(result.text);
    assert.equal(m1.notes.length, m0.notes.length);
    const secondFrame = m0.sections[1].startFrame;
    let moved = 0;
    m0.notes.forEach((n, i) => {
      const delta = m1.notes[i].midi - n.midi;
      if (n.start < secondFrame) assert.equal(delta, 0, `note ${i} of section 1 is unchanged`);
      else if (!n.percussion) { assert.equal(delta, 2, `note ${i} of section 2 moved by exactly 2 semitones`); moved++; }
    });
    assert.ok(moved > 0, "section 2 has pitched notes");
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
    let compared = 0;
    for (let v = 1; v <= 3; v++) {
      const a = onsets(before, v);
      const b = onsets(after, v);
      const n = Math.min(a.length, b.length);
      if (n >= 1) { compared++; assert.deepEqual(b.slice(0, n), a.slice(0, n), `voice ${v} plays the same pitches in the same order`); }
    }
    assert.ok(compared >= 1, "at least one voice has a note onset in the horizon");
    const seq = (m) => m.notes.map((n) => `${n.voice}:${n.midi}`).join(",");
    assert.equal(seq(modelOfScoreText(result.text)), seq(modelOfScoreText(text)), "the whole note sequence is unchanged");
    const lengthBefore = modelOfScoreText(text).totalFrames;
    const lengthAfter = modelOfScoreText(result.text).totalFrames;
    assert.ok(Math.abs(lengthAfter / lengthBefore - Number(doc.tempo) / bpm) < 0.02, `the length scales with the tempo: ${lengthBefore} to ${lengthAfter}`);
    return { detail: `${doc.tempo} to ${bpm} BPM, ${lengthBefore} to ${lengthAfter} calls` };
  },

  async "reuse an extracted instrument"(text) {
    const extracted = await extractInstruments(text, { created: "2026-11-27" });
    if (!extracted.instruments.length) return { skip: "no instrument" };
    const check = await checkInstrumentReuse({ library: extracted.library, instrument: extracted.instruments[0].name, sourceInstrument: extracted.instruments[0].sourceName, source: text, engine: sharedEngine(), seconds: 4 });
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
  // Per edit and input class: every input passes, except the listed impossibilities.
  const classOf = (name) => (name.startsWith("reconstructed fixture") ? "fixtures" : name.startsWith("reconstructed") ? "reconstructed" : "seeded");
  const ALLOWED_NA = { "transpose a section": /no bar line splits/ };
  for (const n of names) {
    for (const cls of ["seeded", "reconstructed", "fixtures"]) {
      const rows = table.filter((r) => classOf(r.input) === cls);
      const na = rows.filter((r) => r[n].startsWith("n/a"));
      for (const r of na) assert.match(r[n], ALLOWED_NA[n] ?? /^$/, `${r.input} / ${n} is n/a without a listed reason`);
      assert.equal(rows.filter((r) => r[n] === "pass").length + na.length, rows.length, `${n} on ${cls}`);
      assert.ok(rows.filter((r) => r[n] === "pass").length >= Math.ceil(rows.length * 0.6), `${n} passes on most ${cls} inputs`);
    }
  }
});
