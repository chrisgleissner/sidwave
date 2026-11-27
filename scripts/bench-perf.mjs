#!/usr/bin/env node
// Measures CPU time (process.cpuUsage) and wall time of the SIDWave operations on every bundled example and on
// representative large synthetic inputs. Each operation runs once cold (reported as `cold`), then five times warm;
// the report holds the median of the five warm runs. Requires a build (`npm run build`).
//
// Usage: node scripts/bench-perf.mjs [--filter <substring>] [--runs <n>] [--out <file>] [--dist <dir>] [--examples a,b] [--no-engine] [--no-cli]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = resolve(process.argv.includes("--dist") ? process.argv[process.argv.indexOf("--dist") + 1] : join(root, "sidwave", "dist"));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const filter = value("--filter", "");
const runs = Number(value("--runs", "5"));
const outFile = value("--out", join(homedir(), ".c64bridge", "sidwave-standalone", "perf", `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));

const sw = await import(`${pkg}/index.js`);
const { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid, lintSidwave, SIDWAVE_EXAMPLES, readSidwaveExample } = sw;
const { compileSidwave } = await import(`${pkg}/sidwaveGame.js`);
const { formatSidwave, diffSidwave, mergeSidwave } = await import(`${pkg}/format/sidwaveFormat.js`);
const { transpose } = await import(`${pkg}/transform/index.js`);
const { compareTraces } = await import(`${pkg}/verify/index.js`);
const { compareAudioA1, loadA1Rules } = await import(`${pkg}/verify/a1.js`);
const { buildIr } = await import(`${pkg}/reconstruct/ir.js`);
const { fdiff } = await import(`${pkg}/reconstruct/fdiff.js`);
const { traceFeatures, extractFeatures } = await import(`${pkg}/reconstruct/features.js`);
const { analyse, expectedSchedule } = await import(`${pkg}/audio/sidwaveFidelity.js`);
const { analyseQuality } = await import(`${pkg}/audio/sidwaveQuality.js`);
const { compareToReference } = await import(`${pkg}/audio/sidwaveSimilarity.js`);
const toolkit = await import(resolve(root, "6502-toolkit", "dist", "index.js"));

const results = [];
function measure(name, fn, { warmRuns = runs } = {}) {
  if (filter && !name.includes(filter)) return;
  const sample = () => {
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    fn();
    const w1 = performance.now();
    const c = process.cpuUsage(c0);
    return { cpu: (c.user + c.system) / 1000, wall: w1 - w0 };
  };
  let cold;
  try { cold = sample(); } catch (error) { console.error(`${name} skipped: ${error.message.slice(0, 80)}`); return; }
  const warm = Array.from({ length: warmRuns }, sample);
  const median = (key) => warm.map((s) => s[key]).sort((a, b) => a - b)[warm.length >> 1];
  results.push({ name, coldCpuMs: +cold.cpu.toFixed(2), cpuMs: +median("cpu").toFixed(2), wallMs: +median("wall").toFixed(2) });
  console.error(`${name} ${results.at(-1).cpuMs} ms`);
}
async function measureAsync(name, fn) {
  if (filter && !name.includes(filter)) return;
  const sample = async () => {
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    await fn();
    const w1 = performance.now();
    const c = process.cpuUsage(c0);
    return { cpu: (c.user + c.system) / 1000, wall: w1 - w0 };
  };
  const cold = await sample();
  const warm = [];
  for (let i = 0; i < Math.min(runs, 3); i++) warm.push(await sample());
  const median = (key) => warm.map((s) => s[key]).sort((a, b) => a - b)[warm.length >> 1];
  results.push({ name, coldCpuMs: +cold.cpu.toFixed(2), cpuMs: +median("cpu").toFixed(2), wallMs: +median("wall").toFixed(2) });
}

// ---- scores ----------------------------------------------------------------------------------------------------
const all = [...SIDWAVE_EXAMPLES.map((e) => e.name), "fuer_elise"];
const names = value("--examples", "") ? value("--examples", "").split(",") : all;
for (const name of names) {
  const text = readSidwaveExample(name);
  const doc = parseSidwave(text);
  measure(`parse/${name}`, () => parseSidwave(text));
  measure(`lint/${name}`, () => lintSidwave(doc));
  measure(`compilePrg/${name}`, () => compileSidwaveToPrg(doc));
  measure(`parse+compilePrg/${name}`, () => compileSidwaveToPrg(parseSidwave(text)));
  const prg = compileSidwaveToPrg(doc);
  measure(`compileSid/${name}`, () => compileSidwaveToSid(doc, prg.prg, { initAddress: prg.initAddress, playAddress: prg.playAddress }));
  measure(`format/${name}`, () => formatSidwave(text));
  const shifted = transpose(text, { semitones: 1, validate: false }).text;
  measure(`transpose/${name}`, () => transpose(text, { semitones: 1, validate: false }));
  measure(`diff/${name}`, () => diffSidwave(text, shifted));
  measure(`merge/${name}`, () => mergeSidwave(text, shifted, text));
  if (name !== "fuer_elise" && !name.startsWith("game_")) {
    measure(`gameBuild/${name}`, () => compileSidwave(doc, { target: "game", origin: 0x1000, symbols: ["acme", "json"] }));
  }
}

// ---- convert hub (detect, read, plan, write, verify; no engine) -------------------------------------------------
{
  const { convert } = await import(`${pkg}/interchange/convert.js`);
  const { readFileSync } = await import("node:fs");
  const fixtures = join(root, "sidwave", "test", "fixtures", "convert");
  const score = (n) => new TextEncoder().encode(readSidwaveExample(n));
  const jobs = [
    ["convert/chiptune_drive.yaml->midi", score("chiptune_drive"), "midi"],
    ["convert/chiptune_drive.yaml->goattracker", score("chiptune_drive"), "goattracker"],
    ["convert/chamber_waltz.mid->musicxml", readFileSync(join(fixtures, "chamber-waltz.mid")), "musicxml"],
    ["convert/chiptune-drive.sng->midi+verify", readFileSync(join(fixtures, "chiptune-drive.sng")), "midi", true],
  ];
  for (const [name, bytes, to, verify] of jobs) {
    await measureAsync(name, () => convert(bytes, { to, ...(verify ? { verify: true } : {}) }));
  }
}

// ---- SID file, songlengths ------------------------------------------------------------------------------------
{
  const doc = parseSidwave(readSidwaveExample("chiptune_drive"));
  const prg = compileSidwaveToPrg(doc);
  const sid = new Uint8Array(compileSidwaveToSid(doc, prg.prg, { initAddress: prg.initAddress, playAddress: prg.playAddress }).sid);
  measure("sidParse", () => sw.parseSidFile(sid));
  const parsed = sw.parseSidFile(sid);
  measure("sidMd5", () => sw.md5ForSonglengths(sid));
  const lines = ["[Database]"];
  for (let i = 0; i < 60000; i++) lines.push(`; /MUSICIANS/X/Tune_${i}.sid`, `${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${(i * 40503 >>> 0).toString(16).padStart(8, "0")}${"0".repeat(16)}=3:${String(i % 60).padStart(2, "0")} 1:30`);
  const text = lines.join("\n");
  measure("songlengthsParse/60k", () => sw.parseSonglengths(text), { warmRuns: 3 });
  const db = sw.parseSonglengths(text);
  measure("songlengthsLookup", () => sw.lookupSonglength(db, sid, 1));
  void parsed;
}

// ---- traces, IR, F-diff ---------------------------------------------------------------------------------------
function syntheticTrace(seconds, seed = 1) {
  const frames = Math.floor(seconds * 50);
  const out = [];
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let f = 0; f < frames; f++) {
    const base = f * 19656 + 40;
    let c = base;
    for (let v = 0; v < 3; v++) {
      const note = (f >> 3) % 7 + v * 5 + (rnd() < 0.05 ? 1 : 0);
      out.push(0, v * 7, (note * 37) & 0xff, c, 0, v * 7 + 1, (note * 11) & 0xff, c + 8, 0, v * 7 + 4, f % 8 === 0 ? 0x41 : 0x40, c + 16);
      c += 40;
    }
    out.push(0, 24, 15, c + 20, 0, 22, (f * 3) & 0xff, c + 28);
  }
  return Float64Array.from(out);
}
{
  const t180 = syntheticTrace(180);
  const t180b = syntheticTrace(180);
  measure("t0t1Compare/180s", () => compareTraces(t180, t180b));
  const t180c = Float64Array.from(t180); for (let i = 3; i < t180c.length; i += 4) t180c[i] += 3;
  measure("t0t1Compare/180s-offset", () => compareTraces(t180, t180c));
  const t60 = syntheticTrace(60);
  measure("buildIr/60s", () => buildIr(t60));
  measure("buildIr/180s", () => buildIr(t180));
  const ir = buildIr(t60), ir2 = buildIr(syntheticTrace(60, 7));
  measure("fdiff/60s", () => fdiff(ir, ir2));
  measure("traceFeatures/60s", () => traceFeatures(ir));
  measure("extractFeatures/60s", () => extractFeatures(ir));
}

// ---- audio -----------------------------------------------------------------------------------------------------
function syntheticPcm(seconds, seed = 3) {
  const n = Math.floor(seconds * 48000);
  const out = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const t = i / 48000;
    out[i] = Math.round(6000 * Math.sin(2 * Math.PI * (220 + 110 * Math.floor(t * 2) % 5) * t) + 2500 * Math.sin(2 * Math.PI * 880 * t) + ((s >>> 20) - 2048) * 0.3);
  }
  return out;
}
{
  const rules = loadA1Rules();
  const ref = syntheticPcm(30), cand = syntheticPcm(30, 9);
  measure("a1/30s", () => compareAudioA1(ref, cand, rules));
  measure("a1/30s-identical", () => compareAudioA1(ref, ref, rules));
  const stereo = (pcm) => { const l = new Float32Array(pcm.length), r = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) { l[i] = pcm[i] / 32768; r[i] = l[i] * 0.9; } return { left: l, right: r, sampleRate: 48000 }; };
  const p20 = syntheticPcm(20);
  const st = stereo(p20), st2 = stereo(syntheticPcm(20, 5));
  const doc = parseSidwave(readSidwaveExample("chiptune_drive"));
  const schedule = expectedSchedule(doc);
  measure("expectedSchedule/chiptune_drive", () => expectedSchedule(doc));
  const inter = new Int16Array(p20.length * 2); for (let i = 0; i < p20.length; i++) { inter[2 * i] = p20[i]; inter[2 * i + 1] = p20[i]; }
  measure("fidelity/20s", () => analyse(inter, 48000, schedule, { latencySearchMs: 500 }), { warmRuns: 3 });
  measure("quality/20s", () => analyseQuality({ signal: st, schedule }), { warmRuns: 3 });
  measure("similarity/20s", () => compareToReference(st, st2, { halfBarSeconds: 1 }), { warmRuns: 3 });
}

// ---- generator ---------------------------------------------------------------------------------------------------
for (const style of ["chiptune", "funk"]) {
  measure(`generate/${style}`, () => sw.generateSidwave({ root: "C3", style, seed: 65, preset: "classic", system: "PAL" }));
}

// ---- 6502 toolkit and emulator ---------------------------------------------------------------------------------
{
  const doc = parseSidwave(readSidwaveExample("chiptune_drive"));
  const prg = compileSidwaveToPrg(doc);
  const bytes = prg.prg.subarray(2);
  measure("disassemble/prg", () => toolkit.disassemble(bytes, 0x0801, bytes.length));
  const asm = readFileSync(join(root, "sidwave", "examples", "game", "raster_bars.asm"), "utf8");
  measure("assemble/raster_bars", () => toolkit.assemblyToPrg(asm, { resolveInclude: (p) => readFileSync(join(root, "sidwave", "examples", "game", p), "utf8") }));
  const big = Array.from({ length: 4000 }, (_, i) => `l${i}: lda #$${(i & 255).toString(16).padStart(2, "0")}\n sta $d020\n jmp l${(i + 1) % 4000}\n`).join("");
  measure("assemble/12k-lines", () => toolkit.assemblyToPrg(`* = $1000\n${big}`), { warmRuns: 3 });
}

// ---- engine ----------------------------------------------------------------------------------------------------
if (!flag("--no-engine")) {
  try {
    const { createLibsidplayfpEngine } = await import(`${pkg}/engine/libsidplayfp.js`);
    const doc = parseSidwave(readSidwaveExample("chiptune_drive"));
    const prg = compileSidwaveToPrg(doc);
    const sid = new Uint8Array(compileSidwaveToSid(doc, prg.prg, { initAddress: prg.initAddress, playAddress: prg.playAddress }).sid);
    const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
    await measureAsync("engineRender/30s", () => engine.render({ sid, seconds: 30, sampleRate: 48000, channels: 1 }));
    await measureAsync("engineTrace/30s", () => engine.trace({ sid, seconds: 30 }));
    const { verifySid } = await import(`${pkg}/verify/index.js`);
    await measureAsync("verifySid/5s", () => verifySid(sid, sid, { engine, pcmEngine: engine, seconds: 5 }));
  } catch (error) {
    console.error(`engine benchmarks skipped: ${error.message}`);
  }
}

// ---- CLI cold start (new process per sample) -------------------------------------------------------------------
if (!flag("--no-cli")) {
  const bin = join(pkg, "bin.js");
  const file = join(root, "sidwave", "data", "sound", "examples", "chiptune_drive.yaml");
  for (const [label, argv] of [["validate", ["validate", file]], ["compile", ["compile", file, "-o", "-"]], ["lint", ["lint", file]], ["help", ["--help"]]]) {
    if (filter && !`cli/${label}`.includes(filter)) continue;
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [bin, ...argv], { encoding: "buffer", maxBuffer: 1 << 26 });
      samples.push({ wall: performance.now() - t0, status: r.status });
    }
    const wall = samples.map((s) => s.wall).sort((a, b) => a - b)[samples.length >> 1];
    results.push({ name: `cli/${label}`, coldCpuMs: null, cpuMs: null, wallMs: +wall.toFixed(1) });
  }
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ node: process.version, date: new Date().toISOString(), runs, results }, null, 2));
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.name.padEnd(width)}  cpu ${String(r.cpuMs).padStart(9)} ms  wall ${String(r.wallMs).padStart(9)} ms  cold ${String(r.coldCpuMs).padStart(9)} ms`);
console.error(`wrote ${outFile}`);
