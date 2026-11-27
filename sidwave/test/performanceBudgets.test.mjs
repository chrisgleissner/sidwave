import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { readSidwaveExample } from "../src/sidwaveExamples.ts";
import { formatSidwave, diffSidwave } from "../src/format/sidwaveFormat.ts";
import { compareTraces } from "../src/verify/index.ts";
import { compareAudioA1, loadA1Rules } from "../src/verify/a1.ts";
import { buildIr } from "../src/reconstruct/ir.ts";
import { parseSonglengths } from "../src/songlengths.ts";
import { writeSidFile } from "../src/sidFile.ts";
import { editSidHeader } from "../src/sidEdit.ts";
import { parseStil, queryStil } from "../src/stil.ts";
import { songlengthsKey, writeSonglengthsEntry } from "../src/songlengthsFile.ts";
import { identifyPlayerInData, parseSidIdConfig } from "../src/sidId.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.ts";
import { resolveCutoff } from "../src/sidwaveFilterModel.ts";
import { convert } from "../src/interchange/convert.ts";

// CPU-time budgets (see doc/performance.md). Each operation is measured as the smallest CPU time of a few runs, and
// compared with the CPU time of a fixed reference workload measured the same way in the same process. A slow or busy
// machine scales both, so the bound is a multiple of the reference and not an absolute time. The multiples are
// about five times the measured ratio: they catch a complexity regression (a quadratic scan, a repeated parse), not
// a few percent of drift. resolveCutoff is far below the reference when it is fast (0.03 x) and about 15 x with the
// old scan of 2048 codes per lookup, so its bound is 3 x.

