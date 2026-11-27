// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Preservation bundle of a SID tune: the SIDWave score that reproduces it, the checksums of the source, the reference
// configuration, the identities of the tools, the horizon, the verdict, the known ambiguities and the rights fields,
// described by a manifest (`preservation.json`, schema sidwave-preservation/1, see doc/preservation.md) that holds the
// SHA-256 of every file. The original SID is stored only when the caller asserts that redistribution is permitted.
// `verifyPreservation` recompiles the score offline and checks every hash, the trace fingerprint and the verdict.

import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SidwaveOperationError } from "../cliCore.js";
import { psidClock, type SidEngine, type SystemRoms } from "../engine/libsidplayfp.js";
import { IR_CODE_VERSION, type FrameIr } from "../reconstruct/ir.js";
import { DEFAULT_HORIZON_SECONDS, bestFdiff, irOfTrace, stateOnlyIr, reconstructSid, type ReconstructReport } from "../reconstruct/reconstruct.js";
import { parseSidFile, songSpeed } from "../sidFile.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes } from "../sidwaveOps.js";
import { verifyTunes, type VerifyLevel } from "../sidwaveTools.js";
import type { A1Rules } from "../verify/index.js";
import { irFingerprint, md5, memoEngine, sha256, sliceIr } from "./common.js";

export const PRESERVATION_SCHEMA = "sidwave-preservation/1";
export const MANIFEST_FILE = "preservation.json";
export const SCORE_FILE = "score.yaml";
export const REPORT_FILE = "reconstruction-report.json";
/** Largest manifest that verify reads. */
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const ORIGINAL_FILE = "original.sid";

export type Redistribution = "unknown" | "permitted";

export interface PreservationManifest {
  schema: typeof PRESERVATION_SCHEMA;
  /** Every file of the bundle except the manifest itself. */
  files: Record<string, { sha256: string; bytes: number; role: "score" | "report" | "original" }>;
  source: { md5: string; sha256: string; bytes: number; subtune: number; songs: number; magic: string; version: number; originalIncluded: boolean };
  referenceConfiguration: {
    clock: "PAL" | "NTSC";
    headerClock: string;
    sidModels: string[];
    sidCount: number;
    /** SID base addresses from the header (the first SID is at $D400 unless the header says otherwise). */
    sidAddresses: number[];
    loadAddress: number;
    initAddress: number;
    playAddress: number;
    speed: "VBI" | "CIA";
    emulation: string;
    roms: "no ROMs" | { kernal?: string; basic?: string; chargen?: string };
  };
  identities: {
    sidwavePackage: { name: string; version: string };
    /** The SIDWave compiler and player are part of the sidwave package; their version is the package version. */
    compiler: { name: string; version: string };
    engine: { id: string; version: string; emulation: string };
    irCodeVersion: number;
    compileOptions: { format: "sid"; loop: boolean };
  };
  horizon: { seconds: number; cycles: number; calls: number; clock: string; song: number };
  verdict: {
    strict: boolean;
    registerStateExact: boolean;
    /** T0 and T1 compare the writes of one player; they do not apply to a score compiled by SIDWave. */
    t0: "not applicable";
    t1: "not applicable";
    a1: { status: string; result: "pass" | "fail" | "not evaluated" | "not run"; reason?: string; badWindows?: number; windows?: number };
    /** The levels of the ladder as evaluated (T0 and T1 are expected to fail for a compiled score); absent when the ladder was not run. */
    ladder?: { T0: string; T1: string; A0: string; A1: string; highest: string };
    differingCalls: number;
    firstDifference?: { class: string; call: number; timeSeconds: number; voice?: number; register?: number; expected?: number; observed?: number };
    callCountMismatch?: { expected: number; observed: number };
  };
  /**
   * SHA-256 over the register state and control-write order of the compared calls of the two traces (see
   * irFingerprint). `reference` is the original tune, `recompiled` the compiled score. They are equal when the strict
   * verdict holds. The original calls and the recompiled calls start at different call indexes (the init call is skipped).
   */
  fingerprints: { algorithm: string; calls: number; referenceFirstCall: number; recompiledFirstCall: number; reference: string; recompiled: string };
  compiled: { sha256: string; bytes: number } | null;
  ambiguities: Array<{ kind: string; detail: string }>;
  rights: {
    title: string;
    author: string;
    released: string;
    stil?: { path: string; text: string };
    /** "unknown" unless the caller asserted otherwise. */
    redistribution: Redistribution;
    note: string;
  };
}

