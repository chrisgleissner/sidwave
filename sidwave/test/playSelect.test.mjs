import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.ts";
import { arrangeSidwave, compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { makeTimelineClock } from "../src/sidwaveForm.ts";
import { readExampleScore, compileSidwaveBytes, confinedReadOptions } from "../src/sidwaveOps.ts";
import { selectScore } from "../src/play/select.ts";
import { buildPlayTune, readPlaySource } from "../src/play/source.ts";
import { scoreLocator } from "../src/play/positions.ts";
import { convert } from "../src/interchange/convert.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = (name) => parseSidwave(readExampleScore(name), confinedReadOptions(root));
const bytesOf = (text) => new TextEncoder().encode(text);

/** The notes of every voice as [midi, start, length] with starts counted from `from`, within `length` frames. */
function notes(doc, from = 0, length = Infinity) {
  return arrangeSidwave(doc).voices.map((v) => v.notes.filter((n) => !n.hidden && n.start >= from && n.start < from + length).map((n) => [n.midi, n.start - from]));
}

const clockOf = (doc) => makeTimelineClock(doc, arrangeSidwave(doc).fps);

/** Equal pitches, and starts within one frame (the rounding of beats to frames depends on the origin). */
function sameNotes(actual, expected, what) {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((voice, v) => {
    assert.deepEqual(voice.map((n) => n[0]), expected[v].map((n) => n[0]), `${what}: pitches of voice ${v + 1}`);
    assert.ok(voice.every((n, i) => Math.abs(n[1] - expected[v][i][1]) <= 1), `${what}: starts of voice ${v + 1}`);
  });
}

test("no selection leaves the score as it is", () => {
  const doc = example("chiptune_drive");
  const selected = selectScore(doc, {}, false);
  assert.equal(selected.doc, doc);
  assert.deepEqual([selected.startBar, selected.skipSeconds, selected.loop, selected.notes], [1, 0, false, []]);
});

test("--from-bar at the first bar of a section plays the notes of the score from that bar on", () => {
  const doc = example("chiptune_drive");
  const clock = clockOf(doc);
  assert.ok(clock.sections.length > 2, "the example has several sections");
  const target = clock.sections[2];
  const bar = clock.barOf(target.startBeat);
  const selected = selectScore(doc, { fromBar: bar }, false);
  assert.equal(selected.startBar, bar);
  assert.equal(selected.skipSeconds, 0);
  assert.equal(selected.doc.song.length_bars, doc.song.length_bars - bar + 1);
  sameNotes(notes(selected.doc), notes(doc, clock.frameAt(target.startBeat)), "from a section");
});

test("--from-bar inside a section starts at the section and says how much to skip", () => {
  const doc = example("chiptune_drive");
  const clock = clockOf(doc);
  const index = clock.sections.findIndex((s) => s.section.bars > 2);
  const section = clock.sections[index];
  const bar = clock.barOf(section.startBeat) + 2;
  const selected = selectScore(doc, { fromBar: bar }, false);
  assert.equal(selected.startBar, bar - 2);
  const secondsPerBar = 4 * 60 / doc.song.tempo;
  assert.ok(Math.abs(selected.skipSeconds - 2 * secondsPerBar) < 0.05, `skip ${selected.skipSeconds}`);
  const local = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "local", fromBar: bar });
  assert.equal(local.startBar, bar);
  assert.ok(local.skipSeconds > 0);
  const vice = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "vice", fromBar: bar });
  assert.equal(vice.startBar, bar - 2);
  assert.equal(vice.skipSeconds, 0);
  assert.match(vice.notes.join("\n"), /starts at bar/);
});

