// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { CliIo } from "./cliCore.js";
import { runDiffCli } from "./cliDiff.js";
import { runFormatCli } from "./cliFormat.js";
import { runMergeCli } from "./cliMerge.js";
import { runTransformCli } from "./cliTransform.js";

/** The authoring commands. Each one has its own file, its own --help and reports errors itself. */
export const AUTHORING_COMMANDS: Record<string, (args: string[], io: CliIo) => number> = {
  transform: runTransformCli,
  format: runFormatCli,
  diff: runDiffCli,
  merge: runMergeCli,
};

export const AUTHORING_USAGE = `  sidwave transform <score> --transpose <n>|--tempo <bpm>|--swap-instrument <a>=<b>|--quantise <grid>|... [-o <out>]   (see "sidwave transform --help")
  sidwave format   <score>... [--check|--write]
  sidwave diff     <a> <b> [--json]            (exit 1 when the scores differ)
  sidwave merge    <base> <ours> <theirs> [-o <out>]   (exit 1 on conflicts)
`;