export interface PreservationBundle {
  manifest: PreservationManifest;
  /** File name to content. Contains the manifest as preservation.json. */
  files: Map<string, Uint8Array>;
  report: ReconstructReport;
  /** Things the caller should know that are not errors, for example a STIL entry that was not found. */
  warnings: string[];
}

export interface PreserveOptions {
  engine: SidEngine;
  /** reSIDfp engine for A1; default: the same engine is not used for A1, so A1 is "not run" without it. */
  a1Engine?: SidEngine;
  song?: number;
  seconds?: number;
  /** Store the original SID. Requires `rightsPermitted`. */
  includeOriginal?: boolean;
  /** The caller asserts that redistribution of the original is permitted. */
  rightsPermitted?: boolean;
  /** Text of STIL.txt and the HVSC path of the tune (for example /MUSICIANS/X/Y.sid) to copy its STIL entry. */
  stil?: { text: string; path: string };
  /** Ladder level to evaluate for the A1 status. Default "A1"; "none" skips the ladder. */
  level?: VerifyLevel | "none";
  roms?: SystemRoms;
  rules?: A1Rules;
  signal?: AbortSignal;
}

function packageIdentity(): { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  return { name: manifest.name, version: manifest.version };
}

/** Longest STIL entry copied into a manifest, in characters. */
export const STIL_MAX_CHARS = 16_384;

/** The STIL block of an HVSC path: the lines from the path line to the next path line. */
export function lookupStil(stilText: string, hvscPath: string): { path: string; text: string } | undefined {
  const wanted = hvscPath.startsWith("/") ? hvscPath : `/${hvscPath}`;
  const lines = stilText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === wanted);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("/") ) end++;
  const text = lines.slice(start + 1, end).join("\n").trim();
  return { path: wanted, text: text.length > STIL_MAX_CHARS ? `${text.slice(0, STIL_MAX_CHARS)}\n[truncated at ${STIL_MAX_CHARS} characters]` : text };
}

