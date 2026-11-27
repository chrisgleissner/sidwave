import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { convert, detectFormat, listFormats } from "../src/index.ts";
import { ambiguityMessage } from "../src/interchange/convert.ts";
import { classifyLossText, groupLosses } from "../src/interchange/loss.ts";
import { planScore } from "../src/interchange/scorePlan.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { parseSmf } from "../src/interchange/smf.ts";
import { FIXTURE_DIR } from "./helpers/convertMatrix.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fix = (name) => path.join(FIXTURE_DIR, name);
const score = (name) => path.join(fixtures, name);

async function run(args, cwd) {
  const out = [], err = [], bytes = [];
  const code = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)) });
  return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-convert-"));
const copy = (dir, file, name = path.basename(file)) => { fs.copyFileSync(file, path.join(dir, name)); return path.join(dir, name); };

test("convert detects the input by content and takes the target from the output extension", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.sng"));
  const result = await run(["convert", "fuer-elise.sng", "out.mid"], dir);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(dir, "out.mid")).subarray(0, 4).toString("latin1"), "MThd");
  assert.match(result.out, /goattracker \(detected by magic, confidence 1\) -> midi/);
  assert.match(result.out, /chain: read:goattracker > normalise > plan:midi > write:midi/);
});

test("the default output is <stem>.<ext>; an existing file is never overwritten without --force", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.mid"));
  assert.equal((await run(["convert", "fuer-elise.mid", "--to", "goattracker"], dir)).code, 0);
  assert.ok(fs.existsSync(path.join(dir, "fuer-elise.sng")));
  fs.writeFileSync(path.join(dir, "fuer-elise.sng"), "keep");
  const refused = await run(["convert", "fuer-elise.mid", "--to", "goattracker"], dir);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /exists; use --force/);
  assert.equal(fs.readFileSync(path.join(dir, "fuer-elise.sng"), "utf8"), "keep");
  assert.equal((await run(["convert", "fuer-elise.mid", "--to", "goattracker", "--force"], dir)).code, 0);
  assert.notEqual(fs.readFileSync(path.join(dir, "fuer-elise.sng"), "utf8"), "keep");
  const same = await run(["convert", "fuer-elise.mid", "fuer-elise.mid", "--force"], dir);
  assert.equal(same.code, 2);
  assert.match(same.err, /output file is the input file/);
});

test("--json prints the envelope with chain, detection, losses, defaults and timings", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.sng"));
  const result = await run(["convert", "fuer-elise.sng", "out.musicxml", "--json", "--verify"], dir);
  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "convert");
  const r = parsed.result;
  assert.deepEqual(r.chain, ["read:goattracker", "normalise", "plan:musicxml", "write:musicxml", "verify:musicxml"]);
  assert.equal(r.detected.format, "goattracker");
  assert.ok(r.losses.every((l) => ["info", "approx", "lost"].includes(l.severity) && typeof l.code === "string" && typeof l.count === "number"));
  assert.ok(r.metrics.noteF1 >= 0.99);
  assert.equal(r.outputs[0].format, "musicxml");
  assert.equal(r.defaults.song, 1);
  assert.equal(typeof r.timings.overheadMs, "number");
});

test("an input that cannot be classified exits 3 with the candidates and the exact --from fix", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "mystery.bin"), Buffer.from("hello, this is not music"));
  const result = await run(["convert", "mystery.bin", "out.mid"], dir);
  assert.equal(result.code, 3);
  assert.match(result.err, /cannot tell the format of mystery\.bin/);
  assert.match(result.err, /--from <format>|--from /);
  // The extension alone is a weak hint: the candidate is listed with its fix.
  fs.writeFileSync(path.join(dir, "tune.prg"), Buffer.from([1, 8, 0, 0]));
  const prg = await run(["convert", "tune.prg", "out.mid"], dir);
  assert.equal(prg.code, 3);
  assert.match(prg.err, /Pass --from prg to read it as prg anyway/);
  assert.doesNotMatch(prg.err, /with confidence/);
  fs.writeFileSync(path.join(dir, "empty.mid"), Buffer.alloc(0));
  const empty = await run(["convert", "empty.mid", "out.mid"], dir);
  assert.equal(empty.code, 3);
  assert.match(empty.err, /empty\.mid is empty for midi/);
  fs.writeFileSync(path.join(dir, "short.mid"), Buffer.from("MT"));
  assert.match((await run(["convert", "short.mid", "out.mid"], dir)).err, /too short \(2 bytes\) for midi/);
  // --from skips detection; the importer then reports what is wrong with the content.
  const forced = await run(["convert", "mystery.bin", "out.mid", "--from", "midi"], dir);
  assert.equal(forced.code, 3);
  assert.match(forced.err, /MIDI|midi|header/i);
});

