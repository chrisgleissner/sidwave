import test from "#test/runner";
import assert from "#test/assert";
import { parseMidi, writeMidi } from "midi-file";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { exportMidi } from "../src/interchange/midiExport.js";
import { importMidi, MidiImportError } from "../src/interchange/midiImport.js";
import { parseSmf, writeSmf, MidiError } from "../src/interchange/smf.js";
import { runCli } from "../src/cli.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const SCORE = {
  sidwave: 1.3, title: "Round trip", tempo: 120,
  instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [
    { id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" }, b: { length: 1, bars: 1, groove: "D4 F4 A4 -" } } },
    { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } },
    { id: 3, role: "drums", patterns: { d: { length: 0.5, bars: 1, drums: { kit: { k: "lib:kick", s: "lib:snare", h: "lib:hat" }, steps: "k.h.s.h." } } } },
  ],
  timeline: [
    { section: "one", bars: 2, layers: { v1: "a", v2: "r", v3: "d" } },
    { section: "two", bars: 2, layers: { v1: "b", v2: "r", v3: "d" } },
  ],
};
const parse = (obj) => parseSidwave(yaml.stringify(obj));
const midiOf = (bytes) => parseMidi(Buffer.from(bytes));
const notesOf = (track) => track.filter((e) => e.type === "noteOn" && e.velocity > 0);

test("exported MIDI is accepted by an independent parser and matches the event export", () => {
  const doc = parse(SCORE);
  const exported = exportEvents(doc);
  const result = exportMidi(doc);
  const midi = midiOf(result.bytes);
  assert.equal(midi.header.format, 1);
  assert.equal(midi.header.ticksPerBeat, 480);
  assert.equal(midi.header.numTracks, 1 + exported.voices.length);
  assert.equal(midi.tracks.length, 4);
  // Conductor: name, one tempo, one time signature, section markers.
  const conductor = midi.tracks[0];
  assert.equal(conductor.find((e) => e.type === "trackName").text, "Round trip");
  const tempo = conductor.find((e) => e.type === "setTempo");
  assert.equal(tempo.microsecondsPerBeat, 500000);
  const sig = conductor.find((e) => e.type === "timeSignature");
  assert.deepEqual([sig.numerator, sig.denominator], [4, 4]);
  assert.deepEqual(conductor.filter((e) => e.type === "marker").map((e) => e.text), ["one", "two"]);
  // One track per voice: same notes, ticks, and velocity as the event export.
  exported.voices.forEach((voice, i) => {
    const track = midi.tracks[i + 1];
    let tick = 0;
    const ons = [];
    const offs = [];
    for (const e of track) {
      tick += e.deltaTime;
      if (e.type === "noteOn" && e.velocity > 0) ons.push({ tick, note: e.noteNumber, velocity: e.velocity, channel: e.channel });
      if (e.type === "noteOff") offs.push({ tick, note: e.noteNumber });
    }
    assert.equal(ons.length, voice.notes.length);
    assert.equal(offs.length, voice.notes.length);
    voice.notes.forEach((note, k) => {
      assert.equal(ons[k].tick, note.on.tick);
      assert.equal(offs[k].tick, note.off.tick);
      assert.equal(ons[k].velocity, note.velocity);
      if (voice.kind === "pitched") assert.equal(ons[k].note, note.pitch);
    });
  });
  // Drums on channel 10 (index 9) with GM keys; pitched voices have a program change.
  const drumTrack = midi.tracks[3];
  assert.ok(notesOf(drumTrack).every((e) => e.channel === 9));
  assert.deepEqual([...new Set(notesOf(drumTrack).map((e) => e.noteNumber))].sort((a, b) => a - b), [36, 38, 42]);
  assert.ok(midi.tracks[1].some((e) => e.type === "programChange"));
  assert.ok(!midi.tracks.some((t) => t.some((e) => e.type === "pitchBend")), "no bend unless requested");
  assert.ok(result.losses.some((l) => /bend/i.test(l)));
});

