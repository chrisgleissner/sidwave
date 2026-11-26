import test from "#test/runner";
import assert from "#test/assert";
import crypto from "node:crypto";
import { parseSidwave, SidwaveValidationError } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { compileSidwave } from "../src/sidwaveGame.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { runPrg } from "./helpers/sidwaveEmulator.mjs";
import { gameMachine, isSidWrite, sidTrace } from "./helpers/sidwaveGameHarness.mjs";

const load = (name) => parseSidwave(readSidwaveExample(name));
const build = (name, options) => compileSidwave(load(name), { target: "game", measure: false, ...options });
const clockOf = (doc) => (doc.song.mode === "NTSC" ? 1 : 0);

// fuer_elise: one SID, legacy 1.0, loops. title_fanfare: one SID with an end (play once). stereo_echo: two SIDs.
const SCORES = ["fuer_elise", "title_fanfare", "stereo_echo"];
const FRAMES = 600;

test("the entry table is three jumps and the sfx stub, at fixed offsets from the origin", () => {
  const b = build("fuer_elise", { origin: 0x1234 });
  const at = (offset) => b.player[offset];
  const target = (offset) => b.player[offset + 1] | (b.player[offset + 2] << 8);
  assert.deepEqual([at(0), at(3), at(6), at(9), at(10), at(11)], [0x4c, 0x4c, 0x4c, 0x60, 0xea, 0xea]);
  assert.deepEqual(b.contract.entryPoints, { init: 0x1234, play: 0x1237, stop: 0x123a, sfx: 0x123d });
  assert.equal(b.contract.entryTableBytes, 12);
  assert.equal(target(0), b.image.symbols.get("game_init"));
  assert.equal(target(3), b.image.symbols.get("play"));
  assert.equal(target(6), b.image.symbols.get("game_stop"));
  assert.equal(b.labels.sidwave_init, 0x1234);
  assert.equal(b.labels.sidwave_sfx, 0x123d);
});

test("the sfx stub returns at once and changes no register or flag", () => {
  const m = gameMachine(build("fuer_elise", { origin: 0x1000 }));
  m.init(0, 0);
  m.cpu.a = 0x12; m.cpu.x = 0x34; m.cpu.y = 0x56; m.cpu.c = 1;
  const cycles = m.cpu.call(0x1009, 0x12);
  assert.deepEqual([cycles, m.cpu.a, m.cpu.x, m.cpu.y, m.cpu.c], [6, 0x12, 0x34, 0x56, 1]);
});

for (const name of SCORES) {
  test(`${name}: the game build writes the SID registers of the PRG build at an aligned, an odd, a split and a relocated layout`, () => {
    const doc = load(name);
    const reference = runPrg(compileSidwaveToPrg(doc), FRAMES).calls.map((call) => call.writes.map((w) => [w.addr, w.value]));
    assert.ok(reference.some((writes) => writes.length > 0));
    const layouts = [
      { origin: 0x1000 },
      { origin: 0x1001, dataOrigin: 0x8001, zeroPage: 0xf0 },
      { origin: 0x0200, zeroPage: 0x02 },
      { origin: 0x6001, dataOrigin: 0x2000 },
    ];
    for (const layout of layouts) {
      const m = gameMachine(compileSidwave(doc, { target: "game", measure: false, ...layout }));
      m.init(0, clockOf(doc));
      for (let i = 0; i < FRAMES; i++) m.play();
      const trace = sidTrace(m);
      for (let i = 0; i < FRAMES; i++) {
        assert.deepEqual(trace[i + 2] ?? [], reference[i], `${name} ${JSON.stringify(layout)} call ${i}`);
      }
    }
  });
}

