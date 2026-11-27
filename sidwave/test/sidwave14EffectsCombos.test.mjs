// SIDWave 1.4 effects in combination with the other features: filter routing, several SIDs, a score that plays once
// (an `end` block), the PRG and the PSID output. The game build combinations with songs and multispeed are in
// sidwave14EffectsRuntime.test.mjs.
import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave, SidwaveValidationError } from "../src/sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { Cpu, sampleHarness } from "./helpers/sidwaveEmulator.mjs";
import { E, EFFECTS, EFFECT_FRAMES, compileBoth, exampleText, lockstep, ownedCalls } from "./helpers/sidwaveEffectsKit.mjs";
import { hzToSidFrequency } from "../src/sidwaveCompiler.js";

const at = (n, ...sfx) => ({ [n]: sfx.map((args) => ({ sfx: args })) });
const merge = (...parts) => {
  const out = {};
  for (const part of parts) for (const [k, v] of Object.entries(part)) out[k] = [...(out[k] ?? []), ...v];
  return out;
};

const FILTER_DOC = `sidwave: 1.4
title: Filter
tempo: 120
mode: PAL
global_fx:
  filter_env: { cutoff_base: 1800, sweep: -800, speed: 12, voices: [1, 2] }
instruments:
  lead: { waveform: pulse, adsr: [1, 5, 10, 4], pulse_width: 0.4 }
  bass: { waveform: sawtooth, adsr: [0, 5, 9, 3] }
voices:
  - { id: 1, instrument: lead, patterns: { tune: { length: 1, bars: 1, groove: "A4 C5 E5 D5" } } }
  - { id: 2, instrument: bass, patterns: { root: { length: 1, bars: 1, groove: "A2 ~ A2 ~" } } }
  - { id: 3, instrument: bass, patterns: { low: { length: 1, bars: 1, groove: "A1 ~ ~ ~" } } }
timeline:
  - { bars: 4, layers: { v1: tune, v2: root, v3: low } }
`;
const FILTER_EFFECTS = `
effects:
  dry:
    priority: 5
    steps:
      - { freq: C6, wave: pulse, filter: off, wait: 3 }
      - { freq: C5, filter: keep, wait: 2 }
      - { gate: false, wait: 1 }
  wet:
    priority: 3
    steps:
      - { freq: E5, wave: triangle, wait: 4 }
`;

