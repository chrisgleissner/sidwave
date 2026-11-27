// The conversion test matrix: every importer x exporter pair on committed fixtures. The formats come from the registry
// (src/interchange/registry.ts): a format that can be read needs a fixture entry below, and every format that can be
// written is a target. Shared by test/convertMatrix.test.mjs and scripts/regenerate-convert-golden.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError } from "../../src/cliCore.ts";
import { convert } from "../../src/interchange/convert.ts";
import { listFormats } from "../../src/interchange/registry.ts";
import { parseSidwave } from "../../src/sidwave.ts";
import { compileSidwaveBytes } from "../../src/sidwaveOps.ts";
import { gts } from "./gtFixtures.mjs";
import { fur228 } from "./furFixtures.mjs";
import { ctFile, smallSong } from "./ctFixtures.mjs";
import { smallSf2 } from "./sf2Fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_DIR = path.join(root, "test/fixtures/convert");
export const GOLDEN_DIR = path.join(FIXTURE_DIR, "golden");

const read = (file) => fs.readFileSync(path.join(root, file));
const generated = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name));

/**
 * Fixtures per readable format: [name, loader]. Binary fixtures in test/fixtures/convert are generated from the scores by
 * scripts/make-convert-fixtures.mjs; the others are committed or built by the test helpers. The first entry of a format
 * is the one that also runs the targets that need the engine.
 */
const FIXTURES = {
  sidwave: [
    ["fuer-elise", () => read("test/fixtures/sidwave-1.0/fuer-elise.yaml")],
    ["chiptune-drive", () => read("test/fixtures/sidwave-1.1/chiptune_drive.yaml")],
    ["chamber-waltz", () => read("test/fixtures/sidwave-1.2/chamber_waltz.yaml")],
    ["title-fanfare", () => read("test/fixtures/sidwave-1.2/title_fanfare.yaml")],
    ["digi-groove", () => read("test/fixtures/sidwave-1.2/digi_groove.yaml")],
  ],
  midi: ["fuer-elise", "chiptune-drive", "chamber-waltz", "title-fanfare"].map((n) => [n, () => generated(`${n}.mid`)]),
  musicxml: ["fuer-elise", "chiptune-drive", "title-fanfare"].map((n) => [n, () => generated(`${n}.musicxml`)]),
  abc: [["two-part-air", () => read("test/fixtures/abc/two-part-air.abc")]],
  goattracker: [...["fuer-elise", "chiptune-drive"].map((n) => [n, () => generated(`${n}.sng`)]), ["hand-authored", () => Buffer.from(gts())]],
  furnace: [...["fuer-elise", "chiptune-drive"].map((n) => [n, () => generated(`${n}.fur`)]), ["hand-authored", () => Buffer.from(fur228())]],
  sidwizard: [["fuer-elise", () => generated("fuer-elise.swm")], ["hand-built", () => read("test/fixtures/sidwizard/hand-built.swm")]],
  jch: [["hand-built", () => read("test/fixtures/jch/hand-built.prg")]],
  mod: [["four-channel", () => read("test/fixtures/mod/four-channel.mod")], ["effects", () => read("test/fixtures/mod/effects.mod")]],
  cheesecutter: [["small-song", () => Buffer.from(ctFile(smallSong()))]],
  sf2: [["small-song", () => Buffer.from(smallSf2())]],
  sid: [["fuer-elise", () => Buffer.from(compileSidwaveBytes(parseSidwave(read("test/fixtures/sidwave-1.0/fuer-elise.yaml").toString("utf8")), { format: "sid" }).bytes)]],
  "vice-dump": [["fur-elise", () => read("test/fixtures/traces/fur-elise.vice-dump.txt")]],
  siddump: [["fur-elise", () => read("test/fixtures/traces/fur-elise.siddump.txt")]],
};
const EXTENSION = { sidwave: ".yaml", midi: ".mid", musicxml: ".musicxml", abc: ".abc", goattracker: ".sng", furnace: ".fur", sidwizard: ".swm", mod: ".mod", jch: ".bin", cheesecutter: ".ct", sf2: ".sf2", sid: ".sid", "vice-dump": ".dump", siddump: ".siddump" };

export const FORMATS = listFormats();
/** Formats with a reader. Their fixtures are the inputs of the matrix. */
export const READABLE_FORMATS = FORMATS.filter((f) => f.read).map((f) => f.id);
/** Formats that can be written; every one is a target for every input. */
export const WRITABLE_FORMATS = FORMATS.filter((f) => f.write).map((f) => f.id);
/** Targets that can be read back exactly, so the quality of a conversion can be measured. */
export const READABLE_TARGETS = FORMATS.filter((f) => f.read && f.write && !f.readApproximate).map((f) => f.id);
/** Readable formats that have no fixture in this file: the matrix test fails on them. */
export const MISSING_FIXTURES = READABLE_FORMATS.filter((id) => !FIXTURES[id]);
/** Targets that render audio or traces with the engine. */
export const ENGINE_TARGETS = FORMATS.filter((f) => f.write && f.writeNeedsEngine).map((f) => f.id);
/** Formats whose reader needs the engine (a reconstruct). */
export const ENGINE_SOURCES = FORMATS.filter((f) => f.readApproximate).map((f) => f.id);

/** All inputs: { id, format, name, bytes, first, engine }. `engine` inputs are read by reconstruct. */
export function inputs() {
  const list = [];
  for (const format of READABLE_FORMATS) {
    (FIXTURES[format] ?? []).forEach(([name, load], index) => {
      list.push({ id: `${format}:${name}`, format, name: `${name}${EXTENSION[format] ?? ""}`, bytes: load(), first: index === 0, engine: ENGINE_SOURCES.includes(format) });
    });
  }
  return list;
}

/** Options of one conversion in the matrix. Short horizons keep the engine-based cases fast. */
/** Targets that embed a driver: the matrix hands them a small song built by the test helpers (SIDWave never ships a real driver). */
const DRIVERS = { cheesecutter: () => Uint8Array.from(ctFile(smallSong())), sf2: () => Uint8Array.from(smallSf2()) };

export const driverOptions = (target) => (DRIVERS[target] ? { driver: DRIVERS[target]() } : {});

export function caseOptions(input, target) {
  return { ...driverOptions(target), inputName: input.name, to: target, ...(input.engine ? { seconds: 4 } : {}), ...(ENGINE_TARGETS.includes(target) ? { seconds: 1 } : {}) };
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
export const goldenFile = (input) => path.join(GOLDEN_DIR, `${input.id.replace(/[^a-z0-9.-]+/gi, "_")}.json`);

/** Every case of the matrix. Engine inputs and engine targets are left out without the engine. */
export function caseList({ withEngine }) {
  const cases = [];
  for (const input of inputs()) {
    if (input.engine && !withEngine) continue;
    for (const target of WRITABLE_FORMATS) {
      if (input.format === target && (ENGINE_SOURCES.includes(target) || target === "sid")) continue;
      if (ENGINE_TARGETS.includes(target) && !(withEngine && input.first)) continue;
      cases.push({ input, target });
    }
  }
  return cases;
}
