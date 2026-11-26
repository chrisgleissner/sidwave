// SIDWave 1.4 effects at run time (S4c): every scenario of the design's adversarial list runs on the bundled emulator
// against the same score without effects. test/helpers/sidwaveEffectsKit.mjs checks after every play call that (a) the
// voices without an effect and the global registers write what the plain music writes, (b) the SID register image equals
// the plain run's wherever no effect owns the voice, (c) every write to an owned voice comes from the effect engine,
// and (d) an accepted effect writes in the very next play call. The tests add their own exact assertions.
import test from "#test/runner";
import assert from "#test/assert";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { E, EFFECTS, EFFECT_FRAMES, compileBoth, lockstep, ownedCalls, worstCycles, effectMachine } from "./helpers/sidwaveEffectsKit.mjs";
import { hzToSidFrequency } from "../src/sidwaveCompiler.js";

const BASE = readSidwaveExample("game_songs");
const builds = compileBoth(BASE);
const songs = builds.withFx.contract.songs;
const FRAMES = songs.map((song) => song.frames);

const at = (n, ...sfx) => ({ [n]: sfx.map((args) => ({ sfx: args })) });
const merge = (...parts) => {
  const out = {};
  for (const part of parts) for (const [k, v] of Object.entries(part)) out[k] = [...(out[k] ?? []), ...v];
  return out;
};

test("an effect writes the registers of its steps in the call after sfx and gives the voice back with the music's values", () => {
  const { log, accepted } = lockstep(builds, { calls: 40, actions: at(10, [E.zap, 1]) });
  assert.deepEqual(accepted.map(({ call, voice, a }) => [call, voice, a]), [[10, 0, E.zap]]);
  const fromEngine = (n) => log[n - 1].writesM.filter((w) => w.pc >= builds.withFx.labels.sidwave_int_sfx && w.pc < builds.withFx.labels.sidwave_int_sfx_so + 3).map((w) => [w.address - 0xd400, w.value]);
  const c6 = hzToSidFrequency(1046.5022612023945, "PAL");
  const hz1200 = hzToSidFrequency(1200, "PAL");
  // call 10: first step. Gate off first (a clean restart), then frequency, pulse width, AD, SR, control with the gate on.
  assert.deepEqual(fromEngine(10), [[4, 0], [0, c6 & 255], [1, c6 >> 8], [2, 0], [3, 8], [5, 0x02], [6, 0x00], [4, 0x41]]);
  assert.deepEqual(fromEngine(11), []);
  assert.deepEqual(fromEngine(12), [[0, hz1200 & 255], [1, hz1200 >> 8]]);
  assert.deepEqual(fromEngine(13), []);
  assert.deepEqual(fromEngine(14), []);
  assert.deepEqual(fromEngine(15), [[4, 0x40]]);
  // call 16: the effect has run for its 6 play calls; the shadow registers return to the SID, control last.
  const restore = fromEngine(16);
  assert.deepEqual(restore.map(([r]) => r), [0, 1, 2, 3, 5, 6, 4]);
  const plainVoice1 = Object.fromEntries(log[15].writesQ.filter((w) => w.address < 0xd407).map((w) => [w.address - 0xd400, w.value]));
  assert.deepEqual(Object.fromEntries(restore), plainVoice1);
  assert.deepEqual(log.map((entry) => entry.own[0]), [...Array(9).fill(0), ...Array(7).fill(1), ...Array(24).fill(0)]);
  assert.equal(ownedCalls(log, 0, 10), EFFECT_FRAMES.zap + 1, "owned from the call after sfx until the restore call");
});

test("the effect and the music keep to their voices when sfx is called on every play call for ten seconds", () => {
  const calls = 503; // 10 s at 50.12 calls per second
  const actions = {};
  for (let n = 1; n <= calls; n++) actions[n] = [{ sfx: [n % 7, [1, 2, 3, 0xff][n % 4]] }];
  const { log, accepted } = lockstep(builds, { calls, actions });
  assert.ok(accepted.length > 100, `${accepted.length} effects were accepted`);
  assert.ok(log.some((entry) => entry.sfx.some((s) => s.carry === 1)), "some were rejected");
  assert.ok(worstCycles(log) <= builds.withFx.cycles.estimatedWorst, `${worstCycles(log)} cycles per call, bound ${builds.withFx.cycles.estimatedWorst}`);
  console.log(`# every-call triggers: worst play call ${worstCycles(log)} cycles (bound ${builds.withFx.cycles.estimatedWorst}), ${accepted.length} of ${calls} accepted`);
});

