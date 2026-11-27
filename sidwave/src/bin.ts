#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { readFileSync } from "node:fs";
import type { CliIo } from "./cliCore.js";

process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(0); throw error; });

// SIGINT aborts the running operation through the signal; a second SIGINT ends the process at once.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(5);
  controller.abort();
});

const io: CliIo = {
  cwd: process.cwd(),
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  outBytes: (bytes) => { process.stdout.write(bytes); },
  signal: controller.signal,
};

type Runner = (args: string[], io: CliIo) => number | Promise<number>;

/**
 * Commands that load only their own modules. The full command line (cli.js) imports every command and takes about
 * 0.2 s of CPU to load; these start in a fraction of that. runCli (cli.js) dispatches the same commands, for callers
 * that use the library.
 */
const FAST: Record<string, () => Promise<Runner>> = {
  format: async () => (await import("./cliFormat.js")).runFormatCli,
  diff: async () => (await import("./cliDiff.js")).runDiffCli,
  merge: async () => (await import("./cliMerge.js")).runMergeCli,
  transform: async () => (await import("./cliTransform.js")).runTransformCli,
  generate: async () => (await import("./cliGenerate.js")).runGenerateCli,
  play: async () => (await import("./cliPlay.js")).runPlayCli,
  watch: async () => (await import("./cliPlay.js")).runWatchCli,
};

const args = process.argv.slice(2);
const first = args[0];
if (first === "--version" || first === "-V") {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  io.out(`${manifest.version}\n`);
  process.exitCode = 0;
} else if (first !== undefined && Object.prototype.hasOwnProperty.call(FAST, first)) {
  process.exitCode = await (await FAST[first]!())(args.slice(1), io);
} else {
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(args, io);
}
