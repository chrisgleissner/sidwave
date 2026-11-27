import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_INPUT, EXIT_ENGINE_UNAVAILABLE, EXIT_LIMIT, EXIT_INTERNAL, EXIT_CODES } from "../src/cli.ts";
import { classifyError, SidwaveOperationError } from "../src/cliCore.ts";
import { compileSidwaveBytes, readExampleScore } from "../src/sidwaveOps.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { SidAbortError, SidEngineUnavailableError, SidLimitError, SidLoadError, TraceOverflowError } from "../src/engine/types.ts";
import { VerifyError } from "../src/verify/index.ts";
import { A1Error } from "../src/verify/a1.ts";
import { SidFileError } from "../src/sidFile.ts";
import { encodeWav, formatTrace, loadRoms, defaultHorizon, loadTune } from "../src/sidwaveTools.ts";
import { formatVerify } from "../src/cliVerify.ts";

const ELISE = readExampleScore("fuer_elise");
const FIRST_NOTE_CHANGED = ELISE.replace('["E5", "D#5"', '["F5", "D#5"');
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const engineVersion = createRequire(import.meta.url)("libsidplayfp-wasm/package.json").version;

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-verify-cli-")));
  fs.writeFileSync(path.join(dir, "a.yaml"), ELISE);
  fs.writeFileSync(path.join(dir, "b.yaml"), FIRST_NOTE_CHANGED);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
/** Placeholder ROM images are not runnable, so the engine renders without them; the command still hashes and checks them. */
const ignoreRoms = (emulation) => {
  const engine = createLibsidplayfpEngine({ emulation });
  return { id: engine.id, get version() { return engine.version; }, render: (req) => engine.render({ ...req, roms: undefined }), trace: (req) => engine.trace({ ...req, roms: undefined }) };
};

async function run(cwd, args, extra = {}) {
  const out = [], err = [], bytes = [];
  const code = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(Buffer.from(b)), ...extra });
  return { code, out: out.join(""), err: err.join(""), bytes: Buffer.concat(bytes) };
}

function romDir(dir) {
  const rom = path.join(dir, "roms");
  fs.mkdirSync(rom, { recursive: true });
  fs.writeFileSync(path.join(rom, "kernal.rom"), Buffer.alloc(8192, 1));
  fs.writeFileSync(path.join(rom, "basic.rom"), Buffer.alloc(8192, 2));
  fs.writeFileSync(path.join(rom, "chargen.rom"), Buffer.alloc(4096, 3));
  return rom;
}
const pinnedRoms = { kernal: sha(Buffer.alloc(8192, 1)), basic: sha(Buffer.alloc(8192, 2)), chargen: sha(Buffer.alloc(4096, 3)) };

function rulesFile(dir, overrides = {}, parameters = { thetaSpec: 2, thetaLevel: 3, sGap: 10, k: 2, m: 3 }) {
  const file = path.join(dir, "rules.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "sidwave-a1-rules/1", parameters,
    conditions: { sampleRate: 48000, channels: 1, engine: { id: "libsidplayfp-wasm", version: engineVersion, emulation: "residfp" }, roms: pinnedRoms, ...overrides },
  }));
  return file;
}