test("the extension breaks ties and a contradicting extension warns", async () => {
  const bytes = fs.readFileSync(fix("fuer-elise.mid"));
  const wrong = detectFormat(bytes, "tune.sng");
  assert.equal(wrong.best.id, "midi");
  assert.equal(wrong.warnings.length, 1);
  assert.match(wrong.warnings[0], /extension \.sng.*content is midi/);
  const dir = tmp();
  copy(dir, fix("fuer-elise.mid"), "tune.sng");
  const result = await run(["convert", "tune.sng", "out.musicxml"], dir);
  assert.equal(result.code, 0);
  assert.match(result.err, /warning: tune\.sng has the extension \.sng/);

  const weak = (id, confidence, ext) => ({ id, name: id, extensions: [ext], magic: () => confidence, detection: "test", caps: {}, lossSummary: "" });
  const tied = [weak("a", 0.8, ".aaa"), weak("b", 0.8, ".bbb")];
  const ambiguous = detectFormat(Buffer.from("x"), undefined, tied);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.best, undefined);
  assert.match(ambiguityMessage("x", ambiguous), /--from a or --from b/);
  const resolved = detectFormat(Buffer.from("x"), "song.bbb", tied);
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.best.id, "b");
  const low = detectFormat(Buffer.from("x"), undefined, [weak("c", 0.4, ".c")]);
  assert.equal(low.ambiguous, true);
});

test("--dry-run writes nothing; --strict exits 1 on a lost loss and writes nothing", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.sng"));
  const dry = await run(["convert", "fuer-elise.sng", "out.mid", "--dry-run"], dir);
  assert.equal(dry.code, 0);
  assert.equal(fs.existsSync(path.join(dir, "out.mid")), false);
  assert.match(dry.out, /dry run, would write .*out\.mid; nothing written/);
  // Five voices to GoatTracker: two voices are lost.
  const five = copy(dir, score("sidwave-1.2/title_fanfare.yaml"), "fanfare.yaml");
  assert.ok(fs.existsSync(five));
  const strict = await run(["convert", "fanfare.yaml", "out.sng", "--strict"], dir);
  assert.equal(strict.code, 1);
  assert.equal(fs.existsSync(path.join(dir, "out.sng")), false);
  assert.match(strict.out, /voices\.dropped/);
  assert.match(strict.out, /nothing was written/);
  const json = JSON.parse((await run(["convert", "fanfare.yaml", "out.sng", "--strict", "--json"], dir)).out);
  assert.equal(json.ok, false);
  assert.equal(json.result.strictFailed, true);
  assert.deepEqual(json.result.plan.dropped.length, 2);
  // Without --strict the conversion is written and the drop list is reported.
  const lenient = await run(["convert", "fanfare.yaml", "out.sng"], dir);
  assert.equal(lenient.code, 0);
  assert.match(lenient.out, /voices dropped: v\d, v\d/);
  assert.ok(fs.existsSync(path.join(dir, "out.sng")));
});

test("--voices limits the voices by notes x range and the report names the kept voices", async () => {
  const dir = tmp();
  copy(dir, score("sidwave-1.2/title_fanfare.yaml"), "fanfare.yaml");
  const result = await run(["convert", "fanfare.yaml", "out.mid", "--voices", "2", "--json"], dir);
  assert.equal(result.code, 0, result.err);
  const loss = JSON.parse(result.out).result.losses.find((l) => l.code === "voices.dropped");
  assert.equal(loss.severity, "lost");
  assert.equal(loss.count, 3);
  assert.match(loss.message, /kept v\d, v\d, ranked by notes x pitch range/);
  const bad = await run(["convert", "fanfare.yaml", "out.mid", "--voices", "0"], dir);
  assert.equal(bad.code, 2);
});

