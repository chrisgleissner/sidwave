import test from "#test/runner";
import assert from "#test/assert";
import yaml from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { exportEvents } from "../src/interchange/events.js";
import { parseFurnace, writeFurnace, FurnaceError, MAX_FUR_INFLATED } from "../src/interchange/furnace.js";
import { importFurnace } from "../src/interchange/furnaceImport.js";
import { exportFurnace } from "../src/interchange/furnaceExport.js";
import { runCli } from "../src/cli.js";
import { fur228, fur240 } from "./helpers/furFixtures.mjs";

const pitches = (text) => exportEvents(parseSidwave(text)).voices.map((v) => v.notes.map((n) => n.pitch)).filter((p) => p.length);

test("hand-built Furnace modules (INFO version 228, INF2 version 240, compressed) import to the same notes", () => {
  for (const [label, bytes, version] of [["INFO", fur228(), 228], ["INF2", fur240(), 240], ["zlib", deflateSync(fur228()), 228]]) {
    const result = importFurnace(bytes);
    assert.equal(result.report.version, version, label);
    assert.equal(result.report.chip, "C64 (6581)");
    assert.equal(result.report.rows, 16);
    assert.deepEqual(pitches(result.yaml), [[60, 64, 67]], label);
    assert.equal(result.report.instruments[0].name, "lead");
    compileSidwaveToPrg(parseSidwave(result.yaml));
  }
  const detail = importFurnace(fur228());
  const doc = parseSidwave(detail.yaml);
  // 6 ticks per row at 60 ticks/s, 4 rows per beat: 150 BPM; the volume column of row 8 gives level 8.
  assert.equal(doc.song.tempo, 150);
  assert.ok(detail.yaml.includes("level: 8"));
  const inst = yaml.parse(detail.yaml).instruments.f00_lead;
  assert.deepEqual(inst.adsr, [0, 9, 10, 4]);
  assert.equal(inst.pulse_width, 2048);
  assert.deepEqual(inst.wavetable.map((s) => s.note), [undefined, "+4", "+7"]);
  assert.equal(inst.wavetable[0].frames, 2);
  assert.ok(detail.report.losses.some((l) => /arpeggio/.test(l)));
});

test("Furnace input is bounded and unsupported modules are refused", () => {
  assert.throws(() => parseFurnace(Buffer.from("not a module")), FurnaceError);
  assert.throws(() => parseFurnace(fur228().subarray(0, 100)), /truncated|outside/);
  assert.throws(() => parseFurnace(fur228({ chip: 0x83 })), /only the C64 chip/);
  assert.throws(() => parseFurnace(fur240({ chip: 0x06 })), /only the C64 chip/);
  const old = Buffer.from(fur228()); old.writeUInt16LE(100, 16);
  assert.throws(() => parseFurnace(old), /older than 157/);
  // A decompression bomb: a few KB of zlib that expands beyond the limit.
  const bomb = deflateSync(Buffer.alloc(MAX_FUR_INFLATED + 1024));
  assert.ok(bomb.length < 100_000);
  assert.throws(() => parseFurnace(bomb), /decompresses to more than/);
  assert.throws(() => parseFurnace(Buffer.from([0x78, 0x9c, 1, 2, 3])), FurnaceError);
  assert.throws(() => importFurnace(fur228(), { maxRows: 8 }), /limit/);
});

test("Furnace export: a module the reader and the importer accept, with losses listed", () => {
  const doc = parseSidwave(yaml.stringify({
    sidwave: 1.3, title: "Exp", author: "Me", tempo: 125,
    instruments: { lead: { waveform: "pulse", adsr: [0, 4, 8, 3], pulse_width: 0.5 }, bass: { waveform: "sawtooth", adsr: [0, 5, 9, 3] } },
    voices: [{ id: 1, instrument: "lead", patterns: { a: { length: 0.5, bars: 1, groove: "C4 E4 G4 E4 C5 G4 E4 C4" } } },
      { id: 2, instrument: "bass", role: "bass", patterns: { r: { length: 1, bars: 1, groove: "C2 C2 G2 G2" } } }],
    timeline: [{ section: "one", bars: 4, layers: { v1: "a", v2: "r" } }],
  }));
  const result = exportFurnace(doc);
  const song = parseFurnace(result.bytes);
  assert.equal(song.version, 228);
  assert.equal(song.name, "Exp");
  assert.deepEqual(song.chips, [0x47]);
  assert.equal(song.instruments.length, 2);
  assert.equal(song.instruments[1].c64.flags1, 2); // sawtooth
  assert.ok(result.losses.some((l) => /Filter/.test(l)));
  const back = importFurnace(result.bytes);
  const original = exportEvents(doc).voices.map((v) => v.notes.map((n) => n.pitch));
  assert.deepEqual(pitches(back.yaml), original);
  // The compressed form reads back to the same song.
  assert.deepEqual(parseFurnace(writeFurnace({ name: "x", author: "", chip: 0x07, tickRate: 50, speed: 6, patternLength: 8, orders: [[0, 0, 0]],
    patterns: [[[{ note: 108, ins: 0, vol: -1 }, ...Array.from({ length: 7 }, () => ({ note: -1, ins: -1, vol: -1 }))]], [[]], [[]]], instruments: [{ name: "i", flags1: 4, flags2: 0, ad: 0, sr: 0xf0, duty: 100 }] }, true)).chips, [0x07]);
});

