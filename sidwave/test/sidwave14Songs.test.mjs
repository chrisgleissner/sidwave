import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { SIDWAVE_MAX_SONGS, SidwaveValidationError, parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { SongSelect, differsBySong, hasSongSelect, lintSongs, mergeSampleCommands, psidSpeedBits, songDoc } from "../src/sidwaveSongs.js";
import { parseSidFile } from "../src/sidFile.js";
import { lintSidwave } from "../src/sidwaveOps.js";
import { SIDWAVE_SCORE_RESOURCES, readSidwaveExample } from "../src/sidwaveExamples.js";
import { Cpu } from "./helpers/sidwaveEmulator.mjs";
import os from "node:os";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const BASE = {
  sidwave: 1.4,
  tempo: 125.31,
  instruments: { p: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, b: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
  voices: [
    { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" }, c: { length: 0.5, bars: 1, groove: "E5 D5 C5 B4 A4 G4 F4 E4" } } },
    { id: 2, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" }, q: { length: 1, bars: 1, groove: "F2 F2 A2 A2" } } },
  ],
  sections: { x: { bars: 2, layers: { v1: "a", v2: "r" } }, y: { bars: 2, layers: { v1: "c", v2: "q" } } },
};
const make = (patch) => ({ ...BASE, ...patch });
const text = (obj) => yaml.stringify(obj);
const parse = (obj) => parseSidwave(text(obj));
const TWO = [{ name: "one", timeline: ["x", "y"] }, { name: "two", timeline: ["y", "x", "y"], tempo: 100 }];

/** Document that holds song k only, as SIDWave 1.3, for comparison with the same song inside a document with songs. */
function standalone(obj, k) {
  const song = obj.songs[k];
  const { songs: _songs, ...rest } = obj;
  const one = { ...rest, sidwave: 1.3, timeline: song.timeline };
  if (song.tempo !== undefined) one.tempo = song.tempo;
  if (song.speed !== undefined) one.speed = song.speed;
  if (typeof song.loop === "string" || typeof song.loop === "number") one.loop_to = song.loop;
  return one;
}

/** A PRG or PSID player on the bundled emulator: init(A) and play() with every SID write and CIA 1 latch write recorded per call. */
function player(compiled, bytes) {
  const mem = new Uint8Array(65536);
  const prg = bytes ?? compiled.prg;
  const isSid = !!bytes;
  let initAddress = compiled.initAddress;
  let playAddress = compiled.playAddress;
  if (isSid) {
    const offset = bytes.readUInt16BE(6);
    const loadAt = bytes[offset] | (bytes[offset + 1] << 8);
    mem.set(bytes.subarray(offset + 2), loadAt);
    initAddress = bytes.readUInt16BE(10);
    playAddress = bytes.readUInt16BE(12);
  } else {
    mem.set(prg.subarray(2), compiled.loadAddress);
  }
  mem[0xea31] = 0x60;
  mem[0x02a6] = 1;
  let call = 0;
  let raster = 100;
  const writes = [];
  const cpu = new Cpu(mem, {
    write(a, v) { if ((a >= 0xd400 && a < 0xd800) || a === 0xdc04 || a === 0xdc05) writes.push({ call, a, v }); },
    read(a) { if (a === 0xd012) return (raster = (raster + 1) % 312) & 0xff; },
  });
  const run = (address, a) => { call += 1; return cpu.call(address, a); };
  return {
    cpu, mem, writes,
    init: (a = 0) => run(initAddress, a),
    play: () => run(playAddress, 0),
    get call() { return call; },
    /** SID writes of every call after the last init, one array of [address, value] per play call. */
    trace(from) {
      const calls = [];
      for (const w of writes) if (w.call > from && w.a < 0xdc00) (calls[w.call - from - 1] ??= []).push([w.a, w.v]);
      return calls;
    },
  };
}

/** Plays `song` after first playing `before` for 150 calls, and returns the SID writes of `frames` play calls. */
function playSong(compiled, bytes, song, frames, before) {
  const m = player(compiled, bytes);
  if (before !== undefined) { m.init(before); for (let i = 0; i < 150; i++) m.play(); }
  const start = m.call;
  m.init(song);
  for (let i = 0; i < frames; i++) m.play();
  const t = m.trace(start);
  return Array.from({ length: frames }, (_, i) => JSON.stringify(t[i + 1] ?? []));
}

const reference = (obj, k, frames, options = {}) => {
  const doc = parse(standalone(obj, k));
  const compiled = compileSidwaveToPrg(doc, options);
  const m = player(compiled);
  m.init(0);
  for (let i = 0; i < frames; i++) m.play();
  const t = m.trace(0);
  return Array.from({ length: frames }, (_, i) => JSON.stringify(t[i + 1] ?? []));
};

const fails = (obj, pattern, pathPart) => {
  assert.throws(() => parse(obj), (error) => {
    assert.ok(error instanceof SidwaveValidationError, String(error));
    assert.match(error.message, pattern);
    if (pathPart) assert.ok(error.path.startsWith(pathPart), `${error.path} should start with ${pathPart}`);
    return true;
  });
};

// ---------------------------------------------------------------- language: validation

test("a 1.3 document that contains songs is rejected with an error that names the version and the field", () => {
  for (const version of [1.2, 1.3, "1.3"]) fails(make({ sidwave: version, songs: TWO }), /songs require sidwave: 1\.4/, "$.songs");
  assert.throws(() => parse({ ...make({ sidwave: 1.5 }), timeline: ["x"] }), /use 1\.0, 1\.1, 1\.2, 1\.3 or 1\.4/);
});

test("songs: 0 songs, 1 song and the maximum number of songs", () => {
  fails(make({ songs: [] }), /expected a list of 1 to 32 songs/, "$.songs");
  fails(make({ songs: "x" }), /expected a list of 1 to 32 songs/);
  const one = parse(make({ songs: [{ name: "only", timeline: ["x"] }] }));
  assert.equal(one.songs.length, 1);
  assert.equal(hasSongSelect(one), false);
  const many = Array.from({ length: SIDWAVE_MAX_SONGS }, (_, i) => ({ name: `s${i}`, timeline: [i % 2 ? "x" : "y"] }));
  assert.equal(SIDWAVE_MAX_SONGS, 32);
  const max = parse(make({ songs: many }));
  assert.equal(max.songs.length, 32);
  const prg = compileSidwaveToPrg(max);
  assert.equal(prg.songs.length, 32);
  fails(make({ songs: [...many, { name: "s32", timeline: ["x"] }] }), /at most 32 songs.*33 were given/, "$.songs");
});

test("songs: the player indexes stream pointers with one byte, which limits songs times voice channels", () => {
  const sids = { layout: "ultisid8" };
  const ok = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, timeline: ["x"] }));
  assert.equal(parse(make({ sids, songs: ok })).songs.length, 10);
  fails(make({ sids, songs: [...ok, { name: "s10", timeline: ["x"] }] }), /11 songs of 24 voice channels exceed.*use at most 10 songs/, "$.songs");
});

test("songs: empty timeline, missing timeline and unknown sections are errors that name the song", () => {
  fails(make({ songs: [{ name: "a", timeline: [] }] }), /missing timeline/, "$.songs[0].timeline");
  fails(make({ songs: [{ name: "a", timeline: ["x"] }, { name: "b" }] }), /missing timeline/, "$.songs[1].timeline");
  fails(make({ songs: [{ name: "a", timeline: ["x"] }, { name: "b", timeline: ["x", "nope"] }] }), /unknown section nope/, "$.songs[1].timeline[1]");
  fails(make({ songs: [{ name: "a", timeline: [{ bars: 1, layers: { v1: "zz" } }] }] }), /zz/, "$.songs[0].timeline[0]");
  fails(make({ songs: [{ name: "a", timeline: new Array(4097).fill("x") }] }), /at most 4096 sections|exceeds 4096 bars/);
});

test("songs: names, keys and the fields that move into the song", () => {
  fails(make({ songs: [{ timeline: ["x"] }] }), /expected text|name/, "$.songs[0].name");
  fails(make({ songs: [{ name: "a", timeline: ["x"] }, { name: "a", timeline: ["y"] }] }), /used more than once/, "$.songs[1].name");
  fails(make({ songs: [{ name: "x".repeat(33), timeline: ["x"] }] }), /at most 32 characters/);
  fails(make({ songs: [{ name: "a", timeline: ["x"], jingle: true }] }), /jingle/, "$.songs[0]");
  fails(make({ songs: ["a"] }), /expected a song mapping/);
  fails(make({ songs: TWO, timeline: ["x"] }), /no top-level timeline/, "$.timeline");
  fails(make({ songs: TWO, loop_to: 1 }), /no top-level loop_to; use the loop field of a song/, "$.loop_to");
  fails(make({ songs: TWO, end: true }), /no top-level end; use loop: false/, "$.end");
  fails(make({ songs: TWO, length_bars: 4 }), /no top-level length_bars/, "$.length_bars");
  fails(make({ songs: TWO, samples: { rate: 4000, defs: { k: { hex: "fe18" } }, triggers: [{ sample: "k", at: [0] }] } }), /positioned on one timeline/, "$.samples");
});

test("songs: tempo, speed and loop per song, with the document values as defaults", () => {
  const doc = parse(make({ speed: 2, songs: [
    { name: "a", timeline: ["x", "y"] },
    { name: "b", timeline: ["x", "y"], tempo: 90, speed: 1, loop: false },
    { name: "c", timeline: ["x", "y"], loop: "y" },
    { name: "d", timeline: ["x", "y"], loop: 1 },
    { name: "e", timeline: ["x", "y"], loop: true },
  ] }));
  assert.deepEqual(doc.songs.map((s) => [s.tempo, s.speed, s.loop, s.loopTo, s.length_bars]),
    [[125.31, 2, true, undefined, 4], [90, 1, false, undefined, 4], [125.31, 2, true, 1, 4], [125.31, 2, true, 0, 4], [125.31, 2, true, undefined, 4]]);
  // The document-level fields describe song 0, so code that knows one song sees a complete score.
  assert.equal(doc.speed, 2);
  assert.equal(doc.timeline, doc.songs[0].timeline);
  assert.equal(parse(make({ songs: [{ name: "a", timeline: ["x"], tempo: 90 }] })).song.tempo, 90);
  fails(make({ songs: [{ name: "a", timeline: ["x"], tempo: 10 }] }), /tempo/, "$.songs[0].tempo");
  fails(make({ songs: [{ name: "a", timeline: ["x"], speed: 5 }] }), /speed/, "$.songs[0].speed");
  fails(make({ songs: [{ name: "a", timeline: ["x"], loop: "nowhere" }] }), /expected true, false, the name of a section/, "$.songs[0].loop");
  fails(make({ songs: [{ name: "a", timeline: ["x"], loop: 9 }] }), /loop/, "$.songs[0].loop");
  fails(make({ speed: 9, songs: TWO }), /speed/);
});

test("songs: bar checks apply across all songs and name the song's timeline", () => {
  const meter = make({ meter: "3/4", songs: [{ name: "a", timeline: ["x"] }] });
  assert.throws(() => parse(meter), (error) => error instanceof SidwaveValidationError);
  // A pattern that only a later song plays is checked in that song's metre, not in the song metre.
  const ok = make({
    voices: [{ id: 1, instrument: "p", patterns: { w: { length: 1, bars: 1, groove: "C4 E4 G4" }, a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } }],
    sections: { x: { bars: 1, layers: { v1: "a" } }, z: { bars: 1, meter: "3/4", layers: { v1: "w" } } },
    songs: [{ name: "a", timeline: ["x"] }, { name: "b", timeline: ["z"] }],
  });
  assert.equal(parse(ok).songs.length, 2);
});

// ---------------------------------------------------------------- compatibility with older versions

test("a 1.4 document without songs compiles to the bytes of the same document written as 1.3", () => {
  for (const { name } of SIDWAVE_SCORE_RESOURCES) {
    const source = readSidwaveExample(name);
    if (!/^sidwave: 1\.3$/m.test(source)) continue;
    const old = compileSidwaveToPrg(parseSidwave(source));
    const now = compileSidwaveToPrg(parseSidwave(source.replace(/^sidwave: 1\.3$/m, "sidwave: 1.4")));
    assert.equal(sha(now.prg), sha(old.prg), name);
  }
});

test("a document with one song compiles to the bytes of the same song written without songs, as PRG and PSID", () => {
  const withSongs = parse(make({ songs: [{ name: "only", timeline: ["x", "y"], tempo: 100 }] }));
  const plain = parse(standalone(make({ songs: [{ name: "only", timeline: ["x", "y"], tempo: 100 }] }), 0));
  assert.equal(sha(compileSidwaveToPrg(withSongs).prg), sha(compileSidwaveToPrg(plain).prg));
  assert.equal(sha(compileSidwaveToPrg(withSongs, { loop: false }).prg), sha(compileSidwaveToPrg(plain, { loop: false }).prg));
  const a = compileSidwaveToSid(withSongs, compileSidwaveToPrg(withSongs).prg).sid;
  const b = compileSidwaveToSid(plain, compileSidwaveToPrg(plain).prg).sid;
  assert.equal(sha(a), sha(b));
});

// ---------------------------------------------------------------- player: song selection

const MIX = make({
  speed: 1,
  songs: [
    { name: "intro", timeline: ["x", "y"] },
    { name: "fast", timeline: ["y", "x"], tempo: 100, speed: 2 },
    { name: "once", timeline: ["x", "y", "x"], tempo: 150, loop: false },
    { name: "back", timeline: ["x", "y", "x", "y"], loop: "y" },
    { name: "quad", timeline: ["y"], speed: 4, tempo: 90 },
  ],
});

test("every song writes the registers of the same song compiled alone, and a fresh init gives the same trace after any other song", () => {
  const doc = parse(MIX);
  const compiled = compileSidwaveToPrg(doc);
  assert.equal(compiled.songs.length, 5);
  const frames = 900;
  for (let k = 0; k < 5; k++) {
    const speed = MIX.songs[k].speed ?? 1;
    const expected = reference(MIX, k, frames, { loop: MIX.songs[k].loop !== false });
    assert.ok(expected.some((line) => line !== "[]"), `song ${k} writes registers`);
    for (const before of [undefined, 0, 4, (k + 1) % 5]) {
      assert.deepEqual(playSong(compiled, undefined, k, frames, before), expected, `song ${k} after ${before} (speed ${speed})`);
    }
  }
});

test("the PSID player takes the song in A, starts a song again at its first note and plays play-once songs to silence", () => {
  const doc = parse(MIX);
  const compiled = compileSidwaveToPrg(doc);
  const sid = compileSidwaveToSid(doc, compiled.prg).sid;
  const frames = 700;
  for (const k of [0, 2, 4]) {
    assert.deepEqual(playSong(compiled, sid, k, frames, 1), reference(MIX, k, frames, { loop: MIX.songs[k].loop !== false }), `psid song ${k}`);
  }
  // The play-once song stops writing: its last calls are empty.
  const once = playSong(compiled, sid, 2, compiled.songs[2].totalFrames + 400, 0);
  assert.equal(once.slice(-50).every((line) => line === "[]"), true);
});

test("PSID header: song count, start song, speed bits per song, CIA latch per song", () => {
  const doc = parse(MIX);
  const sid = compileSidwaveToSid(doc, compileSidwaveToPrg(doc).prg).sid;
  const file = parseSidFile(sid);
  assert.equal(file.songs, 5);
  assert.equal(file.startSong, 1);
  assert.equal(sid.readUInt32BE(18), 0b10010);
  assert.equal(psidSpeedBits(doc), 0b10010);
  assert.equal(psidSpeedBits({ speed: 3 }), 1);
  assert.equal(psidSpeedBits({ speed: 1 }), 0);
  // init programs the CIA 1 latch of the selected song
  const compiled = compileSidwaveToPrg(doc);
  const latch = (song, expectSpeed) => {
    const m = player(compiled, sid);
    m.init(song);
    const w = m.writes.filter((x) => x.a === 0xdc04 || x.a === 0xdc05);
    assert.equal(w.length, 2);
    assert.ok(Math.abs((w[0].v | (w[1].v << 8)) - Math.round(1_022_727 / (50.125 * expectSpeed))) < 3 || Math.abs((w[0].v | (w[1].v << 8)) - Math.round(985_248 / (50.125 * expectSpeed))) < 3);
  };
  latch(1, 2);
  latch(4, 4);
  // a document with a single speed keeps the one-latch init of 1.3
  const same = parse(make({ speed: 2, songs: TWO }));
  assert.equal(psidSpeedBits(same), 0b11);
  assert.equal(compileSidwaveToSid(same, compileSidwaveToPrg(same).prg).sid.readUInt32BE(18), 3);
});

test("an out-of-range song index plays song 0", () => {
  const doc = parse(make({ songs: TWO }));
  const compiled = compileSidwaveToPrg(doc);
  const zero = playSong(compiled, undefined, 0, 300, 1);
  for (const index of [2, 7, 255]) assert.deepEqual(playSong(compiled, undefined, index, 300, 1), zero, `index ${index}`);
});

test("the PRG plays the start song chosen by the song option, and rejects a song that does not exist", () => {
  const doc = parse(make({ songs: TWO }));
  const one = compileSidwaveToPrg(doc, { song: 1 });
  assert.equal(one.startSong, 1);
  assert.equal(one.framesPerSecond, one.songs[1].framesPerSecond);
  assert.throws(() => compileSidwaveToPrg(doc, { song: 2 }), /song 2 does not exist; the document has 2 songs/);
  assert.throws(() => compileSidwaveToPrg(doc, { song: -1 }), SidwaveValidationError);
  assert.throws(() => compileSidwaveToPrg(parse(standalone(make({ songs: TWO }), 0)), { song: 1 }), /has one song/);
  // The installer starts the chosen song: its init-less entry plays it from the first call.
  const m = player(one);
  m.cpu.call(one.entryAddress);
  const start = m.call;
  for (let i = 0; i < 200; i++) m.play();
  const wanted = reference(make({ songs: TWO }), 1, 200);
  const t = m.trace(start);
  assert.deepEqual(Array.from({ length: 200 }, (_, i) => JSON.stringify(t[i] ?? [])), wanted);
});

test("songs share one instrument table and the selector costs no cycles per play call", () => {
  const doc = parse(MIX);
  const compiled = compileSidwaveToPrg(doc);
  const own = (k) => arrangeSidwave(songDoc(doc, k)).instruments.length - 1;
  assert.ok(compiled.instrumentCount >= Math.max(own(0), own(1)), "the table holds the instruments of every song");
  // One song alone and the same song inside a document with songs have the same worst-case estimate.
  const alone = compileSidwaveToPrg(parse(standalone(MIX, 0)));
  assert.ok(compiled.worstCaseCyclesPerCall >= alone.worstCaseCyclesPerCall);
  assert.equal(compiled.songs[0].streamBytes, alone.streamBytes.reduce((a, b) => a + b, 0));
});

test("songs with different tempos and speeds each keep the filter sweep of their own tempo", () => {
  const filtered = make({
    tempo: 120,
    global_fx: { filter_env: { cutoff_base: 600, sweep: 900, speed: 4, resonance: 6, type: "lowpass" } },
    songs: [{ name: "slow", timeline: ["x", "y"], tempo: 70 }, { name: "quick", timeline: ["x", "y"], tempo: 200, speed: 2 }, { name: "mid", timeline: ["y", "x"] }],
  });
  const compiled = compileSidwaveToPrg(parse(filtered));
  for (let k = 0; k < 3; k++) {
    assert.deepEqual(playSong(compiled, undefined, k, 500, (k + 1) % 3), reference(filtered, k, 500), `song ${k}`);
  }
});

test("songs where only one song uses the filter, a table or a voice", () => {
  const partial = make({
    voices: [
      { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } },
      { id: 2, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" } } },
      { id: 3, instrument: "p", patterns: { u: { length: 1, bars: 1, groove: "G5 E5 C5 E5" } } },
    ],
    global_fx: { filter_env: { cutoff_base: 500, sweep: 700, speed: 2, voices: [1] } },
    sections: { x: { bars: 2, layers: { v1: "a", v2: "r" } }, z: { bars: 2, layers: { v1: "a", v2: "r", v3: "u" } }, k: { bars: 1, layers: {} } },
    songs: [{ name: "plain", timeline: ["x"] }, { name: "three", timeline: ["z", "x"] }, { name: "quiet", timeline: ["k", "k", "k"] }],
  });
  const compiled = compileSidwaveToPrg(parse(partial));
  for (let k = 0; k < 3; k++) assert.deepEqual(playSong(compiled, undefined, k, 400, (k + 2) % 3), reference(partial, k, 400), `song ${k}`);
});

test("songs on two SIDs", () => {
  const stereo = make({
    sids: [{ id: "sid1", address: "$D400", model: "8580" }, { id: "sid2", address: "$D420", model: "6581" }],
    voices: [
      { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } },
      { id: 4, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" } } },
      { id: 5, unison: { voice: 1, detune: 8 } },
    ],
    sections: { x: { bars: 2, layers: { v1: "a", v4: "r" } }, y: { bars: 1, layers: { v1: "a" } } },
    songs: [{ name: "a", timeline: ["x", "y"] }, { name: "b", timeline: ["y", "y", "x"], tempo: 170, loop: false }, { name: "c", timeline: ["x"], speed: 2 }],
  });
  const compiled = compileSidwaveToPrg(parse(stereo));
  const sid = compileSidwaveToSid(parse(stereo), compiled.prg).sid;
  assert.equal(parseSidFile(sid).songs, 3);
  for (let k = 0; k < 3; k++) {
    assert.deepEqual(playSong(compiled, undefined, k, 500, (k + 1) % 3), reference(stereo, k, 500, { loop: stereo.songs[k].loop !== false }), `song ${k}`);
  }
});

test("songs with play-once and looping songs mixed, all looping, and all playing once", () => {
  for (const loops of [[true, true], [false, false], [true, false], [false, true]]) {
    const obj = make({ songs: [{ name: "a", timeline: ["x"], loop: loops[0] }, { name: "b", timeline: ["y", "x"], loop: loops[1], tempo: 140 }] });
    const compiled = compileSidwaveToPrg(parse(obj));
    for (let k = 0; k < 2; k++) {
      const frames = compiled.songs[k].totalFrames * 2 + 60;
      assert.deepEqual(playSong(compiled, undefined, k, frames, 1 - k), reference(obj, k, frames, { loop: loops[k] }), `${loops} song ${k}`);
    }
    assert.deepEqual(compiled.songs.map((s) => s.loop), loops);
  }
  // The loop option off makes every song play once.
  const obj = make({ songs: TWO });
  assert.deepEqual(compileSidwaveToPrg(parse(obj), { loop: false }).songs.map((s) => s.loop), [false, false]);
});

test("songs with CIA2 digi voices compile as a PRG with samples, play the pitched voice and reject sample schedules tied to one timeline", () => {
  const digi = make({
    sids: [{ id: "sid1", address: "$D400", model: "8580" }, { id: "sid2", address: "$D420", model: "8580" }],
    samples: { rate: 4000, defs: { kick: { hex: "fe18" }, snare: { hex: "0f0f" } } },
    voices: [
      { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } },
      { id: "d1", digi: "sid2", patterns: { k: { length: 0.5, drums: { kit: { k: "sample:kick", s: "sample:snare" }, steps: "k.s.k.s." } }, s: { length: 0.5, drums: { kit: { s: "sample:snare" }, steps: "s..." } } } },
    ],
    sections: { x: { bars: 2, layers: { v1: "a", d1: "k*2" } }, y: { bars: 2, layers: { v1: "a", d1: "s*4" } }, z: { bars: 1, layers: { v1: "a" } } },
    songs: [{ name: "a", timeline: ["x"] }, { name: "b", timeline: ["y", "z"], tempo: 100 }, { name: "c", timeline: ["z"] }],
  });
  const doc = parse(digi);
  const compiled = compileSidwaveToPrg(doc);
  assert.ok(compiled.sampleBytes > 0);
  assert.equal(compiled.songs.length, 3);
  const commands = compiled.songs.length && arrangeSidwave(songDoc(doc, 0)).samples.commands;
  assert.ok(commands.length > 0);
  // The SID writes of the pitched voice are those of the same song alone (the samples use the CIA2 NMI, not tested here).
  const m = player(compiled);
  m.init(1);
  const start = m.call;
  for (let i = 0; i < 300; i++) m.play();
  assert.ok(m.trace(start).some((calls) => calls?.some(([a]) => a < 0xd420)));
  fails({ ...digi, samples: { ...digi.samples, voices: [{ sample: "kick", at_beat: [0] }] } }, /positioned on one timeline/);
});

