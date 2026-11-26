import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { compileSidwave } from "../src/sidwaveGame.js";
import { SIDWAVE_SCORE_RESOURCES, readSidwaveExample } from "../src/sidwaveExamples.js";
import { runPrg } from "./helpers/sidwaveEmulator.mjs";
import { gameMachine, sidTrace } from "./helpers/sidwaveGameHarness.mjs";

// Every example that a game build accepts (all but digi_groove, which needs the CIA2 NMI), at origin $3001, zero page
// $40 and the data at $9001, or at $5001 when the data is too large to end below $D000. The machine memory starts
// filled with pseudo-random bytes, so the player may not depend on anything outside what init sets.
// The run is limited to CALL_LIMIT play calls (the whole song plus one loop for the shorter scores).
const CALL_LIMIT = 4000;
const NAMES = SIDWAVE_SCORE_RESOURCES.map(({ name }) => name).filter((name) => name !== "digi_groove" && name !== "game_songs"); // game_songs: see sidwaveSongsGame.test.mjs

function buildExample(doc) {
  for (const dataOrigin of [0x9001, 0x5001]) {
    try {
      return compileSidwave(doc, { target: "game", origin: 0x3001, dataOrigin, zeroPage: 0x40, measure: false });
    } catch (error) {
      if (error.path !== "$.timeline") throw error;
    }
  }
  throw new Error("no layout fits");
}

test("13 examples are buildable as a game", () => {
  assert.equal(NAMES.length, 13);
});

for (const name of NAMES) {
  test(`${name}: only contract ranges are written and the SID writes equal the PRG build's (garbage filled memory, up to ${CALL_LIMIT} calls)`, () => {
    const doc = parseSidwave(readSidwaveExample(name));
    const b = buildExample(doc);
    const prg = compileSidwaveToPrg(doc);
    const loopCalls = prg.totalFrames + (b.image.loopFrame === undefined ? prg.totalFrames : prg.totalFrames - b.image.loopFrame) + 4;
    const calls = Math.min(CALL_LIMIT, doc.end ? prg.totalFrames + 4 : loopCalls);
    const reference = runPrg(prg, calls).calls.map((call) => call.writes.map((w) => [w.addr, w.value]));
    const m = gameMachine(b, { garbage: true });
    m.init(0, doc.song.mode === "NTSC" ? 1 : 0);
    for (let i = 0; i < calls; i++) m.play();
    m.stop();
    const { ram, zeroPage, sidRegisters } = b.contract;
    const allowed = (a) => sidRegisters.some(({ address, bytes }) => a >= address && a < address + bytes)
      || zeroPage.some(({ address, bytes }) => a >= address && a < address + bytes)
      || ram.some(({ start, end }) => a >= start && a < end) || a === 1 || (a >= 0x100 && a < 0x200);
    const stray = [...new Set(m.writes.filter(({ address }) => !allowed(address)).map(({ address }) => address))];
    assert.deepEqual(stray, []);
    const trace = sidTrace(m);
    for (let i = 0; i < calls; i++) assert.deepEqual(trace[i + 2] ?? [], reference[i], `${name} call ${i}`);
    assert.ok(reference.some((writes) => writes.length > 0));
  });
}
