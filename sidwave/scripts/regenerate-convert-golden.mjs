// Regenerates the golden losses in test/fixtures/convert/golden/ (one file per input): the losses that `sidwave convert`
// reports for every importer x exporter pair of the conversion test matrix. Never edit the files by hand. Run:
//   node --import tsx/esm scripts/regenerate-convert-golden.mjs
// then review the diff: a changed loss is a changed conversion. The engine (libsidplayfp-wasm) must be installed,
// because the .sid and trace inputs and the WAV and VICE dump targets are part of the matrix.
import fs from "node:fs";
import { GOLDEN_DIR, caseKey, caseList, goldenFile, runCase } from "../test/helpers/convertMatrix.mjs";

try { await import("libsidplayfp-wasm"); } catch { console.error("libsidplayfp-wasm is not installed; the golden files need the engine cases"); process.exit(1); }
fs.rmSync(GOLDEN_DIR, { recursive: true, force: true });
fs.mkdirSync(GOLDEN_DIR, { recursive: true });
const byInput = new Map();
for (const { input, target } of caseList({ withEngine: true })) {
  const entry = byInput.get(input.id) ?? { input, golden: {} };
  entry.golden[caseKey(input, target)] = (await runCase(input, target)).golden;
  byInput.set(input.id, entry);
}
let cases = 0;
for (const { input, golden } of byInput.values()) { fs.writeFileSync(goldenFile(input), `${JSON.stringify(golden, null, 1)}\n`); cases += Object.keys(golden).length; }
console.log(`${cases} cases in ${byInput.size} files written to ${GOLDEN_DIR}`);
