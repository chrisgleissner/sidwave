import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import { homeDirectory } from "./helpers/home.mjs";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { Sf2Error, packSequence, parseSf2, readOrderList, readSequence } from "../src/interchange/sf2.js";
import { importSf2, sf2Vibrato } from "../src/interchange/sf2Import.js";
import { exportSf2 } from "../src/interchange/sf2Export.js";
import { InterchangeInputError } from "../src/interchange/errors.js";
import { runCli } from "../src/cli.js";
import { L, seqBytes, sf2File, smallSf2 } from "./helpers/sf2Fixtures.mjs";
import { psidFromSf2 } from "./helpers/sf2Differential.mjs";
import { compareVoices } from "./helpers/roundTrip.mjs";
import { assertQuality } from "./helpers/quality.mjs";
import { haveEngine, compareSids, compileScoreToSid } from "./helpers/trackerDifferential.mjs";

const pitches = (text) => exportEvents(parseSidwave(text)).voices.map((v) => v.notes.map((n) => n.pitch));

test("a hand-built SID Factory II song imports with notes, instruments, wave and pulse programs, hard restart and tempo", () => {
  const result = importSf2(smallSf2());
  assert.equal(result.report.driver, "11.00.02");
  assert.equal(result.report.ticks, 16);
  assert.equal(result.report.rowsPerBeat, 4);
  const doc = parseSidwave(result.yaml);
  // Tempo value 5 is six frames per row: 60 * 50.1245 / (4 * 6) = 125.31 BPM.
  assert.ok(Math.abs(doc.song.tempo - 125.3114) < 1e-3);
  assert.deepEqual(pitches(result.yaml).filter((p) => p.length), [[60, 64, 67, 72, 60, 64, 67, 72], [36, 36, 43, 36, 36, 43]]);
  const def = yaml.parse(result.yaml).instruments;
  assert.deepEqual(def.i00.adsr, [0, 8, 10, 5]);
  assert.equal(def.i00.pulse_width, 0x800);
  assert.deepEqual(def.i00.hard_restart, { frames: 2, adsr: [0, 15, 0, 0] });
  assert.deepEqual(def.i01.hard_restart, { frames: 0 });
  compileSidwaveToPrg(parseSidwave(result.yaml));
});

test("transposition, ties, legato, arpeggio commands and the tempo chain are read as the driver reads them", () => {
  const seq = seqBytes([[0, 0x30, 1], [null, 0x7e], [null, 0x34, null, true], [null, 0x34, null, true], [null, 0], [0, 0x30], [null, 0x7e], [null, 0x7e]]);
  const bytes = sf2File({
    tracks: [[[2, 1]], [[0, 0]], [[0, 0]]], sequences: { 1: seq },
    instruments: { 0: [0, 0xf0, 0x80, 0, 0, 0] }, wave: { 0: [0x41, 0], 1: [0x7f, 0] },
    cmds: { 1: [3, 1, 0] }, arp: { 0: 0, 1: 4, 2: 7, 3: 0x71 }, tempo: [7, 5, 0x7f],
  });
  const result = importSf2(bytes);
  assert.deepEqual(pitches(result.yaml)[0], [62, 66, 62]);
  assert.equal(result.report.voices[0].legato, 1);
  assert.deepEqual(result.report.tempo.values, [7, 5]);
  assert.equal(result.report.tempo.alternating, true);
  const names = Object.keys(yaml.parse(result.yaml).instruments);
  assert.ok(names.some((n) => /_a0s1/.test(n)), `the arpeggio command makes an instrument variant: ${names}`);
  assert.deepEqual(result.report.commands, {});
});

test("a multi-SID song maps tracks 4-6 to SID 2 and refuses drivers above 11.05", () => {
  const seq = seqBytes([[0, 0x30], [null, 0x7e], [null, 0x7e], [null, 0]]);
  const bytes = sf2File({
    tracksCount: 6, tracks: [[[0, 1]], [[0, 0]], [[0, 0]], [[0, 0]], [[0, 1]], [[12, 1]]], sequences: { 1: seq },
    instruments: { 0: [0, 0xf0, 0x80, 0, 0, 0] }, wave: { 0: [0x41, 0], 1: [0x7f, 0] },
  });
  const result = importSf2(bytes);
  assert.equal(result.report.voices.length, 6);
  assert.equal(result.report.songs, 1);
  const doc = yaml.parse(result.yaml);
  assert.equal(doc.sids.length, 2);
  assert.deepEqual(doc.sids.map((s) => s.address), ["$D400", "$D420"]);
  assert.deepEqual(pitches(result.yaml).filter((p) => p.length), [[60], [60], [72]]);
  compileSidwaveToPrg(parseSidwave(result.yaml));
  assert.throws(() => importSf2(sf2File({ tracks: [[[0, 0]], [[0, 0]], [[0, 0]]], minor: 6 })), /11\.06; only drivers 11\.00 to 11\.05/);
  assert.throws(() => importSf2(sf2File({ tracks: [[[0, 0]], [[0, 0]], [[0, 0]], [[0, 0]]], tracksCount: 4 })), /multiple of three/);
});

