// The example game programs of examples/game (S4d): each is assembled with 6502-toolkit, run on the bundled emulator for
// hundreds of frames with scripted joystick input, and checked for: the effect starts when the program asks for it,
// the music of every voice that no effect owns is exactly the plain score's, the voice gets its music back, and the
// cycles of one frame stay below the PAL raster budget of 63 x 312 cycles.
import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrgDetailed } from "6502-toolkit/assembler";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwave } from "../src/sidwaveGame.js";
import { Cpu } from "./helpers/sidwaveEmulator.mjs";
import { gameMachine } from "./helpers/sidwaveGameHarness.mjs";
import { GAME_EXAMPLES, buildGameExample } from "../examples/game/build.mjs";

const FRAME_CYCLES = 63 * 312;
const api = { parseSidwave, compileSidwave, assemblyToPrgDetailed };
const RELEASED = 0xff;
const voiceOf = (address) => { const r = address - 0xd400; return r >= 0 && r < 21 ? Math.floor(r / 7) : -1; };

/** Runs the program: set-up code to its main loop, then `frames` raster interrupts at line 20 with `joystick(frame)` in $DC00. */
function runDemo(example, frames, joystick) {
  const { build, prg } = example;
  const labels = build.labels;
  const eff = labels.sidwave_int_sfx_eff;
  const mem = new Uint8Array(65536);
  mem[0x02a6] = 1;
  mem[0xea81] = 0x60;
  mem.set(prg.subarray(2), 0x0801);
  let frame = -1;
  let frameStart = 0;
  const writes = [];
  const extras = [];
  const lo = build.contract.memory.player.start;
  const hi = build.contract.memory.variables.end;
  const cpu = new Cpu(mem, {
    write(address, value) {
      if (address >= 0xd400 && address < 0xd419) writes.push({ frame, address, value, pc: cpu.pc });
      else if (address === 0xd020 || address === 0xd021 || address === 0xd000 || address === 0xd001 || address === 0xd010) extras.push({ frame, address, value });
    },
    read(address) {
      if (address === 0xd012) return Math.floor((cpu.cycles - frameStart) / 63) % 312 & 255;
      if (address === 0xdc00) return joystick(frame);
      return undefined;
    },
  });
  cpu.pc = example.start;
  const main = example.symbols.get("main");
  for (let steps = 0; cpu.pc !== main; steps++) {
    assert.ok(steps < 20000, "the set-up code reaches the main loop");
    cpu.step();
  }
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  assert.equal(irq, example.symbols.get("irq"), "the program installs its raster interrupt");
  assert.equal(mem[0xd012], 20);
  let player = 0;
  let own = 0;
  let waiting = 0;
  const waitAt = example.symbols.get("wait"); // the loop that waits for a raster line: cmp $d012 / bne
  const isWait = (pc) => waitAt !== undefined && pc >= waitAt && pc < waitAt + 5;
  const step = cpu.step.bind(cpu);
  cpu.step = () => {
    const pc = cpu.pc;
    const before = cpu.cycles;
    step();
    if (pc >= lo && pc < hi) player += cpu.cycles - before;
    else if (isWait(pc)) waiting += cpu.cycles - before;
    else own += cpu.cycles - before;
  };
  const log = [];
  for (let f = 0; f < frames; f++) {
    frame = f;
    frameStart = (f + 2) * FRAME_CYCLES;
    cpu.cycles = frameStart + 20 * 63 + 7; // the interrupt starts at raster line 20
    player = 0; own = 0; waiting = 0;
    const ownAtStart = [0, 1, 2].map((v) => mem[eff + v]);
    cpu.call(irq);
    log.push({ frame: f, ownAtStart, ownAfter: [0, 1, 2].map((v) => mem[eff + v]), player, own, waiting, total: player + own + waiting, free: FRAME_CYCLES - player - own });
  }
  return { log, writes, extras, mem };
}

/** The plain score's play calls, one per frame, with the writes of each. */
function plainRun(example, frames) {
  const plainText = example.yaml.slice(0, example.yaml.indexOf("\neffects:")) + "\n";
  const plain = compileSidwave(parseSidwave(plainText), { target: "game", origin: example.origin, measure: false });
  const m = gameMachine(plain);
  m.init(0, 0);
  const out = [];
  for (let f = 0; f < frames; f++) {
    const start = m.writes.length;
    m.play();
    out.push(m.writes.slice(start).filter(({ address }) => address >= 0xd400 && address < 0xd419));
  }
  return out;
}

