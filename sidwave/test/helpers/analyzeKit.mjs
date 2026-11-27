// Helpers of the analysis, comparison, isolation and preservation tests.
import YAML from "yaml";
import { buildIr } from "../../src/reconstruct/ir.ts";
import { parseSidwave } from "../../src/sidwave.ts";
import { compileSidwaveBytes } from "../../src/sidwaveOps.ts";
import { irOfTrace } from "../../src/reconstruct/reconstruct.ts";
import { buildScore, sharedEngine } from "./reconstructRoundTrip.mjs";

export const sidOfScore = (text) => new Uint8Array(compileSidwaveBytes(parseSidwave(text), { format: "sid", loop: true }).bytes);
export const seededText = (feature, seed) => YAML.stringify(buildScore(feature, seed));
export const seededSid = (feature, seed) => sidOfScore(seededText(feature, seed));

export async function irOf(sid, seconds = 3) {
  return irOfTrace(await sharedEngine().trace({ sid, seconds, clock: "PAL" }));
}

/** Every object with a `basis` field is observed or inferred, and an inferred one names its method. Returns the number of marked facts. */
export function checkMarks(value, path = "$", found = { n: 0, observed: 0, inferred: 0 }) {
  if (Array.isArray(value)) value.forEach((v, i) => checkMarks(v, `${path}[${i}]`, found));
  else if (value && typeof value === "object") {
    if ("basis" in value) {
      if (value.basis !== "observed" && value.basis !== "inferred") throw new Error(`${path}.basis is ${value.basis}`);
      if (value.basis === "inferred" && !(typeof value.method === "string" && value.method.length > 0)) throw new Error(`${path} is inferred and names no method`);
      found.n++;
      found[value.basis]++;
    }
    for (const [k, v] of Object.entries(value)) if (k !== "histogram") checkMarks(v, `${path}.${k}`, found);
  }
  return found;
}

const PERIOD = 19_656;

/**
 * Builds a trace of `calls` player calls (one per PAL frame) from a function that returns the writes of a call as
 * [register, value] pairs for SID 0. Call 0 writes all 25 registers (the init call).
 */
export function syntheticIr(calls, writesOf, { sids = 1 } = {}) {
  const records = [];
  for (let c = 0; c < calls; c++) {
    const base = 1000 + c * PERIOD;
    const writes = c === 0 ? Array.from({ length: 25 }, (_, r) => [r, 0]) : writesOf(c);
    for (let s = 0; s < sids; s++) writes.forEach(([reg, value], i) => records.push(s, reg, value & 0xff, base + i * 20));
  }
  return buildIr(Float64Array.from(records), { clock: "PAL" });
}

export const freqWrites = (voice, f) => [[voice * 7, f & 0xff], [voice * 7 + 1, f >> 8]];