function ambiguitiesOf(report: ReconstructReport): PreservationManifest["ambiguities"] {
  const out: PreservationManifest["ambiguities"] = [];
  for (const u of report.unsupported) out.push({ kind: `unsupported: ${u.kind}`, detail: u.detail });
  for (const e of report.languageExtensions) out.push({ kind: "language extension candidate", detail: `${e.construct}: ${e.reason} (${e.occurrences} occurrences)` });
  if (report.recovery.phantomNotes) out.push({ kind: "phantom notes", detail: `${report.recovery.phantomNotes} note(s) after the horizon were inferred from a hard restart visible inside it` });
  const ev = report.recovery.tuningEvidence;
  if (ev.distinctRegisters && ev.matched < 1) out.push({ kind: "tuning", detail: `${(ev.matched * 100).toFixed(1)}% of the note onsets have a frequency register that equals an equal-temperament note at ${report.recovery.tuningCents} cents; the others are approximated` });
  if (report.callRate.irregularShare > 0) out.push({ kind: "call timing", detail: `${(report.callRate.irregularShare * 100).toFixed(2)}% of the spacings between player calls are irregular` });
  if (report.fdiff.callCountMismatch) out.push({ kind: "call count", detail: `the tune has ${report.fdiff.callCountMismatch.expected} calls and the reconstruction ${report.fdiff.callCountMismatch.observed} within the horizon` });
  if (!report.strictExact && report.fdiff.first) out.push({ kind: "first difference", detail: `${report.fdiff.first.class} at call ${report.fdiff.first.call}${report.fdiff.first.detail ? `: ${report.fdiff.first.detail}` : ""}` });
  if (report.compile && !report.compile.ok) out.push({ kind: "compile", detail: report.compile.error ?? "the recovered score did not compile" });
  return out;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function createPreservation(sidBytes: Uint8Array, options: PreserveOptions): Promise<PreservationBundle> {
  if (options.includeOriginal && !options.rightsPermitted) {
    throw new SidwaveOperationError("usage", "the original SID is stored only when redistribution is permitted: pass --rights-permitted together with --include-original");
  }
  const file = parseSidFile(sidBytes);
  const song = options.song ?? file.startSong;
  if (song < 1 || song > file.songs) throw new SidwaveOperationError("input", `song ${song} is outside 1..${file.songs}`);
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const clock = psidClock(sidBytes) ?? "PAL";
  const engine = memoEngine(options.engine);
  const title = (file.name ? `${file.name} (reconstruction)` : "Reconstruction").slice(0, 200);
  const { score, report } = await reconstructSid(sidBytes, { engine, song, seconds, title });
  const original = irOfTrace(await engine.trace({ sid: sidBytes, song, seconds, clock }));
  let compiledBytes: Uint8Array | undefined;
  let recompiled: FrameIr | undefined;
  let traceEngine = { id: engine.id, version: engine.version, emulation: "sidlite" };
  if (report.compile?.ok) {
    compiledBytes = new Uint8Array(compileSidwaveBytes(parseSidwave(score), { format: "sid", loop: true }).bytes);
    const trace = await engine.trace({ sid: compiledBytes, seconds, clock });
    recompiled = irOfTrace(trace);
    traceEngine = trace.engine;
  }
  const alignment = report.fdiff.alignment;
  const compared = Math.min(original.calls.length - alignment.expectedCall, (recompiled?.calls.length ?? 0) - alignment.observedCall);
  const fingerprints = {
    algorithm: "sha256 over the call count and SID count, then for each compared call and SID the 25 registers and the control-write sequence of each voice",
    calls: Math.max(0, compared), referenceFirstCall: alignment.expectedCall, recompiledFirstCall: alignment.observedCall,
    reference: irFingerprint(sliceIr(original, alignment.expectedCall, alignment.expectedCall + Math.max(0, compared))),
    recompiled: recompiled ? irFingerprint(sliceIr(recompiled, alignment.observedCall, alignment.observedCall + Math.max(0, compared))) : "",
  };
  // Verification ladder for the A1 status.
  let a1: PreservationManifest["verdict"]["a1"] = { status: "approximate", result: "not run" };
  const level = options.level ?? "A1";
  let ladderLevels: NonNullable<PreservationManifest["verdict"]["ladder"]> | undefined;
  if (compiledBytes && level !== "none") {
    const ladder = await verifyTunes(
      { source: "original", kind: "sid", bytes: sidBytes, md5: md5(sidBytes) },
      { source: "reconstruction", kind: "score", bytes: compiledBytes, md5: md5(compiledBytes) },
      {
        level, seconds, song, clock,
        createEngine: (emulation) => {
          if (emulation === "sidlite") return engine;
          if (options.a1Engine) return options.a1Engine;
          throw new SidwaveOperationError("engine_unavailable", "the A1 ladder level needs a reSIDfp engine");
        },
        ...(options.roms ? { roms: options.roms } : {}), ...(options.rules ? { rules: options.rules } : {}), ...(options.signal ? { signal: options.signal } : {}),
      },
    ).catch((error: unknown) => {
      if (error instanceof SidwaveOperationError && error.category === "engine_unavailable") return undefined;
      throw error;
    });
    if (ladder?.a1) {
      a1 = {
        status: ladder.a1.status, result: ladder.levels.A1,
        ...(ladder.a1.reason ? { reason: ladder.a1.reason } : {}),
        ...(ladder.a1.windows === undefined ? {} : { windows: ladder.a1.windows, badWindows: ladder.a1.badWindows }),
      };
    } else if (ladder) a1 = { status: "approximate", result: ladder.levels.A1 };
    if (ladder) ladderLevels = { ...ladder.levels, highest: ladder.level };
    else a1 = { status: "approximate", result: "not run", reason: "no reSIDfp engine was supplied" };
  }
  const reportText = json(report);
  const files = new Map<string, Uint8Array>();
  const put = (name: string, content: string | Uint8Array) => files.set(name, typeof content === "string" ? new TextEncoder().encode(content) : content);
  put(SCORE_FILE, score);
  put(REPORT_FILE, reportText);
  const redistribution: Redistribution = options.rightsPermitted ? "permitted" : "unknown";
  if (options.includeOriginal) put(ORIGINAL_FILE, sidBytes);
  const manifest: PreservationManifest = {
    schema: PRESERVATION_SCHEMA,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length, role: name === SCORE_FILE ? "score" : name === ORIGINAL_FILE ? "original" : "report" }])) as PreservationManifest["files"],
    source: { md5: md5(sidBytes), sha256: sha256(sidBytes), bytes: sidBytes.length, subtune: song, songs: file.songs, magic: file.magic, version: file.version, originalIncluded: !!options.includeOriginal },
    referenceConfiguration: {
      clock, headerClock: file.clock, sidModels: [...file.sidModels], sidCount: original.sidCount,
      sidAddresses: [0xd400, ...(file.secondSidAddress === undefined ? [] : [0xd000 + file.secondSidAddress * 16]), ...(file.thirdSidAddress === undefined ? [] : [0xd000 + file.thirdSidAddress * 16])],
      loadAddress: file.loadAddress, initAddress: file.initAddress === 0 ? file.loadAddress : file.initAddress, playAddress: file.playAddress,
      speed: songSpeed(file, song), emulation: traceEngine.emulation,
      roms: options.roms && (options.roms.kernal || options.roms.basic || options.roms.chargen)
        ? { ...(options.roms.kernal ? { kernal: sha256(options.roms.kernal) } : {}), ...(options.roms.basic ? { basic: sha256(options.roms.basic) } : {}), ...(options.roms.chargen ? { chargen: sha256(options.roms.chargen) } : {}) }
        : "no ROMs",
    },
    identities: {
      sidwavePackage: packageIdentity(), compiler: { name: "sidwave", version: packageIdentity().version },
      engine: { id: traceEngine.id, version: engine.version, emulation: traceEngine.emulation }, irCodeVersion: IR_CODE_VERSION,
      compileOptions: { format: "sid", loop: true },
    },
    horizon: { seconds, cycles: report.horizon.cycles, calls: report.horizon.calls, clock: report.horizon.clock, song },
    verdict: {
      strict: report.strictExact, registerStateExact: report.registerStateExact, t0: "not applicable", t1: "not applicable", a1, ...(ladderLevels ? { ladder: ladderLevels } : {}),
      differingCalls: report.fdiff.differingCalls,
      ...(report.fdiff.first ? { firstDifference: { class: report.fdiff.first.class, call: report.fdiff.first.call, timeSeconds: report.fdiff.first.timeSeconds, voice: report.fdiff.first.voice, register: report.fdiff.first.register, expected: report.fdiff.first.expected, observed: report.fdiff.first.observed } } : {}),
      ...(report.fdiff.callCountMismatch ? { callCountMismatch: report.fdiff.callCountMismatch } : {}),
    },
    fingerprints,
    compiled: compiledBytes ? { sha256: sha256(compiledBytes), bytes: compiledBytes.length } : null,
    ambiguities: ambiguitiesOf(report),
    rights: {
      title: file.name, author: file.author, released: file.released,
      ...(options.stil ? (() => { const s = lookupStil(options.stil.text, options.stil.path); return s ? { stil: s } : {}; })() : {}),
      redistribution,
      note: options.rightsPermitted
        ? "The caller asserted that redistribution of the original is permitted; SIDWave did not check this."
        : "Redistribution rights are unknown. The original SID is not part of this bundle; the score is a reconstruction of a copyrighted work and may need the rights holder's permission to publish.",
    },
  };
  const warnings: string[] = [];
  if (options.stil && !manifest.rights.stil) {
    warnings.push(`no STIL entry for ${options.stil.path} in the STIL file; the manifest has no stil field`);
    manifest.ambiguities.push({ kind: "STIL", detail: `no entry for ${options.stil.path} was found in the supplied STIL file` });
  }
  put(MANIFEST_FILE, json(manifest));
  return { manifest, files, report, warnings };
}