test("the instrument table is shared and limited to 63 entries for all songs together", () => {
  const instruments = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`i${i}`, { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.1 + i / 100 }]));
  const voices = Array.from({ length: 2 }, (_, v) => ({
    id: v + 1,
    patterns: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`n${i}`, { length: 1, bars: 1, groove: `C4@i${i} E4 G4 C5` }])),
    instrument: "i0",
  }));
  const sections = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`s${i}`, { bars: 1, layers: { v1: `n${i}` } }]));
  const doc = parse({ sidwave: 1.4, tempo: 120, instruments, voices, sections, songs: [
    { name: "a", timeline: Array.from({ length: 35 }, (_, i) => `s${i}`) },
    { name: "b", timeline: Array.from({ length: 35 }, (_, i) => `s${i + 35}`) },
  ] });
  assert.throws(() => compileSidwaveToPrg(doc), /more than 63 distinct/);
});

// ---------------------------------------------------------------- init: its own writes and the reset

/** Every SID and CIA 1 latch write of the init call that starts `song`, after playing `before` (if given) for 150 calls. */
function initWrites(compiled, bytes, song, before) {
  const m = player(compiled, bytes);
  if (before !== undefined) { m.init(before); for (let i = 0; i < 150; i++) m.play(); }
  const call = m.call + 1;
  m.init(song);
  return m.writes.filter((w) => w.call === call).map((w) => [w.a, w.v]);
}

