// Differential check of a tracker import: the reference PSID (made by the tracker's own relocator) against the PSID
// compiled from the imported score, on the verification ladder (T0, T1, A0, A1) and by a per-call comparison of the
// frame-state IR (gate and note agreement; the frequency tables differ, so pitch is compared in semitones).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLibsidplayfpEngine } from "../../src/engine/libsidplayfp.ts";
import { buildIr, fdiff } from "../../src/reconstruct/index.ts";
import { parseSidwave } from "../../src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../../src/sidwaveCompiler.ts";
import { runCli } from "../../src/cli.ts";

const home = os.homedir();
export const GT2RELOC = process.env.GT2RELOC ?? path.join(home, ".c64bridge/sidwave-standalone/tools/goattracker2-upstream-2.77/linux/gt2reloc");
export const ROMS = process.env.SIDWAVE_ROMS ?? path.join(home, ".c64bridge/sidwave-standalone/open-roms");
export const haveGt2reloc = () => fs.existsSync(GT2RELOC);
export const haveEngine = async () => { try { await import("libsidplayfp-wasm"); return true; } catch { return false; } };

export function gt2reloc(sngPath, outPath, extra = []) {
  execFileSync(GT2RELOC, [sngPath, outPath, ...extra], { stdio: "ignore" });
  return fs.readFileSync(outPath);
}

export function compileScoreToSid(yamlText) {
  const doc = parseSidwave(yamlText);
  const prg = compileSidwaveToPrg(doc);
  return compileSidwaveToSid(doc, prg.prg ?? prg).sid;
}

const semitone = (reg) => (reg > 0 ? 12 * Math.log2(reg * 985248 / 16777216 / 440) + 69 : -1);

/**
 * Startup offset, in player calls, between the two players. The GoatTracker player starts a song with its call counter at
 * 5, so the first row is read on call 3 and its note starts on call 5 (tick 0); the wavetable sets the frequency on the
 * next call, so the first audible note with its pitch is on call 6 to 7. The SIDWave player plays the first note on
 * call 0. A reference made by gt2reloc therefore lags the SIDWave PSID by 7 calls (143 ms at 50 Hz); on the example songs
 * the best alignment is 7 or 8 calls (hard restart and the first row differ per song). Agreement is
 * computed at this pinned shift; a search over -12..12 is only used to check that the pinned value is the best one.
 */
export const GT_STARTUP_CALLS = 7;

function agreementAt(ref, cand, shift) {
  const gate = [0, 0, 0], both = [0, 0, 0], same = [0, 0, 0];
  let total = 0;
  const n = Math.min(ref.calls.length, cand.calls.length) - 14;
  for (let i = 14; i < n; i++) {
    const a = ref.calls[i].sids[0].regs, b = cand.calls[i + shift].sids[0].regs;
    total++;
    for (let v = 0; v < 3; v++) {
      const ga = a[v * 7 + 4] & 1, gb = b[v * 7 + 4] & 1;
      if (ga === gb) gate[v]++;
      if (ga && gb) {
        both[v]++;
        if (Math.abs(semitone(a[v * 7] | a[v * 7 + 1] << 8) - semitone(b[v * 7] | b[v * 7 + 1] << 8)) < 0.6) same[v]++;
      }
    }
  }
  return { shift, score: gate.reduce((s, x) => s + x, 0) + same.reduce((s, x) => s + x, 0), gate: gate.map((x) => x / total), pitch: same.map((x, v) => x / Math.max(1, both[v])), both };
}

/** `shift`: candidate call i + shift is compared with reference call i (negative: the candidate starts earlier). */
export function agreement(ref, cand, shift) {
  let best;
  for (let s = -12; s <= 12; s++) { const r = agreementAt(ref, cand, s); if (!best || r.score > best.score) best = r; }
  return { ...agreementAt(ref, cand, shift), bestShift: best.shift };
}

export async function irOf(sid, seconds) {
  const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
  const r = await engine.trace({ sid, seconds, clock: "PAL", maxRecords: 2_000_000 });
  return buildIr(r.records, { clock: "PAL", horizonCycles: r.horizonCycles, originCycle: r.originCycle });
}

/** Runs the ladder through the command line; returns the levels and the A1 status. */
export async function ladder(dir, refName, candName, seconds) {
  const out = [];
  const args = ["verify", refName, candName, "--seconds", String(seconds), "--json"];
  if (fs.existsSync(ROMS)) args.push("--roms", ROMS);
  await runCli(args, { cwd: dir, out: (t) => out.push(t), err: () => {}, outBytes: () => {} });
  const result = JSON.parse(out.join("")).result;
  return { levels: result.levels, a1: result.a1, level: result.level };
}

/** Compares a reference PSID with a candidate PSID: ladder, per-call agreement and F-diff class match shares. */
export async function compareSids(ref, cand, seconds = 6, shift = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-diff-"));
  try {
    fs.writeFileSync(path.join(dir, "ref.sid"), ref);
    fs.writeFileSync(path.join(dir, "cand.sid"), cand);
    const [a, b] = [await irOf(ref, seconds), await irOf(cand, seconds)];
    const agree = agreement(a, b, shift);
    // shift s: candidate call i + s matches reference call i
    const fd = fdiff(a, b, { alignExpected: Math.max(0, -agree.shift), alignObserved: Math.max(0, agree.shift) });
    return { ladder: await ladder(dir, "ref.sid", "cand.sid", seconds), agree, fdiffClasses: Object.fromEntries(Object.entries(fd.classes).map(([k, c]) => [k, Math.round(c.matchShare * 1000) / 1000])), calls: [a.calls.length, b.calls.length] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Import direction: gt2reloc of the song file against the compiled imported score. */
export async function differential({ sng, yamlText, seconds = 6 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-gtdiff-"));
  try {
    fs.writeFileSync(path.join(dir, "song.sng"), sng);
    const ref = gt2reloc(path.join(dir, "song.sng"), path.join(dir, "ref.sid"));
    return await compareSids(ref, compileScoreToSid(yamlText), seconds, -GT_STARTUP_CALLS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Export direction: the compiled score against gt2reloc of the exported song file. */
export async function differentialExport({ sng, yamlText, seconds = 6 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-gtdiff-"));
  try {
    fs.writeFileSync(path.join(dir, "song.sng"), sng);
    const cand = gt2reloc(path.join(dir, "song.sng"), path.join(dir, "cand.sid"));
    return await compareSids(compileScoreToSid(yamlText), cand, seconds, GT_STARTUP_CALLS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
