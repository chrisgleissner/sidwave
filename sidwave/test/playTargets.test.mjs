import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibsidplayfpEngine } from "../src/engine/libsidplayfp.ts";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveBytes, confinedReadOptions, readExampleScore } from "../src/sidwaveOps.ts";
import { buildPlayTune } from "../src/play/source.ts";
import { findAudioPlayer, startLocalPlayback } from "../src/play/local.ts";
import { findVice, startVicePlayback, viceArguments } from "../src/play/vice.ts";
import { startUltimatePlayback, ultimateBaseUrl, ultimatePlay } from "../src/play/ultimate.ts";
import { openPlayTarget } from "../src/play/session.ts";
import { liveChildCount } from "../src/play/children.ts";
import { fakePrograms, fakeUltimate, sandbox, within } from "./helpers/playKit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const score = () => parseSidwave(readExampleScore("chiptune_drive"), confinedReadOptions(root));
const sid = new Uint8Array(compileSidwaveBytes(score(), { format: "sid" }).bytes);
const engine = createLibsidplayfpEngine({ emulation: "sidlite" });
const RATE = 8000;

async function withPrograms(body) {
  const box = sandbox();
  const programs = await fakePrograms(box.dir);
  try { await body(programs, box); } finally { await programs.close(); box.done(); }
}

test("a streamed render delivers the samples of a render and waits for its consumer", async () => {
  const request = { sid, seconds: 0.7, sampleRate: RATE };
  const whole = await engine.render(request);
  const parts = [];
  let busy = false;
  const streamed = await engine.render({
    ...request,
    onSamples: async (samples) => {
      assert.equal(busy, false, "no slice arrives while the consumer works");
      busy = true;
      await new Promise((resolve) => setImmediate(resolve));
      parts.push(...samples);
      busy = false;
    },
  });
  assert.equal(streamed.samples.length, 0);
  assert.equal(streamed.seconds, whole.seconds);
  assert.deepEqual(parts, [...whole.samples]);
  await assert.rejects(engine.render({ ...request, onSamples: () => { throw new Error("consumer broke"); } }), /consumer broke/);
});

