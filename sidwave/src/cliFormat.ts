// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { writeFileSync } from "node:fs";
import { EXIT_FAILED, EXIT_OK, SidwaveOperationError, UsageError, type CliIo } from "./cliCore.js";
import { emit, guard, last, readText, runAuthoring, writeOutput } from "./cliAuthoring.js";
import { formatSidwave } from "./format/sidwaveFormat.js";

export const FORMAT_HELP = `sidwave format: write a SIDWave score in its canonical layout

Usage:
  sidwave format <score> [-o <out>] [--force] [--json]
  sidwave format <score>... --check [--json]
  sidwave format <score>... --write [--json]

The canonical layout has a fixed key order, two-space indentation, double-quoted strings and short lists in flow
style. Comments, anchors and aliases are kept. Formatting does not change what the score plays, and it is
idempotent: formatting a formatted file changes nothing.

Without --check and --write the formatted text goes to -o, or to standard output; that form takes one file.

Options:
  --check          Change nothing. Exit 0 when every file is formatted, 1 when a file is not (the files are listed).
                   For CI and pre-commit hooks.
  --write          Rewrite each file that is not formatted, in place, and list the files changed.
  -o <file>        Write the formatted text to <file>. An existing file needs --force.
  --force          Replace an existing -o file.
  --json           Machine-readable output.
  -h, --help       Show this text.

Examples:
  sidwave format song.yaml > song.formatted.yaml
  sidwave format songs/*.yaml --check          # in CI: exit 1 when a file needs formatting
  sidwave format songs/*.yaml --write          # fix them
  # Pre-commit hook (.git/hooks/pre-commit): sidwave format $(git diff --cached --name-only -- '*.yaml') --check

Exit codes: 0 formatted or written; 1 --check found a file that is not formatted; 2 usage; 3 unreadable file or
invalid YAML.
`;

interface FileResult { file: string; changed: boolean }

/** `sidwave format`. `args` excludes the command name. */
export function runFormatCli(args: string[], io: CliIo): number {
  return runAuthoring("format", FORMAT_HELP, { value: ["-o"], bool: ["--check", "--write", "--force"] }, args, io, (p, { json }) => {
    const check = p.flags.has("--check");
    const write = p.flags.has("--write");
    const output = last(p, "-o");
    if (check && write) throw new UsageError("--check and --write cannot be combined; run --check to test and --write to fix");
    if (p.positional.length === 0) throw new UsageError("format needs a score file");
    if ((check || write) && output !== undefined) throw new UsageError(`-o does not apply with ${check ? "--check" : "--write"}`);
    if (!check && !write && p.positional.length > 1) throw new UsageError("format without --check or --write takes one file; use --write to format several in place");
    if (!check && !write && p.flags.has("--force") && output === undefined) throw new UsageError("--force needs -o");

    const results: FileResult[] = [];
    const formatted = new Map<string, string>();
    for (const file of p.positional) {
      const { text } = readText(io, file);
      const next = guard(file, () => formatSidwave(text));
      formatted.set(file, next);
      results.push({ file, changed: next !== text });
    }
    const unformatted = results.filter((r) => r.changed);

    if (check) {
      const lines = unformatted.map((r) => `${r.file}: not formatted`);
      emit(io, json, "format", { check: true, files: results, formatted: unformatted.length === 0 },
        unformatted.length === 0 ? `${results.length} file${results.length === 1 ? " is" : "s are"} formatted` : `${lines.join("\n")}\nRun "sidwave format --write" on the listed files.`,
        unformatted.length === 0);
      return unformatted.length === 0 ? EXIT_OK : EXIT_FAILED;
    }
    if (write) {
      for (const r of unformatted) {
        const path = readText(io, r.file).path;
        try { writeFileSync(path, formatted.get(r.file)!); } catch (error) {
          throw new SidwaveOperationError("input", `cannot write ${r.file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: r.file });
        }
      }
      emit(io, json, "format", { write: true, files: results },
        unformatted.length === 0 ? `${results.length} file${results.length === 1 ? " was" : "s were"} already formatted` : unformatted.map((r) => `formatted ${r.file}`).join("\n"));
      return EXIT_OK;
    }
    const file = p.positional[0]!;
    const text = formatted.get(file)!;
    if (output === undefined || output === "-") {
      if (json) emit(io, true, "format", { file, changed: results[0]!.changed, output: null, text }, "");
      else io.out(text);
      return EXIT_OK;
    }
    const path = writeOutput(io, output, text, { force: p.flags.has("--force"), inputs: [readText(io, file).path] });
    emit(io, json, "format", { file, changed: results[0]!.changed, output: path }, `${path}: ${results[0]!.changed ? "formatted" : "already formatted"}`);
    return EXIT_OK;
  });
}
