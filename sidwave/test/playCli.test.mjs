import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "../src/cli.ts";
import { readExampleScore, compileSidwaveBytes } from "../src/sidwaveOps.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { eventQueue, fakePrograms, fakeUltimate, sandbox, within } from "./helpers/playKit.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binJs = path.join(packageRoot, "dist", "bin.js");
const SCORE = readExampleScore("chiptune_drive");
const SID = compileSidwaveBytes(parseSidwave(SCORE), { format: "sid" }).bytes;

async function world(body) {
  const box = sandbox("sidwave-play-cli-");
  const programs = await fakePrograms(box.dir);
  // Whatever a test leaves running when it fails is ended here, so that a failure never hangs the run.
  const stop = new AbortController();
  const children = [];
  // A command that wrongly gets as far as playing finds these instead of the player and VICE of the system.
  const saved = { SIDWAVE_PLAYER: process.env.SIDWAVE_PLAYER, SIDWAVE_VICE: process.env.SIDWAVE_VICE };
  process.env.SIDWAVE_PLAYER = programs.program("unwanted/player", "fail");
  process.env.SIDWAVE_VICE = programs.program("unwanted/vsid", "vice-fail");
  try {
    box.write("song.yaml", SCORE);
    box.write("tune.sid", SID);
    await body({ box, programs, stop, children, player: programs.program("player", "player"), listener: programs.program("listener", "slow") });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    stop.abort();
    for (const child of children) child.kill("SIGKILL");
    await programs.close();
    box.done();
  }
}

/** Runs the command line in this process. */
function cli(cwd, args, { signal } = {}) {
  const out = eventQueue(), err = eventQueue();
  const done = Promise.resolve(runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t), outBytes: () => {}, ...(signal ? { signal } : {}) }));
  return { done: within(done, `sidwave ${args.join(" ")}`).then((code) => ({ code, out: out.all.join(""), err: err.all.join("") })), out, err };
}

test("play and watch are listed and explain themselves with examples", async () => {
  const main = await cli(".", ["--help"]).done;
  assert.match(main.out, /sidwave play\s+<file> \[--target local\|vice\|u64\]/);
  assert.match(main.out, /sidwave watch\s+<score>/);
  for (const [command, flags] of [["play", ["--from-bar", "--loop-section", "--solo", "--mute", "--song", "--detach", "SIDWAVE_U64_PASSWORD"]], ["watch", ["--loop-section", "--no-play", "--debounce", "--target vice"]]]) {
    const help = await cli(".", [command, "--help"]).done;
    assert.equal(help.code, 0);
    assert.match(help.out, /Examples:\n\s+sidwave /);
    for (const flag of flags) assert.ok(help.out.includes(flag), `${command}: ${flag}`);
  }
  const unknown = await cli(".", ["plya"]).done;
  assert.match(unknown.err, /did you mean play\?/);
});

