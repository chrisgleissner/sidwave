// Preservation bundle: contents, rights handling, offline verification and tamper detection.
import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreservation, lookupStil, MANIFEST_FILE, ORIGINAL_FILE, verifyPreservation, writePreservation } from "../src/analyze/preserve.ts";
import { sha256 } from "../src/analyze/common.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { seededSid } from "./helpers/analyzeKit.mjs";

const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "sidwave-preserve-")); dirs.push(d); return d; };

const make = (sid, extra = {}) => createPreservation(sid, { engine: sharedEngine(), seconds: 3, level: "A0", ...extra });

test("the bundle holds the score, the report and the manifest; the original is never included by default", { timeout: 120_000 }, async () => {
  const sid = seededSid("combined", 3);
  const bundle = await make(sid);
  assert.deepEqual([...bundle.files.keys()].sort(), ["preservation.json", "reconstruction-report.json", "score.yaml"]);
  const m = bundle.manifest;
  assert.equal(m.schema, "sidwave-preservation/1");
  assert.equal(m.source.sha256, sha256(sid));
  assert.equal(m.source.md5.length, 32);
  assert.deepEqual({ subtune: m.source.subtune, songs: m.source.songs, originalIncluded: m.source.originalIncluded }, { subtune: 1, songs: 1, originalIncluded: false });
  assert.equal(m.referenceConfiguration.clock, "PAL");
  assert.equal(m.referenceConfiguration.sidCount, 1);
  assert.deepEqual(m.referenceConfiguration.sidAddresses, [0xd400]);
  assert.equal(m.referenceConfiguration.roms, "no ROMs");
  assert.equal(m.referenceConfiguration.emulation, "sidlite");
  assert.equal(m.identities.engine.id, "libsidplayfp-wasm");
  assert.match(m.identities.engine.version, /^\d+\.\d+\.\d+/);
  assert.equal(m.identities.compiler.name, "sidwave");
  assert.equal(typeof m.identities.irCodeVersion, "number");
  assert.deepEqual({ seconds: m.horizon.seconds, song: m.horizon.song, clock: m.horizon.clock }, { seconds: 3, song: 1, clock: "PAL" });
  assert.equal(m.verdict.strict, true);
  assert.equal(m.verdict.registerStateExact, true);
  assert.equal(m.verdict.t0, "not applicable");
  assert.equal(m.verdict.t1, "not applicable");
  assert.equal(m.verdict.a1.status, "approximate");
  assert.deepEqual(Object.keys(m.verdict.ladder), ["T0", "T1", "A0", "A1", "highest"]);
  assert.equal(m.verdict.ladder.A1, "not evaluated");
  assert.equal(m.fingerprints.reference, m.fingerprints.recompiled);
  assert.equal(m.fingerprints.referenceFirstCall, 1);
  assert.ok(m.compiled.bytes > 1000);
  assert.equal(m.rights.redistribution, "unknown");
  assert.match(m.rights.note, /not part of this bundle/);
  assert.equal(m.rights.author, "SIDWAVE");
  for (const [name, entry] of Object.entries(m.files)) assert.equal(entry.sha256, sha256(bundle.files.get(name)), name);
  assert.ok(!("preservation.json" in m.files), "the manifest does not list itself");
  assert.deepEqual(m.files["score.yaml"].role, "score");
});

test("the original SID is stored only with the caller's assertion of redistribution rights", { timeout: 120_000 }, async () => {
  const sid = seededSid("basic", 1);
  await assert.rejects(() => make(sid, { includeOriginal: true }), /redistribution is permitted/);
  const withOriginal = await make(sid, { includeOriginal: true, rightsPermitted: true });
  assert.deepEqual(withOriginal.files.get(ORIGINAL_FILE), sid);
  assert.equal(withOriginal.manifest.files[ORIGINAL_FILE].role, "original");
  assert.equal(withOriginal.manifest.source.originalIncluded, true);
  assert.equal(withOriginal.manifest.rights.redistribution, "permitted");
  assert.match(withOriginal.manifest.rights.note, /did not check/);
  // The assertion alone does not add the file.
  const flagOnly = await make(sid, { rightsPermitted: true });
  assert.ok(!flagOnly.files.has(ORIGINAL_FILE));
  assert.equal(flagOnly.manifest.rights.redistribution, "permitted");
});