export function writePreservation(bundle: PreservationBundle, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) throw new SidwaveOperationError("input", `${dir} is not empty; use an empty directory`, { file: dir });
    for (const [name, bytes] of bundle.files) writeFileSync(join(dir, name), bytes);
  } catch (error) {
    if (error instanceof SidwaveOperationError) throw error;
    throw new SidwaveOperationError("input", `cannot write ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: dir });
  }
}

// ---- verify --------------------------------------------------------------------------------------------------------

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
  /** Differences between the tools that made the bundle and the tools verifying it. They do not fail the verification on their own. */
  identityNotes: string[];
  /** Fields that verification cannot authenticate: they are the maker's statements. */
  unauthenticated: string[];
  verdict: { stored: { strict: boolean; registerStateExact: boolean }; reproduced: "recompiled trace matches the stored fingerprint" | "not reproduced" | "re-derived from the original" };
}

export interface VerifyPreservationOptions {
  engine: SidEngine;
  signal?: AbortSignal;
}

function readManifest(dir: string): PreservationManifest {
  const path = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new SidwaveOperationError("input", `${path} is not a regular file`, { file: path });
    if (info.size > MANIFEST_MAX_BYTES) throw new SidwaveOperationError("input", `${path} is ${info.size} bytes; the limit is ${MANIFEST_MAX_BYTES}`, { file: path });
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof SidwaveOperationError) throw error;
    throw new SidwaveOperationError("input", `cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: path });
  }
  let m: PreservationManifest;
  try {
    m = JSON.parse(text) as PreservationManifest;
  } catch (error) {
    throw new SidwaveOperationError("input", `${path} is not valid JSON: ${(error as Error).message}`, { file: path });
  }
  if (m.schema !== PRESERVATION_SCHEMA) throw new SidwaveOperationError("input", `${path}: schema is ${JSON.stringify(m.schema)}, expected ${PRESERVATION_SCHEMA}`, { file: path });
  for (const key of ["files", "source", "referenceConfiguration", "identities", "horizon", "verdict", "fingerprints", "rights"] as const) {
    if (typeof m[key] !== "object" || m[key] === null) throw new SidwaveOperationError("input", `${path}: the field ${key} is missing`, { file: path });
  }
  return m;
}

