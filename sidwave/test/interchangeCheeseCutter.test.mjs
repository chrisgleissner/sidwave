import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import { homeDirectory } from "./helpers/home.mjs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { CT, CheeseCutterError, parseCheeseCutter, writeCheeseCutter } from "../src/interchange/cheesecutter.js";
import { importCheeseCutter } from "../src/interchange/cheesecutterImport.js";
import { exportCheeseCutter } from "../src/interchange/cheesecutterExport.js";
import { runCli } from "../src/cli.js";
import { InterchangeInputError } from "../src/interchange/errors.js";
import { A, ctFile, ctInflated, orderList, rowsToSequence, smallSong } from "./helpers/ctFixtures.mjs";
import { psidFromCt } from "./helpers/ctDifferential.mjs";
import { haveEngine, compareSids, compileScoreToSid } from "./helpers/trackerDifferential.mjs";
import { buildCtPlayer } from "./helpers/ctPlayerBuild.mjs";
import { compareVoices } from "./helpers/roundTrip.mjs";
import { assertQuality } from "./helpers/quality.mjs";

const pitches = (text) => exportEvents(parseSidwave(text)).voices.map((v) => v.notes.map((n) => n.pitch));
/** A stand-in for the CheeseCutter player: data areas and pointer table only, no player code. Enough for the structure tests. */
const stubPlayer = () => { const image = ctInflated({ orders: [orderList([]), orderList([]), orderList([])] }).subarray(0, 0xb700); return Buffer.concat([Buffer.from([0x00, 0x0e]), image.subarray(0x0e00)]); };

test("a hand-built CheeseCutter song imports with notes, instruments, pulse program and tempo", () => {
  const result = importCheeseCutter(ctFile(smallSong()));
  assert.equal(result.report.ticks, 16);
  assert.equal(result.report.rowsPerBeat, 4);
  const doc = parseSidwave(result.yaml);
  assert.equal(doc.song.title, "Fixture");
  assert.equal(doc.song.author, "Tester");
  // Speed 5 is six frames per row: 60 * 50.1245 / (4 * 6) = 125.31 BPM.
  assert.ok(Math.abs(doc.song.tempo - 125.3114) < 1e-3);
  assert.deepEqual(pitches(result.yaml).filter((p) => p.length), [[48, 52, 55, 60, 48, 52, 55, 60], [36, 36, 43, 36, 36, 43]]);
  const lead = result.report.instruments.find((i) => i.number === 0);
  assert.equal(lead.notes, 8);
  const def = yaml.parse(result.yaml).instruments[lead.sidwave];
  assert.deepEqual(def.adsr, [0, 8, 10, 5]);
  assert.equal(def.pulsetable.steps[0].set, 0x880 + 8);
  assert.deepEqual(def.hard_restart, { frames: 2, adsr: [0, 0, 0, 0] });
  compileSidwaveToPrg(parseSidwave(result.yaml));
});

test("transposition, ties, legato, speed commands, chords and wave program arpeggios are read as the player reads them", () => {
  const seq = rowsToSequence([
    { note: 36, inst: 0, cmd: 0x81 }, // chord 1 on the first note
    { note: 0 },
    { note: 40, tied: true }, // tied note with a new pitch: legato
    { note: 40, tied: true }, // tied note with the same pitch: held
    { note: 1 }, // gate off
    { note: 36, inst: 0, cmd: 0xf3 }, // speed 3
    { note: 0 }, { note: 0 },
  ]);
  const bytes = ctFile(ctInflated({
    sequences: { 1: seq },
    orders: [orderList([[2, 1]]), orderList([]), orderList([])],
    instruments: { 0: [0x00, 0xf0, 0x40, 0x41, 0, 0, 0, 1] },
    wave: [[0x00, 0x41], [0x0c, 0x00], [0x7f, 0x01]],
    chord: [0x00, 0x04, 0x07, 0x80], chordIndex: [0, 0],
    speed: 5,
  }));
  const result = importCheeseCutter(bytes);
  assert.deepEqual(pitches(result.yaml)[0], [50, 54, 50]);
  assert.equal(result.report.voices[0].legato, 1);
  assert.equal(result.report.tempo.changes, 1);
  assert.deepEqual(result.report.tempo.framesPerTickRange, [4, 6]);
  assert.ok(Object.keys(parseSidwave(result.yaml).instruments).length >= 2, "the chord makes a second instrument variant");
  assert.ok(result.report.tempo.changesNotAtBarLine === 1);
});

