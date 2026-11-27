#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { runCli } from "./cli.js";

// SIGINT aborts the running operation through the signal; a second SIGINT ends the process at once.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(5);
  controller.abort();
});

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  outBytes: (bytes) => { process.stdout.write(bytes); },
  signal: controller.signal,
});
