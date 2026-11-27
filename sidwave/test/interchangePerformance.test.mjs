import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import { deflateSync } from "node:zlib";
import { parseSidwave } from "../src/sidwave.js";
import { importMusicXml } from "../src/interchange/musicxmlImport.js";
import { exportMusicXml } from "../src/interchange/musicxmlExport.js";
import { importGoatTracker } from "../src/interchange/goattrackerImport.js";
import { exportGoatTracker } from "../src/interchange/goattrackerExport.js";
import { importFurnace } from "../src/interchange/furnaceImport.js";
import { exportFurnace } from "../src/interchange/furnaceExport.js";
import { writeFurnace } from "../src/interchange/furnace.js";
import { gts } from "./helpers/gtFixtures.mjs";

const BOUND_SECONDS = 4; // generous: the measured times are far below this, but CI machines are shared
const cpu = (fn) => { const before = process.cpuUsage(); const out = fn(); const u = process.cpuUsage(before); return { out, seconds: (u.user + u.system) / 1e6 }; };
const report = (label, seconds) => console.log(`# cpu ${label}: ${seconds.toFixed(3)} s`);

// A long score: many bars, tempo changes every section, three voices.
function bigScore(bars) {
  const sections = [];
  for (let i = 0; i < bars; i += 2) sections.push({ section: `s${i}`, bars: 2, tempo: 100 + (i % 7) * 10, layers: { v1: "a", v2: "r" } });
  return parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Big", tempo: 120,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3] }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 1, bars: 2, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 2, groove: "C2 C2 G2 G2 C2 C2 G2 G2" } } }],
    timeline: sections,
  }));
}

test("MusicXML import and export of a 1500-bar score stay within the CPU bound", () => {
  const doc = bigScore(1500);
  const exp = cpu(() => exportMusicXml(doc));
  report("musicxml export (1500 bars, 1500 tempo entries)", exp.seconds);
  assert.ok(exp.seconds < BOUND_SECONDS, `export used ${exp.seconds} s`);
  const imp = cpu(() => importMusicXml(Buffer.from(exp.out.xml), { validate: false, limits: { maxBars: 5000, maxCells: 1_000_000 } }));
  report(`musicxml import (${(exp.out.xml.length / 1e6).toFixed(1)} MB)`, imp.seconds);
  assert.ok(imp.seconds < BOUND_SECONDS, `import used ${imp.seconds} s`);
  assert.equal(imp.out.report.bars, 1500);
});

test("MusicXML import of a score with thousands of tempo marks and chords is linear", () => {
  const measures = [];
  for (let m = 1; m <= 1800; m++) {
    measures.push(`<measure number="${m}">${m === 1 ? "<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>" : ""}<direction><sound tempo="${60 + (m % 100)}"/></direction>`
      + Array.from({ length: 4 }, (_, i) => `<note><pitch><step>${"CDEFGAB"[(m + i) % 7]}</step><octave>4</octave></pitch><duration>4</duration></note><note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration></note>`).join("") + "</measure>");
  }
  const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1">${measures.join("")}</part></score-partwise>`;
  const { out, seconds } = cpu(() => importMusicXml(Buffer.from(xml), { validate: false, limits: { maxBars: 5000 } }));
  report(`musicxml import (${(xml.length / 1e6).toFixed(1)} MB, 1800 tempo marks)`, seconds);
  assert.ok(seconds < BOUND_SECONDS, `used ${seconds} s`);
  assert.equal(out.report.bars, 1800);
});

test("GoatTracker import and export stay within the CPU bound on the largest allowed song", () => {
  // 3 channels, 254 order entries each (REPEAT 15 would exceed the row limit; use plain entries), 128-row patterns.
  const bytes = [...Buffer.from("GTS5"), ...new Array(96).fill(0), 1];
  for (let c = 0; c < 3; c++) { bytes.push(254 + 1); for (let i = 0; i < 254; i++) bytes.push(i % 200); bytes.push(0xff, 0); }
  bytes.push(1, 0x09, 0xa4, 1, 0, 0, 0, 0, 2, 0x11, ...Buffer.from("lead\0".padEnd(16, "\0")));
  bytes.push(2, 0x11, 0xff, 0, 0, 0, 0, 0, 0, 0, 0);
  bytes.splice(bytes.length - 8, 8, 0, 0, 0, 0, 0, 0, 0, 0);
  bytes.push(200);
  for (let p = 0; p < 200; p++) {
    bytes.push(129);
    for (let r = 0; r < 128; r++) bytes.push(r % 4 === 0 ? 0x90 + ((p + r) % 12) : 0xbd, r === 0 ? 1 : 0, 0, 0);
    bytes.push(0xff, 0, 0, 0);
  }
  const file = Buffer.from(bytes);
  const imp = cpu(() => importGoatTracker(file, { maxRows: 100_000, validate: false }));
  report(`goattracker import (${imp.out.report.rows} rows x 3 channels)`, imp.seconds);
  assert.ok(imp.seconds < BOUND_SECONDS, `import used ${imp.seconds} s`);
  const doc = bigScore(100);
  const exp = cpu(() => exportGoatTracker(doc));
  report("goattracker export (100 bars)", exp.seconds);
  assert.ok(exp.seconds < BOUND_SECONDS, `export used ${exp.seconds} s`);
  const small = cpu(() => importGoatTracker(gts()));
  report("goattracker import (small song, with SIDWave validation)", small.seconds);
  assert.ok(small.seconds < BOUND_SECONDS);
});

test("Furnace import and export stay within the CPU bound on a large module", () => {
  const rows = (n) => Array.from({ length: 64 }, (_, r) => (r % 4 === 0 ? { note: 100 + ((n + r) % 12), ins: 0, vol: -1 } : { note: -1, ins: -1, vol: -1 }));
  const orders = Array.from({ length: 256 }, (_, o) => [o, o, o]);
  const patterns = [0, 1, 2].map(() => Array.from({ length: 256 }, (_, n) => rows(n)));
  const file = writeFurnace({ name: "Big", author: "", chip: 0x47, tickRate: 60, speed: 6, patternLength: 64, orders, patterns,
    instruments: [{ name: "i", flags1: 4, flags2: 0, ad: 0x09, sr: 0xa4, duty: 2048 }] }, true);
  const imp = cpu(() => importFurnace(file, { validate: false }));
  report(`furnace import (${file.length} bytes compressed, 16384 rows x 3)`, imp.seconds);
  assert.ok(imp.seconds < BOUND_SECONDS, `import used ${imp.seconds} s`);
  const exp = cpu(() => exportFurnace(bigScore(300)));
  report("furnace export (300 bars)", exp.seconds);
  assert.ok(exp.seconds < BOUND_SECONDS, `export used ${exp.seconds} s`);
  void deflateSync;
});

test("a normal-sized file imports with SIDWave validation in a fraction of a second", () => {
  const doc = bigScore(40);
  const xml = exportMusicXml(doc).xml;
  const { out, seconds } = cpu(() => importMusicXml(Buffer.from(xml)));
  report(`musicxml import with validation (${(xml.length / 1e3).toFixed(0)} KB, 40 bars)`, seconds);
  assert.ok(seconds < BOUND_SECONDS);
  assert.equal(out.report.bars, 40);
  const g = cpu(() => importGoatTracker(gts()));
  report("goattracker import with validation (small song)", g.seconds);
  assert.ok(g.seconds < BOUND_SECONDS);
});
