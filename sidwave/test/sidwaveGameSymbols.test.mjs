import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemblyToPrgDetailed } from "6502-toolkit/assembler";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwave, freePageRange, sidwaveGamePsid } from "../src/sidwaveGame.js";
import { parseSidFile } from "../src/sidFile.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { gameMachine, sidTrace } from "./helpers/sidwaveGameHarness.mjs";

const load = (name) => parseSidwave(readSidwaveExample(name));
const ALL = ["acme", "kickass", "ca65", "vice", "json"];
const elise = (extra = {}) => compileSidwave(load("fuer_elise"), { target: "game", origin: 0x1000, measure: false, symbols: ALL, ...extra });
const entries = (text, pattern) => text.split("\n").filter((line) => pattern.test(line));

const ELISE_LABELS = {
  sidwave_init: 0x1000, sidwave_play: 0x1003, sidwave_stop: 0x1006, sidwave_sfx: 0x1009,
  sidwave_ram: 0x1e3f, sidwave_ram_end: 0x1f73, sidwave_zp_ptr: 0xfb, sidwave_play_calls_per_frame: 1,
};

test("the symbol files hold the entry points and the contract labels in every format", () => {
  const b = elise();
  assert.deepEqual(Object.keys(b.symbols), ALL);
  assert.deepEqual(b.labels, ELISE_LABELS);
  assert.deepEqual(entries(b.symbols.acme, /^sidwave_/).map((line) => line.split(" ; ")[0]), [
    "sidwave_init = $1000", "sidwave_play = $1003", "sidwave_stop = $1006", "sidwave_sfx = $1009",
    "sidwave_ram = $1E3F", "sidwave_ram_end = $1F73", "sidwave_zp_ptr = $FB", "sidwave_play_calls_per_frame = $01",
  ]);
  assert.deepEqual(entries(b.symbols.kickass, /^\.label /).map((line) => line.split(" // ")[0]), [
    ".label sidwave_init=$1000", ".label sidwave_play=$1003", ".label sidwave_stop=$1006", ".label sidwave_sfx=$1009",
    ".label sidwave_ram=$1E3F", ".label sidwave_ram_end=$1F73", ".label sidwave_zp_ptr=$FB", ".label sidwave_play_calls_per_frame=$01",
  ]);
  assert.deepEqual(entries(b.symbols.ca65, /^sidwave_/).map((line) => line.split(" ; ")[0]), entries(b.symbols.acme, /^sidwave_/).map((line) => line.split(" ; ")[0]));
  assert.ok(b.symbols.ca65.includes("; .export sidwave_init, sidwave_play, sidwave_stop, sidwave_sfx, sidwave_ram, sidwave_ram_end, sidwave_zp_ptr, sidwave_play_calls_per_frame\n"));
  assert.equal(b.symbols.vice, [
    "al C:1000 .sidwave_init", "al C:1003 .sidwave_play", "al C:1006 .sidwave_stop", "al C:1009 .sidwave_sfx",
    "al C:1E3F .sidwave_ram", "al C:1F73 .sidwave_ram_end", "al C:00FB .sidwave_zp_ptr", "",
  ].join("\n"));
  const json = JSON.parse(b.symbols.json);
  assert.deepEqual(json.symbols, ELISE_LABELS);
  assert.deepEqual(json.contract, JSON.parse(JSON.stringify(b.contract)));
});

