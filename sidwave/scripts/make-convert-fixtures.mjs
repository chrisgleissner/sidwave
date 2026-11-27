// Regenerates the binary conversion fixtures in test/fixtures/convert/ from the committed SIDWave scores, with the
// exporters of this package. Run: node --import tsx/esm scripts/make-convert-fixtures.mjs
// The fixtures are inputs of the conversion test matrix (test/convertMatrix.test.mjs). Regenerate them only when an
// exporter changes on purpose, then review the diff of the golden losses (scripts/regenerate-convert-golden.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/interchange/convert.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "test/fixtures/convert");
fs.mkdirSync(out, { recursive: true });

const SOURCES = [
  ["fuer-elise", "test/fixtures/sidwave-1.0/fuer-elise.yaml", ["midi", "musicxml", "goattracker", "furnace"]],
  ["chiptune-drive", "test/fixtures/sidwave-1.1/chiptune_drive.yaml", ["midi", "musicxml", "goattracker", "furnace"]],
  // 22 tempo changes: the tempo map of MIDI.
  ["chamber-waltz", "test/fixtures/sidwave-1.2/chamber_waltz.yaml", ["midi"]],
  // Five voices on two SIDs: voice reduction.
  ["title-fanfare", "test/fixtures/sidwave-1.2/title_fanfare.yaml", ["midi", "musicxml"]],
];
const EXT = { midi: ".mid", musicxml: ".musicxml", goattracker: ".sng", furnace: ".fur" };

for (const [name, file, targets] of SOURCES) {
  const bytes = fs.readFileSync(path.join(root, file));
  for (const to of targets) {
    const result = await convert(bytes, { inputName: file, to });
    fs.writeFileSync(path.join(out, `${name}${EXT[to]}`), result.output);
    console.log(`${name}${EXT[to]}: ${result.output.length} bytes`);
  }
}
