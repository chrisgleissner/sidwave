// The command line of analyze, compare, isolate, preserve and extract-instruments.
import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { runCli, HELP } from "../src/cli.ts";
import { sharedEngine } from "./helpers/reconstructRoundTrip.mjs";
import { seededSid, seededText } from "./helpers/analyzeKit.mjs";

async function run(args, cwd) {
  const out = [];
  const err = [];
  const bytes = [];
  const exit = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: (b) => bytes.push(b), createEngine: (emulation) => (emulation === "sidlite" ? sharedEngine() : sharedEngine()) });
  return { exit, out: out.join(""), err: err.join(""), bytes };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-analyze-cli-"));
  writeFileSync(join(dir, "tune.sid"), seededSid("combined", 1));
  writeFileSync(join(dir, "a.yaml"), seededText("combined", 1));
  writeFileSync(join(dir, "b.yaml"), seededText("combined", 2));
  return dir;
}

test("help lists the five commands and their flags", () => {
  for (const word of ["sidwave analyze ", "sidwave compare ", "sidwave isolate ", "sidwave preserve ", "sidwave extract-instruments", "--include-original --rights-permitted", "preserve --verify"]) assert.ok(HELP.includes(word), word);
});

test("analyze: text and JSON for a score and for a SID file", { timeout: 120_000 }, async () => {
  const dir = workspace();
  const score = await run(["analyze", "a.yaml"], dir);
  assert.equal(score.exit, 0, score.err);
  assert.match(score.out, /Key \[inferred: Krumhansl/);
  assert.match(score.out, /Techniques: \d+/);
  const sid = await run(["analyze", "tune.sid", "--seconds", "2", "--json"], dir);
  assert.equal(sid.exit, 0, sid.err);
  const parsed = JSON.parse(sid.out);
  assert.equal(parsed.command, "analyze");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.report.schema, "sidwave-analysis/1");
  assert.equal(parsed.result.report.horizon.seconds, 2);
  assert.equal(parsed.result.report.source.kind, "sid");
});

test("compare: exit 0 for equal inputs, 1 for different inputs, with the ladder in the JSON", { timeout: 120_000 }, async () => {
  const dir = workspace();
  const same = await run(["compare", "tune.sid", "a.yaml", "--seconds", "2", "--level", "A0"], dir);
  assert.equal(same.exit, 0, same.err + same.out);
  assert.match(same.out, /F-diff: equal/);
  const different = await run(["compare", "a.yaml", "b.yaml", "--seconds", "2", "--level", "A0", "--json"], dir);
  assert.equal(different.exit, 1);
  const parsed = JSON.parse(different.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, undefined, "a failed verdict carries a result and no error");
  assert.equal(parsed.result.report.equal, false);
  assert.ok(parsed.result.report.musical.changes > 0);
  assert.equal((await run(["compare", "a.yaml", "b.yaml", "--seconds", "2", "--no-ladder", "--json"], dir)).exit, 1);
});

test("isolate writes a WAV and reports the method and the coupling", { timeout: 120_000 }, async () => {
  const dir = workspace();
  const r = await run(["isolate", "tune.sid", "--voice", "2", "--seconds", "2", "-o", "v2.wav"], dir);
  assert.equal(r.exit, 0, r.err);
  assert.match(r.out, /voice 2 alone, 2 s, method reconstruct-and-recompile, additive, reconstruction strictly exact/);
  assert.equal(readFileSync(join(dir, "v2.wav")).subarray(0, 4).toString(), "RIFF");
  const json = await run(["isolate", "tune.sid", "--voice", "1", "--mute", "--seconds", "2", "-o", "m.wav", "--json"], dir);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.result.mode, "mute");
  assert.deepEqual(parsed.result.silenced, [1]);
  assert.equal(parsed.result.method, "reconstruct-and-recompile");
  assert.equal(typeof parsed.result.coupling.nonAdditive, "boolean");
  const stdout = await run(["isolate", "tune.sid", "--voice", "3", "--seconds", "1", "-o", "-"], dir);
  assert.equal(stdout.bytes.length, 1);
  assert.equal(stdout.bytes[0].length > 44, true);
});

test("preserve writes a bundle, --verify checks it, and the original needs the rights assertion", { timeout: 180_000 }, async () => {
  const dir = workspace();
  const made = await run(["preserve", "tune.sid", "--seconds", "2", "--no-ladder", "-o", "bundle"], dir);
  assert.equal(made.exit, 0, made.err);
  assert.deepEqual(readdirSync(join(dir, "bundle")).sort(), ["preservation.json", "reconstruction-report.json", "score.yaml"]);
  assert.match(made.out, /redistribution: unknown/);
  const verified = await run(["preserve", "--verify", "bundle"], dir);
  assert.equal(verified.exit, 0, verified.out);
  assert.match(verified.out, /bundle: verified/);
  writeFileSync(join(dir, "bundle", "score.yaml"), `${readFileSync(join(dir, "bundle", "score.yaml"), "utf8")}\n# changed\n`);
  const broken = await run(["preserve", "--verify", "bundle", "--json"], dir);
  assert.equal(broken.exit, 1);
  assert.equal(JSON.parse(broken.out).ok, false);
  const refused = await run(["preserve", "tune.sid", "--include-original", "--seconds", "1", "-o", "x"], dir);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /--include-original needs --rights-permitted/);
  assert.equal(existsSync(join(dir, "x")), false, "nothing is written when the assertion is missing");
  const original = await run(["preserve", "tune.sid", "--include-original", "--rights-permitted", "--seconds", "2", "--no-ladder", "-o", "withsid"], dir);
  assert.equal(original.exit, 0, original.err);
  assert.ok(readdirSync(join(dir, "withsid")).includes("original.sid"));
  assert.equal((await run(["preserve", "tune.sid", "--rights-permitted", "-o", "y"], dir)).exit, 2);
  assert.equal((await run(["preserve", "tune.sid", "--stil", "STIL.txt", "-o", "z"], dir)).exit, 2);
});