/** Checks music against the plain score, frame by frame; returns the frames in which an effect owned a voice. */
function checkMusic(example, run, frames) {
  const reference = plainRun(example, frames);
  const engineLo = example.build.labels.sidwave_int_sfx;
  const engineHi = example.build.labels.sidwave_int_sfx_so + 3;
  const imageM = new Array(25).fill(0);
  const imageQ = new Array(25).fill(0);
  const text = (writes) => writes.map((w) => `${w.address.toString(16)}=${w.value}`).join(",");
  for (let f = 0; f < frames; f++) {
    const entry = run.log[f];
    const mine = run.writes.filter((w) => w.frame === f && w.address >= 0xd400 && w.address < 0xd419 && !(w.pc === undefined));
    const keep = (writes) => writes.filter((w) => voiceOf(w.address) < 0 || entry.ownAtStart[voiceOf(w.address)] === 0);
    // The set-up code calls init before frame 0 (frame -1); the frames hold the play calls only.
    assert.equal(text(keep(mine)), text(keep(reference[f])), `frame ${f}: the voices without an effect write what the plain music writes`);
    for (const w of mine) {
      const v = voiceOf(w.address);
      if (v >= 0 && entry.ownAtStart[v] !== 0 && entry.ownAfter[v] !== 0) assert.ok(w.pc >= engineLo && w.pc < engineHi, `frame ${f}: a write to the owned voice ${v + 1} comes from the effect engine`);
    }
    for (const w of mine) imageM[w.address - 0xd400] = w.value;
    for (const w of reference[f]) imageQ[w.address - 0xd400] = w.value;
    for (let r = 0; r < 25; r++) {
      const v = r < 21 ? Math.floor(r / 7) : -1;
      if (v >= 0 && entry.ownAfter[v] !== 0) continue;
      assert.equal(imageM[r], imageQ[r], `frame ${f}: SID register $${(0xd400 + r).toString(16)} has the plain music's value`);
    }
  }
}

const examples = new Map(GAME_EXAMPLES.map((name) => [name, buildGameExample(name, api, { symbolsAll: true })]));

test("both example programs assemble to one PRG that starts at $0801 with the player behind the program", () => {
  assert.deepEqual([...examples.keys()], ["raster_bars", "sprite_bounce"]);
  for (const example of examples.values()) {
    assert.equal(example.prg[0] | (example.prg[1] << 8), 0x0801);
    assert.equal(example.start, 0x080d);
    assert.ok(example.origin >= example.programEnd && example.origin % 256 === 0);
    assert.equal(example.prg.length, 2 + example.end - 0x0801);
    assert.deepEqual([...example.prg.subarray(2, 2 + 12)], [0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00], "10 SYS2061");
    assert.equal(example.build.contract.effects.length, example.name === "raster_bars" ? 1 : 2);
  }
});

test("raster bars: fire starts pew on voice 3, the music of voices 1 and 2 never changes, the bars are drawn and a frame fits the raster budget", () => {
  const example = examples.get("raster_bars");
  const frames = 600;
  // fire down in frames 100-104, 300-329, and a quick double press at 400 and 402
  const pressed = (f) => (f >= 100 && f <= 104) || (f >= 300 && f <= 329) || f === 400 || f === 402;
  const run = runDemo(example, frames, (f) => (pressed(f) ? 0xef : RELEASED));
  const pew = 1; // effect 0, stored as index + 1
  // the interrupt of frame f sees the press and calls sfx after its play call: the voice is owned from frame f + 1
  for (const press of [100, 300, 400]) {
    assert.deepEqual(run.log[press].ownAtStart, [0, 0, 0], `frame ${press}`);
    assert.deepEqual(run.log[press].ownAfter, [0, 0, pew], `frame ${press}: sfx accepted`);
  }
  const owned = (from) => { let n = 0; while (run.log[from + n].ownAtStart[2] !== 0) n += 1; return n; };
  assert.equal(owned(101), 9, "pew lasts 5 + 3 play calls and its restore call");
  assert.equal(owned(301), 9);
  // the second press at 402 restarts the running effect
  assert.equal(owned(401), 11, "restarted by the press in frame 402: owned from 401 to 411");
  // no frame without an edge starts anything
  for (const f of [50, 99, 105, 200, 305, 450]) {
    const started = run.log[f].ownAtStart[2] === 0 && run.log[f].ownAfter[2] !== 0;
    assert.ok(!started, `frame ${f}: no effect starts without a press`);
  }
  const engine = run.writes.filter((w) => w.frame === 101 && voiceOf(w.address) === 2);
  assert.ok(engine.length >= 7, "frame 101 writes the first step of pew on voice 3");
  checkMusic(example, run, frames);
  // the bars: 64 lines in the colours of the table, scrolled by one entry per frame, then the border returns to black
  const table = [0,6,6,14,14,3,3,13,13,1,1,13,13,3,3,14, 14,6,6,0,0,2,2,10,10,7,7,10,10,2,2,0, 0,9,9,8,8,7,7,8,8,9,9,0,0,5,5,13, 13,1,1,13,13,5,5,0,0,6,6,14,14,3,3,0];
  for (const f of [0, 1, 37, 255, 256, 599]) {
    const border = run.extras.filter((w) => w.frame === f && w.address === 0xd020).map((w) => w.value);
    assert.equal(border.length, 65);
    assert.deepEqual(border.slice(0, 64), Array.from({ length: 64 }, (_, i) => table[(i + (f & 255)) & 63]));
    assert.equal(border[64], 0);
  }
  // One frame, the one in which the player and the program together take the most (not the maxima of different frames).
  const busiest = run.log.reduce((a, b) => (b.player + b.own > a.player + a.own ? b : a));
  assert.ok(busiest.total < FRAME_CYCLES, `a frame takes ${busiest.total} of ${FRAME_CYCLES} cycles`);
  assert.ok(run.log.every((e) => e.player <= example.build.cycles.estimatedWorst));
  assert.ok(Math.max(...run.log.map((e) => e.own)) + example.build.cycles.estimatedWorst < FRAME_CYCLES);
  assert.equal(busiest.free, FRAME_CYCLES - busiest.player - busiest.own);
  console.log(`# raster_bars frame ${busiest.frame}: player ${busiest.player} + program ${busiest.own} + raster wait loop ${busiest.waiting} = ${busiest.total} of ${FRAME_CYCLES}; CPU time left for a game ${busiest.free}`);
});

