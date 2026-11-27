// The conversion test matrix: every importer x exporter pair on committed fixtures. Shared by
// test/convertMatrix.test.mjs and scripts/regenerate-convert-golden.mjs, so both enumerate the same cases.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError } from "../../src/cliCore.ts";
import { convert } from "../../src/interchange/convert.ts";
import { parseSidwave } from "../../src/sidwave.ts";
import { compileSidwaveBytes } from "../../src/sidwaveOps.ts";
import { gts } from "./gtFixtures.mjs";
import { fur228 } from "./furFixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_DIR = path.join(root, "test/fixtures/convert");
export const GOLDEN_FILE = path.join(FIXTURE_DIR, "golden-losses.json");

const read = (file) => fs.readFileSync(path.join(root, file));

const SCORES = [
  ["fuer-elise", "test/fixtures/sidwave-1.0/fuer-elise.yaml"],
  ["chiptune-drive", "test/fixtures/sidwave-1.1/chiptune_drive.yaml"],
  ["chamber-waltz", "test/fixtures/sidwave-1.2/chamber_waltz.yaml"],
  ["title-fanfare", "test/fixtures/sidwave-1.2/title_fanfare.yaml"],
  ["digi-groove", "test/fixtures/sidwave-1.2/digi_groove.yaml"],
];
const BINARY = [
  ["midi", ".mid", ["fuer-elise", "chiptune-drive", "chamber-waltz", "title-fanfare"]],
  ["musicxml", ".musicxml", ["fuer-elise", "chiptune-drive", "chamber-waltz", "title-fanfare"]],
  ["goattracker", ".sng", ["fuer-elise", "chiptune-drive", "chamber-waltz"]],
  ["furnace", ".fur", ["fuer-elise", "chiptune-drive", "chamber-waltz"]],
];

/** Targets run for every input. WAV needs the audio engine and is run for one fixture per input format. */
export const TARGETS = ["sidwave", "midi", "musicxml", "goattracker", "furnace", "prg", "sid", "events"];
/** Targets that can be read back, so the quality of a conversion can be measured. */
export const READABLE_TARGETS = ["sidwave", "midi", "musicxml", "goattracker", "furnace"];

/** All inputs: { id, format, name, bytes, wav, sid }. `sid` inputs are read by reconstruct and need the engine. */
export function inputs() {
  const list = [];
  for (const [id, file] of SCORES) list.push({ id: `sidwave:${id}`, format: "sidwave", name: `${id}.yaml`, bytes: read(file), wav: id === "fuer-elise" });
  for (const [format, ext, ids] of BINARY) {
    for (const id of ids) list.push({ id: `${format}:${id}`, format, name: `${id}${ext}`, bytes: fs.readFileSync(path.join(FIXTURE_DIR, `${id}${ext}`)), wav: id === "fuer-elise" });
  }
  list.push({ id: "goattracker:hand-authored", format: "goattracker", name: "hand.sng", bytes: Buffer.from(gts()), wav: false });
  list.push({ id: "furnace:hand-authored", format: "furnace", name: "hand.fur", bytes: Buffer.from(fur228()), wav: false });
  const sid = compileSidwaveBytes(parseSidwave(read("test/fixtures/sidwave-1.0/fuer-elise.yaml").toString("utf8")), { format: "sid" }).bytes;
  list.push({ id: "sid:fuer-elise", format: "sid", name: "fuer-elise.sid", bytes: Buffer.from(sid), wav: true, sid: true });
  return list;
}

/** Options of one conversion in the matrix. Short horizons keep the engine-based cases fast. */
export function caseOptions(input, target) {
  return { inputName: input.name, to: target, ...(input.sid ? { seconds: 4 } : {}), ...(target === "wav" ? { seconds: 1 } : {}) };
}

/** Runs one conversion; the result is what the golden file stores. Never throws. */
export async function runCase(input, target, extra = {}) {
  try {
    const result = await convert(input.bytes, { ...caseOptions(input, target), ...extra });
    return { ok: true, result, golden: { ok: true, losses: result.losses.map(({ stage, code, severity, count, where, message }) => ({ stage, code, severity, count, ...(where ? { where } : {}), message })) } };
  } catch (error) {
    const report = classifyError(error);
    return { ok: false, error, category: report.category, golden: { ok: false, category: report.category, message: report.message } };
  }
}

export const caseKey = (input, target) => `${input.id} -> ${target}`;

export function caseList({ withEngine }) {
  const cases = [];
  for (const input of inputs()) {
    if (input.sid && !withEngine) continue;
    for (const target of TARGETS) if (!(input.format === target && target === "sid")) cases.push({ input, target });
    if (input.wav && withEngine) cases.push({ input, target: "wav" });
  }
  return cases;
}