test("--from-bar with a loop plays the rest of the song and then repeats what the song repeats", () => {
  const doc = { ...example("chiptune_drive"), end: undefined };
  const clock = clockOf(doc);
  const sections = clock.sections.length;
  const bar = clock.barOf(clock.sections[3].startBeat);
  const fromStartLoop = selectScore(doc, { fromBar: bar }, true);
  assert.equal(fromStartLoop.doc.timeline.length, sections - 3 + sections);
  assert.equal(fromStartLoop.doc.loopTo, sections - 3);
  const looped = { ...doc, loopTo: 5 };
  const before = selectScore(looped, { fromBar: bar }, true);
  assert.equal(before.doc.timeline.length, sections - 3);
  assert.equal(before.doc.loopTo, 2);
  compileSidwaveToPrg(fromStartLoop.doc, { loop: true });
});

test("--loop-section plays the notes of one section, by name or by position, and loops", () => {
  const doc = example("chiptune_drive");
  const clock = clockOf(doc);
  const index = 2;
  const section = clock.sections[index];
  const name = doc.timeline[index].section;
  const first = doc.timeline.findIndex((s) => s.section === name);
  for (const wanted of name ? [name, String(first + 1)] : [String(index + 1)]) {
    const selected = selectScore(doc, { loopSection: wanted }, false);
    assert.equal(selected.loop, true);
    assert.equal(selected.doc.timeline.length, 1);
    assert.equal(selected.doc.loopTo, 0);
    const chosen = clock.sections[name ? first : index];
    sameNotes(notes(selected.doc), notes(doc, clock.frameAt(chosen.startBeat), clock.frameAt(chosen.endBeat) - clock.frameAt(chosen.startBeat)), wanted);
  }
  assert.ok(section);
  assert.throws(() => selectScore(doc, { loopSection: "nowhere" }), /no such section; its sections/);
  assert.throws(() => selectScore(doc, { loopSection: "99" }), /no such section/);
});

test("a score with an end plays once, also from a bar, and one section of it can loop", () => {
  const doc = example("drum_and_bass");
  assert.ok(doc.end);
  const looped = selectScore(doc, {}, true);
  assert.equal(looped.loop, false);
  assert.match(looped.notes.join("\n"), /plays once/);
  const later = selectScore(doc, { fromBar: 9 }, true);
  assert.equal(later.loop, false);
  assert.deepEqual(later.doc.end, doc.end);
  assert.equal(selectScore(doc, { loopSection: "build" }, false).loop, true);
});

test("a turbo score runs as a PRG on a device and the notes say what to set", () => {
  const doc = example("wall_of_sid");
  assert.equal(doc.cpu, "turbo");
  const device = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "u64" });
  assert.equal(device.needsPrg, true);
  assert.match(device.notes.join("\n"), /Turbo Registers/);
  assert.match(device.notes.join("\n"), /set the SID addresses/);
  const emulator = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "vice" });
  assert.match(emulator.notes.join("\n"), /at 1 MHz[\s\S]*at most 4 SIDs/);
});

test("a section that cannot be followed by itself gets a bar of rest between the repeats", () => {
  const doc = example("drum_and_bass");
  const tune = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "local", loopSection: "build2" });
  assert.match(tune.notes.join("\n"), /1 bar of rest/);
});

test("--solo and --mute keep exactly the chosen voices", () => {
  const doc = example("chiptune_drive");
  const all = notes(doc);
  const solo = notes(selectScore(doc, { solo: ["2"] }).doc);
  assert.deepEqual(solo.map((v) => v.length > 0), [false, true, false]);
  assert.deepEqual(solo[1].map((n) => n[0]), all[1].map((n) => n[0]));
  const muted = notes(selectScore(doc, { mute: ["v2"] }).doc);
  assert.deepEqual(muted.map((v) => v.length), [all[0].length, 0, all[2].length]);
  const byName = selectScore(doc, { solo: [doc.voices[0].name] }).doc;
  assert.deepEqual(notes(byName).map((v) => v.length > 0), [true, false, false]);
  assert.throws(() => selectScore(doc, { solo: ["7"] }), /no such voice; its voices are 1/);
  assert.throws(() => selectScore(doc, { solo: ["1"], mute: ["2"] }), /not both/);
});

