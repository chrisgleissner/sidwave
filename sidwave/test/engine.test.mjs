import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.ts";
import {
  createLibsidplayfpEngine,
  SidEngineUnavailableError,
  TraceOverflowError,
} from "../src/engine/libsidplayfp.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/sound/examples");

async function tune(name = "funk_bass", vbi = false) {
  const doc = parseSidwave(await readFile(path.join(root, `${name}.yaml`), "utf8"));
  if (vbi) doc.speed = 1;
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
  assert.deepEqual(concatenate(chunks), streamed.records);
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
  assert.equal(result.records.length, result.count * 4);
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