test("error categories map to exit codes and every code is distinct from a failed verdict", () => {
  assert.deepEqual(EXIT_CODES, { usage: 2, input: 3, validation: 3, engine_unavailable: 4, limit_exceeded: 5, aborted: 5, internal: 70 });
  assert.deepEqual([EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_INPUT, EXIT_ENGINE_UNAVAILABLE, EXIT_LIMIT, EXIT_INTERNAL], [0, 1, 2, 3, 4, 5, 70]);
  const category = (e) => classifyError(e).category;
  assert.equal(category(new SidAbortError()), "aborted");
  assert.equal(category(new SidEngineUnavailableError("x")), "engine_unavailable");
  assert.equal(category(new SidLoadError("x")), "input");
  assert.equal(category(new SidLimitError("x")), "limit_exceeded");
  assert.equal(category(new TraceOverflowError("x")), "limit_exceeded");
  assert.equal(category(new VerifyError("invalid_options", "x")), "usage");
  assert.equal(category(new VerifyError("trace_limit", "x")), "limit_exceeded");
  assert.equal(category(new VerifyError("invalid_trace", "x")), "internal");
  assert.equal(category(new VerifyError("unsupported_pcm_engine", "x")), "engine_unavailable");
  assert.equal(category(new A1Error("invalid_input", "x")), "usage");
  assert.equal(category(new A1Error("invalid_rules", "x")), "input");
  assert.equal(category(new SidFileError("truncated", "x")), "input");
  assert.equal(category(Object.assign(new Error("boom"), { code: "EACCES" })), "input");
  assert.equal(category(Object.assign(new Error("stop"), { name: "AbortError" })), "aborted");
  assert.equal(category(new Error("boom")), "internal");
  assert.equal(category("text"), "internal");
  assert.equal(category(new SidwaveOperationError("usage", "m")), "usage");
});

test("sid-info prints and returns the header; a songlengths database adds the length", async () => {
  const { dir, done } = sandbox();
  try {
    assert.equal((await run(dir, ["compile", "a.yaml", "-o", "a.sid"])).code, EXIT_OK);
    const bytes = fs.readFileSync(path.join(dir, "a.sid"));
    const text = await run(dir, ["sid-info", "a.sid"]);
    assert.equal(text.code, EXIT_OK);
    assert.match(text.out, /^a\.sid: PSID v\d, 1 song, start song 1\nname: Für Elise\n/);
    assert.match(text.out, new RegExp(`md5 ${createHash("md5").update(bytes).digest("hex")}`));
    const json = JSON.parse((await run(dir, ["sid-info", "a.sid", "--json"])).out);
    assert.equal(json.ok, true);
    assert.equal(json.command, "sid-info");
    assert.equal(json.result.songs, 1);
    assert.equal(json.result.name, "Für Elise");
    assert.equal(json.result.sizeBytes, bytes.length);
    assert.deepEqual(json.result.speeds, ["VBI"]);
    assert.equal(json.result.songlengths, undefined);
    fs.writeFileSync(path.join(dir, "len.md5"), `[Database]\n; /x/a.sid\n${json.result.md5}=1:23.5\n`);
    const withLengths = JSON.parse((await run(dir, ["sid-info", "a.sid", "--songlengths", "len.md5", "--json"])).out);
    assert.deepEqual(withLengths.result.songlengths, [83.5]);
    assert.match((await run(dir, ["sid-info", "a.sid", "--songlengths", "len.md5"])).out, /song lengths: 83.5s/);
    fs.writeFileSync(path.join(dir, "junk.sid"), "not a sid file at all");
    const junk = await run(dir, ["sid-info", "junk.sid", "--json"]);
    assert.equal(junk.code, EXIT_INPUT);
    assert.equal(JSON.parse(junk.out).error.category, "input");
    assert.equal((await run(dir, ["sid-info", "missing.sid"])).code, EXIT_INPUT);
    assert.equal((await run(dir, ["sid-info", "a.sid", "b.sid"])).code, EXIT_USAGE);
    assert.equal((await run(dir, ["sid-info", "a.sid", "--seconds", "3"])).code, EXIT_USAGE);
    assert.equal((await run(dir, ["sid-info", "a.sid", "--max-bytes", "10"])).code, EXIT_LIMIT);
    assert.equal((await run(dir, ["sid-info", "a.sid", "-o", "x"])).code, EXIT_USAGE);
  } finally { done(); }
});