test("--keep-score and --report write the intermediate score and the report", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.fur"));
  const result = await run(["convert", "fuer-elise.fur", "out.sng", "--keep-score", "kept.yaml", "--report", "report.json"], dir);
  assert.equal(result.code, 0, result.err);
  parseSidwave(fs.readFileSync(path.join(dir, "kept.yaml"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  assert.equal(report.from, "furnace");
  assert.equal(report.to, "goattracker");
  // The same refusal applies to the extra outputs.
  const again = await run(["convert", "fuer-elise.fur", "out2.sng", "--keep-score", "kept.yaml"], dir);
  assert.equal(again.code, 2);
  assert.equal(fs.existsSync(path.join(dir, "out2.sng")), false);
  const toStdout = await run(["convert", "fuer-elise.fur", "--to", "musicxml", "--report", "-", "-o", "x.musicxml"], dir);
  assert.equal(toStdout.code, 0);
  assert.equal(JSON.parse(toStdout.out).to, "musicxml");
});

test("converted bytes go to standard output with -o - and the summary to standard error", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.mid"));
  const result = await run(["convert", "fuer-elise.mid", "-", "--to", "goattracker"], dir);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.bytes.subarray(0, 4).toString("latin1"), "GTS5");
  assert.match(result.err, /-> goattracker/);
  assert.equal((await run(["convert", "fuer-elise.mid", "-", "--to", "goattracker", "--json"], dir)).code, 2);
});

test("usage errors exit 2 and unreadable input exits 3", async () => {
  const dir = tmp();
  copy(dir, fix("fuer-elise.mid"));
  assert.equal((await run(["convert"], dir)).code, 2);
  assert.equal((await run(["convert", "fuer-elise.mid"], dir)).code, 2); // no target
  assert.equal((await run(["convert", "fuer-elise.mid", "--to", "nonsense"], dir)).code, 2);
  assert.equal((await run(["convert", "fuer-elise.mid", "--to", "midi", "--song", "x"], dir)).code, 2);
  assert.equal((await run(["convert", "fuer-elise.mid", "--to", "midi", "--mode", "SECAM"], dir)).code, 2);
  const missing = await run(["convert", "missing.mid", "--to", "sidwave"], dir);
  assert.equal(missing.code, 3);
  assert.match(missing.err, /cannot read missing\.mid: the file does not exist/);
  fs.mkdirSync(path.join(dir, "folder.mid"));
  assert.match((await run(["convert", "folder.mid", "--to", "sidwave"], dir)).err, /cannot read folder\.mid: it is a directory, not a file/);
  assert.match((await run(["convert"], dir)).err, /see "sidwave convert --help"/);
  const song = await run(["convert", "fuer-elise.mid", "--to", "sid", "--song", "2"], dir);
  assert.equal(song.code, 2);
  assert.match(song.err, /holds one song/);
  const unwritable = await run(["convert", "fuer-elise.mid", "out.mxl"], dir);
  assert.equal(unwritable.code, 2);
  assert.match(unwritable.err, /extension \.mxl is read only \(use \.musicxml\)/);
  const wavIn = await run(["convert", "fuer-elise.mid", "out.xyz"], dir);
  assert.equal(wavIn.code, 2);
});

test("convert --help shows the examples; formats lists every format; info describes a file", async () => {
  const dir = tmp();
  const help = await run(["convert", "--help"], dir);
  assert.equal(help.code, 0);
  for (const example of ["sidwave convert song.sng song.mid", "sidwave convert tune.mid tune.sid", "sidwave convert tune.sid tune.sng"]) assert.match(help.out, new RegExp(example));
  assert.match((await run(["--help"], dir)).out, /sidwave convert <in>/);
  const formats = await run(["formats"], dir);
  assert.equal(formats.code, 0);
  for (const id of ["sidwave", "sid", "midi", "musicxml", "goattracker", "furnace", "wav", "prg", "events"]) assert.match(formats.out, new RegExp(`^${id} `, "m"));
  const json = JSON.parse((await run(["formats", "--json"], dir)).out);
  assert.equal(json.result.formats.find((f) => f.id === "wav").read, false);
  assert.equal(json.result.formats.find((f) => f.id === "sid").readApproximate, true);
  copy(dir, fix("fuer-elise.sng"));
  copy(dir, fix("fuer-elise.mid"));
  copy(dir, fix("fuer-elise.fur"));
  copy(dir, score("sidwave-1.0/fuer-elise.yaml"));
  const sng = await run(["info", "fuer-elise.sng"], dir);
  assert.match(sng.out, /GoatTracker song \(magic, confidence 1\)/);
  assert.match(sng.out, /songs: 1/);
  assert.match((await run(["info", "fuer-elise.mid"], dir)).out, /tracks: 4/);
  assert.match((await run(["info", "fuer-elise.fur"], dir)).out, /Furnace module/);
  const yaml = JSON.parse((await run(["info", "fuer-elise.yaml", "--json"], dir)).out);
  assert.equal(yaml.result.format, "sidwave");
  assert.equal(yaml.result.details.voices, 3);
  fs.writeFileSync(path.join(dir, "bad.sng"), Buffer.from("GTS5"));
  assert.equal((await run(["info", "bad.sng"], dir)).code, 3);
});

