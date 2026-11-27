// Developer integration of the game build: assembler includes, relocation tables and the cycle limit. The includes are
// checked by parsing their byte directives and, where the assembler is installed, by assembling them with 64tass, ACME,
// ca65/ld65 or KickAssembler (KICKASS_JAR and java).
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli, EXIT_OK, EXIT_INPUT, EXIT_USAGE, EXIT_LIMIT } from "../src/cli.js";
import * as library from "../src/index.js";
import { parseSidwave, SidwaveValidationError } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import {
  compileSidwave, renderSidwaveGameInclude, sidwaveRelocationTable, verifySidwaveRelocation, SidwaveGameCycleLimitError,
  SIDWAVE_ASSEMBLERS, SIDWAVE_SYMBOL_FORMATS,
} from "../src/sidwaveGame.js";
import { readSidwaveExample } from "../src/sidwaveExamples.js";
import { runPrg } from "./helpers/sidwaveEmulator.mjs";
import { gameMachine, sidTrace } from "./helpers/sidwaveGameHarness.mjs";

const ELISE = readSidwaveExample("fuer_elise");
// Effect names that are mnemonics, registers or directive names: the prefix of the symbols must keep them apart.
const EFFECT_SCORE = `${readSidwaveExample("game_songs")}
effects:
  lda: { priority: 5, steps: [ { freq: C6, wave: pulse, pulse: 0.5, adsr: [0, 2, 0, 0], wait: 4 }, { gate: false, wait: 1 } ] }
  a: { priority: 3, steps: [ { freq: 80, wave: noise, wait: 3 } ] }
  org: { priority: 1, steps: [ { freq: A5, wave: triangle } ] }
  byte: { priority: 2, steps: [ { freq: G4, wave: sawtooth, wait: 2 } ] }
`;
const CASE_SCORE = `${readSidwaveExample("game_songs")}
effects:
  zap: { priority: 1, steps: [ { freq: C6 } ] }
  Zap: { priority: 2, steps: [ { freq: C5 } ] }
`;
const SCORES = { fuer_elise: ELISE, effects: EFFECT_SCORE };
const LAYOUTS = [
  { origin: 0x2000 },
  { origin: 0x2001, dataOrigin: 0x8003, zeroPage: 0xf0 },
  { origin: 0x8000, dataOrigin: 0x2000, zeroPage: 0x02 },
];

const parsed = new Map();
const scoreDoc = (text) => parsed.get(text) ?? parsed.set(text, parseSidwave(text)).get(text);
const game = (text, options) => compileSidwave(scoreDoc(text), { target: "game", measure: false, ...options });
const layoutName = (layout) => JSON.stringify(layout);

// --- tools -----------------------------------------------------------------------------------------------------------

const works = (command, args) => spawnSync(command, args, { encoding: "utf8" }).error === undefined;
const kickJar = process.env.KICKASS_JAR;
const MISSING = {
  "64tass": works("64tass", ["--version"]) ? false : "64tass is not installed",
  acme: works("acme", ["--version"]) ? false : "acme is not installed",
  ca65: works("ca65", ["--version"]) && works("ld65", ["--version"]) ? false : "ca65 and ld65 are not installed",
  kickass: kickJar && fs.existsSync(kickJar) && works("java", ["-version"]) ? false : "KickAssembler needs KICKASS_JAR and java",
};

function tool(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
}

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-devint-")));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function inSandbox(fn) {
  const { dir, done } = sandbox();
  try {
    return fn(dir);
  } finally { done(); }
}

const file = (dir, name) => new Uint8Array(fs.readFileSync(path.join(dir, name)));

/** The `<name>_RAM` memory areas of the ld65 lines in a ca65 include header, in file order. */
function ca65Areas(include) {
  return [...include.matchAll(/^; {3}(\w+)_RAM: start = \$([0-9A-F]+), size = \$([0-9A-F]+), file = %O;$/gm)]
    .map(([, segment, start, size]) => ({ segment, start: Number.parseInt(start, 16), size: Number.parseInt(size, 16) }));
}

/**
 * Assembles a source file that only includes the include and returns the player and data bytes as the real tool placed
 * them. `references` are symbol names emitted as words behind the bytes, to check their values.
 */
