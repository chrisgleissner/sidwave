#!/usr/bin/env node
/**
 * A1 calibration (design: doc/plans/sidwave-standalone/research/a1-calibration-design.md).
 *
 *   nice -n 10 node scripts/calibrate-a1.mjs --phase dev
 *   nice -n 10 node scripts/calibrate-a1.mjs --phase freeze
 *   nice -n 10 node scripts/calibrate-a1.mjs --phase heldout [--new-heldout style:seed,style:seed]
 *
 * dev      Renders the development tunes and their mutations with reSIDfp (48 kHz mono, pinned ROMs), analyses every
 *          pair, searches the parameter grid and writes the development report.
 * freeze   Repeats the selection from the cached results and writes sidwave/data/verify/a1-rules.json. The SHA-256 of
 *          that file goes into the ledger by the operator, then the file is committed.
 * heldout  Refuses to run unless the rule file hash equals the one recorded at freeze, and refuses a second run unless
 *          --new-heldout names generator seeds that were never used. Evaluates the held-out tunes once.
 *
 * Options: --jobs <n> (render workers, default 3, at most 3), --cache-dir <dir>, --horizon-cap <seconds> (default 180),
 *          --only <tune id> (restrict to one base tune, for a smoke test), --rom-dir <dir>.
 * Needs a built package (npm run build). The cache is content addressed: a render is keyed by the compiled SID, the
 * package version, the engine identity, the ROM hashes and the horizon, so reruns and later phases reuse it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dist = (file) => import(pathToFileURL(path.join(repo, "sidwave", "dist", file)).href);
const RULES_PATH = path.join(repo, "sidwave", "data", "verify", "a1-rules.json");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
/** Hash of the code whose behaviour the cached results depend on (mutations, features, compiler). */
const codeHash = () => sha256(["verify/mutations.js", "verify/a1.js", "sidwaveCompiler.js", "sidwave.js"].map((f) => fs.readFileSync(path.join(repo, "sidwave", "dist", f))).map(sha256).join());

export const GENERATORS = [
  ["chiptune", 101], ["chiptune", 202], ["chiptune", 303], ["chiptune", 404],
  ["ambient", 111], ["ambient", 222], ["ambient", 333],
  ["funk", 121], ["funk", 242], ["funk", 363],
];

function parseArgs(argv) {
  const out = { jobs: 3, horizonCap: 180 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === "--phase") out.phase = value();
    else if (arg === "--jobs") out.jobs = Math.min(3, Math.max(1, Number(value())));
    else if (arg === "--cache-dir") out.cacheDir = value();
    else if (arg === "--horizon-cap") out.horizonCap = Number(value());
    else if (arg === "--only") out.only = value();
    else if (arg === "--rom-dir") out.romDir = value();
    else if (arg === "--new-heldout") out.newHeldout = value();
    else throw new Error(`unknown option ${arg}`);
  }
  if (!["dev", "freeze", "heldout"].includes(out.phase)) throw new Error("--phase dev|freeze|heldout is required");
  out.cacheDir ??= path.join(os.homedir(), ".c64bridge", "sidwave-standalone", "a1-cache");
  out.romDir ??= path.join(os.homedir(), ".c64bridge", "sidwave-standalone", "open-roms");
  return out;
}

const log = (...parts) => console.log(`${new Date().toISOString()} ${parts.join(" ")}`);

// ---------------------------------------------------------------------------------------------------------
// Worker: compile, render (cached), analyse