test("render writes a WAV of exact size, to a file or to standard output, with the summary beside it", async () => {
  const { dir, done } = sandbox();
  try {
    const result = await run(dir, ["render", "a.yaml", "--seconds", "0.5", "--engine", "sidlite", "--json"]);
    assert.equal(result.code, EXIT_OK);
    const envelope = JSON.parse(result.out);
    assert.equal(envelope.command, "render");
    const wav = fs.readFileSync(path.join(dir, "a.wav"));
    assert.equal(wav.length, 44 + 24_000 * 2);
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.subarray(8, 16).toString(), "WAVEfmt ");
    assert.equal(wav.readUInt32LE(24), 48_000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), 48_000);
    assert.equal(envelope.result.sha256, sha(wav));
    assert.equal(envelope.result.samples, 24_000);
    assert.equal(envelope.result.engine.emulation, "sidlite");
    assert.ok(wav.subarray(44).some((b) => b !== 0), "audio is not silent");
    const toStdout = await run(dir, ["render", "a.yaml", "--seconds", "0.25", "--rate", "44100", "-o", "-", "--engine", "sidlite"]);
    assert.equal(toStdout.bytes.length, 44 + 11_025 * 2);
    assert.equal(toStdout.out, "");
    assert.match(toStdout.err, /^standard output: WAV 22094 bytes, 0\.3 s, 44100 Hz mono, sidlite\n$/);
    const named = await run(dir, ["render", "a.yaml", "--seconds", "0.1", "-o", "sub/x.wav", "--model", "8580", "--clock", "NTSC"]);
    assert.equal(named.code, EXIT_OK);
    assert.equal(fs.statSync(path.join(dir, "sub/x.wav")).size, 44 + 4_800 * 2);
  } finally { done(); }
});

test("render and trace refuse bad options, over-budget runs and overwriting the input", async () => {
  const { dir, done } = sandbox();
  try {
    for (const args of [["render"], ["render", "a.yaml", "b.yaml"], ["render", "a.yaml", "--level", "T0"], ["render", "a.yaml", "--seconds", "0"], ["render", "a.yaml", "--seconds", "x"],
      ["render", "a.yaml", "--song", "0"], ["render", "a.yaml", "--rate", "100"], ["render", "a.yaml", "--model", "9000"], ["render", "a.yaml", "--engine", "x"], ["render", "a.yaml", "--clock", "X"],
      ["render", "a.yaml", "--progress=1"], ["render", "a.yaml", "--seconds"], ["render", "a.yaml", "--strict"], ["render", "a.yaml", "-o", "a.yaml"],
      ["trace"], ["trace", "a.yaml", "--format", "xml"], ["trace", "a.yaml", "--json"], ["trace", "a.yaml", "--rate", "48000"], ["trace", "a.yaml", "-o", "a.yaml"],
      ["verify"], ["verify", "a.yaml"], ["verify", "a.yaml", "b.yaml", "--level", "T9"], ["verify", "a.yaml", "b.yaml", "--rate", "48000"], ["verify", "a.yaml", "b.yaml", "--model", "8580"], ["verify", "a.yaml", "b.yaml", "-o", "x"],
      ["verify", "a.yaml", "b.yaml", "--tolerance-cycles", "-1"], ["verify", "a.yaml", "b.yaml", "--tolerance-cycles", "1.5"]]) {
      const result = await run(dir, args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
      if (!args.includes("--json")) assert.match(result.err, /^sidwave: /);
      else assert.equal(JSON.parse(result.out).error.category, "usage");
    }
    const tooLong = await run(dir, ["render", "a.yaml", "--seconds", "5", "--max-seconds", "1", "--json"]);
    assert.equal(tooLong.code, EXIT_LIMIT);
    assert.deepEqual(JSON.parse(tooLong.out).error, { category: "limit_exceeded", message: "5 s exceeds the limit of 1 s", details: { seconds: 5, max: 1 } });
    assert.equal((await run(dir, ["render", "a.yaml", "--seconds", "181"])).code, EXIT_LIMIT);
    const bigOutput = await run(dir, ["render", "a.yaml", "--seconds", "1", "--max-bytes", "2000"]);
    assert.equal(bigOutput.code, EXIT_LIMIT);
    assert.match(bigOutput.err, /the WAV output is 96044 bytes; the limit is 2000 bytes/);
    assert.equal((await run(dir, ["render", "a.yaml", "--max-bytes", "100"])).code, EXIT_LIMIT);
    assert.equal(fs.existsSync(path.join(dir, "a.wav")), false);
    assert.equal((await run(dir, ["render", "missing.yaml"])).code, EXIT_INPUT);
    fs.writeFileSync(path.join(dir, "bad.yaml"), "voices: 3\n");
    assert.equal((await run(dir, ["render", "bad.yaml"])).code, EXIT_INPUT);
  } finally { done(); }
});

test("trace writes CSV or JSON lines of the register writes", async () => {
  const { dir, done } = sandbox();
  try {
    const csv = await run(dir, ["trace", "a.yaml", "--seconds", "0.5"]);
    assert.equal(csv.code, EXIT_OK);
    const lines = csv.out.trim().split("\n");
    assert.equal(lines[0], "sid,address,value,cycle");
    assert.match(lines[1], /^0,\d+,\d+,\d+$/);
    const summaryLine = csv.err;
    assert.match(summaryLine, new RegExp(`^standard output: ${lines.length - 1} SID writes as csv, 0\\.5 s, PAL\\n$`));
    const toFile = await run(dir, ["trace", "a.yaml", "--seconds", "0.5", "--format", "jsonl", "-o", "t.jsonl", "--json"]);
    assert.equal(toFile.code, EXIT_OK);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "t.jsonl"), "utf8").split("\n")[0]);
    assert.deepEqual(Object.keys(record), ["sid", "address", "value", "cycle"]);
    const envelope = JSON.parse(toFile.out);
    assert.equal(envelope.result.records, lines.length - 1);
    assert.equal(envelope.result.format, "jsonl");
    assert.equal(envelope.result.clock, "PAL");
    assert.equal(envelope.result.outputBytes, fs.statSync(path.join(dir, "t.jsonl")).size);
    const overflow = await run(dir, ["trace", "a.yaml", "--seconds", "0.5", "--max-records", "3", "-o", "t3.csv", "--json"]);
    assert.equal(overflow.code, EXIT_LIMIT);
    assert.equal(JSON.parse(overflow.out).error.category, "limit_exceeded");
    assert.equal((await run(dir, ["trace", "a.yaml", "--seconds", "0.5", "--max-bytes", "50"])).code, EXIT_LIMIT);
  } finally { done(); }
});

