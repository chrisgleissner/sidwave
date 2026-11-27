// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// The `lock` and `bundle` commands of the sidwave command line (SIDWave 1.4 asset libraries). Failures are thrown and
// classified by the command line (cliCore): an invalid score or library is `validation` (exit 3), unreadable or
// unwritable files and refused paths are `input` (exit 3).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SidwaveOperationError, UsageError, envelope, withFile, type CliIo } from "./cliCore.js";
import { bundleScore, lockScore } from "./sidwaveLibs.js";

export interface AssetCommandArgs {
  file: string;
  output?: string;
  force: boolean;
  json: boolean;
  allowDirs: string[];
}

function read(io: CliIo, args: AssetCommandArgs): { text: string; path: string } {
  const path = resolve(io.cwd, args.file);
  try {
    return { text: readFileSync(path, "utf8"), path };
  } catch (error) {
    throw new SidwaveOperationError("input", `cannot read ${args.file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: args.file });
  }
}

/** Runs `fn`: score errors keep their category, any other plain error (a refused sample, a full directory) is input. */
function guarded<T>(args: AssetCommandArgs, fn: () => T): T {
  try {
    return withFile(args.file, fn);
  } catch (error) {
    if (error instanceof Error && error.constructor === Error && !/^E[A-Z]+$/.test(String((error as NodeJS.ErrnoException).code ?? ""))) {
      throw new SidwaveOperationError("input", error.message, { file: args.file }, { cause: error });
    }
    throw error;
  }
}

/** `sidwave lock <score> [-o <out>]`: writes the sha256 of every imported library into the score. */
export function lockCommand(io: CliIo, args: AssetCommandArgs): number {
  const { text, path } = read(io, args);
  const locked = guarded(args, () => lockScore(text, path, args.allowDirs.map((d) => resolve(io.cwd, d))));
  const toStdout = args.output === "-";
  const target = args.output === undefined ? path : resolve(io.cwd, args.output);
  if (toStdout) io.out(locked.text);
  else {
    try {
      writeFileSync(target, locked.text);
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: target });
    }
  }
  const result = { file: args.file, output: toStdout ? null : target, imports: locked.imports };
  const report = args.json
    ? `${JSON.stringify(envelope("lock", true, { result }), null, 2)}\n`
    : `${locked.imports.map((i) => `${i.as}: sha256 ${i.sha256}${i.changed ? "" : " (unchanged)"}`).join("\n")}\n`;
  // With the score on standard output the report goes to standard error so the two never mix.
  if (toStdout) io.err(report); else io.out(report);
  return 0;
}

/** `sidwave bundle <score> -o <dir>`: the score and its library closure in one directory, with bundle.json. */
export function bundleCommand(io: CliIo, args: AssetCommandArgs): number {
  if (args.output === undefined || args.output === "-") throw new UsageError("bundle needs -o <directory>");
  const { text, path } = read(io, args);
  const output = resolve(io.cwd, args.output);
  const manifest = guarded(args, () => bundleScore(text, path, output, args.allowDirs.map((d) => resolve(io.cwd, d)), args.force, resolve(io.cwd)));
  io.out(args.json
    ? `${JSON.stringify(envelope("bundle", true, { result: { file: args.file, output, ...manifest } }), null, 2)}\n`
    : `${output}: bundle with ${manifest.libraries.length} librar${manifest.libraries.length === 1 ? "y" : "ies"}\n`);
  return 0;
}