test("a copy voice plays only with its source, and the notes say so", () => {
  const doc = example("stereo_echo");
  const copy = doc.voices.find((v) => v.echo || v.follow || v.unison);
  const source = (copy.echo ?? copy.follow ?? copy.unison).voice;
  const heard = (d) => {
    const arrangement = arrangeSidwave(d);
    return d.voices.filter((v) => arrangement.voices[d.voiceSlots.get(v.id)].notes.some((n) => !n.hidden)).map((v) => v.id).sort((a, b) => a - b);
  };
  const solo = selectScore(doc, { solo: [String(copy.id)] });
  assert.deepEqual(heard(solo.doc), [copy.id, source].sort((a, b) => a - b));
  assert.match(solo.notes.join("\n"), /plays too/);
  const muted = selectScore(doc, { mute: [String(source)] });
  assert.ok(!heard(muted.doc).includes(source) && !heard(muted.doc).includes(copy.id));
  assert.match(muted.notes.join("\n"), /silent too/);
  assert.ok(!heard(selectScore(doc, { mute: [String(copy.id)] }).doc).includes(copy.id), "a muted copy is silent");
  assert.ok(!heard(selectScore(doc, { solo: [String(source)] }).doc).includes(copy.id), "the copy of a soloed voice is not heard");
});

test("--song selects a song of a score with songs", () => {
  const doc = example("game_songs");
  const second = selectScore(doc, { song: 2 }).doc;
  assert.equal(second.songs, undefined);
  assert.equal(second.timeline, doc.songs[1].timeline);
  assert.equal(second.song.tempo, doc.songs[1].tempo);
  assert.equal(selectScore(doc, { song: 2 }, true).loop, doc.songs[1].loop);
  assert.throws(() => selectScore(doc, { song: 9 }), /the score has \d+ songs/);
  assert.throws(() => selectScore(example("chiptune_drive"), { song: 2 }), /one song/);
});

test("sample triggers move with --from-bar, and the local engine plays a score with samples without them", () => {
  const doc = example("digi_groove");
  const bars = doc.song.length_bars;
  for (const fromBar of [2, bars]) {
    const tune = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "local", fromBar });
    assert.ok(tune.prg.length > 0);
    assert.ok(tune.sid, "a PSID without the samples");
    assert.match(tune.notes.join("\n"), /does not play digi samples/);
  }
  const vice = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { target: "vice" });
  assert.equal(vice.sid, undefined);
  assert.match(vice.sidUnavailable, /digi samples|PSID/);
});

test("positional sample triggers move with --from-bar and --loop-section", () => {
  const doc = parseSidwave([
    "sidwave: 1.2", "title: T", "tempo: 120", "sids: [{ id: chip1, address: '$D400' }]",
    "voices:", "  - { id: 1, patterns: { A: { groove: [C4], length: 4 } } }",
    "sections:", "  one: { layers: { v1: A } }", "  two: { layers: { v1: A } }",
    "timeline: [one, two, one]",
    "samples: { rate: 4000, triggers: [{ sid: chip1, kit: kick, bar: 1 }, { sid: chip1, kit: snare, bar: 2, beat: 3 }, { sid: chip1, kit: clap, at: [210] }] }",
  ].join("\n"));
  const frames = (d) => d.samples.triggers.map((t) => [t.name, t.beat ?? `at ${t.at}`]);
  const names = doc.samples.triggers.map((t) => t.name);
  assert.deepEqual(frames(selectScore(doc, { fromBar: 2 }).doc), [[names[1], 2], [names[2], `at ${210 - clockOf(doc).frameAt(4)}`]]);
  assert.deepEqual(frames(selectScore(doc, { loopSection: "two" }).doc), [[names[1], 2]]);
  assert.deepEqual(selectScore(doc, { solo: ["1"] }).doc.samples.triggers, []);
  compileSidwaveToPrg(selectScore(doc, { fromBar: 2 }).doc);
});

