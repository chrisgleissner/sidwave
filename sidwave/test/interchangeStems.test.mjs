import test from "#test/runner";
import assert from "#test/assert";
import wavefile from "wavefile";
const { WaveFile } = wavefile;
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { writeWav } from "../src/interchange/wav.js";
import { detectCoupling, keepVoices, renderStems, STEM_ENERGY_TOLERANCE } from "../src/interchange/stems.js";
import { runCli } from "../src/cli.js";
import { arrangeSidwave } from "../src/sidwaveCompiler.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const PLAIN = {
  sidwave: 1.3, tempo: 125,
  instruments: { p: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, b: { waveform: "sawtooth", adsr: [0, 5, 9, 3] }, t: { waveform: "triangle", adsr: [0, 4, 9, 3] } },
  voices: [
    { id: 1, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } },
    { id: 2, instrument: "b", patterns: { r: { length: 2, bars: 1, groove: "C2 G2" } } },
    { id: 3, instrument: "t", patterns: { m: { length: 0.5, bars: 1, groove: "G3 B3 D4 B3 G3 B3 D4 B3" } } },
  ],
  timeline: [{ section: "x", bars: 4, layers: { v1: "a", v2: "r", v3: "m" } }],
};
const parse = (obj) => parseSidwave(yaml.stringify(obj));
const energy = (a) => { let s = 0; for (const x of a) s += x * x; return s / a.length; };

test("WAV writer output is read correctly by an independent parser", () => {
  const samples = Int16Array.from({ length: 2000 }, (_, i) => Math.round(Math.sin(i / 7) * 20000));
  const wav = new WaveFile(Buffer.from(writeWav(samples, 44100)));
  assert.equal(wav.container, "RIFF");
  assert.equal(wav.fmt.numChannels, 1);
  assert.equal(wav.fmt.sampleRate, 44100);
  assert.equal(wav.fmt.bitsPerSample, 16);
  assert.equal(wav.fmt.audioFormat, 1);
  assert.deepEqual(Array.from(wav.getSamples(false, Int16Array)), Array.from(samples));
  const stereo = new WaveFile(Buffer.from(writeWav(Int16Array.from([1, 2, 3, 4]), 22050, 2)));
  assert.equal(stereo.fmt.numChannels, 2);
  assert.equal(stereo.fmt.blockAlign, 4);
  assert.throws(() => writeWav(samples, 0), RangeError);
});

test("keepVoices silences the other voices and leaves the score otherwise unchanged", () => {
  const doc = parse(PLAIN);
  const only = keepVoices(doc, new Set([2]));
  const counts = arrangeSidwave(only).voices.map((v) => v.notes.length);
  assert.deepEqual(counts, [0, 4 * 2, 0]);
  assert.equal(doc.timeline[0].layers.v1, "a", "the original is not mutated");
});

test("stems of a score without coupling add up to the mix in energy", async () => {
  const doc = parse(PLAIN);
  const result = await renderStems(doc, { seconds: 4, emulation: "sidlite" });
  assert.equal(result.additive, true);
  assert.deepEqual(result.coupling, []);
  assert.equal(result.stems.length, 3);
  assert.deepEqual(result.stems.map((s) => s.voices), [[1], [2], [3]]);
  for (const stem of result.stems) {
    assert.equal(stem.samples.length, result.mix.length);
    assert.ok(energy(stem.samples) > 1000, "every stem sounds");
  }
  assert.ok(Math.abs(result.sumError.energyRatio - 1) <= STEM_ENERGY_TOLERANCE, `energy ratio ${result.sumError.energyRatio}`);
  assert.equal(result.energyWithinTolerance, true);
  // Each stem differs from the others: the muting really isolates voices.
  assert.notEqual(result.stems[0].samples[10000], result.stems[1].samples[10000]);
});

test("filter, ring modulation and sync make the stems non-additive", async () => {
  const coupled = parse({
    ...PLAIN,
    sids: [{ id: "sid1", address: "$D400", model: "8580", volume: 15, filter: { owner: "v1", route: [1, 2] } }],
    instruments: { ...PLAIN.instruments, p: { ...PLAIN.instruments.p, filtertable: [{ cutoff: "1kHz", resonance: 6, type: "lowpass" }] } },
  });
  const kinds = detectCoupling(coupled).map((c) => c.kind);
  assert.ok(kinds.includes("filter"));
  const ring = parse({ ...PLAIN, instruments: { ...PLAIN.instruments, t: { waveform: "triangle", adsr: [0, 4, 9, 3], ring: true } } });
  assert.ok(detectCoupling(ring).some((c) => c.kind === "ring"));
  const sync = parse({ ...PLAIN, instruments: { ...PLAIN.instruments, b: { waveform: "sawtooth", adsr: [0, 5, 9, 3], sync: true } } });
  assert.ok(detectCoupling(sync).some((c) => c.kind === "sync"));
  assert.deepEqual(detectCoupling(parse(PLAIN)), []);
  const result = await renderStems(ring, { seconds: 2, emulation: "sidlite" });
  assert.equal(result.additive, false);
  assert.ok(result.coupling.some((c) => c.kind === "ring"));
});

