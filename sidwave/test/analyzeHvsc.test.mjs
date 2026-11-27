// Local only: analysis, extraction, isolation and preservation of development tunes of the frozen corpus manifest
// (HVSC_DIR, default /home/chris/dev/c64/C64Music). Skipped when the collection is absent or CI is set. The held-out
// tunes of the manifest are never used here, and no HVSC data is written to the repository.
import test from "#test/runner";
import assert from "#test/assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSid, formatAnalysis } from "../src/analyze/analysis.ts";
import { cpuMicros } from "../src/analyze/common.ts";
import { extractInstruments } from "../src/analyze/instruments.ts";
import { isolateVoice } from "../src/analyze/isolate.ts";
import { createPreservation, verifyPreservation, writePreservation } from "../src/analyze/preserve.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { checkMarks } from "./helpers/analyzeKit.mjs";

const HVSC = process.env.HVSC_DIR ?? "/home/chris/dev/c64/C64Music";
const manifest = JSON.parse(readFileSync(new URL("../data/reconstruct/corpus-manifest.json", import.meta.url), "utf8"));
const skip = process.env.CI || !existsSync(HVSC) ? "HVSC_DIR is not available or CI is set; this test runs locally only" : false;
const SECONDS = 20;
const COUNT = Number(process.env.SIDWAVE_HVSC_COUNT ?? 4);

test("development tunes: analysis, extraction, isolation and preservation with offline verification", { skip, timeout: 900_000 }, async (t) => {
  const tunes = manifest.tunes.filter((x) => x.split === "development" && existsSync(join(HVSC, x.path)));
  const chosen = [];
  for (const entry of tunes) {
    const bytes = new Uint8Array(readFileSync(join(HVSC, entry.path)));
    if (createHash("md5").update(bytes).digest("hex") === entry.md5) chosen.push({ entry, bytes });
    if (chosen.length === COUNT) break;
  }
  assert.ok(chosen.length >= 1, "at least one development tune is present");
  const lines = [];
  for (const { entry, bytes } of chosen) {
    const song = entry.subtune;
    const cpu0 = cpuMicros();
    const wall0 = Date.now();
    const report = await analyzeSid(bytes, { engine: sharedEngine(), song, seconds: SECONDS });
    const analysisCpu = cpuMicros() - cpu0;
    checkMarks(report);
    assert.equal(report.horizon.seconds, SECONDS);
    assert.ok(report.techniques.every((x) => (x.basis === "inferred" && x.method) || ["oscillator sync", "ring modulation", "test bit", "noise", "combined waveforms", "multispeed", "sample playback"].includes(x.name)));
    assert.ok(formatAnalysis(report).length > 200);
    const library = await extractInstruments(bytes, { engine: sharedEngine(), song, seconds: SECONDS, created: "2026-11-27" });
    assert.match(library.library, /library:/);
    const loudest = report.voices.slice().sort((a, b) => (b.trace?.gateShare ?? 0) - (a.trace?.gateShare ?? 0))[0];
    let isolation = "isolated";
    try {
      const isolated = await isolateVoice(bytes, { voice: loudest.voice, engine: sharedEngine(), song, seconds: Math.min(SECONDS, 10) });
      assert.equal(isolated.method, "reconstruct-and-recompile");
    } catch (error) {
      // A reconstruction that does not compile cannot be muted; the command says so with the reason.
      assert.equal(error.details?.reason, "reconstruction_not_compilable", error.message);
      isolation = "isolation unavailable (the reconstruction does not compile)";
    }
    const dir = mkdtempSync(join(tmpdir(), "sidwave-hvsc-"));
    try {
      const bundle = await createPreservation(bytes, { engine: sharedEngine(), song, seconds: SECONDS, level: "none" });
      writePreservation(bundle, join(dir, "b"));
      const verified = await verifyPreservation(join(dir, "b"), { engine: sharedEngine() });
      assert.equal(verified.ok, true, JSON.stringify(verified.checks.filter((c) => !c.ok)));
      assert.ok(!bundle.files.has("original.sid"));
      assert.equal(bundle.manifest.rights.redistribution, "unknown");
      lines.push(`${entry.path} #${song}: strict ${bundle.manifest.verdict.strict ? "exact" : "not exact"}, ${report.techniques.map((x) => x.name).join("|") || "no technique"}, ${library.instruments.length} instruments, ${isolation}, key ${report.key ? `${report.key.tonic} ${report.key.mode}` : "-"}, ${report.horizon.calls} calls, wall ${Date.now() - wall0} ms, analysis CPU ${Math.round(analysisCpu / 1000)} ms (includes the reconstruction)`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(`\nDevelopment tunes (${SECONDS} s horizon)\n${lines.join("\n")}`);
  t.diagnostic?.(lines.join("\n"));
});