test("a SID file is played as it is and refuses selections that need a score", async () => {
  const sid = new Uint8Array(compileSidwaveBytes(example("chiptune_drive"), { format: "sid" }).bytes);
  const source = await readPlaySource(sid, { name: "tune.bin" });
  assert.equal(source.kind, "sid");
  const tune = buildPlayTune(source, { target: "local" });
  assert.deepEqual(tune.sid, sid);
  assert.equal(tune.seconds, undefined);
  assert.equal(tune.loop, true);
  for (const selection of [{ solo: ["1"] }, { mute: ["1"] }, { fromBar: 2 }, { loopSection: "a" }]) {
    assert.throws(() => buildPlayTune(source, { target: "local", ...selection }), /needs a score/);
  }
  assert.throws(() => buildPlayTune(source, { target: "local", song: 2 }), /the file has 1 song/);
});

test("a file that convert reads is imported into a score", async () => {
  const midi = await convert(bytesOf(readExampleScore("chiptune_drive")), { to: "midi", inputName: "a.yaml" });
  const source = await readPlaySource(midi.output, { name: "a.mid" });
  assert.equal(source.kind, "score");
  assert.equal(source.format, "midi");
  assert.match(source.notes[0], /imported from midi/);
  assert.ok(buildPlayTune(source, { target: "local" }).sid);
  await assert.rejects(readPlaySource(bytesOf("not music"), { name: "a.bin" }), /cannot tell the format/);
});

test("--song reaches the importer of a file with several songs", async () => {
  const gt = await convert(bytesOf(readExampleScore("chiptune_drive")), { to: "goattracker", inputName: "a.yaml" });
  const source = await readPlaySource(gt.output, { name: "a.sng", song: 1 });
  assert.equal(source.songChosen, true);
  assert.ok(buildPlayTune(source, { target: "local", song: 1 }).sid);
  await assert.rejects(readPlaySource(gt.output, { name: "a.sng", song: 2 }), /song/i);
  const midi = await convert(bytesOf(readExampleScore("chiptune_drive")), { to: "midi", inputName: "a.yaml" });
  await assert.rejects(readPlaySource(midi.output, { name: "a.mid", song: 2 }), /holds one song/);
});

test("validation paths and lint positions point at line and column", () => {
  const text = [
    "sidwave: 1.2", "title: T", "tempo: 120", "voices:", "  - id: 1", "    patterns:", "      A: { groove: [c4:1] }",
    "  - id: 2", "    patterns:", "      B.x: { groove: [e4:1] }", "sections:", "  one:", "    layers: { v1: A }",
    "timeline: [one*2, one]", "",
  ].join("\n");
  const locator = scoreLocator(text);
  assert.deepEqual(locator.path("$.tempo"), { line: 3, column: 1 });
  assert.deepEqual(locator.path("$.voices[0].patterns.A"), { line: 7, column: 7 });
  assert.deepEqual(locator.path("$.voices[1].patterns.B.x.groove"), { line: 10, column: 14 });
  assert.deepEqual(locator.path("$.voices.v2.center"), { line: 8, column: 5 });
  assert.deepEqual(locator.path("$.timeline[0]"), { line: 14, column: 12 });
  assert.deepEqual(locator.path("$.sections.one.layers.v1"), { line: 13, column: 15 });
  assert.equal(locator.path("$").line, 1);
  const doc = { voices: [{ id: 1, patterns: { A: {} } }, { id: 2, patterns: {} }], timeline: [{ bars: 1, layers: { v1: "A" } }, { bars: 1, layers: { v1: "-" } }, { bars: 1, layers: { v1: "A" } }] };
  assert.deepEqual(locator.finding("bar 1 v1", doc), { line: 7, column: 7 });
  assert.deepEqual(locator.finding('voice 1 pattern "A"', doc), { line: 7, column: 7 });
  assert.deepEqual(locator.finding("v2 echo", doc), { line: 8, column: 5 });
  assert.deepEqual(locator.finding('section "one"', doc), { line: 12, column: 3 });
  assert.equal(locator.finding("bar 3", doc).line, 14);
  assert.equal(locator.finding("elsewhere", doc), undefined);
  assert.equal(scoreLocator("a: [1\nb: 2\n").path("$").line, 2);
});