test("the manifest and the bundle never contain the SID bytes unless the original is included", { timeout: 120_000 }, async () => {
  const sid = seededSid("basic", 3);
  const bundle = await make(sid);
  const needle = Buffer.from(sid.subarray(0x7c, 0x7c + 64));
  for (const [name, bytes] of bundle.files) assert.ok(!Buffer.from(bytes).includes(needle), `${name} holds SID payload bytes`);
});

test("verify: an untouched bundle verifies offline and reproduces the verdict", { timeout: 120_000 }, async () => {
  const dir = join(temp(), "b");
  writePreservation(await make(seededSid("combined", 1)), dir);
  assert.deepEqual(readdirSync(dir).sort(), ["preservation.json", "reconstruction-report.json", "score.yaml"]);
  const result = await verifyPreservation(dir, { engine: sharedEngine() });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.equal(result.verdict.reproduced, "recompiled trace matches the stored fingerprint");
  assert.deepEqual(result.checks.map((c) => c.name), ["file score.yaml", "file reconstruction-report.json", "no unlisted files", "original", "recompile", "trace fingerprint", "strict verdict consistent"]);
});

test("verify with the original re-derives the verdict from the original and the recompiled score", { timeout: 120_000 }, async () => {
  const dir = join(temp(), "b");
  writePreservation(await make(seededSid("pulse", 4), { includeOriginal: true, rightsPermitted: true }), dir);
  const result = await verifyPreservation(dir, { engine: sharedEngine() });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.equal(result.verdict.reproduced, "re-derived from the original");
  assert.ok(result.checks.some((c) => c.name === "verdict re-derived" && c.ok));
  assert.ok(result.checks.some((c) => c.name === "original checksums" && c.ok));
});

test("verify detects every kind of change: score, report, manifest hash, extra file, missing file, fingerprint and verdict", { timeout: 240_000 }, async () => {
  const base = temp();
  const bundle = await make(seededSid("combined", 1));
  const fresh = (name) => { const dir = join(base, name); writePreservation(bundle, dir); return dir; };
  const failing = async (dir) => (await verifyPreservation(dir, { engine: sharedEngine() })).checks.filter((c) => !c.ok).map((c) => c.name);
  const edit = (dir, file, fn) => writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), "utf8")));
  const manifest = (dir, fn) => edit(dir, MANIFEST_FILE, (t) => { const m = JSON.parse(t); fn(m); return JSON.stringify(m, null, 2); });

  let dir = fresh("score");
  edit(dir, "score.yaml", (t) => t.replace('note: "', 'note: "x'));
  assert.ok((await failing(dir)).includes("file score.yaml"));

  dir = fresh("score-valid");
  edit(dir, "score.yaml", (t) => t.replace("tempo: 187", "tempo: 150"));
  manifest(dir, (m) => { m.files["score.yaml"].sha256 = sha256(readFileSync(join(dir, "score.yaml"))); });
  const names = await failing(dir);
  assert.ok(names.includes("recompile") && names.includes("trace fingerprint"), `a score changed together with its manifest hash still fails: ${names}`);

  dir = fresh("report");
  edit(dir, "reconstruction-report.json", (t) => `${t} `);
  assert.deepEqual(await failing(dir), ["file reconstruction-report.json"]);

  dir = fresh("hash");
  manifest(dir, (m) => { m.files["score.yaml"].sha256 = "0".repeat(64); });
  assert.deepEqual(await failing(dir), ["file score.yaml"]);

  dir = fresh("extra");
  writeFileSync(join(dir, "original.sid"), "x");
  assert.deepEqual(await failing(dir), ["no unlisted files"]);

  dir = fresh("missing");
  rmSync(join(dir, "reconstruction-report.json"));
  assert.deepEqual(await failing(dir), ["file reconstruction-report.json"]);

  dir = fresh("fingerprint");
  manifest(dir, (m) => { m.fingerprints.recompiled = "f".repeat(64); });
  const fp = await failing(dir);
  assert.ok(fp.includes("trace fingerprint") && fp.includes("strict verdict consistent"), String(fp));

  dir = fresh("compiled");
  manifest(dir, (m) => { m.compiled.sha256 = "e".repeat(64); });
  assert.deepEqual(await failing(dir), ["recompile"]);

  dir = fresh("verdict");
  manifest(dir, (m) => { m.verdict.strict = true; m.fingerprints.reference = "a".repeat(64); });
  assert.ok((await failing(dir)).includes("strict verdict consistent"));
});

