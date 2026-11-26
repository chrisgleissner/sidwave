import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.ts";
import { createRequire } from "node:module";
import {
  createLibsidplayfpEngine,
  SidEngineUnavailableError,
  SidLoadError,
  TraceOverflowError,
} from "../src/engine/libsidplayfp.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/sound/examples");

async function tune(name = "funk_bass", vbi = false, mode = undefined) {
  const doc = parseSidwave(await readFile(path.join(root, `${name}.yaml`), "utf8"));
  if (vbi) doc.speed = 1;
  if (mode) doc.song.mode = mode;
  const prg = compileSidwaveToPrg(doc);
  const options = { initAddress: prg.initAddress, playAddress: prg.playAddress };
  return new Uint8Array(compileSidwaveToSid(doc, prg.prg, options).sid);
}

const hash = (a) => createHash("sha256").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

function concatenate(chunks) {
  const joined = new Float64Array(chunks.reduce((n, x) => n + x.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

test("SIDLite rendering is repeatable", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const a = await engine.render({ sid, seconds: 1 });
  const b = await engine.render({ sid, seconds: 1 });
  assert.equal(a.samples.length, 44_100);
  assert.equal(hash(a.samples), hash(b.samples));
});

test("tracing does not change the rendered audio (SIDLite PCM hashes match, tracing on and off)", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const untraced = await engine.render({ sid, seconds: 3 });
  const traced = await engine.trace({ sid, seconds: 3 });
  const untracedAgain = await engine.render({ sid, seconds: 3 });
  assert.ok(traced.count > 0);
  assert.equal(traced.samples.length, 3 * 44_100);
  assert.equal(traced.sampleRate, 44_100);
  assert.equal(traced.channels, 1);
  assert.equal(hash(traced.samples), hash(untraced.samples));
  assert.equal(hash(untracedAgain.samples), hash(untraced.samples));
});

test("reSIDfp trace leaves PCM length and RMS within one percent", async () => {
  // Fresh reSIDfp contexts are nondeterministic from about sample 15; powerOnDelay=8191 is the deterministic binding setting but does not seed that state.
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "residfp" });
  const a = await engine.render({ sid, seconds: 0.25 });
  const t = await engine.trace({ sid, seconds: 0.25 });
  const b = await engine.render({ sid, seconds: 0.25 });
  assert.equal(a.samples.length, b.samples.length);
  assert.ok(Math.abs(rms(a.samples) - rms(b.samples)) / Math.max(rms(a.samples), 1) < 0.01);
  assert.ok(t.count > 0);
});

test("trace values stay in SID register ranges and arrive at the declared play cadence", async () => {
  const sid = await tune("funk_bass", true);
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const result = await engine.trace({ sid, seconds: 3, clock: "PAL" });
  assert.ok(result.count > 0);
  const bursts = [];
  let previous = -Infinity;
  for (let i = 0; i < result.records.length; i += 4) {
    const [chip, address, value, cycle] = result.records.subarray(i, i + 4);
    assert.ok(chip === 0 || chip === 1);
    assert.ok(address >= 0 && address <= 0x1f);
    assert.ok(value >= 0 && value <= 255);
    if (cycle - previous > 1_000) bursts.push(cycle);
    previous = cycle;
  }
  assert.ok(bursts.length > 2);
  const gaps = bursts
    .slice(1)
    .map((x, i) => x - bursts[i])
    .filter((x) => x > 10_000 && x < 30_000)
    .sort((a, b) => a - b);
  assert.ok(gaps.length > 1);
  // This generated tune is VBI timed: PAL's 50 Hz frame period.
  const declaredPlayPeriod = 985_248 / 50;
  assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - declaredPlayPeriod) / declaredPlayPeriod < 0.01);
});

test("sidNumber is zero based for the two-SID compiled example", async () => {
  const sid = await tune("title_fanfare");
  const result = await createLibsidplayfpEngine({ emulation: "sidlite" }).trace({ sid, seconds: 0.5 });
  const chips = new Set();
  for (let i = 0; i < result.records.length; i += 4) chips.add(result.records[i]);
  assert.ok(chips.has(0));
  assert.ok(chips.has(1));
});

test("trace chunks concatenate to streamed result; bounds and abort are typed", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const chunks = [];
  const streamed = await engine.trace({ sid, seconds: 1, onChunk: (c) => chunks.push(c) });
  const buffered = await engine.trace({ sid, seconds: 1 });
  assert.deepEqual(concatenate(chunks), buffered.records);
  assert.equal(streamed.count, buffered.count);
  await assert.rejects(engine.render({ sid, seconds: 2, maxSeconds: 1 }), { code: "limit_exceeded" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.render({ sid, seconds: 1, signal: controller.signal }), { code: "aborted" });
});

test("a per-slice buffer overflow fails with TraceOverflowError instead of returning a truncated trace", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite", traceBufferLimit: 0 });
  await assert.rejects(engine.trace({ sid, seconds: 0.1 }), TraceOverflowError);
});

