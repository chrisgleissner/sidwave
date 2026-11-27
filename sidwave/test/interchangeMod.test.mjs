import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMod, ModError, periodToMidi, MOD_MAX_BYTES } from "../src/interchange/mod.js";
import { importMod, chooseRowsPerBeat, planBars } from "../src/interchange/modImport.js";
import { analyzeSample, drumFromName, measureLoopCycle, normalisedAutocorrelation } from "../src/interchange/modSamples.js";
import { convert } from "../src/interchange/convert.js";
import { detectFormat } from "../src/interchange/registry.js";
import { exportEvents } from "../src/interchange/events.js";
import { UsageError } from "../src/cliCore.js";
import { playRows } from "../src/interchange/modPlay.js";
import { InterchangeUsageError } from "../src/interchange/errors.js";
import { parseSidwave } from "../src/sidwave.js";
import { runCli } from "../src/cli.js";
import { fuzz, cpuMs } from "./helpers/formatKit.mjs";
import { buildMod, pattern, songFourChannel, songEffects, songVariant, songLarge, MOD_FIXTURES, SAMPLES, periodOf } from "./helpers/modKit.mjs";

const fixtures = new URL("./fixtures/mod/", import.meta.url);
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "modtest-"));
function cli(args, cwd) {
  let out = "", err = "";
  const io = { cwd, out: (t) => { out += t; }, err: (t) => { err += t; }, outBytes: () => {} };
  return Promise.resolve(runCli(args, io)).then((code) => ({ code, out, err }));
}
const typed = [ModError, InterchangeUsageError, RangeError];

test("committed hand-built fixtures are the bytes of the test kit", () => {
  for (const [name, bytes] of Object.entries(MOD_FIXTURES())) {
    assert.deepEqual(new Uint8Array(fs.readFileSync(new URL(name, fixtures))), bytes, name);
  }
});

test("period to note: 428 is MIDI 48, finetune shifts the period", () => {
  assert.equal(periodToMidi(428), 48);
  assert.equal(periodToMidi(214), 60);
  assert.equal(periodToMidi(856), 36);
  assert.equal(periodToMidi(113), 71);
  // Finetune -8 plays a period 2^(8/96) (5.9 %) higher in ProTracker's table... the note a period maps to does not move.
  assert.equal(periodToMidi(Math.round(428 * 2 ** (-3 / 96)), 3), 48);
  assert.equal(periodToMidi(Math.round(428 * 2 ** (8 / 96)), -8), 48);
});

test("reader: every layout gives its channel count, patterns and cells", () => {
  const layouts = [["M.K.", 4], ["M!K!", 4], ["FLT4", 4], ["4CHN", 4], ["6CHN", 6], ["8CHN", 8], ["FLT8", 8], ["10CH", 10], ["CD81", 8], [null, 4]];
  for (const [variant, channels] of layouts) {
    const song = parseMod(songVariant(variant, channels));
    assert.equal(song.channels, channels, String(variant));
    assert.equal(song.variant, variant ?? "15-sample");
    assert.equal(song.sampleCount, variant === null ? 15 : 31);
    assert.equal(song.patterns.length, 1);
    for (let c = 0; c < channels; c++) {
      assert.equal(song.patterns[0].period[c], periodOf(36 + 7 * c), `${variant} channel ${c} row 0`);
      assert.equal(song.patterns[0].sample[16 * channels + c], 1);
      assert.equal(song.patterns[0].period[16 * channels + c], periodOf(40 + 7 * c));
    }
    assert.equal(song.samples[0].looped, true);
    assert.equal(song.samples[0].length, 64);
  }
});

test("reader: sample header fields, finetune, a sample number above 31 uses the high nibble", () => {
  const rows = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  rows[0][0] = { note: 48, sample: 0x1f };
  const samples = Array.from({ length: 31 }, (_, i) => ({ name: `smp${i}`, data: SAMPLES.sine.data, volume: 10 + i, loop: i === 4 ? [8, 32] : undefined }));
  const bytes = buildMod({ samples, patterns: [rows], finetune: { 1: 9 } });
  const song = parseMod(bytes);
  assert.equal(song.patterns[0].sample[0], 31);
  assert.equal(song.samples[1].finetune, -7);
  assert.equal(song.samples[4].loopStart, 8);
  assert.equal(song.samples[4].loopLength, 32);
  assert.equal(song.samples[0].looped, false);
  assert.equal(song.samples[30].name, "smp30");
  assert.equal(song.samples[30].volume, 40);
});