test("a score that plays once keeps its SID writes identical to the PRG build through the end and beyond", () => {
  const doc = load("fuer_elise");
  const prg = compileSidwaveToPrg(doc, { loop: false });
  const frames = prg.totalFrames + 20;
  const reference = runPrg(prg, frames).calls.map((call) => call.writes.map((w) => [w.addr, w.value]));
  const m = gameMachine(compileSidwave(doc, { target: "game", origin: 0x1001, loop: false, measure: false }));
  m.init(0, 0);
  for (let i = 0; i < frames; i++) m.play();
  const trace = sidTrace(m);
  for (let i = 0; i < frames; i++) assert.deepEqual(trace[i + 2] ?? [], reference[i], `call ${i}`);
  // The ending silences the voices and sets the volume; it never touches the KERNAL IRQ vector or the CIA.
  assert.ok(!m.writes.some(({ address }) => address === 0x0314 || address === 0x0315 || (address >= 0xdc00 && address < 0xde00)));
  assert.equal(reference[prg.totalFrames - 1].length > 0, true);
});

for (const name of SCORES) {
  test(`${name}: the player writes only the SID registers, the stack, $01, its zero page and the contract RAM`, () => {
    const doc = load(name);
    const b = compileSidwave(doc, { target: "game", origin: 0x3003, zeroPage: 0xf0, measure: false });
    const m = gameMachine(b);
    m.init(0, clockOf(doc));
    for (let i = 0; i < 1200; i++) m.play();
    m.stop();
    const { ram, zeroPage, sidRegisters } = b.contract;
    const sid = (a) => sidRegisters.some(({ address, bytes }) => a >= address && a < address + bytes);
    const zp = (a) => zeroPage.some(({ address, bytes }) => a >= address && a < address + bytes);
    const inRam = (a) => ram.some(({ start, end }) => a >= start && a < end);
    const stray = new Set();
    const written = new Set();
    for (const { address } of m.writes) {
      written.add(address);
      if (!(sid(address) || zp(address) || inRam(address) || address === 1 || (address >= 0x100 && address < 0x200))) stray.add(address);
    }
    assert.deepEqual([...stray], []);
    // The pointers moved to $F0, so the default $FB-$FE bytes are never written.
    assert.ok(written.has(0xf0));
    for (const address of [0xfb, 0xfc, 0xfd, 0xfe]) assert.ok(!written.has(address), `$${address.toString(16)} written`);
    // The variables are really used.
    assert.ok([...written].filter(inRam).length > 20);
    // The contract lists the SID chips of the score.
    assert.equal(sidRegisters.length, doc.sids.length);
    assert.deepEqual(zeroPage.map(({ address, bytes }) => [address, bytes]), doc.sids.length > 1 ? [[0xf0, 2], [0xf2, 2]] : [[0xf0, 2]]);
  });
}

test("zero page bytes, $01 and the interrupt and decimal flags have the values they had before each call", () => {
  const doc = load("stereo_echo");
  const m = gameMachine(build("stereo_echo", { origin: 0x2000 }), { port: 0x35 });
  m.mem.set([0xa1, 0xa2, 0xa3, 0xa4], 0xfb);
  m.cpu.i = 0;
  const sidPorts = new Set();
  m.init(0, clockOf(doc));
  for (let i = 0; i < 300; i++) {
    m.play();
    assert.deepEqual([...m.mem.subarray(0xfb, 0xff)], [0xa1, 0xa2, 0xa3, 0xa4]);
    assert.deepEqual([m.mem[1], m.cpu.i, m.cpu.d], [0x35, 0, 0]);
  }
  m.stop();
  assert.deepEqual([m.mem[1], m.cpu.i, m.cpu.d], [0x35, 0, 0]);
  // $01 is $36 whenever a SID register is written.
  for (const { address, port } of m.writes) if (isSidWrite(address)) sidPorts.add(port);
  assert.deepEqual([...sidPorts], [0x36]);
  m.cpu.i = 1;
  m.play();
  assert.equal(m.cpu.i, 1);
});