test("a small maxRecords cap fails with TraceOverflowError; chunks delivered so far are whole records", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const full = await engine.trace({ sid, seconds: 1 });
  assert.ok(full.count > 10);
  const chunks = [];
  await assert.rejects(
    engine.trace({ sid, seconds: 1, maxRecords: 10, onChunk: (c) => chunks.push(c) }),
    (error) => error instanceof TraceOverflowError && error.code === "trace_overflow" && /maxRecords 10/.test(error.message),
  );
  assert.ok(chunks.every((c) => c.length % 4 === 0));
  // A cap equal to the real record count succeeds and loses nothing.
  const exact = await engine.trace({ sid, seconds: 1, maxRecords: full.count });
  assert.equal(exact.count, full.count);
  assert.deepEqual(exact.records, full.records);
});

test("a completed trace reports zero dropped records and its chunks sum to the record count", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const chunks = [];
  const result = await engine.trace({ sid, seconds: 2, onChunk: (c) => chunks.push(c) });
  assert.equal(result.droppedRecords, 0);
  assert.equal(concatenate(chunks).length / 4, result.count);
});

test("a missing libsidplayfp-wasm package gives SidEngineUnavailableError naming the package and install command", async () => {
  const engine = createLibsidplayfpEngine({
    emulation: "sidlite",
    importModule: async () => {
      throw new Error("Cannot find package 'libsidplayfp-wasm'");
    },
  });
  const sid = await tune();
  let seen;
  try {
    await engine.render({ sid, seconds: 0.1 });
  } catch (error) {
    seen = error;
  }
  assert.ok(seen instanceof SidEngineUnavailableError);
  assert.equal(seen.code, "engine_unavailable");
  assert.equal(
    seen.message,
    "The libsidplayfp-wasm package is required but could not be loaded (Error: Cannot find package 'libsidplayfp-wasm'). " +
      "Install it with: npm install libsidplayfp-wasm",
  );
});

test("the loader receives the package name", async () => {
  const requested = [];
  const engine = createLibsidplayfpEngine({
    emulation: "sidlite",
    importModule: async (specifier) => {
      requested.push(specifier);
      throw new Error("absent");
    },
  });
  await assert.rejects(engine.trace({ sid: await tune(), seconds: 0.1 }), { code: "engine_unavailable" });
  assert.deepEqual(requested, ["libsidplayfp-wasm"]);
});

test("sixty-second streaming trace equals its non-streamed record buffer", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const chunks = [];
  const streamed = await engine.trace({ sid, seconds: 60, onChunk: (c) => chunks.push(c) });
  const buffered = await engine.trace({ sid, seconds: 60 });
  assert.deepEqual(concatenate(chunks), buffered.records);
  assert.equal(streamed.count, buffered.count);
  assert.equal(streamed.droppedRecords, 0);
});

const nodeRequire = createRequire(import.meta.url);

function fakeModule({ perSlice = 0, dropped = 0, droppedFrom = 1, cycle = 100 } = {}) {
  const packed = new Float64Array(perSlice * 4);
  for (let i = 0; i < perSlice; i++) packed.set([0, 24, 15, cycle], i * 4);
  let created = 0;
  class Context {
    index = created++;
    configure() { return true; }
    getLastError() { return ""; }
    setSystemROMs() { return true; }
    setEmulationConfig() { return true; }
    setSidWriteTraceEnabled() {}
    loadSidBuffer() { return true; }
    selectSong() { return 1; }
    getTuneMd5() { return "fake"; }
    render() { return new Int16Array(882); }
    getAndClearSidWriteTracesPacked() { return packed; }
    getDroppedSidWriteTraceCount() { return this.index >= droppedFrom ? dropped : 0; }
    delete() {}
  }
  return { loadLibsidplayfp: async () => ({ SidPlayerContext: Context }) };
}
const fakeSid = new Uint8Array(0x7c + 8);

test("a dropped-record count from the binding fails the trace with TraceOverflowError", async () => {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite", importModule: async () => fakeModule({ perSlice: 2, dropped: 1 }) });
  await assert.rejects(
    engine.trace({ sid: fakeSid, seconds: 0.1 }),
    (error) => error instanceof TraceOverflowError && error.message === "Trace buffer overflow in render slice 0 (1 dropped records; limit 1048576)",
  );
});

test("the default maxRecords is 2^22 records", async () => {
  // 100,000 records per slice and 50 slices per second give 5,000,000 records, more than 4,194,304.
  const engine = createLibsidplayfpEngine({ emulation: "sidlite", importModule: async () => fakeModule({ perSlice: 100_000 }) });
  await assert.rejects(
    engine.trace({ sid: fakeSid, seconds: 1 }),
    (error) => error instanceof TraceOverflowError && error.message === "Trace exceeds maxRecords 4194304; records would be lost",
  );
});

