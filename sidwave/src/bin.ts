#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWAVE Player Exception.

import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  outBytes: (bytes) => { process.stdout.write(bytes); },
});
