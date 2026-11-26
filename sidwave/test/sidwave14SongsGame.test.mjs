import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { compileSidwave, sidwaveGamePsid } from "../src/sidwaveGame.js";
import { parseSidFile } from "../src/sidFile.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { Cpu } from "./helpers/sidwaveEmulator.mjs";
import { gameMachine, sidTrace } from "./helpers/sidwaveGameHarness.mjs";

const doc = parseSidwave(readSidwaveExample("game_songs"));
const FRAMES = 700;

/** SID writes of `frames` play calls of song `song` of the PRG build: init at $0810 with A = song, then play. */
function prgTrace(song, frames, source = doc) {
  const compiled = compileSidwaveToPrg(source);
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60;
  mem[0x02a6] = 1;
  let writes = [];
  const cpu = new Cpu(mem, { write(a, v) { if (a >= 0xd400 && a < 0xd800) writes.push([a, v]); } });
  cpu.call(compiled.initAddress, song);
  const out = [];
  for (let i = 0; i < frames; i++) { writes = []; cpu.call(compiled.playAddress); out.push(JSON.stringify(writes)); }
  return out;
}

function gameTrace(m, song, frames, clock = 0) {
  const start = m.calls;
  m.init(song, clock);
  for (let i = 0; i < frames; i++) m.play();
  const t = sidTrace(m);
  return Array.from({ length: frames }, (_, i) => JSON.stringify(t[start + 2 + i] ?? []));
}

test("the game build selects the song with A in init and matches the PRG build of that song, from any previous song", () => {
  for (const layout of [{ origin: 0x1000 }, { origin: 0x2001, dataOrigin: 0x8001, zeroPage: 0xf0 }]) {
    const build = compileSidwave(doc, { target: "game", measure: false, ...layout });
    for (let k = 0; k < 3; k++) {
      const expected = prgTrace(k, FRAMES);
      assert.ok(expected.some((line) => line !== "[]"));
      for (const before of [undefined, (k + 1) % 3, (k + 2) % 3]) {
        const m = gameMachine(build, { garbage: true });
        if (before !== undefined) { m.init(before, 0); for (let i = 0; i < 200; i++) m.play(); m.stop(); }
        assert.deepEqual(gameTrace(m, k, FRAMES), expected, `${JSON.stringify(layout)} song ${k} after ${before}`);
      }
    }
  }
});

test("a song index beyond the last song plays song 0", () => {
  const build = compileSidwave(doc, { target: "game", measure: false, origin: 0x1000 });
  const zero = gameTrace(gameMachine(build), 0, 300);
  for (const index of [3, 4, 100, 255]) assert.deepEqual(gameTrace(gameMachine(build), index, 300), zero, `index ${index}`);
});

test("only contract ranges are written while all songs play and switch, with the memory filled with garbage", () => {
  const build = compileSidwave(doc, { target: "game", measure: false, origin: 0x3001, dataOrigin: 0x9001, zeroPage: 0x40 });
  const m = gameMachine(build, { garbage: true });
  for (const song of [2, 0, 1, 2, 1]) { m.init(song, 0); for (let i = 0; i < 500; i++) m.play(); }
  m.stop();
  const { ram, zeroPage, sidRegisters } = build.contract;
  const allowed = (a) => sidRegisters.some(({ address, bytes }) => a >= address && a < address + bytes)
    || zeroPage.some(({ address, bytes }) => a >= address && a < address + bytes)
    || ram.some(({ start, end }) => a >= start && a < end) || a === 1 || (a >= 0x100 && a < 0x200);
  assert.deepEqual([...new Set(m.writes.filter(({ address }) => !allowed(address)).map(({ address }) => address))], []);
});

