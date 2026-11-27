// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Every process that playback starts (audio player, VICE) and every temporary directory is registered here. They are
// removed by stopChild and removeTempDir on the normal paths, and by an `exit` handler when the process ends any other
// way (process.exit, an uncaught exception). Only these child process objects are signalled; nothing is looked up by name.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
let hooked = false;

function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const child of children) child.kill("SIGKILL");
    for (const dir of tempDirs) removeTempDir(dir);
  });
}

export function spawnTracked(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  hook();
  const child = spawn(command, [...args], options);
  children.add(child);
  child.once("exit", () => children.delete(child));
  // A spawn that failed has no process id and never emits `exit`.
  child.on("error", () => { if (child.pid === undefined) children.delete(child); });
  return child;
}

export interface ChildExit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

/** Resolves when the process has ended, or when it could not be started. */
export function exitOf(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => { if (child.pid === undefined) resolve({ code: null, signal: null, error }); });
  });
}

/** Sends SIGTERM, then SIGKILL after `graceMs`, and waits until the process has ended. */
export async function stopChild(child: ChildProcess, graceMs = 500): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitOf(child);
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(force);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

export function makeTempDir(): string {
  hook();
  const dir = mkdtempSync(join(tmpdir(), "sidwave-play-"));
  tempDirs.add(dir);
  return dir;
}

export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  } catch {
    // Left in the system temporary directory; the exit handler tries once more.
  }
}

/** The number of started processes that have not ended yet; used by tests. */
export function liveChildCount(): number {
  return children.size;
}

/** Keeps the last `limit` characters of the output of a process, for error messages. */
export function outputTail(child: ChildProcess, limit = 2000): () => string {
  let text = "";
  const add = (chunk: Buffer | string) => { text = (text + String(chunk)).slice(-limit); };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  return () => text.replace(/\u001b\[[0-9;]*m/g, "").trim();
}