function assembleInclude(assembler, include, build, references = []) {
  return inSandbox((dir) => {
    fs.writeFileSync(path.join(dir, "tune.inc"), include);
    const data = build.contract.memory.data;
    const blocks = [{ start: build.contract.memory.player.start, size: build.player.length }, ...(data ? [{ start: data.start, size: build.data.length }] : [])];
    // The words go to $C800, above every layout used here.
    const refsAt = 0xc800;
    const words = references.join(", ");
    let source;
    if (assembler === "64tass") source = `        .include "tune.inc"\n${words ? `* = $C800\n        .word ${words}\n` : ""}`;
    else if (assembler === "acme") source = `        !source "tune.inc"\n${words ? `* = $C800\n        !word ${words}\n` : ""}`;
    else if (assembler === "kickass") source = `#import "tune.inc"\n${words ? `* = $C800\n        .word ${words}\n` : ""}`;
    else source = `.include "tune.inc"\n${words ? `.segment "REFS"\n.word ${words}\n` : ""}`;
    fs.writeFileSync(path.join(dir, "main.asm"), source);
    if (assembler === "ca65") {
      const areas = ca65Areas(include);
      assert.deepEqual(areas.map(({ start, size }) => ({ start, size })), blocks, "the header areas are the blocks of the build");
      const memory = include.match(/^; {3}\w+_RAM: .*$/gm).map((line) => line.slice(1));
      const segments = include.match(/^; {3}SIDWAVE_\w+: load = .*$/gm).map((line) => line.slice(1));
      const refs = words ? ["  REFS_RAM: start = $C800, size = $800, file = %O;", "  REFS: load = REFS_RAM, type = ro;"] : [];
      fs.writeFileSync(path.join(dir, "link.cfg"), `MEMORY {\n${[...memory, ...refs.slice(0, 1)].join("\n")}\n}\nSEGMENTS {\n${[...segments, ...refs.slice(1)].join("\n")}\n}\n`);
      tool(dir, "ca65", ["main.asm", "-o", "main.o"]);
      tool(dir, "ld65", ["-C", "link.cfg", "-m", "map.txt", "-o", "out.bin", "main.o"]);
      const map = fs.readFileSync(path.join(dir, "map.txt"), "utf8");
      for (const [i, { segment }] of areas.entries()) {
        const placed = new RegExp(`^${segment}\\s+([0-9A-F]{6})\\s+[0-9A-F]{6}\\s+([0-9A-F]{6})`, "m").exec(map);
        assert.deepEqual([Number.parseInt(placed[1], 16), Number.parseInt(placed[2], 16)], [blocks[i].start, blocks[i].size], segment);
      }
      const out = file(dir, "out.bin");
      assert.equal(out.length, blocks.reduce((sum, b) => sum + b.size, 0) + references.length * 2);
      let at = 0;
      const [player, split] = blocks.map((b) => out.subarray(at, (at += b.size)));
      return { player, data: split, references: wordsOf(out.subarray(at)) };
    }
    if (assembler === "64tass") tool(dir, "64tass", ["--nostart", "-o", "out.bin", "main.asm"]);
    else if (assembler === "acme") tool(dir, "acme", ["-f", "plain", "-o", "out.bin", "main.asm"]);
    else tool(dir, "java", ["-jar", kickJar, "main.asm", "-binfile", "-o", "out.bin"]);
    // One flat image from the lowest address; the gaps between the blocks are zero.
    const out = file(dir, "out.bin");
    const low = Math.min(...blocks.map((b) => b.start));
    const high = references.length ? refsAt + references.length * 2 : Math.max(...blocks.map((b) => b.start + b.size));
    assert.equal(out.length, high - low, "the output spans exactly the blocks");
    const expected = new Uint8Array(high - low);
    expected.set(build.combined, build.combinedOrigin - low);
    if (references.length) expected.set(out.subarray(refsAt - low), refsAt - low);
    assert.equal(Buffer.compare(out, expected), 0, `${assembler}: the assembled image differs from the build`);
    const [player, split] = blocks.map((b) => out.subarray(b.start - low, b.start - low + b.size));
    return { player, data: split, references: wordsOf(out.subarray(refsAt - low)) };
  });
}

const wordsOf = (bytes) => Array.from({ length: bytes.length >> 1 }, (_, i) => bytes[2 * i] | (bytes[2 * i + 1] << 8));

// --- include parser --------------------------------------------------------------------------------------------------

