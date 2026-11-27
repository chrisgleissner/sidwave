import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { watchScore } from "../src/play/watch.ts";
import { readExampleScore } from "../src/sidwaveOps.ts";
import { eventQueue, sandbox, sleep, within } from "./helpers/playKit.mjs";

const SCORE = [
  "sidwave: 1.2", "title: Watched", "tempo: 120",
  "voices:", "  - id: 1", "    patterns:", "      A: { groove: [C4, E4], length: 2 }",
  "sections:", "  one: { layers: { v1: A } }", "  two: { layers: { v1: A } }",
  "timeline: [one, two]", "",
].join("\n");
const withTempo = (tempo) => SCORE.replace("tempo: 120", `tempo: ${tempo}`);

/** A target that records what it was asked to play. `behaviour(n)` returns an error for the nth tune that must fail. */
function fakeTarget(behaviour = () => undefined) {
  const log = [];
  const played = [];
  return {
    log, played,
    play(tune) {
      const n = played.length + 1;
      let end, fail;
      const done = new Promise((resolve, reject) => { end = resolve; fail = reject; });
      done.catch(() => {});
      const error = behaviour(n);
      const started = error ? Promise.reject(error) : Promise.resolve();
      started.catch(() => {});
      played.push({ tune, end, fail });
      log.push(`play ${n}`);
      return { started, done, detail: "a fake target", stop: async (reason = "end") => { log.push(`stop ${n} ${reason}`); end(); } };
    },
  };
}

/** Starts a watch on a score in a new directory and runs `body`; the watch is stopped afterwards. */
async function watching(options, body, content = SCORE) {
  const box = sandbox("sidwave-watch-test-");
  const file = box.write("song.yaml", content);
  const events = eventQueue();
  const stop = new AbortController();
  const summary = watchScore({ file, cwd: box.dir, target: "local", debounceMs: 30, signal: stop.signal, onEvent: (e) => events.push(e), loop: true, ...options });
  summary.catch(() => {});
  const next = (type) => events.next((e) => e.type === type, `a ${type} event`);
  /** Replaces the file the way many editors do: a new file renamed over the old one. */
  const rename = (text, name = "song.yaml") => {
    fs.writeFileSync(path.join(box.dir, `.${name}.swp`), text);
    fs.renameSync(path.join(box.dir, `.${name}.swp`), path.join(box.dir, name));
  };
  try {
    await body({ box, file, events, next, rename, stop, summary });
  } finally {
    stop.abort();
    await within(summary.catch(() => {}), "the end of the watch");
    box.done();
  }
}

test("watch plays the score, replaces the playback on a save and stops it at the end", async () => {
  const target = fakeTarget();
  await watching({ player: target }, async ({ file, next, stop, summary }) => {
    const ok = await next("ok");
    assert.deepEqual([ok.title, ok.voices, ok.sids, ok.findings.every((f) => typeof f.code === "string")], ["Watched", 1, 1, true]);
    assert.ok(ok.seconds > 0);
    const playing = await next("playing");
    assert.ok(playing.latencyMs >= 0);
    assert.equal(playing.detail, "a fake target");
    fs.writeFileSync(file, withTempo(90));
    const second = await next("ok");
    assert.ok(second.seconds > ok.seconds, "the slower tempo is longer");
    await next("playing");
    stop.abort();
    assert.deepEqual(await within(summary, "the summary"), { builds: 2, errors: 0, ok: true });
    assert.deepEqual(target.log, ["play 1", "stop 1 replace", "play 2", "stop 2 end"]);
  });
});

test("an invalid save is reported with line and column and the last version keeps playing", async () => {
  const target = fakeTarget();
  await watching({ player: target }, async ({ file, next, stop, summary }) => {
    await next("playing");
    fs.writeFileSync(file, SCORE.replace("[C4, E4]", "[C4, H9]"));
    const error = await next("error");
    assert.deepEqual([error.line, error.category, error.keptPlaying], [7, "validation", true]);
    assert.ok(error.column > 1);
    assert.match(error.message, /H9/);
    assert.deepEqual(target.log, ["play 1"]);
    fs.writeFileSync(file, SCORE.replace("[C4, E4]", "[C4, E4"));
    const syntax = await next("error");
    assert.match(syntax.message, /YAML\/JSON could not be parsed/);
    assert.ok(syntax.line >= 7);
    fs.writeFileSync(file, withTempo(100));
    await next("playing");
    stop.abort();
    assert.deepEqual(await summary, { builds: 2, errors: 2, ok: true });
    assert.deepEqual(target.log, ["play 1", "stop 1 replace", "play 2", "stop 2 end"]);
  });
});

test("saves by rename are followed again and again, and a removed file is waited for", async () => {
  await watching({ player: fakeTarget() }, async ({ file, next, rename }) => {
    await next("playing");
    for (const tempo of [100, 101, 102]) {
      rename(withTempo(tempo));
      await next("playing");
    }
    fs.renameSync(file, `${file}.bak`);
    const missing = await next("missing");
    assert.equal(missing.file, file);
    rename(withTempo(103));
    await next("playing");
    fs.unlinkSync(file);
    await next("missing");
    fs.writeFileSync(file, withTempo(104));
    await next("playing");
  });
});

test("rapid saves give one build, and saves without a change or of other files give none", async () => {
  const target = fakeTarget();
  await watching({ player: target, debounceMs: 250 }, async ({ box, file, next, events }) => {
    await next("playing");
    for (let tempo = 100; tempo <= 110; tempo++) fs.writeFileSync(file, withTempo(tempo));
    await next("playing");
    assert.equal(target.played.length, 2);
    fs.writeFileSync(file, withTempo(110));
    box.write("unrelated.txt", "x");
    await sleep(700);
    assert.equal(events.all.filter((e) => e.type === "ok").length, 2);
    assert.equal(target.played.length, 2);
  });
});

