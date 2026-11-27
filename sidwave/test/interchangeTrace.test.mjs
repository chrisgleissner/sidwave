import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportViceDump, parseSiddump, parseViceDump, MAX_IMPORT_RECORDS } from "../src/interchange/traceInput.js";
import { reconstructFromTrace } from "../src/interchange/traceReconstruct.js";
import { InterchangeUsageError } from "../src/interchange/errors.js";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.js";
import { runCli } from "../src/cli.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveBytes } from "../src/sidwaveOps.js";
import { fuzz, cpuMs } from "./helpers/formatKit.mjs";

const dir = new URL("./fixtures/traces/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir));
const vice = read("fur-elise.vice-dump.txt");
const siddump = read("fur-elise.siddump.txt");

function cli(args, cwd) {
  let out = "", err = "";
  const io = { cwd, out: (t) => { out += t; }, err: (t) => { err += t; }, outBytes: () => {} };
  return Promise.resolve(runCli(args, io)).then((code) => ({ code, out, err }));
}

test("VICE dump: lines become writes with cumulative cycles, all attributed to SID 0", () => {
  const t = parseViceDump("342 24 15\n10 0 1\n5 1 2\n7 9 9\n3 31 1\n");
  assert.deepEqual(Array.from(t.records), [0, 24, 15, 342, 0, 0, 1, 352, 0, 1, 2, 357, 0, 9, 9, 364]);
  assert.equal(t.count, 4);
  assert.equal(t.sidCount, 1);
  assert.equal(t.ignoredWrites, 1, "register 31 is not a SID register");
  assert.equal(t.approximate, false);
  assert.equal(t.originCycle, 0);
  assert.equal(t.horizonCycles % 19656, 0);
});

test("VICE dump: the real vsid dump parses and re-exports byte for byte", () => {
  const t = parseViceDump(vice);
  assert.ok(t.count > 3000);
  assert.equal(exportViceDump(t.records), vice.toString("latin1"));
});

test("VICE dump: malformed input is a typed error with the line number", () => {
  const bad = ["1 2", "1 2 3 4", "a 2 3", "1 32 3", "1 2 300", "1  2 3", "1 2 3x", "99999999999999 0 0", "-1 0 0"];
  for (const text of bad) assert.throws(() => parseViceDump(`0 0 0\n${text}\n`), (e) => e instanceof InterchangeUsageError && /line 2/.test(e.message), text);
  assert.throws(() => parseViceDump("0 0 0\n".repeat(5), { maxRecords: 4 }), InterchangeUsageError);
  assert.equal(parseViceDump("").count, 0);
  assert.equal(parseViceDump("\r\n1 0 1\r\n").count, 1);
});

test("VICE dump export refuses what a dump cannot hold", () => {
  assert.throws(() => exportViceDump([0, 32, 0, 0]), InterchangeUsageError);
  assert.throws(() => exportViceDump([1, 4, 0, 0]), /no chip number/);
  assert.throws(() => exportViceDump([0, 0, 300, 0]), InterchangeUsageError);
  assert.throws(() => exportViceDump([0, 0, 1, 10, 0, 0, 1, 5]), InterchangeUsageError);
  assert.equal(exportViceDump([0, 4, 17, 100, 0, 4, 33, 100]), "100 4 17\n0 4 33\n");
});

test("siddump: rows become per-frame writes; dots keep the previous value", () => {
  const text = [
    "Load address: $1000",
    "| Frame | Freq Note/Abs WF ADSR Pul | Freq Note/Abs WF ADSR Pul | Freq Note/Abs WF ADSR Pul | FCut RC Typ V |",
    "+-------+---------------------------+---------------------------+---------------------------+---------------+",
    "|     0 | 2BDA  E-5 C0  11 1494 800 | 0116  ... ..  00 0000 000 | 0116  ... ..  00 0000 000 | 0000 00 Off 1 |",
    "|     1 | ....  ... ..  .. .... ... | ....  ... ..  .. .... ... | ....  ... ..  .. .... ... | .... .. ... 2 |",
    "|     3 | 2C00 (+ 0026) 10 .... ... | ....  ... ..  .. .... ... | ....  ... ..  .. .... ... | 0820 F1 Hi  . |",
    "",
  ].join("\n");
  const t = parseSiddump(text);
  const rows = [];
  for (let i = 0; i < t.records.length; i += 4) rows.push([t.records[i + 1], t.records[i + 2], Math.floor(t.records[i + 3] / 19656)]);
  const frame0 = rows.filter((r) => r[2] === 0).map((r) => `${r[0]}:${r[1].toString(16)}`);
  assert.deepEqual(frame0.slice(0, 7), ["5:14", "6:94", "0:da", "1:2b", "2:0", "3:8", "4:11"]);
  assert.ok(frame0.includes("24:1"));
  assert.deepEqual(rows.filter((r) => r[2] === 1).map((r) => [r[0], r[1]]), [[24, 2]]);
  const frame3 = rows.filter((r) => r[2] === 3).map((r) => `${r[0]}:${r[1].toString(16)}`);
  assert.deepEqual(frame3, ["0:0", "1:2c", "4:10", "21:1", "22:8", "23:f1", "24:42"]);
  assert.equal(t.approximate, true);
  assert.ok(t.warnings.length > 0);
});

test("siddump: the real table parses; timed frames and malformed rows", () => {
  const t = parseSiddump(siddump);
  assert.ok(t.count > 100, String(t.count));
  assert.ok(t.records[t.records.length - 1] > 100 * 19656);
  const timed = "|0:01.25| 0100  C-0 80  41 0000 000 | ....  ... ..  .. .... ... | ....  ... ..  .. .... ... | .... .. ... . |\n";
  assert.equal(Math.round(parseSiddump(timed).records[3] / 19656), 75);
  assert.throws(() => parseSiddump("no table here"), InterchangeUsageError);
  assert.throws(() => parseSiddump("| 1 | 12 |\n"), InterchangeUsageError);
  assert.throws(() => parseSiddump(timed + timed), (e) => e instanceof InterchangeUsageError && /does not follow/.test(e.message));
  assert.throws(() => parseSiddump(timed.replace("0100 ", "01ZZ ")), InterchangeUsageError);
});

test("reconstruction from a VICE dump gives the same notes as reconstruction from the SID file", async () => {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const result = await reconstructFromTrace(parseViceDump(vice), { engine, seconds: 3 });
  assert.equal(result.trace.format, "vice-dump");
  assert.equal(result.report.horizon.seconds, 3);
  assert.ok(result.report.recovery.noteCount >= 4, `notes ${result.report.recovery.noteCount}`);
  assert.ok(result.score.includes("sidwave:"));
  assert.equal(result.report.compile.ok, true);
  const sid = new Uint8Array(read("fur-elise.sid"));
  const { reconstructSid } = await import("../src/reconstruct/reconstruct.js");
  const direct = await reconstructSid(sid, { engine, seconds: 3 });
  assert.equal(result.report.recovery.noteCount, direct.report.recovery.noteCount);
  assert.equal(result.report.recovery.instrumentCount, direct.report.recovery.instrumentCount);
});

test("reconstruction from siddump is approximate and says so", async () => {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const result = await reconstructFromTrace(parseSiddump(siddump), { engine, seconds: 8 });
  assert.equal(result.trace.approximate, true);
  assert.ok(result.report.recovery.noteCount >= 10, `notes ${result.report.recovery.noteCount}`);
  await assert.rejects(() => reconstructFromTrace(parseViceDump(""), { engine }), RangeError);
});

test("command line: reconstruct --from, export --format vice-dump, errors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swtrace-"));
  const f = (n) => path.join(tmp, n);
  fs.copyFileSync(new URL("fur-elise.vice-dump.txt", dir), f("a.dump"));
  fs.copyFileSync(new URL("fur-elise.siddump.txt", dir), f("a.txt"));
  fs.copyFileSync(new URL("fur-elise.yaml", dir), f("score.yaml"));
  let r = await cli(["reconstruct", "a.dump", "--from", "vice-dump", "--seconds", "3", "-o", "out.yaml"], tmp);
  assert.ok(r.code === 0 || r.code === 1, r.err);
  assert.match(r.err, /vice-dump trace of \d+ writes/);
  assert.ok(fs.readFileSync(f("out.yaml"), "utf8").includes("sidwave:"));
  r = await cli(["reconstruct", "a.txt", "--from=siddump", "--seconds", "5", "--json"], tmp);
  const json = JSON.parse(r.out);
  assert.equal(json.command, "reconstruct");
  assert.equal(json.result.trace.approximate, true);
  r = await cli(["reconstruct", "a.txt", "--from", "gt"], tmp);
  assert.equal(r.code, 2);
  r = await cli(["reconstruct", "score.yaml", "--from", "vice-dump", "--json"], tmp);
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).error.category, "input");
  r = await cli(["export", "score.yaml", "--format", "vice-dump", "--seconds", "2", "-o", "x.dump"], tmp);
  assert.equal(r.code, 0, r.err);
  const dump = fs.readFileSync(f("x.dump"), "latin1");
  assert.ok(parseViceDump(dump).count > 100);
  assert.equal(exportViceDump(parseViceDump(dump).records), dump);
  r = await cli(["export", "score.yaml", "--format", "midi", "--seconds", "2"], tmp);
  assert.equal(r.code, 2);
  r = await cli(["export", "score.yaml", "-o", "y.dump"], tmp);
  assert.equal(r.code, 0, r.err);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("export then import of a VICE dump reproduces the trace of the compiled score", async () => {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swtrace-"));
  fs.copyFileSync(new URL("fur-elise.yaml", dir), path.join(tmp, "score.yaml"));
  const r = await cli(["export", "score.yaml", "--format", "vice-dump", "--seconds", "2", "--json"], tmp);
  assert.equal(r.code, 0, r.err);
  const dump = JSON.parse(r.out).result.dump;
  const imported = parseViceDump(dump);
  const compiled = compileSidwaveBytes(parseSidwave(fs.readFileSync(new URL("fur-elise.yaml", dir), "utf8")), { format: "sid", loop: false });
  const t = await engine.trace({ sid: new Uint8Array(compiled.bytes), seconds: 2, clock: "PAL" });
  const live = [];
  for (let i = 0; i < t.records.length; i += 4) if (t.records[i + 3] <= t.horizonCycles && t.records[i + 1] <= 24) live.push(t.records.slice(i, i + 4));
  assert.equal(imported.count, live.length);
  for (const k of [0, 1, 50, live.length - 1]) assert.deepEqual(Array.from(imported.records.slice(k * 4, k * 4 + 4)), Array.from(live[k]).map((v, i) => (i === 0 ? 0 : v)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("fuzz: 1500 mutated VICE dumps and 1500 mutated siddump tables give only typed errors", () => {
  const a = fuzz({ seed: 11, cases: 1500, base: [new Uint8Array(vice.subarray(0, 4000))], parse: (b) => parseViceDump(b), typed: [InterchangeUsageError] });
  const b = fuzz({ seed: 12, cases: 1500, base: [new Uint8Array(siddump.subarray(0, 6000))], parse: (x) => parseSiddump(x), typed: [InterchangeUsageError] });
  assert.ok(a.accepted > 0 && a.rejected > 0, JSON.stringify(a));
  assert.ok(b.accepted > 0 && b.rejected > 0, JSON.stringify(b));
});

test("CPU time: a 16 MiB VICE dump, its export, and a large siddump table parse in linear time", () => {
  const line = "19656 4 65\n";
  const text = Buffer.from(line.repeat(Math.floor((16 * 1024 * 1024) / line.length)));
  assert.ok(text.length > 15_000_000);
  const parsed = cpuMs(() => parseViceDump(text));
  assert.equal(parsed.value.count, Math.floor((16 * 1024 * 1024) / line.length));
  assert.ok(parsed.value.count < MAX_IMPORT_RECORDS);
  const exported = cpuMs(() => exportViceDump(parsed.value.records));
  assert.equal(exported.value.length, text.length);
  const rows = siddump.toString("latin1").split("\n").filter((l) => l.startsWith("|") && !l.includes("Frame"));
  const manyRows = Array.from({ length: 400 * rows.length }, (_, i) => `| ${String(i).padStart(5)} ${rows[i % rows.length].slice(8)}`).join("\n");
  const sd = cpuMs(() => parseSiddump(manyRows));
  const frame = sd.value.count;
  assert.ok(frame > 20_000, String(frame));
  console.log(`CPU: VICE dump parse ${parsed.ms.toFixed(0)} ms (${(text.length / 1e6).toFixed(1)} MB, ${parsed.value.count} writes), export ${exported.ms.toFixed(0)} ms, siddump parse ${sd.ms.toFixed(0)} ms (${(manyRows.length / 1e6).toFixed(1)} MB, ${frame} writes)`);
  assert.ok(parsed.ms < 3000 && exported.ms < 3000 && sd.ms < 5000);
});

test("command line: reconstruct detects VICE dumps and siddump tables without --from, and the errors say what to do", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swtrace-"));
  fs.copyFileSync(new URL("fur-elise.vice-dump.txt", dir), path.join(tmp, "a.dump"));
  fs.copyFileSync(new URL("fur-elise.siddump.txt", dir), path.join(tmp, "a.txt"));
  fs.copyFileSync(new URL("fur-elise.sid", dir), path.join(tmp, "a.sid"));
  let r = await cli(["reconstruct", "a.dump", "--seconds", "2", "--json"], tmp);
  assert.equal(JSON.parse(r.out).result.trace.format, "vice-dump");
  r = await cli(["reconstruct", "a.txt", "--seconds", "3", "--json"], tmp);
  assert.equal(JSON.parse(r.out).result.trace.format, "siddump");
  r = await cli(["reconstruct", "a.sid", "--seconds", "2", "--json"], tmp);
  assert.equal(JSON.parse(r.out).command, "reconstruct");
  assert.equal(JSON.parse(r.out).result.trace, undefined, "a SID file still takes the SID path");
  r = await cli(["reconstruct", "a.txt", "--from", "vice-dump", "--json"], tmp);
  assert.equal(r.code, 3);
  assert.match(JSON.parse(r.out).error.message, /looks like a siddump, pass --from siddump/);
  fs.writeFileSync(path.join(tmp, "x.bin"), "hello");
  r = await cli(["reconstruct", "x.bin", "--from", "vice-dump", "--json"], tmp);
  assert.match(JSON.parse(r.out).error.message, /vsid -sounddev dump/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