test("init reads the clock from X: 0 PAL, any other value NTSC, $FF the KERNAL flag at $02A6", () => {
  const doc = load("title_fanfare");
  const b = build("title_fanfare", { origin: 0x1000 });
  const run = (x, clockFlag) => {
    const m = gameMachine(b, { clockFlag });
    m.init(0, x);
    for (let i = 0; i < 30; i++) m.play();
    return JSON.stringify(sidTrace(m));
  };
  const pal = run(0, 0);
  const ntsc = run(1, 0);
  assert.notEqual(pal, ntsc);
  assert.equal(run(7, 1), ntsc);
  assert.equal(run(0xff, 1), pal, "$02A6 is nonzero on a PAL machine");
  assert.equal(run(0xff, 0), ntsc, "$02A6 is zero on an NTSC machine");
  assert.equal(clockOf(doc), 0);
  // The subtune number in A is ignored while the score has one tune.
  const m = gameMachine(b);
  m.init(5, 0);
  for (let i = 0; i < 30; i++) m.play();
  assert.equal(JSON.stringify(sidTrace(m)), pal);
});

test("stop zeroes $D400-$D418 of every SID and leaves the processor port and the IRQ vector alone", () => {
  const doc = load("stereo_echo");
  const m = gameMachine(build("stereo_echo", { origin: 0x2000 }), { port: 0x35 });
  m.init(0, clockOf(doc));
  const registers = new Uint8Array(0x400);
  for (let i = 0; i < 400; i++) m.play();
  const before = m.writes.length;
  m.mem[0x0314] = 0x31; m.mem[0x0315] = 0xea;
  m.stop();
  for (const { address, value } of m.writes.slice(before)) if (isSidWrite(address)) registers[address - 0xd400] = value;
  const expected = new Set();
  for (const base of [0, 0x20]) for (let r = 0; r <= 0x18; r++) expected.add(base + r);
  const written = new Set(m.writes.slice(before).filter(({ address }) => isSidWrite(address)).map(({ address }) => address - 0xd400));
  assert.deepEqual([...written].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  assert.ok([...registers].every((v) => v === 0));
  assert.deepEqual([m.mem[1], m.mem[0x0314], m.mem[0x0315]], [0x35, 0x31, 0xea]);
  assert.ok(!m.writes.slice(before).some(({ address }) => address === 0x0314));
});

test("a separate data block holds the streams and tables; the contract records its hash", () => {
  const joined = build("acid_line", { origin: 0x1000 });
  const split = build("acid_line", { origin: 0x1000, dataOrigin: 0x6000 });
  assert.equal(joined.data, undefined);
  assert.deepEqual(joined.combined, joined.player);
  assert.equal(joined.combinedOrigin, 0x1000);
  assert.equal(split.data.length, 11698);
  assert.equal(split.player.length, 2464);
  assert.equal(joined.player.length, 2464 + 11698);
  assert.deepEqual(split.contract.data, { origin: 0x6000, bytes: 11698, sha256: crypto.createHash("sha256").update(split.data).digest("hex") });
  assert.deepEqual(split.contract.memory.data, { start: 0x6000, end: 0x6000 + 11698 });
  assert.equal(split.labels.sidwave_data, 0x6000);
  assert.equal(split.labels.sidwave_data_end, 0x6000 + 11698);
  // Player, zero filled gap and data in one image.
  assert.equal(split.combinedOrigin, 0x1000);
  assert.equal(split.combined.length, 0x6000 + 11698 - 0x1000);
  assert.deepEqual(split.combined.subarray(0, 2464), split.player);
  assert.deepEqual(split.combined.subarray(0x5000), split.data);
  assert.ok(split.combined.subarray(2464, 0x5000).every((v) => v === 0));
  // With the data below the player the image starts at the data.
  const below = build("acid_line", { origin: 0x9000, dataOrigin: 0x2000 });
  assert.equal(below.combinedOrigin, 0x2000);
  assert.deepEqual(below.combined.subarray(0, 11698), below.data);
  assert.deepEqual(below.combined.subarray(0x7000), below.player);
});

test("invalid layouts are rejected with the option that is wrong", () => {
  const doc = load("fuer_elise");
  const fails = (options, path, message) => {
    assert.throws(() => compileSidwave(doc, { target: "game", measure: false, ...options }), (error) => {
      assert.ok(error instanceof SidwaveValidationError);
      assert.equal(error.path, path);
      assert.match(error.message, message);
      return true;
    });
  };
  fails({ origin: 0x01ff }, "$.origin", /must lie in \$0200-\$CFF4/);
  fails({ origin: 0xd000 }, "$.origin", /must lie in \$0200-\$CFF4/);
  fails({ origin: 0xcff5 }, "$.origin", /must lie in/);
  fails({ origin: 1.5 }, "$.origin", /integer/);
  fails({ origin: 0x1000, dataOrigin: 0x100 }, "$.dataOrigin", /must lie in/);
  fails({ origin: 0x1000, zeroPage: 0 }, "$.zeroPage", /\$02 to \$FE/);
  fails({ origin: 0x1000, zeroPage: 1 }, "$.zeroPage", /\$02 to \$FE/);
  fails({ origin: 0x1000, zeroPage: 0xff }, "$.zeroPage", /\$02 to \$FE/);
  fails({ origin: 0x1000, dataOrigin: 0x1100 }, "$.dataOrigin", /overlaps the player/);
  fails({ origin: 0xcf00 }, "$.timeline", /past the \$D000 limit/);
  fails({ origin: 0x1000, symbols: ["nope"] }, "$.symbols", /unknown symbol format "nope"/);
  assert.throws(() => compileSidwave(doc, { target: "prg", origin: 0x1000 }), /only the "game" target/);
  // Two SIDs need four zero page bytes.
  assert.throws(() => compileSidwave(load("stereo_echo"), { target: "game", origin: 0x1000, zeroPage: 0xfd, measure: false }),
    /a multi-SID player needs 4 zero page bytes; the highest base is \$FC/);
  // The same base is fine for one SID, which uses two bytes.
  assert.ok(compileSidwave(doc, { target: "game", origin: 0x1000, zeroPage: 0xfe, measure: false }).player.length > 1000);
  // Digi samples need the CIA2 NMI that only the PRG installer sets up.
  assert.throws(() => compileSidwave(load("digi_groove"), { target: "game", origin: 0x1000, measure: false }), (error) => error.path === "$.samples");
  // A score of about 50 KB cannot fit above a high origin.
  assert.throws(() => compileSidwave(load("wall_of_sid"), { target: "game", origin: 0x8000, measure: false }), (error) => error.path === "$.timeline");
});

test("cpu: turbo scores build without switching the CPU speed and carry a warning", () => {
  const b = build("ultisid_orchestra", { origin: 0x1000 });
  assert.deepEqual(b.warnings.filter((w) => w.startsWith("cpu: turbo")), [
    "cpu: turbo is switched on by the PRG installer; a game build leaves the CPU speed to the game, which must run at the speed the score was written for.",
  ]);
  assert.ok(b.warnings.some((w) => /^The player needs up to \d+ cycles per call, more than the \d+ left in a stock PAL frame/.test(w)));
  const m = gameMachine(b);
  m.init(0, 0);
  m.play();
  assert.ok(!m.writes.some(({ address }) => address === 0xd031 || address === 0xd030));
});

// The measured worst case is exact for a given score, origin and emulator; the estimate is the compiler's upper bound.
const CYCLES = {
  title_fanfare: { worst: 12243, average: 4595.245762711865, estimatedWorst: 14881, measuredCalls: 944, seconds: 18.83308973984215, stack: 14, perFrame: 1 },
  chiptune_drive: { worst: 6443, average: 2277.2560676478183, estimatedWorst: 8356, measuredCalls: 15492, seconds: 154.5350774627302, stack: 14, perFrame: 2 },
  stereo_echo: { worst: 9958, average: 4410.917472965281, estimatedWorst: 11704, measuredCalls: 8785, seconds: 175.26344636071323, stack: 14, perFrame: 1 },
};

for (const [name, expected] of Object.entries(CYCLES)) {
  test(`${name}: measured cycles per play call at $1000 against the compiler estimate`, () => {
    const b = compileSidwave(load(name), { target: "game", origin: 0x1000 });
    assert.deepEqual(b.cycles, {
      worst: expected.worst,
      average: expected.average,
      estimatedWorst: expected.estimatedWorst,
      measuredOverSeconds: expected.seconds,
      measuredCalls: expected.measuredCalls,
      kinds: { worst: "measured", average: "measured", estimatedWorst: "estimated" },
    });
    assert.ok(b.cycles.worst <= b.cycles.estimatedWorst);
    assert.equal(b.contract.maxStackBytes, expected.stack);
    assert.equal(b.contract.playCallsPerFrame, expected.perFrame);
    console.log(`${name}: measured worst ${b.cycles.worst}, estimated worst ${b.cycles.estimatedWorst}, average ${b.cycles.average.toFixed(1)}`);
  });
}

test("the measured run covers every call of the song plus one more pass of the loop; without measuring the values are null", () => {
  const doc = load("fuer_elise");
  const looped = compileSidwave(doc, { target: "game", origin: 0x1000 });
  const prg = compileSidwaveToPrg(doc);
  assert.equal(looped.cycles.measuredCalls, prg.totalFrames + prg.totalFrames + 4);
  const once = compileSidwave(doc, { target: "game", origin: 0x1000, loop: false });
  assert.equal(once.cycles.measuredCalls, prg.totalFrames + 4);
  const skipped = build("fuer_elise", { origin: 0x1000 });
  assert.deepEqual([skipped.cycles.worst, skipped.cycles.average, skipped.cycles.measuredOverSeconds, skipped.cycles.measuredCalls, skipped.contract.maxStackBytes],
    [null, null, null, 0, null]);
  assert.equal(skipped.cycles.estimatedWorst, looped.cycles.estimatedWorst);
});

test("the game build measures the same cycles on the test helper emulator as on the bundled one", () => {
  const doc = load("title_fanfare");
  const b = compileSidwave(doc, { target: "game", origin: 0x1000 });
  const m = gameMachine(b);
  m.init(0, 0);
  let worst = 0;
  for (let i = 0; i < b.cycles.measuredCalls; i++) worst = Math.max(worst, m.play());
  assert.equal(worst, b.cycles.worst);
});

test("the PRG build of the same score is unchanged by the game build existing", () => {
  const doc = load("fuer_elise");
  const before = compileSidwaveToPrg(doc).prg;
  compileSidwave(doc, { target: "game", origin: 0x1000, measure: false });
  assert.deepEqual(compileSidwaveToPrg(doc).prg, before);
});

test("the 12 byte entry table must fit below $D000 for the origin only; a data block is checked against its own size", () => {
  const doc = load("fuer_elise");
  const error = (options) => {
    try { compileSidwave(doc, { target: "game", measure: false, ...options }); } catch (e) { return e; }
    return undefined;
  };
  // $CFF5 is a valid data address (the table is not there); the data does not fit, which the size check reports.
  const data = error({ origin: 0x1000, dataOrigin: 0xcff5 });
  assert.equal(data.path, "$.timeline");
  assert.match(data.message, /the data would end at \$D6\w\w, past the \$D000 limit/);
  // The same address is rejected as an origin.
  assert.equal(error({ origin: 0xcff5 }).path, "$.origin");
  assert.equal(error({ origin: 0x1000, dataOrigin: 0xd000 }).path, "$.dataOrigin");
  assert.equal(error({ origin: 0x1000, dataOrigin: 0x1ff }).path, "$.dataOrigin");
});