test("extract-instruments writes a library file or prints it, for scores and SID files", { timeout: 120_000 }, async () => {
  const dir = workspace();
  const out = await run(["extract-instruments", "a.yaml", "-o", "lib.yaml", "--created", "2026-11-27", "--licence", "CC0-1.0", "--name", "my-lib"], dir);
  assert.equal(out.exit, 0, out.err);
  const lib = YAML.parse(readFileSync(join(dir, "lib.yaml"), "utf8"));
  assert.equal(lib.library.name, "my-lib");
  assert.equal(lib.library.licence, "CC0-1.0");
  assert.deepEqual(Object.keys(lib.instruments), ["lead1", "lead2", "lead3"]);
  const sid = await run(["extract-instruments", "tune.sid", "--seconds", "2", "--created", "2026-11-27"], dir);
  assert.equal(sid.exit, 0, sid.err);
  assert.match(sid.out, /^# SIDWave instrument library extracted by sidwave\. Source sid:/);
  assert.match(sid.err, /instruments in library extracted-/);
  assert.equal((await run(["extract-instruments", "a.yaml", "--name", "bad name"], dir)).exit, 3);
  assert.equal((await run(["extract-instruments", "a.yaml", "--json"], dir)).exit, 2);
});

test("isolate and extract-instruments do not overwrite an existing output without --force; preserve --stil reports a missing entry", { timeout: 120_000 }, async () => {
  const dir = workspace();
  writeFileSync(join(dir, "out.wav"), "keep");
  const refused = await run(["isolate", "tune.sid", "--voice", "1", "--seconds", "1", "-o", "out.wav"], dir);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /exists; use --force/);
  assert.equal(readFileSync(join(dir, "out.wav"), "utf8"), "keep");
  assert.equal((await run(["isolate", "tune.sid", "--voice", "1", "--seconds", "1", "-o", "out.wav", "--force"], dir)).exit, 0);
  assert.equal(readFileSync(join(dir, "out.wav")).subarray(0, 4).toString(), "RIFF");
  writeFileSync(join(dir, "lib.yaml"), "keep");
  assert.equal((await run(["extract-instruments", "a.yaml", "-o", "lib.yaml"], dir)).exit, 2);
  assert.equal(readFileSync(join(dir, "lib.yaml"), "utf8"), "keep");
  assert.equal((await run(["extract-instruments", "a.yaml", "-o", "lib.yaml", "--force", "--created", "2026-11-27"], dir)).exit, 0);
  writeFileSync(join(dir, "STIL.txt"), "/MUSICIANS/X/Y.sid\n  COMMENT: x\n");
  const stil = await run(["preserve", "tune.sid", "--seconds", "1", "--no-ladder", "--stil", "STIL.txt", "--stil-path", "/MUSICIANS/A/B.sid", "-o", "st"], dir);
  assert.match(stil.err, /warning: no STIL entry for/);
  const tooBig = await run(["preserve", "tune.sid", "--seconds", "1", "--stil", "STIL.txt", "--stil-path", "/A.sid", "--max-bytes", "5", "-o", "st2"], dir);
  assert.equal(tooBig.exit, 5);
});

test("usage and input errors have their own exit codes", async () => {
  const dir = workspace();
  assert.equal((await run(["analyze"], dir)).exit, 2);
  assert.equal((await run(["analyze", "a.yaml", "b.yaml"], dir)).exit, 2);
  assert.equal((await run(["analyze", "missing.sid"], dir)).exit, 3);
  assert.equal((await run(["compare", "a.yaml"], dir)).exit, 2);
  assert.equal((await run(["isolate", "tune.sid"], dir)).exit, 2);
  assert.equal((await run(["isolate", "tune.sid", "--voice", "0"], dir)).exit, 2);
  assert.equal((await run(["isolate", "tune.sid", "--voice", "9"], dir)).exit, 2);
  assert.equal((await run(["isolate", "a.yaml", "--voice", "1"], dir)).exit, 2);
  assert.equal((await run(["isolate", "tune.sid", "--voice", "1", "--song", "4"], dir)).exit, 3);
  assert.equal((await run(["validate", "a.yaml", "--voice", "1"], dir)).exit, 2, "--voice applies to isolate only");
  assert.equal((await run(["analyze", "a.yaml", "--verify"], dir)).exit, 2);
  assert.equal((await run(["analyze", "a.yaml", "-o", "x"], dir)).exit, 2);
  const json = await run(["analyze", "missing.sid", "--json"], dir);
  assert.equal(JSON.parse(json.out).error.category, "input");
});
