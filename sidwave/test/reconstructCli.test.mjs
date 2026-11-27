import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { buildFixture } from "./helpers/reconstructFixtures.mjs";
import { buildScore } from "./helpers/reconstructRoundTrip.mjs";

function run(args, cwd) {
  const out = [];
  const err = [];
  const code = runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {} });
  return Promise.resolve(code).then((exit) => ({ exit, out: out.join(""), err: err.join("") }));
}

test("sidwave reconstruct writes a score, prints a summary and exits 0 when the round trip matches", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reconstruct-"));
  writeFileSync(join(dir, "tune.sid"), compileSidwaveBytes(parseSidwave(buildScore("basic", 1)), { format: "sid", loop: true }).bytes);
  const result = await run(["reconstruct", "tune.sid", "--seconds", "2", "-o", "score.yaml"], dir);
  assert.equal(result.exit, 0, result.err);
  assert.match(result.err, /0 differing calls in register-state classes/);
  const score = readFileSync(join(dir, "score.yaml"), "utf8");
  parseSidwave(score);
  const json = await run(["reconstruct", "tune.sid", "--seconds", "2", "--json"], dir);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "reconstruct");
  assert.equal(parsed.result.report.horizon.seconds, 2);
  assert.equal(parsed.result.report.strictExact, true);
  assert.equal(typeof parsed.result.score, "string");
});

test("sidwave reconstruct exit codes: 2 for usage, 3 for an unreadable or invalid input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reconstruct-"));
  assert.equal((await run(["reconstruct"], dir)).exit, 2);
  assert.equal((await run(["reconstruct", "a.sid", "--seconds", "0"], dir)).exit, 2);
  assert.equal((await run(["reconstruct", "a.sid", "--song", "x"], dir)).exit, 2);
  assert.equal((await run(["reconstruct", "missing.sid"], dir)).exit, 3);
  writeFileSync(join(dir, "bad.sid"), "not a sid file");
  assert.equal((await run(["reconstruct", "bad.sid"], dir)).exit, 3);
  const help = await run(["--help"], dir);
  assert.equal(help.exit, 0);
  assert.match(help.out, /sidwave reconstruct <file.sid>/);
});

test("a failed strict verdict exits 1 with ok:false and a result", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reconstruct-"));
  writeFileSync(join(dir, "fixture.sid"), buildFixture("pulseSweep").sid);
  const result = await run(["reconstruct", "fixture.sid", "--seconds", "3", "--json"], dir);
  assert.equal(result.exit, 1);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.report.strictExact, false);
});

test("invalid input is classified as input (exit 3) in the JSON envelope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reconstruct-"));
  writeFileSync(join(dir, "bad.sid"), "not a sid file");
  const result = await run(["reconstruct", "bad.sid", "--json"], dir);
  assert.equal(result.exit, 3);
  assert.equal(JSON.parse(result.out).error.category, "input");
});

test("--song outside the subtunes of the file is an input error (exit 3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reconstruct-"));
  writeFileSync(join(dir, "tune.sid"), compileSidwaveBytes(parseSidwave(buildScore("basic", 1)), { format: "sid", loop: true }).bytes);
  const result = await run(["reconstruct", "tune.sid", "--song", "2", "--json"], dir);
  assert.equal(result.exit, 3);
  assert.equal(JSON.parse(result.out).error.category, "input");
});