test("reader: typed errors for files that are not MODs", () => {
  assert.throws(() => parseMod(new Uint8Array(10)), ModError);
  assert.throws(() => parseMod(new Uint8Array(MOD_MAX_BYTES + 1)), /limit/);
  const good = songFourChannel();
  assert.throws(() => parseMod(good.subarray(0, 2000)), /ends inside the pattern data/);
  const noLength = Uint8Array.from(good); noLength[950] = 0;
  assert.throws(() => parseMod(noLength), /song length is 0/);
  const manyPatterns = Uint8Array.from(good); manyPatterns[952] = 200;
  assert.throws(() => parseMod(manyPatterns), /limit/);
  const garbage = songVariant(null, 4);
  garbage.fill(0xff, 600, 700);
  assert.throws(() => parseMod(garbage), /no MOD signature/);
  const clamp = Uint8Array.from(good); clamp[950] = 200;
  assert.ok(parseMod(clamp).warnings.some((w) => /clamped to 128/.test(w)));
});

test("reader: a file that ends in the sample data is read as far as it goes", () => {
  const good = songFourChannel();
  const song = parseMod(good.subarray(0, good.length - 500));
  assert.ok(song.warnings.some((w) => /sample data/.test(w)));
  assert.ok(song.samples[5].length < 2000);
});

test("fuzz: at least 1000 mutated MODs give a result or a typed error, quickly", () => {
  const base = [songFourChannel(), songEffects(), songVariant("6CHN", 6), songVariant("FLT8", 8), songVariant(null, 4)];
  const a = fuzz({ seed: 41, cases: 1500, base, parse: (b) => parseMod(b), typed });
  assert.equal(a.accepted + a.rejected, 1500);
  const b = fuzz({ seed: 42, cases: 400, base: [songFourChannel(), songEffects()], parse: (x) => importMod(x, { validate: false }), typed, limitMs: 5000 });
  assert.equal(b.accepted + b.rejected, 400);
  assert.ok(a.rejected > 0 && a.accepted > 0);
});

test("sample analysis: waveform from harmonics, noise, percussion by name and by character", () => {
  const song = parseMod(buildMod({ samples: [SAMPLES.sine, SAMPLES.square, SAMPLES.saw, SAMPLES.noise, SAMPLES.kick, SAMPLES.hat, SAMPLES.snare, { ...SAMPLES.kick, name: "x1" }, { ...SAMPLES.snare, name: "x2" }, { ...SAMPLES.hat, name: "x3" }], patterns: [[]] }));
  const a = song.samples.slice(0, 10).map(analyzeSample);
  assert.equal(a[0].waveform, "triangle");
  assert.equal(a[1].waveform, "pulse");
  assert.equal(a[2].waveform, "sawtooth");
  assert.equal(a[3].waveform, "noise");
  assert.equal(a[3].drum, undefined);
  assert.equal(a[4].drum, 36);
  assert.equal(a[5].drum, 42);
  assert.equal(a[6].drum, 38);
  // Without a name: the low decaying sample is a kick or tom, the noise bursts are snare and hat.
  assert.ok([36, 45].includes(a[7].drum), `x1 drum ${a[7].drum}`);
  assert.ok([38, 42, 46].includes(a[8].drum), `x2 drum ${a[8].drum}`);
  assert.ok([42, 46].includes(a[9].drum), `x3 drum ${a[9].drum}`);
  // Looped samples sustain; one-shots decay to zero.
  assert.ok(a[0].adsr[2] >= 8);
  assert.equal(a[4].adsr[2], 0);
  for (const [name, key] of [["Bassdrum", 36], ["BD_01", 36], ["snare 2", 38], ["hihat", 42], ["open hat", 46], ["crash", 49], ["tom lo", 45], ["lead", undefined], ["abdomen", undefined]]) {
    assert.equal(drumFromName(name), key, name);
  }
});

test("drum names match as whole words; digits and underscores separate words", () => {
  for (const [name, key] of [
    ["kick1", 36], ["808kick", 36], ["Kick_2", 36], ["bd2", 36], ["bassdrum", 36], ["snare_hard", 38], ["clap 2", 39], ["oh1", 46], ["openhat", 46], ["Open Hat", 46],
    ["ch_1", 42], ["hat3", 42], ["hihat", 42], ["MyHiHats", 42], ["hi-hat", 42], ["tomtom", 45], ["tom2", 45], ["crash1", 49], ["cym", 49], ["splash 1", 49], ["cymbals", 49],
    ["ride", 49], ["Ride 2", 49], ["ride_01", 49], ["ride bell", 49], ["RideCymbal", 49], ["my ride cymbal", 49], ["ride of", 49],
  ]) assert.equal(drumFromName(name), key, name);
  for (const name of [
    "Bride", "Pride pad", "Clapton", "Kickstart", "Ride of the strings", "ride pad", "stride", "overrides", "crashed", "cymatic", "splashy", "snares", "chat", "chord", "Ohio", "hatch", "kicks",
  ]) assert.equal(drumFromName(name), undefined, name);
});