test("verify: identical scores reach T0, a changed note fails T0 and T1 with the first difference, exit 0 and 1", async () => {
  const { dir, done } = sandbox();
  try {
    const same = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--level", "T0"]);
    assert.equal(same.code, EXIT_OK);
    assert.match(same.out, /^verify: PASS, highest level reached: T0 \(requested T0\)\n/);
    assert.match(same.out, /  T0: pass\n  T1: pass\n  A0: not evaluated\n  A1: not evaluated\n$/);
    const different = await run(dir, ["verify", "a.yaml", "b.yaml", "--seconds", "1", "--level", "T1", "--json"]);
    assert.equal(different.code, EXIT_FAILED);
    const envelope = JSON.parse(different.out);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, "verify");
    assert.equal(envelope.error, undefined);
    const result = envelope.result;
    assert.equal(result.verdict, "fail");
    assert.equal(result.level, "none");
    assert.equal(result.requestedLevel, "T1");
    assert.deepEqual(result.levels, { T0: "fail", T1: "fail", A0: "not evaluated", A1: "not evaluated" });
    assert.equal(result.firstDifference.level, "T0");
    assert.equal(result.firstDifference.category, "value");
    assert.equal(result.firstDifference.voice, 1);
    assert.equal(result.horizon.seconds, 1);
    assert.equal(result.reference.kind, "score");
    const plain = await run(dir, ["verify", "a.yaml", "b.yaml", "--seconds", "1", "--level", "T1"]);
    assert.match(plain.out, /^verify: FAIL, highest level reached: none \(requested T1\)\n/);
    assert.match(plain.out, /first difference: T0 value at 0\.\d+ s, call \d+, SID 1, voice 1, register \$[0-9a-f]{2}; expected \d+, observed \d+\n$/);
    // The requested level is the weakest acceptable one: T1 passes a timing-only difference that T0 reports.
    const tolerant = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--level", "T1", "--tolerance-cycles", "10"]);
    assert.equal(tolerant.code, EXIT_OK);
  } finally { done(); }
});