/** A JavaScript model of sprite_bounce.asm: the sprite position and the hits of every frame for a joystick script. */
function spriteModel(frames, joystick) {
  let x = 66, y = 60, dx = 3, dy = 2;
  const out = [];
  for (let f = 0; f < frames; f++) {
    const joy = joystick(f);
    if (!(joy & 0x04)) dx = -3;
    if (!(joy & 0x08)) dx = 3;
    if (!(joy & 0x01)) dy = -2;
    if (!(joy & 0x02)) dy = 2;
    const hits = [];
    if (dx < 0 ? x <= 24 : x >= 320) { dx = -dx; hits.push("x"); }
    x += dx;
    if (dy < 0 ? y <= 50 : y >= 229) { dy = -dy; hits.push("y"); }
    y += dy;
    out.push({ x, y, hits });
  }
  return out;
}

test("sprite bounce: the sprite follows the model, every edge hit starts its effect, the music continues and a frame fits the raster budget", () => {
  const example = examples.get("sprite_bounce");
  const frames = 900;
  // joystick: left in 200-205, right in 400-405, up in 520-522, down and left together in 700
  const joystick = (f) => {
    let joy = RELEASED;
    if (f >= 200 && f <= 205) joy &= ~0x04;
    if (f >= 400 && f <= 405) joy &= ~0x08;
    if (f >= 520 && f <= 522) joy &= ~0x01;
    if (f === 700) joy &= ~0x06;
    return joy;
  };
  const model = spriteModel(frames, joystick);
  const xHits = model.filter((m) => m.hits.includes("x")).length;
  const yHits = model.filter((m) => m.hits.includes("y")).length;
  assert.ok(xHits >= 4 && yHits >= 4, `the script produces ${xHits} edge hits left or right and ${yHits} top or bottom`);
  const run = runDemo(example, frames, joystick);
  for (let f = 0; f < frames; f++) {
    const last = (address) => run.extras.filter((w) => w.frame === f && w.address === address).pop()?.value;
    assert.equal(last(0xd000), model[f].x & 255, `frame ${f}: x`);
    assert.equal(last(0xd010), model[f].x >> 8, `frame ${f}: x bit 8`);
    assert.equal(last(0xd001), model[f].y, `frame ${f}: y`);
  }
  // effect 0 is bounce (voice 3), effect 1 is thud (voices 2 and 3); stored as index + 1
  let both = 0;
  model.forEach((m, f) => {
    const own = run.log[f].ownAfter;
    if (m.hits.includes("x")) assert.equal(own[2], 1, `frame ${f}: bounce on voice 3`);
    if (m.hits.length === 2) { both += 1; assert.deepEqual(own.slice(1), [2, 1], `frame ${f}: a corner hit plays bounce on voice 3 and thud on voice 2`); }
  });
  model.forEach((m, f) => {
    if (m.hits.length === 1 && m.hits[0] === "y") {
      const after = run.log[f].ownAfter;
      assert.ok(after.includes(2), `frame ${f}: thud is running after a top or bottom hit`);
    }
  });
  assert.ok(model.some((m) => m.hits.length === 0));
  assert.ok(both >= 1, "the script includes a corner hit");
  checkMusic(example, run, frames);
  const busiest = run.log.reduce((a, b) => (b.player + b.own > a.player + a.own ? b : a));
  assert.ok(busiest.total < FRAME_CYCLES);
  assert.ok(run.log.every((e) => e.player <= example.build.cycles.estimatedWorst));
  assert.ok(Math.max(...run.log.map((e) => e.own)) + example.build.cycles.estimatedWorst < FRAME_CYCLES);
  console.log(`# sprite_bounce frame ${busiest.frame}: player ${busiest.player} + program ${busiest.own} = ${busiest.total} of ${FRAME_CYCLES}; CPU time left ${busiest.free}; ${xHits} x hits, ${yHits} y hits, ${both} in a corner`);
});