/** A copy of the PRG with the first occurrence of `pattern` (bytes, null matches any byte) overwritten by `patch`. */
function mutated(compiled, pattern, patch) {
  const prg = Buffer.from(compiled.prg);
  for (let at = 2; at + pattern.length <= prg.length; at++) {
    if (pattern.every((b, i) => b === null || prg[at + i] === b)) {
      patch.forEach((b, i) => { if (b !== null) prg[at + i] = b; });
      return { ...compiled, prg };
    }
  }
  throw new Error("pattern not found");
}

test("the init call writes the same SID and CIA 1 latch values after any other song as from a fresh start", () => {
  const doc = parse(MIX);
  const compiled = compileSidwaveToPrg(doc);
  const sid = compileSidwaveToSid(doc, compiled.prg).sid;
  for (const [c, bytes] of [[compiled, undefined], [compiled, sid]]) {
    for (let k = 0; k < 5; k++) {
      const fresh = initWrites(c, bytes, k, undefined);
      assert.ok(fresh.some(([a]) => a >= 0xd400), "init clears the SID");
      for (let before = 0; before < 5; before++) assert.deepEqual(initWrites(c, bytes, k, before), fresh, `${bytes ? "psid" : "prg"} song ${k} after ${before}`);
    }
  }
  // The PSID init of a song with several play calls per frame writes the CIA 1 latch, and the PRG init the same value.
  assert.equal(initWrites(compiled, sid, 1, 0).filter(([a]) => a === 0xdc04 || a === 0xdc05).length, 2);
});

