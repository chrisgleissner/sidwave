#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
//
// Corpus development run of SIDWave reconstruction (design: S5 reconstruction, work package S5d).
//
//   HVSC_DIR=/path/to/C64Music nice -n 10 node scripts/reconstruct-corpus.mjs [options]
//
// For each development tune of sidwave/data/reconstruct/corpus-manifest.json: reconstruct at the design horizon
// (the Songlengths length or 180 s, whichever is shorter), recompile, strict F-diff, registerStateExact, A1 (approximate
// status) when ROMs are available, score size and run time. A shorter horizon is declared per tune and never silent.
// Held-out tunes are never run. Results are cached by the content hash of the input, the settings and the code
// versions. Output: dev-report.json (no SID data, no scores) and dev-report.md. Run it after `npm run build`.

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "sidwave", "dist");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const MAX_WORKERS = 4;
const DESIGN_HORIZON = 180;
const SCRIPT_VERSION = 2;

const { values: args } = parseArgs({
  options: {
    manifest: { type: "string", default: path.join(root, "sidwave/data/reconstruct/corpus-manifest.json") },
    out: { type: "string", default: path.join(root, "sidwave/data/reconstruct/dev-report.json") },
    md: { type: "string" },
    cache: { type: "string", default: path.join(homedir(), ".c64bridge/sidwave-standalone/recon-cache") },
    roms: { type: "string", default: path.join(homedir(), ".c64bridge/sidwave-standalone/open-roms") },
    "no-a1": { type: "boolean", default: false },
    "max-horizon": { type: "string" },
    only: { type: "string" },
    workers: { type: "string", default: "4" },
    "budget-seconds": { type: "string", default: "1500" },
    force: { type: "boolean", default: false },
    label: { type: "string", default: "" },
    "one": { type: "string" },
  },
});

function codeVersion() {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  for (const d of ["reconstruct", "format", "verify", "engine"]) walk(path.join(dist, d));
  for (const f of ["sidwave.js", "sidwaveCompiler.js", "sidwaveOps.js", "sidFile.js", "sidwaveEffects.js", "sidwaveLint.js"]) files.push(path.join(dist, f));
  const h = createHash("sha256");
  for (const f of files) if (existsSync(f)) h.update(path.relative(dist, f)).update(readFileSync(f));
  let engineVersion = "unknown";
  try {
    engineVersion = JSON.parse(readFileSync(path.join(root, "node_modules/libsidplayfp-wasm/package.json"), "utf8")).version;
  } catch { /* unknown */ }
  return { code: h.digest("hex").slice(0, 16), engine: engineVersion };
}

function loadRomsDir(dir) {
  const roms = {};
  for (const [k, f] of [["kernal", "kernal.rom"], ["basic", "basic.rom"], ["chargen", "chargen.rom"]]) {
    const p = path.join(dir, f);
    if (existsSync(p)) roms[k] = new Uint8Array(readFileSync(p));
  }
  return Object.keys(roms).length === 3 ? roms : undefined;
}

let versionsMemo;
function versions() {
  return (versionsMemo ??= codeVersion());
}
const hvsc = process.env.HVSC_DIR;
const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
const maxHorizon = args["max-horizon"] ? Number(args["max-horizon"]) : DESIGN_HORIZON;
const settings = { maxHorizon, a1: !args["no-a1"], scriptVersion: SCRIPT_VERSION };

function horizonOf(tune) {
  const design = Math.min(tune.lengthSeconds, DESIGN_HORIZON);
  const used = Math.min(design, maxHorizon);
  return { designSeconds: design, usedSeconds: used, reduced: used < design, ...(used < design ? { reason: `--max-horizon ${maxHorizon}` } : {}) };
}

function cacheKey(tune, sidBytes, versions) {
  return sha256(JSON.stringify({ sid: sha256(sidBytes), subtune: tune.subtune, horizon: horizonOf(tune), settings, versions })).slice(0, 32);
}

// ---- classification ----------------------------------------------------------------------------------------------

