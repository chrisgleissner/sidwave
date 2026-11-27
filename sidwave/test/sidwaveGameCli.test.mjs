import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, EXIT_OK, EXIT_INPUT, EXIT_USAGE } from "../src/cli.js";
import { compileSidwave } from "../src/sidwaveGame.js";
import { parseSidwave } from "../src/sidwave.js";
import { readExampleScore } from "../src/sidwaveOps.js";

const ELISE = readExampleScore("fuer_elise");
const doc = parseSidwave(ELISE);

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-game-cli-")));
  fs.writeFileSync(path.join(dir, "song.yaml"), ELISE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(cwd, ...args) {
  const out = [], err = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
  return { code, out: out.join(""), err: err.join("") };
}

test("compile --target game writes the player binary and the symbol files and prints the cycles", () => {
  const { dir, done } = sandbox();
  try {
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--symbols", "acme,vice", "--symbols=json");
    assert.equal(r.code, EXIT_OK, r.err);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["song.acme", "song.bin", "song.symbols.json", "song.vice", "song.yaml"]);
    const expected = compileSidwave(doc, { target: "game", origin: 0x1000, symbols: ["acme", "vice", "json"] });
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, "song.bin"))), expected.player);
    assert.equal(fs.readFileSync(path.join(dir, "song.acme"), "utf8"), expected.symbols.acme);
    assert.equal(fs.readFileSync(path.join(dir, "song.vice"), "utf8"), expected.symbols.vice);
    assert.equal(fs.readFileSync(path.join(dir, "song.symbols.json"), "utf8"), expected.symbols.json);
    assert.equal(r.out, `${path.join(dir, "song.bin")}: game build, player $1000-$1E3E, worst 1722 cycles per play call (measured over 51 s), upper bound 2084\n`);
    assert.equal(r.err, "");
  } finally { done(); }
});

test("--data-origin writes a second file, -o names the base, --no-measure skips the emulator", () => {
  const { dir, done } = sandbox();
  try {
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "$1000", "--data-origin", "8192", "--zp", "0xF0", "--no-measure", "-o", "out/music.bin");
    assert.equal(r.code, EXIT_OK, r.err);
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")).sort(), ["music.bin", "music.data.bin"]);
    const expected = compileSidwave(doc, { target: "game", origin: 0x1000, dataOrigin: 0x2000, zeroPage: 0xf0, measure: false });
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, "out", "music.bin"))), expected.player);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, "out", "music.data.bin"))), expected.data);
    assert.match(r.out, /game build, player \$1000-\$[0-9A-F]+, data \$2000-\$[0-9A-F]+, upper bound 2084 cycles per play call \(not measured\)\n$/);
  } finally { done(); }
});

test("--json prints the contract, the cycles, the outputs and the labels", () => {
  const { dir, done } = sandbox();
  try {
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--json", "--symbols", "kickass,ca65", "--symbols-all");
    assert.equal(r.code, EXIT_OK, r.err);
    const envelope = JSON.parse(r.out);
    assert.equal(envelope.command, "compile");
    const json = envelope.result;
    const expected = compileSidwave(doc, { target: "game", origin: 0x1000 });
    assert.equal(envelope.ok, true);
    assert.equal(json.target, "game");
    assert.deepEqual(json.contract, JSON.parse(JSON.stringify(expected.contract)));
    assert.deepEqual(json.cycles, JSON.parse(JSON.stringify(expected.cycles)));
    assert.equal(json.labels.sidwave_play, 0x1003);
    assert.ok("sidwave_int_play" in json.labels);
    assert.deepEqual(json.outputs.map((o) => [o.kind, path.basename(o.path), o.bytes, o.address]), [
      ["player", "song.bin", expected.player.length, 0x1000],
      ["symbols-kickass", "song.kickass", json.outputs[1].bytes, undefined],
      ["symbols-ca65", "song.ca65", json.outputs[2].bytes, undefined],
    ]);
    assert.equal(json.totalFrames, expected.totalFrames);
    assert.deepEqual(json.warnings, []);
  } finally { done(); }
});

test("--format sid writes a PSID with the player image and the free page range", () => {
  const { dir, done } = sandbox();
  try {
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--format", "sid", "--no-measure");
    assert.equal(r.code, EXIT_OK, r.err);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["song.sid", "song.yaml"]);
    const sid = fs.readFileSync(path.join(dir, "song.sid"));
    assert.equal(sid.subarray(0, 4).toString("ascii"), "PSID");
    assert.deepEqual([sid[0x78], sid[0x79], sid.readUInt16BE(10), sid.readUInt16BE(12)], [0x20, 0xb0, 0x1f73, 0x1003]);
    assert.equal(run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0xCF00", "--format", "sid", "--no-measure").code, EXIT_INPUT);
  } finally { done(); }
});

