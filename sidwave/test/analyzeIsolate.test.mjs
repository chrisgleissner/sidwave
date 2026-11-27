// Voice isolation by reconstruct-and-recompile, and the detection of coupled voices.
import test from "#test/runner";
import assert from "#test/assert";
import { detectCoupling, isolateVoice, silenceVoices } from "../src/analyze/isolate.ts";
import { restrictIrToVoice } from "../src/analyze/common.ts";
import { reconstructSid } from "../src/reconstruct/reconstruct.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { irOf, seededSid, syntheticIr, freqWrites } from "./helpers/analyzeKit.mjs";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";

const samplesOf = (wav) => new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
const energy = (s) => s.reduce((n, x) => n + Math.abs(x), 0);

test("solo isolation keeps one voice: the other voices have no register activity and the WAV has sound", { timeout: 120_000 }, async () => {
  const sid = seededSid("basic", 4);
  const r = await isolateVoice(sid, { voice: 2, engine: sharedEngine(), seconds: 3 });
  assert.equal(r.method, "reconstruct-and-recompile");
  assert.match(r.methodNote, /cannot replay a list of register writes/);
  assert.equal(r.mode, "solo");
  assert.deepEqual(r.silenced, [1, 3]);
  assert.equal(r.reconstructionStrictExact, true);
  assert.equal(String.fromCharCode(...r.wav.subarray(0, 4)), "RIFF");
  assert.ok(energy(samplesOf(r.wav)) > 1_000_000);
  assert.equal(r.horizon.sampleRate, 48000);
  const again = await isolateVoice(sid, { voice: 2, engine: sharedEngine(), seconds: 3 });
  assert.equal(again.sha256, r.sha256, "deterministic");
  // The silenced score has no activity on voices 1 and 3.
  const rec = await reconstructSid(sid, { engine: sharedEngine(), seconds: 3 });
  const masked = silenceVoices(rec.score, [1, 3]);
  const ir = await irOf(new Uint8Array(compileSidwaveBytes(parseSidwave(masked), { format: "sid", loop: true }).bytes), 3);
  const active = (v) => restrictIrToVoice(ir, v).calls.some((c) => c.sids[0].regs.some((b) => b !== 0));
  assert.deepEqual([active(1), active(2), active(3)], [false, true, false]);
});

test("mute isolation silences exactly the chosen voice", { timeout: 120_000 }, async () => {
  const sid = seededSid("basic", 4);
  const muted = await isolateVoice(sid, { voice: 1, mode: "mute", engine: sharedEngine(), seconds: 3 });
  assert.deepEqual(muted.silenced, [1]);
  const solo = await isolateVoice(sid, { voice: 1, engine: sharedEngine(), seconds: 3 });
  assert.notEqual(muted.sha256, solo.sha256);
});

test("for voices that are not coupled, the powers of the three solo renders add up to the power of the full render", { timeout: 180_000 }, async () => {
  const sid = seededSid("basic", 5);
  const solos = [];
  for (const voice of [1, 2, 3]) solos.push(samplesOf((await isolateVoice(sid, { voice, engine: sharedEngine(), seconds: 3 })).wav));
  const full = await sharedEngine().render({ sid, seconds: 3, sampleRate: 48000, channels: 1 });
  // Every render carries the DC level of the chip with silent voices; it is removed with the render of the tune with all voices silenced.
  const rec = await reconstructSid(sid, { engine: sharedEngine(), seconds: 3 });
  const silent = await sharedEngine().render({ sid: new Uint8Array(compileSidwaveBytes(parseSidwave(silenceVoices(rec.score, [1, 2, 3])), { format: "sid", loop: true }).bytes), seconds: 3, sampleRate: 48000, channels: 1 });
  // The waveforms do not add sample by sample: the oscillator phase depends on the exact cycle of each frequency write,
  // and the recompiled player writes a few cycles apart from the original. The power of uncorrelated voices does add.
  const power = (samples) => { let sum = 0; for (let i = 5000; i < samples.length; i++) sum += (samples[i] - silent.samples[i]) ** 2; return sum / (samples.length - 5000); };
  const fullPower = power(full.samples);
  const soloPower = solos.reduce((n, s) => n + power(s), 0);
  assert.ok(fullPower > 1_000_000, `full power ${fullPower}`);
  assert.ok(soloPower / fullPower > 0.85 && soloPower / fullPower < 1.15, `power of the solos ${soloPower}, of the full tune ${fullPower}`);
  const coupling = (await isolateVoice(sid, { voice: 1, engine: sharedEngine(), seconds: 3 })).coupling;
  assert.equal(coupling.nonAdditive, false);
});