test("a slide becomes a bend and a portamento a glide from the preceding note", () => {
  const rows = [{ note: 36, inst: 0, cmd: 1 }, ...Array.from({ length: 7 }, () => ({ note: 0 })), { note: 36, inst: 0, cmd: 2 }, { note: 43, tied: true }, ...Array.from({ length: 6 }, () => ({ note: 0 }))];
  const result = importCheeseCutter(ctFile(ctInflated({
    sequences: { 1: rowsToSequence(rows) }, orders: [orderList([[0, 1]]), orderList([]), orderList([])],
    instruments: { 0: [0, 0xf0, 0x80, 0x41, 0, 0, 0, 1] }, wave: [[0x00, 0x41], [0x7e, 0x00]],
    // command table: row 1 slide up at 0x0040 per call, row 2 portamento at 0x0040 per call
    cmds: { 1: [0, 0x00, 0x40], 2: [7, 0x00, 0x40] },
  })));
  const groove = Object.values(yaml.parse(result.yaml).voices[0].patterns)[0].groove;
  const tokens = Array.isArray(groove) ? groove : [];
  const bend = tokens.find((t) => t && typeof t === "object" && t.bend);
  assert.ok(bend, JSON.stringify(groove));
  assert.ok(bend.bend.to >= 1 && bend.bend.frames > 1 && bend.bend.frames <= 255);
  const glide = tokens.find((t) => t && typeof t === "object" && t.portamento);
  assert.ok(glide && glide.portamento >= 1, JSON.stringify(groove));
  assert.deepEqual(result.report.commands, {});
});

test("the speed list of the chord table is used when the song speed is below two", () => {
  const bytes = ctFile(ctInflated({ speed: 0, chord: [7, 5, 0x80], orders: [orderList([[0, 1]]), orderList([]), orderList([])], sequences: { 1: rowsToSequence(Array.from({ length: 16 }, (_, i) => ({ note: 36 + i, inst: 0 }))) }, instruments: { 0: [0, 0xf0, 0x80, 0x41, 0, 0, 0, 1] }, wave: [[0, 0x41], [0x7e, 0]] }));
  const result = importCheeseCutter(bytes);
  assert.equal(result.report.tempo.alternatingSpeeds, true);
  assert.deepEqual(result.report.tempo.framesPerTickRange, [6, 8]);
});

test("the speed list wraps after 256 entries, as the 8-bit index of the player does", () => {
  // No end value in the first 256 entries; the bytes behind them must not be read.
  const chord = Uint8Array.from({ length: 512 }, (_, i) => (i === 0x80 || i === 0x81 ? 0 : i < 256 ? 7 : 40));
  chord.fill(7, 0x80, 0x82);
  const rows = Array.from({ length: 64 }, () => ({ note: 36, inst: 0 }));
  const bytes = ctFile(ctInflated({ speed: 0, chord, chordIndex: [], orders: [orderList(Array.from({ length: 8 }, () => [0, 1])), orderList([]), orderList([])], sequences: { 1: rowsToSequence(rows) }, instruments: { 0: [0, 0xf0, 0x80, 0x41, 0, 0, 0, 1] }, wave: [[0, 0x41], [0x7e, 0]] }));
  const result = importCheeseCutter(bytes, { validate: false });
  assert.equal(result.report.ticks, 512);
  assert.deepEqual(result.report.tempo.framesPerTickRange, [8, 8]);
});

