import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { convert } from "../src/interchange/convert.ts";
import { exportEvents } from "../src/interchange/events.ts";
import { BASIC_COST, BASIC_LEAD_SECONDS, basicLineBytes } from "../src/interchange/basic.ts";
import { InterchangeLimitError, InterchangeUsageError } from "../src/interchange/errors.ts";
import { traceDocument } from "../src/compose/trace.ts";
import { runCli } from "../src/cli.ts";
import { parseSidwave } from "../src/sidwave.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const example = (name) => read(`data/sound/examples/${name}.yaml`);
const toBasic = (yaml, options = {}) => convert(Buffer.from(yaml), { to: "basic", ...options });
const text = (result) => Buffer.from(result.output).toString("latin1");
const lossOf = (result, code) => result.losses.find((loss) => loss.code === code);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-basic-"));
const hasPetcat = spawnSync("petcat", ["-help"], { stdio: "ignore" }).error === undefined;

/** The DATA statements of a listing as records of (jiffy, register writes), with the checks of the program itself. */
function decode(program) {
  const lines = program.trimEnd().split("\n");
  const values = lines.flatMap((line) => {
    const data = /^\d+ DATA(.*)$/.exec(line);
    return data ? data[1].split(",").map(Number) : [];
  });
  const count = Number(/FOR I=1 TO (\d+):READ A:C=C\+A:NEXT/.exec(program)[1]);
  const checksum = Number(/IF C<>(\d+) THEN PRINT"DATA ERROR":END/.exec(program)[1]);
  const records = [];
  let jiffy = 0;
  for (let i = 0; i < values.length;) {
    jiffy += values[i++];
    const pairs = values[i++];
    const writes = [];
    for (let n = 0; n < pairs; n++) writes.push([values[i++], values[i++]]);
    records.push({ jiffy, writes });
  }
  return { lines, values, count, checksum, records };
}

/** When each write happens, from the jiffies of the records and the measured interpreter costs. */
function timeline(records) {
  let free = 0;
  return records.flatMap((record) => {
    const start = Math.max(record.jiffy / 60 + BASIC_COST.wait, free);
    free = start + record.writes.length * BASIC_COST.write + BASIC_COST.record;
    return record.writes.map(([reg, value], i) => ({ reg, value, time: start + (i + 1) * BASIC_COST.write - BASIC_LEAD_SECONDS }));
  });
}

/** Gate edges per voice with the register values at the edge. */
function gates(writes) {
  const registers = new Array(25).fill(0);
  const on = [[], [], []], off = [[], [], []];
  for (const { reg, value, time } of writes) {
    if (reg < 21 && reg % 7 === 4 && (value & 1) !== (registers[reg] & 1)) {
      const voice = (reg - 4) / 7, base = voice * 7;
      (value & 1 ? on : off)[voice].push({ time, ctrl: value, freq: registers[base] | (registers[base + 1] << 8), pw: registers[base + 2] | (registers[base + 3] << 8), ad: registers[base + 5], sr: registers[base + 6] });
    }
    registers[reg] = value;
  }
  return { on, off };
}

