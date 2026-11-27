import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { runCli, EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_INPUT } from "../src/cli.js";
import { listSidwaveExamples, readExampleScore, compileSidwaveBytes } from "../src/sidwaveOps.js";
import { parseSidwave } from "../src/sidwave.js";
import { formatSidwave, diffSidwave, mergeSidwave } from "../src/format/sidwaveFormat.js";
import { transpose, setTempo, scaleTempo, substituteInstrument, quantise, humanise, restructure } from "../src/transform/index.js";
import { generateSidwave } from "../src/audio/generateSidwave.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binJs = path.join(packageRoot, "dist", "bin.js");

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-authoring-")));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** In-process run; returns the exit code and what was written. */
function run(cwd, ...args) {
  const out = [], err = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
  return { code, out: out.join(""), err: err.join("") };
}

const SCORE = readExampleScore("chiptune_drive");
const EXAMPLES = listSidwaveExamples().map((e) => e.name);
const write = (dir, name, text) => { fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };

// ---- format ----------------------------------------------------------------------------------------------------

test("format prints exactly what formatSidwave returns, for every bundled example, and is idempotent", () => {
  const { dir, done } = sandbox();
  try {
    for (const name of [...EXAMPLES, "fuer_elise"]) {
      const text = readExampleScore(name);
      const file = write(dir, `${name}.yaml`, text);
      const first = run(dir, "format", file);
      assert.equal(first.code, EXIT_OK, name);
      assert.equal(first.out, formatSidwave(text), `${name}: the same text as the library`);
      const second = run(dir, "format", write(dir, `${name}.formatted.yaml`, first.out));
      assert.equal(second.out, first.out, `${name}: formatting a formatted score changes nothing`);
      assert.equal(run(dir, "format", `${name}.formatted.yaml`, "--check").code, EXIT_OK, name);
    }
  } finally { done(); }
});

test("format --check exits 1 for a file that is not formatted and lists it; --write fixes it", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "raw.yaml", SCORE);
    write(dir, "good.yaml", formatSidwave(SCORE));
    const bad = run(dir, "format", "raw.yaml", "good.yaml", "--check");
    assert.equal(bad.code, EXIT_FAILED);
    assert.match(bad.out, /raw\.yaml: not formatted/);
    assert.doesNotMatch(bad.out, /good\.yaml/);
    assert.equal(fs.readFileSync(path.join(dir, "raw.yaml"), "utf8"), SCORE, "--check changes nothing");
    const json = JSON.parse(run(dir, "format", "raw.yaml", "--check", "--json").out);
    assert.equal(json.ok, false);
    assert.equal(json.result.formatted, false);
    const fixed = run(dir, "format", "raw.yaml", "good.yaml", "--write");
    assert.equal(fixed.code, EXIT_OK);
    assert.match(fixed.out, /formatted raw\.yaml/);
    assert.equal(fs.readFileSync(path.join(dir, "raw.yaml"), "utf8"), formatSidwave(SCORE));
    assert.equal(run(dir, "format", "raw.yaml", "good.yaml", "--check").code, EXIT_OK);
    assert.match(run(dir, "format", "raw.yaml", "--write").out, /already formatted/);
  } finally { done(); }
});

test("format reports usage errors and invalid YAML with their exit codes", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "a.yaml", SCORE);
    write(dir, "broken.yaml", "a: [1, 2\nb: {");
    for (const args of [["format"], ["format", "a.yaml", "--check", "--write"], ["format", "a.yaml", "b.yaml"], ["format", "a.yaml", "--check", "-o", "x"], ["format", "a.yaml", "--bogus"]]) {
      assert.equal(run(dir, ...args).code, EXIT_USAGE, args.join(" "));
    }
    const broken = run(dir, "format", "broken.yaml");
    assert.equal(broken.code, EXIT_INPUT);
    assert.match(broken.err, /^broken\.yaml: not valid YAML/);
    assert.equal(run(dir, "format", "missing.yaml").code, EXIT_INPUT);
    write(dir, "out.yaml", "x");
    const clash = run(dir, "format", "a.yaml", "-o", "out.yaml");
    assert.equal(clash.code, EXIT_USAGE);
    assert.match(clash.err, /--force/);
    assert.equal(run(dir, "format", "a.yaml", "-o", "out.yaml", "--force").code, EXIT_OK);
    assert.equal(fs.readFileSync(path.join(dir, "out.yaml"), "utf8"), formatSidwave(SCORE));
  } finally { done(); }
});