test("ACME, KickAssembler and ca65 files carry the contract as comments; the VICE file has none", () => {
  const b = elise();
  const comment = (text, token) => text.split("\n").filter((line) => line.startsWith(token)).slice(0, 15);
  const expected = [
    "SIDWave game build contract",
    "entry points: init $1000, play $1003, stop $1006, sfx $1009 (3 bytes each)",
    "init: A = subtune index, 0-based (only 0 exists; the value is ignored); X = clock: 0 PAL, 1 NTSC, $FF reads the KERNAL flag at $02A6; clobbers A, X, Y",
    "play, stop: no input; clobber A, X, Y",
    "sfx: a stub that returns at once (sound effects come later); the registers and the carry flag are unchanged",
    "flags: the interrupt and decimal flags are never changed; the other flags are undefined on return",
    "$01: saved on entry and restored on return; set to $36 (I/O and KERNAL visible, BASIC ROM off) while the routine runs",
    "zero page: ptr $FB-$FC (saved and restored)",
    "SID registers written: $D400-$D418",
    "RAM written: $1E3F-$1F72",
    "memory: player $1000-$1E3E, variables $1E3F-$1F72",
    "interrupts: none: no interrupt vector, CIA or VIC timer is touched and the I flag is not changed; the game calls play itself",
    "stack: not measured",
    "play calls per frame: 1; 50.124542124542124 per second; written for PAL",
    "cycles per play call: not measured, upper bound 2084 (estimated)",
  ];
  assert.deepEqual(comment(b.symbols.acme, ";").map((line) => line.slice(2)), expected);
  assert.deepEqual(comment(b.symbols.kickass, "//").map((line) => line.slice(3)), expected);
  assert.deepEqual(comment(b.symbols.ca65, ";").slice(0, 15).map((line) => line.slice(2)), expected);
  assert.ok(!b.symbols.vice.includes(";") && !b.symbols.vice.includes("//") && !b.symbols.vice.includes("#"));
  const measured = elise({ measure: true });
  assert.ok(measured.symbols.acme.includes("; stack: 9 bytes (measured)\n"));
  assert.ok(measured.symbols.acme.includes("; cycles per play call: worst 1722 (measured), average 852.8 (measured), upper bound 2084 (estimated)\n"));
});

test("a data block adds its labels and the data line of the contract; --symbols-all exports internal labels", () => {
  const b = compileSidwave(load("fuer_elise"), { target: "game", origin: 0x1000, dataOrigin: 0x4000, zeroPage: 0x40, measure: false, symbols: ["acme"], symbolsAll: true });
  assert.equal(b.labels.sidwave_data, 0x4000);
  assert.equal(b.labels.sidwave_data_end, 0x4000 + b.data.length);
  assert.equal(b.labels.sidwave_zp_ptr, 0x40);
  assert.equal(b.labels.sidwave_int_play, b.image.symbols.get("play"));
  assert.equal(b.labels.sidwave_int_stream0, b.image.symbols.get("stream0"));
  assert.ok(b.labels.sidwave_int_stream0 >= 0x4000);
  assert.ok(!Object.keys(b.labels).some((name) => name.startsWith("sidwave_int_game_")));
  assert.ok(b.symbols.acme.includes(`sidwave_data = $4000 ; start of the data block\n`));
  assert.ok(b.symbols.acme.includes(`; data: ${b.data.length} bytes at $4000, SHA-256 ${crypto.createHash("sha256").update(b.data).digest("hex")} (not verified at run time)\n`));
  const stereo = compileSidwave(load("stereo_echo"), { target: "game", origin: 0x1000, measure: false });
  assert.equal(stereo.labels.sidwave_zp_sid_io, 0xfd);
  assert.deepEqual(stereo.contract.sidRegisters, [{ address: 0xd400, bytes: 25 }, { address: 0xd420, bytes: 25 }]);
});

// ---- assemblers -------------------------------------------------------------------------------------------------

function tool(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  return probe.error ? undefined : name;
}
const TASS = tool("64tass");
const CA65 = tool("ca65") && tool("ld65");
const CALLER = [0xa9, 0x00, 0xa2, 0xff, 0x20, 0x00, 0x10, 0x20, 0x03, 0x10, 0x20, 0x06, 0x10, 0x60];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-game-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("64tass assembles a caller of init, play and stop through the ACME symbol file", { skip: TASS ? false : "64tass is not installed" }, () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "song.acme"), elise().symbols.acme);
    fs.writeFileSync(path.join(dir, "main.asm"), `* = $2000
.include "song.acme"
        lda #0
        ldx #$ff
        jsr sidwave_init
        jsr sidwave_play
        jsr sidwave_stop
        rts
`);
    const run = spawnSync(TASS, ["--nostart", "-o", "main.bin", "main.asm"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual([...fs.readFileSync(path.join(dir, "main.bin"))], CALLER);
  } finally { done(); }
});