/** One waveform with `cycles` cycles in `length` points. */
const loopOf = (kind, length, cycles = 1) => Int8Array.from({ length }, (_, i) => {
  const ph = ((i * cycles) % length) / length;
  if (kind === "square") return ph < 0.5 ? 100 : -100;
  if (kind === "saw") return Math.round(200 * ph - 100);
  return Math.round(100 * Math.sin(2 * Math.PI * ph));
});
const noiseData = (length) => { let seed = 4321; return Int8Array.from({ length }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >> 8) & 0xff) - 128; }); };

/** The note that the imported score plays when the sample is triggered once at `period`. */
function importedPitch(sample, period) {
  const mod = buildMod({ samples: [{ name: "tone", volume: 64, ...sample }], patterns: [[[{ period, sample: 1 }]]] });
  return exportEvents(parseSidwave(importMod(mod).yaml)).voices[0].notes[0].pitch;
}

/**
 * The imported note against the pitch of the Amiga: 7093789.2 / (2 x period) sample points per second, one cycle every
 * `cycle` points. The note must be within half a semitone, plus the 17.6 cents by which period 428 on a 64-point cycle
 * (129.5 Hz) is below equal temperament.
 */
function assertPitch(sample, period, cycle, label) {
  const expected = 7093789.2 / (2 * period) / cycle;
  const midi = importedPitch(sample, period);
  const actual = 440 * 2 ** ((midi - 69) / 12);
  const cents = 1200 * Math.log2(actual / expected);
  assert.ok(Math.abs(cents) <= 68, `${label}, period ${period}: MIDI ${midi} is ${actual.toFixed(2)} Hz, the MOD plays ${expected.toFixed(2)} Hz (${cents.toFixed(0)} cents)`);
}

test("pitch of a looped sample: one cycle per loop, 4 to 600 points", () => {
  // The period keeps the note inside the range of SIDWave, so no note is moved by octaves.
  for (const [length, period] of [[4, 856], [6, 856], [8, 856], [10, 428], [12, 428], [16, 428], [24, 428], [32, 428], [36, 428], [48, 428], [50, 428], [64, 428],
    [96, 428], [100, 428], [128, 428], [200, 214], [256, 214], [342, 214], [400, 214], [512, 214], [600, 214]]) {
    for (const kind of length < 8 ? ["square"] : ["sine", "square", "saw"]) {
      assertPitch({ data: loopOf(kind, length), loop: [0, length] }, period, length, `${kind} loop of ${length}`);
    }
  }
});

test("pitch of a looped sample: several cycles per loop, up to 4096 points", () => {
  for (const [length, cycles] of [[64, 2], [64, 4], [96, 3], [100, 4], [64, 6], [1000, 8], [1024, 1024 / 256], [2048, 32], [3000, 30], [4096, 64], [4096, 128], [4096, 41], [4096, 100], [4094, 23], [3640, 7]]) {
    for (const kind of ["sine", "saw"]) assertPitch({ data: loopOf(kind, length, cycles), loop: [0, length] }, 428, length / cycles, `${kind}, ${cycles} cycles in ${length}`);
  }
});

test("pitch of a looped sample follows the loop, not the part before it", () => {
  for (const [attack, loop, cycles] of [
    [loopOf("saw", 2048, 2048 / 100), loopOf("sine", 32), 1], [loopOf("square", 3000, 100), loopOf("saw", 48), 1],
    [noiseData(1500), loopOf("square", 24), 1], [loopOf("sine", 640, 10), loopOf("sine", 1000, 10), 10],
  ]) {
    const data = new Int8Array(attack.length + loop.length);
    data.set(attack); data.set(loop, attack.length);
    assertPitch({ data, loop: [attack.length, loop.length] }, 428, loop.length / cycles, `loop of ${loop.length} after ${attack.length}`);
  }
});

test("pitch is that of a 64-point cycle without a loop or a measurable pitch", () => {
  // A loop length of 2 bytes means no loop.
  for (const [label, sample] of [
    ["one-shot", { data: loopOf("sine", 2048, 64) }], ["loop of 2", { data: loopOf("sine", 64, 2), loop: [0, 2] }],
    ["silent loop", { data: new Int8Array(64), loop: [0, 64] }], ["noise loop of 64", { data: noiseData(64), loop: [0, 64] }],
    ["noise loop of 1024", { data: noiseData(1024), loop: [0, 1024] }], ["one cycle of 4096", { data: loopOf("sine", 4096), loop: [0, 4096] }],
  ]) assert.equal(importedPitch(sample, 428), 48, label);
  assert.equal(measureLoopCycle(loopOf("sine", 2)), 0);
  assert.equal(measureLoopCycle(loopOf("sine", 4096, 64)), 64);
});

/** The autocorrelation written out directly: all three sums inside the lag loop. */
function referenceAutocorrelation(x, maxLag) {
  const r = new Array(maxLag + 1).fill(0);
  for (let lag = 2; lag <= maxLag; lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < x.length; i++) { num += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
    r[lag] = e1 > 0 && e2 > 0 ? num / Math.sqrt(e1 * e2) : 0;
  }
  return r;
}