const CLASS_OF = { pitch: "pitch", timing: "timing/call rate", gate: "gate/hard restart", waveform: "waveform", pulse: "pulse", adsr: "ADSR", filter: "filter", volume: "volume" };

function classify(report) {
  if (report.strictExact) return { rootCause: "exact" };
  if (!report.compile?.ok) return { rootCause: "unsupported", why: `recovered score did not compile: ${report.compile?.error ?? "unknown"}` };
  const first = report.fdiff.first;
  if (first) return { rootCause: CLASS_OF[first.class] ?? first.class, why: `first difference in ${first.class}` };
  if (report.fdiff.callCountMismatch) return { rootCause: "structure", why: `call counts ${report.fdiff.callCountMismatch.expected} vs ${report.fdiff.callCountMismatch.observed}` };
  if (!report.fdiff.standardAlignment) return { rootCause: "structure", why: "non-standard alignment" };
  return { rootCause: "structure", why: "no register difference; strict check failed on alignment or call count" };
}

// ---- one tune (child process) -------------------------------------------------------------------------------------

/**
 * Engine wrapper that caches the trace of the original tune on disk. The original trace depends only on the SID,
 * the subtune, the horizon, the clock and the engine version, so it is reused across repair batches. Traces of
 * recompiled scores are never cached.
 */
function cachingEngine(engine, original, engineVersion) {
  return {
    id: engine.id, version: engine.version,
    render: (req) => engine.render(req),
    async trace(req) {
      if (req.sid !== original) return engine.trace(req);
      const key = sha256(JSON.stringify({ sid: sha256(original), song: req.song ?? null, seconds: req.seconds, clock: req.clock ?? null, engineVersion, t: 1 })).slice(0, 32);
      const meta = path.join(args.cache, "traces", `${key}.json`);
      const data = path.join(args.cache, "traces", `${key}.f64.gz`);
      if (existsSync(meta) && existsSync(data)) {
        const m = JSON.parse(readFileSync(meta, "utf8"));
        const buf = gunzipSync(readFileSync(data));
        const records = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        return { ...m, records, samples: new Int16Array(0) };
      }
      const r = await engine.trace(req);
      const { records, samples, ...rest } = r;
      writeAtomic(data, gzipSync(Buffer.from(records.buffer, records.byteOffset, records.byteLength), { level: 1 }));
      writeAtomic(meta, JSON.stringify(rest));
      return r;
    },
  };
}