test("tempo ramps, time signatures and bends are written", () => {
  const doc = parse({
    sidwave: 1.3, tempo: 100,
    instruments: { vib: { waveform: "pulse", vibrato: { depth: 0.5, rate: 6, delay: 2 } } },
    voices: [{ id: 1, instrument: "vib", patterns: {
      w: { length: 1, bars: 1, groove: ["C4", "E4", { note: "G4", bend: { to: 2, frames: 6 } }] },
      v: { length: 0.5, bars: 1, groove: "C4 D4 E4 F4 G4 A4" },
    } }],
    timeline: [{ section: "waltz", bars: 2, meter: "3/4", layers: { v1: "w" } }, { section: "six", bars: 2, meter: "6/8", tempo: { to: 140 }, layers: { v1: "v" } }],
  });
  const withBend = exportMidi(doc, { bend: true });
  const midi = midiOf(withBend.bytes);
  const conductor = midi.tracks[0];
  assert.deepEqual(conductor.filter((e) => e.type === "timeSignature").map((e) => `${e.numerator}/${e.denominator}`), ["3/4", "6/8"]);
  const tempos = conductor.filter((e) => e.type === "setTempo").map((e) => Math.round(6e7 / e.microsecondsPerBeat));
  assert.ok(Math.abs(tempos[0] - 100) < 6);
  assert.ok(tempos.length > 3 && tempos[tempos.length - 1] > 100);
  const bends = midi.tracks[1].filter((e) => e.type === "pitchBend");
  assert.ok(bends.length > 10, "vibrato and the glide produce pitch bend");
  assert.ok(bends.some((e) => e.value > 0) && bends.some((e) => e.value < 0));
  assert.ok(midi.tracks[1].some((e) => e.type === "controller" && e.controllerType === 6 && e.value === 12), "RPN bend range of 12 semitones");
  assert.ok(withBend.tracks[0].pitchBendEvents > 0);
  const without = midiOf(exportMidi(doc).bytes);
  assert.ok(!without.tracks[1].some((e) => e.type === "pitchBend"));
});

test("import: independent writer's file with channel parts, tempo map and time signatures", () => {
  const track = (events) => {
    let t = 0;
    return events.map(([tick, e]) => { const deltaTime = tick - t; t = tick; return { deltaTime, ...e }; });
  };
  const note = (start, end, noteNumber, channel, velocity = 90) => [
    [start, { type: "noteOn", channel, noteNumber, velocity }], [end, { type: "noteOff", channel, noteNumber, velocity: 0 }]];
  const events0 = [[0, { type: "trackName", text: "Etude" }], [0, { type: "timeSignature", numerator: 3, denominator: 4, metronome: 24, thirtyseconds: 8 }],
    [0, { type: "setTempo", microsecondsPerBeat: 500000 }], [1440, { type: "timeSignature", numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 }],
    [1440, { type: "setTempo", microsecondsPerBeat: 400000 }], [2880, { type: "endOfTrack" }]];
  const melody = [[0, { type: "trackName", text: "Melody" }], [0, { type: "programChange", channel: 0, programNumber: 73 }],
    ...[60, 62, 64, 65, 67, 69].flatMap((n, i) => note(i * 480, i * 480 + 440, n, 0, 100)), [2880, { type: "endOfTrack" }]];
  // A chord part: three notes together, the voice keeps the highest.
  const chords = [[0, { type: "trackName", text: "Chords" }], ...[36, 40, 43].flatMap((n) => note(0, 960, n, 1, 70)),
    ...[38, 41, 45].flatMap((n) => note(960, 1920, n, 1, 70))];
  const drums = [[0, { type: "trackName", text: "Kit" }], ...[0, 480, 960, 1440, 1920, 2400].flatMap((tick, i) => note(tick, tick + 120, i % 2 ? 38 : 36, 9, 110)), ...note(480, 600, 42, 9, 60), ...note(1080, 1200, 99, 9, 60)];
  const bytes = writeMidi({ header: { format: 1, numTracks: 4, ticksPerBeat: 480 }, tracks: [track(events0), track(melody), track(chords.sort((a, b) => a[0] - b[0])), track(drums.sort((a, b) => a[0] - b[0]))] });
  const result = importMidi(Uint8Array.from(bytes));
  const report = result.report;
  assert.equal(report.format, 1);
  assert.equal(report.voices.length, 3);
  assert.deepEqual(report.voices.map((v) => v.role), ["melodic", "bass", "drums"]);
  assert.equal(report.voices[0].source.name, "Melody");
  assert.equal(report.voices[0].instrument, "wind", "GM 73 (flute) is a wind instrument");
  assert.equal(report.voices[1].droppedPolyphony, 4, "bass rule keeps the lowest note of each chord");
  assert.deepEqual(report.timeSignatures.map((s) => s.signature), ["3/4", "4/4"]);
  assert.equal(report.tempoChanges.total, 2);
  assert.equal(report.quantisation.maxErrorTicks, 0);
  assert.ok(report.losses.some((l) => /not imported|dropped/.test(l)));
  // The result is a valid SIDWave score with the same metres and tempos.
  const doc = parseSidwave(result.yaml);
  compileSidwaveToPrg(doc);
  assert.equal(doc.timeline[0].meter?.sig, undefined, "first section uses the song metre");
  assert.equal(doc.song.tempo, 120);
  assert.ok(doc.timeline.some((s) => s.tempo === 150));
  const events = exportEvents(doc);
  assert.deepEqual(events.timeSignatures.map((s) => `${s.numerator}/${s.denominator}`), ["3/4", "4/4"]);
  assert.deepEqual(events.voices[0].notes.map((n) => n.pitch), [60, 62, 64, 65, 67, 69]);
  assert.deepEqual(events.voices[1].notes.map((n) => n.pitch), [36, 38]);
});

