// Seeded score builders, the round trip and the shrinker of the reconstruction property tests.
//
// A feature score is built from a seed with a fixed pseudo-random sequence (mulberry32), compiled with the
// production compiler, traced on SIDLite, reconstructed, recompiled and traced again. The two traces are
// compared call by call (F-diff). A failing score is shrunk by deleting parts while the failure persists.
import YAML from "yaml";
import { createLibsidplayfpEngine } from "../../src/engine/libsidplayfp.ts";
import { parseSidwave } from "../../src/sidwave.ts";
import { compileSidwaveBytes } from "../../src/sidwaveOps.ts";
import { generateSidwave, MUSIC_STYLES } from "../../src/audio/generateSidwave.ts";
import { reconstructSid } from "../../src/reconstruct/reconstruct.ts";

export const FEATURES = ["basic", "pulse", "arpeggio", "hard_restart", "multispeed", "vibrato", "filter", "combined", "generator"];
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** The seeds the tests run: all eight, for every feature. */
/** Horizon of the round trip in seconds. */
export const SECONDS = 3;

export function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

const NOTES = ["C3", "D3", "E3", "G3", "A3", "C4", "D4", "E4", "F4", "G4", "A4", "C5", "D5", "E5", "G5"];
const WAVES = ["pulse", "sawtooth", "triangle"];
const LENS = [0.25, 0.5, 0.75, 1, 1.5];

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function groove(rand, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (rand() < 0.2) out.push("-");
    else out.push({ note: pick(rand, NOTES), len: pick(rand, LENS) });
  }
  return out;
}

/** Builds the score object of a feature and a seed. */
export function buildScore(feature, seed) {
  if (feature === "generator") {
    const styles = Object.keys(MUSIC_STYLES);
    return generateSidwave({ root: "C3", preset: "classic", style: styles[seed % styles.length], seed, system: "PAL" }).score;
  }
  const rand = random(seed * 7919 + feature.length);
  const speed = feature === "multispeed" || (feature === "combined" && seed % 2 === 0) ? 2 + (seed % 2) : 1;
  // "combined" gives every voice a different mix of the features above.
  const has = (name, v) => feature === name || (feature === "combined" && ({ pulse: [1, 3], arpeggio: [2], hard_restart: [1, 2, 3], vibrato: [2, 3], filter: [1] })[name]?.includes(v));
  const instruments = {};
  const voices = [];
  for (let v = 1; v <= 3; v++) {
    const name = `lead${v}`;
    const inst = {
      waveform: pick(rand, WAVES),
      adsr: [Math.floor(rand() * 4), Math.floor(rand() * 8), 4 + Math.floor(rand() * 10), Math.floor(rand() * 8)],
    };
    if (has("pulse", v)) {
      inst.waveform = "pulse";
      inst.pulse_width = 500 + Math.floor(rand() * 2500);
      inst.pulsetable = { steps: [{ set: 400 + Math.floor(rand() * 1000), calls: 1 }, { add: 10 + Math.floor(rand() * 30), calls: 20 }, { add: -(10 + Math.floor(rand() * 30)), calls: 20 }], loop: 1 };
    }
    if (has("arpeggio", v)) {
      const offsets = pick(rand, [["+0", "+4", "+7"], ["+0", "+3", "+7", "+12"], ["+0", "+7"], ["+0", "+5", "+9"]]);
      inst.wavetable = offsets.map((note) => ({ note, calls: 1 + Math.floor(rand() * 3) }));
      inst.loop = 0;
    }
    if (has("hard_restart", v)) {
      const frames = pick(rand, [0, 1, 2, 3]);
      inst.hard_restart = { frames, ...(frames && rand() < 0.5 ? { adsr: [0, 0, Math.floor(rand() * 4), 0] } : {}), ...(frames && rand() < 0.4 ? { test: true } : {}) };
    }
    if (has("vibrato", v)) inst.vibrato = { depth: pick(rand, [0.15, 0.25, 0.4]), rate: pick(rand, [3, 4.5, 6]), delay: pick(rand, [0, 4, 8]) };
    if (has("filter", v)) {
      if (v === 1) inst.filtertable = { steps: [{ cutoff: 400 + Math.floor(rand() * 800), resonance: 4 + Math.floor(rand() * 8), type: "lowpass", frames: 1 }, { add: 10, frames: 20 }] };
    }
    instruments[name] = inst;
    const patterns = { A: { length: 0.5, groove: groove(rand, 12) }, B: { length: 0.5, groove: groove(rand, 12) } };
    voices.push({ id: v, instrument: name, patterns });
  }
  const bar = () => (seed % 2 ? "A B A*2" : "A A B");
  return {
    sidwave: "1.4", title: `${feature} ${seed}`, tempo: 110 + (seed % 5) * 10, mode: "PAL", speed,
    ...(feature === "filter" || feature === "combined" ? { sids: [{ id: "sid1", address: "$D400", model: "6581" }] } : {}),
    instruments, voices,
    timeline: [{ section: "Main", bars: 4, layers: Object.fromEntries(voices.map((v, i) => [`v${v.id}`, bar(i)])) }],
  };
}