test("sample analysis: the prefix-sum autocorrelation equals the direct computation", () => {
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >> 8) & 0xff) - 128; };
  const signals = {
    noise: Float64Array.from({ length: 2048 }, () => rnd() + 0.3),
    sine: Float64Array.from({ length: 2048 }, (_, i) => 100 * Math.sin(i / 5)),
    silentTail: Float64Array.from({ length: 1500 }, (_, i) => (i < 400 ? rnd() : 0)),
    silentHead: Float64Array.from({ length: 1500 }, (_, i) => (i < 1100 ? 0 : rnd())),
    quietTail: Float64Array.from({ length: 2048 }, (_, i) => (i < 1000 ? 127 * rnd() : rnd() / 4096)),
    silence: new Float64Array(300),
    short: Float64Array.from({ length: 64 }, () => rnd()),
  };
  for (const [name, x] of Object.entries(signals)) {
    const maxLag = Math.min(600, Math.floor(x.length / 3));
    const got = normalisedAutocorrelation(x, maxLag), want = referenceAutocorrelation(x, maxLag);
    assert.equal(got.length, want.length, name);
    for (let lag = 0; lag <= maxLag; lag++) assert.ok(Math.abs(got[lag] - want[lag]) < 1e-9, `${name} lag ${lag}: ${got[lag]} against ${want[lag]}`);
  }
});

test("sample analysis: cached by content, each caller gets its own copy", () => {
  const song = parseMod(buildMod({ samples: [{ ...SAMPLES.saw, name: "cached", data: SAMPLES.saw.data.map((v, i) => v + (i % 3)), loop: [0, 64] }], patterns: [[]] }));
  const sample = song.samples[0];
  const first = analyzeSample(sample);
  const copy = structuredClone(first);
  first.adsr[0] = 15; first.harmonics.length = 0; first.waveform = "noise";
  assert.deepEqual(analyzeSample(sample), copy);
  // A change of the data, the loop or the name is a different sample.
  const other = Int8Array.from(sample.data, (_, i) => ((i * 7919) % 251) - 125);
  assert.notDeepEqual(analyzeSample({ ...sample, data: other }), copy);
  assert.equal(analyzeSample({ ...sample, looped: false }).adsr[2], 0);
  assert.equal(analyzeSample({ ...sample, name: "snare" }).drum, 38);
  // 3000 repeats of a 32 KB one-shot sample cost a hash and a copy each; measuring it every time takes seconds.
  const large = { ...sample, name: "large", looped: false, length: 32768, data: Int8Array.from({ length: 32768 }, (_, i) => ((i * 31) % 200) - 100) };
  analyzeSample(large);
  const repeats = cpuMs(() => { for (let i = 0; i < 3000; i++) analyzeSample(large); });
  assert.ok(repeats.ms < 1500, `${repeats.ms} ms`);
});

test("timing: a speed and tempo change inside a bar reports the measured largest onset error", () => {
  const rows = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  rows[0][0] = { note: 48, sample: 1, fx: 0xf, param: 0x03 };
  rows[8][0] = { note: 50, sample: 1, fx: 0xf, param: 0x40 };
  const r = importMod(buildMod({ samples: [SAMPLES.sine], patterns: [rows] }));
  const real = [...Array(8).fill(3 * 2.5 / 125), ...Array(56).fill(3 * 2.5 / 64)];
  // Four rows per beat would clamp the first bar (250 BPM); eight is the first value without a clamped bar.
  assert.equal(r.report.timing.rowsPerBeat, 8);
  assert.equal(r.report.timing.clampedBars, 0);
  assert.equal(r.report.timing.mistimedRows, 32);
  // The first bar holds 32 rows; every other bar has rows of one length.
  const mean = real.slice(0, 32).reduce((t, v) => t + v, 0) / 32;
  let start = 0, largest = 0;
  for (let i = 0; i < 32; i++) { largest = Math.max(largest, Math.abs(start - i * mean)); start += real[i]; }
  assert.equal(Math.round(largest * 1000), 343);
  const loss = r.report.losses.find((l) => /different length/.test(l));
  assert.match(loss, /largest onset error is 343 ms/);
  assert.doesNotMatch(loss, /up to one row/);
  // The imported score moves the note of row 8 from 0.48 s by that error, within the frame rounding of SIDWave.
  const onset = exportEvents(parseSidwave(r.yaml)).voices[0].notes[1].on.time;
  assert.ok(Math.abs(onset - (0.48 + largest)) < 0.02, `onset ${onset} s`);
});