test("a driver .ct whose order list pointer leaves the image is a typed error", () => {
  const bad = smallSong(); bad[0xfa0 + 19 * 2] = 0xf0; bad[0xfa0 + 19 * 2 + 1] = 0xff;
  const doc = parseSidwave(importCheeseCutter(ctFile(smallSong())).yaml);
  assert.throws(() => exportCheeseCutter(doc, { driver: ctFile(bad) }), (e) => e instanceof CheeseCutterError && /track 1/.test(e.message));
});

test("container errors say what is wrong", () => {
  const good = ctFile(smallSong());
  assert.throws(() => parseCheeseCutter(Buffer.from("XYZ1234")), /magic CC2/);
  assert.throws(() => parseCheeseCutter(good.subarray(0, 20)), CheeseCutterError);
  assert.throws(() => parseCheeseCutter(Buffer.concat([Buffer.from("CC2"), Buffer.alloc(100, 7)])), /zlib/);
  assert.throws(() => parseCheeseCutter(ctFile(Buffer.alloc(1000))), /at least/);
  const old = smallSong(); old[65536] = 5;
  assert.throws(() => parseCheeseCutter(ctFile(old)), /older/);
  const stereo = smallSong(); stereo[65536] = 130;
  assert.throws(() => parseCheeseCutter(ctFile(stereo)), /stereo/);
  const bomb = Buffer.concat([Buffer.from("CC2"), deflateSync(Buffer.alloc(50_000_000), { level: 9 })]);
  assert.ok(bomb.length < 100_000);
  assert.throws(() => parseCheeseCutter(bomb), /inflates to more than/);
  const badPointer = smallSong(); badPointer[A.seqhi + 5] = 0xff; badPointer[A.seqlo + 5] = 0xff;
  assert.throws(() => parseCheeseCutter(ctFile(badPointer)), /sequence 5/);
  assert.throws(() => importCheeseCutter(good, { song: 2 }), /does not exist; the file has 1/);
  const badSeq = ctFile(ctInflated({ orders: [orderList([[0, 200]]), orderList([]), orderList([])] }));
  assert.throws(() => importCheeseCutter(badSeq), (e) => e instanceof CheeseCutterError && /sequence 200/.test(e.message));
  assert.throws(() => importCheeseCutter(ctFile(ctInflated({ orders: [orderList([]), orderList([]), orderList([])], subtunes: [] }))), /no subtune/);
});

test("the writer reproduces what the reader parsed", () => {
  const original = ctFile(smallSong());
  const again = writeCheeseCutter(parseCheeseCutter(original));
  const a = parseCheeseCutter(original), b = parseCheeseCutter(again);
  assert.deepEqual(b.image, a.image);
  assert.deepEqual(b.orderLists, a.orderLists);
  assert.equal(b.title, "Fixture");
  assert.equal(importCheeseCutter(again).yaml, importCheeseCutter(original).yaml);
});

test("export needs a driver, rejects unusable drivers, and writes a file that the reader and importer accept", () => {
  const doc = parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Exp", tempo: 125,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  }));
  assert.throws(() => exportCheeseCutter(doc, {}), /driver is required/);
  assert.throws(() => exportCheeseCutter(doc, { driver: Buffer.alloc(50) }), /neither a .ct file nor/);
  assert.throws(() => exportCheeseCutter(doc, { driver: Buffer.alloc(0x2000) }), /player binary/);
  for (const driver of [stubPlayer(), ctFile(smallSong())]) {
    const result = exportCheeseCutter(doc, { driver });
    assert.equal(result.driver, Buffer.from(driver).subarray(0, 3).toString() === "CC2" ? "ct-file" : "player-binary");
    assert.ok(result.losses.some((l) => /Pulse width modulation/.test(l)));
    const song = parseCheeseCutter(result.bytes);
    assert.equal(song.title, "Exp");
    assert.equal(song.speeds[0], result.framesPerRow - 1);
    const back = importCheeseCutter(result.bytes);
    const original = exportEvents(doc).voices.map((v) => v.notes.map((n) => n.pitch));
    assert.deepEqual(pitches(back.yaml).filter((p) => p.length), original);
    assert.ok(result.maxTimingErrorFrames <= 1);
    // The sequences and order list of the old song in a .ct driver are gone.
    assert.equal(back.report.songs, 1);
  }
});