test("with onChunk the records are not accumulated; count still reports every record", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const buffered = await engine.trace({ sid, seconds: 1 });
  let delivered = 0;
  const streamed = await engine.trace({ sid, seconds: 1, onChunk: (c) => (delivered += c.length / 4) });
  assert.equal(streamed.records.length, 0);
  assert.equal(streamed.count, buffered.count);
  assert.equal(delivered, buffered.count);
});

test("errors thrown by onChunk and onProgress propagate unchanged", async () => {
  const sid = await tune();
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const chunkError = new RangeError("chunk consumer failed");
  await assert.rejects(engine.trace({ sid, seconds: 0.5, onChunk: () => { throw chunkError; } }), (error) => error === chunkError);
  const progressError = new TypeError("progress consumer failed");
  await assert.rejects(engine.render({ sid, seconds: 0.5, onProgress: () => { throw progressError; } }), (error) => error === progressError);
});

test("loader failures and unexpected binding errors keep their cause", async () => {
  const loaderError = new Error("Cannot find package 'libsidplayfp-wasm'");
  const missing = createLibsidplayfpEngine({ emulation: "sidlite", importModule: async () => { throw loaderError; } });
  await assert.rejects(missing.render({ sid: fakeSid, seconds: 0.1 }), (error) => error instanceof SidEngineUnavailableError && error.cause === loaderError);
  const bindingError = new Error("wasm trap");
  const broken = fakeModule();
  const Context = (await broken.loadLibsidplayfp()).SidPlayerContext;
  Context.prototype.render = () => { throw bindingError; };
  const engine = createLibsidplayfpEngine({ emulation: "sidlite", importModule: async () => broken });
  await assert.rejects(engine.render({ sid: fakeSid, seconds: 0.1 }), (error) => error instanceof SidLoadError && error.cause === bindingError && error.message === "wasm trap");
});

test("the engine version is read from the installed libsidplayfp-wasm package and the peer range is ^1.1.1", async () => {
  const installed = nodeRequire("libsidplayfp-wasm/package.json").version;
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  assert.equal(engine.version, "unknown");
  const result = await engine.render({ sid: await tune(), seconds: 0.1 });
  assert.equal(result.engine.version, installed);
  assert.equal(engine.version, installed);
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
  assert.equal(manifest.peerDependencies["libsidplayfp-wasm"], "^1.1.1");
});

test("the clock comes from the PSID header flags unless the request sets it", async () => {
  const ntsc = await tune("funk_bass", true, "NTSC");
  const pal = await tune("funk_bass", true, "PAL");
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const fromHeader = await engine.trace({ sid: ntsc, seconds: 1 });
  const palRun = await engine.trace({ sid: pal, seconds: 1 });
  const forced = await engine.trace({ sid: ntsc, seconds: 1, clock: "PAL" });
  assert.equal(fromHeader.clock, "NTSC");
  assert.equal(palRun.clock, "PAL");
  assert.equal(forced.clock, "PAL");
  assert.equal(fromHeader.horizonCycles - fromHeader.originCycle, 1_022_727);
  assert.equal(palRun.horizonCycles - palRun.originCycle, 985_248);
  // VBI play rate: one call per frame, 263 x 65 cycles on NTSC.
  const starts = [];
  let previous = -Infinity;
  for (let i = 0; i < fromHeader.records.length; i += 4) {
    const cycle = fromHeader.records[i + 3];
    if (cycle - previous > 1_000) starts.push(cycle);
    previous = cycle;
  }
  const gaps = starts.slice(1).map((x, i) => x - starts[i]).filter((x) => x > 10_000 && x < 30_000).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  assert.ok(Math.abs(median - 263 * 65) / (263 * 65) < 0.01);
});

test("trace records end at the requested horizon; cycles may exceed it by less than one slice", async () => {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const a = await engine.trace({ sid: await tune(), seconds: 1 });
  const b = await engine.trace({ sid: await tune("title_fanfare"), seconds: 1 });
  for (const result of [a, b]) {
    assert.equal(result.horizonCycles, result.originCycle + 985_248);
    assert.ok(result.count > 0);
    let last = 0;
    for (let i = 3; i < result.records.length; i += 4) last = Math.max(last, result.records[i]);
    assert.ok(last <= result.horizonCycles);
    assert.ok(result.cycles >= result.horizonCycles);
    assert.ok(result.cycles - result.horizonCycles < 25_000);
  }
  assert.equal(a.horizonCycles, b.horizonCycles);
});

test("a failure to read the package version leaves the version unknown and does not fail the engine", async () => {
  const engine = createLibsidplayfpEngine({
    emulation: "sidlite",
    importModule: async () => fakeModule({ perSlice: 1 }),
    readVersion: () => {
      throw new Error("package.json is not readable");
    },
  });
  const result = await engine.render({ sid: fakeSid, seconds: 0.1 });
  assert.equal(result.engine.version, "unknown");
  assert.equal(engine.version, "unknown");
  assert.equal(result.samples.length, 4410);
});