test("mutation check: the comparisons fail when init skips the SID clear or the clear of the player variables", () => {
  const doc = parse(MIX);
  const compiled = compileSidwaveToPrg(doc);
  // ini_sid: lda #0 / ldy #$18 / sta (sid_io),y / dey / bpl  ->  the store becomes two NOPs
  const noSidClear = mutated(compiled, [0xa9, 0x00, 0xa0, 0x18, 0x91, 0xfd, 0x88, 0x10], [0xa9, 0x00, 0xa0, 0x18, 0xea, 0xea, 0x88, 0x10]);
  // Bun's node:assert has no notDeepEqual, so the two write lists are compared as JSON.
  assert.notEqual(JSON.stringify(initWrites(noSidClear, undefined, 1, 0)), JSON.stringify(initWrites(compiled, undefined, 1, undefined)), "the init writes differ");
  // ini_vars: lda #0 / ldx #n / sta vars,x / dex / cpx #$FF / bne  ->  the store becomes three NOPs
  const noVarsClear = mutated(compiled, [0xa9, 0x00, 0xa2, null, 0x9d, null, null, 0xca, 0xe0, 0xff, 0xd0], [0xa9, 0x00, 0xa2, null, 0xea, 0xea, 0xea, 0xca, 0xe0, 0xff, 0xd0]);
  const pairs = [[0, 1], [1, 2], [4, 0], [2, 3], [3, 4]];
  assert.ok(pairs.some(([before, song]) => JSON.stringify([...ramAfter(noVarsClear, before, song)]) !== JSON.stringify([...ramAfter(noVarsClear, undefined, song)])),
    "the RAM after a switch differs from a fresh start");
  // and the unmutated player matches for the same pairs
  for (const [before, song] of pairs) assert.deepEqual(ramAfter(compiled, before, song), ramAfter(compiled, undefined, song));
});