async function runOne(tune) {
  const sidPath = path.join(hvsc, tune.path);
  const sidBytes = new Uint8Array(readFileSync(sidPath));
  const { createLibsidplayfpEngine } = await import("sidwave/engine");
  const { reconstructSid } = await import("sidwave/reconstruct");
  const { verifySid, loadA1Rules } = await import("sidwave/verify");
  const { md5ForSonglengths } = await import("sidwave/sid-file");
  const md5 = md5ForSonglengths(sidBytes);
  if (md5 !== tune.md5) throw new Error(`MD5 of ${tune.path} is ${md5}, the manifest has ${tune.md5}`);
  const horizon = horizonOf(tune);
  const rawEngine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const engine = cachingEngine(rawEngine, sidBytes, versions().engine);
  const started = Date.now();
  const { score, report, compiled, timings } = await reconstructSid(sidBytes, { engine, song: tune.subtune, seconds: horizon.usedSeconds, title: "Reconstructed" });
  const result = {
    path: tune.path, md5: tune.md5, subtune: tune.subtune, lengthSeconds: tune.lengthSeconds,
    horizon,
    model: tune.header.model, sidCount: tune.header.sidCount, speed: tune.header.speed,
    ...classify(report),
    strictExact: report.strictExact,
    registerStateExact: report.registerStateExact,
    compileOk: report.compile?.ok === true,
    ...(report.compile?.cycleBudgetExceeded ? { cycleBudgetExceeded: report.compile.cycleBudgetExceeded } : {}),
    ...(report.compile?.ok ? {} : { compileError: report.compile?.error }),
    calls: report.horizon.calls,
    callRate: report.callRate,
    fdiff: {
      differingCalls: report.fdiff.differingCalls, comparedCalls: report.fdiff.comparedCalls,
      expectedCalls: report.fdiff.expectedCalls, observedCalls: report.fdiff.observedCalls,
      standardAlignment: report.fdiff.standardAlignment, first: report.fdiff.first ?? null,
      classes: Object.fromEntries(Object.entries(report.fdiff.classes).map(([k, v]) => [k, { differingCalls: v.differingCalls, matchShare: Number(v.matchShare.toFixed(6)) }])),
    },
    fdiffState: {
      differingCalls: report.fdiffState.differingCalls, first: report.fdiffState.first ?? null,
      classes: Object.fromEntries(Object.entries(report.fdiffState.classes).map(([k, v]) => [k, { differingCalls: v.differingCalls, matchShare: Number(v.matchShare.toFixed(6)) }])),
    },
    recovery: report.recovery,
    unsupported: report.unsupported.map((u) => ({ kind: u.kind, detail: u.detail })),
    languageExtensions: report.languageExtensions.map((e) => ({ id: e.id, construct: e.construct, occurrences: e.occurrences, reason: e.reason })),
    scoreBytes: Buffer.byteLength(score),
    scoreSha256: sha256(score),
    compiledBytes: compiled ? compiled.length : null,
  };
  const seconds = horizon.usedSeconds;
  const rec = timings;
  result.timing = {
    wallSeconds: Number((rec.totalMs / 1000).toFixed(2)),
    cpuSeconds: Number((rec.totalCpuMs / 1000).toFixed(2)),
    phasesMs: { trace: Math.round(rec.traceMs), ir: Math.round(rec.irMs), recover: Math.round(rec.recoverMs), compile: Math.round(rec.compileMs), retrace: Math.round(rec.retraceMs), fdiff: Math.round(rec.fdiffMs) },
    // CPU seconds of the whole reconstruction (both traces included) and of the recovery alone, per minute of music.
    reconstructCpuPerMusicMinute: Number(((rec.totalCpuMs / 1000) / (seconds / 60)).toFixed(2)),
    recoverMsPerMusicMinute: Number((rec.recoverMs / (seconds / 60)).toFixed(1)),
  };
  if (settings.a1 && compiled && report.compile?.ok) {
    const roms = loadRomsDir(args.roms);
    if (!roms) result.a1 = { status: "not evaluated", reason: "ROM images not found" };
    else {
      try {
        const t = Date.now();
        const v = await verifySid(sidBytes, compiled, {
          engine, seconds: horizon.usedSeconds, song: tune.subtune,
          a1: { engine: createLibsidplayfpEngine({ emulation: "residfp" }), rules: loadA1Rules(), roms },
        });
        result.a1 = { level: v.levels.A1, details: v.a1 ?? null, wallSeconds: Number(((Date.now() - t) / 1000).toFixed(1)) };
        if (v.a1) {
          const { status, reason, windows, badWindows, lagMs, truncated } = v.a1;
          result.a1 = { level: v.levels.A1, status, ...(reason ? { reason } : {}), windows, badWindows, lagMs, ...(truncated ? { truncated } : {}), wallSeconds: result.a1.wallSeconds };
        }
      } catch (error) {
        result.a1 = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }
  } else if (settings.a1) result.a1 = { status: "not evaluated", reason: "recompiled score missing" };
  result.finishedAt = new Date(started).toISOString();
  return { result, score };
}

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

if (args.one !== undefined) {
  const tune = JSON.parse(args.one);
  const versions = codeVersion();
  const sidBytes = new Uint8Array(readFileSync(path.join(hvsc, tune.path)));
  const key = cacheKey(tune, sidBytes, versions);
  try {
    const { result, score } = await runOne(tune);
    writeAtomic(path.join(args.cache, `${key}.json`), JSON.stringify({ result, score }));
  } catch (error) {
    writeAtomic(path.join(args.cache, `${key}.error.json`), JSON.stringify({ path: tune.path, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }));
    process.exitCode = 1;
  }
} else {
  await main();
}

// ---- parent ----------------------------------------------------------------------------------------------------------

async function main() {
  if (!hvsc) throw new Error("HVSC_DIR is not set");
  const only = args.only ? args.only.split(",") : undefined;
  const tunes = manifest.tunes.filter((t) => t.split === "development" && (!only || only.some((o) => t.path.includes(o))));
  if (tunes.some((t) => t.split !== "development")) throw new Error("held-out tune selected");
  const versions = codeVersion();
  const workers = Math.min(MAX_WORKERS, Math.max(1, Number(args.workers)));
  const budgetMs = Number(args["budget-seconds"]) * 1000;
  const entries = tunes.map((tune) => {
    const sidBytes = new Uint8Array(readFileSync(path.join(hvsc, tune.path)));
    const key = cacheKey(tune, sidBytes, versions);
    return { tune, key, file: path.join(args.cache, `${key}.json`) };
  });
  const todo = entries.filter((e) => args.force || !existsSync(e.file));
  console.error(`${entries.length} development tunes, ${entries.length - todo.length} cached, ${todo.length} to run on ${workers} workers (code ${versions.code})`);
  let next = 0;
  const failures = [];
  const runWorker = async () => {
    for (;;) {
      const e = todo[next++];
      if (!e) return;
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...passThrough(), "--one", JSON.stringify(e.tune)], { stdio: ["ignore", "inherit", "inherit"], timeout: budgetMs, env: process.env });
        child.on("exit", (code, signal) => {
          if (code !== 0) failures.push({ path: e.tune.path, code, signal });
          console.error(`${e.tune.path}: ${code === 0 ? "done" : `failed (${code ?? signal})`}`);
          resolve();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));
  const results = [];
  for (const e of entries) {
    if (existsSync(e.file)) results.push(JSON.parse(readFileSync(e.file, "utf8")).result);
    else {
      const errFile = e.file.replace(/\.json$/, ".error.json");
      const why = existsSync(errFile) ? JSON.parse(readFileSync(errFile, "utf8")).error.split("\n")[0] : "no result (timeout or crash)";
      results.push({ path: e.tune.path, md5: e.tune.md5, subtune: e.tune.subtune, horizon: horizonOf(e.tune), rootCause: "error", strictExact: false, registerStateExact: false, error: why });
    }
  }
  const report = buildReport(results, versions);
  writeAtomic(args.out, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(args.md ?? args.out.replace(/\.json$/, ".md"), markdown(report));
  console.error(`strict exact ${report.summary.strictExact}/${results.length}, register-state exact ${report.summary.registerStateExact}/${results.length}`);
  if (failures.length) process.exitCode = 2;
}

function passThrough() {
  const out = ["--cache", args.cache, "--roms", args.roms, "--manifest", args.manifest];
  if (args["no-a1"]) out.push("--no-a1");
  if (args["max-horizon"]) out.push("--max-horizon", args["max-horizon"]);
  return out;
}

function buildReport(results, versions) {
  const byClass = {};
  for (const r of results) (byClass[r.rootCause] ??= []).push(r.path);
  const timed = results.filter((r) => r.timing);
  const sum = (f) => timed.reduce((s, r) => s + f(r), 0);
  const music = timed.reduce((s, r) => s + r.horizon.usedSeconds / 60, 0);
  return {
    schema: 1,
    label: args.label,
    note: "Development tunes only. No SID data, no scores. Held-out tunes are not run.",
    manifestSha256: sha256(readFileSync(args.manifest)),
    versions,
    settings,
    summary: {
      tunes: results.length,
      strictExact: results.filter((r) => r.strictExact).length,
      registerStateExact: results.filter((r) => r.registerStateExact).length,
      compileFailures: results.filter((r) => r.compileOk === false).length,
      a1Pass: results.filter((r) => r.a1?.level === "pass").length,
      a1Evaluated: results.filter((r) => r.a1?.level).length,
      horizonReduced: results.filter((r) => r.horizon.reduced).length,
      rootCauseCounts: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1])),
      differingCalls: sum((r) => r.fdiff?.differingCalls ?? 0),
      scoreBytes: sum((r) => r.scoreBytes ?? 0),
      musicMinutes: Number(music.toFixed(2)),
      reconstructCpuSecondsPerMusicMinute: music ? Number((sum((r) => r.timing.cpuSeconds) / music).toFixed(2)) : null,
      recoverMsPerMusicMinute: music ? Number((sum((r) => r.timing.phasesMs.recover) / music).toFixed(1)) : null,
    },
    tunes: results,
  };
}