test("ca65 assembles and ld65 links a caller of init, play and stop through the ca65 symbol file", { skip: CA65 ? false : "ca65 or ld65 is not installed" }, () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "song.ca65"), elise().symbols.ca65);
    fs.writeFileSync(path.join(dir, "main.s"), `.include "song.ca65"
.segment "CODE"
        lda #0
        ldx #$ff
        jsr sidwave_init
        jsr sidwave_play
        jsr sidwave_stop
        rts
`);
    fs.writeFileSync(path.join(dir, "main.cfg"), `MEMORY { RAM: start = $2000, size = $1000, file = %O; }
SEGMENTS { CODE: load = RAM, type = ro; }
`);
    const assemble = spawnSync("ca65", ["-o", "main.o", "main.s"], { cwd: dir, encoding: "utf8" });
    assert.equal(assemble.status, 0, assemble.stderr);
    const link = spawnSync("ld65", ["-C", "main.cfg", "-o", "main.bin", "main.o"], { cwd: dir, encoding: "utf8" });
    assert.equal(link.status, 0, link.stderr);
    assert.deepEqual([...fs.readFileSync(path.join(dir, "main.bin"))], CALLER);
  } finally { done(); }
});

test("the bundled assembler accepts the ACME symbol file and resolves the same addresses", () => {
  const b = elise();
  const assembled = assemblyToPrgDetailed(`* = $2000
!source "song.acme"
        lda #0
        ldx #$ff
        jsr sidwave_init
        jsr sidwave_play
        jsr sidwave_stop
        rts
`, { resolveInclude: () => b.symbols.acme });
  assert.deepEqual([...assembled.prg.subarray(2)], CALLER);
  assert.equal(assembled.symbols.get("sidwave_ram_end"), 0x1f73);
});

// ---- PSID ---------------------------------------------------------------------------------------------------------

test("freePageRange picks the largest free run of $0400-$CFFF and reports no space as $FF and 0", () => {
  assert.deepEqual(freePageRange([[0x1000, 0x2000]]), { startPage: 0x20, pageLength: 0xb0 });
  assert.deepEqual(freePageRange([[0x8000, 0x8001]]), { startPage: 0x04, pageLength: 0x7c });
  assert.deepEqual(freePageRange([[0x0800, 0x0801], [0xa000, 0xa200]]), { startPage: 0x09, pageLength: 0x97 });
  assert.deepEqual(freePageRange([[0x4000, 0x4001]]), { startPage: 0x41, pageLength: 0x8f });
  assert.deepEqual(freePageRange([[0x0400, 0xd000]]), { startPage: 0xff, pageLength: 0 });
  assert.deepEqual(freePageRange([[0x0000, 0x0400], [0x0400, 0x0400 + 1]]), { startPage: 0x05, pageLength: 0xcb });
  // Equal runs ($04-$67 and $69-$CC): the lower one wins.
  assert.deepEqual(freePageRange([[0x6800, 0x6900], [0xcd00, 0xd000]]), { startPage: 0x04, pageLength: 100 });
  assert.deepEqual(freePageRange([[0x0400, 0x6600], [0x6700, 0x6800]]), { startPage: 0x68, pageLength: 0x68 });
  assert.deepEqual(freePageRange([[0x0400, 0x6500], [0x6600, 0xd000]]), { startPage: 0x65, pageLength: 1 });
});