async function cli(args, cwd) {
  const out = [], err = [];
  const code = await runCli(args, { cwd, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

/** A long score of three voices with a new note on every step. */
function busyScore(bars, voices = 3) {
  const voice = (id) => {
    const notes = Array.from({ length: 32 }, (_, i) => `"${"CDEFGAB"[(i + id) % 7]}${3 + (id % 3)}"`).join(", ");
    return `  - id: ${id}\n    waveform: ${["pulse", "saw", "triangle", "pulse"][id - 1]}\n    adsr: [0, 4, 8, 2]\n    patterns:\n      p:\n        groove: [${notes}]\n`;
  };
  const ids = Array.from({ length: voices }, (_, i) => i + 1);
  return `song:\n  title: "Busy"\n  mode: PAL\n  tempo: 150\nvoices:\n${ids.map(voice).join("")}timeline:\n  - bars: ${bars}\n    layers: { ${ids.map((id) => `v${id}: p`).join(", ")} }\n`;
}

test("the DATA records hold the pitch, waveform, envelope and time of every note of the score", async () => {
  const yaml = example("fuer_elise");
  const result = await toBasic(yaml);
  const { records } = decode(text(result));
  const score = exportEvents(parseSidwave(yaml));
  assert.equal(records.at(-1).writes.length, 0, "the last record only waits");
  const writes = timeline(records);
  assert.ok(writes.every((w) => w.reg >= 0 && w.reg <= 24 && w.value >= 0 && w.value <= 255));
  const { on, off } = gates(writes);
  let compared = 0;
  for (const [index, voice] of score.voices.entries()) {
    assert.equal(on[index].length, voice.notes.length, `voice ${index + 1} gate-ons`);
    assert.equal(off[index].length, voice.notes.length, `voice ${index + 1} gate-offs`);
    for (const [n, note] of voice.notes.entries()) {
      const start = on[index][n];
      const [attack, decay, sustain, release] = score.instruments.find((i) => i.index === note.instrument).adsr;
      const frequency = 440 * 2 ** ((note.pitch - 69) / 12) * 16777216 / 985248;
      assert.ok(Math.abs(start.freq - frequency) <= 1, `note ${n}: frequency ${start.freq}, expected ${frequency}`);
      assert.equal(start.ctrl, 0x11, "triangle with the gate set");
      assert.equal(start.ad, attack * 16 + decay);
      assert.equal(start.sr, sustain * 16 + release);
      // Half a jiffy of rounding, and the writes of other voices of the same chord.
      assert.ok(Math.abs(start.time - note.on.time) <= 0.025, `note ${n} starts at ${start.time}, score ${note.on.time}`);
      const end = off[index][n].time;
      assert.ok(end > start.time && end <= note.off.time + 0.06 && end >= note.off.time - 0.15, `note ${n} ends at ${end}, score ${note.off.time}`);
      compared++;
    }
  }
  assert.equal(compared, 47);
  assert.equal(result.reports.write.delayedEvents, 0);
  assert.ok(result.reports.write.predictedMaxErrorMs <= 17);
  assert.equal(lossOf(result, "basic.timing.dense"), undefined);
  assert.equal(lossOf(result, "basic.timing.jiffy").count, records.length - 1);
});

test("a score with wavetables and legato notes plays the register values of the compiled player at its note starts", async () => {
  const yaml = example("chamber_waltz");
  const result = await toBasic(yaml);
  const { on } = gates(timeline(decode(text(result)).records));
  const doc = parseSidwave(yaml);
  const trace = traceDocument(doc, { loop: false });
  const score = exportEvents(doc);
  const registers = new Uint8Array(32);
  const states = [];
  const starts = [[], [], []];
  const gate = [0, 0, 0];
  for (let call = 0; call < trace.callCount; call++) {
    for (let i = trace.starts[call]; i < trace.starts[call + 1]; i++) {
      const reg = trace.writes[i] >>> 8, value = trace.writes[i] & 255;
      registers[reg] = value;
      if (reg < 21 && reg % 7 === 4) {
        const voice = (reg - 4) / 7;
        if (value & 1 && !gate[voice]) starts[voice].push(call);
        gate[voice] = value & 1;
      }
    }
    states.push(registers.slice());
  }
  for (let voice = 0; voice < 3; voice++) {
    assert.equal(on[voice].length, starts[voice].length, `voice ${voice + 1}`);
    for (const [n, call] of starts[voice].entries()) {
      const note = on[voice][n];
      const during = states.slice(call, starts[voice][n + 1] ?? states.length);
      const base = voice * 7;
      assert.ok(during.some((s) => (s[base] | (s[base + 1] << 8)) === note.freq), `voice ${voice + 1} note ${n}: frequency`);
      assert.ok(during.some((s) => (s[base + 4] & 0xf6) === (note.ctrl & 0xf6)), `voice ${voice + 1} note ${n}: waveform`);
      assert.ok(during.some((s) => s[base + 5] === note.ad && s[base + 6] === note.sr), `voice ${voice + 1} note ${n}: envelope`);
      assert.ok(Math.abs(note.time - call / score.callRate) <= 0.03, `voice ${voice + 1} note ${n}: ${note.time} against ${call / score.callRate}`);
    }
  }
  // Voice 1 has more score notes than gate-ons: each of the others changes the frequency while the gate stays set.
  assert.ok(score.voices[0].notes.length > starts[0].length);
  const frequencies = [];
  let low = 0;
  for (const w of timeline(decode(text(result)).records)) {
    if (w.reg === 0) low = w.value;
    if (w.reg === 1) frequencies.push({ time: w.time, freq: low | (w.value << 8) });
  }
  const legato = score.voices[0].notes.filter((note) => !starts[0].includes(Math.round(note.on.time * score.callRate)));
  const heard = legato.filter((note) => {
    const expected = 440 * 2 ** ((note.pitch - 69) / 12) * 16777216 / 985248;
    const latest = frequencies.filter((f) => f.time <= note.on.time + 0.05).at(-1);
    return latest !== undefined && Math.abs(1200 * Math.log2(latest.freq / expected)) < 50;
  });
  assert.equal(heard.length, legato.length, "legato notes reach their pitch on time");
});

test("lines are numbered in steps of 10, upper case, at most 80 characters, and the program checks its DATA", async () => {
  const result = await toBasic(example("chamber_waltz"));
  const program = text(result);
  const { lines, values, count, checksum } = decode(program);
  assert.ok(lines.every((line) => line.length <= 80), "line length");
  assert.ok(lines.every((line, i) => line.startsWith(`${(i + 1) * 10} `)), "numbering");
  assert.ok(!/[a-z]/.test(program));
  assert.equal(count, values.length);
  assert.equal(checksum, values.reduce((sum, value) => sum + value, 0));
  assert.equal(result.reports.write.checksum, checksum);
  assert.equal(result.reports.write.lineCount, lines.length);
  // A loop line is a target of GOTO and IF.
  assert.match(lines[4], /^50 READ D,N:T=T\+D$/);
  assert.match(lines[5], /^60 IF TI<T THEN 60$/);
  assert.match(lines[6], /GOTO 50$/);
});

test("the size is that of the tokenised program and its variables", async () => {
  assert.equal(basicLineBytes('PRINT"END"'), 5 + 1 + 5);
  assert.equal(basicLineBytes("DATA1,2"), 5 + 1 + 3);
  assert.equal(basicLineBytes("IF TI<T THEN 60"), 5 + "i TI<T t 60".length);
  const report = (await toBasic(example("fuer_elise"))).reports.write;
  assert.equal(report.variableBytes, 9 * 7);
  assert.equal(report.tokenisedBytes, report.programTokenBytes + report.variableBytes);
  assert.equal(report.availableBytes, 38911);
});

test("petcat tokenises the listing to the computed size", { skip: !hasPetcat }, async () => {
  const result = await toBasic(example("chamber_waltz"));
  const dir = tempDir();
  const input = path.join(dir, "program.txt"), output = path.join(dir, "program.prg");
  // petcat reads lower case ASCII as the unshifted letters of the C64.
  fs.writeFileSync(input, text(result).toLowerCase());
  execFileSync("petcat", ["-w2", "-o", output, "--", input]);
  assert.equal(fs.statSync(output).size - 2, result.reports.write.programTokenBytes);
  const listed = execFileSync("petcat", ["-2", "--", output]).toString("latin1");
  assert.match(listed, /60 if ti<t then 60/);
});

test("a program larger than BASIC RAM exits 5 and names a --seconds value that fits", async () => {
  const dir = tempDir();
  const source = path.join(dir, "busy.yaml"), target = path.join(dir, "busy.bas");
  fs.writeFileSync(source, busyScore(200));
  const refused = await cli(["convert", source, target], dir);
  assert.equal(refused.code, 5, refused.err);
  assert.match(refused.err, /more than the 38911 bytes of BASIC RAM/);
  assert.match(refused.err, /--voices 1 or 2/);
  assert.equal(fs.existsSync(target), false);
  const seconds = Number(/--seconds (\d+) writes its first/.exec(refused.err)[1]);
  assert.ok(seconds > 20, `${seconds}`);
  const shortened = await cli(["convert", source, target, "--seconds", String(seconds)], dir);
  assert.equal(shortened.code, 0, shortened.err);
  const result = await toBasic(fs.readFileSync(source, "utf8"), { seconds });
  assert.ok(result.reports.write.tokenisedBytes <= 38911);
  assert.ok(result.reports.write.tokenisedBytes > 36000, "the suggested length uses most of the memory");
  assert.ok(lossOf(result, "basic.truncated").count > 0);
  assert.ok(decode(text(result)).records.at(-2).jiffy / 60 <= seconds + 2 + result.reports.write.maxDelayMs / 1000);
  await assert.rejects(toBasic(busyScore(200)), InterchangeLimitError);
});

test("dense passages, dropped voices, other SIDs and what a note cannot hold are reported as losses", async () => {
  const dense = await toBasic(example("chiptune_drive"), { seconds: 30 });
  assert.equal(lossOf(dense, "basic.timing.dense").count, dense.reports.write.delayedEvents);
  assert.ok(dense.reports.write.delayedEvents > 10);
  assert.match(lossOf(dense, "basic.timing.dense").message, /too dense for BASIC V2/);

  const fanfare = await toBasic(example("title_fanfare"));
  assert.ok(lossOf(fanfare, "voices.dropped").count >= 1);
  assert.ok(lossOf(fanfare, "basic.modulation.dropped").count > 0);
  assert.ok(lossOf(fanfare, "basic.filter.sampled").count > 0);
  assert.ok(lossOf(fanfare, "basic.sid.moved").count > 0);
  assert.ok(fanfare.losses.every((loss) => loss.code !== "note" && loss.count > 0));
  assert.ok(decode(text(fanfare)).records.every((r) => r.writes.every(([reg]) => reg <= 24)));
});

test("--voices writes only the chosen voices", async () => {
  const one = await toBasic(example("fuer_elise"), { voices: 1 });
  const { on } = gates(timeline(decode(text(one)).records));
  assert.deepEqual(on.map((list) => list.length), [27, 0, 0]);
  assert.equal(lossOf(one, "voices.dropped").count, 2);
});

test("a .bas file cannot be read", async () => {
  const listing = (await toBasic(example("fuer_elise"))).output;
  await assert.rejects(convert(listing, { to: "midi", inputName: "tune.bas" }), InterchangeUsageError);
});

test("the largest shipped example is processed within 1 s of CPU time", async () => {
  const dir = path.join(root, "data/sound/examples");
  const [largest] = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size);
  const yaml = read(`data/sound/examples/${largest}`);
  // The smallest of three runs, so that the first compilation of the code and other processes do not count.
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const before = process.cpuUsage();
    await toBasic(yaml).catch((error) => assert.ok(error instanceof InterchangeLimitError, error.stack));
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  assert.ok(best < 1000, `${largest}: ${best} ms`);
});