async function workerMain() {
  const { cacheDir, romDir, horizonCap } = workerData;
  const { parseSidwave } = await dist("sidwave.js");
  const { compileSidwaveBytes } = await dist("sidwaveOps.js");
  const { createLibsidplayfpEngine } = await dist("engine/libsidplayfp.js");
  const { analyzeAudioA1 } = await dist("verify/a1.js");
  const { mutateScore } = await dist("verify/mutations.js");
  const { encodeStats } = await dist("verify/calibration.js");
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repo, "sidwave", "package.json"), "utf8")).version;
  const roms = { kernal: fs.readFileSync(path.join(romDir, "kernal.rom")), basic: fs.readFileSync(path.join(romDir, "basic.rom")), chargen: fs.readFileSync(path.join(romDir, "chargen.rom")) };
  const romHashes = Object.fromEntries(Object.entries(roms).map(([k, v]) => [k, sha256(v)]));
  const engine = createLibsidplayfpEngine({ emulation: "residfp" });
  const references = new Map();

  const compile = (raw) => {
    const compiled = compileSidwaveBytes(parseSidwave(JSON.parse(JSON.stringify(raw))), { format: "sid" });
    return { sid: new Uint8Array(compiled.bytes), duration: compiled.summary.durationSeconds };
  };
  const horizonOf = (duration) => Math.max(1, Math.floor(Math.min(duration, horizonCap) * 10) / 10);
  const pcmFile = (sid, horizon, engineId) =>
    path.join(cacheDir, "pcm", `${sha256(JSON.stringify({ sid: sha256(sid), compiler: packageVersion, engine: engineId, roms: romHashes, rate: 48000, horizon }))}.pcm`);

  async function render(sid, horizon) {
    // The engine version is known only after the first load; render once with a throw-away probe key when unknown.
    const probe = engine.version === "unknown" ? await engine.render({ sid, seconds: 0.1, sampleRate: 48000, channels: 1, roms }) : undefined;
    const identity = probe ? probe.engine : { id: engine.id, version: engine.version, emulation: "residfp" };
    const file = pcmFile(sid, horizon, identity);
    if (fs.existsSync(file)) return { file, cached: true, identity };
    const result = await engine.render({ sid, seconds: horizon, sampleRate: 48000, channels: 1, roms });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(result.samples.buffer, result.samples.byteOffset, result.samples.byteLength));
    fs.renameSync(tmp, file);
    return { file, cached: false, identity: result.engine };
  }
  const readPcm = (file) => { const b = fs.readFileSync(file); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };

  async function base({ raw }) {
    const { sid, duration } = compile(raw);
    const horizon = horizonOf(duration);
    const rendered = await render(sid, horizon);
    return { sidSha: sha256(sid), duration, horizon, pcmFile: rendered.file, cached: rendered.cached, engine: rendered.identity, romHashes };
  }

  const referenceFor = (file) => {
    let reference = references.get(file);
    if (!reference) {
      if (references.size >= 2) references.delete(references.keys().next().value);
      reference = { samples: readPcm(file) };
      references.set(file, reference);
    }
    return reference;
  };

  async function item({ tuneId, raw, kind, baseInfo, itemKey }) {
    const reference = referenceFor(baseInfo.pcmFile);
    const basePcm = reference.samples;
    const meta = { tune: tuneId, class: kind.class, severity: kind.severity, label: kind.label };
    let candidate;
    let description;
    let targets;
    let firstUseSeconds;
    if (kind.class === "pcm_delay") {
      candidate = new Int16Array(basePcm.length);
      candidate.set(basePcm.subarray(0, basePcm.length - 1), 1);
      description = "candidate PCM delayed by one sample";
    } else {
      const outcome = mutateScore(raw, kind, { tuneId, horizonSeconds: baseInfo.horizon });
      if (!outcome.applied) return { ...meta, status: "skipped", reason: outcome.reason };
      description = outcome.mutation.description;
      targets = outcome.mutation.targets;
      firstUseSeconds = outcome.mutation.firstUseSeconds;
      const { sid } = compile(outcome.document);
      if (sha256(sid) === baseInfo.sidSha && kind.class !== "identical") return { ...meta, status: "skipped", reason: "the compiled SID is identical to the base tune", description };
      const rendered = await render(sid, baseInfo.horizon);
      candidate = readPcm(rendered.file);
    }
    const samePcm = basePcm.length === candidate.length && Buffer.compare(Buffer.from(basePcm.buffer, basePcm.byteOffset, basePcm.byteLength), Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength)) === 0;
    if (samePcm && kind.label !== "B") return { ...meta, status: "skipped", reason: "no effect on the audio within the horizon", description };
    const analysis = analyzeAudioA1(basePcm, candidate, { horizonSeconds: baseInfo.horizon, reference });
    const statsFile = path.join(cacheDir, "stats", `${itemKey}.bin`);
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    fs.writeFileSync(statsFile, encodeStats(analysis.stats, (analysis.lagSamples * 1000) / 48000));
    return { ...meta, status: "scored", description, ...(targets ? { targets } : {}), ...(firstUseSeconds === undefined ? {} : { firstUseSeconds }), statsFile, lagMs: (analysis.lagSamples * 1000) / 48000, identicalPcm: samePcm };
  }

  parentPort.on("message", async (job) => {
    try {
      const result = job.type === "base" ? await base(job) : await item(job);
      parentPort.postMessage({ id: job.id, result });
    } catch (error) {
      parentPort.postMessage({ id: job.id, error: String(error?.stack ?? error) });
    }
  });
  parentPort.postMessage({ ready: true });
}