test("a game PSID loads the image, starts through a routine that passes the clock and records the free pages", () => {
  const doc = load("fuer_elise");
  const b = elise();
  const file = sidwaveGamePsid(doc, b);
  const sid = parseSidFile(new Uint8Array(file));
  assert.equal(file.readUInt16BE(8), 0, "the load address comes from the data");
  assert.equal(file.readUInt16BE(10), 0x1f73, "init is the start routine behind the variables");
  assert.equal(file.readUInt16BE(12), 0x1003, "play is the entry at origin+3");
  assert.deepEqual([file[0x78], file[0x79]], [0x20, 0xb0], "pages $20-$CF are free");
  assert.equal(sid.loadAddress, 0x1000);
  assert.equal(file.length, 0x7c + 2 + (0x1f73 - 0x1000) + 5);
  assert.deepEqual([...file.subarray(file.length - 5)], [0xa2, 0x00, 0x4c, 0x00, 0x10]);
  // Run it as a PSID host does: load, init, play.
  const body = file.subarray(0x7c);
  const m = gameMachine(b);
  m.mem.fill(0);
  m.mem.set(body.subarray(2), body.readUInt16LE(0));
  m.cpu.call(file.readUInt16BE(10), 0);
  for (let i = 0; i < 100; i++) m.cpu.call(file.readUInt16BE(12), 0);
  const direct = gameMachine(b);
  direct.init(0, 0);
  for (let i = 0; i < 100; i++) direct.play();
  const trace = (machine, offset) => sidTrace(machine).slice(offset).map((call) => JSON.stringify(call));
  assert.equal(m.writes.filter(({ address }) => address >= 0xd400).length, direct.writes.filter(({ address }) => address >= 0xd400).length);
  const registers = (machine) => { const r = new Uint8Array(32); for (const { address, value } of machine.writes) if (address >= 0xd400 && address < 0xd420) r[address - 0xd400] = value; return [...r]; };
  assert.deepEqual(registers(m), registers(direct));
  assert.deepEqual(trace(m, 0).length > 0, true);
});

test("a game PSID for an NTSC score passes X = 1; a split layout is one image with the gap zero filled", () => {
  const doc = load("title_fanfare");
  const split = compileSidwave(doc, { target: "game", origin: 0x1000, dataOrigin: 0x2000, measure: false });
  const file = sidwaveGamePsid(doc, split);
  assert.equal(file[0x78] + file[0x79] > 0, true);
  const ntsc = { ...doc, song: { ...doc.song, mode: "NTSC" } };
  const ntscBuild = compileSidwave(ntsc, { target: "game", origin: 0x1000, measure: false });
  const ntscFile = sidwaveGamePsid(ntsc, ntscBuild);
  assert.deepEqual([...ntscFile.subarray(ntscFile.length - 5, ntscFile.length - 3)], [0xa2, 0x01]);
  assert.equal(ntscFile.readUInt16BE(0x76) & 0x0c, 0x08, "the clock flag says NTSC");
  // The start routine needs five bytes behind the variables.
  const fitting = compileSidwave(load("fuer_elise"), { target: "game", origin: 0xc08a, measure: false });
  assert.equal(fitting.contract.memory.variables.end, 0xcffd);
  assert.throws(() => sidwaveGamePsid(load("fuer_elise"), fitting), (error) => error.path === "$.origin" && /start routine would end past \$D000/.test(error.message));
});

// ---- README -------------------------------------------------------------------------------------------------------

test("the README example assembles with 6502-toolkit and calls init and play at the documented addresses", () => {
  const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Using the player in a game"));
  const code = /```asm\n([\s\S]*?)```/.exec(section)[1];
  const b = elise();
  const assembled = assemblyToPrgDetailed(code, { fileName: "game.asm", resolveInclude: (name) => {
    assert.equal(name, "song.acme");
    return b.symbols.acme;
  } });
  const prg = assembled.prg;
  assert.equal(prg.readUInt16LE(0), 0x0801);
  const start = assembled.symbols.get("start");
  assert.equal(start, 0x080d);
  const at = (address) => prg[2 + address - 0x0801];
  const calls = [];
  for (let address = start; address < start + 60; address++) {
    if (at(address) === 0x20) calls.push(at(address + 1) | (at(address + 2) << 8));
  }
  assert.deepEqual(calls, [0x1000, 0x1003]);
  // Machine code: the program ends before the music starts.
  assert.ok(0x0801 + prg.length - 2 < 0x1000);
  // The documented compile command and the file names it names match what the CLI writes.
  assert.ok(section.includes("sidwave compile song.sidwave.yaml --target game --origin 0x1000 --symbols acme -o song"));
});