test("a slide becomes a bend and a portamento a glide from the preceding note", () => {
  const seq = seqBytes([[0, 0x30, 1], ...Array.from({ length: 7 }, () => [null, 0x7e]), [0, 0x30, 2], [null, 0x37, null, true], ...Array.from({ length: 6 }, () => [null, 0x7e])]);
  const result = importSf2(sf2File({
    tracks: [[[0, 1]], [[0, 0]], [[0, 0]]], sequences: { 1: seq }, instruments: { 0: [0, 0xf0, 0x80, 0, 0, 0] }, wave: { 0: [0x41, 0], 1: [0x7f, 0] },
    cmds: { 1: [0, 0x00, 0x40], 2: [2, 0x00, 0x40] },
  }));
  const groove = Object.values(yaml.parse(result.yaml).voices[0].patterns)[0].groove;
  const tokens = Array.isArray(groove) ? groove : [];
  const bend = tokens.find((t) => t && typeof t === "object" && t.bend);
  assert.ok(bend && bend.bend.to >= 1, JSON.stringify(groove));
  const glide = tokens.find((t) => t && typeof t === "object" && t.portamento);
  assert.ok(glide && glide.portamento >= 1, JSON.stringify(groove));
  assert.deepEqual(result.report.commands, {});
});

test("container, driver and data errors say what is wrong", () => {
  const good = smallSf2();
  assert.throws(() => parseSf2(Buffer.alloc(4)), /too short/);
  const noId = Buffer.from(good); noId[2] = 0;
  assert.throws(() => parseSf2(noId), /0x1337/);
  assert.throws(() => parseSf2(good.subarray(0, 60)), Sf2Error);
  assert.throws(() => parseSf2(Buffer.alloc(1_000_001)), /limit/);
  assert.throws(() => importSf2(sf2File({ tracks: [[[0, 0]], [[0, 0]], [[0, 0]]], major: 14 })), /driver 14\.00; only drivers 11\.00 to 11\.05/);
  assert.throws(() => importSf2(good, { song: 2 }), /does not exist; the file has 1/);
  assert.throws(() => importSf2(sf2File({ tracks: [[[0, 5]], [[0, 0]], [[0, 0]]], sequences: { 5: new Uint8Array(256).fill(0x30) } })), (e) => e instanceof Sf2Error && /sequence 5 has no end marker/.test(e.message));
  const tall = sf2File({ tracks: [[[0, 1]], [[0, 0]], [[0, 0]]] });
  tall[2 + L.ol1 - L.load] = 0x70; tall[2 + L.ol1 - L.load + 1] = 0x70; tall.fill(0x70, 2 + L.ol1 - L.load, 2 + L.ol1 - L.load + 256);
  assert.throws(() => importSf2(tall), /no end marker|entries/);
  // Round trip of the stream coding.
  const events = [{ instrument: 3, command: 0x80, note: 0x30, tied: false }, { instrument: 0x80, command: 0x80, note: 0x7e, tied: false }, { instrument: 0x80, command: 5, note: 0, tied: false }];
  const packed = packSequence(events);
  const again = sf2File({ tracks: [[[0, 1]], [[0, 0]], [[0, 0]]], sequences: { 1: packed } });
  assert.deepEqual(readSequence(parseSf2(again), 1), events);
  assert.deepEqual(readOrderList(parseSf2(again), 0), { entries: [{ transposition: 0, sequence: 1 }], loop: 0 });
});