test("the command line imports by magic or extension and exports with --driver", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-ct-"));
  try {
    const run = async (...args) => {
      const out = [], err = [];
      const code = await runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "a.ct"), ctFile(smallSong()));
    fs.copyFileSync(path.join(dir, "a.ct"), path.join(dir, "noext"));
    for (const name of ["a.ct", "noext"]) {
      const imported = await run("import", name, "-o", `${name}.yaml`, "--json");
      assert.equal(imported.code, 0, imported.err);
      assert.equal(JSON.parse(imported.out).result.format, "cheesecutter");
    }
    const noDriver = await run("export", "a.ct.yaml", "-o", "b.ct");
    assert.notEqual(noDriver.code, 0);
    assert.match(noDriver.err, /--driver <file>/);
    const exported = await run("export", "a.ct.yaml", "-o", "b.ct", "--driver", "a.ct", "--json");
    assert.equal(exported.code, 0, exported.err);
    assert.ok(JSON.parse(exported.out).result.losses.length > 0);
    assert.equal(parseCheeseCutter(fs.readFileSync(path.join(dir, "b.ct"))).title, "Fixture");
    fs.writeFileSync(path.join(dir, "bad.ct"), "CC2");
    assert.equal((await run("import", "bad.ct", "--json")).code, 3);
    const wrong = await run("export", "a.ct.yaml", "--format", "midi", "--driver", "a.ct");
    assert.match(wrong.err, /--driver applies to/);
    assert.match((await run("--help")).out + (await run("help")).out, /cheesecutter/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mutated songs only raise typed errors, none takes two seconds", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const base = smallSong();
  let typed = 0, ok = 0, slowest = 0;
  for (let i = 0; i < 1500; i++) {
    const d = Buffer.from(base);
    for (let k = 0; k < 1 + rnd(6); k++) {
      // Mostly the regions the importer reads: pointer table, sequences, tables, order lists, header.
      const region = rnd(5);
      const at = region === 0 ? 0xfa0 + rnd(192) : region === 1 ? A.seq0 + rnd(1024) : region === 2 ? A.inst + rnd(512) : region === 3 ? 65536 + rnd(120) : A.arp1 + rnd(1024);
      d[at] = rnd(256);
    }
    const raw = rnd(10) === 0 ? ctFile(d).subarray(0, rnd(200)) : rnd(10) === 1 ? Buffer.concat([ctFile(d).subarray(0, 40), Buffer.from([rnd(256)])]) : ctFile(d);
    const start = process.hrtime.bigint();
    try { importCheeseCutter(raw, { validate: false }); ok++; } catch (error) {
      assert.ok(error instanceof InterchangeInputError, `${error.name}: ${error.message}`);
      typed++;
    }
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - start) / 1e9);
  }
  console.log(`# cheesecutter fuzz: 1500 cases, ${ok} imported, ${typed} typed errors, slowest ${slowest.toFixed(3)} s`);
  assert.ok(typed > 20 && ok > 20);
  assert.ok(slowest < 2);
});

