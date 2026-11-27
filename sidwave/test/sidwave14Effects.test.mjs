// SIDWave 1.4 effects (S4c): the document language, its limits and the generated tables. The run-time behaviour is
// tested in sidwave14EffectsRuntime.test.mjs and sidwave14EffectsCombos.test.mjs.
import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave, SIDWAVE_MAX_EFFECTS, SIDWAVE_MAX_EFFECT_STEPS } from "../src/sidwave.js";
import { compileSidwaveToPrg, hzToSidFrequency } from "../src/sidwaveCompiler.js";
import { compileSidwave } from "../src/sidwaveGame.js";
import { SFX_CYCLES_BOUND, effectCyclesBound, effectRecords, effectFrames } from "../src/sidwaveEffects.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { E, EFFECTS, compileBoth, effectMachine, lockstep } from "./helpers/sidwaveEffectsKit.mjs";
import { gameMachine } from "./helpers/sidwaveGameHarness.mjs";

const effectMachineFor = (build) => effectMachine(build);

const BASE = readSidwaveExample("game_songs");
const BASE13 = `sidwave: 1.3
title: T
tempo: 120
voices:
  - { id: 1, instrument: lead, patterns: { a: { length: 1, bars: 1, groove: "A4 C5 E5 D5" } } }
instruments:
  lead: { waveform: pulse, adsr: [1, 5, 10, 4] }
timeline:
  - { bars: 1, layers: { v1: a } }
`;
const parse = (effects, base = BASE) => parseSidwave(`${base}\neffects:\n${effects}`);
const one = (body) => `  e: ${body}`;
const invalid = (effects, pattern, base) => assert.throws(() => parse(effects, base), pattern);

test("a document without effects and one with an empty effects mapping compile to the same bytes", () => {
  const plain = parseSidwave(BASE);
  const empty = parseSidwave(BASE + "\neffects: {}\n");
  assert.equal(empty.effects, undefined);
  assert.equal(Buffer.compare(compileSidwaveToPrg(plain).prg, compileSidwaveToPrg(empty).prg), 0);
  const a = compileSidwave(plain, { target: "game", origin: 0x1000, measure: false });
  const b = compileSidwave(empty, { target: "game", origin: 0x1000, measure: false });
  assert.equal(Buffer.compare(a.combined, b.combined), 0);
  assert.equal(b.contract.effects, undefined);
  assert.equal(b.labels.sidwave_effects, undefined);
});

test("a sidwave 1.2 or 1.3 document with effects is rejected, and the message names the version", () => {
  for (const base of [BASE13, BASE13.replace("1.3", "1.2"), BASE13.replace("sidwave: 1.3", "sidwave: \"1.3\"")]) {
    assert.throws(() => parseSidwave(`${base}\neffects:\n  e: { priority: 1, steps: [ { freq: C4 } ] }\n`), /effects require sidwave: 1\.4/);
  }
  assert.throws(() => parseSidwave(`${BASE13.replace("sidwave: 1.3\n", "")}\neffects: {}\n`), /effects require sidwave: 1\.4/);
  assert.equal(parseSidwave(`${BASE13.replace("1.3", "1.4")}\neffects:\n  e: { priority: 1, steps: [ { freq: C4 } ] }\n`).effects.length, 1);
});

test("limits: 0 to 32 effects, 1 to 255 steps, priority 0 to 15, wait 1 to 255", () => {
  const effect = (name, body = "{ priority: 1, steps: [ { freq: C4 } ] }") => `  ${name}: ${body}\n`;
  const many = (n) => Array.from({ length: n }, (_, i) => effect(`e${i}`)).join("");
  assert.equal(SIDWAVE_MAX_EFFECTS, 32);
  assert.equal(parse(many(32)).effects.length, 32);
  invalid(many(33), /at most 32 effects/);
  const steps = (n) => `{ priority: 1, steps: [ ${Array.from({ length: n }, () => "{ freq: C4 }").join(", ")} ] }`;
  assert.equal(SIDWAVE_MAX_EFFECT_STEPS, 255);
  assert.equal(parse(effect("e", steps(1))).effects[0].steps.length, 1);
  assert.equal(parse(effect("e", steps(255))).effects[0].steps.length, 255);
  invalid(effect("e", steps(256)), /at most 255 steps/);
  invalid(effect("e", "{ priority: 1, steps: [] }"), /missing steps/);
  invalid(effect("e", "{ priority: 1 }"), /missing steps/);
  for (const [priority, ok] of [[0, true], [15, true], [7, true], [-1, false], [16, false], [1.5, false], ['"high"', false]]) {
    const text = effect("e", `{ priority: ${priority}, steps: [ { freq: C4 } ] }`);
    if (ok) assert.equal(parse(text).effects[0].priority, priority);
    else invalid(text, /\$\.effects\.e\.priority/);
  }
  invalid(effect("e", "{ steps: [ { freq: C4 } ] }"), /missing priority/);
  for (const [wait, ok] of [[1, true], [255, true], [0, false], [256, false], [1.5, false]]) {
    const text = effect("e", `{ priority: 1, steps: [ { freq: C4, wait: ${wait} } ] }`);
    if (ok) assert.equal(parse(text).effects[0].steps[0].wait, wait);
    else invalid(text, /steps\[0\]\.wait/);
  }
  assert.equal(parse(effect("e")).effects[0].steps[0].wait, 1, "a step lasts one play call unless it says otherwise");
});