const SCORE = {
  sidwave: 1.3, title: "Exp", tempo: 125.3114,
  instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
    { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
  timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
};

test("export needs a driver of the right kind and writes a file that the reader and importer accept", () => {
  const doc = parseSidwave(yaml.stringify(SCORE));
  assert.throws(() => exportSf2(doc, {}), /driver is required/);
  assert.throws(() => exportSf2(doc, { driver: Buffer.alloc(50) }), Sf2Error);
  assert.throws(() => exportSf2(doc, { driver: sf2File({ tracks: [[[0, 0]], [[0, 0]], [[0, 0]]], major: 12 }) }), /export supports driver 11/);
  // A driver PRG carries the address of sequence 0 only; the exporter fills the pointer table.
  const prg = sf2File({ tracks: [[[0, 0]], [[0, 0]], [[0, 0]]], size: L.seq0 + 3 - L.load });
  const prgLike = Buffer.from(prg);
  for (let n = 1; n < 128; n++) { prgLike[2 + L.seqlo + n - L.load] = 0; prgLike[2 + L.seqhi + n - L.load] = 0; }
  for (const driver of [prgLike, smallSf2()]) {
    const result = exportSf2(doc, { driver });
    assert.equal(result.framesPerRow, 12);
    assert.ok(result.losses.some((l) => /Pulse width modulation/.test(l)));
    const song = parseSf2(result.bytes);
    assert.equal(song.driver.major, 11);
    const back = importSf2(result.bytes);
    assert.deepEqual(pitches(back.yaml).filter((p) => p.length), exportEvents(doc).voices.map((v) => v.notes.map((n) => n.pitch)));
    assert.deepEqual(back.report.tempo.values, [11]);
    assert.ok(result.maxTimingErrorFrames <= 1);
  }
});

test("the command line imports by id or extension and exports with --driver", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-sf2-"));
  try {
    const run = async (...args) => {
      const out = [], err = [];
      const code = await runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "a.sf2"), smallSf2());
    fs.copyFileSync(path.join(dir, "a.sf2"), path.join(dir, "noext"));
    for (const name of ["a.sf2", "noext"]) {
      const imported = await run("import", name, "-o", `${name}.yaml`, "--json");
      assert.equal(imported.code, 0, imported.err);
      assert.equal(JSON.parse(imported.out).result.format, "sf2");
    }
    const noDriver = await run("export", "a.sf2.yaml", "-o", "b.sf2");
    assert.notEqual(noDriver.code, 0);
    assert.match(noDriver.err, /--driver <file>/);
    const exported = await run("export", "a.sf2.yaml", "-o", "b.sf2", "--driver", "a.sf2", "--json");
    assert.equal(exported.code, 0, exported.err);
    assert.equal(parseSf2(fs.readFileSync(path.join(dir, "b.sf2"))).driver.major, 11);
    fs.writeFileSync(path.join(dir, "bad.sf2"), "xx");
    assert.equal((await run("import", "bad.sf2", "--json")).code, 3);
    const other = await run("import", "a.sf2", "--song", "4", "-o", "x.yaml");
    assert.notEqual(other.code, 0);
    const missing = await run("convert", "a.sf2", "x.mid", "--song", "4");
    assert.equal(missing.code, 3, missing.err);
    assert.match(missing.err, /song 4 does not exist/);
    assert.match((await run("--help")).out, /SID Factory II/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mutated songs only raise typed errors, none takes two seconds", () => {
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const base = smallSf2();
  let typed = 0, ok = 0, slowest = 0;
  for (let i = 0; i < 1500; i++) {
    const d = Buffer.from(base);
    for (let k = 0; k < 1 + rnd(6); k++) {
      const region = rnd(5);
      const at = region === 0 ? 2 + rnd(0x200) : region === 1 ? 2 + L.ol1 - L.load + rnd(40) : region === 2 ? 2 + L.seq0 - L.load + 256 + rnd(120) : region === 3 ? 2 + L.instr - L.load + rnd(200) : 2 + L.wave - L.load + rnd(40);
      d[at] = rnd(256);
    }
    const input = rnd(10) === 0 ? d.subarray(0, rnd(d.length)) : d;
    const start = process.hrtime.bigint();
    try { importSf2(input, { validate: false }); ok++; } catch (error) {
      assert.ok(error instanceof InterchangeInputError, `${error.name}: ${error.message}`);
      typed++;
    }
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - start) / 1e9);
  }
  console.log(`# sf2 fuzz: 1500 cases, ${ok} imported, ${typed} typed errors, slowest ${slowest.toFixed(3)} s`);
  assert.ok(typed > 20 && ok > 20);
  assert.ok(slowest < 2);
});