test("a voice that copies another voice is rendered together with its source", async () => {
  const doc = parse({
    ...PLAIN,
    voices: [...PLAIN.voices.slice(0, 2), { id: 3, echo: { voice: 1, delay: 4, volume: 0.5 } }],
    timeline: [{ section: "x", bars: 4, layers: { v1: "a", v2: "r" } }],
  });
  const result = await renderStems(doc, { seconds: 2, emulation: "sidlite" });
  assert.deepEqual(result.stems.map((s) => s.voices), [[1], [2], [1, 3]]);
  assert.equal(result.additive, false);
  assert.ok(result.coupling.some((c) => c.kind === "copy"));
});

test("scores with digi samples or several SIDs beyond PSID are refused", async () => {
  const many = parse({ ...PLAIN, sids: { layout: "ultisid8" }, voices: [...PLAIN.voices, ...[4, 5, 6, 7].map((id) => ({ id, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } }))] });
  await assert.rejects(() => renderStems(many, { seconds: 1, emulation: "sidlite" }), /at most 3 SIDs|PSID/);
});

test("sidwave render --stems writes mix, stems and a manifest; refuses to overwrite", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-stems-")));
  try {
    fs.writeFileSync(path.join(dir, "plain.yaml"), yaml.stringify(PLAIN));
    const run = async (...args) => {
      const out = [], err = [];
      const code = await runCli(["render", ...args], { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    const ok = await run("plain.yaml", "--stems", "-o", "out", "--seconds", "2", "--engine", "sidlite");
    assert.equal(ok.code, 0, ok.err);
    const names = fs.readdirSync(path.join(dir, "out")).sort();
    assert.deepEqual(names, ["plain.mix.wav", "plain.stems.json", "plain.v1.wav", "plain.v2.wav", "plain.v3.wav"]);
    const wav = new WaveFile(fs.readFileSync(path.join(dir, "out", "plain.v2.wav")));
    assert.equal(wav.fmt.sampleRate, 48000);
    assert.equal(wav.getSamples(false, Int16Array).length, 96000);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "out", "plain.stems.json"), "utf8"));
    assert.equal(manifest.additive, true);
    assert.equal(manifest.energyWithinTolerance, true);
    assert.equal(typeof manifest.energyRatio, "number");
    assert.match(manifest.note, new RegExp(manifest.energyRatio.toFixed(3)));
    assert.equal(manifest.files.length, 5 - 1);
    assert.equal((await run("plain.yaml", "--stems", "-o", "out", "--seconds", "2", "--engine", "sidlite")).code, 2);
    // A refusal because one target exists writes nothing at all.
    fs.mkdirSync(path.join(dir, "partial"));
    fs.writeFileSync(path.join(dir, "partial", "plain.v3.wav"), "x");
    assert.equal((await run("plain.yaml", "--stems", "-o", "partial", "--seconds", "1", "--engine", "sidlite")).code, 2);
    assert.deepEqual(fs.readdirSync(path.join(dir, "partial")), ["plain.v3.wav"]);
    const mix = await run("plain.yaml", "-o", "mix.wav", "--seconds", "1", "--engine", "sidlite");
    assert.equal(mix.code, 0, mix.err);
    assert.equal(new WaveFile(fs.readFileSync(path.join(dir, "mix.wav"))).getSamples(false, Int16Array).length, 48000);
    assert.equal((await run("plain.yaml", "--model", "9999")).code, 2);
    assert.equal((await run("missing.yaml")).code, 3);
    assert.equal((await run("plain.yaml", "--stems", "-o", "-")).code, 2, "-o - is not possible for stems");
    assert.equal((await run("plain.yaml", "--stems", "--sample-rate", "22050", "--seconds", "1", "--emulation", "sidlite", "-o", "alias")).code, 0);
    assert.equal(new WaveFile(fs.readFileSync(path.join(dir, "alias", "plain.mix.wav"))).fmt.sampleRate, 22050);
    assert.equal((await run("plain.yaml", "--stems", "--json", "-o", "alias", "--force", "--seconds", "1", "--engine", "sidlite")).code, 0);
    const many = { ...PLAIN, sids: { layout: "ultisid8" }, voices: [...PLAIN.voices, ...[4, 5, 6, 7].map((id) => ({ id, instrument: "p", patterns: { a: { length: 1, bars: 1, groove: "C4 E4 G4 C5" } } }))] };
    fs.writeFileSync(path.join(dir, "many.yaml"), yaml.stringify(many));
    const refused = await run("many.yaml", "--stems", "--json", "-o", "refused", "--engine", "sidlite", "--seconds", "1");
    assert.equal(refused.code, 5, "a refused score is limit_exceeded");
    assert.equal(JSON.parse(refused.out).error.category, "limit_exceeded");
    fs.writeFileSync(path.join(dir, "bad.yaml"), "sidwave: 1.3\nvoices: nonsense\n");
    assert.equal((await run("bad.yaml")).code, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the funk bass example is reported as non-additive (it uses the filter)", async () => {
  const doc = parseSidwave(readExampleScore("funk_bass"));
  const result = await renderStems(doc, { seconds: 1, emulation: "sidlite" });
  assert.equal(result.additive, false);
  assert.ok(result.coupling.some((c) => c.kind === "filter"));
});
