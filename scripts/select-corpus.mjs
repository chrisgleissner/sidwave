#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
//
// Deterministic selection of the SIDWave reconstruction corpus (design: S5 reconstruction, section "Corpus (S5a)").
//
//   HVSC_DIR=/path/to/C64Music node scripts/select-corpus.mjs [options]
//
// Steps: pool (every Songlengths entry of at least 30 s), hash order SHA-256(md5 + subtune), the first 3,000
// candidates traced on SIDLite for up to 60 s, header and trace features, SIDFlow style features when the data
// release is present, greedy bin cover (two tunes per bin, at most two per composer), groups, 24/6 split, manifest.
// The manifest holds no SID data. Traces and features are cached by content, so a rerun only traces what is missing.
// Run it after `npm run build`; it imports the built `sidwave` package.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip, gzipSync } from "node:zlib";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createLibsidplayfpEngine, SidAbortError, SidLoadError, TraceOverflowError } from "sidwave/engine";
import {
  buildIr,
  extractFeatures,
  featureBins,
  FEATURE_CODE_VERSION,
  headerFeatures,
  IR_CODE_VERSION,
  styleBins,
  styleFromSidflow,
} from "sidwave/reconstruct";
import { effectiveInitAddress, md5ForSonglengths, parseSidFile } from "sidwave/sid-file";
import { parseSonglengthsWithPaths } from "sidwave/songlengths";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const DEFAULTS = {
  candidates: 3000,
  seconds: 60,
  minLengthSeconds: 30,
  workers: 4,
  budgetSeconds: 240,
  maxRecords: 2_000_000,
  total: 30,
  heldOut: 6,
  perBin: 2,
  perComposer: 2,
  signatureBytes: 512,
};
const MAX_WORKERS = 4;
const STYLE_CACHE_VERSION = 1;

// ---- worker: one candidate ------------------------------------------------------------------------------------------