test("the library exports convert, detectFormat and listFormats", async () => {
  const result = await convert(fs.readFileSync(fix("fuer-elise.mid")), { to: "goattracker" });
  assert.equal(result.from, "midi");
  assert.equal(Buffer.from(result.output).subarray(0, 4).toString("latin1"), "GTS5");
  assert.ok(listFormats().some((f) => f.id === "furnace" && f.read && f.write));
  assert.equal(detectFormat(fs.readFileSync(fix("fuer-elise.musicxml"))).best.id, "musicxml");
});

test("losses get a code and a severity; groups add their counts", () => {
  assert.deepEqual(classifyLossText("3 notes are outside the GoatTracker range C0 to G#7 and were moved by octaves."), { code: "pitch.octave", severity: "approx" });
  assert.equal(classifyLossText("Only the first three voices of the first SID are exported (the score has 5 voices).").severity, "lost");
  assert.equal(classifyLossText("Pitches are the written notes; vibrato, arpeggio wavetables and slides are described per instrument.").severity, "info");
  const grouped = groupLosses([
    { stage: "write", code: "a", severity: "info", count: 2, message: "m1" },
    { stage: "write", code: "a", severity: "lost", count: 3, message: "m2" },
    { stage: "read", code: "a", severity: "info", count: 1, message: "m3" },
  ]);
  assert.equal(grouped.length, 2);
  assert.deepEqual([grouped[0].count, grouped[0].severity, grouped[0].message], [5, "lost", "m1 | m2"]);
});

test("ScorePlan keeps the voices with the most notes x range, deterministically, and reports the drop list", () => {
  const doc = parseSidwave(fs.readFileSync(score("sidwave-1.2/title_fanfare.yaml"), "utf8"));
  const caps = { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "partial", loop: false, metadata: true };
  const a = planScore(doc, caps);
  const b = planScore(doc, caps);
  assert.deepEqual(a, b);
  assert.equal(a.dropped.length, 2);
  const kept = a.voices.filter((v) => v.kept), dropped = a.voices.filter((v) => !v.kept);
  assert.ok(Math.min(...kept.map((v) => v.weight)) >= Math.max(...dropped.map((v) => v.weight)));
  assert.deepEqual(a.exportOptions.voiceIds, kept.map((v) => v.id));
  assert.equal(a.losses[0].code, "voices.dropped");
  assert.equal(planScore(doc, { ...caps, maxVoices: undefined }).dropped.length, 0);
  assert.equal(planScore(doc, { ...caps, maxVoices: undefined }, { voices: 4 }).dropped.length, 1);
});

test("a tempo ramp is reported for single-tempo and stepped targets", async () => {
  const text = `sidwave: 1.3
title: Ramp
tempo: 100
instruments:
  lead: { waveform: pulse, adsr: [0, 4, 8, 3] }
voices:
  - id: 1
    instrument: lead
    patterns:
      a: { length: 1, bars: 2, groove: "C4 E4 G4 E4 C5 G4 E4 C4" }
timeline:
  - { section: s1, bars: 2, tempo: { to: 140 }, layers: { v1: a } }
  - { section: s2, bars: 2, layers: { v1: a } }
`;
  for (const to of ["midi", "goattracker"]) {
    const result = await convert(Buffer.from(text), { to, inputName: "ramp.yaml" });
    const ramp = result.losses.find((l) => l.code === "tempo.ramp");
    assert.ok(ramp, `${to}: no tempo.ramp loss in ${JSON.stringify(result.losses.map((l) => l.code))}`);
    assert.equal(ramp.severity, "approx");
  }
});