// ---------------------------------------------------------------------------------------------------------
// Main: corpus, pool, phases

class Pool {
  constructor(size, data) {
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.idle = [];
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: data });
      worker.on("message", (message) => {
        if (message.ready) { this.idle.push(worker); this.pump(); return; }
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        this.idle.push(worker);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
        this.pump();
      });
      worker.on("error", (error) => { throw error; });
      return worker;
    });
  }
  run(job) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ job: { ...job, id }, resolve, reject });
      this.pump();
    });
  }
  pump() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop();
      const next = this.queue.shift();
      this.pending.set(next.job.id, next);
      worker.postMessage(next.job);
    }
  }
  async close() { await Promise.all(this.workers.map((w) => w.terminate())); }
}

async function baseTunes(extraGenerators) {
  const { readRawScore } = await dist("verify/mutations.js");
  const { generateSidwave } = await dist("audio/generateSidwave.js");
  const examples = path.join(repo, "sidwave", "data", "sound", "examples");
  const bases = fs.readdirSync(examples).filter((f) => f.endsWith(".yaml")).sort().map((f) => ({
    id: `example:${f.replace(/\.yaml$/, "")}`, raw: readRawScore(fs.readFileSync(path.join(examples, f), "utf8")),
  }));
  for (const [style, seed] of [...GENERATORS, ...extraGenerators]) {
    const { score } = generateSidwave({ root: "C3", preset: "classic", style, seed, system: "PAL" });
    bases.push({ id: `gen:${style}:${seed}`, raw: readRawScore(score) });
  }
  return bases.map((b) => ({ ...b, sha256: sha256(JSON.stringify(b.raw)) }));
}

function parseNewSeeds(text) {
  if (!text) return [];
  return text.split(",").map((entry) => {
    const [style, seed] = entry.split(":");
    if (!["chiptune", "ambient", "funk"].includes(style) || !Number.isInteger(Number(seed))) throw new Error(`--new-heldout entries are style:seed, not "${entry}"`);
    if (GENERATORS.some(([s, n]) => s === style && n === Number(seed))) throw new Error(`seed ${entry} was used in the first corpus`);
    return [style, Number(seed)];
  });
}

const keyOf = (b, kind, args) => sha256(`${b.id}|${kind.class}|${kind.severity}|${b.sha256}|${args.horizonCap}|${args.codeHash}`);

async function runItems(args, side, bases, newSeeds) {
  const { MUTATION_CATALOG } = await dist("verify/mutations.js");
  const { splitSide } = await dist("verify/calibration.js");
  fs.mkdirSync(args.cacheDir, { recursive: true });
  args.codeHash ??= codeHash();
  const chosen = bases.filter((b) => (args.only ? b.id === args.only : newSeeds.length ? b.id.startsWith("gen:") && newSeeds.some(([s, n]) => b.id === `gen:${s}:${n}`) : splitSide(b.id) === side));
  log(`phase ${side}: ${chosen.length} base tunes`);
  const pool = new Pool(args.jobs, { cacheDir: args.cacheDir, romDir: args.romDir, horizonCap: args.horizonCap });
  const kinds = [...MUTATION_CATALOG, { class: "pcm_delay", severity: "1-sample", label: "B" }];
  const resultsFile = path.join(args.cacheDir, `items-${side}-${args.horizonCap}${newSeeds.length ? "-new" : ""}.jsonl`);
  const done = new Map();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); done.set(r.itemKey, r); }
  }
  const baseResults = new Map();
  let finished = 0;
  await Promise.all(chosen.map(async (b) => {
    baseResults.set(b.id, await pool.run({ type: "base", raw: b.raw }));
    log(`base ${b.id} rendered (${++finished}/${chosen.length}), horizon ${baseResults.get(b.id).horizon} s`);
  }));
  const jobs = [];
  for (const b of chosen) {
    for (const kind of kinds) {
      const itemKey = keyOf(b, kind, args);
      if (done.has(itemKey)) continue;
      jobs.push({ b, kind, itemKey });
    }
  }
  log(`${jobs.length} items to run, ${done.size} already done`);
  let count = 0;
  await Promise.all(jobs.map(async ({ b, kind, itemKey }) => {
    const result = await pool.run({ type: "item", tuneId: b.id, raw: b.raw, kind, baseInfo: baseResults.get(b.id), itemKey });
    const record = { itemKey, ...result };
    fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
    done.set(itemKey, record);
    if (++count % 20 === 0 || count === jobs.length) log(`items ${count}/${jobs.length}`);
  }));
  await pool.close();
  const records = chosen.flatMap((b) => kinds.map((kind) => done.get(keyOf(b, kind, args))));
  return { records, baseResults, chosen };
}

