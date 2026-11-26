// Runs a score with SIDWave 1.4 effects and the same score without them side by side on the bundled 6502 emulator, and
// checks after every play call that the effect engine and the music leave each other alone:
//  (a) the writes of every voice that no effect owns, and of the filter and volume registers, are those of the plain run;
//  (b) the SID register image equals the plain run's for every voice that no effect owns after the call, so that an
//      owned voice has its music values again from the call in which its effect ends;
//  (c) every write to a voice that an effect owns comes from the effect engine (the program counter is inside it), never
//      from the music;
//  (d) an effect that `sfx` accepted writes its first registers in the very next play call (latency of one play period).
import assert from "#test/assert";
import { Cpu } from "./sidwaveEmulator.mjs";
import { parseSidwave } from "../../src/sidwave.js";
import { compileSidwave } from "../../src/sidwaveGame.js";

export const ORIGIN = 0x1000;

/** Effects used by most tests: indexes 0 zap, 1 boom, 2 blip, 3 low, 4 top, 5 drone, 6 same. */
export const EFFECTS = `
effects:
  zap:
    priority: 5
    steps:
      - { freq: C6, wave: pulse, pulse: 0.5, adsr: [0, 2, 0, 0], wait: 2 }
      - { freq: 1200, wait: 3 }
      - { gate: false, wait: 1 }
  boom:
    priority: 9
    voices: [2, 3]
    steps:
      - { freq: 80, wave: noise, adsr: [0, 6, 0, 4], wait: 9 }
      - { gate: false, wait: 2 }
  blip:
    priority: 2
    voices: [3]
    steps:
      - { freq: A5, wave: triangle }
  low:
    priority: 0
    steps:
      - { freq: C4, wave: sawtooth, wait: 4 }
  top:
    priority: 15
    steps:
      - { freq: F3, wave: sawtooth, adsr: [0, 9, 0, 0], wait: 5 }
      - { gate: false, wait: 3 }
  drone:
    priority: 7
    steps:
      - { freq: 200, wave: triangle, wait: 255 }
      - { freq: 220, wait: 255 }
      - { gate: false, wait: 255 }
  same:
    priority: 5
    steps:
      - { freq: G4, wave: pulse, wait: 6 }
`;
export const EFFECT_FRAMES = { zap: 6, boom: 11, blip: 1, low: 4, top: 8, drone: 765, same: 6 };
export const E = { zap: 0, boom: 1, blip: 2, low: 3, top: 4, drone: 5, same: 6 };

/** A machine with the player loaded at `origin` (or the origin of the build), recording every SID write with its call and pc. */
export function effectMachine(build, { garbage = false } = {}) {
  const { memory, entryPoints } = build.contract;
  const mem = new Uint8Array(65536);
  if (garbage) { let seed = 0x7654321; for (let i = 0; i < mem.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; mem[i] = seed >>> 24; } }
  mem[0x2a6] = 1;
  mem.set(build.player, memory.player.start);
  if (build.data) mem.set(build.data, memory.data.start);
  mem[1] = 0x35;
  const writes = [];
  let call = 0;
  const cpu = new Cpu(mem, { write(address, value) { if (address >= 0xd400 && address < 0xd800) writes.push({ call, address, value, pc: cpu.pc }); } });
  const label = (name) => build.labels[`sidwave_int_${name}`];
  const eff = label("sfx_eff");
  const run = (address, a, x, y) => {
    call += 1;
    if (x !== undefined) cpu.x = x;
    if (y !== undefined) cpu.y = y;
    const cycles = cpu.call(address, a);
    return cycles;
  };
  return {
    cpu, mem, writes, build,
    init: (song = 0, clock = 0) => run(entryPoints.init, song, clock),
    play: () => run(entryPoints.play, 0),
    stop: () => run(entryPoints.stop, 0),
    /** Calls the sfx entry; `call` is not advanced, so its writes (there are none) belong to the previous call. */
    sfx(a, y) {
      cpu.y = y;
      const cycles = cpu.call(entryPoints.sfx, a);
      return { carry: cpu.c, cycles };
    },
    /** The effect (index + 1, 0 for none) that owns each voice of the first SID. */
    own: () => [0, 1, 2].map((v) => mem[eff + v]),
    /** The filter-off bit of each voice's effect (0 when none, or when the player was built without filter: off). */
    foff: () => (label("sfx_foff") === undefined ? [0, 0, 0] : [0, 1, 2].map((v) => mem[label("sfx_foff") + v])),
    /** Effect, step pointer, remaining wait and priority of each voice, as text. */
    state: () => [0, 1, 2].map((v) => [eff, label("sfx_pl"), label("sfx_ph"), label("sfx_wait"), label("sfx_prio")].map((base) => mem[base + v]).join(":")),
    engine: [label("sfx"), label("sfx_so") + 3],
    get call() { return call; },
  };
}

export function compileBoth(text, options = {}, effects = EFFECTS) {
  const opts = { target: "game", origin: ORIGIN, symbolsAll: true, measure: false, ...options };
  const withFx = compileSidwave(parseSidwave(text + effects), opts);
  const plain = compileSidwave(parseSidwave(text), { ...opts, symbolsAll: false });
  return { withFx, plain };
}

const voiceOf = (address) => { const r = address - 0xd400; return r >= 0 && r < 21 ? Math.floor(r / 7) : -1; };
const list = (writes) => writes.map((w) => `${w.address.toString(16)}=${w.value}`).join(",");

/**
 * Runs `calls` play calls of both builds after init(song). `actions` maps a call number (1-based) to the list of
 * { sfx: [a, y] } or { stop: true } actions that happen right before that call. Returns the log of every call.
 */