test("voices: one, two or three entries; invalid numbers are rejected", () => {
  const effect = (voices) => `  e: { priority: 1, ${voices === undefined ? "" : `voices: ${voices}, `}steps: [ { freq: C4 } ] }\n`;
  assert.deepEqual(parse(effect(undefined)).effects[0].voices, [1, 2, 3]);
  assert.deepEqual(parse(effect("[2]")).effects[0].voices, [2]);
  assert.deepEqual(parse(effect("[3, 1]")).effects[0].voices, [1, 3]);
  assert.deepEqual(parse(effect("[1, 2, 3]")).effects[0].voices, [1, 2, 3]);
  for (const bad of ["[0]", "[4]", "[-1]", "[1, 1]", "[]", '["a"]', "[1.5]", "2", "{ a: 1 }"]) invalid(effect(bad), /voices/);
});

test("step fields: every field is accepted and invalid values are rejected with their path", () => {
  const step = (body) => `  e: { priority: 1, steps: [ { freq: C4 }, ${body} ] }\n`;
  const ok = parse(step('{ freq: "880Hz", wave: tri+saw, pulse: 0.25, adsr: [1, 2, 3, 4], gate: false, filter: off, wait: 9 }')).effects[0].steps[1];
  assert.deepEqual(ok, { freq: { hz: 880 }, wave: "tri+saw", pulse: Math.round(0.25 * 4095), adsr: [1, 2, 3, 4], gate: false, filter: "off", wait: 9 });
  const notes = parse(step("{ freq: F#2 }")).effects[0].steps[1];
  assert.deepEqual(notes.freq, { midi: 42 });
  assert.deepEqual(parse(step("{ freq: 440 }")).effects[0].steps[1].freq, { hz: 440 });
  assert.deepEqual(parse(step('{ freq: "440" }')).effects[0].steps[1].freq, { hz: 440 });
  assert.equal(parse(step("{ pulse: 1000 }")).effects[0].steps[1].pulse, 1000);
  assert.equal(parse(step("{ filter: keep }")).effects[0].steps[1].filter, "keep");
  for (const [body, path] of [
    ["{ freq: C8 }", "freq"], ["{ freq: H4 }", "freq"], ["{ freq: 0 }", "freq"], ["{ freq: 3849 }", "freq"], ["{ freq: true }", "freq"], ["{ freq: [1] }", "freq"],
    ["{ wave: sine }", "wave"], ["{ wave: 3 }", "wave"], ["{ pulse: 0 }", "pulse"], ["{ pulse: 4095 }", "pulse"], ["{ pulse: -1 }", "pulse"],
    ["{ adsr: [1, 2, 3] }", "adsr"], ["{ adsr: [16, 0, 0, 0] }", "adsr"], ["{ adsr: 5 }", "adsr"],
    ["{ gate: 1 }", "gate"], ['{ gate: "on" }', "gate"], ["{ filter: on }", "filter"], ["{ filter: true }", "filter"],
    ["{ volume: 3 }", "volume"], ["5", ""],
  ]) invalid(step(body), new RegExp(`\\$\\.effects\\.e\\.steps\\[1\\]\\.?${path}`));
  invalid("  e: { priority: 1, steps: [ { wait: 2 } ] }\n", /steps\[0\]\.freq.*first step needs a freq/);
  invalid("  e: { priority: 1, steps: [ { freq: C4 } ], extra: 1 }\n", /\$\.effects\.e\.extra/);
  invalid("  e: 5\n", /expected a mapping/);
  invalid("  1bad: { priority: 1, steps: [ { freq: C4 } ] }\n", /effect name/);
  invalid("  has-dash: { priority: 1, steps: [ { freq: C4 } ] }\n", /effect name/);
  assert.throws(() => parseSidwave(`${BASE}\neffects: [1]\n`), /\$\.effects: expected a mapping/);
  assert.equal(parse(`  ${"x".repeat(32)}: { priority: 1, steps: [ { freq: C4 } ] }\n`).effects.length, 1);
  invalid(`  ${"x".repeat(33)}: { priority: 1, steps: [ { freq: C4 } ] }\n`, /effect name/);
});