test("the local target sends the render to the player and ends when the player has it", async () => {
  await withPrograms(async (programs) => {
    const player = findAudioPlayer(programs.program("myplayer", "player"));
    assert.equal(player.input, "wav");
    const playback = startLocalPlayback({ sid, seconds: 0.5, skipSeconds: 0.25, sampleRate: RATE, engine, player });
    await within(playback.started, "the start");
    const end = await programs.event("end");
    await within(playback.done, "the end");
    await end.run.exited;
    const data = Buffer.from(end.data, "base64");
    assert.equal(data.subarray(0, 4).toString(), "RIFF");
    assert.equal(data.readUInt32LE(24), RATE);
    const expected = (await engine.render({ sid, seconds: 0.75, sampleRate: RATE })).samples.subarray(0.25 * RATE);
    assert.deepEqual(data.subarray(44), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
    assert.equal(liveChildCount(), 0);
    await playback.stop();
  });
});

test("known players get raw PCM with their own arguments", async () => {
  await withPrograms(async (programs, box) => {
    programs.program("bin/aplay", "player");
    programs.program("bin/mpv", "player");
    const env = { PATH: path.join(box.dir, "bin") };
    const player = findAudioPlayer(undefined, { env });
    assert.equal(player.name, "aplay");
    assert.equal(findAudioPlayer("mpv", { env }).input, "wav");
    assert.equal(findAudioPlayer(undefined, { env: { ...env, SIDWAVE_PLAYER: "mpv" } }).name, "mpv");
    const playback = startLocalPlayback({ sid, seconds: 0.2, sampleRate: RATE, engine, player });
    const start = await programs.start();
    assert.deepEqual(start.args.slice(0, 6), ["-q", "-t", "raw", "-f", "S16_LE", "-r"]);
    assert.equal(start.args[6], String(RATE));
    assert.equal((await programs.event("end")).bytes, 0.2 * RATE * 2);
    await within(playback.done, "the end");
    assert.throws(() => findAudioPlayer(undefined, { env: { PATH: box.dir } }), /no audio player found on PATH \(looked for paplay/);
    assert.throws(() => findAudioPlayer("nothing-here", { env }), /was not found or is not executable/);
  });
});

test("stop ends a player that no longer reads, also one that ignores SIGTERM", async () => {
  await withPrograms(async (programs) => {
    for (const mode of ["slow", "stubborn"]) {
      const playback = startLocalPlayback({ sid, seconds: 600, sampleRate: 48_000, engine, player: findAudioPlayer(programs.program(mode, mode)) });
      const run = await programs.start();
      await within(playback.started, "the start");
      await within(playback.stop(), `the stop of a ${mode} player`);
      await within(run.exited, "the end of the process");
      await within(playback.done, "done after stop");
      assert.equal(liveChildCount(), 0);
    }
  });
});

test("a player that fails is reported with its message; a player the user closes is not", async () => {
  await withPrograms(async (programs) => {
    const failing = startLocalPlayback({ sid, seconds: 600, sampleRate: RATE, engine, player: findAudioPlayer(programs.program("broken", "fail")) });
    await assert.rejects(within(failing.done, "the failure"), /audio player broken exited with status 3: no sound device/);
    await failing.stop();
    const quit = startLocalPlayback({ sid, seconds: 600, sampleRate: RATE, engine, player: findAudioPlayer(programs.program("quitter", "quit")) });
    await within(quit.done, "the end");
    await quit.stop();
    assert.equal(liveChildCount(), 0);
  });
});

test("an engine that cannot load stops the player and reports the cause", async () => {
  await withPrograms(async (programs) => {
    const broken = createLibsidplayfpEngine({ emulation: "sidlite", importModule: () => Promise.reject(new Error("gone")) });
    const playback = startLocalPlayback({ sid, seconds: 1, engine: broken, player: findAudioPlayer(programs.program("p", "stubborn")) });
    await assert.rejects(within(playback.started, "the failure"), /libsidplayfp-wasm/);
    await assert.rejects(playback.done, /libsidplayfp-wasm/);
    await playback.stop();
    assert.equal(liveChildCount(), 0);
  });
});

test("VICE gets the SID file for vsid and the PRG with the machine settings for x64sc", () => {
  const sidArgs = viceArguments({ program: { command: "vsid", mode: "sid" }, bytes: sid, song: 2, extraArgs: ["-sounddev", "dummy"] }, "/t/tune.sid");
  assert.deepEqual(sidArgs, ["+saveres", "+warp", "-console", "-tune", "2", "-sounddev", "dummy", "/t/tune.sid"]);
  const prgArgs = viceArguments({ program: { command: "x64sc", mode: "prg" }, bytes: sid, clock: "NTSC", sids: [{ address: 0xd400, model: "8580" }, { address: 0xd420 }] }, "/t/tune.prg");
  assert.deepEqual(prgArgs, ["+saveres", "+warp", "-console", "-ntsc", "-sidenginemodel", "257", "-sidextra", "1", "-sid2address", "0xd420", "-autostartprgmode", "1", "-autostart", "/t/tune.prg"]);
});

test("VICE is chosen from PATH, from --vice or SIDWAVE_VICE", async () => {
  await withPrograms(async (programs, box) => {
    const vsid = programs.program("bin/vsid", "vice");
    const x64sc = programs.program("bin/x64sc", "vice");
    const env = { PATH: path.join(box.dir, "bin") };
    assert.deepEqual(findVice(undefined, { sid: true, prg: true }, { env }), { command: vsid, mode: "sid" });
    assert.deepEqual(findVice(undefined, { sid: false, prg: true }, { env }), { command: x64sc, mode: "prg" });
    assert.deepEqual(findVice("x64sc", { sid: true, prg: true }, { env }), { command: x64sc, mode: "prg" });
    assert.deepEqual(findVice(undefined, { sid: true, prg: true }, { env: { ...env, SIDWAVE_VICE: x64sc } }), { command: x64sc, mode: "prg" });
    assert.throws(() => findVice("x64sc", { sid: true, prg: false }, { env }), /runs PRG files and a SID file is not one/);
    assert.throws(() => findVice("vsid", { sid: false, prg: true }, { env }), /plays SID files/);
    assert.throws(() => findVice("none", { sid: true, prg: true }, { env }), /was not found/);
    assert.throws(() => findVice(undefined, { sid: true, prg: false }, { env: { PATH: box.dir } }), /no VICE program found on PATH \(looked for vsid, x64sid\)/);
  });
});

test("VICE runs on a temporary file and is ended by stop, also when it ignores SIGTERM", async () => {
  await withPrograms(async (programs) => {
    for (const mode of ["vice", "vice-stubborn"]) {
      const playback = startVicePlayback({ program: { command: programs.program(`${mode}-vsid`, mode), mode: "sid" }, bytes: sid });
      const run = await programs.start();
      const file = run.args.at(-1);
      assert.deepEqual(Buffer.from(run.tune, "base64"), Buffer.from(sid));
      await within(playback.started, "the start");
      assert.ok(fs.existsSync(file));
      await within(playback.stop(), "stop");
      await within(playback.done, "done");
      await within(run.exited, "the end of the process");
      assert.equal(fs.existsSync(path.dirname(file)), false, "the temporary directory is removed");
      await playback.stop();
      assert.equal(liveChildCount(), 0);
    }
  });
});

test("VICE is ended after the length of the tune", async () => {
  await withPrograms(async (programs) => {
    const playback = startVicePlayback({ program: { command: programs.program("vsid", "vice"), mode: "sid" }, bytes: sid, seconds: 0.05, startupSeconds: 0 });
    await within(playback.done, "the end after the length");
    assert.equal(liveChildCount(), 0);
  });
});

test("VICE that fails is reported with its output; VICE that the user closes ends playback", async () => {
  await withPrograms(async (programs, box) => {
    const failing = startVicePlayback({ program: { command: programs.program("vsid", "vice-fail"), mode: "sid" }, bytes: sid });
    await assert.rejects(within(failing.done, "the failure"), /vsid exited with status 3: no sound device/);
    await failing.stop();
    const closed = startVicePlayback({ program: { command: programs.program("vsid2", "vice-quit"), mode: "sid" }, bytes: sid });
    await within(closed.done, "the end");
    const missing = startVicePlayback({ program: { command: path.join(box.dir, "gone"), mode: "sid" }, bytes: sid });
    await assert.rejects(within(missing.started, "the failure"), /could not be started/);
    await missing.stop();
    assert.equal(liveChildCount(), 0);
  });
});

test("the Ultimate target uploads a SID file with the song and password, and resets when it stops", async () => {
  const server = await fakeUltimate();
  try {
    const device = { host: server.host, password: "secret-pw" };
    const playback = startUltimatePlayback({ device, tune: { kind: "sid", bytes: sid, song: 2 } });
    await within(playback.started, "the upload");
    const upload = await server.requests.next();
    assert.deepEqual([upload.method, upload.url, upload.headers["x-password"]], ["POST", "/v1/runners:sidplay?songnr=2", "secret-pw"]);
    assert.match(upload.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(Number(upload.headers["content-length"]), upload.body.length);
    assert.match(upload.body.toString("latin1"), /name="file"; filename="upload\.sid"/);
    assert.ok(upload.body.includes(Buffer.from(sid)));
    assert.equal(server.requests.all.length, 1);
    await within(playback.stop(), "the reset");
    const reset = await server.requests.next();
    assert.deepEqual([reset.method, reset.url, reset.headers["x-password"]], ["PUT", "/v1/machine:reset", "secret-pw"]);
    await playback.stop();
    await playback.done;
    assert.equal(server.requests.all.length, 2, "one reset only");
  } finally { await server.close(); }
});

test("the Ultimate target runs a PRG, leaves the machine alone on replace and detach, and resets after the length", async () => {
  const server = await fakeUltimate();
  try {
    const device = { host: server.host };
    const prg = Uint8Array.of(1, 8, 0, 0);
    const replaced = startUltimatePlayback({ device, tune: { kind: "prg", bytes: prg } });
    await replaced.started;
    await replaced.stop("replace");
    const run = await server.requests.next();
    assert.deepEqual([run.method, run.url, run.headers["content-type"], run.headers["x-password"]], ["POST", "/v1/runners:run_prg", "application/octet-stream", undefined]);
    assert.deepEqual(run.body, Buffer.from(prg));
    const detached = startUltimatePlayback({ device, tune: { kind: "sid", bytes: sid }, detach: true });
    await within(detached.done, "done after the upload");
    await detached.stop();
    assert.deepEqual(server.requests.all.map((r) => r.url), ["/v1/runners:run_prg", "/v1/runners:sidplay"]);
    const timed = startUltimatePlayback({ device, tune: { kind: "sid", bytes: sid }, seconds: 0.01 });
    await within(timed.done, "the reset after the length");
    assert.equal(server.requests.all.at(-1).url, "/v1/machine:reset");
    await timed.stop();
    assert.equal(server.requests.all.length, 4, "stop after the length sends no second reset");
  } finally { await server.close(); }
});

test("Ultimate failures name the host and the cause and never the password", async () => {
  const replies = {
    forbidden: { status: 403, body: { errors: ["bad secret-pw"] } },
    errors: { status: 200, body: { errors: ["Unknown SID", "secret-pw"] } },
    broken: { status: 500, body: "oops" },
    redirect: { status: 302, body: "", headers: { location: "http://127.0.0.1:9/elsewhere" } },
  };
  let mode;
  const server = await fakeUltimate(() => replies[mode]);
  try {
    const patterns = { forbidden: /refused the request \(HTTP 403\); set SIDWAVE_U64_PASSWORD/, errors: /failed: Unknown SID; <password>/, broken: /returned HTTP 500/, redirect: /returned HTTP 302/ };
    for (mode of Object.keys(replies)) {
      const playback = startUltimatePlayback({ device: { host: server.host, password: "secret-pw" }, tune: { kind: "sid", bytes: sid } });
      const error = await playback.started.then(() => assert.fail("should fail"), (e) => e);
      assert.match(error.message, patterns[mode]);
      assert.ok(error.message.startsWith(server.host));
      assert.doesNotMatch(JSON.stringify([error.message, error.details]), /secret-pw/);
      await playback.stop();
    }
    assert.equal(server.requests.all.length, 4, "no reset after a failed upload, and the redirect is not followed");
    await assert.rejects(ultimatePlay({ host: "127.0.0.1:1" }, { kind: "sid", bytes: sid }), /127\.0\.0\.1:1: POST \/v1\/runners:sidplay failed/);
  } finally { await server.close(); }
});

test("stopping during an upload that does not answer cancels it and resets", async () => {
  const server = await fakeUltimate((request) => (request.url.startsWith("/v1/runners") ? "hang" : { status: 200, body: { errors: [] } }));
  try {
    const playback = startUltimatePlayback({ device: { host: server.host }, tune: { kind: "sid", bytes: sid } });
    await server.requests.next();
    await within(playback.stop(), "stop");
    await playback.done;
    assert.equal(server.requests.all.at(-1).url, "/v1/machine:reset");
    await assert.rejects(ultimatePlay({ host: server.host, timeoutMs: 50 }, { kind: "sid", bytes: sid }), /no answer within 0\.05 s/);
  } finally { await server.close(); }
});

test("only a plain host name or address is accepted for the Ultimate", () => {
  for (const host of ["u64", "192.168.1.20", "u64.local:8080", "[fe80::1]", "[::1]:80"]) assert.equal(ultimateBaseUrl(host), `http://${host}`);
  for (const host of ["", "http://u64", "u64/path", "user@u64", "u64?x=1", "u64#a", "a b", "u64:port", "-u64"]) assert.throws(() => ultimateBaseUrl(host), /--host needs/);
});

test("a target is checked when it is opened and plays a tune with the right length", async () => {
  await withPrograms(async (programs, box) => {
    const tune = buildPlayTune({ kind: "score", format: "sidwave", doc: score(), notes: [] }, { target: "local" });
    assert.throws(() => openPlayTarget({ kind: "local", player: "none" }, box.dir), /was not found/);
    assert.throws(() => openPlayTarget({ kind: "vice", vice: "none" }, box.dir), /was not found/);
    assert.throws(() => openPlayTarget({ kind: "u64", device: { host: "a/b" } }, box.dir), /--host needs/);
    const local = openPlayTarget({ kind: "local", player: programs.program("p", "player"), sampleRate: RATE, emulation: "sidlite" }, box.dir);
    const playback = local.play({ ...tune, seconds: 0.5, skipSeconds: 0.25 });
    const end = await programs.event("end");
    assert.equal(end.bytes - 44, 0.5 * RATE * 2, "one pass from --from-bar, with the quarter second of tail");
    await playback.stop();
    assert.throws(() => local.play({ ...tune, sid: undefined, sidUnavailable: "too many SIDs" }), /cannot play this tune: too many SIDs/);
    const server = await fakeUltimate();
    try {
      const u64 = openPlayTarget({ kind: "u64", device: { host: server.host }, detach: true }, box.dir);
      await u64.play({ ...tune, sid: undefined }).done;
      assert.equal((await server.requests.next()).url, "/v1/runners:run_prg");
    } finally { await server.close(); }
  });
});