test("verify rejects a directory without a valid manifest", async () => {
  const dir = temp();
  await assert.rejects(() => verifyPreservation(dir, { engine: sharedEngine() }), /cannot read/);
  writeFileSync(join(dir, MANIFEST_FILE), "{ not json");
  await assert.rejects(() => verifyPreservation(dir, { engine: sharedEngine() }), /not valid JSON/);
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ schema: "other/1" }));
  await assert.rejects(() => verifyPreservation(dir, { engine: sharedEngine() }), /schema is "other\/1"/);
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ schema: "sidwave-preservation/1" }));
  await assert.rejects(() => verifyPreservation(dir, { engine: sharedEngine() }), /field files is missing/);
});

test("a bundle is written only into an empty directory", async () => {
  const dir = temp();
  writeFileSync(join(dir, "x"), "1");
  const bundle = await make(seededSid("basic", 1));
  assert.throws(() => writePreservation(bundle, dir), /is not empty/);
});

test("the known ambiguities of an inexact reconstruction are listed with the first difference and the unsupported features", { timeout: 120_000 }, async () => {
  const bundle = await make(new Uint8Array(buildFixture("nmiSampler").sid));
  assert.equal(bundle.manifest.verdict.strict, false);
  const kinds = bundle.manifest.ambiguities.map((a) => a.kind);
  assert.ok(kinds.some((k) => k.startsWith("unsupported: non_periodic_writes")), kinds.join("; "));
  assert.ok(kinds.includes("first difference") || kinds.includes("call count"));
  assert.ok(bundle.manifest.verdict.differingCalls > 0 || bundle.manifest.verdict.callCountMismatch);
  const dir = join(temp(), "b");
  writePreservation(bundle, dir);
  const result = await verifyPreservation(dir, { engine: sharedEngine() });
  assert.equal(result.ok, true, "a bundle of an inexact reconstruction still verifies: the recompiled trace matches its fingerprint");
  assert.equal(result.verdict.stored.strict, false);
});

test("STIL entries are copied from a local STIL file by their HVSC path", () => {
  const stil = "# header\n\n/MUSICIANS/A/Ass_It/DLL-Sound.sid\n  COMMENT: First line.\n   Second line.\n\n/MUSICIANS/B/Other.sid\n  COMMENT: Other.\n";
  assert.deepEqual(lookupStil(stil, "/MUSICIANS/A/Ass_It/DLL-Sound.sid"), { path: "/MUSICIANS/A/Ass_It/DLL-Sound.sid", text: "COMMENT: First line.\n   Second line." });
  assert.equal(lookupStil(stil, "MUSICIANS/B/Other.sid").text, "COMMENT: Other.");
  assert.equal(lookupStil(stil, "/MUSICIANS/C/None.sid"), undefined);
});

test("a subtune outside the file is rejected", async () => {
  await assert.rejects(() => make(seededSid("basic", 1), { song: 2 }), /song 2 is outside 1\.\.1/);
});

test("temporary directories of this file are removed", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