const GRAMMAR = {
  "64tass": { comment: ";", byte: /^\.byte (.*)$/, constant: /^(\w+) = \$([0-9A-F]+)$/, origin: /^\* = \$([0-9A-F]{4})$/ },
  acme: { comment: ";", byte: /^!byte (.*)$/, constant: /^(\w+) = \$([0-9A-F]+)$/, origin: /^\* = \$([0-9A-F]{4})$/ },
  kickass: { comment: "//", byte: /^\.byte (.*)$/, constant: /^\.label (\w+) = \$([0-9A-F]+)$/, origin: /^\* = \$([0-9A-F]{4})$/ },
  ca65: { comment: ";", byte: /^\.byte (.*)$/, constant: /^(\w+) = \$([0-9A-F]+)$/, origin: /^\.segment "(\w+)"$/ },
};

/** Reads an include strictly: every line must be a comment, a constant, an origin, a byte directive or a ca65 stack directive. */
function parseInclude(text, assembler) {
  const grammar = GRAMMAR[assembler];
  const areas = assembler === "ca65" ? ca65Areas(text) : [];
  const header = [];
  const symbols = {};
  const blocks = [];
  assert.ok(text.endsWith("\n"));
  for (const line of text.slice(0, -1).split("\n")) {
    let match;
    if (line.startsWith(`${grammar.comment} `)) {
      assert.equal(blocks.length + Object.keys(symbols).length, 0, "comments come first");
      header.push(line.slice(grammar.comment.length + 1));
    } else if ((match = grammar.constant.exec(line))) symbols[match[1]] = Number.parseInt(match[2], 16);
    else if ((match = grammar.origin.exec(line))) {
      const origin = assembler === "ca65" ? areas.find((a) => a.segment === match[1]).start : Number.parseInt(match[1], 16);
      blocks.push({ origin, bytes: [] });
    } else if ((match = grammar.byte.exec(line))) {
      const values = match[1].split(", ");
      assert.ok(values.length <= 16);
      for (const value of values) assert.match(value, /^\$[0-9A-F]{2}$/);
      const block = blocks.at(-1);
      assert.equal(block.bytes.length % 16, 0, "only the last line of a block is short");
      block.bytes.push(...values.map((v) => Number.parseInt(v.slice(1), 16)));
    } else assert.ok(assembler === "ca65" && (line === ".pushseg" || line === ".popseg"), `unexpected line: ${line}`);
  }
  return { header: header.join("\n"), symbols, blocks };
}

const expectedBlocks = (build) => [
  { origin: build.contract.memory.player.start, bytes: [...build.player] },
  ...(build.data ? [{ origin: build.contract.memory.data.start, bytes: [...build.data] }] : []),
];

// --- includes --------------------------------------------------------------------------------------------------------

for (const assembler of SIDWAVE_ASSEMBLERS) {
  test(`${assembler}: the include holds the bytes, addresses and symbols of the binary build`, () => {
    for (const [name, score] of Object.entries(SCORES)) {
      for (const layout of LAYOUTS) {
        const build = game(score, layout);
        const include = renderSidwaveGameInclude(build, assembler, name);
        const parsedInclude = parseInclude(include, assembler);
        assert.deepEqual(parsedInclude.blocks, expectedBlocks(build), `${name} ${layoutName(layout)}`);
        assert.deepEqual(parsedInclude.symbols, build.labels);
        assert.equal(renderSidwaveGameInclude(game(score, layout), assembler, name), include, "the output is deterministic");
      }
    }
  });

  test(`${assembler}: the assembled include has the bytes of the binary build`, { skip: MISSING[assembler] }, () => {
    for (const [name, score] of Object.entries(SCORES)) {
      for (const layout of LAYOUTS) {
        const build = game(score, { ...layout, symbolsAll: true });
        const include = renderSidwaveGameInclude(build, assembler, name);
        const names = Object.keys(build.labels);
        for (const references of [[], names]) {
          const out = assembleInclude(assembler, include, build, references);
          assert.deepEqual([...out.player], [...build.player], `${name} ${layoutName(layout)}`);
          assert.deepEqual(out.data && [...out.data], build.data && [...build.data]);
          assert.deepEqual(out.references, references.map((symbol) => build.labels[symbol]));
        }
      }
    }
  });

  test(`${assembler}: the assembled include writes the SID registers of the PRG build`, { skip: MISSING[assembler] }, () => {
    const frames = 600;
    for (const name of ["fuer_elise", "stereo_echo"]) {
      const score = readSidwaveExample(name);
      const reference = runPrg(compileSidwaveToPrg(scoreDoc(score)), frames).calls.map((call) => call.writes.map((w) => [w.addr, w.value]));
      assert.ok(reference.some((writes) => writes.length > 0));
      for (const layout of LAYOUTS.slice(0, 2)) {
        const build = game(score, layout);
        const out = assembleInclude(assembler, renderSidwaveGameInclude(build, assembler, name), build);
        const machine = gameMachine({ ...build, player: out.player, data: out.data });
        machine.init(0, scoreDoc(score).song.mode === "NTSC" ? 1 : 0);
        for (let i = 0; i < frames; i++) machine.play();
        const trace = sidTrace(machine);
        for (let i = 0; i < frames; i++) assert.deepEqual(trace[i + 2] ?? [], reference[i], `${name} ${layoutName(layout)} call ${i}`);
      }
    }
  });

  test(`${assembler}: a title with line breaks and comment terminators stays inside the comment header`, () => {
    const title = "Für\nElise\r\n .byte $FF\r*/ lda #0 \u2028 .error \u2029\u0085\u0000\u001a end \\";
    const build = game(ELISE, { origin: 0x2000 });
    const include = renderSidwaveGameInclude(build, assembler, title);
    const result = parseInclude(include, assembler);
    assert.deepEqual(result.blocks, expectedBlocks(build));
    assert.deepEqual(result.symbols, build.labels);
    assert.ok(!include.includes("*/"));
    assert.doesNotMatch(include, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/);
    assert.match(result.header.split("\n")[0], /^Für Elise .* end \\ - SIDWave game include/);
    if (!MISSING[assembler]) assembleInclude(assembler, include, build);
  });
}

