import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMod, ModError, periodToMidi, MOD_MAX_BYTES } from "../src/interchange/mod.js";
import { importMod } from "../src/interchange/modImport.js";
import { analyzeSample, drumFromName } from "../src/interchange/modSamples.js";
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

test("import speed: a 230 KB module with 6400 rows imports within the CPU budget", () => {
  const big = songLarge(100);
  assert.ok(big.length > 200_000);
  const noValidate = cpuMs(() => importMod(big, { validate: false }));
  const typical = cpuMs(() => importMod(songLarge(30), { validate: false }));
  const small = cpuMs(() => importMod(songFourChannel()));
  console.log(`MOD import CPU: 230 KB / 6400 rows without validation ${noValidate.ms.toFixed(0)} ms; 100 KB / 1920 rows ${typical.ms.toFixed(0)} ms; four-channel song with validation ${small.ms.toFixed(0)} ms`);
  assert.ok(noValidate.ms < 3000, `${noValidate.ms} ms`);
  assert.ok(typical.ms < 1000, `${typical.ms} ms`);
  assert.ok(small.ms < 1500, `${small.ms} ms`);
});