test("timing: among row grids with equally few clamped bars the one with fewer mistimed rows wins", () => {
  // Four rows of 0.16 s, then rows of 0.24 s: only 2 rows per beat can end a bar at the change without a clamped bar.
  const rowSeconds = [...Array(4).fill(0.16), ...Array(60).fill(0.24)];
  assert.equal(planBars(rowSeconds, 4).mistimed, 16);
  assert.equal(planBars(rowSeconds, 2).mistimed, 0);
  assert.equal(chooseRowsPerBeat(rowSeconds), 2);
  // A grid with more bars than a score holds loses against one that fits, even when it has fewer mistimed rows.
  const long = [...Array(4).fill(0.16), ...Array(20_000).fill(0.24)];
  assert.ok(planBars(long, 2).bars.length > 2048);
  assert.equal(chooseRowsPerBeat(long), 4);
  // Choosing the grid stays fast for the longest sequence the importer accepts.
  const uniform = Array(100_000).fill(0.12);
  const run = cpuMs(() => chooseRowsPerBeat(uniform));
  // 100,000 rows fit into 2048 bars only with 16 rows per beat.
  assert.equal(run.value, 16);
  assert.ok(run.ms < 500, `${run.ms} ms`);
});

test("playback model: pattern break, jump loop, pattern loop, pattern delay, speed and tempo", () => {
  const rows = (fn) => { const r = Array.from({ length: 64 }, () => [{}, {}, {}, {}]); fn(r); return r; };
  // Order 0 plays pattern 0 with a D00 at row 3 (4 rows), order 1 plays pattern 1 with E60 at row 0, E62 at row 3 (rows 0 to 3 three times), EE1 at row 4, F03 at row 5, then B00 at row 7.
  const p0 = rows((r) => { r[3][0] = { fx: 0xd, param: 0 }; });
  const p1 = rows((r) => { r[0][1] = { fx: 0xe, param: 0x60 }; r[3][1] = { fx: 0xe, param: 0x62 }; r[4][0] = { fx: 0xe, param: 0xe1 }; r[5][0] = { fx: 0xf, param: 3 }; r[7][2] = { fx: 0xb, param: 0 }; });
  const song = parseMod(buildMod({ samples: [SAMPLES.sine], orders: [0, 1], patterns: [p0, p1] }));
  const seq = playRows(song, 1000);
  // 4 rows, then rows 0-3 x3 (12), rows 4-7 (4): 20 rows.
  assert.equal(seq.rows.length, 20);
  assert.equal(seq.end, "loop");
  assert.equal(seq.loopTo, 0);
  assert.equal(seq.patternLoops, 2);
  assert.equal(seq.patternDelays, 1);
  assert.equal(seq.jumps, 2);
  const delayed = seq.rows.find((r) => r.delay === 1);
  assert.equal(delayed.seconds, 2 * 6 * 2.5 / 125);
  const fast = seq.rows[seq.rows.length - 1];
  assert.equal(fast.speed, 3);
  assert.ok(Math.abs(fast.seconds - 3 * 2.5 / 125) < 1e-12);
  assert.ok(Math.abs(seq.seconds - seq.rows.reduce((t, r) => t + r.seconds, 0)) < 1e-9);
  // BPM tempo: F7D = 125 is the default, F96 = 150 BPM makes a tick 2.5 / 150 seconds.
  const q = rows((r) => { r[0][0] = { fx: 0xf, param: 150 }; r[1][0] = { fx: 0xf, param: 0 }; });
  const stop = playRows(parseMod(buildMod({ samples: [SAMPLES.sine], patterns: [q] })), 100);
  assert.equal(stop.end, "stop");
  assert.equal(stop.rows.length, 2);
  assert.ok(Math.abs(stop.rows[0].seconds - 6 * 2.5 / 150) < 1e-12);
});

test("playback model: a position that repeats ends the song, runaway songs are bounded", () => {
  const r = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  r[0][0] = { fx: 0xb, param: 0 };
  const loop0 = playRows(parseMod(buildMod({ samples: [SAMPLES.sine], patterns: [r] })), 100000);
  assert.equal(loop0.rows.length, 1);
  assert.equal(loop0.end, "loop");
  const p = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  p[0][0] = { fx: 0xe, param: 0x60 };
  p[1][0] = { fx: 0xe, param: 0x6f };
  const song = parseMod(buildMod({ samples: [SAMPLES.sine], patterns: [p] }));
  assert.ok(playRows(song, 100000).rows.length < 100);
  assert.throws(() => playRows(parseMod(songLarge(10)), 50), /more than 50 rows/);
});

