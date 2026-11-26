#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Committed launcher. npm creates the bin link when it installs the workspace, which happens before dist/ exists in a
// fresh clone; a link whose target is missing is not created. This file exists in the clone, so the link is always made.
try {
  await import("../dist/bin.js");
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("bin.js")) {
    process.stderr.write("sidwave is not built: run npm run build\n");
    process.exit(2);
  }
  throw error;
}