test("coupling is detected in the trace: filter routing, sync, ring and sample playback make the isolation non-additive", () => {
  const A4 = 0x1d45;
  const filter = syntheticIr(20, (c) => (c === 1 ? [[0x17, 0xf3], [0x18, 0x1f], [4, 0x41], [11, 0x41], [18, 0x41]] : freqWrites(0, A4)));
  const f1 = detectCoupling(filter, 1);
  assert.equal(f1.nonAdditive, true);
  assert.deepEqual(f1.filterRouted, [1, 2]);
  assert.match(f1.reasons[0], /filter/);
  assert.equal(detectCoupling(filter, 3).nonAdditive, true, "voices 1 and 2 share the filter, so voice 3 mixes with a nonlinear stage");
  const single = syntheticIr(20, (c) => (c === 1 ? [[0x17, 0xf1], [0x18, 0x1f], [4, 0x41], [11, 0x41]] : freqWrites(0, A4)));
  assert.equal(detectCoupling(single, 2).nonAdditive, false, "an unfiltered voice next to one filtered voice stays additive");
  assert.equal(detectCoupling(single, 1).nonAdditive, true);
  const sync = syntheticIr(20, (c) => (c === 1 ? [[4, 0x43], [11, 0x41], [18, 0x41]] : freqWrites(0, A4)));
  const s = detectCoupling(sync, 3);
  assert.deepEqual(s.sync, [{ voice: 1, source: 3 }]);
  assert.equal(s.nonAdditive, true, "voice 3 is the modulator of voice 1");
  assert.equal(detectCoupling(sync, 2).nonAdditive, false);
  const ring = syntheticIr(20, (c) => (c === 1 ? [[4, 0x45], [11, 0x41], [18, 0x41]] : freqWrites(0, A4)));
  assert.deepEqual(detectCoupling(ring, 1).ring, [{ voice: 1, source: 3 }]);
  assert.match(detectCoupling(ring, 1).reasons[0], /ring-modulated by voice 3/);
});

test("fixtures: the sync tune and the sample-playing tune are reported as coupled", { timeout: 180_000 }, async () => {
  const sync = await isolateVoice(new Uint8Array(buildFixture("sync").sid), { voice: 1, engine: sharedEngine(), seconds: 3 });
  assert.equal(sync.coupling.nonAdditive, true);
  assert.ok(sync.coupling.sync.length >= 1);
  assert.equal(sync.reconstructionStrictExact, false, "the result says that the reconstruction is not exact");
  const sampler = await isolateVoice(new Uint8Array(buildFixture("nmiSampler").sid), { voice: 1, engine: sharedEngine(), seconds: 3 });
  assert.equal(sampler.coupling.sampleStreams, true);
  assert.equal(sampler.coupling.nonAdditive, true);
});

test("invalid voices and subtunes are rejected", { timeout: 60_000 }, async () => {
  const sid = seededSid("basic", 1);
  await assert.rejects(() => isolateVoice(sid, { voice: 4, engine: sharedEngine(), seconds: 1 }), /--voice 4 is outside 1\.\.3/);
  await assert.rejects(() => isolateVoice(sid, { voice: 0, engine: sharedEngine(), seconds: 1 }), /outside/);
  await assert.rejects(() => isolateVoice(sid, { voice: 1, song: 3, engine: sharedEngine(), seconds: 1 }), /song 3/);
});