test("import and export of the largest song stay within the CPU bound", () => {
  // 3 voices of 511 order list entries; 128 different full 64-row sequences.
  const sequences = {};
  for (let n = 0; n < 128; n++) sequences[n] = rowsToSequence(Array.from({ length: 64 }, (_, r) => (r % 4 === 0 ? { note: 24 + ((n + r) % 40), inst: n % 8 } : { note: 0 })));
  const entries = Array.from({ length: 511 }, (_, i) => [0, i % 128]);
  const big = ctFile(ctInflated({ sequences, orders: [orderList(entries), orderList(entries.slice().reverse()), orderList(entries)], instruments: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, [0, 0xf0, 0x80, 0x41, 0, 0, 0, 1]])), wave: [[0, 0x41], [0x7e, 0]] }));
  const t0 = process.cpuUsage();
  const imported = importCheeseCutter(big, { validate: false, maxRows: 1_000_000 });
  const u = process.cpuUsage(t0);
  const seconds = (u.user + u.system) / 1e6;
  console.log(`# cpu cheesecutter import (${imported.report.ticks} ticks x 3 voices): ${seconds.toFixed(3)} s`);
  assert.ok(seconds < 4, `import used ${seconds} s`);
  const doc = parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Big", tempo: 125.3114,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 1, bars: 2, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } }],
    timeline: Array.from({ length: 300 }, (_, i) => ({ section: `s${i}`, bars: 2, layers: { v1: "a" } })),
  }));
  const t1 = process.cpuUsage();
  const exported = exportCheeseCutter(doc, { driver: stubPlayer() });
  const u2 = process.cpuUsage(t1);
  const seconds2 = (u2.user + u2.system) / 1e6;
  console.log(`# cpu cheesecutter export (${exported.rows} rows): ${seconds2.toFixed(3)} s`);
  assert.ok(seconds2 < 4);
});

// ---- differential against the real player ------------------------------------------------------------------------
const TUNES = path.join(homeDirectory(), ".c64bridge/sidwave-standalone/research-src/theyamo_CheeseCutter/tunes");
const haveTunes = fs.existsSync(TUNES) && fs.readdirSync(TUNES).some((f) => f.endsWith(".ct"));
const engineOk = haveTunes ? await haveEngine() : false;
const reason = !haveTunes ? `no CheeseCutter checkout with example songs at ${TUNES}` : !engineOk ? "libsidplayfp-wasm not available" : undefined;
/**
 * Fixed alignment, not searched: the player spends one call on its init, one on loading the first sequence, and the
 * gate rises two calls after a row starts (the restart takes two calls), so the player's trace lags the SIDWave
 * trace by 4 calls. A search over -12..12 is run only to confirm that 4 is the best alignment.
 */
const STARTUP_CALLS = 4;
const fmt = (l) => l.map((x) => x.toFixed(2)).join("/");

test("differential: the player inside each example song against the imported score", { skip: reason }, async () => {
  const files = fs.readdirSync(TUNES).filter((f) => f.endsWith(".ct")).sort();
  const rows = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(TUNES, file));
    const result = importCheeseCutter(bytes);
    assert.ok(result.report.ticks > 0, file);
    if (result.report.multiplier > 1) { console.log(`# ${file}: skipped in the differential (multiplier ${result.report.multiplier}; the PSID needs CIA timing)`); continue; }
    const diff = await compareSids(psidFromCt(bytes, 0), compileScoreToSid(result.yaml), 8, -STARTUP_CALLS);
    console.log(`# ${file}: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}, F-diff ${JSON.stringify(diff.fdiffClasses)}`);
    rows.push({ name: file, gate: diff.agree.gate, note: diff.agree.pitch, both: diff.agree.both });
    assert.ok(Math.abs(diff.agree.bestShift + STARTUP_CALLS) <= 1 || result.report.tempo.alternatingSpeeds, `${file}: best shift ${diff.agree.bestShift}`);
  }
  const summary = assertQuality(rows, { songs: 10, gateVoice: 0.5, gateSong: 0.75, gateMedian: 0.95, noteSong: 0.35, noteMedian: 0.75 });
  console.log(`# cheesecutter quality: ${rows.length} songs, ${summary.voices} voices, gate median ${summary.gateMedian.toFixed(3)}, note median ${summary.noteMedian.toFixed(3)} over ${summary.noteVoices} voices`);
});