let engine;
export function sharedEngine() {
  engine ??= createLibsidplayfpEngine({ emulation: "sidlite" });
  return engine;
}

/** Compiles a score object (or YAML text), reconstructs it and returns the reconstruct result. */
export async function roundTrip(score, seconds = SECONDS) {
  const text = typeof score === "string" ? score : YAML.stringify(score);
  const compiled = compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true });
  const result = await reconstructSid(new Uint8Array(compiled.bytes), { engine: sharedEngine(), seconds });
  return { text, ...result };
}

/** Number of differing calls in the register-state classes (everything except call timing). */
export function stateDifferences(report) {
  const c = report.fdiffState.classes;
  return Object.entries(c).filter(([k]) => k !== "timing").reduce((n, [, v]) => n + v.differingCalls, 0);
}

/** strict: the F-diff of the complete IRs is equal ("exact"); otherwise the secondary register-state value decides "state_exact". */
export function verdict(report) {
  if (report.compile?.ok === false) return "compile_failed";
  if (report.fdiffState.callCountMismatch) return "call_count";
  if (report.strictExact) return "exact";
  if (report.registerStateExact) return "state_exact";
  return "different";
}

/** Deletes parts of a failing score while `fails(score)` stays true. Bounded by `budget` evaluations. */
export async function shrink(score, fails, budget = 80) {
  let current = JSON.parse(JSON.stringify(score));
  let evaluations = 0;
  const paths = (value, prefix = []) => {
    const out = [];
    if (Array.isArray(value)) value.forEach((v, i) => out.push([...prefix, i], ...paths(v, [...prefix, i])));
    else if (value && typeof value === "object") for (const k of Object.keys(value)) out.push([...prefix, k], ...paths(value[k], [...prefix, k]));
    return out;
  };
  const without = (root, path) => {
    const copy = JSON.parse(JSON.stringify(root));
    let node = copy;
    for (const key of path.slice(0, -1)) node = node[key];
    const last = path[path.length - 1];
    if (Array.isArray(node)) node.splice(last, 1);
    else delete node[last];
    return copy;
  };
  let progress = true;
  while (progress && evaluations < budget) {
    progress = false;
    for (const path of paths(current).reverse()) {
      if (evaluations >= budget) break;
      const candidate = without(current, path);
      let valid = true;
      try { parseSidwave(candidate); compileSidwaveBytes(parseSidwave(candidate), { format: "sid", loop: true }); } catch { valid = false; }
      if (!valid) continue;
      evaluations++;
      if (await fails(candidate)) { current = candidate; progress = true; break; }
    }
  }
  return current;
}