async function loadCorpus(records) {
  const { decodeStats } = await dist("verify/calibration.js");
  const items = [];
  const skipped = [];
  for (const r of records) {
    if (r.status === "scored") items.push({ tune: r.tune, class: r.class, severity: r.severity, label: r.label, stats: decodeStats(fs.readFileSync(r.statsFile)).stats });
    else skipped.push({ tune: r.tune, class: r.class, severity: r.severity, reason: r.reason });
  }
  return { items, skipped };
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] ?? 0) + 1;
  return out;
}

async function manifestOf(bases, horizonCap) {
  const { MUTATION_CATALOG } = await dist("verify/mutations.js");
  const { manifestHash } = await dist("verify/calibration.js");
  const manifest = {
    bases: bases.map((b) => ({ id: b.id, sha256: b.sha256 })),
    mutations: MUTATION_CATALOG.map(({ class: c, severity, label }) => ({ class: c, severity, label })),
    horizonMaxSeconds: horizonCap, sampleRate: 48000,
  };
  return { manifest, sha256: manifestHash(manifest) };
}

function writeReport(args, name, report) {
  const file = path.join(args.cacheDir, name);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  log(`report ${file}`);
  return file;
}

const rate = (r) => ({ count: r.count, total: r.total, rate: Number(r.rate.toFixed(4)), ci95: [Number(r.low.toFixed(4)), Number(r.high.toFixed(4))] });
const summarise = (report) => ({
  parameters: report.parameters,
  falseAccept: rate(report.falseAccept),
  falseReject: rate(report.falseReject),
  byClass: Object.fromEntries(Object.entries(report.byClass).map(([c, v]) => [c, { ...(v.falseAccept ? { falseAccept: rate(v.falseAccept) } : {}), ...(v.falseReject ? { falseReject: rate(v.falseReject) } : {}) }])),
  borderline: report.borderline,
  misclassified: report.misclassified,
});

async function phaseDev(args) {
  const { selectParameters, scoreItems } = await dist("verify/calibration.js");
  const { A1_STARTING_PARAMETERS, A1_GRID } = await dist("verify/a1.js");
  const bases = await baseTunes([]);
  const { records, baseResults, chosen } = await runItems(args, "development", bases, []);
  const { items, skipped } = await loadCorpus(records);
  log(`scored ${items.length}, skipped ${skipped.length}: ${JSON.stringify(countBy(skipped, "reason"))}`);
  const selection = selectParameters(items, (i, n) => { if (i % 100 === 0 || i === n) log(`grid ${i}/${n}`); });
  const { sha256: manifestSha, manifest } = await manifestOf(bases, args.horizonCap);
  const report = {
    phase: "development", tunes: chosen.map((b) => b.id), manifestSha256: manifestSha,
    horizons: Object.fromEntries([...baseResults].map(([id, r]) => [id, r.horizon])),
    scored: items.length, skipped, grid: A1_GRID, selected: summarise(selection.best), top: selection.top,
    startingParameters: summarise(scoreItems(items, A1_STARTING_PARAMETERS)),
    engine: [...baseResults.values()][0]?.engine, romHashes: [...baseResults.values()][0]?.romHashes,
    baseCount: manifest.bases.length,
  };
  writeReport(args, `a1-report-dev-${args.horizonCap}.json`, report);
  const sel = report.selected;
  log(`selected ${JSON.stringify(sel.parameters)}; dev FA ${sel.falseAccept.count}/${sel.falseAccept.total}, FR ${sel.falseReject.count}/${sel.falseReject.total}; misclassified ${sel.misclassified.length}`);
}