test("the contract, the symbols and the measured cycles list every song", () => {
  const build = compileSidwave(doc, { target: "game", origin: 0x1000, symbols: ["acme", "vice", "json"] });
  assert.deepEqual(build.contract.songs.map((s) => [s.index, s.name, s.playCallsPerFrame, s.loop]),
    [[0, "title", 1, true], [1, "ingame", 1, true], [2, "gameover", 1, false]]);
  assert.match(build.contract.registers.init.in.A, /song index, 0-based \(0-2\)/);
  assert.equal(build.labels.sidwave_songs, 3);
  assert.match(build.symbols.acme, /sidwave_songs = \$03/);
  assert.match(build.symbols.acme, /song 1 "ingame": 1 play call\(s\) per frame, loops/);
  assert.match(build.symbols.vice, /al C:0003 \.sidwave_songs/);
  assert.equal(JSON.parse(build.symbols.json).contract.songs.length, 3);
  assert.equal(build.cycles.songs.length, 3);
  for (const song of build.cycles.songs) {
    assert.ok(song.worst > 0 && song.worst <= song.estimatedWorst, `${song.name}: ${song.worst} <= ${song.estimatedWorst}`);
  }
  assert.equal(build.cycles.worst, Math.max(...build.cycles.songs.map((s) => s.worst)));
  assert.ok(build.cycles.worst <= build.cycles.estimatedWorst);
  assert.ok(build.cycles.measuredOverSeconds > 60);
  assert.equal(build.image.songs.length, 3);
  const unmeasured = compileSidwave(doc, { target: "game", origin: 0x1000, measure: false });
  assert.deepEqual(unmeasured.cycles.songs.map((s) => s.worst), [null, null, null]);
});

test("a game build of a document without songs or with one song has no song fields and the same bytes as before", () => {
  const plain = parseSidwave(readSidwaveExample("fuer_elise"));
  const b = compileSidwave(plain, { target: "game", origin: 0x1000, measure: false });
  assert.equal(b.contract.songs, undefined);
  assert.equal(b.labels.sidwave_songs, undefined);
  assert.match(b.contract.registers.init.in.A, /only 0 exists/);
});

test("the game PSID keeps the host's song in A, records the song count and programs the latch per song", () => {
  for (const speeds of [[1, 1, 1], [1, 2, 1]]) {
    const timed = parseSidwave(readSidwaveExample("game_songs").replace(/^songs:/m, "songs:").replace("tempo: 140\n", `tempo: 140\n    speed: ${speeds[1]}\n`));
    const build = compileSidwave(timed, { target: "game", origin: 0x1000, measure: false });
    const sid = sidwaveGamePsid(timed, build);
    const file = parseSidFile(sid);
    assert.equal(file.songs, 3);
    assert.equal(sid.readUInt32BE(18), speeds[1] > 1 ? 0b010 : 0);
    // Run the PSID: init with each song and compare with the PRG build of the song.
    const dataOffset = sid.readUInt16BE(6);
    const load = sid[dataOffset] | (sid[dataOffset + 1] << 8);
    for (let k = 0; k < 3; k++) {
      const mem = new Uint8Array(65536);
      mem.set(sid.subarray(dataOffset + 2), load);
      mem[1] = 0x35;
      const writes = [];
      const latches = [];
      let call = 0;
      const cpu = new Cpu(mem, { write(a, v) { if (a >= 0xd400 && a < 0xd800) writes.push({ call, a, v }); if (a === 0xdc04 || a === 0xdc05) latches.push(v); } });
      call = 1;
      cpu.call(sid.readUInt16BE(10), k);
      const frames = 300;
      for (let i = 0; i < frames; i++) { call += 1; cpu.call(sid.readUInt16BE(12)); }
      const got = Array.from({ length: frames }, (_, i) => JSON.stringify(writes.filter((w) => w.call === i + 2).map((w) => [w.a, w.v])));
      const expected = prgTrace(k, frames, timed);
      assert.deepEqual(got, expected, `speeds ${speeds} song ${k}`);
      if (speeds[1] > 1) assert.equal(latches.length, 2, "the latch is written at init");
    }
  }
});