// ---- diff ------------------------------------------------------------------------------------------------------

const TEMPO = /tempo: *([\d.]+)/;
const withTempo = (text, bpm) => text.replace(TEMPO, `tempo: ${bpm}`);

test("diff exits 0 for equal scores and 1 for different ones, and --json matches diffSidwave", () => {
  const { dir, done } = sandbox();
  try {
    const changed = withTempo(SCORE, 99);
    write(dir, "a.yaml", SCORE);
    write(dir, "b.yaml", changed);
    const same = run(dir, "diff", "a.yaml", "a.yaml");
    assert.equal(same.code, EXIT_OK);
    assert.match(same.out, /semantically identical/);
    const different = run(dir, "diff", "a.yaml", "b.yaml");
    assert.equal(different.code, EXIT_FAILED);
    assert.match(different.out, /1 change \(1 musical\)/);
    assert.match(different.out, /\/tempo/);
    assert.match(different.out, /compiled output: different/);
    const json = JSON.parse(run(dir, "diff", "a.yaml", "b.yaml", "--json").out);
    const direct = diffSidwave(SCORE, changed);
    assert.equal(json.ok, false);
    assert.equal(json.result.equal, false);
    assert.deepEqual(json.result.changes, direct.changes);
    assert.equal(json.result.compiledEqual, direct.compiledEqual);
  } finally { done(); }
});

test("diff treats a formatting-only difference as a difference unless --ignore-formatting is given", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "a.yaml", SCORE);
    write(dir, "b.yaml", formatSidwave(SCORE));
    const plain = run(dir, "diff", "a.yaml", "b.yaml");
    assert.equal(plain.code, EXIT_FAILED);
    assert.match(plain.out, /only the formatting differs/);
    assert.equal(run(dir, "diff", "a.yaml", "b.yaml", "--ignore-formatting").code, EXIT_OK);
    assert.equal(run(dir, "diff", "a.yaml").code, EXIT_USAGE);
    assert.equal(run(dir, "diff", "a.yaml", "nope.yaml").code, EXIT_INPUT);
  } finally { done(); }
});

test("diff --git follows the external diff driver convention and always exits 0", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "old", SCORE);
    write(dir, "new", withTempo(SCORE, 99));
    const result = run(dir, "diff", "--git", "songs/x.yaml", "old", "1234567", "100644", "new", "abcdef0", "100644");
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /a\/songs\/x\.yaml -> b\/songs\/x\.yaml: 1 change/);
    assert.match(run(dir, "diff", "--git", "songs/x.yaml", "/dev/null", ".", "000", "new", "abc", "100644").out, /new score/);
    assert.match(run(dir, "diff", "--git", "songs/x.yaml", "old", ".", "100644", "/dev/null", ".", "000").out, /score deleted/);
    assert.equal(run(dir, "diff", "--git", "a", "b").code, EXIT_USAGE);
  } finally { done(); }
});

// ---- merge -----------------------------------------------------------------------------------------------------