test("the step records hold the flags, the wait, both clocks' frequencies, the pulse width, the control byte and the envelope", () => {
  const doc = parse(`  e:
    priority: 3
    steps:
      - { freq: A4, wave: sawtooth, pulse: 0.5, adsr: [1, 2, 3, 4], wait: 7 }
      - { freq: 1000 }
      - { wave: noise, gate: false, wait: 2 }
      - { adsr: [15, 0, 0, 15], filter: off }
      - { filter: keep, pulse: 100, gate: true, wait: 255 }
`);
  const records = effectRecords(doc.effects[0], { hzToRegister: hzToSidFrequency, midiToHz: (m) => 440 * 2 ** ((m - 69) / 12) });
  const pal = hzToSidFrequency(440, "PAL");
  const ntsc = hzToSidFrequency(440, "NTSC");
  assert.deepEqual(records[0], [0x40 | 0x01 | 0x02 | 0x04 | 0x08, 7, pal & 255, pal >> 8, ntsc & 255, ntsc >> 8, 2048 & 255, 2048 >> 8, 0x21, 0x12, 0x34]);
  const thousand = [hzToSidFrequency(1000, "PAL"), hzToSidFrequency(1000, "NTSC")];
  assert.deepEqual(records[1], [0x01, 1, thousand[0] & 255, thousand[0] >> 8, thousand[1] & 255, thousand[1] >> 8, 0, 8, 0x21, 0x12, 0x34]);
  assert.equal(records[2][0], 0x04, "wave and gate change the control byte only");
  assert.equal(records[2][8], 0x80, "noise, gate off");
  assert.equal(records[3][0], 0x08 | 0x10 | 0x20);
  assert.deepEqual(records[3].slice(9), [0xf0, 0x0f]);
  assert.equal(records[3][8], 0x80, "the control byte keeps the last wave and gate");
  assert.equal(records[4][0], 0x80 | 0x02 | 0x04 | 0x10);
  assert.equal(records[4][8], 0x81);
  assert.equal(records[4][1], 255);
  assert.deepEqual(records[4].slice(6, 8), [100, 0]);
  assert.equal(effectFrames(doc.effects[0]), 7 + 1 + 2 + 1 + 255);
});

test("the longest effect: 255 steps cross page boundaries of the data and every step plays its own frequency", () => {
  const steps = Array.from({ length: 255 }, (_, i) => `{ freq: ${100 + i}, wait: 1 }`).join(", ");
  const text = `${BASE}\neffects:\n  long: { priority: 3, steps: [ ${steps} ] }\n  other: { priority: 1, steps: [ { freq: C4 } ] }\n`;
  const { withFx } = compileBoth(text, {}, "");
  const m = effectMachine(withFx);
  m.init(0, 0);
  m.play();
  assert.equal(m.sfx(0, 1).carry, 0);
  const [lo, hi] = m.engine;
  const seen = [];
  for (let n = 1; n <= 257; n++) {
    const start = m.writes.length;
    m.play();
    const writes = m.writes.slice(start).filter((w) => w.pc >= lo && w.pc < hi);
    const freq = writes.filter((w) => w.address === 0xd400 || w.address === 0xd401);
    seen.push(freq.length === 2 ? freq[0].value | (freq[1].value << 8) : null);
    if (n === 256) assert.equal(writes.length, 7, "the call after the last step restores the voice");
    if (n === 257) assert.equal(writes.length, 0);
  }
  for (let i = 0; i < 255; i++) assert.equal(seen[i], hzToSidFrequency(100 + i, "PAL"), `step ${i}`);
  assert.deepEqual(m.own(), [0, 0, 0]);
});