test("verify A0 and A1: identical tunes reach T0, A1 evaluates under a rule file and reports why it cannot", async () => {
  const { dir, done } = sandbox();
  try {
    const rules = rulesFile(dir);
    const roms = romDir(dir);
    const a0 = JSON.parse((await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--level", "A0", "--json"])).out);
    assert.equal(a0.result.levels.A0, "pass");
    const a1 = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--a1-rules", rules, "--roms", roms, "--json", "--progress"], { createEngine: ignoreRoms });
    assert.equal(a1.code, EXIT_OK);
    const parsed = JSON.parse(a1.out);
    assert.equal(parsed.result.levels.A1, "pass");
    assert.equal(parsed.result.a1.windows, 92);
    assert.equal(parsed.result.a1.status, "approximate");
    assert.equal(parsed.result.a1.badWindows, 0);
    assert.match(parsed.result.a1.rulesSha256, /^[0-9a-f]{64}$/);
    assert.match(a1.err, /progress: A1 render \d+%/);
    const changed = await run(dir, ["verify", "a.yaml", "b.yaml", "--seconds", "1", "--a1-rules", rules, "--roms", roms], { createEngine: ignoreRoms });
    assert.equal(changed.code, EXIT_FAILED);
    assert.match(changed.out, /A1 \(approximate\): \d+ of 92 windows differ, lag -?\d+ ms/);
    const wrongVersion = rulesFile(dir, { engine: { id: "libsidplayfp-wasm", version: "0.0.0", emulation: "residfp" } });
    const notEvaluated = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--a1-rules", wrongVersion, "--roms", roms], { createEngine: ignoreRoms });
    assert.equal(notEvaluated.code, EXIT_OK);
    assert.match(notEvaluated.out, /A1 \(approximate\): not evaluated \(The engine libsidplayfp-wasm .* differs from the pinned libsidplayfp-wasm 0\.0\.0\)/);
    const noRoms = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--a1-rules", rules]);
    assert.equal(noRoms.code, EXIT_OK);
    assert.match(noRoms.out, /A1 \(approximate\): not evaluated \(The rule file pins the kernal ROM and none was supplied/);
    const otherRom = path.join(dir, "other");
    fs.mkdirSync(otherRom);
    for (const f of ["kernal.rom", "basic.rom"]) fs.copyFileSync(path.join(roms, f), path.join(otherRom, f));
    fs.writeFileSync(path.join(otherRom, "chargen.rom"), Buffer.alloc(4096, 9));
    assert.match((await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--a1-rules", rules, "--roms", otherRom])).out, /not evaluated \(The chargen ROM differs/);
    const missingRules = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--a1-rules", "nope.json"]);
    assert.equal(missingRules.code, EXIT_INPUT);
    fs.writeFileSync(path.join(dir, "bad-rules.json"), "{}");
    assert.equal((await run(dir, ["verify", "a.yaml", "a.yaml", "--a1-rules", "bad-rules.json"])).code, EXIT_INPUT);
  } finally { done(); }
});

test("verify compares a reference SID file with a score candidate and refuses unreadable or invalid input", async () => {
  const { dir, done } = sandbox();
  try {
    await run(dir, ["compile", "a.yaml", "-o", "ref.sid"]);
    const ok = await run(dir, ["verify", "ref.sid", "a.yaml", "--seconds", "0.5", "--level", "T0", "--json"]);
    assert.equal(ok.code, EXIT_OK);
    assert.deepEqual([JSON.parse(ok.out).result.reference.kind, JSON.parse(ok.out).result.candidate.kind], ["sid", "score"]);
    const horizon = JSON.parse((await run(dir, ["verify", "ref.sid", "a.yaml", "--level", "T0", "--max-seconds", "400", "--json"])).out).result.horizon.seconds;
    assert.equal(horizon, 30);
    fs.writeFileSync(path.join(dir, "len.md5"), `${compileSidwaveBytes(parseSidwave(ELISE), { format: "sid" }).bytes.length ? "" : ""}`);
    const missing = await run(dir, ["verify", "ref.sid", "nope.yaml", "--json"]);
    assert.equal(missing.code, EXIT_INPUT);
    assert.equal(JSON.parse(missing.out).error.details.file, "nope.yaml");
    fs.writeFileSync(path.join(dir, "bad.yaml"), "voices: 3\n");
    const invalid = await run(dir, ["verify", "ref.sid", "bad.yaml"]);
    assert.equal(invalid.code, EXIT_INPUT);
    fs.writeFileSync(path.join(dir, "junk.sid"), "junk");
    assert.equal((await run(dir, ["verify", "junk.sid", "a.yaml"])).code, EXIT_INPUT);
    assert.equal((await run(dir, ["verify", "ref.sid", "a.yaml", "--max-bytes", "20"])).code, EXIT_LIMIT);
  } finally { done(); }
});

test("a pre-aborted signal and an abort during the run end with exit 5 and category aborted; progress stays on stderr", async () => {
  const { dir, done } = sandbox();
  try {
    const controller = new AbortController();
    controller.abort();
    const pre = await run(dir, ["render", "a.yaml", "--seconds", "1", "--json"], { signal: controller.signal });
    assert.equal(pre.code, EXIT_LIMIT);
    assert.equal(JSON.parse(pre.out).error.category, "aborted");
    const live = new AbortController();
    const out = [], err = [];
    const code = await runCli(["render", "a.yaml", "--seconds", "20", "--progress", "--json", "-o", "x.wav"], {
      cwd: dir, out: (t) => out.push(t), outBytes: () => {}, signal: live.signal,
      err: (t) => { err.push(t); live.abort(); },
    });
    assert.equal(code, EXIT_LIMIT);
    assert.equal(JSON.parse(out.join("")).error.category, "aborted");
    assert.ok(err.length >= 1 && err.every((line) => line.startsWith("progress: render ")));
    assert.equal(fs.existsSync(path.join(dir, "x.wav")), false);
    const verifyAborted = await run(dir, ["verify", "a.yaml", "b.yaml", "--seconds", "1", "--level", "T1"], { signal: controller.signal });
    assert.equal(verifyAborted.code, EXIT_LIMIT);
    assert.equal(verifyAborted.out, "");
  } finally { done(); }
});

test("an unavailable engine exits 4 and an unexpected failure exits 70, both with the JSON error shape", async () => {
  const { dir, done } = sandbox();
  try {
    const unavailable = await run(dir, ["render", "a.yaml", "--seconds", "1", "--json"], { createEngine: () => { throw new SidEngineUnavailableError("libsidplayfp-wasm is not installed"); } });
    assert.equal(unavailable.code, EXIT_ENGINE_UNAVAILABLE);
    assert.deepEqual(JSON.parse(unavailable.out), { ok: false, command: "render", error: { category: "engine_unavailable", message: "libsidplayfp-wasm is not installed", details: { code: "engine_unavailable" } } });
    const internal = await run(dir, ["trace", "a.yaml", "--seconds", "1"], { createEngine: () => { throw new Error("boom"); } });
    assert.equal(internal.code, EXIT_INTERNAL);
    assert.equal(internal.err, "sidwave: boom\n");
    const verifyDown = await run(dir, ["verify", "a.yaml", "a.yaml", "--seconds", "1", "--level", "T1"], { createEngine: () => { throw new SidEngineUnavailableError("gone"); } });
    assert.equal(verifyDown.code, EXIT_ENGINE_UNAVAILABLE);
    const usage = await run(dir, ["verify", "--json"]);
    assert.equal(usage.code, EXIT_USAGE);
    assert.equal(JSON.parse(usage.out).error.category, "usage");
    assert.equal(JSON.parse(usage.out).command, "verify");
    const unknown = await run(dir, ["frobnicate", "--json"]);
    assert.equal(JSON.parse(unknown.out).command, "sidwave");
  } finally { done(); }
});

test("library helpers: WAV encoding, trace formatting, ROM loading and the default horizon", async () => {
  const wav = encodeWav(Int16Array.from([1, -2, 32767]), 8000, 1);
  assert.equal(wav.length, 50);
  assert.equal(Buffer.from(wav).readInt16LE(46), -2);
  assert.equal(Buffer.from(wav).readUInt32LE(4), 42);
  assert.equal(formatTrace(Float64Array.from([0, 24, 15, 6]), "csv"), "sid,address,value,cycle\n0,24,15,6\n");
  assert.equal(formatTrace(Float64Array.from([1, 4, 17, 99]), "jsonl"), '{"sid":1,"address":4,"value":17,"cycle":99}\n');
  const { dir, done } = sandbox();
  try {
    assert.throws(() => loadRoms(dir, { cwd: dir }), /holds none of/);
    fs.writeFileSync(path.join(dir, "kernal.rom"), Buffer.alloc(8192, 1));
    const roms = loadRoms(dir, { cwd: dir });
    assert.equal(roms.roms.kernal.length, 8192);
    assert.equal(roms.hashes.kernal, sha(Buffer.alloc(8192, 1)));
    assert.equal(roms.roms.basic, undefined);
    const tune = loadTune("a.yaml", { cwd: dir });
    assert.equal(tune.kind, "score");
    assert.equal(defaultHorizon(tune, undefined, undefined), Math.min(tune.durationSeconds, 180));
    assert.equal(defaultHorizon({ ...tune, durationSeconds: undefined }, 1, undefined), 30);
    assert.equal(defaultHorizon({ ...tune, durationSeconds: 999 }, 1, undefined), 180);
    const db = new Map([[tune.md5, [12_000]]]);
    assert.equal(defaultHorizon({ ...tune, durationSeconds: undefined }, 1, db), 12);
    assert.match(formatVerify({ verdict: "pass", requestedLevel: "T1", level: "T0", levels: { T0: "pass", T1: "pass", A0: "not evaluated", A1: "not evaluated" }, horizon: { seconds: 2, cycles: 1, calls: 3 }, engines: {}, reference: { source: "r", kind: "sid", md5: "" }, candidate: { source: "c", kind: "sid", md5: "" } }), /^verify: PASS/);
  } finally { done(); }
});

test("a second SIGINT ends the process with exit 5", async () => {
  const binJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
  const { dir, done } = sandbox();
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [binJs, "render", "a.yaml", "--seconds", "180", "--progress", "-o", "x.wav"], { cwd: dir });
    let count = 0;
    child.stderr.on("data", () => { if (count++ === 0) { child.kill("SIGINT"); child.kill("SIGINT"); } });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.ok(code === 5, `exit ${code}`);
  } finally { done(); }
});

test("the built CLI aborts on SIGINT with exit 5 and keeps standard output clean", async () => {
  const binJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
  assert.ok(fs.existsSync(binJs), "dist/bin.js is missing; run npm run build");
  const { dir, done } = sandbox();
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [binJs, "render", "a.yaml", "--seconds", "180", "--progress", "--json", "-o", "x.wav"], { cwd: dir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    let signalled = false;
    child.stderr.on("data", (d) => {
      stderr += d;
      if (!signalled) { signalled = true; child.kill("SIGINT"); }
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, EXIT_LIMIT);
    assert.equal(JSON.parse(stdout).error.category, "aborted");
    assert.match(stderr, /^progress: render \d+%/);
    assert.equal(fs.existsSync(path.join(dir, "x.wav")), false);
    const help = spawnSync(process.execPath, [binJs, "--help"], { encoding: "utf8" });
    assert.match(help.stdout, /sidwave verify/);
    assert.match(help.stdout, /3 input or validation error/);
    assert.match(help.stdout, /validate {3}Parse a score\. Exit 0 when it is valid, 3 with the path/);
  } finally { done(); }
});