/** Verifies a bundle directory offline: hashes, recompilation, trace fingerprint and verdict. */
export async function verifyPreservation(dir: string, options: VerifyPreservationOptions): Promise<VerificationResult> {
  const root = resolve(dir);
  const manifest = readManifest(root);
  const checks: VerificationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const contents = new Map<string, Uint8Array>();
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (name.includes("/") || name.includes("\\") || name.startsWith(".") || name === MANIFEST_FILE) {
      add(`file ${name}`, false, "the manifest lists a name that is not a plain file of the bundle directory");
      continue;
    }
    const path = join(root, name);
    let info;
    try { info = lstatSync(path); } catch { add(`file ${name}`, false, "missing"); continue; }
    if (!info.isFile()) { add(`file ${name}`, false, "not a regular file (a link or a directory is not accepted)"); continue; }
    if (info.size > entry.bytes) { add(`file ${name}`, false, `${info.size} bytes on disk, the manifest says ${entry.bytes}; not read`); continue; }
    const bytes = new Uint8Array(readFileSync(path));
    contents.set(name, bytes);
    const actual = sha256(bytes);
    add(`file ${name}`, actual === entry.sha256 && bytes.length === entry.bytes, actual === entry.sha256 && bytes.length === entry.bytes ? "sha256 matches" : `sha256 ${actual} (${bytes.length} bytes), manifest ${entry.sha256} (${entry.bytes} bytes)`);
  }
  const listed = new Set([...Object.keys(manifest.files), MANIFEST_FILE]);
  const extra = readdirSync(root).filter((n) => !listed.has(n));
  add("no unlisted files", extra.length === 0, extra.length ? `not in the manifest: ${extra.join(", ")}` : "every file of the directory is listed");
  const original = contents.get(ORIGINAL_FILE);
  if (manifest.source.originalIncluded !== (ORIGINAL_FILE in manifest.files)) add("original", false, "source.originalIncluded does not match the file list");
  if (original) {
    add("original checksums", sha256(original) === manifest.source.sha256 && md5(original) === manifest.source.md5, "sha256 and md5 of original.sid against the manifest");
  } else if (ORIGINAL_FILE in manifest.files) add("original", false, "original.sid is listed but could not be read");
  else add("original", true, `original SID not included (redistribution ${manifest.rights.redistribution})`);
  if (original) add("redistribution", manifest.rights.redistribution === "permitted", manifest.rights.redistribution === "permitted" ? "the caller asserted that redistribution is permitted" : "original.sid is present but rights.redistribution is not \"permitted\"");
  const identityNotes: string[] = [];
  const here = packageIdentity();
  if (here.version !== manifest.identities.sidwavePackage.version) identityNotes.push(`sidwave ${manifest.identities.sidwavePackage.version} made the bundle, ${here.version} verifies it`);
  if (options.engine.version !== "unknown" && options.engine.version !== manifest.identities.engine.version) identityNotes.push(`engine ${manifest.identities.engine.version} made the bundle, ${options.engine.version} verifies it`);
  if (IR_CODE_VERSION !== manifest.identities.irCodeVersion) identityNotes.push(`IR version ${manifest.identities.irCodeVersion} made the bundle, ${IR_CODE_VERSION} verifies it`);
  if (manifest.identities.engine.id !== options.engine.id) identityNotes.push(`engine ${manifest.identities.engine.id} made the bundle, ${options.engine.id} verifies it`);
  if (manifest.identities.compiler.version !== here.version) identityNotes.push(`compiler ${manifest.identities.compiler.version} made the bundle, ${here.version} verifies it`);
  const cfg = manifest.referenceConfiguration;
  add("subtune consistent", manifest.horizon.song === manifest.source.subtune && manifest.source.subtune >= 1 && manifest.source.subtune <= manifest.source.songs, `horizon.song ${manifest.horizon.song}, source.subtune ${manifest.source.subtune} of ${manifest.source.songs}`);
  add("verdict flags consistent", !manifest.verdict.strict || manifest.verdict.registerStateExact, "a strict verdict implies registerStateExact");
  if (original) {
    try {
      const header = parseSidFile(original);
      const headerClock = psidClock(original) ?? "PAL";
      const mismatches = [
        ["songs", header.songs, manifest.source.songs], ["magic", header.magic, manifest.source.magic], ["version", header.version, manifest.source.version],
        ["headerClock", header.clock, cfg.headerClock], ["clock", headerClock, cfg.clock], ["loadAddress", header.loadAddress, cfg.loadAddress],
        ["initAddress", header.initAddress === 0 ? header.loadAddress : header.initAddress, cfg.initAddress], ["playAddress", header.playAddress, cfg.playAddress],
        ["speed", songSpeed(header, manifest.source.subtune), cfg.speed],
      ].filter(([, a, b]) => a !== b).map(([name, a, b]) => `${name} is ${String(a)} in original.sid and ${String(b)} in the manifest`);
      add("header consistent", mismatches.length === 0, mismatches.length ? mismatches.join("; ") : "songs, magic, version, clock, addresses and speed of original.sid match the manifest");
    } catch (error) {
      add("header consistent", false, `original.sid does not parse: ${(error as Error).message}`);
    }
  }
  let reproduced: VerificationResult["verdict"]["reproduced"] = "not reproduced";
  const scoreBytes = contents.get(SCORE_FILE);
  if (!scoreBytes) {
    add("recompile", false, "score.yaml is missing");
  } else if (manifest.compiled === null) {
    add("recompile", !manifest.verdict.strict, "the bundle records that the score did not compile");
  } else {
    let compiled: Uint8Array | undefined;
    let scoreMode = "";
    try {
      const doc = parseSidwave(Buffer.from(scoreBytes).toString("utf8"));
      scoreMode = doc.song.mode;
      compiled = new Uint8Array(compileSidwaveBytes(doc, { format: "sid", loop: manifest.identities.compileOptions.loop }).bytes);
    } catch (error) {
      add("recompile", false, `the score does not compile: ${(error as Error).message}`);
    }
    if (compiled) {
      const hash = sha256(compiled);
      add("recompile", hash === manifest.compiled.sha256 && compiled.length === manifest.compiled.bytes, hash === manifest.compiled.sha256 ? "the compiled SID matches the recorded sha256" : `compiled sha256 ${hash}, manifest ${manifest.compiled.sha256}${identityNotes.length ? ` (${identityNotes.join("; ")})` : ""}`);
      const engine = memoEngine(options.engine);
      const clock = manifest.horizon.clock === "NTSC" ? "NTSC" : "PAL";
      const trace = await engine.trace({ sid: compiled, seconds: manifest.horizon.seconds, clock, ...(options.signal ? { signal: options.signal } : {}) });
      const ir = irOfTrace(trace);
      const f = manifest.fingerprints;
      const fp = irFingerprint(sliceIr(ir, f.recompiledFirstCall, f.recompiledFirstCall + f.calls));
      const traceOk = fp === f.recompiled && ir.calls.length - f.recompiledFirstCall >= f.calls;
      add("trace fingerprint", traceOk, traceOk ? `the recompiled score gives the recorded register trace (${f.calls} calls)` : "the register trace of the recompiled score differs from the recorded fingerprint");
      if (traceOk) reproduced = "recompiled trace matches the stored fingerprint";
      const calls = manifest.horizon.calls;
      const noMismatch = !manifest.verdict.callCountMismatch;
      add("horizon calls", noMismatch ? calls === f.referenceFirstCall + f.calls : calls >= f.referenceFirstCall + f.calls, `horizon.calls ${calls}, fingerprints.calls ${f.calls} from call ${f.referenceFirstCall}${noMismatch ? "" : " (call count mismatch recorded)"}`);
      const hz = clock === "NTSC" ? 1_022_727 : 985_248;
      add("horizon cycles", manifest.horizon.seconds > 0 && manifest.horizon.seconds <= 180 && manifest.horizon.cycles >= manifest.horizon.seconds * hz && manifest.horizon.cycles <= manifest.horizon.seconds * hz + 1_000_000, `horizon.cycles ${manifest.horizon.cycles} for ${manifest.horizon.seconds} s at ${hz} Hz`);
      if (manifest.verdict.strict) add("strict verdict details", manifest.verdict.differingCalls === 0 && !manifest.verdict.callCountMismatch && !manifest.verdict.firstDifference, "a strict verdict has no differing call, no call-count mismatch and no first difference");
      add("clock consistent", scoreMode === manifest.referenceConfiguration.clock, `the score's mode ${scoreMode} against the recorded clock ${manifest.referenceConfiguration.clock}`);
      if (manifest.verdict.strict) add("SID count consistent", ir.sidCount === cfg.sidCount, `the recompiled trace has ${ir.sidCount} SID(s), the manifest ${cfg.sidCount}`);
      if (manifest.verdict.strict) add("strict verdict consistent", f.reference === f.recompiled, "a strict verdict needs equal reference and recompiled fingerprints");
      if (original) {
        const refIr = irOfTrace(await engine.trace({ sid: original, song: manifest.horizon.song, seconds: manifest.horizon.seconds, clock }));
        const summary = bestFdiff(refIr, ir, f.referenceFirstCall);
        const strict = summary.equal && summary.standardAlignment && !summary.callCountMismatch;
        add("verdict re-derived", strict === manifest.verdict.strict, `strict ${strict} from the original and the recompiled score, manifest ${manifest.verdict.strict}`);
        const state = bestFdiff(stateOnlyIr(refIr), stateOnlyIr(ir), f.referenceFirstCall);
        const registerState = state.standardAlignment && !state.callCountMismatch && state.differingCalls - state.classes.timing.differingCalls === 0;
        add("differing calls re-derived", summary.differingCalls === manifest.verdict.differingCalls && JSON.stringify(summary.callCountMismatch ?? null) === JSON.stringify(manifest.verdict.callCountMismatch ?? null), `${summary.differingCalls} differing calls and call-count mismatch ${JSON.stringify(summary.callCountMismatch ?? null)} from the original, manifest ${manifest.verdict.differingCalls} and ${JSON.stringify(manifest.verdict.callCountMismatch ?? null)}`);
        add("registerStateExact re-derived", registerState === manifest.verdict.registerStateExact, `register state exact ${registerState} from the original, manifest ${manifest.verdict.registerStateExact}`);
        add("original SID count", refIr.sidCount === cfg.sidCount, `the original trace has ${refIr.sidCount} SID(s), the manifest ${cfg.sidCount}`);
        reproduced = "re-derived from the original";
      }
    }
  }
  const unauthenticated = ["rights", "verdict.a1", "verdict.t0", "verdict.t1", "verdict.firstDifference", "ambiguities", "referenceConfiguration.roms", "referenceConfiguration.sidAddresses", "identities"];
  if (!original) unauthenticated.push("source (md5, sha256, bytes, songs, magic, version)", "referenceConfiguration (clock, headerClock, sidModels, addresses, speed)", "verdict.differingCalls", "verdict.callCountMismatch", ...(manifest.verdict.strict ? [] : ["verdict.strict", "verdict.registerStateExact"]), "fingerprints.reference");
  return { ok: checks.every((c) => c.ok), checks, identityNotes, unauthenticated, verdict: { stored: { strict: manifest.verdict.strict, registerStateExact: manifest.verdict.registerStateExact }, reproduced } };
}

