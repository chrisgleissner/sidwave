#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Committed launcher. npm creates the bin link when it installs the workspace, which happens before dist/ exists in a
// fresh clone; a link whose target is missing is not created. This file exists in the clone, so the link is always made.
import "../dist/bin.js";