test("differential: the exported song in the player of the example songs against the compiled score", { skip: reason }, async () => {
  const text = yaml.stringify({
    sidwave: 1.3, title: "Exp", tempo: 125,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  });
  const driver = fs.readFileSync(path.join(TUNES, fs.readdirSync(TUNES).filter((f) => f.endsWith(".ct")).sort()[0]));
  const result = exportCheeseCutter(parseSidwave(text), { driver });
  const diff = await compareSids(compileScoreToSid(text), psidFromCt(result.bytes, 0), 6, STARTUP_CALLS);
  console.log(`# export: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}, F-diff ${JSON.stringify(diff.fdiffClasses)}`);
  assert.equal(diff.agree.bestShift, STARTUP_CALLS);
  assert.ok(diff.agree.gate[0] >= 0.9 && diff.agree.gate[1] >= 0.9, fmt(diff.agree.gate));
  assert.ok(diff.agree.pitch[0] >= 0.9 && diff.agree.pitch[1] >= 0.9, fmt(diff.agree.pitch));
});

test("differential: export with a raw player binary built from the local sources (assembled with the ACME of the checkout)", { skip: reason }, async () => {
  const player = buildCtPlayer();
  if (!player) { console.log("# raw player.bin path: skipped (no C compiler or checkout sources)"); return; }
  assert.equal(player[0], 0x00); assert.equal(player[1], 0x0e);
  const text = yaml.stringify({
    sidwave: 1.3, title: "Exp", tempo: 125.3114,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  });
  const result = exportCheeseCutter(parseSidwave(text), { driver: player });
  assert.equal(result.driver, "player-binary");
  const diff = await compareSids(compileScoreToSid(text), psidFromCt(result.bytes, 0), 6, STARTUP_CALLS);
  console.log(`# raw player.bin: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)}, best shift ${diff.agree.bestShift}`);
  assert.equal(diff.agree.bestShift, STARTUP_CALLS);
  assert.ok(diff.agree.gate[0] >= 0.9 && diff.agree.gate[1] >= 0.9, fmt(diff.agree.gate));
  assert.ok(diff.agree.pitch[0] >= 0.9 && diff.agree.pitch[1] >= 0.9, fmt(diff.agree.pitch));
});

const WAVE_SCORE = {
  sidwave: 1.3, title: "Wave", tempo: 125.3114,
  instruments: {
    pluck: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 2048, wavetable: [{ gate: true, frames: 1 }, { wave: "saw", gate: true, note: "+12", frames: 2 }, { wave: "pulse", gate: true, frames: 3 }], loop: 1 },
    chord: { waveform: "sawtooth", adsr: [0, 5, 9, 3], wavetable: [{ gate: true, note: "+7", frames: 1 }, { gate: true, note: "+4", frames: 1 }, { gate: true, frames: 1 }], loop: 0, hard_restart: { frames: 0 } },
  },
  voices: [{ id: 1, instrument: "pluck", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
    { id: 2, instrument: "chord", patterns: { r: { length: 1, bars: 1, groove: "C3 C3 G3 G3" } } }],
  timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
};

test("export keeps note ends, the length of the last note and legato notes", () => {
  const text = yaml.stringify({
    sidwave: 1.3, title: "Ends", tempo: 125.3114,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 2048 } },
    // The song has 18 rows of six frames, so its last sequence is shorter than the others; E4 to G4 and G4 to G4 are legato.
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.25, bars: 1, groove: ["C4", "~", "E4", "~", { note: "G4", legato: true }, "~", { note: "G4", legato: true }, "~", "C5", "~", "~", "~", "~", "~", "~", "~"] } } }],
    timeline: [{ section: "one", bars: 3, layers: { v1: "a" } }],
  });
  const result = exportCheeseCutter(parseSidwave(text), { driver: ctFile(smallSong()) });
  const back = importCheeseCutter(result.bytes);
  const r = compareVoices(text, back.yaml);
  assert.deepEqual([r.unmatched, r.extra], [[], 0]);
  assert.equal(back.report.ticks, result.rows);
  assert.ok(result.rows % result.sequenceRows !== 0, `${result.rows} rows in sequences of ${result.sequenceRows}`);
  assert.equal(back.report.voices[0].legato, 3);
});