test("wrong options are usage errors that name the fix", async () => {
  await world(async ({ box, programs, player }) => {
    const cases = [
      [["play"], /play needs exactly one file/],
      [["play", "a", "b"], /exactly one file/],
      [["play", "song.yaml", "--target", "c64"], /--target must be one of local, vice, u64/],
      [["play", "song.yaml", "--host", "u64"], /--host applies to --target u64 only/],
      [["play", "song.yaml", "--detach"], /--detach applies to --target u64 only/],
      [["play", "song.yaml", "--target", "u64"], /--target u64 needs --host/],
      [["play", "song.yaml", "--target", "u64", "--host", "http://x"], /--host needs a host name/],
      [["play", "song.yaml", "--target", "u64", "--host", "x", "--detach", "--seconds", "3"], /--seconds does not apply/],
      [["play", "song.yaml", "--target", "vice", "--player", "x"], /--player applies to --target local only/],
      [["play", "song.yaml", "--vice", "x"], /--vice applies to --target vice only/],
      [["play", "song.yaml", "--solo", "1", "--mute", "2"], /--solo or --mute, not both/],
      [["play", "song.yaml", "--solo", ","], /--solo needs voice ids/],
      [["play", "song.yaml", "--from-bar", "2", "--loop-section", "a"], /--from-bar or --loop-section/],
      [["play", "song.yaml", "--loop", "--no-loop"], /--loop or --no-loop/],
      [["play", "song.yaml", "--loop-section", "a", "--no-loop"], /leave out --no-loop/],
      [["play", "song.yaml", "--seconds", "0"], /--seconds needs a number above 0/],
      [["play", "song.yaml", "--from-bar", "0"], /--from-bar needs a whole number/],
      [["play", "song.yaml", "--model", "6502", "--player", player], /--model must be one of/],
      [["play", "song.yaml", "--bogus"], /unknown option --bogus/],
      [["watch"], /watch needs exactly one score file/],
      [["watch", "song.yaml", "--seconds", "1"], /unknown option --seconds/],
      [["watch", "song.yaml", "--allow-dir", "--no-play"], /--allow-dir needs a value, not the option --no-play/],
      [["watch", "song.yaml", "--vice-arg", "--no-play", "--target", "vice"], /--vice-arg needs a value/],
      [["play", "song.yaml", "--solo", "--help-me"], /--solo needs a value/],
    ];
    for (const [args, message] of cases) {
      const result = await cli(box.dir, args).done;
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.err, message);
      assert.match(result.err, new RegExp(`sidwave ${args[0]} --help`));
    }
    assert.equal(programs.starts().length, 0, "nothing was started");
  });
});

test("input problems exit 3, a missing player or VICE exits 4", async () => {
  await world(async ({ box, programs, player }) => {
    box.write("bad.yaml", SCORE.replace(/^tempo:.*$/m, "tempo: fast"));
    box.write("junk.bin", "junk");
    for (const [args, code, message] of [
      [["play", "none.yaml", "--player", player], 3, /cannot read none\.yaml/],
      [["play", "bad.yaml", "--player", player], 3, /^bad\.yaml: Invalid SIDWAVE at \$\.tempo/],
      [["play", "junk.bin", "--player", player], 3, /cannot tell the format of junk\.bin/],
      [["play", "tune.sid", "--solo", "1", "--player", player], 2, /--solo needs a score/],
      [["play", "song.yaml", "--song", "3", "--player", player], 3, /the score has one song/],
      [["play", "song.yaml", "--player", "no-such-player"], 4, /audio player "no-such-player" was not found/],
      [["play", "song.yaml", "--target", "vice", "--vice", "no-such-vice"], 4, /VICE program "no-such-vice" was not found/],
      [["watch", "none.yaml", "--no-play"], 3, /cannot read none\.yaml/],
      [["watch", "tune.sid", "--no-play"], 3, /watch needs a SIDWave score/],
    ]) {
      const result = await cli(box.dir, args).done;
      assert.equal(result.code, code, `${args.join(" ")}: ${result.err}`);
      assert.match(result.err, message);
    }
    assert.equal(programs.starts().length, 0, "nothing was started");
    const json = await cli(box.dir, ["play", "none.yaml", "--player", player, "--json"]).done;
    assert.deepEqual(JSON.parse(json.out).error.category, "input");
  });
});

test("play renders a score to the player and reports the result", async () => {
  await world(async ({ box, programs, player }) => {
    const run = await cli(box.dir, ["play", "song.yaml", "--player", player, "--seconds", "0.2", "--rate", "8000", "--engine", "sidlite", "--solo", "1,2", "--json"]).done;
    assert.equal(run.code, 0, run.err);
    const { ok, result } = JSON.parse(run.out);
    assert.deepEqual([ok, result.target, result.format, result.ended, result.seconds, result.startBar], [true, "local", "sidwave", "finished", 0.2, 1]);
    assert.equal((await programs.event("end")).bytes, 44 + 3200);
    const text = await cli(box.dir, ["play", "tune.sid", "--player", player, "--seconds", "0.1", "--engine", "sidlite"]).done;
    assert.equal(text.code, 0);
    assert.match(text.err, /playing tune\.sid on local audio through player: Neon Run, 0\.1 s \(Ctrl-C stops\)/);
    assert.equal(text.out, "");
    await within(Promise.all(programs.starts().map((start) => start.exited)), "the end of the players");
  });
});

