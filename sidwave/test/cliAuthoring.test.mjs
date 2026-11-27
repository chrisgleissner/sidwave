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
import { describeChange } from "../src/cliDiff.js";
import { unknownCommandMessage } from "../src/cliAuthoring.js";
import { checkSidwaveCompiles, compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
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
// The bundled examples are formatted; RAW is the same score with one non-canonical line.
const RAW = SCORE.replace(/^tempo: */m, "tempo:   ");
assert.ok(RAW !== SCORE && formatSidwave(RAW) === SCORE, "the examples are in canonical format and RAW is not");
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
    write(dir, "raw.yaml", RAW);
    write(dir, "good.yaml", SCORE);
    const bad = run(dir, "format", "raw.yaml", "good.yaml", "--check");
    assert.equal(bad.code, EXIT_FAILED);
    assert.match(bad.out, /raw\.yaml: not formatted/);
    assert.doesNotMatch(bad.out, /good\.yaml/);
    assert.equal(fs.readFileSync(path.join(dir, "raw.yaml"), "utf8"), RAW, "--check changes nothing");
    const json = JSON.parse(run(dir, "format", "raw.yaml", "--check", "--json").out);
    assert.equal(json.ok, false);
    assert.equal(json.result.formatted, false);
    const fixed = run(dir, "format", "raw.yaml", "good.yaml", "--write");
    assert.equal(fixed.code, EXIT_OK);
    assert.match(fixed.out, /formatted raw\.yaml/);
    assert.equal(fs.readFileSync(path.join(dir, "raw.yaml"), "utf8"), SCORE);
    assert.equal(run(dir, "format", "raw.yaml", "good.yaml", "--check").code, EXIT_OK);
    assert.match(run(dir, "format", "raw.yaml", "--write").out, /already formatted/);
  } finally { done(); }
});

test("format rejects anything that is not a valid score and never rewrites it", () => {
  const { dir, done } = sandbox();
  try {
    const cases = { "other.yaml": "hello: world\n", "words.txt": "random words without structure\n", "list.yaml": "- 1\n- 2\n", "empty.yaml": "" };
    for (const [name, content] of Object.entries(cases)) {
      write(dir, name, content);
      for (const args of [["format", name], ["format", name, "--check"], ["format", name, "--write"]]) {
        const result = run(dir, ...args);
        assert.equal(result.code, EXIT_INPUT, args.join(" "));
        assert.match(result.err, new RegExp(`^${name}: `));
        assert.equal(result.out, "", "nothing is printed");
      }
      assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), content, `${name} is unchanged`);
    }
    assert.match(run(dir, "format", "missing.yaml").err, /^sidwave: no such file: missing\.yaml/);
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
    assert.match(broken.err, /^broken\.yaml: .*could not be parsed/);
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
    assert.doesNotMatch(different.out, /compiled output/);
    assert.match(run(dir, "diff", "a.yaml", "b.yaml", "--compile").out, /compiled output: different/);
    const json = JSON.parse(run(dir, "diff", "a.yaml", "b.yaml", "--json", "--compile").out);
    const direct = diffSidwave(SCORE, changed);
    assert.equal(json.ok, false);
    assert.equal(json.result.equal, false);
    assert.deepEqual(json.result.changes, direct.changes);
    assert.equal(json.result.compiledEqual, direct.compiledEqual);
    assert.equal(JSON.parse(run(dir, "diff", "a.yaml", "b.yaml", "--json").out).result.compiledEqual, null, "the compile is opt-in");
  } finally { done(); }
});

test("diff treats a formatting-only difference as a difference unless --ignore-formatting is given", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "a.yaml", RAW);
    write(dir, "b.yaml", SCORE);
    const plain = run(dir, "diff", "a.yaml", "b.yaml");
    assert.equal(plain.code, EXIT_FAILED);
    assert.match(plain.out, /formatting only \(no musical change\)/);
    assert.equal(run(dir, "diff", "a.yaml", "b.yaml", "--ignore-formatting").code, EXIT_OK);
    assert.equal(run(dir, "diff", "a.yaml").code, EXIT_USAGE);
    assert.equal(run(dir, "diff", "a.yaml", "nope.yaml").code, EXIT_INPUT);
  } finally { done(); }
});