test("import and export of the largest song stay within the CPU bound", () => {
  // 3 tracks of 250 order list entries, 128 sequences of 64 events.
  const sequences = {};
  for (let n = 0; n < 128; n++) sequences[n] = seqBytes(Array.from({ length: 64 }, (_, r) => (r % 4 === 0 ? [n % 8, 0x18 + ((n + r) % 40)] : [null, 0x7e])));
  const entries = Array.from({ length: 250 }, (_, i) => [0, i % 128]);
  const bytes = sf2File({ tracks: [entries, entries.slice().reverse(), entries], sequences, instruments: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, [0, 0xf0, 0x80, 0, 0, 0]])), wave: { 0: [0x41, 0], 1: [0x7f, 0] }, size: 0xa000 });
  const t0 = process.cpuUsage();
  const imported = importSf2(bytes, { validate: false, maxRows: 1_000_000 });
  const seconds = (process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1e6;
  console.log(`# cpu sf2 import (${imported.report.ticks} ticks x 3 tracks): ${seconds.toFixed(3)} s`);
  assert.ok(seconds < 4, `import used ${seconds} s`);
  const doc = parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Big", tempo: 125.3114,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 1, bars: 2, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } }],
    timeline: Array.from({ length: 300 }, (_, i) => ({ section: `s${i}`, bars: 2, layers: { v1: "a" } })),
  }));
  const t1 = process.cpuUsage();
  const exported = exportSf2(doc, { driver: smallSf2() });
  const u = process.cpuUsage(t1);
  console.log(`# cpu sf2 export (${exported.rows} rows): ${((u.user + u.system) / 1e6).toFixed(3)} s`);
  assert.ok((u.user + u.system) / 1e6 < 4);
});

test("export merges effect variants of an instrument into driver instruments and arpeggio commands", () => {
  // 40 instruments that differ only in their ADSR: more than the 32 instruments of the driver.
  const instruments = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`a${n}`, { waveform: "pulse", adsr: [n >> 4, n & 15, 8, 3], pulse_width: 2048 }]));
  const text = yaml.stringify({
    sidwave: 1.3, title: "Variants", tempo: 125.3114, instruments,
    voices: [{ id: 1, instrument: "a0", patterns: { a: { length: 0.5, bars: 5, groove: Array.from({ length: 40 }, (_, n) => ({ note: "C4", inst: `a${n}` })) } } }],
    timeline: [{ section: "one", bars: 5, layers: { v1: "a" } }],
  });
  const result = exportSf2(parseSidwave(text), { driver: smallSf2() });
  assert.equal(result.instruments, 1);
  const r = compareVoices(text, importSf2(result.bytes).yaml);
  assert.deepEqual([r.notes, r.unmatched, r.extra], [40, [], 0]);
  assert.equal(new Set(exportEvents(parseSidwave(importSf2(result.bytes).yaml)).instruments.map((i) => i.adsr.join(","))).size, 40);
});

/** The instrument name of every note of voice 1, in order. */
const noteInstruments = (text) => {
  const e = exportEvents(parseSidwave(text));
  const names = new Map(e.instruments.map((i) => [i.index, i.name]));
  return e.voices[0].notes.map((n) => names.get(n.instrument));
};

test("a pitch effect ends where the driver ends it: vibrato at the next note, arpeggio at an instrument or another effect", () => {
  const H = [null, 0x7e];
  // Commands: 1 vibrato, 2 arpeggio, 3 slide (zero speed), 4 wave program.
  const seq = seqBytes([
    [0, 0x30, 1], H, [null, 0x30], H,                    // vibrato, then a plain note: no vibrato
    [0, 0x30, 1], H, [null, 0x32, null, true], H,        // vibrato, then a tied note of another pitch: no vibrato
    [0, 0x30, 2], H, [null, 0x30], H, [0, 0x30], H,      // arpeggio stays on a plain note and ends at an instrument
    [0, 0x30, 2], H, [null, 0x30, 3], H, [null, 0x30], H, // arpeggio ends at a slide command
    [0, 0x30, 4], H, [null, 0x30], H,                    // the wave program lasts for its note
  ]);
  const result = importSf2(sf2File({
    tracks: [[[0, 1]], [[0, 0]], [[0, 0]]], sequences: { 1: seq }, instruments: { 0: [0, 0xf0, 0x80, 0, 0, 0] },
    wave: { 0: [0x41, 0], 1: [0x7f, 0], 2: [0x21, 0], 3: [0x7f, 2] }, cmds: { 1: [1, 4, 2], 2: [3, 0, 0], 3: [0, 0, 0], 4: [0x0b, 0, 2] }, arp: { 0: 0, 1: 4, 2: 7, 3: 0x70 },
  }));
  const names = noteInstruments(result.yaml);
  const kind = names.map((n) => (/_v\d/.test(n) ? "vib" : /_a0s0/.test(n) ? "arp" : /_w2/.test(n) ? "wave" : "plain"));
  // The fourth note is tied: the importer drops the vibrato there, but a SIDWave legato note keeps its instrument and the
  // report says so.
  assert.deepEqual(kind, ["vib", "plain", "vib", "vib", "arp", "arp", "plain", "arp", "plain", "plain", "wave", "plain"]);
  assert.ok(result.report.losses.some((l) => /^1 change\(s\) of arpeggio.* not heard/.test(l)), JSON.stringify(result.report.losses));
});