test("an interrupt stops the playback and exits 0", async () => {
  await world(async ({ box, programs, listener, stop }) => {
    const run = cli(box.dir, ["play", "song.yaml", "--player", listener, "--loop", "--json"], { signal: stop.signal });
    const start = await programs.start();
    await programs.event("audio");
    stop.abort();
    const result = await run.done;
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).result.ended, "interrupted");
    await within(start.exited, "the end of the player");
  });
});

test("the password of the Ultimate comes from the environment and is not printed", async () => {
  await world(async ({ box }) => {
    const server = await fakeUltimate((request) => (request.url.includes("sidplay") && request.headers["x-password"] !== "pw-123" ? { status: 403, body: {} } : { status: 200, body: { errors: [] } }));
    const before = process.env.SIDWAVE_U64_PASSWORD;
    try {
      process.env.SIDWAVE_U64_PASSWORD = "pw-wrong";
      const refused = await cli(box.dir, ["play", "song.yaml", "--target", "u64", "--host", server.host, "--json"]).done;
      assert.equal(refused.code, 4);
      assert.doesNotMatch(refused.out + refused.err, /pw-wrong/);
      process.env.SIDWAVE_U64_PASSWORD = "pw-123";
      const played = await cli(box.dir, ["play", "song.yaml", "--target", "u64", "--host", server.host, "--seconds", "0.05"]).done;
      assert.equal(played.code, 0, played.err);
      assert.doesNotMatch(played.out + played.err, /pw-123/);
      assert.deepEqual(server.requests.all.map((r) => r.url), ["/v1/runners:sidplay", "/v1/runners:sidplay", "/v1/machine:reset"]);
      const detached = await cli(box.dir, ["play", "tune.sid", "--target", "u64", "--host", server.host, "--detach", "--song", "1"]).done;
      assert.equal(detached.code, 0, detached.err);
      assert.equal(server.requests.all.length, 4);
    } finally {
      if (before === undefined) delete process.env.SIDWAVE_U64_PASSWORD; else process.env.SIDWAVE_U64_PASSWORD = before;
      await server.close();
    }
  });
});

test("watch --no-play prints places and exits 3 when the last version is invalid, 0 when it is valid", async () => {
  await world(async ({ box, stop: whole }) => {
    box.write("bad.yaml", SCORE.replace(/^tempo:.*$/m, "tempo: fast"));
    const controller = () => {
      const own = new AbortController();
      whole.signal.addEventListener("abort", () => own.abort());
      return own;
    };
    for (const [file, code, wanted] of [["bad.yaml", 3, /\] error bad\.yaml:\d+:\d+: Invalid SIDWAVE at \$\.tempo/], ["song.yaml", 0, /\] ok: Neon Run, 3 voices, 1 SID, \d+ lint findings?[^\n]*\n\s+song\.yaml:\d+:\d+: [A-Z-]+: /]]) {
      const stop = controller();
      const run = cli(box.dir, ["watch", file, "--no-play"], { signal: stop.signal });
      await run.out.next(() => true, "the first report");
      stop.abort();
      const result = await run.done;
      assert.equal(result.code, code, result.out);
      assert.match(result.out, wanted);
      assert.match(result.err, /watching .*checking only.*Ctrl-C stops/);
    }
    const stop = controller();
    const run = cli(box.dir, ["watch", "bad.yaml", "--no-play", "--json"], { signal: stop.signal });
    await run.out.next((line) => line.includes('"error"'), "the error event");
    stop.abort();
    const lines = (await run.done).out.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual([lines[0].type, lines[0].path, typeof lines[0].line], ["error", "$.tempo", "number"]);
    assert.deepEqual([lines.at(-1).command, lines.at(-1).result.errors, lines.at(-1).result.ok], ["watch", 1, false]);
  });
});