test("diff without --compile gives the same changes as the library without compiling", () => {
  const { dir, done } = sandbox();
  try {
    const changed = withTempo(SCORE, 99);
    write(dir, "a.yaml", SCORE);
    write(dir, "b.yaml", changed);
    const full = diffSidwave(SCORE, changed);
    const fast = diffSidwave(SCORE, changed, undefined, { compile: false });
    assert.deepEqual(fast.changes, full.changes);
    assert.equal(fast.compiledEqual, null);
    const json = JSON.parse(run(dir, "diff", "a.yaml", "b.yaml", "--json").out);
    assert.deepEqual(json.result.changes, full.changes);
    assert.equal(run(dir, "diff", "a.yaml", "a.yaml").code, EXIT_OK);
  } finally { done(); }
});

test("diff shows the changed tokens of a long value and rejects input that is not a score", () => {
  const { dir, done } = sandbox();
  try {
    const long = "C3 D3 E3 F3 G3 A3 B3 C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6 D6 E6 F6 G6 A6 B6 C7 D7 E7 F7";
    assert.equal(describeChange("C3", "D3"), '"C3" -> "D3"');
    const shown = describeChange(long, long.replace("A4 B4 C5", "A4 Bb4 C5"));
    assert.match(shown, /\[B4 -> Bb4\]/, shown);
    assert.ok(shown.startsWith('"...'), "the common start is cut");
    assert.ok(shown.length < long.length, "shorter than the value");
    write(dir, "a.yaml", SCORE);
    write(dir, "text.yaml", "just some words\n");
    write(dir, "other.yaml", "hello: world\n");
    for (const bad of ["text.yaml", "other.yaml", "missing.yaml"]) {
      const result = run(dir, "diff", "a.yaml", bad);
      assert.equal(result.code, EXIT_INPUT, bad);
      assert.match(result.err, new RegExp(bad === "missing.yaml" ? "no such file: missing.yaml" : `^${bad}: `));
    }
    assert.match(run(dir, "diff", "a.yaml", ".").err, /is a directory: \./);
  } finally { done(); }
});

test("transform validation levels: arrange finds a result the compiler rejects, parse does not, and a chain gives the stepwise library text", () => {
  // A tempo 1.25 times faster is a valid score for which a bend no longer fits its note.
  const slow = (validate) => () => scaleTempo(SCORE, { factor: 1.25, validate });
  assert.doesNotThrow(slow("parse"));
  assert.throws(slow("arrange"), /does not compile/);
  assert.throws(slow("compile"), /does not compile/);
  const first = transpose(SCORE, { semitones: 2, validate: "parse" });
  const checkedTwice = setTempo(first.text, { bpm: 120, validate: "arrange" });
  assert.equal(setTempo(first.text, { bpm: 120, validate: "arrange", inputChecked: true }).text, checkedTwice.text, "inputChecked only skips the parse of the input");
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    const chain = run(dir, "transform", "s.yaml", "--transpose", "2", "--quantise", "0.25", "--tempo", "120");
    assert.equal(chain.code, EXIT_OK, chain.err);
    assert.equal(chain.out, setTempo(quantise(first.text, { grid: 0.25, validate: "none" }).text, { bpm: 120 }).text);
    write(dir, "bad.yaml", "title: x\nvoices: nope\n");
    assert.equal(run(dir, "transform", "bad.yaml", "--tempo", "99", "--quantise", "0.25").code, EXIT_INPUT, "the input of a chain is checked");
    const last = run(dir, "transform", "s.yaml", "--tempo", "140", "--tempo-factor", "1.25", "--quantise", "0.25");
    assert.equal(last.code, EXIT_INPUT, "the final result of a chain is checked");
    assert.match(last.err, /does not compile/);
    assert.match(last.err, /tempo closer to the original/, "the hint names the tempo, not the transposition");
    assert.equal(run(dir, "transform", "s.yaml", "--tempo-factor", "1.25", "--validate", "parse").code, EXIT_OK);
    assert.equal(run(dir, "transform", "s.yaml", "--tempo-factor", "1.25", "--validate", "compile").code, EXIT_INPUT);
    assert.equal(run(dir, "transform", "s.yaml", "--tempo", "99", "--validate", "none").code, EXIT_USAGE);
  } finally { done(); }
});