test("a plain score passes --strict for every target that does not need the engine, and a plain file of every reader passes for SID-Wizard too", async () => {
  const dir = tmp();
  const targets = ["out.yaml", "out.mid", "out.musicxml", "out.sng", "out.fur", "out.swm", "out.prg", "out.sid", "out.json"];
  for (const file of ["fuer-elise.mid", "fuer-elise.musicxml", "fuer-elise.fur", "fuer-elise.sng", "fuer-elise.swm"]) {
    copy(dir, fix(file));
    for (const to of targets) {
      if (path.extname(to) === path.extname(file)) continue;
      // An imported SID-Wizard instrument has a first-frame waveform table; GoatTracker has no wavetable step, so that export reports it as lost (true positive).
      if (file.endsWith(".swm") && [".sng"].includes(path.extname(to))) continue;
      const result = await run(["convert", file, to, "--strict", "--force"], dir);
      assert.equal(result.code, 0, `${file} -> ${to}: ${result.out}${result.err}`);
    }
  }
  copy(dir, score("sidwave-1.0/fuer-elise.yaml"), "score.yaml");
  for (const to of targets.filter((t) => t !== "out.yaml")) {
    const result = await run(["convert", "score.yaml", to, "--strict", "--force"], dir);
    assert.equal(result.code, 0, `score.yaml -> ${to}: ${result.out}${result.err}`);
  }
});

test("drum hits of a pitched voice are written to the percussion channel of MIDI and to an unpitched part of MusicXML", async () => {
  const bytes = fs.readFileSync(score("sidwave-1.1/chiptune_drive.yaml"));
  const midi = await convert(bytes, { to: "midi", inputName: "chiptune_drive.yaml", verify: true });
  const smf = parseSmf(midi.output);
  const drumTracks = smf.tracks.filter((t) => t.some((e) => e.type === "noteOn" && e.channel === 9));
  assert.equal(drumTracks.length, 1);
  assert.ok(drumTracks[0].some((e) => e.type === "noteOn" && e.channel !== 9), "the track of the voice also holds its pitched notes");
  assert.equal(midi.metrics.drumIdentity, 1);
  const xml = await convert(bytes, { to: "musicxml", inputName: "chiptune_drive.yaml", verify: true });
  const text = Buffer.from(xml.output).toString("utf8");
  assert.match(text, /<part-name>v1 Voice1 drums<\/part-name>|<part-name>v1[^<]*drums<\/part-name>/);
  assert.equal(xml.metrics.drumIdentity, 1);
});

test("a score with speed 2 keeps its note times in GoatTracker, Furnace and SID-Wizard; only the end of the song moves to a bar line", async () => {
  const bytes = fs.readFileSync(score("sidwave-1.1/chiptune_drive.yaml"));
  for (const to of ["goattracker", "furnace", "midi"]) {
    const result = await convert(bytes, { to, verify: true, inputName: "chiptune_drive.yaml" });
    const m = result.metrics;
    // MIDI keeps the drum hits as drums, so only their pitch differs from the reference; a voice limit of the importer drops 16 notes.
    if (to === "midi") { assert.equal(m.drumIdentity, 1); assert.ok(m.noteF1 >= 0.92, JSON.stringify(m)); } else assert.equal(m.noteF1PitchOnly, 1, `${to}: ${JSON.stringify(m)}`);
    assert.ok(m.onsetError.maxMs <= 40, `${to}: onset error ${m.onsetError.maxMs} ms`);
    // The song length differs by the padding of the last bar, not by a tempo drift: the last note starts within a frame.
    assert.ok(Math.abs(m.durationSeconds.output - m.durationSeconds.reference) < 0.8, `${to}: ${JSON.stringify(m.durationSeconds)}`);
  }
  // SID-Wizard keeps the one-call rows of a speed-2 score only by merging them to 3-frame cells when it is read back.
  const swm = await convert(bytes, { to: "sidwizard", inputName: "chiptune_drive.yaml" });
  assert.ok(swm.losses.some((l) => l.code === "rows.one-call"));
  const gt = await convert(bytes, { to: "goattracker", inputName: "chiptune_drive.yaml" });
  assert.ok(gt.losses.some((l) => l.code === "timing.multispeed" && l.severity === "approx"));
});