/** The bundle as text for a terminal. */
export function formatPreservation(manifest: PreservationManifest): string {
  const v = manifest.verdict;
  return [
    `Preservation bundle for ${manifest.rights.title || "(untitled)"} by ${manifest.rights.author || "unknown"}, subtune ${manifest.source.subtune}`,
    `source md5 ${manifest.source.md5}, sha256 ${manifest.source.sha256}, original ${manifest.source.originalIncluded ? "included" : "not included"}`,
    `horizon ${manifest.horizon.seconds} s (${manifest.horizon.calls} calls), ${manifest.referenceConfiguration.clock}, ${manifest.referenceConfiguration.sidCount} SID, ${manifest.identities.engine.id} ${manifest.identities.engine.version} ${manifest.identities.engine.emulation}`,
    `verdict: strict ${v.strict ? "exact" : "not exact"}, register state ${v.registerStateExact ? "exact" : "differs"}, T0/T1 not applicable, A1 ${v.a1.result} (${v.a1.status})${v.a1.reason ? `: ${v.a1.reason}` : ""}`,
    `ambiguities: ${manifest.ambiguities.length}${manifest.ambiguities.map((a) => `\n  ${a.kind}: ${a.detail}`).join("")}`,
    `redistribution: ${manifest.rights.redistribution}`,
  ].join("\n") + "\n";
}
