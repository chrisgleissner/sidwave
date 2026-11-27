// Fake audio players, fake VICE programs and a fake Ultimate REST server for the play and watch tests. A fake program
// connects back to the test over TCP and reports what it was given, so that tests wait for events instead of polling,
// and the connection closes when the process is gone. No test produces sound or reaches a device.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function sandbox(prefix = "sidwave-play-test-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }), write: (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; } };
}

/** A promise that fails after `ms` instead of hanging the test run. */
export function within(promise, what, ms = 60_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A queue of events with `next(predicate)`. */
export function eventQueue() {
  const items = [], waiting = [];
  return {
    all: [],
    push(event) {
      this.all.push(event);
      const index = waiting.findIndex((w) => w.match(event));
      if (index >= 0) waiting.splice(index, 1)[0].resolve(event);
      else items.push(event);
    },
    next(match = () => true, what = "an event") {
      const index = items.findIndex(match);
      if (index >= 0) return Promise.resolve(items.splice(index, 1)[0]);
      return within(new Promise((resolve) => waiting.push({ match, resolve })), what);
    },
  };
}

const PROGRAM = `
const net = require("net"), fs = require("fs");
const [port, mode, ...args] = process.argv.slice(2);
const socket = net.connect(Number(port), "127.0.0.1");
const say = (message, then) => socket.write(JSON.stringify({ pid: process.pid, ...message }) + "\\n", then);
let tune;
const last = args[args.length - 1];
if (mode.startsWith("vice") && last && fs.existsSync(last)) tune = fs.readFileSync(last).toString("base64");
say({ type: "start", args, tune, mode });
const leave = (code) => socket.end(() => process.exit(code));
if (mode === "fail" || mode === "vice-fail") { process.stderr.write("no sound device\\n"); leave(3); }
if (mode === "vice-quit") leave(0);
if (mode === "stubborn" || mode === "vice-stubborn") process.on("SIGTERM", () => say({ type: "sigterm" }));
if (mode.startsWith("vice") || mode === "stubborn") setInterval(() => {}, 1000);
if (mode === "player" || mode === "slow" || mode === "quit") {
  const chunks = []; let bytes = 0;
  process.stdin.on("data", (data) => {
    chunks.push(data); bytes += data.length;
    if (chunks.length === 1) say({ type: "audio" });
    if (mode === "slow") process.stdin.pause();
    if (mode === "quit") leave(0);
  });
  process.stdin.on("end", () => say({ type: "end", bytes, data: Buffer.concat(chunks).toString("base64") }, () => leave(0)));
  if (mode === "slow") setInterval(() => {}, 1000);
}
`;

/**
 * Starts a server for fake programs. \`program(name, mode)\` writes an executable called \`name\` and returns its path.
 * Every start is an item of \`events\` with an \`exited\` promise.
 */
export async function fakePrograms(dir) {
  const events = eventQueue();
  const runs = new Map();
  const server = net.createServer((socket) => {
    let buffer = "", run;
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buffer += data;
      for (let i; (i = buffer.indexOf("\n")) >= 0;) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.type === "start") {
          let gone;
          run = { ...message, exited: new Promise((resolve) => { gone = resolve; }), gone, alive: true };
          runs.set(message.pid, run);
          events.push(run);
        } else events.push({ ...message, run });
      }
    });
    socket.on("close", () => { if (run) { run.alive = false; run.gone(); } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const script = path.join(dir, "fake-program.cjs");
  fs.writeFileSync(script, PROGRAM);
  const node = process.versions.bun ? spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim() || process.execPath : process.execPath;
  return {
    events,
    program(name, mode) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\nexec "${node}" "${script}" ${server.address().port} ${mode} "$@"\n`, { mode: 0o755 });
      return file;
    },
    start: () => events.next((e) => e.type === "start", "a program to start"),
    event: (type) => events.next((e) => e.type === type, `a ${type} event`),
    starts: () => events.all.filter((e) => e.type === "start"),
    alive: () => [...runs.values()].filter((r) => r.alive),
    async close() {
      // Only processes that this server's own fake programs reported are ended here.
      for (const run of runs.values()) if (run.alive) { try { process.kill(run.pid, "SIGKILL"); } catch { /* gone */ } }
      await Promise.all([...runs.values()].map((r) => r.exited));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A fake Ultimate REST server. `behaviour(request)` returns { status, body, headers } or "hang". */
export async function fakeUltimate(behaviour = () => ({ status: 200, body: { errors: [] } })) {
  const requests = eventQueue();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(record);
      const reply = behaviour(record);
      if (reply === "hang") return;
      response.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    host: `127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