async function phaseFreeze(args) {
  const { selectParameters } = await dist("verify/calibration.js");
  const { A1_GRID, A1_BANDS, A1_BAND_RANGE_HZ, A1_FLOOR_DB, A1_HOP, A1_LAG_SECONDS, A1_LAG_STEP, A1_LAG_STEPS, A1_SPAN_SECONDS, A1_WINDOW } = await dist("verify/a1.js");
  const bases = await baseTunes([]);
  const { records, baseResults, chosen } = await runItems(args, "development", bases, []);
  const { items, skipped } = await loadCorpus(records);
  const selection = selectParameters(items);
  const { sha256: manifestSha } = await manifestOf(bases, args.horizonCap);
  const first = [...baseResults.values()][0];
  const heldOut = bases.filter((b) => !chosen.includes(b)).map((b) => b.id);
  const file = {
    schema: "sidwave-a1-rules/1",
    parameters: selection.best.parameters,
    conditions: {
      sampleRate: 48000, channels: 1, window: A1_WINDOW, hop: A1_HOP, bands: A1_BANDS, bandRangeHz: [...A1_BAND_RANGE_HZ], floorDb: A1_FLOOR_DB,
      lagRangeMs: (A1_LAG_STEPS * A1_LAG_STEP * 1000) / 48000, lagStepSamples: A1_LAG_STEP, lagSeconds: A1_LAG_SECONDS, spanSeconds: A1_SPAN_SECONDS,
      engine: first.engine, roms: first.romHashes,
    },
    grid: A1_GRID,
    objective: "minimise 3 * false-accept rate + false-reject rate on the development set; ties go to the larger thetaSpec, thetaLevel, sGap, k, m in that order",
    split: { rule: "SHA-256(tune id) mod 10 < 7 is development, otherwise held out", development: chosen.map((b) => b.id), heldOut },
    corpus: { manifestSha256: manifestSha, horizonMaxSeconds: args.horizonCap, scored: items.length, skipped: skipped.length },
    development: summarise(selection.best),
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, text);
  const hash = sha256(text);
  const state = { rulesSha256: hash, rulesPath: RULES_PATH, frozenAt: new Date().toISOString(), heldoutRuns: [] };
  fs.writeFileSync(path.join(args.cacheDir, "a1-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  log(`frozen ${RULES_PATH}`);
  log(`rule file SHA-256 ${hash}`);
}

async function phaseHeldout(args) {
  const { scoreItems, rateOf } = await dist("verify/calibration.js");
  const statePath = path.join(args.cacheDir, "a1-state.json");
  if (!fs.existsSync(statePath) || !fs.existsSync(RULES_PATH)) throw new Error("no frozen rule file; run --phase freeze first");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const actual = sha256(fs.readFileSync(RULES_PATH));
  if (actual !== state.rulesSha256) throw new Error(`the rule file hash ${actual} differs from the hash recorded at freeze ${state.rulesSha256}; refusing to evaluate`);
  const newSeeds = parseNewSeeds(args.newHeldout);
  if (state.heldoutRuns.length > 0 && newSeeds.length === 0) throw new Error("the held-out set was already evaluated; a new run needs --new-heldout style:seed,... with seeds never used before");
  if (newSeeds.some(([s, n]) => state.heldoutRuns.some((r) => r.seeds?.includes(`${s}:${n}`)))) throw new Error("a --new-heldout seed was used in an earlier held-out run");
  const rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  if (rules.conditions.engine.version === undefined) throw new Error("the rule file has no engine identity");
  const bases = await baseTunes(newSeeds);
  const { records, baseResults, chosen } = await runItems(args, "heldout", bases, newSeeds);
  const { items, skipped } = await loadCorpus(records);
  const report = scoreItems(items, rules.parameters);
  const summary = summarise(report);
  const verified = report.falseAccept.rate <= 0.05 && report.falseReject.rate <= 0.05;
  const result = {
    phase: "heldout", rulesSha256: actual, tunes: chosen.map((b) => b.id), scored: items.length, skipped, ...summary,
    status: verified ? "verified within declared bounds" : "approximate",
    engine: [...baseResults.values()][0]?.engine,
  };
  const reportFile = writeReport(args, `a1-report-heldout-${new Date().toISOString().slice(0, 10)}-${state.heldoutRuns.length + 1}.json`, result);
  state.heldoutRuns.push({ at: new Date().toISOString(), seeds: newSeeds.map(([s, n]) => `${s}:${n}`), report: reportFile });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  log(`held-out FA ${report.falseAccept.count}/${report.falseAccept.total}, FR ${report.falseReject.count}/${report.falseReject.total}: ${result.status}`);
  void rateOf;
}

if (isMainThread) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
      const args = parseArgs(process.argv.slice(2));
      const run = { dev: phaseDev, freeze: phaseFreeze, heldout: phaseHeldout }[args.phase];
      await run(args);
    } catch (error) {
      console.error(`calibrate-a1: ${error.message}`);
      process.exit(1);
    }
  }
} else {
  await workerMain();
}