test("a slide on a continuing note whose sounding instrument sets pitches is reported, not written", () => {
  // The note starts on an arpeggio; a slide command on a hold row ends the arpeggio, but the legato note keeps that instrument.
  const seq = seqBytes([[0, 0x30, 1], [null, 0x7e], [null, 0x7e, 2], ...Array.from({ length: 5 }, () => [null, 0x7e])]);
  const result = importSf2(sf2File({
    tracks: [[[0, 1]], [[0, 0]], [[0, 0]]], sequences: { 1: seq }, instruments: { 0: [0, 0xf0, 0x80, 0, 0, 0] },
    wave: { 0: [0x41, 0], 1: [0x7f, 0] }, cmds: { 1: [3, 0, 0], 2: [0, 0, 0x80] }, arp: { 0: 0, 1: 4, 2: 7, 3: 0x70 },
  }));
  compileSidwaveToPrg(parseSidwave(result.yaml));
  assert.ok(result.report.losses.some((l) => /slide\(s\) are not imported/.test(l)), JSON.stringify(result.report.losses));
});

test("vibrato depth and rate follow the counters of the driver", () => {
  // Measured in driver 11 at XX=4, YY=2: five frames up and five down, 65 register units per frame at C-4.
  const v = sf2Vibrato(4, 2, 50.1245);
  assert.ok(Math.abs(v.rate - 5.01) < 0.02, `${v.rate}`);
  assert.ok(Math.abs(v.depth - 0.63) < 0.02, `${v.depth}`);
  assert.equal(sf2Vibrato(4, 12, 50.1245), undefined);
  assert.ok(sf2Vibrato(0, 0, 50.1245).rate === 12);
});

test("export writes the effect command on every note that has the effect, because the instrument of the next note ends it", () => {
  const text = yaml.stringify({
    sidwave: 1.3, title: "Fx", tempo: 125.3114,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3] }, vib: { waveform: "sawtooth", adsr: [0, 5, 9, 3], vibrato: { depth: 0.63, rate: 5.01 } } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { type: "arpeggio", notes: ["C4", "E4", "G4"], frame_rate: 2, length: 4 } } },
      { id: 2, instrument: "vib", patterns: { b: { length: 1, bars: 1, groove: ["C3", "D3", { note: "E3", inst: "lead" }, "F3"] } } }],
    timeline: [{ section: "one", bars: 2, layers: { v1: "a", v2: "b" } }],
  });
  // A driver whose order list pointers select another song than the first.
  const driver = smallSf2({ songs: 2 });
  for (let t = 0; t < 3; t++) driver[2 + L.oplo + t - L.load] += 0x40;
  const result = exportSf2(parseSidwave(text), { driver });
  const song = parseSf2(result.bytes);
  const commandsOf = (track) => readOrderList(song, track).entries.flatMap((e) => readSequence(song, e.sequence)).filter((e) => e.note > 0 && e.note < 0x7e).map((e) => {
    if (e.command === 0x80) return "none";
    return ["slide", "vib", "porta", "arp"][song.image[L.cmd + e.command]];
  });
  assert.ok(commandsOf(0).length >= 2);
  assert.deepEqual([...new Set(commandsOf(0))], ["arp"]);
  assert.deepEqual(commandsOf(1), ["vib", "vib", "none", "vib", "vib", "vib", "none", "vib"]);
  for (let t = 0; t < 3; t++) assert.equal(song.image[L.oplo + t] | (song.image[L.ophi + t] << 8), L.ol1 + t * 256);
  assert.equal(song.image[0x0ffb] | (song.image[0x0ffc] << 8), 0);
});

test("export writes the wavetable of an instrument as wave table rows and a test-bit first step as the oscillator reset", () => {
  const text = yaml.stringify({
    sidwave: 1.3, title: "Wave", tempo: 125.3114,
    instruments: { drum: { waveform: "pulse", adsr: [0, 4, 8, 3], wavetable: [{ wave: "noise", note: "C6", frames: 2 }, { wave: "tri", note: "+12", frames: 3 }, { wave: "pulse", note: "+0" }] }, reset: { waveform: "saw", adsr: [0, 4, 8, 3], wavetable: [{ test: true, frames: 1 }, { wave: "saw", note: "+7", frames: 1 }, { wave: "saw" }] } },
    voices: [{ id: 1, instrument: "drum", patterns: { a: { length: 1, bars: 1, groove: ["C4", "C4", { note: "C4", inst: "reset" }, "C4"] } } }],
    timeline: [{ section: "one", bars: 1, layers: { v1: "a" } }],
  });
  const result = exportSf2(parseSidwave(text), { driver: smallSf2() });
  assert.ok(!result.losses.some((l) => /wavetable steps/.test(l)), JSON.stringify(result.losses));
  const song = parseSf2(result.bytes);
  const instrument = (n) => ({ flags: song.image[L.instr + 2 * 32 + n], start: song.image[L.instr + 5 * 32 + n] });
  const row = (r) => [song.image[L.wave + r], song.image[L.wave + 256 + r]];
  const drum = instrument(0).start;
  // Two noise frames at the absolute C6, three triangle frames an octave up, then the held pulse row and a jump to it.
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => row(drum + i)), [[0x81, 0xc8], [0x81, 0xc8], [0x11, 12], [0x11, 12], [0x11, 12], [0x41, 0], [0x7f, drum + 5]]);
  const reset = instrument(1);
  assert.equal(reset.flags & 0x10, 0x10);
  assert.deepEqual(Array.from({ length: 3 }, (_, i) => row(reset.start + i)), [[0x21, 7], [0x21, 0], [0x7f, reset.start + 1]]);
  const back = importSf2(result.bytes);
  assert.deepEqual(yaml.parse(back.yaml).instruments.i00.wavetable, yaml.parse(importSf2(exportSf2(parseSidwave(back.yaml), { driver: smallSf2() }).bytes).yaml).instruments.i00.wavetable);
});