test("four-channel song: three voices of four, dropped channel reported, exact timing, quality", () => {
  const r = importMod(songFourChannel(), { quality: true });
  const doc = parseSidwave(r.yaml);
  assert.equal(doc.voices.length, 3);
  assert.equal(r.report.variant, "M.K.");
  assert.equal(r.report.timing.rowsPerBeat, 4);
  assert.equal(doc.song.tempo, 125);
  assert.deepEqual(r.report.voices.map((v) => v.kind), ["melodic", "melodic", "drums"]);
  assert.deepEqual(Object.keys(r.report.droppedNotes), ["3"]);
  assert.equal(r.report.droppedNotes["3"], 32);
  assert.ok(r.report.losses.some((l) => /Channels 3 are not imported/.test(l)));
  assert.equal(r.report.voicePolicy.ranking.filter((u) => u.kept).length, 3);
  const q = r.report.quality;
  assert.ok(q.f1 >= 0.99, `F1 ${q.f1}`);
  assert.ok(q.onsetErrorMs.mean < 15, `onset error ${q.onsetErrorMs.mean} ms`);
  assert.ok(q.durationOverlap >= 0.95, `overlap ${q.durationOverlap}`);
  assert.ok(q.recallAllChannels < q.recall);
  assert.equal(q.reference, 160);
  console.log(`four-channel: F1 ${q.f1}, onset ${q.onsetErrorMs.mean} ms (p95 ${q.onsetErrorMs.p95}), duration overlap ${q.durationOverlap}, recall over all channels ${q.recallAllChannels}`);
  // Waveforms come from the samples: bass saw, lead triangle.
  assert.equal(doc.instruments.s01_saw_bass.waveform, "sawtooth");
  assert.equal(doc.instruments.s02_sine_lead.waveform, "triangle");
  // The drum voice uses the SIDWave kit.
  assert.match(r.yaml, /lib:kick/);
  assert.match(r.yaml, /lib:snare/);
});

test("--sids: all four channels on two SIDs, eight channels on three", () => {
  const two = importMod(songFourChannel(), { sids: 2, quality: true });
  const doc = parseSidwave(two.yaml);
  assert.equal(doc.voices.length, 4);
  assert.deepEqual(doc.sids.map((s) => s.address), [0xd400, 0xd420]);
  assert.deepEqual(two.report.droppedNotes, {});
  assert.ok(two.report.quality.f1 >= 0.99);
  assert.deepEqual(two.report.voices.map((v) => v.sid), [1, 1, 1, 2]);
  const eight = importMod(songVariant("8CHN", 8), { sids: 3 });
  assert.equal(parseSidwave(eight.yaml).voices.length, 8);
  assert.deepEqual(parseSidwave(eight.yaml).sids.map((s) => s.address), [0xd400, 0xd420, 0xd440]);
  const six = importMod(songVariant("6CHN", 6));
  assert.equal(parseSidwave(six.yaml).voices.length, 3);
  assert.equal(Object.keys(six.report.droppedNotes).length, 3);
  assert.throws(() => importMod(songFourChannel(), { sids: 0 }), RangeError);
  assert.throws(() => importMod(songFourChannel(), { sids: 11 }), RangeError);
});

test("voice reduction is deterministic and keeps the busiest channels and the drums", () => {
  const a = importMod(songVariant("6CHN", 6));
  const b = importMod(songVariant("6CHN", 6));
  assert.equal(a.yaml, b.yaml);
  // Channel 1 has fewer notes than channel 2 once two notes are removed; the rest tie, so the lowest channel numbers win.
  const rows = Array.from({ length: 64 }, () => Array.from({ length: 6 }, () => ({})));
  for (let c = 0; c < 6; c++) for (let r = 0; r < 64; r += 8 + c * 4) rows[r][c] = { note: 40 + c, sample: 1 };
  const song = importMod(buildMod({ variant: "6CHN", channels: 6, samples: [SAMPLES.sine], patterns: [rows] }));
  assert.deepEqual(song.report.channelStats.filter((c) => c.kept).map((c) => c.channel), [1, 2, 3]);
  assert.deepEqual(Object.keys(song.report.droppedNotes), ["4", "5", "6"]);
});