test("sidwave import and export handle Furnace modules on the command line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-fur-"));
  try {
    const run = async (...args) => {
      const out = [], err = [];
      const code = await runCli(args, { cwd: dir, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
      return { code, out: out.join(""), err: err.join("") };
    };
    fs.writeFileSync(path.join(dir, "a.fur"), fur228());
    const imported = await run("import", "a.fur", "-o", "a.yaml", "--json");
    assert.equal(imported.code, 0, imported.err);
    assert.equal(JSON.parse(imported.out).result.format, "furnace");
    const exported = await run("export", "a.yaml", "-o", "b.fur", "--json");
    assert.equal(exported.code, 0, exported.err);
    assert.equal(parseFurnace(fs.readFileSync(path.join(dir, "b.fur"))).chips[0], 0x47);
    fs.writeFileSync(path.join(dir, "bad.fur"), "junk");
    assert.equal((await run("import", "bad.fur", "--json")).code, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const ROW_C4 = [0x03, 108, 0, 0xff]; // note C-4 and instrument 0 on row 0
const ROW_E4 = [0x03, 112, 0, 0xff];

test("Furnace order tables are channels-outer and a row with two effects reads each effect once", () => {
  // Two orders, three channels, distinct pattern numbers: bytes are channel 0 (0, 1), channel 1 (0, 0), channel 2 (2, 2).
  const bytes = fur228({ custom: { ordersLen: 2, orderBytes: [0, 1, 0, 0, 2, 2], patterns: [
    { channel: 0, index: 0, rows: ROW_C4 }, { channel: 0, index: 1, rows: ROW_E4 }, { channel: 1, index: 0, rows: [0xff] },
    { channel: 2, index: 2, rows: [0x03, 100, 0, 0xff] },
  ] } });
  const song = parseFurnace(bytes);
  assert.deepEqual(song.orders, [[0, 0, 2], [1, 0, 2]]);
  assert.deepEqual(importFurnace(bytes, { validate: false }).report.voices.map((v) => v.notes), [2, 0, 2]);
  // Effect 0 and effect 1 (extended mask 0x0f): the four bytes follow in bit order and each effect counts once.
  const withFx = parseFurnace(fur228({ custom: { ordersLen: 1, orderBytes: [0, 0, 0], patterns: [{ channel: 0, index: 0, rows: [0x01 | 0x20, 0x0f, 108, 0x00, 0x7f, 0x0d, 0x04, 0xff] }, { channel: 1, index: 0, rows: [0xff] }, { channel: 2, index: 0, rows: [0xff] }] } }));
  assert.equal(withFx.patterns.get(0).get(0).effects, 2);
  // The written module has the same channels-outer table.
  const written = writeFurnace({ name: "x", author: "", chip: 0x47, tickRate: 60, speed: 6, patternLength: 4, orders: [[0, 0, 1], [1, 0, 1]],
    patterns: [[[], []], [[]], [[], []]], instruments: [] });
  assert.deepEqual(parseFurnace(written).orders, [[0, 0, 1], [1, 0, 1]]);
});

test("mutated Furnace modules only raise typed errors", () => {
  const base = [fur228(), fur240(), deflateSync(fur228())];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let typed = 0;
  for (let i = 0; i < 1500; i++) {
    const copy = Buffer.from(base[i % 3]);
    for (let k = 0; k < 1 + rnd(4); k++) copy[rnd(copy.length)] = rnd(256);
    const input = rnd(8) === 0 ? copy.subarray(0, rnd(copy.length)) : copy;
    try { importFurnace(input, { validate: false }); } catch (error) {
      assert.ok(error instanceof FurnaceError, `${error.name}: ${error.message}`);
      typed++;
    }
  }
  assert.ok(typed > 100);
});