test("the most effects: all 32 are reachable by index", () => {
  const effects = Array.from({ length: 32 }, (_, i) => `  fx${i}: { priority: ${i % 16}, voices: [${1 + (i % 3)}], steps: [ { freq: ${200 + 10 * i}, wait: 2 } ] }\n`).join("");
  const { withFx } = compileBoth(BASE, {}, `\neffects:\n${effects}`);
  assert.equal(withFx.contract.effects.length, 32);
  assert.equal(withFx.labels.sidwave_effects, 32);
  assert.equal(withFx.labels.sidwave_fx_fx31, 31);
  const m = effectMachine(withFx);
  m.init(0, 0);
  m.play();
  for (const index of [0, 17, 31]) {
    const voice = 1 + (index % 3);
    assert.equal(m.sfx(index, voice).carry, 0, `effect ${index}`);
    const start = m.writes.length;
    m.play();
    const freq = m.writes.slice(start).filter((w) => w.pc >= m.engine[0] && w.pc < m.engine[1] && w.address === 0xd400 + 7 * (voice - 1));
    assert.equal(freq[0].value | (m.writes.slice(start).find((w) => w.address === 0xd401 + 7 * (voice - 1) && w.pc >= m.engine[0]).value << 8), hzToSidFrequency(200 + 10 * index, "PAL"));
    m.play(); m.play(); m.play();
    assert.deepEqual(m.own(), [0, 0, 0]);
  }
  assert.equal(m.sfx(32, 0xff).carry, 1, "there is no effect 32");
  assert.equal(m.sfx(255, 0xff).carry, 1);
});

test("an effect listed for one voice is rejected on the others, and effects are reported in the compile result and the contract", () => {
  const compiled = compileSidwaveToPrg(parseSidwave(BASE + EFFECTS));
  assert.deepEqual(compiled.effects.map((e) => [e.index, e.name, e.priority, e.voices, e.steps, e.frames]), [
    [0, "zap", 5, [1, 2, 3], 3, 6], [1, "boom", 9, [2, 3], 2, 11], [2, "blip", 2, [3], 1, 1], [3, "low", 0, [1, 2, 3], 1, 4],
    [4, "top", 15, [1, 2, 3], 2, 8], [5, "drone", 7, [1, 2, 3], 3, 765], [6, "same", 5, [1, 2, 3], 1, 6],
  ]);
  const { withFx } = compileBoth(BASE);
  assert.deepEqual(withFx.contract.effects, compiled.effects);
  assert.match(withFx.contract.registers.sfx.in, /A = effect index \(0-6\)/);
  assert.equal(withFx.labels.sidwave_fx_boom, 1);
  const m = effectMachine(withFx);
  m.init(0, 0);
  assert.equal(m.sfx(E.blip, 1).carry, 1);
  assert.equal(m.sfx(E.blip, 3).carry, 0);
});

test("the measured cost of the effect engine stays below the compiler's bound", () => {
  const text = BASE;
  const { withFx, plain } = compileBoth(text, { measure: true }, EFFECTS);
  const compiledPlain = compileSidwave(parseSidwave(text), { target: "game", origin: 0x1000, measure: true });
  assert.equal(plain.cycles.withEffects, undefined);
  assert.ok(withFx.cycles.withEffects.worst <= withFx.cycles.estimatedWorst);
  assert.ok(withFx.cycles.withEffects.sfxWorst > 0 && withFx.cycles.withEffects.sfxWorst <= SFX_CYCLES_BOUND, `sfx ${withFx.cycles.withEffects.sfxWorst} <= ${SFX_CYCLES_BOUND}`);
  assert.equal(compiledPlain.cycles.estimatedWorst, plain.cycles.estimatedWorst);
  assert.ok(withFx.cycles.estimatedWorst > plain.cycles.estimatedWorst);
  // overhead of 0, 1 and 3 effects playing, against the plain score, at several origins (page crossings differ)
  for (const origin of [0x1000, 0x10f3, 0x2001, 0x3ffd]) {
    const both = compileBoth(text, { origin }, EFFECTS);
    const run = (count) => {
      const actions = {};
      for (let n = 1; n <= 300; n++) actions[n] = Array.from({ length: count }, (_, k) => ({ sfx: [E.zap, k + 1] }));
      const { log } = lockstep(both, { calls: 300, actions });
      return Math.max(...log.map((entry) => entry.cycles - entry.plainCycles));
    };
    const idle = (() => { const { log } = lockstep(both, { calls: 120 }); return Math.max(...log.map((entry) => entry.cycles - entry.plainCycles)); })();
    const [one, three] = [run(1), run(3)];
    const bound = both.withFx.cycles.estimatedWorst - both.plain.image.estimatedWorstCycles;
    assert.ok(idle > 0 && idle < one && one < three && three <= bound, `origin ${origin.toString(16)}: idle +${idle}, 1 effect +${one}, 3 effects +${three}, bound +${bound}`);
    if (origin === 0x1000) console.log(`# effect engine overhead per play call: idle +${idle}, one effect +${one}, three effects +${three} cycles (bound +${bound})`);
  }
});