test("the default transform check finds the cycle budget and the memory size, like the compiler", () => {
  const message = (fn) => { try { fn(); } catch (e) { return e.message; } return undefined; };
  // checkSidwaveCompiles throws what compileSidwaveToPrg throws for the cycle budget, and finds nothing in the examples.
  for (const name of EXAMPLES) {
    const doc = parseSidwave(readExampleScore(name));
    assert.equal(message(() => checkSidwaveCompiles(doc, { loop: false })), undefined, name);
  }
  const noTurbo = readExampleScore("ultisid_orchestra").replace(/^cpu:.*$/m, "");
  assert.ok(!/^cpu:/m.test(noTurbo));
  const cycles = message(() => compileSidwaveToPrg(parseSidwave(noTurbo), { loop: false }));
  assert.match(cycles, /use cpu: turbo/);
  assert.equal(message(() => checkSidwaveCompiles(parseSidwave(noTurbo), { loop: false })), cycles, "the same message as the compiler");
  // A song that does not fit below $D000.
  const long = formatSidwave(YAML.stringify(generateSidwave({ composer: 1, root: "C3", preset: "classic", style: "funk", seed: 1, system: "PAL", steps: 260 * 8 }).score));
  const size = message(() => compileSidwaveToPrg(parseSidwave(long), { loop: false }));
  assert.match(size, /the compiled song needs/);
  assert.equal(message(() => checkSidwaveCompiles(parseSidwave(long), { loop: false })), size);
  const { dir, done } = sandbox();
  try {
    write(dir, "u.yaml", noTurbo);
    write(dir, "ok.yaml", readExampleScore("ultisid_orchestra"));
    const result = run(dir, "transform", "u.yaml", "--tempo", "100");
    assert.equal(result.code, EXIT_INPUT, "the default check rejects what the compiler rejects");
    assert.match(result.err, /cpu: turbo/);
    assert.equal(run(dir, "transform", "u.yaml", "--tempo", "100", "--validate", "compile").code, EXIT_INPUT);
    assert.equal(run(dir, "transform", "u.yaml", "--tempo", "100", "--validate", "parse").code, EXIT_OK, "parse checks neither");
    assert.equal(run(dir, "transform", "ok.yaml", "--tempo", "100").code, EXIT_OK);
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

test("merge keeps the comments of ours when both sides changed different values", () => {
  const { dir, done } = sandbox();
  try {
    const commentLines = (text) => text.split("\n").filter((line) => /^\s*#/.test(line));
    const base = SCORE;
    const ours = transpose(base, { semitones: 1, scope: { voices: ["1"] }, validate: "none" }).text;
    const theirs = setTempo(transpose(base, { semitones: -1, scope: { voices: ["2"] }, validate: "none" }).text, { bpm: 101, validate: "none" }).text;
    assert.ok(commentLines(ours).length > 20, "the example has comments");
    write(dir, "base.yaml", base);
    write(dir, "ours.yaml", ours);
    write(dir, "theirs.yaml", theirs);
    const merged = run(dir, "merge", "base.yaml", "ours.yaml", "theirs.yaml");
    assert.equal(merged.code, EXIT_OK, merged.err);
    assert.equal(merged.err, "", "no warning: the edits were applied in place");
    const kept = new Set(commentLines(merged.out).map((l) => l.trim()));
    const lost = commentLines(ours).filter((line) => !kept.has(line.trim()));
    assert.deepEqual(lost, [], "every comment line of ours is still there");
    const parsed = YAML.parse(merged.out);
    assert.equal(parsed.tempo ?? parsed.song?.tempo, 101, "theirs tempo and both voice changes are merged");
    assert.equal(merged.out, mergeSidwave(base, ours, theirs).merged);
    assert.equal(mergeSidwave(base, ours, theirs).preserved, true);
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

test("file errors name the path; /dev/null needs no --force", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    fs.mkdirSync(path.join(dir, "folder"));
    for (const command of [["format"], ["transform", "--tempo", "99"]]) {
      assert.match(run(dir, command[0], "nope.yaml", ...command.slice(1)).err, /^sidwave: no such file: nope\.yaml/);
      assert.match(run(dir, command[0], "folder", ...command.slice(1)).err, /^sidwave: is a directory: folder/);
    }
    assert.equal(run(dir, "transform", "s.yaml", "--tempo", "99", "-o", "/dev/null").code, EXIT_OK);
    assert.equal(run(dir, "format", "s.yaml", "-o", "/dev/null").code, EXIT_OK);
    assert.equal(run(dir, "merge", "s.yaml", "s.yaml", "s.yaml", "-o", "/dev/null").code, EXIT_OK);
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

test("generate --bars and --minutes need --composer 1 and give the requested length", () => {
  const { dir, done } = sandbox();
  try {
    const bars = run(dir, "generate", "--composer", "1", "--bars", "16", "--seed", "2", "--json");
    assert.equal(bars.code, EXIT_OK);
    const json = JSON.parse(bars.out);
    assert.equal(json.result.composer, 1);
    assert.equal(json.result.bars, 16);
    assert.equal(json.result.text, direct({ composer: 1, style: "chiptune", seed: 2, steps: 128 }));
    const minutes = JSON.parse(run(dir, "generate", "--composer", "1", "--minutes", "2", "--style", "ambient", "--json").out);
    assert.equal(minutes.result.bars, 40, "2 minutes at 80 bpm is 40 bars of four beats");
    assert.ok(minutes.result.seconds >= 120 && minutes.result.seconds < 125);
    const eight = run(dir, "generate", "--composer", "1", "--bars", "8", "--seed", "2");
    assert.equal(eight.out, direct({ composer: 1, style: "chiptune", seed: 2 }), "eight bars is the default composer 1 score");
    for (const args of [["--bars", "8"], ["--minutes", "1"], ["--composer", "2", "--bars", "8"], ["--composer", "1", "--bars", "4", "--minutes", "1"], ["--composer", "1", "--bars", "0"],
      ["--composer", "1", "--minutes", "0"], ["--composer", "1", "--minutes", "-1"], ["--composer", "1", "--minutes", "x"], ["--profile", "soft-arch-lydian", "--bars", "4"], ["--composer", "1", "--profile", "soft-arch-lydian"]]) {
      const result = run(dir, "generate", ...args);
      assert.equal(result.code, EXIT_USAGE, args.join(" "));
      assert.match(result.err, /Run "sidwave generate --help"/);
    }
    assert.match(run(dir, "generate", "--bars", "8").err, /need --composer 1/);
  } finally { done(); }
});

test("generate checks every output before it writes the first one", () => {
  const { dir, done } = sandbox();
  try {
    write(dir, "taken.sid", "keep");
    const refused = run(dir, "generate", "--seed", "4", "-o", "new.yaml", "--prg", "new.prg", "--sid", "taken.sid");
    assert.equal(refused.code, EXIT_USAGE);
    assert.match(refused.err, /taken\.sid exists/);
    assert.equal(fs.existsSync(path.join(dir, "new.yaml")), false, "no score was written");
    assert.equal(fs.existsSync(path.join(dir, "new.prg")), false, "no program was written");
    assert.equal(fs.readFileSync(path.join(dir, "taken.sid"), "utf8"), "keep");
    assert.equal(run(dir, "generate", "--seed", "4", "-o", "same", "--prg", "same").code, EXIT_USAGE, "two outputs with one name");
    // Character devices need no --force, and "-" is standard output for a binary.
    assert.equal(run(dir, "generate", "--seed", "4", "-o", "/dev/null").code, EXIT_OK);
    const bytes = [];
    const piped = runCli(["generate", "--seed", "4", "--prg", "-"], { cwd: dir, out: () => {}, err: () => {}, outBytes: (b) => bytes.push(Buffer.from(b)) });
    assert.equal(piped, EXIT_OK);
    assert.equal(Buffer.concat(bytes).length > 100, true);
    assert.equal(run(dir, "generate", "--seed", "4", "--prg", "-", "-o", "-").code, EXIT_USAGE);
  } finally { done(); }
});

test("generate checks output directories before writing any output", { skip: process.getuid?.() === 0 }, () => {
  const { dir, done } = sandbox();
  const ro = path.join(dir, "ro");
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o555);
  try {
    const result = run(dir, "generate", "--seed", "2", "-o", "g1.yaml", "--prg", "ro/x.prg");
    assert.equal(result.code, EXIT_INPUT);
    assert.equal(fs.existsSync(path.join(dir, "g1.yaml")), false, "score was not written");
    assert.match(result.err, /ro is not writable/);
    // A missing directory is created, as writeOutput does.
    assert.equal(run(dir, "generate", "--seed", "2", "-o", "newdir/sub/g.yaml").code, EXIT_OK);
    assert.equal(fs.existsSync(path.join(dir, "newdir", "sub", "g.yaml")), true);
    assert.equal(run(dir, "generate", "--seed", "2", "-o", "ro/deeper/g.yaml").code, EXIT_INPUT, "below a read-only directory");
  } finally {
    fs.chmodSync(ro, 0o755);
    done();
  }
});

test("unknown command suggestions prefer prefixes and list ambiguous matches", () => {
  assert.equal(unknownCommandMessage("gen", ["generate", "format"]), 'unknown command "gen"; did you mean generate?');
  assert.equal(unknownCommandMessage("tranform", ["transform", "format"]), 'unknown command "tranform"; did you mean transform?');
  assert.equal(unknownCommandMessage("co", ["compile", "compare", "complete", "convert"]), 'unknown command "co"; did you mean one of: compare, compile, complete, convert?');
  assert.equal(unknownCommandMessage("zzz", ["generate", "format"]), 'unknown command "zzz"');
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

test("an unknown command suggests the closest one", () => {
  assert.match(run(".", "tranform", "x").err, /unknown command "tranform"; did you mean transform\?/);
  assert.match(run(".", "mrege").err, /did you mean merge\?/);
  assert.match(run(".", "fromat").err, /did you mean format\?/);
  assert.match(run(".", "diif").err, /did you mean diff\?/);
  assert.doesNotMatch(run(".", "zzzzzzzz").err, /did you mean/);
  assert.equal(run(".", "tranform").code, EXIT_USAGE);
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
  assert.ok(fs.existsSync(binJs), `${binJs} is missing: run "npm run build" before the tests`);
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", RAW);
    const result = spawnSync(process.execPath, [binJs, "diff", "s.yaml", "s.yaml"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /semantically identical/);
    assert.equal(spawnSync(process.execPath, [binJs, "format", "s.yaml", "--check"], { cwd: dir }).status, 1);
  } finally { done(); }
});

// Cold process: node start-up, module loading and cold code paths, which the in-process budgets do not see. The CPU
// time of the finished child is read from /proc (Linux only; the resolution is 10 ms).
function childCpuMs() {
  const fields = fs.readFileSync("/proc/self/stat", "utf8").slice(fs.readFileSync("/proc/self/stat", "utf8").lastIndexOf(")") + 2).split(" ");
  return (Number(fields[13]) + Number(fields[14])) * 10;
}

test("the authoring commands start fast in a new process", { skip: process.platform !== "linux" && "needs /proc" }, () => {
  assert.ok(fs.existsSync(binJs), `${binJs} is missing: run "npm run build" before the tests`);
  const { dir, done } = sandbox();
  try {
    write(dir, "s.yaml", SCORE);
    write(dir, "t.yaml", withTempo(SCORE, 99));
    const cold = (...args) => {
      const before = childCpuMs();
      const result = spawnSync(process.execPath, [binJs, ...args], { cwd: dir, encoding: "utf8" });
      assert.ok(result.status === 0 || result.status === 1, `${args.join(" ")}: ${result.stderr}`);
      return childCpuMs() - before;
    };
    // Limits are about 2.2 times the CPU measured on a loaded 8-core machine (load average 14, 2026-11-27: 50, 140, 510, 680, 990, 990 and 320 ms); a regression to the old eager loading exceeds them.
    const cases = [
      [["--version"], 110], [["format", "--help"], 300], [["format", "s.yaml", "--check"], 1100], [["diff", "s.yaml", "t.yaml"], 1500],
      [["merge", "s.yaml", "t.yaml", "s.yaml"], 2200], [["transform", "s.yaml", "--tempo", "99"], 2200], [["generate", "--seed", "3"], 700],
    ];
    for (const [args, limit] of cases) {
      const used = Math.min(cold(...args), cold(...args));
      if (process.env.SIDWAVE_PERF_REPORT) console.log(`cold ${args.join(" ")}: ${used} ms CPU, limit ${limit}`);
      assert.ok(used <= limit, `sidwave ${args.join(" ")} used ${used} ms CPU in a new process, over ${limit} ms`);
    }
  } finally { done(); }
});