test("differential: wavetable programs of an exported score play on the same calls as the compiled score", { skip: reason }, async () => {
  const driver = fs.readFileSync(path.join(TUNES, fs.readdirSync(TUNES).filter((f) => f.endsWith(".ct")).sort()[0]));
  const result = exportCheeseCutter(parseSidwave(yaml.stringify(WAVE_SCORE)), { driver });
  const diff = await compareSids(compileScoreToSid(yaml.stringify(WAVE_SCORE)), psidFromCt(result.bytes, 0), 6, STARTUP_CALLS);
  console.log(`# wavetable export: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)}, best shift ${diff.agree.bestShift}`);
  assert.equal(diff.agree.bestShift, STARTUP_CALLS);
  assert.ok(diff.agree.gate[0] >= 0.9 && diff.agree.gate[1] >= 0.9, fmt(diff.agree.gate));
  // The first call of every note still plays the pitch of the note before.
  assert.ok(diff.agree.pitch[0] >= 0.85 && diff.agree.pitch[1] >= 0.9, fmt(diff.agree.pitch));
});

test("differential: each example song exported with itself as driver, in its player, against the imported score", { skip: reason }, async () => {
  const rows = [];
  for (const file of fs.readdirSync(TUNES).filter((f) => f.endsWith(".ct")).sort()) {
    const bytes = fs.readFileSync(path.join(TUNES, file));
    const first = importCheeseCutter(bytes);
    if (first.report.multiplier > 1) continue;
    const exported = exportCheeseCutter(parseSidwave(first.yaml), { driver: bytes });
    const diff = await compareSids(compileScoreToSid(first.yaml), psidFromCt(exported.bytes, 0), 8, STARTUP_CALLS);
    console.log(`# export of ${file}: gate ${fmt(diff.agree.gate)}, note ${fmt(diff.agree.pitch)} (of ${diff.agree.both.join('/')} calls with both gates on), best shift ${diff.agree.bestShift}`);
    rows.push({ name: file, gate: diff.agree.gate, note: diff.agree.pitch, both: diff.agree.both });
  }
  const summary = assertQuality(rows, { songs: 12, gateVoice: 0.85, gateSong: 0.9, gateMedian: 0.97, noteSong: 0.45, noteMedian: 0.8 });
  console.log(`# cheesecutter export quality: ${rows.length} songs, gate median ${summary.gateMedian.toFixed(3)}, note median ${summary.noteMedian.toFixed(3)} over ${summary.noteVoices} voices`);
});

test("round trip on the example songs: import, export with the original as driver, import again keeps every note", { skip: !haveTunes ? reason : undefined, timeout: 300_000 }, () => {
  let songs = 0, notes = 0, matched = 0;
  for (const file of fs.readdirSync(TUNES).filter((f) => f.endsWith(".ct")).sort()) {
    const bytes = fs.readFileSync(path.join(TUNES, file));
    const first = importCheeseCutter(bytes);
    const exported = exportCheeseCutter(parseSidwave(first.yaml), { driver: bytes });
    const back = importCheeseCutter(exported.bytes);
    const r = compareVoices(first.yaml, back.yaml);
    songs++; notes += r.notes; matched += r.matched;
    assert.deepEqual([r.unmatched.slice(0, 3), r.extra], [[], 0], `${file}: notes that are not equal after the round trip`);
  }
  console.log(`# ct round trip: ${songs} songs, ${matched} of ${notes} notes equal`);
  assert.ok(songs >= 10);
});