test("round trip: score to MIDI to score keeps notes, ticks and voices", () => {
  const original = parse(SCORE);
  const before = exportEvents(original);
  const imported = importMidi(exportMidi(original).bytes, { title: "Round trip" });
  const doc = parseSidwave(imported.yaml);
  compileSidwaveToPrg(doc);
  const after = exportEvents(doc);
  assert.equal(imported.report.quantisation.maxErrorTicks, 0);
  assert.equal(after.voices.length, before.voices.length);
  // Voices come back in importance order (melodic first, drums last); compare by role and kind.
  const pitched = (events) => events.voices.filter((v) => v.kind === "pitched");
  const find = (events, id) => events.voices.find((v) => v.id === id);
  const lead = after.voices.find((v) => v.notes.length === find(before, 1).notes.length && v.kind === "pitched");
  assert.ok(lead);
  assert.deepEqual(lead.notes.map((n) => [n.pitch, n.on.tick]), find(before, 1).notes.map((n) => [n.pitch, n.on.tick]));
  assert.equal(pitched(after).length, 2);
  assert.equal(after.voices.filter((v) => v.kind === "drums").length, 1);
  assert.equal(after.timeSignatures.length, 1);
  // Imported durations are quantised to the grid, so the bar count matches.
  assert.equal(imported.report.bars, 4);
});

test("import reports quantisation error and limits voices to three", () => {
  const events = [[0, { type: "setTempo", microsecondsPerBeat: 500000 }]];
  const mk = (channel, base) => [0, 1, 2, 3].flatMap((i) => {
    const start = i * 480 + (i === 1 ? 37 : 0) + channel; // one note off the grid by 37 ticks
    return [[start, { type: "noteOn", channel, noteNumber: base + i, velocity: 80 }], [start + 400, { type: "noteOff", channel, noteNumber: base + i, velocity: 0 }]];
  });
  const all = [...events, ...mk(0, 60), ...mk(1, 50), ...mk(2, 40), ...mk(3, 70)].sort((a, b) => a[0] - b[0]);
  let t = 0;
  const bytes = writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 480 }, tracks: [all.map(([tick, e]) => { const deltaTime = tick - t; t = tick; return { deltaTime, ...e }; })] });
  const result = importMidi(Uint8Array.from(bytes));
  assert.equal(result.report.format, 0);
  assert.equal(result.report.voices.length, 3);
  assert.equal(result.report.droppedParts.length, 1);
  assert.match(result.report.droppedParts[0].reason, /higher importance/);
  assert.ok(result.report.quantisation.maxErrorTicks >= 37 - 3 && result.report.quantisation.maxErrorTicks <= 120);
  assert.ok(result.report.quantisation.moved >= 3);
  assert.ok(result.report.quantisation.maxErrorMs > 0);
  const one = importMidi(Uint8Array.from(bytes), { voices: 1 });
  assert.equal(one.report.voices.length, 1);
});