test("filter: off clears the route bit of the voice from the next play call on, keep and the end of the effect restore it", () => {
  const builds = compileBoth(FILTER_DOC, {}, FILTER_EFFECTS);
  const { log } = lockstep(builds, { calls: 60, ignoreRoute: true, actions: merge(at(10, [0, 1]), at(30, [0, 2], [1, 1])) });
  const route = (writes) => writes.filter((w) => w.address === 0xd417).map((w) => w.value);
  let cleared = 0;
  log.forEach((entry, i) => {
    const mask = 0xff & ~entry.foff.reduce((bits, value) => bits | value, 0);
    assert.deepEqual(route(entry.writesM), route(entry.writesQ).map((value) => value & mask), `call ${i + 1}`);
    if (route(entry.writesM)[0] !== route(entry.writesQ)[0]) cleared += 1;
  });
  assert.ok(cleared >= 2, `the filter route bit was cleared in ${cleared} calls`);
  // dry on voice 1: step 0 (filter off) applies in call 10; its route bit is cleared in the calls 11 to 13
  assert.deepEqual(log.map((entry) => entry.foff[0]).slice(9, 20), [0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(builds.withFx.contract.effects.length, 2);
});

test("filter: off is not in the player when no step uses it", () => {
  const { withFx } = compileBoth(FILTER_DOC, {}, FILTER_EFFECTS.replace("filter: off, ", ""));
  assert.equal(withFx.labels.sidwave_int_sfx_foff, undefined);
});

test("two SIDs: the effects use the first SID's free voices; a centred voice cannot carry one", () => {
  const text = exampleText(readSidwaveExample("stereo_echo"));
  const { withFx } = compileBoth(text, {}, "\neffects:\n  zap: { priority: 5, steps: [ { freq: C6, wait: 2 }, { gate: false } ] }\n");
  const voices = withFx.contract.effects[0].voices;
  assert.ok(voices.length > 0 && voices.length < 3, `voices ${voices} (a centred voice is left out)`);
  const free = voices[0];
  const centred = [1, 2, 3].find((v) => !voices.includes(v));
  assert.throws(() => compileBoth(text, {}, `\neffects:\n  zap: { priority: 5, voices: [${centred}], steps: [ { freq: C6 } ] }\n`), /centred/);
  const builds = compileBoth(text, {}, `\neffects:\n  zap: { priority: 5, voices: [${voices.join(", ")}], steps: [ { freq: C6, wave: pulse, wait: 3 }, { gate: false } ] }\n  boom: { priority: 9, voices: [${voices.join(", ")}], steps: [ { freq: 90, wave: noise, wait: 5 }, { gate: false } ] }\n`);
  const { log, accepted } = lockstep(builds, { calls: 400, actions: merge(at(50, [0, free]), at(51, [1, 0xff]), at(120, [1, free]), at(200, [0, 0xff], [0, 0xff])) });
  assert.ok(accepted.length >= 4);
  assert.ok(log.some((entry) => entry.own.some((own) => own !== 0)));
});

test("a score that plays once (an end block) stops its effects at the end and rejects sfx afterwards", () => {
  const text = exampleText(readSidwaveExample("chamber_waltz"), { loop: false });
  const builds = compileBoth(text);
  const frames = builds.withFx.image.totalFrames;
  const { log } = lockstep(builds, { calls: frames + 120, actions: merge(at(frames - 40, [E.drone, 1]), at(frames - 20, [E.zap, 2]), at(frames + 60, [E.zap, 0xff])) });
  const last = log.map((entry, i) => (entry.own.some((own) => own !== 0) ? i : -1)).reduce((a, b) => Math.max(a, b));
  assert.ok(last >= frames - 2 && last <= frames + 2, `the effects end with the score: call ${last + 1} of ${frames}`);
  assert.deepEqual(log[frames + 59].sfx.map((s) => s.carry), [1]);
});

test("effects in a PRG: sfx is at $0816, the music of the other voices is unchanged and the effect writes its registers", () => {
  const text = readSidwaveExample("game_songs");
  const doc = parseSidwave(text + EFFECTS);
  const plainDoc = parseSidwave(text);
  const compiled = compileSidwaveToPrg(doc);
  const plain = compileSidwaveToPrg(plainDoc);
  assert.equal(compiled.sfxAddress, 0x0816);
  assert.equal(plain.sfxAddress, undefined);
  assert.deepEqual(compiled.effects.map((e) => e.name), ["zap", "boom", "blip", "low", "top", "drone", "same"]);
  const machine = (prg) => {
    const mem = new Uint8Array(65536);
    mem.set(prg.prg.subarray(2), prg.loadAddress);
    mem[0xea31] = 0x60;
    mem[0x02a6] = 1;
    let writes = [];
    const cpu = new Cpu(mem, { write(a, v) { if (a >= 0xd400 && a < 0xd800) writes.push([a - 0xd400, v]); } });
    return { cpu, mem, take: () => { const w = writes; writes = []; return w; } };
  };
  const m = machine(compiled);
  const q = machine(plain);
  m.cpu.call(compiled.initAddress, 0);
  q.cpu.call(plain.initAddress, 0);
  m.take(); q.take();
  const c6 = hzToSidFrequency(1046.5022612023945, "PAL");
  const calls = [];
  for (let n = 1; n <= 40; n++) {
    let carry;
    if (n === 12) { m.cpu.y = 1; m.cpu.call(compiled.sfxAddress, E.zap); carry = m.cpu.c; assert.equal(carry, 0); }
    if (n === 13) { m.cpu.y = 0xff; m.cpu.call(compiled.sfxAddress, 9); assert.equal(m.cpu.c, 1, "no effect 9"); }
    m.cpu.call(compiled.playAddress);
    q.cpu.call(plain.playAddress);
    calls.push([m.take(), q.take()]);
  }
  const notVoice1 = (writes) => writes.filter(([r]) => r >= 7).map(([r, v]) => `${r}=${v}`).join();
  calls.forEach(([w, p], i) => assert.equal(notVoice1(w), notVoice1(p), `call ${i + 1}`));
  // calls 12 to 18 belong to the effect on voice 1; its first call writes the zap's first step
  assert.deepEqual(calls[11][0].filter(([r]) => r < 7), [[4, 0], [0, c6 & 255], [1, c6 >> 8], [2, 0], [3, 8], [5, 2], [6, 0], [4, 0x41]]);
  for (const i of [12, 13, 14, 15, 16]) {
    const regs = calls[i][0].filter(([r]) => r < 7);
    assert.ok(regs.length <= 2, `call ${i + 1}: only the effect writes voice 1 (${JSON.stringify(regs)})`);
  }
  assert.deepEqual(Object.fromEntries(calls[17][0].filter(([r]) => r < 7)), Object.fromEntries(calls[17][1].filter(([r]) => r < 7)));
  assert.deepEqual(calls[30][0], calls[30][1]);
});

test("effects in a PSID: the file header is unchanged in kind, the code carries the effect entry and music-only playback equals the plain file's", () => {
  const text = readSidwaveExample("game_songs");
  const doc = parseSidwave(text + EFFECTS);
  const plainDoc = parseSidwave(text);
  const withFx = compileSidwaveToSid(doc, compileSidwaveToPrg(doc).prg).sid;
  const plain = compileSidwaveToSid(plainDoc, compileSidwaveToPrg(plainDoc).prg).sid;
  const run = (sid, triggers) => {
    const offset = sid.readUInt16BE(6);
    const load = sid[offset] | (sid[offset + 1] << 8);
    const mem = new Uint8Array(65536);
    mem.set(sid.subarray(offset + 2), load);
    mem[1] = 0x35;
    let writes = [];
    const cpu = new Cpu(mem, { write(a, v) { if (a >= 0xd400 && a < 0xd800) writes.push([a, v]); } });
    cpu.call(sid.readUInt16BE(10), 0);
    const out = [];
    for (let n = 1; n <= 60; n++) {
      if (triggers && n === 20) { cpu.y = 3; cpu.call(0x0816, E.blip); assert.equal(cpu.c, 0); }
      writes = [];
      cpu.call(sid.readUInt16BE(12));
      out.push(JSON.stringify(writes));
    }
    return out;
  };
  assert.equal(withFx.readUInt16BE(10), 0x0810);
  assert.equal(withFx.readUInt16BE(12), 0x0813);
  assert.deepEqual(run(withFx, false), run(plain, false));
  const triggered = run(withFx, true);
  const idle = run(plain, false);
  // sfx before call 20 (blip on voice 3, one step): the effect owns voice 3 in calls 20 and 21, so only those differ
  const different = triggered.map((line, n) => (line !== idle[n] ? n + 1 : 0)).filter(Boolean);
  assert.deepEqual(different, [20, 21]);
});

test("filter: off also masks the routing that filter tables and a filter owner write", () => {
  const text = exampleText(readSidwaveExample("funk_bass"));
  const builds = compileBoth(text, {}, `\neffects:\n  zap: { priority: 5, steps: [ { freq: C6, wait: 6, filter: off }, { gate: false } ] }\n`);
  const actions = {};
  for (let n = 20; n < 400; n += 25) actions[n] = [{ sfx: [0, 1 + ((n / 25 | 0) % 3)] }];
  const { log, accepted } = lockstep(builds, { calls: 420, actions, ignoreRoute: true });
  assert.ok(accepted.length >= 10);
  const route = (writes) => writes.filter((w) => w.address === 0xd417).map((w) => w.value);
  let cleared = 0;
  log.forEach((entry, i) => {
    const mask = 0xff & ~entry.foff.reduce((bits, value) => bits | value, 0);
    assert.deepEqual(route(entry.writesM), route(entry.writesQ).map((value) => value & mask), `call ${i + 1}`);
    if (route(entry.writesQ).some((value) => (value & ~mask) !== 0)) cleared += 1;
  });
  assert.ok(cleared >= 10, `the mask cleared a routed voice in ${cleared} calls`);
});

test("CIA2 digi samples with an effect on a pitched voice: the effect never writes the digi chip, and the sample writes are those of the plain score", () => {
  const text = exampleText(readSidwaveExample("digi_groove"), { loop: false });
  const effects = "\neffects:\n  zap: { priority: 5, steps: [ { freq: C6, wave: pulse, wait: 3 }, { gate: false, wait: 1 } ] }\n";
  const docFx = parseSidwave(text + effects);
  const digiAddress = docFx.sids[1].address;
  const run = (source, trigger) => {
    const h = sampleHarness(source);
    h.writes.length = 0;
    const frames = [];
    for (let f = 0; f < 40; f++) {
      if (trigger && f === 10) { h.cpu.y = 3; h.cpu.call(0x0816, 0); assert.equal(h.cpu.c, 0); }
      const start = h.writes.length;
      h.cpu.call(h.irq);
      for (let t = 0; t < 40; t++) h.tick();
      frames.push(h.writes.slice(start));
    }
    return frames;
  };
  const fx = run(docFx, true);
  const plain = run(parseSidwave(text), false);
  const inChip = (address, base) => address >= base && address < base + 0x20;
  const first = docFx.sids[0].address;
  const sidWrites = (frames, base) => frames.map((writes) => JSON.stringify(writes.filter(([a]) => inChip(a, base))));
  assert.deepEqual(sidWrites(fx, digiAddress), sidWrites(plain, digiAddress), "every write to the digi chip, the samples included, is the plain score's");
  const digiWrites = fx.flat().filter(([a]) => inChip(a, digiAddress));
  assert.ok(digiWrites.length > 100, `${digiWrites.length} writes to the digi chip`);
  // Voices 1 and 2 of the first SID and its filter and volume registers are unchanged; voice 3 differs in the calls of the effect only.
  const voice3 = (frames) => frames.map((writes) => JSON.stringify(writes.filter(([a]) => a >= first + 14 && a <= first + 20)));
  const others = (frames) => frames.map((writes) => JSON.stringify(writes.filter(([a]) => inChip(a, first) && !(a >= first + 14 && a <= first + 20))));
  assert.deepEqual(others(fx), others(plain));
  const different = voice3(fx).map((line, f) => (line !== voice3(plain)[f] ? f : -1)).filter((f) => f >= 0);
  assert.deepEqual(different, [10, 11, 12, 13, 14], "voice 3 of the first SID differs for the effect's 4 calls and its restore call only");
});