test("effects: arpeggio, slides, tone portamento, vibrato, volume, cut, delay, tempo, loop", () => {
  const r = importMod(songEffects(), { quality: true });
  const text = r.yaml;
  assert.match(text, /wavetable:/, "arpeggio wavetable");
  assert.match(text, /s01_sine_lead_a47_1/);
  assert.match(text, /bend: \{to: 5, frames: 20\}/, "slide up");
  assert.match(text, /bend: \{to: -4, frames: 20\}/, "slide down");
  assert.match(text, /legato: true, portamento: 9/, "tone portamento (16 per tick from 56 to 55 semitones... 9 frames)");
  assert.match(text, /vibrato: \{depth: 0\.5, rate: 3/, "vibrato");
  assert.match(text, /level: 8/, "volume slide and set volume");
  assert.match(text, /gate_off: 4/, "note cut after two ticks");
  assert.match(text, /tempo: 187\.5/, "speed 4 at 125 BPM");
  assert.match(text, /meter: 2\/4/, "tempo change in the middle of a pattern splits a bar");
  assert.equal(r.report.loop.end, "loop");
  assert.equal(r.report.loop.toRow, 0);
  const e = r.report.effects;
  for (const name of ["0xy arpeggio", "1xx portamento up", "2xx portamento down", "3xx tone portamento", "4xy vibrato", "Axy volume slide", "Cxx set volume", "ECx note cut", "Fxx speed or tempo", "Bxx position jump"]) {
    assert.equal(e[name].mapped, e[name].uses, name);
  }
  for (const name of ["7xy tremolo", "8xx set panning", "9xx sample offset", "E4x vibrato waveform", "E5x set finetune", "E9x retrigger note", "EFx invert loop"]) {
    assert.equal(e[name].mapped, 0, name);
    assert.ok(r.report.losses.some((l) => l.includes(name) && /not imported/.test(l)), `${name} reported`);
  }
  assert.equal(r.report.timing.mistimedRows, 0);
  assert.equal(r.report.timing.alignedChanges, 1);
  assert.ok(r.report.quality.f1 >= 0.9, `F1 ${r.report.quality.f1}`);
  assert.ok(r.report.quality.durationOverlap >= 0.9);
  console.log(`effects: F1 ${r.report.quality.f1}, onset ${r.report.quality.onsetErrorMs.mean} ms, duration overlap ${r.report.quality.durationOverlap}`);
});

test("timing: speed and BPM become the SIDWave tempo exactly", () => {
  const make = (speed, bpm) => {
    const rows = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
    rows[0][0] = { note: 48, sample: 1, fx: 0xf, param: speed };
    rows[0][1] = { fx: 0xf, param: bpm };
    rows[8][0] = { note: 50, sample: 1 };
    return importMod(buildMod({ samples: [SAMPLES.sine], patterns: [rows] }));
  };
  // Row length = speed x 2.5 / BPM seconds; a bar of 16 rows is 4 beats.
  for (const [speed, bpm] of [[6, 125], [5, 150], [3, 125], [8, 100], [4, 100], [6, 64]]) {
    const r = make(speed, bpm);
    const rowSeconds = speed * 2.5 / bpm;
    const rpb = r.report.timing.rowsPerBeat;
    const expected = Math.round(60 / (rpb * rowSeconds) * 10000) / 10000;
    assert.equal(parseSidwave(r.yaml).song.tempo, expected, `speed ${speed} at ${bpm} BPM`);
    assert.ok(expected >= 30 && expected <= 220);
  }
  // Speed 6 at 125 BPM is 125 with four rows to the beat; speed 3 needs eight rows to stay inside 30..220.
  assert.equal(make(3, 125).report.timing.rowsPerBeat, 8);
  // A song with rows of 1.25 frames (speed 2 at 200 BPM) still imports: the instruments use the plain gate restart.
  const fast = make(2, 200);
  assert.ok(Object.values(parseSidwave(fast.yaml).instruments).every((i) => i.hard_restart?.frames === 0 || i.hardRestart?.frames === 0 || JSON.stringify(i).includes("hard")), JSON.stringify(parseSidwave(fast.yaml).instruments));
});

test("variants: 15-sample and FLT8 import end to end", () => {
  const fifteen = importMod(songVariant(null, 4), { sids: 2 });
  assert.equal(fifteen.report.variant, "15-sample");
  assert.equal(parseSidwave(fifteen.yaml).voices.length, 4);
  const flt8 = importMod(songVariant("FLT8", 8), { sids: 3 });
  assert.equal(flt8.report.channels, 8);
  assert.equal(parseSidwave(flt8.yaml).voices.length, 8);
});

test("many samples and many vibrato variants stay within the 63 instruments of SIDWave", () => {
  const r = importMod(songLarge(8), { quality: true });
  assert.ok(r.report.quality.f1 >= 0.95, `F1 ${r.report.quality.f1}`);
  parseSidwave(r.yaml);
});

test("CLI: detection by signature, flags, report and typed failure", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "four.mod"), songFourChannel());
  fs.writeFileSync(path.join(dir, "noext"), songFourChannel());
  fs.writeFileSync(path.join(dir, "bad.mod"), new Uint8Array(100));
  let r = await cli(["import", "four.mod", "-o", "a.yaml", "--json", "--quality"], dir);
  assert.equal(r.code, 0, r.err);
  const env = JSON.parse(r.out);
  assert.equal(env.result.format, "mod");
  assert.ok(env.result.report.quality.f1 >= 0.99);
  assert.ok(fs.existsSync(path.join(dir, "a.yaml")));
  r = await cli(["import", "noext", "-o", "b.yaml", "--sids", "2", "--transpose", "12"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(path.join(dir, "b.yaml"), "utf8"), /D420/i);
  assert.match(fs.readFileSync(path.join(dir, "b.yaml"), "utf8"), /C4/);
  r = await cli(["import", "four.mod", "-o", "a.yaml"], dir);
  assert.equal(r.code, 2);
  r = await cli(["import", "bad.mod", "--json"], dir);
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).error.category, "input");
  r = await cli(["import", "four.mod", "--sids", "x"], dir);
  assert.notEqual(r.code, 0);
  r = await cli(["import", "four.mod", "-o", "c.yaml", "--sids", "11"], dir);
  assert.equal(r.code, 2);
});