/** The player's RAM after init of `song` (after `before` if given) and one play call. */
function ramAfter(compiled, before, song) {
  const m = player(compiled);
  if (before !== undefined) { m.init(before); for (let i = 0; i < 150; i++) m.play(); }
  m.init(song);
  m.play();
  return m.mem.slice(compiled.loadAddress, compiled.endAddress);
}

test("after the first play call the player's RAM after a song switch equals that of a fresh start", () => {
  const compiled = compileSidwaveToPrg(parse(MIX));
  for (const [before, song] of [[0, 1], [1, 2], [4, 0], [2, 3], [3, 4]]) {
    assert.deepEqual(ramAfter(compiled, before, song), ramAfter(compiled, undefined, song), `song ${song} after ${before}`);
  }
});

// ---------------------------------------------------------------- lint and reports

test("lint: patterns and sections that no song uses, and songs that play nothing", () => {
  const obj = make({
    voices: [
      { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" }, spare: { length: 1, bars: 1, groove: "D4 D4 D4 D4" } } },
      { id: 2, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" } } },
    ],
    sections: { x: { bars: 1, layers: { v1: "a", v2: "r" } }, unused: { bars: 1, layers: { v1: "a" } }, mute: { bars: 1, layers: { v1: "-" } } },
    songs: [{ name: "tune", timeline: ["x"] }, { name: "empty", timeline: ["mute"] }],
  });
  const doc = parse(obj);
  const findings = lintSongs(doc);
  assert.deepEqual(findings.map((f) => `${f.code} ${f.first}`).sort(), [
    'SONG-SILENT song "empty"', 'UNUSED-PATTERN voice 1 pattern "spare"', 'UNUSED-SECTION section "unused"',
  ]);
  const report = lintSidwave(doc);
  assert.deepEqual(report.findings.map((f) => f.code).filter((c) => /SONG|UNUSED/.test(c)).sort(), ["SONG-SILENT", "UNUSED-PATTERN", "UNUSED-SECTION"]);
  assert.equal(lintSongs(parse(standalone(obj, 0))).length, 0, "documents without songs are not checked");
  // a document with one song is checked as well
  const single = parse(make({ songs: [{ name: "s", timeline: ["x"] }] }));
  assert.ok(lintSidwave(single).findings.some((f) => f.code === "UNUSED-SECTION" && f.first === 'section "y"'));
});

test("the finding limit applies after the findings of all songs are merged", () => {
  const doc = parse(make({ songs: TWO }));
  const compiled = compileSidwaveToPrg(doc);
  assert.ok(compiled.lint.length <= 12);
  // a song's own list is cut at 12 findings; merging uses every finding of every song, so a code that only
  // the second song reports is still present
  const second = compileSidwaveToPrg(parse(make({ tempo: 125.31, songs: [{ name: "a", timeline: ["x"], tempo: 120 }, { name: "b", timeline: ["x"], tempo: 133 }] })));
  assert.ok(second.lint.some((f) => f.code === "TEMPO-GRID" && f.count >= 2));
});

test("lint findings of the songs carry the song name and are merged by code", () => {
  const doc = parse(make({ songs: [{ name: "a", timeline: ["x"], tempo: 133 }, { name: "b", timeline: ["x"], tempo: 117 }] }));
  const finding = lintSidwave(doc).findings.find((f) => f.code === "TEMPO-GRID");
  assert.ok(finding);
  assert.match(finding.first, /^song "a": /);
  assert.ok(finding.count >= 2);
});

test("the arrangement report has the lines of every song", () => {
  const compiled = compileSidwaveToPrg(parse(make({ songs: TWO })));
  assert.ok(compiled.arrangement.some((line) => line.startsWith("[one] ")));
  assert.ok(compiled.arrangement.some((line) => line.startsWith("[two] ")));
  assert.equal(compiled.songs[1].name, "two");
  assert.ok(compiled.songs[1].durationSeconds > compiled.songs[0].durationSeconds);
});

// ---------------------------------------------------------------- the song selector as a unit

test("SongSelect: columns that do not differ cost nothing and a differing column is copied per song", () => {
  assert.equal(differsBySong([[1, 2], [1, 2]]), false);
  assert.equal(differsBySong([[1, 2], [1, 3]]), true);
  assert.equal(differsBySong([[1], [1, 2]]), true);
  const select = new SongSelect(3, 3, 1);
  assert.equal(select.column("same", [[1], [1], [1]]), "same: .byte 1");
  assert.equal(select.hasColumns, false);
  assert.equal(select.column("live", [[1, 0, 0], [1, 1, 0], [0, 1, 1]]), "live: .byte 1, 1, 0");
  select.copy("left", [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.equal(select.hasColumns, true);
  const asm = select.asm(["a", "b", "c", "d", "e", "f", "g", "h", "i"], ["a", "b", "c", "d", "e", "f", "g", "h", "i"]).join("\n");
  assert.match(asm, /song_sel: \.byte 1/);
  assert.match(asm, /song_mul3: \.byte 0, 3, 6/);
  assert.match(asm, /ss_col0: \.byte 1, 0, 0, 1, 1, 0, 0, 1, 1/);
  assert.equal(/ss_cia/.test(asm), false, "no CIA latch column when every song has the same speed"); // Bun's node:assert has no doesNotMatch
  assert.match(new SongSelect(2, 3, 0, { lo: [1, 2, 3, 4], hi: [0, 0, 0, 0] }).asm(["a", "b", "c", "d", "e", "f"], ["a", "b", "c", "d", "e", "f"]).join("\n"), /ss_cia_lo: \.byte 1, 2, 3, 4/);
  assert.throws(() => new SongSelect(86, 3, 0), /indexed by one byte/);
});

test("mergeSampleCommands renumbers the commands of every song into one table", () => {
  const e1 = [{ bytes: [0xaa, 0] }, { bytes: [0x10] }];
  const e2 = [{ bytes: [0xaa, 1] }, { bytes: [0xaa, 0] }];
  const merged = mergeSampleCommands([
    [{ chip: 1, at: [3], pitch: 0, name: "k" }, { chip: 1, at: [5], pitch: 0, name: "s" }],
    undefined,
    [{ chip: 1, at: [9], pitch: 0, name: "s" }, { chip: 1, at: [1], pitch: 2, name: "k" }],
  ], [[e1], [], [e2]], 0xaa);
  assert.deepEqual(merged.map((c) => [c.name, c.pitch, c.at]), [["k", 0, [3]], ["s", 0, [5, 9]], ["k", 2, [1]]]);
  assert.deepEqual(e1[0].bytes, [0xaa, 0]);
  assert.deepEqual([e2[0].bytes, e2[1].bytes], [[0xaa, 2], [0xaa, 1]]);
  assert.throws(() => songDoc(parse(make({ songs: TWO })), 5), RangeError);
});

// ---------------------------------------------------------------- the bundled example

test("the game_songs example has three songs that compile as PRG and PSID and sound like the songs alone", () => {
  const source = readSidwaveExample("game_songs");
  const doc = parseSidwave(source);
  assert.deepEqual(doc.songs.map((s) => [s.name, s.tempo, s.loop]), [["title", 110, true], ["ingame", 140, true], ["gameover", 90, false]]);
  assert.equal(doc.version, "1.4");
  const compiled = compileSidwaveToPrg(doc);
  const sid = compileSidwaveToSid(doc, compiled.prg).sid;
  assert.equal(parseSidFile(sid).songs, 3);
  assert.deepEqual(lintSongs(doc), []);
  const raw = yaml.parse(source);
  for (let k = 0; k < 3; k++) {
    assert.deepEqual(playSong(compiled, sid, k, 600, (k + 1) % 3), reference(raw, k, 600, { loop: raw.songs[k].loop !== false }), `song ${k}`);
  }
});

test("the documented 1.4 section exists in the language specification and the schema", () => {
  const spec = fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.md"), "utf8");
  assert.match(spec, /^## SIDWave 1\.4$/m);
  const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.schema.json"), "utf8"));
  assert.ok(schema.properties.songs);
  assert.ok(schema.properties.sidwave.enum.includes(1.4) && schema.properties.sidwave.enum.includes("1.4"));
  assert.equal(schema.properties.songs.maxItems, SIDWAVE_MAX_SONGS);
});

test("every YAML example in the 1.4 chapter of the specification compiles to a document with songs", () => {
  const spec = fs.readFileSync(path.join(here, "..", "data", "sound", "sidwave.md"), "utf8");
  const chapter = spec.slice(spec.indexOf("## SIDWave 1.4"), spec.indexOf("## Playable examples"));
  const examples = [...chapter.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(examples.length >= 1);
  for (const source of examples) {
    const compiled = compileSidwaveToPrg(parseSidwave(source));
    assert.deepEqual(compiled.songs.map((s) => s.name), ["title", "ingame", "gameover"]);
    assert.deepEqual(compiled.songs.map((s) => s.loop), [true, true, false]);
  }
});

test("sidwave compile --song n selects the PRG start song and the PSID start song", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-songs-")));
  try {
    fs.writeFileSync(path.join(dir, "g.sidwave.yaml"), readSidwaveExample("game_songs"));
    fs.writeFileSync(path.join(dir, "one.sidwave.yaml"), text(standalone(make({ songs: TWO }), 0)));
    const cli = (...args) => {
      const out = []; const err = [];
      const code = runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    const doc = parseSidwave(readSidwaveExample("game_songs"));
    assert.equal(cli("compile", "g.sidwave.yaml", "--song", "2", "-o", "a.prg").code, EXIT_OK);
    assert.equal(sha(fs.readFileSync(path.join(dir, "a.prg"))), sha(compileSidwaveToPrg(doc, { song: 2 }).prg));
    assert.notEqual(sha(fs.readFileSync(path.join(dir, "a.prg"))), sha(compileSidwaveToPrg(doc).prg));
    assert.equal(cli("compile", "g.sidwave.yaml", "--song=1", "-o", "b.sid").code, EXIT_OK);
    const sid = fs.readFileSync(path.join(dir, "b.sid"));
    assert.deepEqual([sid.readUInt16BE(14), sid.readUInt16BE(16)], [3, 2]);
    assert.equal(cli("compile", "g.sidwave.yaml", "-o", "c.sid").code, EXIT_OK);
    assert.equal(fs.readFileSync(path.join(dir, "c.sid")).readUInt16BE(16), 1);
    // errors: a song that does not exist, a bad value, the game target, a score without songs
    assert.equal(cli("compile", "g.sidwave.yaml", "--song", "3", "-o", "d.prg").code, EXIT_FAILED);
    assert.match(cli("compile", "g.sidwave.yaml", "--song", "3", "-o", "d.prg").err, /song 3 does not exist/);
    assert.equal(cli("compile", "g.sidwave.yaml", "--song", "x").code, EXIT_USAGE);
    assert.equal(cli("compile", "g.sidwave.yaml", "--song").code, EXIT_USAGE);
    assert.match(cli("compile", "g.sidwave.yaml", "--target", "game", "--origin", "0x1000", "--song", "1").err, /--song is not available with --target game/);
    assert.equal(cli("compile", "one.sidwave.yaml", "--song", "0", "-o", "e.prg").code, EXIT_OK);
    assert.equal(cli("compile", "one.sidwave.yaml", "--song", "1", "-o", "f.prg").code, EXIT_FAILED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