test("effects on all three voices at once", () => {
  const { log, accepted } = lockstep(builds, { calls: 60, actions: at(20, [E.zap, 1], [E.zap, 2], [E.zap, 3], [E.blip, 3]) });
  assert.deepEqual(accepted.map(({ voice }) => voice), [0, 1, 2]);
  assert.deepEqual(log[19].sfx.map((s) => s.carry), [0, 0, 0, 1], "the fourth, a lower priority effect, finds no voice");
  assert.deepEqual(log[19].own, [E.zap + 1, E.zap + 1, E.zap + 1]);
  for (const voice of [0, 1, 2]) assert.equal(ownedCalls(log, voice, 20), EFFECT_FRAMES.zap + 1);
  // all three music voices are silent for the effect's duration and equal the plain run before and after
  assert.deepEqual(log[26].own, [0, 0, 0]);
});

test("voice allocation: free voice first, lowest priority below the new one next, the same effect restarts, everything else is rejected", () => {
  const steps = [
    [E.boom, 0xff], [E.zap, 0xff], [E.blip, 0xff],       // boom: voice 2 (lowest free of 2,3); zap: voice 1; blip: voice 3
    [E.low, 0xff],                                      // priority 0 finds no lower voice
    [E.same, 0xff],                                     // priority 5: voice 3 runs blip (2)
    [E.top, 0xff],                                      // priority 15: lowest priority is 5 on voices 1 and 3; voice 1 is the lower number
    [E.zap, 0xff],                                      // priority 5 against 15, 9 and 5; zap is no longer running
    [E.same, 0xff],                                     // equal priority, the same effect runs on voice 3: restart
    [E.boom, 1],                                        // voice 1 is not allowed for boom
    [E.top, 2],                                         // voice 2 runs boom (9)
    [E.low, 3],                                         // voice 3 runs same (5)
    [E.zap, 3],                                         // equal priority, another effect
    [9, 0xff], [E.zap, 4], [E.zap, 0],                  // no such effect, no such voices
  ];
  const { log } = lockstep(builds, { calls: 20, actions: at(5, ...steps) });
  const result = log[4].sfx;
  assert.deepEqual(result.map((s) => s.carry), [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
  assert.deepEqual(result.map((s) => s.voice), [1, 0, 2, -1, 2, 0, -1, 2, -1, 1, -1, -1, -1, -1, -1]);
  assert.deepEqual(result.map((s) => s.after), [
    [0, E.boom + 1, 0], [E.zap + 1, E.boom + 1, 0], [E.zap + 1, E.boom + 1, E.blip + 1],
    [E.zap + 1, E.boom + 1, E.blip + 1],
    [E.zap + 1, E.boom + 1, E.same + 1], [E.top + 1, E.boom + 1, E.same + 1],
    [E.top + 1, E.boom + 1, E.same + 1], [E.top + 1, E.boom + 1, E.same + 1],
    [E.top + 1, E.boom + 1, E.same + 1], [E.top + 1, E.top + 1, E.same + 1],
    [E.top + 1, E.top + 1, E.same + 1], [E.top + 1, E.top + 1, E.same + 1], [E.top + 1, E.top + 1, E.same + 1], [E.top + 1, E.top + 1, E.same + 1], [E.top + 1, E.top + 1, E.same + 1],
  ]);
});

test("priority 0 and priority 15 effects: the lowest never takes a busy voice, the highest takes any voice of lower priority", () => {
  // low (0) on all voices, then top (15) takes voice 1, then low is rejected everywhere
  const { log } = lockstep(builds, { calls: 30, actions: merge(at(5, [E.low, 1], [E.low, 2], [E.low, 3]), at(6, [E.top, 0xff]), at(7, [E.low, 0xff], [E.low, 1])) });
  assert.deepEqual(log[4].sfx.map((s) => s.carry), [0, 0, 0]);
  assert.deepEqual(log[5].sfx.map((s) => [s.carry, s.voice]), [[0, 0]]);
  // call 7: low is still running on voices 2 and 3 (4 calls), so the same effect restarts there; voice 1 is taken by top
  assert.deepEqual(log[6].sfx.map((s) => s.carry), [0, 1]);
});

test("a trigger in the call that wraps the song loop", () => {
  const frames = FRAMES[0];
  const actions = merge(at(frames - 1, [E.zap, 1]), at(frames, [E.boom, 2]), at(frames + 1, [E.blip, 3]), at(frames + 2, [E.top, 0xff]));
  const { log } = lockstep(builds, { song: 0, calls: frames + 40, actions });
  assert.equal(ownedCalls(log, 0, frames - 1), EFFECT_FRAMES.zap + 1, "the effect on voice 1 runs across the loop point");
  assert.equal(ownedCalls(log, 1, frames), EFFECT_FRAMES.boom + 1);
  // the blip owns voice 3 for one call, then top takes the voice over without a gap
  assert.equal(ownedCalls(log, 2, frames + 1), 1 + EFFECT_FRAMES.top + 1);
  // every voice is busy when top starts, the blip (priority 2) has the lowest priority and gives its voice up
  assert.deepEqual(log[frames + 1].sfx.map((s) => [s.carry, s.voice]), [[0, 2]]);
  assert.deepEqual(log[frames + 1].own, [E.zap + 1, E.boom + 1, E.top + 1]);
});

test("a play-once song that ends while an effect runs stops the effect, restores the music's registers and rejects sfx", () => {
  const frames = FRAMES[2];
  const actions = merge(at(frames - 30, [E.drone, 1], [E.zap, 2]), at(frames + 30, [E.zap, 0xff]));
  const { log } = lockstep(builds, { song: 2, calls: frames + 90, actions });
  const lastOwned = log.map((entry, i) => (entry.own.some((own) => own !== 0) ? i : -1)).reduce((a, b) => Math.max(a, b));
  assert.ok(lastOwned >= frames - 1 && lastOwned <= frames + 2, `the effects end with the song (call ${lastOwned + 1} of ${frames})`);
  assert.deepEqual(log[lastOwned].ownAfter, [0, 0, 0]);
  assert.deepEqual(log[frames + 29].sfx.map((s) => s.carry), [1], "sfx after the end of the song is rejected");
  assert.ok(EFFECT_FRAMES.drone > frames, "the effect was longer than the song");
});

test("an effect running when stop is called is cancelled; play calls after stop write what the plain run writes", () => {
  const actions = merge(at(20, [E.zap, 1], [E.drone, 2]), { 23: [{ stop: true }] });
  const { log } = lockstep(builds, { calls: 70, actions });
  assert.deepEqual(log[21].own, [E.zap + 1, E.drone + 1, 0]);
  for (let n = 23; n <= 70; n++) assert.deepEqual(log[n - 1].own, [0, 0, 0], `call ${n}`);
  const stray = log.slice(23).flatMap((entry) => entry.writesM).filter((w) => w.pc >= builds.withFx.labels.sidwave_int_sfx && w.pc < builds.withFx.labels.sidwave_int_sfx_so + 3);
  assert.deepEqual(stray, [], "no write of the effect engine after stop");
});

test("init cancels the running effects and starts like a fresh player", () => {
  const actions = merge(at(20, [E.drone, 1], [E.drone, 2], [E.drone, 3]), { 24: [{ init: 1 }] });
  const { log } = lockstep(builds, { calls: 60, actions });
  assert.deepEqual(log[22].own, [E.drone + 1, E.drone + 1, E.drone + 1]);
  assert.deepEqual(log[23].own, [0, 0, 0]);
});

test("effects during a multispeed song (two play calls per video frame)", () => {
  const text = BASE.replace("tempo: 140\n", "tempo: 140\n    speed: 2\n");
  const both = compileBoth(text);
  assert.equal(both.withFx.contract.songs[1].playCallsPerFrame, 2);
  const actions = {};
  for (let n = 5; n < 400; n += 7) actions[n] = [{ sfx: [(n >> 1) % 7, [1, 0xff, 3, 2][(n >> 2) % 4]] }];
  const { log, accepted } = lockstep(both, { song: 1, calls: 420, actions });
  assert.ok(accepted.length > 30);
  assert.ok(log.some((entry) => entry.own.some((own) => own !== 0)));
});

test("garbage in memory: the effect state is initialised by init alone", () => {
  const { log } = lockstep(builds, { calls: 40, garbage: true, actions: at(8, [E.same, 3], [E.blip, 3]) });
  assert.ok(log.some((entry) => entry.own.some((own) => own !== 0)));
});

test("sfx called before the first play call after init still starts at the next play call", () => {
  const { log } = lockstep(builds, { calls: 10, actions: at(1, [E.zap, 1]) });
  assert.deepEqual(log[0].own, [E.zap + 1, 0, 0]);
});

test("the effect machine reports the contract entries", () => {
  const m = effectMachine(builds.withFx);
  assert.ok(m.engine[0] < m.engine[1]);
});
