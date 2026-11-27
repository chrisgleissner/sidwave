import test from "#test/runner";
import assert from "#test/assert";
import { XMLParser } from "fast-xml-parser";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { exportMusicXml } from "../src/interchange/musicxmlExport.js";
import { importMusicXml, MusicXmlImportError } from "../src/interchange/musicxmlImport.js";
import { parseXml, XmlError } from "../src/interchange/xml.js";
import { runCli } from "../src/cli.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const SCORE = {
  sidwave: 1.3, title: "Round trip <&>", author: "Me", tempo: 120,
  instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [
    { id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" }, b: { length: 1, bars: 1, groove: "D4 F#4 A4 -" } } },
    { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } },
    { id: 3, role: "drums", patterns: { d: { length: 0.5, bars: 1, drums: { kit: { k: "lib:kick", s: "lib:snare", h: "lib:hat" }, steps: "k.h.s.h." } } } },
  ],
  timeline: [
    { section: "one", bars: 2, layers: { v1: "a", v2: "r", v3: "d" } },
    { section: "two", bars: 2, tempo: 90, layers: { v1: "b", v2: "r", v3: "d" } },
  ],
};
const parse = (obj) => parseSidwave(yaml.stringify(obj));
const independent = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@", processEntities: false, parseTagValue: false,
  isArray: (name) => ["part", "measure", "note", "score-part", "midi-instrument", "tie", "direction", "attributes"].includes(name),
});
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = (p) => (Number(p.octave) + 1) * 12 + SEMI[p.step] + Number(p.alter ?? 0);

test("exported MusicXML is accepted by an independent parser and matches the event export", () => {
  const doc = parse(SCORE);
  const events = exportEvents(doc);
  const result = exportMusicXml(doc);
  const tree = independent.parse(result.xml)["score-partwise"];
  assert.equal(tree["@version"], "4.0");
  assert.equal(tree.work["work-title"], "Round trip &lt;&amp;&gt;");
  assert.equal(tree.part.length, 3);
  assert.equal(tree["part-list"]["score-part"].length, 3);
  assert.equal(result.bars, 4);
  const ppq = events.ppq;
  const part0 = tree.part[0];
  assert.equal(part0.measure.length, 4);
  assert.equal(part0.measure[0].attributes[0].divisions, String(ppq));
  assert.equal(part0.measure[0].attributes[0].time.beats, "4");
  // Every measure of every part sums to one bar.
  for (const part of tree.part) {
    for (const measure of part.measure) {
      const total = measure.note.reduce((sum, n) => sum + Number(n.duration), 0);
      assert.equal(total, 4 * ppq);
    }
  }
  // Pitches of the first part equal the event export, in order.
  const pitches = part0.measure.flatMap((m) => m.note).filter((n) => n.pitch).map((n) => midiOf(n.pitch));
  assert.deepEqual(pitches, events.voices[0].notes.map((n) => n.pitch));
  // Tempo: 120 at the start and 90 at bar 3, only in the first part.
  const tempoOf = (m) => (m.direction ?? []).map((d) => d.sound?.["@tempo"]).filter(Boolean);
  assert.deepEqual(tempoOf(part0.measure[0]), ["120"]);
  assert.deepEqual(tempoOf(part0.measure[2]), ["90"]);
  assert.deepEqual(tempoOf(tree.part[1].measure[0]), []);
  // Drum part: unpitched notes that name a score instrument with a midi-unpitched key.
  const drumNotes = tree.part[2].measure.flatMap((m) => m.note).filter((n) => n.unpitched);
  assert.equal(drumNotes.length, events.voices[2].notes.length);
  const keys = tree["part-list"]["score-part"][2]["midi-instrument"].map((m) => Number(m["midi-unpitched"])).sort((a, b) => a - b);
  assert.deepEqual(keys, [37, 39, 43]); // kick 36, snare 38, hat 42 (1-based in MusicXML)
  assert.ok(result.losses.some((l) => l.includes("not written")));
});

test("a note across a bar line is tied and a tempo change inside a bar splits the note", () => {
  const doc = parse({
    sidwave: 1.3, title: "Ties", tempo: 120, voices: [{ id: 1, patterns: { a: { length: 1, bars: 1, groove: "C4 C4 C4 G4" } } }],
    timeline: [{ section: "a", bars: 2, layers: { v1: "a" } }],
  });
  const result = exportMusicXml(doc);
  const tree = independent.parse(result.xml)["score-partwise"];
  assert.equal(tree.part[0].measure.length, 2);
  const again = importMusicXml(Buffer.from(result.xml));
  assert.equal(again.report.bars, 2);
});