test("a score or layout that cannot be built exits 3 with the path of the problem; bad options exit 2", () => {
  const { dir, done } = sandbox();
  try {
    const bad = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x100");
    assert.equal(bad.code, EXIT_INPUT);
    assert.match(bad.err, /song\.yaml: Invalid SIDWAVE at \$\.origin: must lie in \$0200-\$CFF4/);
    const json = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--zp", "0", "--json");
    assert.equal(json.code, EXIT_INPUT);
    assert.equal(JSON.parse(json.out).error.details.path, "$.zeroPage");
    const usage = (args, pattern) => {
      const r = run(dir, "compile", "song.yaml", ...args);
      assert.equal(r.code, EXIT_USAGE, `${args.join(" ")}: ${r.err}`);
      assert.match(r.err, pattern);
    };
    usage(["--target", "game"], /--target game needs --origin/);
    usage(["--target", "rom"], /--target must be prg or game, not rom/);
    usage(["--target", "game", "--origin", "0x10000"], /--origin 0x10000 is outside \$0000-\$FFFF/);
    usage(["--target", "game", "--origin", "banana"], /--origin needs an address such as 0x1000, \$1000 or 4096, not "banana"/);
    usage(["--target", "game", "--origin", "0x1000", "--format", "prg"], /--format for --target game must be bin, sid or asm, not prg/);
    usage(["--target", "game", "--origin", "0x1000", "--symbols", "acme,nope"], /--symbols takes 64tass, acme, kickass, ca65, vice, json, not nope/);
    usage(["--target", "game", "--origin", "0x1000", "-o", "-"], /-o - is not available with --target game/);
    usage(["--origin", "0x1000"], /--origin does not apply to compile without --target game/);
    usage(["--symbols-all"], /--symbols-all does not apply to compile without --target game/);
    fs.copyFileSync(path.join(dir, "song.yaml"), path.join(dir, "same.bin"));
    const same = run(dir, "compile", "same.bin", "--target", "game", "--origin", "0x1000", "--no-measure", "-o", "same.bin");
    assert.equal(same.code, EXIT_USAGE);
    assert.match(same.err, /an output file is the input file; refusing to overwrite it/);
    for (const command of ["validate", "lint"]) {
      const r = run(dir, command, "song.yaml", "--origin", "0x1000");
      assert.equal(r.code, EXIT_USAGE);
      assert.match(r.err, new RegExp(`--origin does not apply to ${command}`));
    }
    assert.equal(run(dir, "examples", "--no-measure").code, EXIT_USAGE);
    // The default target is the PRG; naming it changes nothing.
    assert.equal(run(dir, "compile", "song.yaml", "--target", "prg", "-o", "x.prg").code, EXIT_OK);
    fs.writeFileSync(path.join(dir, "broken.yaml"), "sidwave: 1.2\n");
    const broken = run(dir, "compile", "broken.yaml", "--target", "game", "--origin", "0x1000");
    assert.equal(broken.code, EXIT_INPUT);
  } finally { done(); }
});

test("an unwritable output is an input error", () => {
  const { dir, done } = sandbox();
  try {
    fs.writeFileSync(path.join(dir, "blocked"), "file");
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--no-measure", "-o", "blocked/out.bin");
    assert.equal(r.code, EXIT_INPUT);
    assert.match(r.err, /cannot write .*blocked\/out\.bin: (ENOTDIR|EEXIST)/);
  } finally { done(); }
});

test("the help text names the game options", () => {
  const help = run(".", "--help").out;
  for (const text of ["--target game --origin <addr>", "--data-origin", "--symbols-all", "--no-measure", "<out>.64tass, .acme, .kickass, .ca65, .vice, .symbols.json"]) {
    assert.ok(help.includes(text), text);
  }
});

test("a -o name ending in .sid selects PSID for the game target, as for the PRG; --format overrides it", () => {
  const { dir, done } = sandbox();
  try {
    const r = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--no-measure", "-o", "out/tune.SID");
    assert.equal(r.code, EXIT_OK, r.err);
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")), ["tune.sid"]);
    assert.equal(fs.readFileSync(path.join(dir, "out", "tune.sid")).subarray(0, 4).toString("ascii"), "PSID");
    const bin = run(dir, "compile", "song.yaml", "--target", "game", "--origin", "0x1000", "--no-measure", "--format", "bin", "-o", "out/raw.sid");
    assert.equal(bin.code, EXIT_OK, bin.err);
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")).sort(), ["raw.bin", "tune.sid"]);
  } finally { done(); }
});