test("import: pitch bend becomes a SIDWave bend, vibrato is reported as lost", () => {
  const rows = [
    [0, { type: "setTempo", microsecondsPerBeat: 500000 }],
    [0, { type: "noteOn", channel: 0, noteNumber: 60, velocity: 100 }],
    [120, { type: "pitchBend", channel: 0, value: 4096 }],
    [240, { type: "pitchBend", channel: 0, value: 8191 }], // +2 semitones with the default range
    [1000, { type: "noteOff", channel: 0, noteNumber: 60, velocity: 0 }],
    [1000, { type: "pitchBend", channel: 0, value: 8192 }],
    [1200, { type: "noteOn", channel: 0, noteNumber: 64, velocity: 100 }],
    [1300, { type: "pitchBend", channel: 0, value: 9000 }],
    [1400, { type: "pitchBend", channel: 0, value: 7000 }],
    [1500, { type: "pitchBend", channel: 0, value: 8192 }],
    [2000, { type: "noteOff", channel: 0, noteNumber: 64, velocity: 0 }],
  ];
  let t = 0;
  const bytes = writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 480 }, tracks: [rows.map(([tick, e]) => { const deltaTime = tick - t; t = tick; return { deltaTime, ...e }; })] });
  const result = importMidi(Uint8Array.from(bytes));
  assert.equal(result.report.voices[0].bends, 1);
  assert.equal(result.report.voices[0].bendsLost, 1);
  const doc = parseSidwave(result.yaml);
  const exported = exportEvents(doc);
  const first = exported.voices[0].notes[0];
  assert.equal(first.effects.bend.to - first.effects.bend.from, 2);
  assert.ok(result.report.losses.some((l) => /vibrato/.test(l)));
  assert.equal(importMidi(Uint8Array.from(bytes), { bend: false }).report.voices[0].bends, 0);
});

test("SMF reader rejects malformed and oversized input and never reads out of bounds", () => {
  const good = writeSmf({ format: 1, division: 96, tracks: [[{ tick: 0, type: "tempo", microsecondsPerQuarter: 500000 }], [{ tick: 0, type: "noteOn", channel: 0, note: 60, velocity: 64 }, { tick: 96, type: "noteOff", channel: 0, note: 60, velocity: 0 }]] });
  assert.equal(parseSmf(good).tracks.length, 2);
  assert.throws(() => parseSmf(new Uint8Array([1, 2, 3])), MidiError);
  assert.throws(() => parseSmf(good.subarray(0, good.length - 3)), MidiError);
  assert.throws(() => parseSmf(good, { maxBytes: 10 }), /limit/);
  assert.throws(() => parseSmf(good, { maxEvents: 2 }), /more than 2 events/);
  assert.throws(() => parseSmf(good, { maxTracks: 1 }), /tracks/);
  const smpte = Uint8Array.from(good); smpte[12] = 0xe7; smpte[13] = 0x28;
  assert.throws(() => parseSmf(smpte), /SMPTE/);
  const huge = Uint8Array.from(good); huge[10] = 0xff; huge[11] = 0xff;
  assert.throws(() => parseSmf(huge), /tracks/);
  // A variable-length quantity of five bytes and a tick beyond the limit.
  const longVlq = Uint8Array.from([...good.subarray(0, 14), 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 6, 0x81, 0x81, 0x81, 0x81, 0x01, 0x90]);
  assert.throws(() => parseSmf(longVlq), MidiError);
  // Fuzz: every truncation and a few bit flips either parse or throw MidiError, never anything else.
  for (let cut = 0; cut < good.length; cut++) {
    try { parseSmf(good.subarray(0, cut)); } catch (error) { assert.ok(error instanceof MidiError, `${cut}: ${error}`); }
  }
  for (let i = 14; i < good.length; i++) {
    const flipped = Uint8Array.from(good); flipped[i] ^= 0xff;
    try { parseSmf(flipped); } catch (error) { assert.ok(error instanceof MidiError, `${i}: ${error}`); }
  }
  assert.throws(() => importMidi(new Uint8Array([0, 1, 2])), MidiImportError);
  const sig = writeSmf({ format: 0, division: 96, tracks: [[{ tick: 0, type: "timeSignature", numerator: 5, denominator: 16 }, { tick: 0, type: "noteOn", channel: 0, note: 60, velocity: 64 }, { tick: 20, type: "noteOff", channel: 0, note: 60, velocity: 0 }]] });
  assert.throws(() => importMidi(sig), /no SIDWave equivalent/);
});