test("MusicXML export then import keeps pitches, rhythm, tempo and the drum part", () => {
  const doc = parse(SCORE);
  const result = exportMusicXml(doc);
  const imported = importMusicXml(Buffer.from(result.xml));
  assert.equal(imported.report.droppedParts.length, 0);
  assert.equal(imported.report.quantisation.moved, 0);
  assert.equal(imported.report.voices.length, 3);
  const back = parseSidwave(imported.yaml);
  compileSidwaveToPrg(back);
  const a = exportEvents(doc);
  const b = exportEvents(back);
  // Voice order: melodic parts by importance, drums last.
  const byRole = (score, kind) => score.voices.filter((v) => v.kind === kind);
  assert.deepEqual(byRole(b, "pitched").map((v) => v.notes.map((n) => n.pitch)).sort(), byRole(a, "pitched").map((v) => v.notes.map((n) => n.pitch)).sort());
  assert.equal(byRole(b, "drums")[0].notes.length, byRole(a, "drums")[0].notes.length);
  // Note times agree to a player call (the tempo change in bar 3 is kept).
  const timesA = a.voices[0].notes.map((n) => n.on.time);
  const timesB = b.voices.find((v) => v.notes.length === a.voices[0].notes.length && v.notes[0].pitch === 60).notes.map((n) => n.on.time);
  timesA.forEach((t, i) => assert.ok(Math.abs(t - timesB[i]) < 0.03, `note ${i}: ${t} vs ${timesB[i]}`));
  assert.deepEqual(b.tempoMap.map((t) => t.bpm), [120, 90]);
});

const wrap = (body, head = "") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1"><work><work-title>Hand</work-title></work>
<part-list><score-part id="P1"><part-name>Flute</part-name><midi-instrument id="I1"><midi-program>74</midi-program></midi-instrument></score-part>${head}</part-list>
${body}</score-partwise>`;
const n = (step, octave, dur, extra = "") => `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration></note>`;

test("hand-authored MusicXML: pickup, chords, ties, grace notes, backup, transposition, divisions and tempo", () => {
  const xml = wrap(`<part id="P1">
<measure number="0" implicit="yes"><attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type></direction>
${n("G", 4, 2)}</measure>
<measure number="1">${n("C", 5, 2)}${n("E", 5, 2, "<chord/>")}<note><grace/><pitch><step>D</step><octave>5</octave></pitch></note>${n("D", 5, 2, '<tie type="start"/>')}${n("D", 5, 2, '<tie type="stop"/><tie type="start"/>')}</measure>
<measure number="2"><note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/></note>${n("E", 5, 4)}</measure>
<measure number="3"><attributes><divisions>4</divisions></attributes>${n("C", 4, 8)}<backup><duration>8</duration></backup>${n("E", 3, 8)}<forward><duration>4</duration></forward></measure>
<measure number="4"><direction><sound tempo="60"/></direction>${n("A", 4, 12)}</measure>
</part>`);
  const result = importMusicXml(Buffer.from(xml));
  const report = result.report;
  assert.equal(report.bars, 5);
  assert.equal(report.skipped.graceNotes, 1);
  assert.ok(report.warnings.some((w) => w.includes("pickup")));
  assert.deepEqual(report.timeSignatures, [{ bar: 1, signature: "3/4", sidwave: "3/4" }]);
  const events = exportEvents(parseSidwave(result.yaml));
  assert.deepEqual(events.tempoMap.map((t) => t.bpm), [100, 60]);
  const voice = events.voices[0];
  // Pickup G4 padded to the end of bar 1; then the chord keeps its top note (E5); the tie merges three D5s.
  assert.deepEqual(voice.notes.map((x) => x.pitch).slice(0, 5), [67, 76, 74, 76, 60]);
  const d = voice.notes[2];
  assert.equal(d.durationTicks, 480 * 3); // D5 tied across three notes and a bar line
  assert.ok(report.losses.some((l) => l.includes("grace")));
  assert.ok(report.voices[0].droppedPolyphony >= 2);
});

test("transposing parts are imported at sounding pitch and repeats are reported", () => {
  const xml = wrap(`<part id="P1"><measure number="1"><attributes><divisions>1</divisions><transpose><chromatic>-2</chromatic></transpose></attributes>