test("the include header documents the memory use, every entry point with its registers and the cycles", () => {
  const unmeasured = game(EFFECT_SCORE, { origin: 0x2000, dataOrigin: 0x8000 });
  const { header, symbols } = parseInclude(renderSidwaveGameInclude(unmeasured, "64tass", "My tune"), "64tass");
  const { contract, cycles } = unmeasured;
  const h = (n) => `\\$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  assert.match(header, /^My tune - SIDWave game include/);
  assert.match(header, new RegExp(`^player ${h(0x2000)}-${h(contract.memory.player.end - 1)}$`, "m"));
  assert.match(header, new RegExp(`^variables ${h(contract.memory.variables.start)}-${h(contract.memory.variables.end - 1)} `, "m"));
  assert.match(header, new RegExp(`^data ${h(0x8000)}-${h(contract.memory.data.end - 1)}$`, "m"));
  assert.match(header, /^zero page \$FB-\$FC/m);
  assert.match(header, /^init \$2000: in A = song index.*; X = clock.*; clobbers A, X, Y$/m);
  assert.match(header, /^play \$2003: in none; clobbers A, X, Y/m);
  assert.match(header, /^stop \$2006: in none.*; clobbers A, X, Y$/m);
  assert.match(header, /^sfx \$2009: in A = effect index \(0-3\), Y = voice 1-3.*; clobbers A, X, Y, flags;/m);
  assert.match(header, new RegExp(`^cycles per play call: upper bound ${cycles.estimatedWorst} \\(estimated; not measured\\)$`, "m"));
  assert.equal(symbols.sidwave_zp_ptr, 0xfb);

  const measured = game(EFFECT_SCORE, { origin: 0x2000, measure: true });
  const worst = Math.max(measured.cycles.worst, measured.cycles.withEffects.worst);
  assert.match(renderSidwaveGameInclude(measured), new RegExp(`; cycles per play call: worst ${worst} \\(measured\\), upper bound ${measured.cycles.estimatedWorst} \\(estimated\\)`));
  assert.match(renderSidwaveGameInclude(game(ELISE, { origin: 0x2000 })), /; sfx \$2009: in none; clobbers nothing; a stub/);
  // ACME takes a four digit zero page literal as a 16 bit address.
  assert.match(renderSidwaveGameInclude(unmeasured, "acme"), /^sidwave_zp_ptr = \$FB$/m);
  assert.throws(() => renderSidwaveGameInclude(unmeasured, "dasm"), SidwaveValidationError);
});

test("symbol files include 64tass, and song names cannot leave their comment lines", () => {
  assert.ok(SIDWAVE_SYMBOL_FORMATS.includes("64tass"));
  const score = readSidwaveExample("game_songs").replace(/^(\s*- name: )(.*)$/m, '$1"x\\n.byte 1\\r\\u2028*/"');
  assert.notEqual(score, readSidwaveExample("game_songs"));
  const build = game(score, { origin: 0x2000, symbols: [...SIDWAVE_SYMBOL_FORMATS] });
  assert.match(build.contract.songs[0].name, /\n/);
  for (const [format, comment] of [["64tass", ";"], ["acme", ";"], ["ca65", ";"], ["kickass", "//"]]) {
    for (const line of build.symbols[format].slice(0, -1).split(/\r\n|[\r\n\u2028\u2029]/)) {
      assert.ok(line.startsWith(comment) || /^(\.label )?sidwave_\w+ ?=/.test(line), `${format}: ${line}`);
    }
    assert.ok(!build.symbols[format].includes("*/"));
  }
});

for (const [format, assembler] of [["64tass", "64tass"], ["acme", "acme"], ["ca65", "ca65"], ["kickass", "kickass"]]) {
  test(`${assembler} assembles its symbol file with every label`, { skip: MISSING[assembler] }, () => {
    const build = game(EFFECT_SCORE, { origin: 0x2000, symbols: [format], symbolsAll: true });
    inSandbox((dir) => {
      fs.writeFileSync(path.join(dir, "symbols.inc"), build.symbols[format]);
      const include = { "64tass": ".include", acme: "!source", ca65: ".include", kickass: "#import" }[assembler];
      const word = assembler === "acme" ? "!word" : ".word";
      const origin = assembler === "ca65" ? "" : "* = $1000\n";
      fs.writeFileSync(path.join(dir, "main.asm"), `${include} "symbols.inc"\n${origin}        ${word} sidwave_init, sidwave_fx_lda, sidwave_zp_ptr\n`);
      if (assembler === "64tass") tool(dir, "64tass", ["--nostart", "-o", "out.bin", "main.asm"]);
      else if (assembler === "acme") tool(dir, "acme", ["-f", "plain", "-o", "out.bin", "main.asm"]);
      else if (assembler === "kickass") tool(dir, "java", ["-jar", kickJar, "main.asm", "-binfile", "-o", "out.bin"]);
      else {
        fs.writeFileSync(path.join(dir, "link.cfg"), "MEMORY { M: start = $1000, size = $100, file = %O; }\nSEGMENTS { CODE: load = M, type = ro; }\n");
        tool(dir, "ca65", ["main.asm", "-o", "main.o"]);
        tool(dir, "ld65", ["-C", "link.cfg", "-o", "out.bin", "main.o"]);
      }
      assert.deepEqual(wordsOf(file(dir, "out.bin")), [0x2000, 0, 0xfb]);
    });
  });
}

// --- command line ----------------------------------------------------------------------------------------------------

function run(cwd, ...args) {
  const out = [], err = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
  return { code, out: out.join(""), err: err.join("") };
}

function cli(fn, score = ELISE) {
  return inSandbox((dir) => {
    fs.writeFileSync(path.join(dir, "song.yaml"), score);
    return fn(dir, (...args) => run(dir, "compile", "song.yaml", "--target", "game", ...args));
  });
}

const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test("--format asm writes one include, 64tass by default, under the name given with -o", () => {
  cli((dir, compile) => {
    const build = compileSidwave(scoreDoc(ELISE), { target: "game", origin: 0x2000 });
    const title = scoreDoc(ELISE).song.title;
    const r = compile("--origin", "$2000", "--format", "asm", "--symbols", "64tass");
    assert.equal(r.code, EXIT_OK, r.err);
    assert.deepEqual(listing(dir), ["song.64tass", "song.inc", "song.yaml"]);
    assert.equal(fs.readFileSync(path.join(dir, "song.inc"), "utf8"), renderSidwaveGameInclude(build, "64tass", title));
    assert.ok(r.out.startsWith(`${path.join(dir, "song.inc")}: game build`), r.out);
    for (const [assembler, name, written] of [["acme", "out/a.a", "a.a"], ["kickass", "out/k.asm", "k.asm"], ["ca65", "out/c", "c.inc"]]) {
      const result = compile("--origin", "$2000", "--format", "asm", "--asm", assembler, "-o", name, "--json");
      assert.equal(result.code, EXIT_OK, result.err);
      assert.equal(fs.readFileSync(path.join(dir, "out", written), "utf8"), renderSidwaveGameInclude(build, assembler, title));
      assert.deepEqual(JSON.parse(result.out).result.outputs.map((o) => o.kind), [`include-${assembler}`]);
    }
    assert.deepEqual(listing(path.join(dir, "out")), ["a.a", "c.inc", "k.asm"]);
  });
});

test("--asm and --reloc are rejected where they cannot apply", () => {
  cli((dir, compile) => {
    for (const args of [["--asm", "acme"], ["--format", "asm", "--asm", "dasm"], ["--format", "sid", "--reloc"], ["--max-cycles", "-1"], ["--max-cycles", "many"]]) {
      assert.equal(compile("--origin", "$2000", ...args).code, EXIT_USAGE, args.join(" "));
    }
    for (const args of [["--reloc"], ["--max-cycles", "0"], ["--asm", "acme"]]) {
      assert.equal(run(dir, "compile", "song.yaml", ...args).code, EXIT_USAGE, args.join(" "));
    }
    assert.deepEqual(listing(dir), ["song.yaml"]);
    const help = run(dir, "--help").out;
    for (const text of ["--format bin|sid|asm", "--asm 64tass|acme|kickass|ca65", "--max-cycles <n>", "--reloc", "[--loop|--no-loop] [--json]"]) assert.ok(help.includes(text), text);
  });
});

test("effect names that differ only in case are rejected for 64tass and accepted by the other assemblers", () => {
  cli((dir, compile) => {
    for (const args of [["--format", "asm"], ["--symbols", "64tass"]]) {
      const r = compile("--origin", "$2000", "--no-measure", ...args);
      assert.equal(r.code, EXIT_INPUT);
      assert.match(r.err, /sidwave_fx_zap and sidwave_fx_Zap differ only in letter case/);
      assert.deepEqual(listing(dir), ["song.yaml"]);
    }
    assert.equal(compile("--origin", "$2000", "--no-measure", "--format", "asm", "--asm", "acme").code, EXIT_OK);
    const build = game(CASE_SCORE, { origin: 0x2000 });
    for (const assembler of ["acme", "ca65"]) {
      if (!MISSING[assembler]) assembleInclude(assembler, renderSidwaveGameInclude(build, assembler), build, ["sidwave_fx_zap", "sidwave_fx_Zap"]);
    }
  }, CASE_SCORE);
});

// --- cycle limit -----------------------------------------------------------------------------------------------------

for (const [name, score] of Object.entries(SCORES)) {
  test(`${name}: --max-cycles compares the measured worst call, with --no-measure the upper bound, and writes nothing above it`, () => {
    const measured = compileSidwave(scoreDoc(score), { target: "game", origin: 0x2000 });
    const worst = Math.max(measured.cycles.worst, measured.cycles.withEffects?.worst ?? 0);
    const bound = measured.cycles.estimatedWorst;
    assert.ok(worst < bound);
    cli((dir, compile) => {
      const base = ["--origin", "$2000", "--reloc", "--symbols", "acme", "-o", "deep/dir/tune"];
      for (const [limit, extra, message] of [
        [worst - 1, [], new RegExp(`limit ${worst - 1} exceeded: the measured worst play call takes ${worst} cycles \\(upper bound ${bound}\\)`)],
        [bound - 1, ["--no-measure"], new RegExp(`limit ${bound - 1} exceeded: the upper bound of a play call is ${bound} cycles \\(not measured\\)`)],
        [worst, ["--no-measure", "--format", "asm"], /exceeded/],
        [0, ["--format", "sid"], /exceeded/],
      ]) {
        const args = [...base.filter((a) => !(extra.includes("sid") && a === "--reloc")), ...extra, "--max-cycles", String(limit)];
        const r = compile(...args);
        assert.equal(r.code, EXIT_LIMIT, r.err);
        assert.match(r.err, message);
        assert.equal(r.out, "");
        assert.deepEqual(listing(dir), ["song.yaml"]);
      }
      const json = JSON.parse(compile(...base, "--max-cycles", String(worst - 1), "--json").out);
      assert.deepEqual([json.ok, json.error.category, json.error.details.measured, json.error.details.upperBound, json.error.details.limit],
        [false, "limit_exceeded", worst, bound, worst - 1]);
      assert.equal(compile(...base, "--max-cycles", String(worst)).code, EXIT_OK);
      assert.equal(compile(...base, "--max-cycles", String(bound), "--no-measure").code, EXIT_OK);
      assert.ok(listing(dir).includes(path.join("deep", "dir", "tune.bin")));
    }, score);

    assert.throws(() => compileSidwave(scoreDoc(score), { target: "game", origin: 0x2000, maxCycles: worst - 1 }), (error) =>
      error instanceof SidwaveGameCycleLimitError && error.measured === worst && error.upperBound === bound && error.limit === worst - 1);
    assert.throws(() => game(score, { origin: 0x2000, maxCycles: bound - 1 }), (error) => error instanceof SidwaveGameCycleLimitError && error.measured === null);
    assert.ok(game(score, { origin: 0x2000, maxCycles: bound }));
    for (const maxCycles of [-1, 1.5, Number.NaN]) assert.throws(() => game(score, { origin: 0x2000, maxCycles }), SidwaveValidationError);
  });
}

test("the cycle limit counts the play calls with sound effects", () => {
  const build = compileSidwave(scoreDoc(EFFECT_SCORE), { target: "game", origin: 0x2000 });
  const { worst, withEffects } = build.cycles;
  assert.ok(withEffects.worst > worst, "the fixture is slower with effects");
  assert.throws(() => compileSidwave(scoreDoc(EFFECT_SCORE), { target: "game", origin: 0x2000, maxCycles: worst }), SidwaveGameCycleLimitError);
});

// --- relocation ------------------------------------------------------------------------------------------------------

/** Applies the documented rule: add the page difference, modulo 256, to every listed byte. */
function relocate(bytes, ...moves) {
  const out = Uint8Array.from(bytes);
  for (const [offsets, pages] of moves) for (const i of offsets) out[i] = (out[i] + pages) & 0xff;
  return out;
}

for (const [name, score] of Object.entries(SCORES)) {
  test(`${name}: --reloc moves the build by +$1000 to the bytes of a direct build there`, () => {
    cli((dir, compile) => {
      for (const split of [false, true]) {
        const data = split ? ["--data-origin", "$8003"] : [];
        const r = compile("--origin", "$2001", ...data, "--no-measure", "--reloc", "-o", "t");
        assert.equal(r.code, EXIT_OK, r.err);
        const table = JSON.parse(fs.readFileSync(path.join(dir, "t.reloc.json"), "utf8"));
        assert.deepEqual([table.origin, table.dataOrigin, table.granularity], [0x2001, split ? 0x8003 : null, 256]);
        assert.ok(table.player.length > 0);
        const direct = game(score, { origin: 0x3001, ...(split ? { dataOrigin: 0x9003 } : {}) });
        assert.deepEqual(relocate(file(dir, "t.bin"), [table.player, 16]), direct.player);
        if (split) assert.deepEqual(relocate(file(dir, "t.data.bin"), [table.data, 16]), direct.data);
        else assert.deepEqual(table.data, []);
        assert.equal(table.independent !== undefined, split);
        assert.deepEqual(table, sidwaveRelocationTable(scoreDoc(score), { target: "game", origin: 0x2001, ...(split ? { dataOrigin: 0x8003 } : {}) }));
      }
      assert.equal(compile("--origin", "$2000", "--no-measure", "--reloc", "--format", "asm", "-o", "inc").code, EXIT_OK);
      assert.ok(listing(dir).includes("inc.inc") && listing(dir).includes("inc.reloc.json"));
    }, score);
  });

  test(`${name}: player and data block relocate by different page differences`, () => {
    const options = { target: "game", origin: 0x4000, dataOrigin: 0x9000, zeroPage: 0xf0 };
    const table = sidwaveRelocationTable(scoreDoc(score), options);
    const { playerPages, dataPages } = table.independent;
    assert.ok(playerPages.player.length > 0 && dataPages.player.length > 0);
    const base = game(score, options);
    for (const [p, d] of [[-32, 0], [0, 7], [-45, -37], [80, -100]]) {
      const direct = game(score, { ...options, origin: 0x4000 + p * 256, dataOrigin: 0x9000 + d * 256 });
      assert.deepEqual(relocate(base.player, [playerPages.player, p], [dataPages.player, d]), direct.player, `player ${p} ${d}`);
      assert.deepEqual(relocate(base.data, [playerPages.data, p], [dataPages.data, d]), direct.data, `data ${p} ${d}`);
    }
  });
}

test("a relocation table is built for layouts at the ends of memory", () => {
  // wall_of_sid fills more than half of $0200-$CFFF, so +$1000 does not fit from every origin.
  for (const [score, options] of [
    [readSidwaveExample("wall_of_sid"), { origin: 0x5500 }],
    [ELISE, { origin: 0xc000 }],
    [ELISE, { origin: 0x0200, dataOrigin: 0xc800 }],
  ]) {
    const table = sidwaveRelocationTable(scoreDoc(score), { target: "game", ...options });
    const base = game(score, options);
    const moved = game(score, { origin: 0x0300, ...(options.dataOrigin === undefined ? {} : { dataOrigin: 0xa000 }) });
    if (options.dataOrigin === undefined) {
      assert.deepEqual(relocate(base.player, [table.player, (0x0300 - options.origin) / 256]), moved.player);
    } else {
      const p = (0x0300 - options.origin) / 256, d = (0xa000 - options.dataOrigin) / 256;
      assert.deepEqual(relocate(base.player, [table.independent.playerPages.player, p], [table.independent.dataPages.player, d]), moved.player);
    }
  }
});

test("the relocation check rejects a table that does not reproduce the other build", () => {
  const a = game(ELISE, { origin: 0x2000 }), b = game(ELISE, { origin: 0x3000 });
  const { player } = sidwaveRelocationTable(scoreDoc(ELISE), { target: "game", origin: 0x2000 });
  assert.doesNotThrow(() => verifySidwaveRelocation(a.player, b.player, [{ offsets: player, pages: 16 }]));
  for (const moves of [[{ offsets: player.slice(1), pages: 16 }], [{ offsets: [...player, 0], pages: 16 }], [{ offsets: player, pages: 15 }]]) {
    assert.throws(() => verifySidwaveRelocation(a.player, b.player, moves), /does not reproduce/);
  }
  assert.throws(() => verifySidwaveRelocation(a.player, b.player.subarray(1), []), /does not reproduce/);
});

// --- library, documentation, speed -----------------------------------------------------------------------------------

test("the package root exports the include renderer, the relocation table and the limit error", () => {
  for (const name of ["renderSidwaveGameInclude", "sidwaveRelocationTable", "verifySidwaveRelocation", "SidwaveGameCycleLimitError", "SIDWAVE_ASSEMBLERS"]) {
    assert.equal(typeof library[name], name === "SIDWAVE_ASSEMBLERS" ? "object" : "function", name);
  }
});

const GUIDE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "doc", "authoring.md"), "utf8");
const examples = (assembler) => Object.fromEntries([...GUIDE.matchAll(/<!-- example: (\S+) (\S+) -->\n```\w*\n([\s\S]*?)```/g)]
  .filter((m) => m[1] === assembler).map((m) => [m[2], m[3]]));

for (const assembler of SIDWAVE_ASSEMBLERS) {
  test(`the documented ${assembler} example builds a program with the player at $2000`, { skip: MISSING[assembler] }, () => {
    const files = examples(assembler);
    assert.ok(Object.keys(files).length > 0);
    cli((dir) => {
      fs.renameSync(path.join(dir, "song.yaml"), path.join(dir, "tune.yaml"));
      const flag = assembler === "64tass" ? "" : ` --asm ${assembler}`;
      const command = `sidwave compile tune.yaml --target game --origin '$2000' --format asm${flag} -o tune.inc`;
      assert.ok(GUIDE.includes(command), command);
      assert.equal(run(dir, "compile", "tune.yaml", "--target", "game", "--origin", "$2000", "--format", "asm", "--asm", assembler, "-o", "tune.inc").code, EXIT_OK);
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      if (assembler === "64tass") tool(dir, "64tass", ["-o", "game.prg", "main.asm"]);
      else if (assembler === "acme") tool(dir, "acme", ["-f", "cbm", "-o", "game.prg", "main.a"]);
      else if (assembler === "kickass") tool(dir, "java", ["-jar", kickJar, "main.asm", "-o", "game.prg"]);
      else {
        const include = fs.readFileSync(path.join(dir, "tune.inc"), "utf8");
        for (const line of include.match(/^; {3}SIDWAVE_.*$/gm)) assert.ok(files["game.cfg"].includes(line.slice(1).trim()), line);
        tool(dir, "ca65", ["main.s", "-o", "main.o"]);
        tool(dir, "ld65", ["-C", "game.cfg", "-o", "game.prg", "main.o"]);
      }
      const prg = file(dir, "game.prg");
      assert.deepEqual([prg[0], prg[1]], [0x01, 0x08]);
      const build = game(ELISE, { origin: 0x2000 });
      const at = 2 + 0x2000 - 0x0801;
      assert.deepEqual([...prg.subarray(at)], [...build.player]);
      // The BASIC line's SYS 2061 lands on the first instruction, SEI.
      assert.equal(prg[2 + 2061 - 0x0801], 0x78);
    });
  });
}

test("an include of the largest shipped example builds with --no-measure in under 1 s of CPU time", () => {
  cli((dir, compile) => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const before = process.cpuUsage();
      const r = compile("--origin", "$0200", "--no-measure", "--format", "asm");
      const used = process.cpuUsage(before);
      assert.equal(r.code, EXIT_OK, r.err);
      times.push((used.user + used.system) / 1000);
    }
    assert.ok(Math.min(...times) < 1000, `CPU ms: ${times.map((t) => t.toFixed(0)).join(", ")}`);
  }, readSidwaveExample("wall_of_sid"));
});