test("a file with several songs says that only one is imported", () => {
  const result = importSf2(smallSf2({ songs: 3 }));
  assert.ok(result.report.losses.some((l) => /holds 3 songs/.test(l)), JSON.stringify(result.report.losses));
  assert.throws(() => importSf2(smallSf2({ songs: 3 }), { song: 2 }), /has 3 songs and only the one/);
  assert.ok(!importSf2(smallSf2({ songs: 1 })).report.losses.some((l) => /songs/.test(l)));
});

test("a driver table with too few columns is a typed error on import and export", () => {
  const narrow = smallSf2({ columns: { 1: 1 } });
  assert.throws(() => importSf2(narrow), (e) => e instanceof Sf2Error && /table 1 .*1 column/.test(e.message));
  assert.throws(() => exportSf2(parseSidwave(yaml.stringify(SCORE)), { driver: narrow }), (e) => e instanceof Sf2Error && /column/.test(e.message));
});

test("a song with thousands of effect variants is imported in bounded time", () => {
  // 32 instruments combined with 64 local ADSR commands: 2048 variants.
  const sequences = {};
  for (let n = 0; n < 32; n++) sequences[n + 1] = seqBytes(Array.from({ length: 64 }, (_, c) => [n, 0x30, c]));
  const bytes = sf2File({
    tracks: [Array.from({ length: 32 }, (_, n) => [0, n + 1]), [[0, 0]], [[0, 0]]], sequences, size: 0x7000,
    instruments: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i, [i, 0xf0, 0, 0, 0, 0]])), wave: { 0: [0x41, 0], 1: [0x7f, 0] },
    cmds: Object.fromEntries(Array.from({ length: 64 }, (_, c) => [c, [8, c, c]])),
  });
  const t0 = process.cpuUsage();
  const result = importSf2(bytes, { validate: false });
  const u = process.cpuUsage(t0), seconds = (u.user + u.system) / 1e6;
  console.log(`# cpu sf2 import with 2048 variants: ${seconds.toFixed(3)} s`);
  assert.ok(result.report.losses.some((l) => /local-ADSR commands are not imported/.test(l)), JSON.stringify(result.report.losses.slice(0, 3)));
  assert.ok(seconds < 3, `${seconds} s`);
  // 2048 different wave programs cannot be reduced: a typed error, without converting all of them.
  const waves = sf2File({
    tracks: [Array.from({ length: 32 }, (_, n) => [0, n + 1]), [[0, 0]], [[0, 0]]], sequences, size: 0x7000,
    instruments: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i, [i, 0xf0, 0, 0, 0, 0]])),
    wave: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, i % 2 ? [0x41, i] : [0x21, i]])),
    cmds: Object.fromEntries(Array.from({ length: 64 }, (_, c) => [c, [0x0b, 0, 2 * c]])),
  });
  const t1 = process.cpuUsage();
  assert.throws(() => importSf2(waves, { validate: false }), (e) => e instanceof Sf2Error && /more than 63 instruments/.test(e.message));
  const w = process.cpuUsage(t1);
  assert.ok((w.user + w.system) / 1e6 < 3, `${(w.user + w.system) / 1e6} s`);
});