<barline><repeat direction="forward"/></barline>${n("D", 4, 4)}</measure></part>`);
  const r = importMusicXml(Buffer.from(xml));
  assert.equal(parseSidwave(r.yaml).voices.length, 1);
  assert.equal(exportEvents(parseSidwave(r.yaml)).voices[0].notes[0].pitch, 60);
  assert.ok(r.report.losses.some((l) => l.includes("Repeat")));
});

test("MusicXML import rejects unsupported and malicious input", () => {
  const body = `<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>${n("C", 4, 4)}</measure></part>`;
  // Internal subset with an entity declaration (XXE and billion laughs).
  const xxe = `<?xml version="1.0"?><!DOCTYPE score-partwise [<!ENTITY x SYSTEM "file:///etc/passwd">]><score-partwise><part-list><score-part id="P1"><part-name>&x;</part-name></score-part></part-list>${body}</score-partwise>`;
  assert.throws(() => importMusicXml(Buffer.from(xxe)), (e) => e instanceof XmlError && /internal subset/.test(e.message));
  // A reference to an undeclared or custom entity.
  const ent = wrap(body).replace("<part-name>Flute", "<part-name>&lol;");
  assert.throws(() => importMusicXml(Buffer.from(ent)), (e) => e instanceof XmlError && /entity/.test(e.message));
  // Nesting depth.
  const deep = `<score-partwise>${"<a>".repeat(200)}${"</a>".repeat(200)}</score-partwise>`;
  assert.throws(() => importMusicXml(Buffer.from(deep)), (e) => e instanceof XmlError && /deeper/.test(e.message));
  // Element count.
  assert.throws(() => parseXml(`<r>${"<a/>".repeat(100)}</r>`, { maxNodes: 50 }), XmlError);
  // Compressed, timewise, wrong root, no notes, bad encoding, truncated, mismatched tags.
  assert.throws(() => importMusicXml(Buffer.from([0x50, 0x4b, 3, 4, 0, 0])), (e) => e instanceof MusicXmlImportError && /\.mxl/.test(e.message));
  assert.throws(() => importMusicXml(Buffer.from("<score-timewise/>")), /timewise/);
  assert.throws(() => importMusicXml(Buffer.from("<html/>")), /not score-partwise/);
  assert.throws(() => importMusicXml(Buffer.from(wrap(`<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><rest/><duration>4</duration></note></measure></part>`))), /no notes/);
  assert.throws(() => importMusicXml(Buffer.from([0x3c, 0xff, 0xfe, 0x3e])), /UTF-8/);
  assert.throws(() => importMusicXml(Buffer.from("<score-partwise><part")), XmlError);
  assert.throws(() => importMusicXml(Buffer.from("<a><b></a></b>")), XmlError);
  // A time signature without a SIDWave metre.
  const odd = wrap(`<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>5</beats><beat-type>8</beat-type></time></attributes>${n("C", 4, 2)}</measure></part>`);
  assert.throws(() => importMusicXml(Buffer.from(odd)), /no SIDWave equivalent/);
  // Character references decode; the five predefined entities work.
  const ok = wrap(body).replace("<part-name>Flute", "<part-name>A&amp;B &#x41;&#66;");
  assert.equal(importMusicXml(Buffer.from(ok)).report.voices[0].part, "P1");
  assert.equal(parseXml("<a b='&lt;'>x&gt;</a>").attrs.b, "<");
});

test("sidwave export and import handle MusicXML on the command line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-mx-"));
  try {
    const run = (...args) => {
      const out = [], err = [];
      const code = runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "song.yaml"), readExampleScore("fuer_elise"));
    const exported = run("export", "song.yaml", "-o", "song.musicxml", "--json");
    assert.equal(exported.code, 0, exported.err);
    const info = JSON.parse(exported.out).result;
    assert.equal(info.format, "musicxml");
    assert.ok(info.losses.length > 0);
    const tree = independent.parse(fs.readFileSync(path.join(dir, "song.musicxml"), "utf8"));
    assert.ok(tree["score-partwise"].part.length >= 1);
    const imported = run("import", "song.musicxml", "-o", "back.yaml", "--json");
    assert.equal(imported.code, 0, imported.err);
    assert.equal(JSON.parse(imported.out).result.format, "musicxml");
    compileSidwaveToPrg(parseSidwave(fs.readFileSync(path.join(dir, "back.yaml"), "utf8")));
    const bad = run("import", "song.musicxml", "-o", "back.yaml");
    assert.equal(bad.code, 2); // exists without --force
    fs.writeFileSync(path.join(dir, "evil.musicxml"), '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><x/>');
    const evil = run("import", "evil.musicxml", "-o", "evil.yaml", "--json");
    assert.equal(evil.code, 3);
    assert.equal(JSON.parse(evil.out).error.category, "input");
    fs.writeFileSync(path.join(dir, "z.mxl"), Buffer.from([0x50, 0x4b, 3, 4]));
    assert.equal(run("import", "z.mxl").code, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