export function lockstep({ withFx, plain }, { song = 0, calls, actions = {}, ignoreRoute = false, garbage = false }) {
  const m = effectMachine(withFx, { garbage });
  const q = effectMachine(plain, { garbage });
  m.init(song, 0);
  q.init(song, 0);
  const imageM = new Array(0x19).fill(0);
  const imageQ = new Array(0x19).fill(0);
  const log = [];
  const accepted = [];
  let engineWrites = 0;
  for (let n = 1; n <= calls; n++) {
    const entry = { call: n, sfx: [], stopped: false };
    for (const action of actions[n] ?? []) {
      if (action.init !== undefined) {
        m.init(action.init, 0); q.init(action.init, 0);
        imageM.fill(0); imageQ.fill(0);
        entry.initialised = true;
        assert.deepEqual(m.own(), [0, 0, 0], `call ${n}: init cancels every effect`);
        continue;
      }
      if (action.stop) {
        m.stop(); q.stop();
        entry.stopped = true;
        assert.deepEqual(m.own(), [0, 0, 0], `call ${n}: stop cancels every effect`);
        continue;
      }
      const before = m.own();
      const stateBefore = m.state();
      const writesBefore = m.writes.length;
      const result = m.sfx(...action.sfx);
      assert.equal(m.writes.length, writesBefore, `call ${n}: sfx itself writes no SID register (the effect starts in the next play call)`);
      const after = m.own();
      const stateAfter = m.state();
      // The voice that took the effect: the one whose state changed; a restart of an effect that is still at its first
      // step changes nothing, so then the lowest voice that runs the effect.
      let voice = stateAfter.findIndex((state, v) => state !== stateBefore[v]);
      if (voice < 0) voice = after.findIndex((value) => value === action.sfx[0] + 1);
      entry.sfx.push({ a: action.sfx[0], y: action.sfx[1], carry: result.carry, cycles: result.cycles, before, after, voice: result.carry === 0 ? voice : -1 });
      if (result.carry !== 0) assert.deepEqual(stateAfter, stateBefore, `call ${n}: a rejected sfx changes nothing`);
      if (result.carry === 0) accepted.push({ call: n, voice, a: action.sfx[0] });
    }
    entry.own = m.own();
    entry.foff = m.foff();
    const startM = m.writes.length;
    const startQ = q.writes.length;
    entry.cycles = m.play();
    entry.plainCycles = q.play();
    const wm = m.writes.slice(startM);
    const wq = q.writes.slice(startQ);
    entry.writesM = wm;
    entry.writesQ = wq;
    entry.ownAfter = m.own();
    const [lo, hi] = m.engine;
    const fromEngine = (w) => w.pc >= lo && w.pc < hi;
    // (a)
    const keep = (writes) => writes.filter((w) => { const v = voiceOf(w.address); return v >= 0 ? entry.own[v] === 0 : !(ignoreRoute && w.address === 0xd417); });
    assert.equal(list(keep(wm)), list(keep(wq)), `call ${n}: writes of voices without an effect and the global registers equal the plain run's`);
    // (c) A voice whose effect ended in this call has the music's writes again after the engine's restore (the end of a
    // play-once song restores the voice and then releases it).
    const lastEngine = [0, 1, 2].map((v) => wm.reduce((last, w, i) => (fromEngine(w) && voiceOf(w.address) === v ? i : last), -1));
    wm.forEach((w, i) => {
      const v = voiceOf(w.address);
      const endedHere = v >= 0 && entry.own[v] !== 0 && entry.ownAfter[v] === 0;
      if (v >= 0 && entry.own[v] !== 0 && !(endedHere && i > lastEngine[v])) {
        assert.ok(fromEngine(w), `call ${n}: the write of $${w.address.toString(16)} to the owned voice ${v + 1} comes from pc $${w.pc.toString(16)}, not from the effect engine`);
      }
      if (fromEngine(w)) {
        engineWrites += 1;
        assert.ok(v >= 0 && entry.own[v] !== 0, `call ${n}: the effect engine wrote $${w.address.toString(16)}, which is not a register of an owned voice`);
      }
    });
    // (b)
    for (const w of wm) imageM[w.address - 0xd400] = w.value;
    for (const w of wq) imageQ[w.address - 0xd400] = w.value;
    for (let r = 0; r < 0x19; r++) {
      const v = r < 21 ? Math.floor(r / 7) : -1;
      if (v >= 0 && entry.ownAfter[v] !== 0) continue;
      if (ignoreRoute && r === 0x17) continue;
      assert.equal(imageM[r], imageQ[r], `call ${n}: SID register $${(0xd400 + r).toString(16)} equals the plain run's (no effect owns voice ${v + 1} after this call)`);
    }
    // (d)
    for (const a of accepted.filter((x) => x.call === n)) {
      assert.ok(wm.some((w) => fromEngine(w) && voiceOf(w.address) === a.voice), `call ${n}: the effect accepted before this call wrote voice ${a.voice + 1} within one play period`);
    }
    log.push(entry);
  }
  return { log, m, q, accepted, engineWrites };
}

/** The number of consecutive calls from `from` on that voice `voice` is owned at the start of the call. */
export function ownedCalls(log, voice, from) {
  let n = 0;
  for (let i = from - 1; i < log.length && log[i].own[voice] !== 0; i++) n += 1;
  return n;
}

export const worstCycles = (log) => Math.max(...log.map((entry) => entry.cycles));

/** A bundled example as a SIDWave 1.4 document; `loop` removes its `end` block so that the score loops. */
export function exampleText(source, { loop = true } = {}) {
  let text = source.replace(/^sidwave: 1\.\d/m, "sidwave: 1.4");
  if (loop) text = text.replace(/^end:.*$/m, "");
  return text;
}