const retitle = (text, title) => text.replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`);

test("merge of changes in different places writes the same text as mergeSidwave", () => {
  const { dir, done } = sandbox();
  try {
    const ours = withTempo(SCORE, 99);
    const theirs = retitle(SCORE, "Retitled");
    assert.ok(/^title:/m.test(SCORE), "the example has a title line");
    write(dir, "base.yaml", SCORE);
    write(dir, "ours.yaml", ours);
    write(dir, "theirs.yaml", theirs);
    const direct = mergeSidwave(SCORE, ours, theirs);
    assert.ok(direct.merged, "the library merges these without conflicts");
    const merged = run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml");
    assert.equal(merged.code, EXIT_OK);
    assert.equal(merged.out, direct.merged);
    assert.equal(parseSidwave(merged.out).song.title, "Retitled");
    const outFile = run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "-o", "m.yaml");
    assert.equal(outFile.code, EXIT_OK);
    assert.equal(fs.readFileSync(path.join(dir, "m.yaml"), "utf8"), direct.merged);
    assert.equal(run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "-o", "m.yaml").code, EXIT_USAGE, "an existing output needs --force");
    assert.equal(run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "-o", "m.yaml", "--force").code, EXIT_OK);
    const json = JSON.parse(run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "--json").out);
    assert.equal(json.ok, true);
    assert.equal(json.result.text, direct.merged);
  } finally { done(); }
});

test("merge of conflicting changes exits 1, writes nothing and names each conflict", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "base.yaml", SCORE);
    write(dir, "ours.yaml", withTempo(SCORE, 99));
    write(dir, "theirs.yaml", withTempo(SCORE, 111));
    const conflict = run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "-o", "m.yaml");
    assert.equal(conflict.code, EXIT_FAILED);
    assert.equal(conflict.out, "");
    assert.match(conflict.err, /1 conflict; nothing was written/);
    assert.match(conflict.err, /\/tempo/);
    assert.match(conflict.err, /ours\s+99/);
    assert.match(conflict.err, /theirs\s+111/);
    assert.equal(fs.existsSync(path.join(dir, "m.yaml")), false);
    const json = JSON.parse(run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml", "--json").out);
    assert.equal(json.ok, false);
    assert.equal(json.result.merged, false);
    assert.deepEqual(json.result.conflicts, mergeSidwave(SCORE, withTempo(SCORE, 99), withTempo(SCORE, 111)).conflicts);
    assert.equal(run(dir, "merge", "base.yaml", "ours.yaml").code, EXIT_USAGE);
  } finally { done(); }
});

const git = (cwd, env, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
const haveGit = spawnSync("git", ["--version"]).status === 0;

test("the documented git merge driver merges scores and reports conflicts", { skip: !haveGit && "git is not installed" }, () => {
  const { dir, done } = sandbox();
  try {
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.org" };
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const g = (...args) => git(repo, env, ...args);
    assert.equal(g("init", "-q", "-b", "main").status, 0);
    write(repo, ".gitattributes", "*.sidwave.yaml merge=sidwave\n*.sidwave.yaml diff=sidwave\n");
    const q = (s) => `"${s}"`;
    assert.equal(g("config", "merge.sidwave.name", "SIDWave semantic merge").status, 0);
    assert.equal(g("config", "merge.sidwave.driver", `${q(process.execPath)} ${q(binJs)} merge %O %A %B -o %A --force`).status, 0);
    assert.equal(g("config", "diff.sidwave.command", `${q(process.execPath)} ${q(binJs)} diff --git`).status, 0);
    write(repo, "song.sidwave.yaml", SCORE);
    assert.equal(g("add", ".").status, 0);
    assert.equal(g("commit", "-q", "-m", "base").status, 0);
    // Clean: one branch changes the tempo, the other the title, both on the same lines of context.
    assert.equal(g("checkout", "-q", "-b", "other").status, 0);
    write(repo, "song.sidwave.yaml", retitle(SCORE, "Retitled"));
    assert.equal(g("commit", "-q", "-am", "title").status, 0);
    assert.equal(g("checkout", "-q", "main").status, 0);
    write(repo, "song.sidwave.yaml", withTempo(SCORE, 99));
    assert.equal(g("commit", "-q", "-am", "tempo").status, 0);
    const clean = g("merge", "other", "-m", "merge");
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const merged = fs.readFileSync(path.join(repo, "song.sidwave.yaml"), "utf8");
    assert.equal(parseSidwave(merged).song.title, "Retitled");
    assert.equal(parseSidwave(merged).song.tempo, 99);
    // The diff driver shows the semantic change of the merge commit.
    const shown = g("diff", "HEAD~1", "HEAD");
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /1 change/);
    // Conflict: both branches set the tempo.
    assert.equal(g("checkout", "-q", "-b", "c1", "HEAD").status, 0);
    write(repo, "song.sidwave.yaml", withTempo(merged, 120));
    assert.equal(g("commit", "-q", "-am", "c1").status, 0);
    assert.equal(g("checkout", "-q", "-b", "c2", "HEAD~1").status, 0);
    write(repo, "song.sidwave.yaml", withTempo(merged, 133));
    assert.equal(g("commit", "-q", "-am", "c2").status, 0);
    const conflict = g("merge", "c1", "-m", "conflicting");
    assert.notEqual(conflict.status, 0, "git reports the conflict");
    assert.match(conflict.stdout + conflict.stderr, /conflict/i);
    assert.equal(fs.readFileSync(path.join(repo, "song.sidwave.yaml"), "utf8"), withTempo(merged, 133), "the working copy keeps ours");
  } finally { done(); }
});

// ---- transform -------------------------------------------------------------------------------------------------

test("transform output is the library output, for every operation", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    const tempoBefore = YAML.parse(SCORE).tempo ?? YAML.parse(SCORE).song?.tempo;
    const instrument = /instrument: ([a-z_]+)/.exec(SCORE)?.[1];
    const sections = Object.keys(YAML.parse(SCORE).sections ?? {});
    const cases = [
      [["--transpose", "3"], transpose(SCORE, { semitones: 3 })],
      [["--transpose", "-2", "--voice", "1"], transpose(SCORE, { semitones: -2, scope: { voices: ["1"] } })],
      [["--tempo", "99"], setTempo(SCORE, { bpm: 99 })],
      [["--tempo-factor", "0.9"], scaleTempo(SCORE, { factor: 0.9 })],
      [["--quantise", "0.25"], quantise(SCORE, { grid: 0.25 })],
      [["--humanise", "0.05", "--seed", "4"], humanise(SCORE, { seed: 4, maxShift: 0.05 })],
      ...(instrument ? [[["--swap-instrument", `${instrument}=lib:lead_pwm`], substituteInstrument(SCORE, { from: instrument, to: "lib:lead_pwm" })]] : []),
      ...(sections.length > 1 ? [[["--order", sections.slice().reverse().join(",")], restructure(SCORE, { order: sections.slice().reverse() })]] : []),
    ];
    assert.ok(tempoBefore > 0);
    assert.ok(cases.length >= 6);
    for (const [flags, direct] of cases) {
      const result = run(dir, "transform", "s.yaml", ...flags);
      assert.equal(result.code, EXIT_OK, `${flags.join(" ")}: ${result.err}`);
      assert.equal(result.out, direct.text, flags.join(" "));
      const json = JSON.parse(run(dir, "transform", "s.yaml", ...flags, "--json").out);
      assert.equal(json.result.text, direct.text);
      assert.deepEqual(json.result.steps[0].changed, direct.report.changed);
      assert.equal(json.result.changed, direct.report.changed.length);
    }
  } finally { done(); }
});

test("transform applies several operations in the order given and reports every step", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    const direct = setTempo(transpose(SCORE, { semitones: 2, validate: "parse" }).text, { bpm: 140 });
    const result = run(dir, "transform", "s.yaml", "--transpose", "2", "--tempo", "140", "-o", "out.yaml");
    assert.equal(result.code, EXIT_OK, result.err);
    assert.equal(fs.readFileSync(path.join(dir, "out.yaml"), "utf8"), direct.text);
    assert.match(result.out, /142 values changed: transpose 141, tempo 1/);
    const json = JSON.parse(run(dir, "transform", "s.yaml", "--transpose", "2", "--tempo", "140", "-o", "o2.yaml", "--json").out);
    assert.deepEqual(json.result.steps.map((s) => s.op), ["transpose", "tempo"]);
    assert.equal(json.result.output, path.join(dir, "o2.yaml"));
    assert.ok(parseSidwave(fs.readFileSync(path.join(dir, "o2.yaml"), "utf8")));
  } finally { done(); }
});

test("transform --validate parse gives the library result without the compile check", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    // A tempo 1.25 times faster is a valid score that no longer compiles (a bend does not fit its note).
    const checked = run(dir, "transform", "s.yaml", "--tempo-factor", "1.25");
    assert.equal(checked.code, EXIT_INPUT);
    assert.match(checked.err, /does not compile/);
    const parsed = run(dir, "transform", "s.yaml", "--tempo-factor", "1.25", "--validate", "parse");
    assert.equal(parsed.code, EXIT_OK);
    assert.equal(parsed.out, scaleTempo(SCORE, { factor: 1.25, validate: "parse" }).text);
    assert.equal(run(dir, "transform", "s.yaml", "--tempo", "99", "--validate", "none").code, EXIT_USAGE);
  } finally { done(); }
});

test("transform without -o prints the score and the report separately, and never overwrites without --force", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    const printed = run(dir, "transform", "s.yaml", "--tempo", "99");
    assert.equal(printed.code, EXIT_OK);
    assert.match(printed.out, /^sidwave:/m);
    assert.match(printed.err, /1 value changed: tempo 1/);
    assert.equal(fs.readFileSync(path.join(dir, "s.yaml"), "utf8"), SCORE);
    write(dir, "exists.yaml", "keep");
    const refused = run(dir, "transform", "s.yaml", "--tempo", "99", "-o", "exists.yaml");
    assert.equal(refused.code, EXIT_USAGE);
    assert.match(refused.err, /--force/);
    assert.equal(fs.readFileSync(path.join(dir, "exists.yaml"), "utf8"), "keep");
    const inPlace = run(dir, "transform", "s.yaml", "--tempo", "99", "-o", "s.yaml");
    assert.equal(inPlace.code, EXIT_USAGE);
    assert.match(inPlace.err, /input file/);
    assert.equal(fs.readFileSync(path.join(dir, "s.yaml"), "utf8"), SCORE);
    assert.equal(run(dir, "transform", "s.yaml", "--tempo", "99", "-o", "s.yaml", "--force").code, EXIT_OK);
    assert.equal(YAML.parse(fs.readFileSync(path.join(dir, "s.yaml"), "utf8")).tempo ?? YAML.parse(fs.readFileSync(path.join(dir, "s.yaml"), "utf8")).song.tempo, 99);
  } finally { done(); }
});

test("transform errors say what to do and use the exit codes of the contract", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    write(dir, "bad.yaml", "title: x\nvoices: nope\n");
    for (const args of [["transform"], ["transform", "s.yaml"], ["transform", "s.yaml", "--transpose", "x"], ["transform", "s.yaml", "--tempo"],
      ["transform", "s.yaml", "--swap-instrument", "novalue"], ["transform", "s.yaml", "--tempo", "99", "--voice", "1"], ["transform", "s.yaml", "--tempo", "99", "--section", "a"],
      ["transform", "s.yaml", "--tempo", "99", "--seed", "1"], ["transform", "s.yaml", "--order", ","], ["transform", "a", "b", "--tempo", "99"]]) {
      const result = run(dir, ...args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
      assert.match(result.err, /Run "sidwave transform --help"/);
    }
    const high = run(dir, "transform", "s.yaml", "--transpose", "60");
    assert.equal(high.code, EXIT_INPUT);
    assert.match(high.err, /^s\.yaml: .*Offending note at \/voices.*--voice or --section/);
    const slow = run(dir, "transform", "s.yaml", "--tempo", "1");
    assert.equal(slow.code, EXIT_INPUT);
    assert.match(slow.err, /bpm must be/);
    assert.equal(run(dir, "transform", "bad.yaml", "--tempo", "99").code, EXIT_INPUT);
    assert.equal(run(dir, "transform", "missing.yaml", "--tempo", "99").code, EXIT_INPUT);
    const json = JSON.parse(run(dir, "transform", "s.yaml", "--transpose", "60", "--json").out);
    assert.equal(json.ok, false);
    assert.equal(json.error.category, "validation");
    assert.equal(json.error.details.code, "out_of_range");
  } finally { done(); }
});

// ---- generate --------------------------------------------------------------------------------------------------

const direct = (options) => formatSidwave(YAML.stringify(generateSidwave({ root: "C3", preset: "classic", system: "PAL", ...options }).score));

test("generate prints the score of generateSidwave, deterministically for a seed", () => {
  const { dir, done } = sandbox();
  try {
    const a = run(dir, "generate", "--seed", "12");
    assert.equal(a.code, EXIT_OK);
    assert.equal(a.out, direct({ composer: 2, style: "chiptune", seed: 12 }));
    assert.equal(run(dir, "generate", "--seed", "12").out, a.out, "the same seed gives the same score");
    assert.notEqual(run(dir, "generate", "--seed", "13").out, a.out);
    assert.ok(parseSidwave(a.out));
    assert.equal(run(dir, "generate", "--style", "funk", "--seed", "5").out, direct({ composer: 2, style: "funk", seed: 5 }));
    assert.equal(run(dir, "generate", "--profile", "soft-arch-lydian", "--seed", "3", "--root", "D3", "--clock", "ntsc").out,
      direct({ composer: 2, profile: "soft-arch-lydian", style: "chiptune", seed: 3, root: "D3", system: "NTSC" }));
    assert.equal(run(dir, "generate", "--composer", "1", "--style", "ambient", "--seed", "9").out, direct({ composer: 1, style: "ambient", seed: 9 }));
    assert.match(a.err, /chiptune seed 12, composer 2 \(chip-aaba-minor\)/);
  } finally { done(); }
});

test("generate --bars and --minutes select composer 1 and give the requested length", () => {
  const { dir, done } = sandbox();
  try {
    const bars = run(dir, "generate", "--bars", "16", "--seed", "2", "--json");
    assert.equal(bars.code, EXIT_OK);
    const json = JSON.parse(bars.out);
    assert.equal(json.result.composer, 1);
    assert.equal(json.result.bars, 16);
    assert.equal(json.result.text, direct({ composer: 1, style: "chiptune", seed: 2, steps: 128 }));
    assert.match(json.result.warnings.join(" "), /selected composer 1/);
    const minutes = JSON.parse(run(dir, "generate", "--minutes", "2", "--style", "ambient", "--json").out);
    assert.equal(minutes.result.bars, 40, "2 minutes at 80 bpm is 40 bars of four beats");
    assert.ok(minutes.result.seconds >= 120 && minutes.result.seconds < 125);
    const eight = run(dir, "generate", "--bars", "8", "--seed", "2");
    assert.equal(eight.out, direct({ composer: 1, style: "chiptune", seed: 2 }), "eight bars is the default composer 1 score");
    for (const args of [["--composer", "2", "--bars", "8"], ["--bars", "4", "--minutes", "1"], ["--bars", "0"], ["--profile", "soft-arch-lydian", "--bars", "4"], ["--composer", "1", "--profile", "soft-arch-lydian"]]) {
      const result = run(dir, "generate", ...args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
      assert.match(result.err, /Run "sidwave generate --help"/);
    }
  } finally { done(); }
});

test("generate --prg and --sid write the bytes that sidwave compile produces for the score", () => {
  const { dir, done } = sandbox();
  try {
    const result = run(dir, "generate", "--seed", "4", "-o", "t.yaml", "--prg", "t.prg", "--sid", "t.sid");
    assert.equal(result.code, EXIT_OK, result.err);
    assert.equal(result.out.includes("sidwave:"), false, "no score on standard output");
    const doc = parseSidwave(fs.readFileSync(path.join(dir, "t.yaml"), "utf8"));
    assert.deepEqual(fs.readFileSync(path.join(dir, "t.prg")), Buffer.from(compileSidwaveBytes(doc, { format: "prg" }).bytes));
    assert.deepEqual(fs.readFileSync(path.join(dir, "t.sid")), Buffer.from(compileSidwaveBytes(doc, { format: "sid" }).bytes));
    assert.equal(run(dir, "compile", "t.yaml", "-o", "c.prg").code, EXIT_OK);
    assert.deepEqual(fs.readFileSync(path.join(dir, "c.prg")), fs.readFileSync(path.join(dir, "t.prg")));
    // Only a binary requested: the score is not printed, and nothing is replaced without --force.
    const only = run(dir, "generate", "--seed", "4", "--prg", "o.prg");
    assert.equal(only.out.includes("sidwave:"), false);
    assert.deepEqual(fs.readFileSync(path.join(dir, "o.prg")), fs.readFileSync(path.join(dir, "t.prg")));
    const again = run(dir, "generate", "--seed", "4", "--prg", "o.prg");
    assert.equal(again.code, EXIT_USAGE);
    assert.match(again.err, /--force/);
    assert.equal(run(dir, "generate", "--seed", "4", "--prg", "o.prg", "--force").code, EXIT_OK);
  } finally { done(); }
});

test("generate --list names the styles and every profile; bad values are usage errors", () => {
  const { dir, done } = sandbox();
  try {
    const list = run(dir, "generate", "--list");
    assert.equal(list.code, EXIT_OK);
    for (const word of ["chiptune", "ambient", "funk", "chip-aaba-minor", "waltz-aaba-minor", "brisk-through-major"]) assert.match(list.out, new RegExp(word));
    const json = JSON.parse(run(dir, "generate", "--list", "--json").out);
    assert.equal(json.result.styles.length, 3);
    assert.ok(json.result.profiles.length >= 30);
    for (const args of [["--style", "polka"], ["--seed", "-1"], ["--seed", "x"], ["--composer", "3"], ["--profile", "nope"], ["--root", "H9"], ["--clock", "secam"], ["song.yaml"]]) {
      const result = run(dir, "generate", ...args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
    }
    assert.match(run(dir, "generate", "--profile", "nope").err, /sidwave generate --list/);
  } finally { done(); }
});

test("every authoring command has --help with at least two examples", () => {
  for (const command of ["transform", "format", "diff", "merge", "generate"]) {
    const help = run(".", command, "--help");
    assert.equal(help.code, EXIT_OK, command);
    assert.match(help.out, new RegExp(`^sidwave ${command}:`), command);
    const examples = help.out.split("Examples:")[1] ?? "";
    assert.ok(examples.split("\n").filter((line) => line.trim().startsWith("sidwave ")).length >= 2, `${command} shows two examples`);
    assert.match(help.out, /Exit codes|exit 1|Exit 0/i);
  }
  assert.match(run(".", "--help").out, /sidwave generate/);
});

test("the built command line runs the authoring commands", () => {
  if (!fs.existsSync(binJs)) return;
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    const result = spawnSync(process.execPath, [binJs, "diff", "s.yaml", "s.yaml"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /semantically identical/);
    assert.equal(spawnSync(process.execPath, [binJs, "format", "s.yaml", "--check"], { cwd: dir }).status, 1);
  } finally { done(); }
});