test("a change of an imported library restarts the playback, also after the library was broken", async () => {
  const library = (tempoNote) => `sidwave: 1.4\nlibrary: { name: kit, version: 1.0.0, licence: CC0-1.0, provenance: { author: test, source: test, created: 2026-01-01 } }\ninstruments:\n  lead: { waveform: pulse, adsr: [0, 0, 15, ${tempoNote}] }\n`;
  const box = sandbox("sidwave-watch-lib-");
  box.write("kit.yaml", library(1));
  const score = SCORE.replace("sidwave: 1.2", "sidwave: 1.4\nimports:\n  - { from: ./libs/kit.yaml, as: kit }").replace("  - id: 1", "  - id: 1\n    instrument: kit.lead");
  fs.mkdirSync(path.join(box.dir, "libs"));
  fs.renameSync(path.join(box.dir, "kit.yaml"), path.join(box.dir, "libs", "kit.yaml"));
  const file = box.write("song.yaml", score);
  const events = eventQueue();
  const stop = new AbortController();
  const target = fakeTarget();
  const summary = watchScore({ file, cwd: box.dir, target: "local", debounceMs: 30, signal: stop.signal, player: target, onEvent: (e) => events.push(e) });
  const next = (type) => events.next((e) => e.type === type, `a ${type} event`).catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(events.all)}`); });
  try {
    await next("playing");
    fs.writeFileSync(path.join(box.dir, "libs", "kit.yaml"), library(2));
    await next("playing");
    fs.writeFileSync(path.join(box.dir, "libs", "kit.yaml"), "nonsense: [");
    await next("error");
    fs.writeFileSync(path.join(box.dir, "libs", "kit.yaml"), library(3));
    await next("playing");
    assert.equal(target.played.length, 3);
  } finally {
    stop.abort();
    await within(summary, "the end");
    box.done();
  }
});

test("--no-play checks only, with the places of the lint findings", async () => {
  const content = readExampleScore("chiptune_drive");
  await watching({ player: undefined }, async ({ file, next, stop, summary, events }) => {
    const ok = await next("ok");
    assert.ok(ok.findings.length > 0);
    const lines = content.split("\n").length;
    assert.ok(ok.findings.every((f) => f.line >= 1 && f.line <= lines && f.column >= 1), JSON.stringify(ok.findings));
    fs.writeFileSync(file, content.replace(/^tempo:.*$/m, "tempo: fast"));
    const error = await next("error");
    assert.equal(error.keptPlaying, false);
    assert.equal(error.path, "$.tempo");
    assert.ok(error.line > 1);
    stop.abort();
    assert.deepEqual(await summary, { builds: 1, errors: 1, ok: false });
    assert.equal(events.all.filter((e) => e.type === "playing").length, 0);
  }, content);
});

test("--loop-section plays one section in a loop; an unknown section is reported", async () => {
  const target = fakeTarget();
  await watching({ player: target, loopSection: "two", loop: false }, async ({ file, next }) => {
    const playing = await next("playing");
    assert.deepEqual([playing.loop, playing.startBar], [true, 2]);
    assert.ok(Math.abs(target.played[0].tune.seconds - 2) < 0.1, "one bar at 120");
    fs.writeFileSync(file, SCORE.replace("timeline: [one, two]", "timeline: [one]"));
    const error = await next("error");
    assert.match(error.message, /--loop-section two: the timeline has no such section/);
    assert.equal(error.keptPlaying, true);
  });
});

test("playback failures and ends are reported and the watch goes on", async () => {
  const target = fakeTarget((n) => (n === 2 ? new Error("device gone") : undefined));
  await watching({ player: target }, async ({ file, next, stop, summary }) => {
    await next("playing");
    fs.writeFileSync(file, withTempo(100));
    assert.match((await next("playback-error")).message, /device gone/);
    fs.writeFileSync(file, withTempo(101));
    await next("playing");
    target.played[2].end();
    await next("finished");
    fs.writeFileSync(file, withTempo(102));
    await next("playing");
    target.played[3].fail(new Error("player crashed"));
    assert.match((await next("playback-error")).message, /player crashed/);
    stop.abort();
    await within(summary, "the end");
  });
});

test("a failed replacement leaves the earlier playback to be stopped at the end", async () => {
  const target = fakeTarget((n) => (n === 2 ? new Error("refused") : undefined));
  await watching({ player: target }, async ({ file, next, stop, summary }) => {
    await next("playing");
    fs.writeFileSync(file, withTempo(100));
    await next("playback-error");
    stop.abort();
    await within(summary, "the end");
    assert.deepEqual(target.log, ["play 1", "stop 1 replace", "play 2", "stop 1 end"]);
  });
});

test("a watch on a missing file fails; an already aborted watch ends at once", async () => {
  const box = sandbox("sidwave-watch-none-");
  try {
    await assert.rejects(watchScore({ file: "none.yaml", cwd: box.dir, target: "local", signal: new AbortController().signal, onEvent: () => {} }), /cannot read none\.yaml/);
    await assert.rejects(watchScore({ file: ".", cwd: box.dir, target: "local", signal: new AbortController().signal, onEvent: () => {} }), /cannot read/);
    box.write("song.yaml", SCORE);
    const stop = new AbortController();
    stop.abort();
    assert.deepEqual(await watchScore({ file: "song.yaml", cwd: box.dir, target: "local", signal: stop.signal, onEvent: () => assert.fail("no event") }), { builds: 0, errors: 0, ok: false });
  } finally { box.done(); }
});