test("detection: a 15-sample module is found by its content only under the .mod extension", async () => {
  const dir = tmpdir();
  const fifteen = songVariant(null, 4);
  for (const name of ["fifteen.mod", "FIFTEEN.MOD"]) assert.equal(detectFormat(fifteen, name).best?.id, "mod", name);
  // Under any other name the module adds no candidate, so the detection of other formats is unaffected.
  for (const name of [undefined, "x", "x.sng", "x.bin", "x.prg"]) assert.ok(!detectFormat(fifteen, name).candidates.some((c) => c.id === "mod"), String(name));
  fs.writeFileSync(path.join(dir, "fifteen.mod"), fifteen);
  let r = await cli(["convert", "fifteen.mod", "out.yaml", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).result.from, "mod");
  r = await cli(["info", "fifteen.mod", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /15-sample/);
});

test("detection: random and truncated .mod files give a typed input error", async () => {
  const dir = tmpdir();
  let seed = 5;
  const random = (n) => Uint8Array.from({ length: n }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) & 0xff; });
  const fifteen = songVariant(null, 4);
  const files = [new Uint8Array(0), new Uint8Array(3), random(100), random(599), random(600), random(1083), random(1084), random(5000), random(70_000), new Uint8Array(5000),
    fifteen.subarray(0, 100), fifteen.subarray(0, 599), fifteen.subarray(0, 600), fifteen.subarray(0, 1623), songFourChannel().subarray(0, 1000)];
  for (const [i, bytes] of files.entries()) {
    const name = `bad${i}.mod`;
    await assert.rejects(convert(bytes, { inputName: name, to: "sidwave" }), InterchangeUsageError, name);
    fs.writeFileSync(path.join(dir, name), bytes);
    const r = await cli(["convert", name, "out.yaml", "--json"], dir);
    assert.equal(r.code, 3, `${name}: ${r.out}${r.err}`);
    assert.equal(JSON.parse(r.out).error.category, "input", name);
  }
});

test("convert --sids: keeps three voices per SID for MOD input and is a usage error otherwise", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "four.mod"), songFourChannel());
  fs.writeFileSync(path.join(dir, "fifteen.mod"), songVariant(null, 4));
  const voices = (file) => parseSidwave(fs.readFileSync(path.join(dir, file), "utf8")).voices.length;
  let r = await cli(["convert", "four.mod", "one.yaml"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(voices("one.yaml"), 3);
  for (const [i, args] of [["four.mod"], ["fifteen.mod"], ["four.mod", "--from", "protracker"]].entries()) {
    r = await cli(["convert", ...args, `two${i}.yaml`, "--sids", "2"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(voices(`two${i}.yaml`), 4, args.join(" "));
  }
  fs.copyFileSync(path.join(dir, "one.yaml"), path.join(dir, "score.yaml"));
  fs.writeFileSync(path.join(dir, "tune.sid"), (await convert(fs.readFileSync(path.join(dir, "one.yaml")), { inputName: "one.yaml", to: "sid" })).output);
  for (const args of [["score.yaml", "x.mid"], ["tune.sid", "x.mid"], ["tune.sid", "x.mid", "--dry-run"], ["score.yaml", "x.mid", "--from", "sidwave"]]) {
    r = await cli(["convert", ...args, "--sids", "2", "--json"], dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.equal(JSON.parse(r.out).error.category, "usage");
    assert.match(r.out, /--sids is supported only for MOD input/);
  }
  for (const value of ["0", "11", "x"]) assert.equal((await cli(["convert", "four.mod", "y.yaml", "--sids", value], dir)).code, 2, value);
  await assert.rejects(convert(songFourChannel(), { inputName: "four.mod", to: "sidwave", sids: 11 }), UsageError);
  assert.match((await cli(["convert", "--help"], dir)).out, /--sids <n>/);
});

test("import speed: a 230 KB module with 6400 rows imports within the CPU budget", () => {
  const big = songLarge(100);
  assert.ok(big.length > 200_000);
  // New sample names, so that earlier tests have not filled the analysis cache for these samples.
  for (let s = 0; s < 31; s++) big[20 + s * 30] = "t".charCodeAt(0);
  const noValidate = cpuMs(() => importMod(big, { validate: false }));
  const typical = cpuMs(() => importMod(songLarge(30), { validate: false }));
  const small = cpuMs(() => importMod(songFourChannel()));
  console.log(`MOD import CPU: 230 KB / 6400 rows without validation ${noValidate.ms.toFixed(0)} ms; 100 KB / 1920 rows ${typical.ms.toFixed(0)} ms; four-channel song with validation ${small.ms.toFixed(0)} ms`);
  assert.ok(noValidate.ms < 1200, `${noValidate.ms} ms`);
  assert.ok(typical.ms < 1000, `${typical.ms} ms`);
  assert.ok(small.ms < 1500, `${small.ms} ms`);
});
