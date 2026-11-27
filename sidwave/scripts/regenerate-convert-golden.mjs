// Regenerates test/fixtures/convert/golden-losses.json: the losses that `sidwave convert` reports for every importer x
// exporter pair of the conversion test matrix. Never edit the file by hand. Run:
//   node --import tsx/esm scripts/regenerate-convert-golden.mjs
// then review the diff: a changed loss is a changed conversion. The engine (libsidplayfp-wasm) must be installed,
// because the .sid input and the WAV target are part of the matrix.
import fs from "node:fs";
import { caseKey, caseList, runCase, GOLDEN_FILE } from "../test/helpers/convertMatrix.mjs";

try { await import("libsidplayfp-wasm"); } catch { console.error("libsidplayfp-wasm is not installed; the golden file needs the engine cases"); process.exit(1); }
const golden = {};
for (const { input, target } of caseList({ withEngine: true })) golden[caseKey(input, target)] = (await runCase(input, target)).golden;
fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(golden, null, 1)}\n`);
console.log(`${Object.keys(golden).length} cases written to ${GOLDEN_FILE}`);