function markdown(report) {
  const s = report.summary;
  const L = [];
  L.push(`# SIDWave reconstruction: development corpus report${report.label ? ` (${report.label})` : ""}`, "");
  L.push(`Development tunes only (${s.tunes}); held-out tunes are not run. Manifest SHA-256 ${report.manifestSha256.slice(0, 16)}, code ${report.versions.code}, engine libsidplayfp-wasm ${report.versions.engine}.`, "");
  L.push(`- Strict exact: ${s.strictExact} of ${s.tunes}`);
  L.push(`- Register state exact (secondary, weaker): ${s.registerStateExact} of ${s.tunes}`);
  L.push(`- Recovered score did not compile: ${s.compileFailures}`);
  L.push(`- A1 pass (approximate status): ${s.a1Pass} of ${s.a1Evaluated} evaluated`);
  L.push(`- Horizon shorter than the design horizon: ${s.horizonReduced}`);
  L.push(`- Reconstruct CPU time: ${s.reconstructCpuSecondsPerMusicMinute} s per minute of music (traces of both the tune and the recompiled score included); recovery step alone ${s.recoverMsPerMusicMinute} ms per minute of music`, "");
  L.push("## Root-cause classes (first material difference)", "");
  L.push("| Class | Tunes |", "| --- | ---: |");
  for (const [k, v] of Object.entries(s.rootCauseCounts)) L.push(`| ${k} | ${v} |`);
  L.push("", "## Tunes", "");
  L.push("| Tune | Horizon s | Strict | State | A1 | Class | First difference | Differing calls | Score bytes | CPU s/min |", "| --- | ---: | :-: | :-: | :-: | --- | --- | ---: | ---: | ---: |");
  for (const r of report.tunes) {
    const f = r.fdiff?.first;
    const first = r.error ? `error: ${r.error}` : f ? `${f.class} call ${f.call} (${f.timeSeconds.toFixed(2)} s)${f.voice !== undefined ? ` voice ${f.voice}` : ""}${f.register !== undefined ? ` reg $${f.register.toString(16)}` : ""}${f.expected !== undefined ? ` ${f.expected}->${f.observed}` : ""}` : r.compileOk === false ? `no compile: ${(r.compileError ?? "").slice(0, 60)}` : "none";
    L.push(`| ${r.path}:${r.subtune} | ${r.horizon.usedSeconds}${r.horizon.reduced ? " (reduced)" : ""} | ${r.strictExact ? "yes" : "no"} | ${r.registerStateExact ? "yes" : "no"} | ${r.a1?.level ?? r.a1?.status ?? "-"} | ${r.rootCause} | ${first} | ${r.fdiff?.differingCalls ?? "-"} | ${r.scoreBytes ?? "-"} | ${r.timing?.reconstructCpuPerMusicMinute ?? "-"} |`);
  }
  L.push("", "## Unsupported features and language-extension candidates", "");
  const kinds = {};
  for (const r of report.tunes) {
    for (const u of r.unsupported ?? []) (kinds[`unsupported: ${u.kind}`] ??= new Set()).add(r.path);
    for (const e of r.languageExtensions ?? []) (kinds[`extension: ${e.construct}`] ??= new Set()).add(r.path);
  }
  L.push("| Kind | Tunes |", "| --- | ---: |");
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1].size - a[1].size)) L.push(`| ${k} | ${v.size} |`);
  L.push("");
  return `${L.join("\n")}\n`;
}