test("the command line does not overwrite the driver with the output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-sf2drv-"));
  try {
    const run = async (...args) => {
      const err = [];
      const code = await runCli(args, { cwd: dir, out: () => {}, err: (t) => err.push(t), outBytes: () => {} });
      return { code, err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "tune.sf2"), smallSf2());
    fs.writeFileSync(path.join(dir, "tune.yaml"), yaml.stringify(SCORE));
    // The default output name of tune.yaml is tune.sf2.
    for (const args of [["export", "tune.yaml", "--format", "sf2", "--driver", "tune.sf2"], ["export", "tune.yaml", "-o", "tune.sf2", "--driver", "tune.sf2"], ["convert", "tune.yaml", "tune.sf2", "--driver", "tune.sf2", "--force"]]) {
      const r = await run(...args);
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /is the driver file/);
      assert.deepEqual(fs.readFileSync(path.join(dir, "tune.sf2")), smallSf2());
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- differential against the real driver ------------------------------------------------------------------------
const MUSIC = path.join(homeDirectory(), ".c64bridge/sidwave-standalone/research-src/Chordian_sidfactory2/SIDFactoryII/music");
const listSf2 = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listSf2(path.join(dir, e.name)) : e.name.endsWith(".sf2") ? [path.join(dir, e.name)] : []));
const haveSongs = fs.existsSync(MUSIC) && listSf2(MUSIC).length > 0;
const engineOk = haveSongs ? await haveEngine() : false;
const reason = !haveSongs ? `no SID Factory II checkout with example songs at ${MUSIC}` : !engineOk ? "libsidplayfp-wasm not available" : undefined;
/**
 * Fixed alignment, not searched: the driver rises the gate of the first note on call 4 (call 0 is its init, the note
 * plays two calls after its row starts), SIDWave on call 1, so the driver lags by 3 calls. A search over -12..12 is
 * reported next to it.
 */
const STARTUP_CALLS = 3;
const fmt = (l) => l.map((x) => x.toFixed(2)).join("/");

test("differential: the driver inside each driver 11 example song against the imported score", { skip: reason }, async () => {
  const rows = [];
  for (const file of listSf2(MUSIC).sort()) {
    const bytes = fs.readFileSync(file);
    if (parseSf2(bytes).driver.major !== 11) continue;
    const result = importSf2(bytes);
    const diff = await compareSids(psidFromSf2(bytes, 0), compileScoreToSid(result.yaml), 8, -STARTUP_CALLS);
    console.log(`# ${path.basename(file)}: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}, tempo ${result.report.tempo.values.join(",")}, F-diff ${JSON.stringify(diff.fdiffClasses)}`);
    rows.push({ name: path.basename(file), gate: diff.agree.gate, note: diff.agree.pitch, both: diff.agree.both });
  }
  // The lowest voice (0.28, Pipes and Pearls voice 2) releases its gate with a wave program on a continuing note, which a
  // SIDWave legato note cannot do.
  const summary = assertQuality(rows, { songs: 54, gateVoice: 0.25, gateSong: 0.5, gateMedian: 0.94, noteSong: 0.15, noteMedian: 0.67 });
  console.log(`# sf2 quality: ${rows.length} songs, ${summary.voices} voices, gate median ${summary.gateMedian.toFixed(3)}, note median ${summary.noteMedian.toFixed(3)} over ${summary.noteVoices} voices`);
});

test("differential: the exported song in the driver against the compiled score", { skip: reason }, async () => {
  const text = yaml.stringify(SCORE);
  const driver = fs.readFileSync(path.join(MUSIC, "Driver 11 Test - Tie Notes.sf2"));
  const result = exportSf2(parseSidwave(text), { driver });
  const diff = await compareSids(compileScoreToSid(text), psidFromSf2(result.bytes, 0), 6, STARTUP_CALLS);
  console.log(`# export: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}, F-diff ${JSON.stringify(diff.fdiffClasses)}`);
  assert.ok(Math.abs(diff.agree.bestShift - STARTUP_CALLS) <= 1);
  assert.ok(diff.agree.gate[0] >= 0.8 && diff.agree.gate[1] >= 0.8, fmt(diff.agree.gate));
  assert.ok(diff.agree.pitch[0] >= 0.9 && diff.agree.pitch[1] >= 0.9, fmt(diff.agree.pitch));
});

test("differential: each driver 11 example song exported with itself as driver, in its driver, against the imported score", { skip: reason }, async () => {
  const rows = [];
  for (const file of listSf2(MUSIC).sort()) {
    const bytes = fs.readFileSync(file);
    if (parseSf2(bytes).driver.major !== 11) continue;
    const first = importSf2(bytes);
    const exported = exportSf2(parseSidwave(first.yaml), { driver: bytes });
    const diff = await compareSids(compileScoreToSid(first.yaml), psidFromSf2(exported.bytes, 0), 8, STARTUP_CALLS);
    console.log(`# export of ${path.basename(file)}: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}`);
    rows.push({ name: path.basename(file), gate: diff.agree.gate, note: diff.agree.pitch, both: diff.agree.both });
  }
  const summary = assertQuality(rows, { songs: 54, gateVoice: 0.65, gateSong: 0.8, gateMedian: 0.95, noteSong: 0.08, noteMedian: 0.7 });
  console.log(`# sf2 export quality: ${rows.length} songs, gate median ${summary.gateMedian.toFixed(3)}, note median ${summary.noteMedian.toFixed(3)} over ${summary.noteVoices} voices`);
});