test("README example: init, then the raster interrupt routine's play call, run on the bundled emulator", () => {
  const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
  const code = /```asm\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf("## Using the player in a game")))[1];
  const b = elise();
  const assembled = assemblyToPrgDetailed(code, { fileName: "game.asm", resolveInclude: () => b.symbols.acme });
  const m = gameMachine(b);
  m.mem.set(assembled.prg.subarray(2), 0x0801);
  m.mem[0xea81] = 0x60;
  m.mem[0x02a6] = 1;
  // The program ends in the main loop of the game, so step it until it gets there.
  m.cpu.pc = assembled.symbols.get("start");
  for (let steps = 0; m.cpu.pc !== assembled.symbols.get("main"); steps++) {
    assert.ok(steps < 2000, "start reaches main");
    m.cpu.step();
  }
  const irq = m.mem[0x0314] | (m.mem[0x0315] << 8);
  assert.equal(irq, assembled.symbols.get("irq"));
  assert.deepEqual([m.mem[0xdc0d], m.mem[0xd01a], m.mem[0xd012]], [0x7f, 1, 0xfa]);
  for (let i = 0; i < 50; i++) m.cpu.call(irq, 0);
  const reference = gameMachine(b);
  reference.init(0, 0);
  for (let i = 0; i < 50; i++) reference.play();
  const final = (machine) => { const r = new Uint8Array(25); for (const { address, value } of machine.writes) if (address >= 0xd400 && address <= 0xd418) r[address - 0xd400] = value; return [...r]; };
  assert.deepEqual(final(m), final(reference));
});

test("a multispeed game PSID programs CIA1 timer A in its start routine; the player itself never touches the CIA", () => {
  const doc = load("chiptune_drive");
  assert.equal(doc.speed, 2);
  const b = compileSidwave(doc, { target: "game", origin: 0x1000, dataOrigin: 0x6000, measure: false });
  const file = sidwaveGamePsid(doc, b);
  assert.equal(file.readUInt32BE(18) & 1, 1, "the header selects CIA timing");
  // PAL clock 985248 Hz over 100.249... play calls per second.
  const latch = Math.round(985248 / b.contract.playCallsPerSecond) - 1;
  assert.equal(latch, 9827);
  const body = file.subarray(0x7c);
  const m = gameMachine(b);
  m.mem.fill(0);
  m.mem.set(body.subarray(2), body.readUInt16LE(0));
  m.cpu.call(file.readUInt16BE(10), 0);
  const cia = m.writes.filter(({ address }) => address >= 0xdc00 && address < 0xde00).map(({ address, value }) => [address, value]);
  assert.deepEqual(cia, [[0xdc04, latch & 255], [0xdc05, latch >> 8]]);
  for (let i = 0; i < 5; i++) m.cpu.call(file.readUInt16BE(12), 0);
  assert.equal(m.writes.filter(({ address }) => address >= 0xdc00 && address < 0xde00).length, 2, "play writes no CIA register");
  // A score at normal speed gets the five byte routine without CIA writes.
  const single = load("fuer_elise");
  const plain = sidwaveGamePsid(single, elise());
  assert.equal(plain.length, 0x7c + 2 + (0x1f73 - 0x1000) + 5);
  // The player image alone (without the PSID routine) has no CIA access.
  assert.ok(!b.player.some((_, i) => i + 2 < b.player.length && b.player[i] === 0x8d && (b.player[i + 2] === 0xdc) && (b.player[i + 1] === 0x04 || b.player[i + 1] === 0x05)));
});