test("evidence for the need: a 1.3 player has no entry for events, and a song played as a sound effect restarts the music", () => {
  // SIDWave 1.3: a PRG has the installer, init and play, and nothing else.
  const v13 = compileSidwaveToPrg(parseSidwave(BASE13));
  assert.equal(v13.sfxAddress, undefined);
  assert.deepEqual([v13.entryAddress, v13.initAddress, v13.playAddress], [0x080d, 0x0810, 0x0813]);
  // SIDWave 1.4 songs: the shot is a fourth song. Starting it with init resets the player, so the title tune that was
  // playing cannot continue where it was: after init(0) it plays its first call again.
  const text = `${BASE}  - { name: shot, loop: false, tempo: 220, timeline: [ { bars: 1, layers: { v1: run } } ] }\n`;
  const build = compileSidwave(parseSidwave(text), { target: "game", origin: 0x1000, measure: false });
  const trace = (machine, calls) => {
    const out = [];
    for (let i = 0; i < calls; i++) {
      const start = machine.writes.length;
      machine.play();
      out.push(JSON.stringify(machine.writes.slice(start).map((w) => [w.address, w.value])));
    }
    return out;
  };
  const make = () => { const m = effectMachineFor(build); m.init(0, 0); return m; };
  const uninterrupted = make();
  const first = trace(uninterrupted, 130);
  const interrupted = make();
  trace(interrupted, 100);
  interrupted.init(3, 0);
  trace(interrupted, 8);
  interrupted.init(0, 0);
  const resumed = trace(interrupted, 30);
  assert.equal(resumed[0], first[0], "the title restarts from its first play call");
  assert.equal(resumed[0] === first[100], false, "it does not continue at call 100");
});

test("sfx keeps the interrupt and decimal flags of the caller, and only the contract's ranges are written while effects run on garbage memory", () => {
  const { withFx } = compileBoth(BASE, { origin: 0x3001, dataOrigin: 0x9001, zeroPage: 0x40 }, EFFECTS);
  const m = gameMachine(withFx, { garbage: true });
  m.init(0, 0);
  // The bundled emulator refuses to execute any instruction with D = 1. Each step runs with D = 0 and the flag is put back
  // afterwards: php pushes the caller's D, plp takes it back from the stack, everything else leaves it as it was.
  const step = m.cpu.step.bind(m.cpu);
  m.cpu.step = () => {
    const op = m.mem[m.cpu.pc];
    const d = m.cpu.d;
    m.cpu.d = 0;
    step();
    if (op === 0x08) m.mem[0x100 + m.cpu.sp + 1] |= d << 3;
    else if (op !== 0x28) m.cpu.d = d;
  };
  for (let n = 0; n < 700; n++) {
    m.cpu.y = [1, 2, 3, 0xff][n % 4];
    m.cpu.i = n % 2; m.cpu.d = n % 3 === 0 ? 1 : 0;
    m.cpu.call(withFx.contract.entryPoints.sfx, n % 7);
    assert.equal(m.cpu.i, n % 2, "the interrupt flag is as the caller left it");
    assert.equal(m.cpu.d, n % 3 === 0 ? 1 : 0, "the decimal flag is as the caller left it");
    m.cpu.d = 0; // the player itself runs with decimal mode off
    m.play();
  }
  m.stop();
  const { ram, zeroPage, sidRegisters } = withFx.contract;
  const allowed = (a) => sidRegisters.some(({ address, bytes }) => a >= address && a < address + bytes)
    || zeroPage.some(({ address, bytes }) => a >= address && a < address + bytes)
    || ram.some(({ start, end }) => a >= start && a < end) || a === 1 || (a >= 0x100 && a < 0x200);
  assert.deepEqual([...new Set(m.writes.filter(({ address }) => !allowed(address)).map(({ address }) => address))], []);
  assert.ok(ram.some(({ start, end }) => withFx.labels.sidwave_int_sfx_eff >= start && withFx.labels.sidwave_int_sfx_eff < end), "the effect state is inside the declared RAM");
  assert.ok(withFx.contract.maxStackBytes === null || withFx.contract.maxStackBytes <= 16);
});