function cpuMs(fn) {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

// A mixed workload of allocation, sorting and JSON, the kind of work the measured operations do. A tight arithmetic
// loop was tried first and rejected: in the same Node version it took 3 ms in one process and 15 ms in another.
function referenceLoop() {
  const items = [];
  let seed = 7;
  for (let i = 0; i < 30_000; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    items.push({ k: seed % 1000, name: `n${seed % 977}`, v: [seed & 255, i] });
  }
  items.sort((x, y) => x.k - y.k || (x.name < y.name ? -1 : 1));
  const json = JSON.stringify(items);
  return JSON.parse(json).length + json.length;
}

/**
 * The smallest CPU time of `runs` runs of `fn` and of the reference loop. The two are run alternately, so that a
 * period of contention on a shared machine raises both and the smallest values come from similar conditions.
 */
function measure(fn, runs = 5) {
  // The reference loop is warmed up in this call, because its first runs are several times slower than the optimised
  // ones (the engine tiers up the loop), and the budgets are checked one after the other.
  for (let i = 0; i < 3; i++) referenceLoop();
  fn();
  let op = Infinity;
  let reference = Infinity;
  for (let i = 0; i < Math.max(runs, 5); i++) {
    reference = Math.min(reference, cpuMs(() => { if (referenceLoop() < 0) throw new Error("unreachable"); }));
    op = Math.min(op, cpuMs(fn));
  }
  return { op, reference };
}

function within(name, fn, multiple, runs) {
  const { op, reference } = measure(fn, runs);
  if (process.env.SIDWAVE_PERF_REPORT) console.log(`${name}: ${op.toFixed(1)} ms = ${(op / reference).toFixed(1)} x reference (${reference.toFixed(2)} ms), limit ${multiple} x`);
  const limit = multiple * reference;
  assert.ok(op <= limit, `${name} took ${op.toFixed(1)} ms CPU, over ${limit.toFixed(1)} ms (${multiple} x the reference loop of ${reference.toFixed(2)} ms)`);
}

const text = readSidwaveExample("chiptune_drive");

test("parse of a normal example stays within its budget", () => {
  within("parse", () => parseSidwave(text), 5.5);
});

test("compile to PRG stays within its budget", () => {
  const doc = parseSidwave(text);
  within("compile", () => compileSidwaveToPrg(doc), 13, 3);
});

test("format and semantic diff stay within their budgets", () => {
  within("format", () => formatSidwave(text), 5.5);
  const changed = text.replace(/tempo: *(\d+)/, (_, t) => `tempo: ${Number(t) + 1}`);
  assert.ok(changed !== text);
  within("diff", () => diffSidwave(text, changed), 50, 3);
});

test("a filter cutoff given in Hz resolves without scanning every register code each time", () => {
  within("resolveCutoff", () => { for (let i = 0; i < 3000; i++) resolveCutoff(`${300 + i * 5}Hz`, "6581", "$"); }, 3);
});

test("Songlengths parsing is linear", () => {
  const lines = ["[Database]"];
  for (let i = 0; i < 20_000; i++) lines.push(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${(i * 40503 >>> 0).toString(16).padStart(8, "0")}${"0".repeat(16)}=3:${String(i % 60).padStart(2, "0")}`);
  within("parseSonglengths", () => parseSonglengths(lines.join("\n")), 3.5, 3);
});

// HVSC tools. The inputs are synthetic and shaped like the HVSC files: Songlengths.md5 has a "; /path" line above every
// entry and CRLF line breaks, STIL.txt has entries of 4 to 8 lines. The real files are timed in hvsc*.test.mjs.
function syntheticSonglengths(entries) {
  const lines = ["[Database]"];
  for (let i = 0; i < entries; i++) {
    lines.push(`; /MUSICIANS/${String.fromCharCode(65 + (i % 26))}/Artist_${i % 500}/Tune_${i}.sid`);
    lines.push(`${(Math.imul(i, 2654435761) >>> 0).toString(16).padStart(8, "0")}${(Math.imul(i, 40503) >>> 0).toString(16).padStart(8, "0")}${"0".repeat(16)}=${i % 9}:${String(i % 60).padStart(2, "0")}${i % 4 === 0 ? `.${(i * 7) % 1000}` : ""}${i % 5 === 0 ? ` 1:${String(i % 60).padStart(2, "0")} 0:30` : ""}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function syntheticStil(entries) {
  const lines = ["#  STIL v83 - SID Tune Information List", ""];
  for (let i = 0; i < entries; i++) {
    lines.push(`/MUSICIANS/${String.fromCharCode(65 + (i % 26))}/Artist_${i % 500}/Tune_${i}.sid`);
    if (i % 3 === 0) lines.push("COMMENT: A comment that runs over two lines, as many of the real", "         comments do.");
    lines.push("(#1)", `   NAME: Tune ${i}`, `  TITLE: Title ${i} [from Album ${i % 40}] (0:00-1:${String(i % 60).padStart(2, "0")})`, " ARTIST: Some Artist");
    if (i % 2 === 0) lines.push("(#2)", `  TITLE: Other ${i}`, " ARTIST: Another Artist");
    lines.push("");
  }
  return `${lines.join("\r\n")}\r\n`;
}

test("Songlengths.md5 of 60,000 entries parses, and a lookup and a write stay within their budgets", () => {
  const text = syntheticSonglengths(60_000);
  within("songlengthsParse60k", () => parseSonglengths(text), 6, 3);
  const db = parseSonglengths(text);
  const payload = Uint8Array.from({ length: 4000 }, (_, i) => (i * 31) & 0xff);
  const sid = writeSidFile({ magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 3, startSong: 1, speed: 0, name: "n", author: "a", released: "r", payload });
  within("songlengthsLookup", () => { for (let i = 0; i < 1000; i++) db.get(songlengthsKey(sid, "md5")); }, 1);
  within("songlengthsWrite60k", () => writeSonglengthsEntry(text, { md5: "f".repeat(32), durations: [1000, 2000, 3000], path: "/MUSICIANS/M/Artist_1/Mid.sid" }), 5, 3);
});

test("STIL of 18,000 entries parses and a query stays within its budget", () => {
  const text = syntheticStil(18_000);
  within("stilParse18k", () => parseStil(text), 6, 3);
  const db = parseStil(text);
  within("stilQuery", () => { for (let i = 0; i < 2000; i++) queryStil(db, `/MUSICIANS/${String.fromCharCode(65 + (i % 26))}/Artist_${i % 500}/Tune_${i}.sid`); }, 1);
});

test("SID header edit and SIDId identification stay within their budgets", () => {
  const payload = Uint8Array.from({ length: 20_000 }, (_, i) => (Math.imul(i, 2654435761) >>> 24) & 0xff);
  const sid = writeSidFile({ magic: "PSID", version: 2, loadAddress: 0x1000, initAddress: 0x1000, playAddress: 0x1003, songs: 3, startSong: 1, speed: 0, name: "n", author: "a", released: "r", payload });
  within("sidEdit", () => { for (let i = 0; i < 200; i++) editSidHeader(sid, { author: `Author ${i}`, clock: i % 2 ? "PAL" : "NTSC" }); }, 6);
  const cfg = [];
  for (let i = 0; i < 750; i++) cfg.push(`Player_${i}`, `${(i * 7 % 256).toString(16).padStart(2, "0")} ${(i * 13 % 256).toString(16).padStart(2, "0")} ?? A9 ${(i % 200).toString(16).padStart(2, "0")} 8D 18 D4 END`, `4C ${(i * 3 % 256).toString(16).padStart(2, "0")} ?? ?? AND 60 ${(i * 11 % 256).toString(16).padStart(2, "0")} 60 END`);
  const text = `${cfg.join("\r\n")}\r\n`;
  within("sididParse", () => parseSidIdConfig(text), 1, 3);
  const db = parseSidIdConfig(text);
  within("sididIdentify", () => { for (let i = 0; i < 10; i++) identifyPlayerInData(payload, db, { all: true }); }, 15);
});

function syntheticTrace(seconds) {
  const out = [];
  for (let f = 0; f < seconds * 50; f++) {
    let c = f * 19656 + 40;
    for (let v = 0; v < 3; v++) {
      const note = (f >> 3) % 7 + v * 5;
      out.push(0, v * 7, (note * 37) & 0xff, c, 0, v * 7 + 1, (note * 11) & 0xff, c + 8, 0, v * 7 + 4, f % 8 === 0 ? 0x41 : 0x40, c + 16);
      c += 40;
    }
  }
  return Float64Array.from(out);
}

test("T0/T1 comparison of 3-minute traces and trace IR of one minute stay within their budgets", () => {
  const a = syntheticTrace(180);
  const b = syntheticTrace(180);
  within("compareTraces", () => compareTraces(a, b), 4.5, 3);
  const minute = syntheticTrace(60);
  within("buildIr", () => buildIr(minute), 1.5, 3);
});

test("A1 comparison of 10 seconds of audio stays within its budget", () => {
  const pcm = (seed) => {
    const out = new Int16Array(48_000 * 10);
    let s = seed;
    for (let i = 0; i < out.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = Math.round(6000 * Math.sin(i / 21.7) + ((s >>> 20) - 2048) * 0.3);
    }
    return out;
  };
  const rules = loadA1Rules();
  const reference_ = pcm(3);
  const candidate = pcm(9);
  within("A1", () => compareAudioA1(reference_, candidate, rules), 30, 3);
});

test("convert of a score to MIDI and to GoatTracker, with --verify, stays within its budget", async () => {
  const bytes = new TextEncoder().encode(text);
  // The hub parses the score, plans, writes and (with verify) reads the output back; it is dominated by those stages.
  for (const [to, multiple] of [["midi", 24], ["goattracker", 24]]) {
    await convert(bytes, { to, verify: true });
    const runs = [];
    for (let i = 0; i < 5; i++) { const before = process.cpuUsage(); await convert(bytes, { to, verify: true }); const u = process.cpuUsage(before); runs.push((u.user + u.system) / 1000); }
    const { reference } = measure(() => 0, 5);
    const op = Math.min(...runs);
    if (process.env.SIDWAVE_PERF_REPORT) console.log(`convert ${to}: ${op.toFixed(1)} ms = ${(op / reference).toFixed(1)} x reference (${reference.toFixed(2)} ms), limit ${multiple} x`);
    assert.ok(op <= multiple * reference, `convert to ${to} took ${op.toFixed(1)} ms CPU, over ${(multiple * reference).toFixed(1)} ms (${multiple} x the reference loop of ${reference.toFixed(2)} ms)`);
  }
});

// The authoring commands, run in the process (startup of node is not part of them). Each one reads its input files,
// does the work of the library function and writes its result, so the budgets include the file system calls.
test("the authoring commands of the command line stay within their budgets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-perf-"));
  try {
    const file = (name, content) => { fs.writeFileSync(path.join(dir, name), content); return name; };
    const base = file("base.yaml", text);
    const ours = file("ours.yaml", text.replace(/tempo: *(\d+)/, (_, t) => `tempo: ${Number(t) + 1}`));
    const theirs = file("theirs.yaml", text.replace(/^title:.*$/m, 'title: "Other"'));
    const formatted = file("formatted.yaml", formatSidwave(text));
    const cli = (...args) => {
      const code = runCli(args, { cwd: dir, out() {}, err() {}, outBytes() {} });
      if (code > 1) throw new Error(`sidwave ${args.join(" ")} exited ${code}`);
    };
    within("cli format --check", () => cli("format", formatted, "--check"), 8);
    within("cli diff", () => cli("diff", base, ours), 10, 3);
    within("cli transform --transpose --validate parse", () => cli("transform", base, "--transpose", "2", "--validate", "parse"), 10, 3);
    within("cli transform chain of three", () => cli("transform", base, "--transpose", "2", "--tempo", "120", "--quantise", "0.25"), 25, 3);
    within("cli diff --compile", () => cli("diff", base, ours, "--compile"), 50, 3);
    within("cli merge", () => cli("merge", base, ours, theirs), 30, 3);
    within("cli transform --transpose (default check)", () => cli("transform", base, "--transpose", "2"), 22, 3);
    within("cli transform --transpose --validate compile", () => cli("transform", base, "--transpose", "2", "--validate", "compile"), 35, 3);
    within("cli generate (composer 2)", () => cli("generate", "--seed", "3"), 6, 3);
    within("cli generate --prg --sid", () => cli("generate", "--seed", "3", "--prg", path.join(dir, "g.prg"), "--sid", path.join(dir, "g.sid"), "--force"), 12, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