test("command line: export, import and refuse to overwrite the input", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-midi-")));
  try {
    const run = (...args) => {
      const out = [], err = [], bytes = [];
      const code = runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)) });
      return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
    };
    fs.writeFileSync(path.join(dir, "song.yaml"), readExampleScore("fuer_elise"));
    const json = run("export", "song.yaml");
    assert.equal(json.code, 0);
    assert.equal(JSON.parse(json.out).schema, "sidwave.events/1");
    const exported = run("export", "song.yaml", "-o", "song.mid", "--bend");
    assert.equal(exported.code, 0, exported.err);
    assert.equal(midiOf(fs.readFileSync(path.join(dir, "song.mid"))).header.format, 1);
    const imported = run("import", "song.mid", "-o", "again.yaml", "--grid", "0.25");
    assert.equal(imported.code, 0, imported.err);
    assert.ok(fs.readFileSync(path.join(dir, "again.yaml"), "utf8").includes("sidwave: 1.3"));
    assert.equal(run("import", "song.mid", "-o", "again.yaml").code, 2, "refuses to overwrite without --force");
    assert.equal(run("import", "song.mid", "-o", "song.mid", "--force").code, 2, "refuses to overwrite its input");
    assert.equal(run("export", "song.yaml", "-o", "song.yaml", "--format", "midi").code, 2);
    assert.equal(run("export", "missing.yaml").code, 3, "unreadable input");
    assert.equal(run("export", "song.yaml", "--format", "nope").code, 2);
    assert.equal(run("export", "song.yaml", "--bend").code, 2, "--bend needs midi");
    fs.writeFileSync(path.join(dir, "bad.mid"), "MThd garbage");
    assert.equal(run("import", "bad.mid").code, 3, "malformed MIDI is an input error");
    const bad = run("import", "bad.mid", "--json");
    assert.equal(JSON.parse(bad.out).error.category, "input");
    fs.writeFileSync(path.join(dir, "unknown.bin"), "hello");
    assert.equal(run("import", "unknown.bin").code, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a file with 200,000 notes gives a result or a typed import error, never a stack overflow", () => {
  const events = [{ tick: 0, type: "tempo", microsecondsPerQuarter: 500000 }];
  for (let i = 0; i < 200_000; i++) {
    events.push({ tick: i * 120, type: "noteOn", channel: 0, note: 40 + (i % 40), velocity: 80 });
    events.push({ tick: i * 120 + 100, type: "noteOff", channel: 0, note: 40 + (i % 40), velocity: 0 });
  }
  const bytes = writeSmf({ format: 0, division: 480, tracks: [events] });
  try {
    importMidi(bytes);
  } catch (error) {
    assert.ok(error instanceof MidiImportError, `${error}`);
  }
});

test("SMF format 2 is rejected with a MidiError", () => {
  const bytes = writeSmf({ format: 2, division: 96, tracks: [[{ tick: 0, type: "noteOn", channel: 0, note: 60, velocity: 64 }]] });
  assert.throws(() => parseSmf(bytes), (e) => e instanceof MidiError && /format 2/.test(e.message));
  assert.throws(() => importMidi(bytes), (e) => e instanceof MidiImportError && /format 2/.test(e.message));
});

test("a file with 100000 notes, tempo events and pitch bends imports in bounded CPU time", () => {
  const N = 100_000;
  const events = [[0, { type: "trackName", text: "Big" }]];
  const lead = [[0, { type: "trackName", text: "Lead" }]];
  for (let i = 0; i < N; i++) {
    events.push([i * 4, { type: "setTempo", microsecondsPerBeat: 400_000 + (i % 100) * 1000 }]);
    const start = i * 4;
    lead.push([start, { type: "noteOn", channel: 0, noteNumber: 48 + (i % 24), velocity: 90 }]);
    lead.push([start + 1, { type: "pitchBend", channel: 0, value: 8192 + ((i % 7) - 3) * 500 }]);
    lead.push([start + 3, { type: "noteOff", channel: 0, noteNumber: 48 + (i % 24), velocity: 0 }]);
  }
  const track = (list) => {
    list.sort((a, b) => a[0] - b[0]);
    let last = 0;
    return [...list.map(([tick, e]) => { const r = { ...e, deltaTime: tick - last }; last = tick; return r; }), { type: "endOfTrack", deltaTime: 0 }];
  };
  const bytes = writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: 480 }, tracks: [track(events), track(lead)] });
  const before = process.cpuUsage();
  const result = importMidi(Uint8Array.from(bytes), { validate: false });
  const used = process.cpuUsage(before);
  const cpuSeconds = (used.user + used.system) / 1e6;
  assert.ok(result.yaml.length > 0);
  assert.ok(cpuSeconds < 10, `import took ${cpuSeconds} s of CPU time`);
});

test("import -o - with --json is a usage error", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-midi-json-")));
  try {
    const run = (...args) => {
      const out = [], err = [];
      const code = runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "song.yaml"), readExampleScore("fuer_elise"));
    assert.equal(run("export", "song.yaml", "-o", "song.mid").code, 0);
    const refused = run("import", "song.mid", "-o", "-", "--json");
    assert.equal(refused.code, 2, refused.err);
    assert.ok(!refused.out.includes("version:") && !refused.out.includes("sidwave: 1."), "no YAML on stdout");
    assert.equal(run("import", "song.mid", "-o", "-").code, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