function cachePaths(cacheDir, key) {
  return { features: path.join(cacheDir, "features", key.slice(0, 2), `${key}.json`), trace: path.join(cacheDir, "traces", key.slice(0, 2), `${key}.f64.gz`) };
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Player signature: SHA-256 over the first `bytes` bytes at the init address and at the play address. */
function playerSignature(file, bytes) {
  const part = (address) => {
    if (!address) return new Uint8Array(0);
    const offset = address - file.loadAddress;
    if (offset < 0 || offset >= file.payload.length) return new Uint8Array(0);
    return file.payload.subarray(offset, Math.min(file.payload.length, offset + bytes));
  };
  return sha256(Buffer.concat([part(effectiveInitAddress(file)), Buffer.from([0xff]), part(file.playAddress)])).slice(0, 16);
}

function failureOf(error) {
  if (error instanceof TraceOverflowError) return "trace_overflow";
  if (error instanceof SidAbortError) return "timeout";
  if (error instanceof SidLoadError) return "load_failed";
  return "engine_error";
}

let engineSingleton;

async function processCandidate(job, opts) {
  let found;
  let mismatch = false;
  for (const p of job.paths) {
    let bytes;
    try {
      bytes = await readFile(path.join(opts.hvsc, p));
    } catch {
      continue;
    }
    if (md5ForSonglengths(bytes) === job.md5) {
      found = { path: p.replace(/^\//, ""), bytes };
      break;
    }
    mismatch = true;
  }
  if (!found) return { ok: false, failure: mismatch ? "md5_mismatch" : "file_missing" };
  let file;
  try {
    file = parseSidFile(found.bytes);
  } catch {
    return { ok: false, failure: "parse_error", path: found.path };
  }
  if (job.subtune > file.songs) return { ok: false, failure: "subtune_out_of_range", path: found.path };
  const seconds = Math.min(opts.seconds, job.lengthMs / 1000);
  const keyObject = {
    md5: job.md5,
    subtune: job.subtune,
    engine: opts.engine,
    seconds,
    featureCodeVersion: FEATURE_CODE_VERSION,
    irCodeVersion: IR_CODE_VERSION,
    maxRecords: opts.maxRecords,
  };
  const key = sha256(JSON.stringify(keyObject));
  const paths = cachePaths(opts.cacheDir, key);
  const meta = {
    path: found.path,
    author: file.author,
    name: file.name,
    signature: playerSignature(file, opts.signatureBytes),
    header: headerFeatures(file, job.subtune),
    traceSeconds: seconds,
    cacheKey: key,
  };
  if (!opts.forceTrace) {
    try {
      const cached = JSON.parse(await readFile(paths.features, "utf8"));
      return { ...meta, ...cached.result, cached: true };
    } catch {
      /* not cached */
    }
  }
  const engine = (engineSingleton ??= createLibsidplayfpEngine({ emulation: "sidlite" }));
  let result;
  try {
    const trace = await engine.trace({
      sid: found.bytes,
      song: job.subtune,
      seconds,
      maxRecords: opts.maxRecords,
      signal: AbortSignal.timeout(opts.budgetSeconds * 1000),
    });
    const ir = buildIr(trace.records, { clock: trace.clock, horizonCycles: trace.horizonCycles, originCycle: trace.originCycle });
    if (ir.calls.length < 2) {
      result = { ok: false, failure: "no_periodic_calls", writes: trace.count };
    } else {
      result = {
        ok: true,
        clock: trace.clock,
        writes: trace.count,
        features: extractFeatures(ir, meta.header),
        irWarnings: ir.warnings,
      };
    }
    if (opts.saveTrace && result.ok) {
      await writeAtomic(paths.trace, gzipSync(Buffer.from(trace.records.buffer, trace.records.byteOffset, trace.records.byteLength), { level: 6 }));
    }
  } catch (error) {
    result = { ok: false, failure: failureOf(error), detail: String(error?.message ?? error).slice(0, 200) };
  }
  // Timeouts depend on the load of the machine, so they are not cached.
  if (result.failure !== "timeout" && result.failure !== "engine_error") {
    await writeAtomic(paths.features, JSON.stringify({ key: keyObject, result }));
  }
  return { ...meta, ...result, cached: false };
}

if (!isMainThread) {
  parentPort.on("message", async ({ id, job }) => {
    let result;
    try {
      result = await processCandidate(job, workerData);
    } catch (error) {
      result = { ok: false, failure: "engine_error", detail: String(error?.message ?? error).slice(0, 200) };
    }
    parentPort.postMessage({ id, result });
  });
}

// ---- main thread ----------------------------------------------------------------------------------------------------

function runPool(jobs, opts, onProgress) {
  const workers = Math.min(MAX_WORKERS, Math.max(1, opts.workers));
  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  return new Promise((resolve, reject) => {
    const pool = [];
    const dispatch = (worker) => {
      if (next >= jobs.length) {
        worker.terminate().then(() => {
          pool.splice(pool.indexOf(worker), 1);
          if (!pool.length) resolve(results);
        });
        return;
      }
      const id = next++;
      worker.postMessage({ id, job: jobs[id] });
    };
    for (let w = 0; w < workers; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: opts });
      pool.push(worker);
      worker.on("message", ({ id, result }) => {
        results[id] = result;
        done++;
        onProgress(done, jobs.length, result);
        dispatch(worker);
      });
      worker.on("error", reject);
      dispatch(worker);
    }
    if (!jobs.length) resolve(results);
  });
}

async function locateHvsc(hvscDir) {
  for (const root of [hvscDir, path.join(hvscDir, "C64Music")]) {
    const songlengths = path.join(root, "DOCUMENTS", "Songlengths.md5");
    if (existsSync(songlengths)) return { root, songlengths };
  }
  throw new Error(`Songlengths.md5 not found under ${hvscDir}/DOCUMENTS or ${hvscDir}/C64Music/DOCUMENTS`);
}

/** Builds (or loads) the style feature table of the SIDFlow export: track id -> style features. */
async function loadStyle(sidflowDir, cacheDir, log) {
  if (!sidflowDir) return { status: "not configured" };
  const bundle = path.join(sidflowDir, "sidcorr-hvsc-full-features-1.jsonl.gz");
  const sums = path.join(sidflowDir, "SHA256SUMS");
  if (!existsSync(bundle) || !existsSync(sums)) return { status: `bundle or SHA256SUMS missing in ${sidflowDir}` };
  const expected = (await readFile(sums, "utf8"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === path.basename(bundle))?.[0];
  const actual = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(bundle).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
  if (!expected || expected !== actual) return { status: `SHA256SUMS check failed for ${path.basename(bundle)}` };
  const table = path.join(cacheDir, `sidflow-style-v${STYLE_CACHE_VERSION}-${actual.slice(0, 16)}.json`);
  let styles;
  try {
    styles = JSON.parse(await readFile(table, "utf8"));
  } catch {
    log(`reading ${path.basename(bundle)} (sha256 ${actual.slice(0, 12)}...)`);
    styles = {};
    const lines = createInterface({ input: createReadStream(bundle).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      styles[record.track_id] = styleFromSidflow(record.features ?? {});
    }
    await writeAtomic(table, JSON.stringify(styles));
  }
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(path.join(sidflowDir, "sidcorr-hvsc-full-features-1.manifest.json"), "utf8"));
  } catch {
    /* optional */
  }
  return {
    status: "used",
    styles,
    source: {
      name: "sidflow-data",
      release: "1.0.0",
      file: path.basename(bundle),
      sha256: actual,
      hvscVersion: manifest.hvsc_version ?? null,
      featureSchemaVersion: manifest.feature_schema_version ?? null,
      tracks: manifest.track_count ?? null,
    },
  };
}

function composerKey(tune) {
  const parts = tune.path.split("/");
  if (parts[0] === "MUSICIANS" && parts.length >= 4) return parts.slice(0, 3).join("/");
  const author = tune.author.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";
  return `${parts[0]}/${author}`;
}

/** Greedy cover: each pick maximises the number of missing bin slots; ties by hash order. */
function selectTunes(candidates, options) {
  const poolCount = new Map();
  for (const c of candidates) for (const b of c.bins) poolCount.set(b, (poolCount.get(b) ?? 0) + 1);
  const target = new Map([...poolCount].map(([bin, n]) => [bin, Math.min(options.perBin, n)]));
  const cover = new Map();
  const perComposer = new Map();
  const selected = [];
  const remaining = [...candidates].sort((a, b) => (a.key < b.key ? -1 : 1));
  const take = (score) => {
    let best;
    let bestScore = 0;
    for (const c of remaining) {
      if ((perComposer.get(c.composer) ?? 0) >= options.perComposer) continue;
      const s = score(c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (!best) return false;
    selected.push(best);
    remaining.splice(remaining.indexOf(best), 1);
    perComposer.set(best.composer, (perComposer.get(best.composer) ?? 0) + 1);
    for (const b of best.bins) cover.set(b, (cover.get(b) ?? 0) + 1);
    return true;
  };
  // Phase 1: cover. The gain is the number of bin slots still missing. Phase 2 (when the cover is complete before the
  // total is reached): fill with the tunes whose bins are rarest in the pool.
  while (selected.length < options.total && take((c) => c.bins.reduce((n, b) => n + Math.max(0, target.get(b) - (cover.get(b) ?? 0)), 0)));
  const phase1 = selected.length;
  while (selected.length < options.total && take((c) => c.bins.reduce((n, b) => n + 1 / poolCount.get(b), 0)));
  return { selected, phase1, poolCount, target };
}

function splitTunes(selected, options) {
  const groups = new Map();
  for (const t of selected) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  const ordered = [...groups].map(([id, tunes]) => ({ id, tunes, key: sha256(id) })).sort((a, b) => (a.key < b.key ? -1 : 1));
  const held = new Set();
  for (const g of ordered) {
    if (held.size + g.tunes.length > options.heldOut) continue;
    const trial = new Set([...held, ...g.tunes]);
    const dev = selected.filter((t) => !trial.has(t));
    const devBins = new Set(dev.flatMap((t) => t.bins));
    if ([...trial].every((t) => t.bins.some((b) => devBins.has(b)))) for (const t of g.tunes) held.add(t);
    if (held.size === options.heldOut) break;
  }
  return held;
}

async function main() {
  const { values } = parseArgs({
    options: {
      hvsc: { type: "string" },
      out: { type: "string", default: "sidwave/data/reconstruct/corpus-manifest.json" },
      cache: { type: "string" },
      sidflow: { type: "string" },
      "no-sidflow": { type: "boolean", default: false },
      candidates: { type: "string", default: String(DEFAULTS.candidates) },
      seconds: { type: "string", default: String(DEFAULTS.seconds) },
      workers: { type: "string", default: String(DEFAULTS.workers) },
      "skip-verify": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: HVSC_DIR=<C64Music> node scripts/select-corpus.mjs [--out FILE] [--cache DIR] [--sidflow DIR | --no-sidflow] [--candidates N] [--seconds S] [--workers N<=4] [--skip-verify]");
    return;
  }
  const started = Date.now();
  const log = (msg) => console.error(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`);
  const hvscDir = values.hvsc ?? process.env.HVSC_DIR;
  if (!hvscDir) throw new Error("Set HVSC_DIR (or pass --hvsc) to the HVSC directory");
  const { root, songlengths } = await locateHvsc(hvscDir);
  const cacheDir = values.cache ?? process.env.CORPUS_CACHE_DIR ?? path.join(homedir(), ".c64bridge", "sidwave-standalone", "corpus-cache");
  const sidflowDir = values["no-sidflow"] ? undefined : (values.sidflow ?? path.join(homedir(), ".c64bridge", "sidwave-standalone", "sidflow-data"));
  await mkdir(cacheDir, { recursive: true });

  const engineVersion = createRequire(import.meta.url)("libsidplayfp-wasm/package.json").version;
  const engine = `libsidplayfp-wasm@${engineVersion}/sidlite`;

  // Pool and hash order.
  const text = await readFile(songlengths, "utf8");
  const songlengthsSha = sha256(text);
  const { db, paths } = parseSonglengthsWithPaths(text);
  const pool = [];
  for (const [md5, durations] of db) {
    durations.forEach((ms, i) => {
      if (ms >= DEFAULTS.minLengthSeconds * 1000) {
        pool.push({ md5, subtune: i + 1, lengthMs: ms, paths: paths.get(md5) ?? [], key: sha256(`${md5}${i + 1}`) });
      }
    });
  }
  pool.sort((a, b) => (a.key < b.key ? -1 : 1));
  const candidateCount = Number(values.candidates);
  const jobs = pool.slice(0, candidateCount);
  log(`pool ${pool.length} subtunes of at least ${DEFAULTS.minLengthSeconds} s in ${db.size} files; tracing ${jobs.length} candidates with ${Math.min(MAX_WORKERS, Number(values.workers))} workers`);

  const opts = {
    hvsc: root,
    cacheDir,
    engine,
    seconds: Number(values.seconds),
    workers: Number(values.workers),
    budgetSeconds: DEFAULTS.budgetSeconds,
    maxRecords: DEFAULTS.maxRecords,
    signatureBytes: DEFAULTS.signatureBytes,
    forceTrace: false,
    saveTrace: false,
  };
  const failures = {};
  const results = await runPool(jobs, opts, (done, total, r) => {
    if (!r.ok) {
      failures[r.failure] = (failures[r.failure] ?? 0) + 1;
      if (failures[r.failure] <= 3) log(`failure ${r.failure}: ${r.path ?? "(no file)"} ${r.detail ?? ""}`);
    }
    if (done % 100 === 0 || done === total) log(`${done}/${total} candidates, failures ${JSON.stringify(failures)}`);
  });
  const outcomes = {};
  let cachedHits = 0;
  for (const r of results) {
    if (r.cached) cachedHits++;
    if (!r.ok) outcomes[r.failure] = (outcomes[r.failure] ?? 0) + 1;
  }
  const ok = results.filter((r) => r.ok);
  log(`traced ${results.length}: ${ok.length} usable, failures ${JSON.stringify(outcomes)}, ${cachedHits} from cache`);

  // Style features and bins.
  const style = await loadStyle(sidflowDir, cacheDir, log);
  const candidates = results.flatMap((r, idx) => {
    if (!r.ok) return [];
    const job = jobs[idx];
    const trackId = `${r.path}#${job.subtune}`;
    const s = style.styles?.[trackId];
    return [{
      ...r,
      md5: job.md5,
      subtune: job.subtune,
      lengthMs: job.lengthMs,
      key: job.key,
      trackId,
      style: s,
      composer: undefined,
      bins: [...new Set([...featureBins(r.features), ...(s ? styleBins(s) : [])])].sort(),
      order: idx,
    }];
  });
  for (const c of candidates) {
    c.composer = composerKey(c);
    c.group = `${c.composer}|${c.signature}`;
  }
  const styleMatched = candidates.filter((c) => c.style).length;
  log(`style features matched for ${styleMatched} of ${candidates.length} usable candidates (${style.status})`);

  const { selected, phase1, poolCount, target } = selectTunes(candidates, DEFAULTS);
  const held = splitTunes(selected, DEFAULTS);
  for (const t of selected) t.split = held.has(t) ? "held-out" : "development";
  log(`selected ${selected.length} tunes (${phase1} by cover), ${held.size} held out`);

  // Determinism check: trace the selected tunes again, keep their traces, compare the features.
  if (!values["skip-verify"]) {
    const reJobs = selected.map((t) => jobs[results.findIndex((r) => r.cacheKey === t.cacheKey)]);
    const again = await runPool(reJobs, { ...opts, forceTrace: true, saveTrace: true }, (done, total) => {
      if (done % 10 === 0 || done === total) log(`retraced ${done}/${total} selected tunes`);
    });
    const mismatches = again.filter((r, i) => !r.ok || JSON.stringify(r.features) !== JSON.stringify(selected[i].features));
    if (mismatches.length) throw new Error(`${mismatches.length} selected tunes gave different features on a second trace`);
    log("second trace of the selected tunes reproduced all features");
  }

  const binNames = [...poolCount.keys()].sort();
  const count = (list, bin) => list.filter((t) => t.bins.includes(bin)).length;
  const dev = selected.filter((t) => t.split === "development");
  const heldOut = selected.filter((t) => t.split === "held-out");
  const bins = binNames.map((bin) => ({
    bin,
    candidates: poolCount.get(bin),
    target: target.get(bin),
    selected: count(selected, bin),
    development: count(dev, bin),
    heldOut: count(heldOut, bin),
  }));
  const manifest = {
    schema: 1,
    procedure: {
      source: "scripts/select-corpus.mjs",
      pool: {
        songlengthsSha256: songlengthsSha,
        songlengthsFiles: db.size,
        minLengthSeconds: DEFAULTS.minLengthSeconds,
        subtunes: pool.length,
        order: "SHA-256 of the lower-case hex MD5 followed by the decimal subtune number, ascending",
        candidates: jobs.length,
      },
      trace: {
        engine,
        horizonSeconds: `min(${opts.seconds}, Songlengths length)`,
        maxRecords: opts.maxRecords,
        featureCodeVersion: FEATURE_CODE_VERSION,
        irCodeVersion: IR_CODE_VERSION,
      },
      candidateOutcome: { traced: results.length, usable: ok.length, failures: Object.fromEntries(Object.entries(outcomes).sort()) },
      styleSource: style.source ?? { status: style.status },
      selection: {
        total: DEFAULTS.total,
        tunesPerBin: DEFAULTS.perBin,
        tunesPerComposer: DEFAULTS.perComposer,
        selectedByCover: phase1,
        heldOut: DEFAULTS.heldOut,
        playerSignature: `SHA-256 over ${DEFAULTS.signatureBytes} bytes at the init address and ${DEFAULTS.signatureBytes} bytes at the play address, first 16 hex digits`,
        composer: "directory MUSICIANS/<letter>/<composer>; for other directories the header author",
      },
      uncoveredBins: bins.filter((b) => b.selected < b.target).map((b) => b.bin),
    },
    bins,
    tunes: selected
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((t) => ({
        path: t.path,
        md5: t.md5,
        subtune: t.subtune,
        lengthSeconds: t.lengthMs / 1000,
        title: t.name,
        author: t.author,
        composer: t.composer,
        group: t.group,
        split: t.split,
        header: t.header,
        features: t.features.trace,
        style: t.style ?? null,
        bins: t.bins,
      })),
  };
  const outFile = path.resolve(values.out);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, body);
  const report = { manifestSha256: sha256(body), seconds: (Date.now() - started) / 1000, cachedHits };
  await writeAtomic(path.join(cacheDir, "last-run.json"), JSON.stringify(report, null, 2));
  console.log(`manifest ${outFile}\nsha256 ${report.manifestSha256}\nruntime ${report.seconds.toFixed(0)} s`);
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