// ---- multi-SID drivers (local checkout) --------------------------------------------------------------------------
const DRIVERS = path.join(homeDirectory(), ".c64bridge/sidwave-standalone/research-src/Chordian_sidfactory2/SIDFactoryII/drivers");
const multiReason = !fs.existsSync(path.join(DRIVERS, "sf2driver11_05_2sid.prg")) ? `no SID Factory II drivers at ${DRIVERS}` : undefined;
const sixVoices = (sids) => yaml.stringify({
  sidwave: 1.3, title: "Multi", tempo: 125.3114,
  sids: Array.from({ length: sids }, (_, n) => ({ id: `s${n + 1}`, address: `$D4${(n * 0x20).toString(16).padStart(2, "0")}` })),
  instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
    ...Array.from({ length: sids - 1 }, (_, n) => ({ id: 4 + n * 3, instrument: "bass", patterns: { r: { length: 1, bars: 1, groove: n ? "G2 G2 C2 C2" : "C2 C2 G2 G2" } } }))],
  timeline: [{ section: "one", bars: 4, layers: { v1: "a", ...Object.fromEntries(Array.from({ length: sids - 1 }, (_, n) => [`v${4 + n * 3}`, "r"])) } }],
});

for (const sids of [2, 3, 4]) {
  test(`export to the ${sids}-SID driver keeps the voices of every SID and imports back with a sids list`, { skip: multiReason }, async () => {
    const text = sixVoices(sids);
    const driver = fs.readFileSync(path.join(DRIVERS, `sf2driver11_05_${sids}sid.prg`));
    const result = exportSf2(parseSidwave(text), { driver });
    assert.equal(result.voices, sids);
    const back = importSf2(result.bytes);
    assert.equal(back.report.voices.length, sids * 3);
    assert.equal(yaml.parse(back.yaml).sids.length, sids);
    const original = exportEvents(parseSidwave(text)).voices.map((v) => v.notes.map((n) => n.pitch));
    assert.deepEqual(pitches(back.yaml).filter((p) => p.length), original);
    if (sids > 3 || !(await haveEngine())) return;
    // The first gate of each exported voice rises on call 4 of the driver, on every SID.
    const { irOf } = await import("./helpers/trackerDifferential.mjs");
    const ir = await irOf(psidFromSf2(result.bytes, 0), 2);
    const first = (s, v) => ir.calls.findIndex((c) => ((c.sids[s]?.regs[v * 7 + 4] ?? 0) & 1) === 1);
    assert.equal(first(0, 0), 4);
    for (let s = 1; s < sids; s++) assert.equal(first(s, 0), 4, `SID ${s + 1} voice 1`);
  });
}

// ---- real-song round trip ------------------------------------------------------------------------------------------
test("round trip on the example songs: import, export with the original as driver, import again keeps every note", { skip: !haveSongs ? reason : undefined, timeout: 600_000 }, () => {
  let songs = 0, notes = 0, matched = 0;
  for (const file of listSf2(MUSIC).sort()) {
    const bytes = fs.readFileSync(file);
    if (parseSf2(bytes).driver.major !== 11) continue;
    let first;
    first = importSf2(bytes);
    const exported = exportSf2(parseSidwave(first.yaml), { driver: bytes });
    const back = importSf2(exported.bytes);
    const r = compareVoices(first.yaml, back.yaml);
    songs++; notes += r.notes; matched += r.matched;
    // A moved C0 note shows once as unmatched and once as extra.
    assert.equal(r.extra, r.unmatched.length, `${path.basename(file)}: notes added by the round trip`);
    // Only C0 (MIDI 12) is lost: the driver's lowest note is C#0 and the importer reaches C0 through order list transposition.
    for (const u of r.unmatched) assert.equal(u.pitch, 12, `${path.basename(file)}: voice ${u.voice} note ${u.pitch} at ${u.on.toFixed(3)}-${u.off.toFixed(3)} s is not equal after the round trip`);
  }
  console.log(`# sf2 round trip: ${songs} songs export and import again; ${matched} of ${notes} notes equal (the rest are C0 notes)`);
  assert.ok(songs >= 54, `only ${songs} songs`);
  assert.ok(matched / notes >= 0.999, `${matched} of ${notes}`);
});