test("watch plays through the command line and stops the player when interrupted", async () => {
  await world(async ({ box, programs, listener, stop }) => {
    // The example has an `end` and plays once; without it the watch loops it.
    box.write("song.yaml", SCORE.replace(/^end:.*$/m, ""));
    const run = cli(box.dir, ["watch", "song.yaml", "--player", listener, "--debounce", "20"], { signal: stop.signal });
    const first = await programs.start();
    await run.out.next((line) => line.includes("playing on local audio through listener, looping"), "playing");
    fs.writeFileSync(path.join(box.dir, "song.yaml"), SCORE.replace(/^end:.*$/m, "").replace(/^tempo: *\d+/m, "tempo: 99"));
    const second = await programs.start();
    await within(first.exited, "the end of the replaced player");
    await run.out.next((line) => /playing on .* s after the change/.test(line), "playing again");
    stop.abort();
    assert.equal((await run.done).code, 0);
    await within(second.exited, "the end of the player");
  });
});

/** Starts the built command and waits for a line of output. */
function command(cwd, args, children) {
  const child = spawn(process.execPath, [binJs, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines = eventQueue();
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => lines.push(String(data)));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited: within(exited, "the end of sidwave"), line: (pattern) => lines.next((text) => pattern.test(text), String(pattern)) };
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} ends play, its player and exits 0`, { skip: process.platform === "win32" && "no POSIX signals" }, async () => {
    assert.ok(fs.existsSync(binJs), `${binJs} is missing: run "npm run build" before the tests`);
    await world(async ({ box, programs, listener, children }) => {
      const run = command(box.dir, ["play", "tune.sid", "--player", listener], children);
      const player = await programs.start();
      await run.line(/playing tune\.sid/);
      run.child.kill(signal);
      assert.deepEqual(await run.exited, { code: 0, signal: null });
      await within(player.exited, "the end of the player");
    });
  });
}

test("SIGTERM ends watch and its VICE and removes the temporary files", { skip: process.platform === "win32" && "no POSIX signals" }, async () => {
  await world(async ({ box, programs, children }) => {
    const vice = programs.program("vsid", "vice-stubborn");
    const run = command(box.dir, ["watch", "song.yaml", "--target", "vice", "--vice", vice], children);
    const emulator = await programs.start();
    await run.line(/playing on VICE \(vsid\)/);
    assert.ok(fs.existsSync(emulator.args.at(-1)));
    run.child.kill("SIGTERM");
    assert.equal((await run.exited).code, 0);
    await within(emulator.exited, "the end of VICE");
    assert.equal(fs.existsSync(path.dirname(emulator.args.at(-1))), false);
  });
});

test("a process that exits without stopping the playback takes its children with it", async () => {
  await world(async ({ box, programs, children }) => {
    const vice = programs.program("vsid", "vice-stubborn");
    const module = pathToFileURL(path.join(packageRoot, "dist", "play", "index.js")).href;
    box.write("exit.mjs", [
      `import { startVicePlayback } from ${JSON.stringify(module)};`,
      "import fs from 'node:fs';",
      `const playback = startVicePlayback({ program: { command: ${JSON.stringify(vice)}, mode: "sid" }, bytes: fs.readFileSync("tune.sid") });`,
      "await playback.started;",
      "process.stdin.once('data', () => process.exit(7));",
    ].join("\n"));
    const child = spawn(process.execPath, [path.join(box.dir, "exit.mjs")], { cwd: box.dir, stdio: ["pipe", "ignore", "inherit"] });
    children.push(child);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const emulator = await programs.start();
    child.stdin.end("go");
    assert.equal(await within(exited, "the exit"), 7);
    await within(emulator.exited, "the end of VICE");
    assert.equal(fs.existsSync(path.dirname(emulator.args.at(-1))), false);
  });
});

test("the built command starts play and watch", () => {
  for (const name of ["play", "watch"]) {
    const result = spawnSync(process.execPath, [binJs, name, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^sidwave ${name}:`));
  }
});