test("every YAML example in the effects chapter of the specification and the README parses and compiles with the effects it shows", async () => {
  const fs = await import("node:fs");
  const spec = fs.readFileSync(new URL("../data/sound/sidwave.md", import.meta.url), "utf8");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const sources = [
    spec.slice(spec.indexOf("### Effects"), spec.indexOf("## SIDWave 1.5")),
    readme.slice(readme.indexOf("### Sound effects (SIDWave 1.4)"), readme.indexOf("### Example game programs")),
  ];
  let count = 0;
  for (const source of sources) {
    for (const [, block] of source.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      const effects = block.slice(block.indexOf("effects:"));
      const compiled = compileSidwaveToPrg(parseSidwave(`${BASE}\n${effects}`));
      assert.ok(compiled.effects.length >= 1);
      count += 1;
    }
  }
  assert.equal(count, 2);
});

const FULL_STEP = (filter) => `{ freq: C6, wave: tri+saw, pulse: 0.3, adsr: [1, 2, 3, 4], gate: true, ${filter ? "filter: off, " : ""}wait: 1 }, { freq: "440Hz", wave: pulse, pulse: 0.6, adsr: [2, 3, 4, 5], gate: false, wait: 1 }`;

test("the bound of the effect engine is above every measured call and close to the worst one, with and without filter: off", () => {
  for (const filter of [false, true]) {
    const effects = `\neffects:\n${[1, 2, 3].map((n) => `  e${n}: { priority: ${n}, steps: [ ${FULL_STEP(filter)} ] }\n`).join("")}`;
    let worst = 0;
    let worstSfx = 0;
    for (let origin = 0x1000; origin < 0x1000 + 256 * 3; origin += 41) {
      const both = compileBoth(BASE, { origin }, effects);
      const m = effectMachine(both.withFx);
      const q = effectMachine(both.plain);
      for (let song = 0; song < 3; song++) {
        m.init(song, 0); q.init(song, 0);
        for (let n = 0; n < 300; n++) {
          for (const v of [1, 2, 3]) worstSfx = Math.max(worstSfx, m.sfx(v - 1, v).cycles);
          worst = Math.max(worst, m.play() - q.play());
        }
      }
    }
    const bound = effectCyclesBound(3, filter);
    assert.ok(worst <= bound && bound - worst <= 150, `filter ${filter}: measured +${worst}, bound +${bound}`);
    assert.ok(worstSfx <= SFX_CYCLES_BOUND && worstSfx >= 340, `sfx ${worstSfx} cycles, bound ${SFX_CYCLES_BOUND}`);
    console.log(`# filter ${filter}: engine overhead up to +${worst} cycles (bound +${bound}), sfx up to ${worstSfx} (bound ${SFX_CYCLES_BOUND})`);
  }
});

test("every per-song estimate bounds a run of that song with three effects running", () => {
  const effects = `\neffects:\n${[1, 2, 3].map((n) => `  e${n}: { priority: ${n}, steps: [ ${FULL_STEP(true)} ] }\n`).join("")}`;
  const build = compileSidwave(parseSidwave(BASE + effects), { target: "game", origin: 0x1000, measure: false });
  const plain = compileSidwave(parseSidwave(BASE), { target: "game", origin: 0x1000, measure: false });
  const m = effectMachine(build);
  build.cycles.songs.forEach((song, k) => {
    assert.ok(song.estimatedWorst > plain.cycles.songs[k].estimatedWorst, `song ${k} includes the engine`);
    let worst = 0;
    m.init(k, 0);
    const frames = build.contract.songs[k].frames * 2 + 4;
    for (let n = 0; n < frames; n++) {
      for (const v of [1, 2, 3]) m.sfx(v - 1, v);
      worst = Math.max(worst, m.play());
    }
    assert.ok(worst <= song.estimatedWorst, `song ${k}: measured ${worst} <= estimate ${song.estimatedWorst}`);
  });
  assert.ok(build.cycles.estimatedWorst >= Math.max(...build.cycles.songs.map((song) => song.estimatedWorst)));
});
