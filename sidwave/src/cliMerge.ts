// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { EXIT_FAILED, EXIT_OK, UsageError, type CliIo } from "./cliCore.js";
import { brief, emit, guard, last, readText, runAuthoring, writeOutput } from "./cliAuthoring.js";
import { mergeSidwave, type Conflict } from "./format/sidwaveFormat.js";
import { confinedReadOptions } from "./sidwaveOps.js";

export const MERGE_HELP = `sidwave merge: three-way merge of SIDWave scores

Usage:
  sidwave merge <base> <ours> <theirs> [-o <out>] [--force] [--allow-dir <dir>] [--json]

Merges on the parsed values: a value that only one side changed takes that side's change, and a value that both
sides changed to the same thing is kept. Lists of equal length (voices, timeline entries, groove entries) merge
entry by entry. Comments, anchors and aliases of <ours> are kept where the merge did not change them. The result
must parse as a valid score, otherwise it is reported as a conflict.

Exit 0 when the merge is clean (the merged score goes to -o, or to standard output). Exit 1 when both sides changed
the same value differently, or the lists differ in length: nothing is written, and standard error lists each
conflict with the path and the three values.

Options:
  -o <file>          Write the merged score to <file>. An existing file needs --force.
  --force            Replace an existing -o file.
  --allow-dir <dir>  Allow "file:" sources and library files below <dir> when validating the result. May be repeated.
  --json             Machine-readable output: { "merged", "conflicts" }.
  -h, --help         Show this text.

Examples:
  sidwave merge base.yaml mine.yaml theirs.yaml -o merged.yaml
  sidwave merge base.yaml mine.yaml theirs.yaml --json

Git integration. Merge scores with "git merge", "git rebase" and "git cherry-pick":
  # .gitattributes
  *.sidwave.yaml merge=sidwave
  # once per clone (or in ~/.gitconfig)
  git config merge.sidwave.name "SIDWave semantic merge"
  git config merge.sidwave.driver "sidwave merge %O %A %B -o %A --force"
Git passes the common ancestor (%O), the current branch's version (%A) and the other branch's version (%B), and
reads the result from %A. On a conflict the command exits 1 and leaves %A as it was, so git reports a conflict;
run "sidwave merge" on the three versions ("git show :1:<path>", ":2:" and ":3:") to see which paths conflict.
`;

function conflictReport(conflicts: Conflict[]): string {
  const lines = [`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; nothing was written`];
  for (const c of conflicts) {
    lines.push(`  ${c.path || "/"}: ${c.summary}`);
    for (const [label, key] of [["base", "base"], ["ours", "ours"], ["theirs", "theirs"]] as const) {
      lines.push(`    ${label.padEnd(6)} ${key in c ? brief(c[key], 100) : "(absent)"}`);
    }
  }
  lines.push("Edit one version so that both sides agree at these paths, then merge again.");
  return lines.join("\n");
}

/** `sidwave merge`. `args` excludes the command name. */
export function runMergeCli(args: string[], io: CliIo): number {
  return runAuthoring("merge", MERGE_HELP, { value: ["-o", "--allow-dir"], bool: ["--force"] }, args, io, (p, { json }) => {
    if (p.positional.length !== 3) throw new UsageError("merge needs three score files: sidwave merge <base> <ours> <theirs>");
    const [base, ours, theirs] = p.positional as [string, string, string];
    const B = readText(io, base), O = readText(io, ours), T = readText(io, theirs);
    const output = last(p, "-o");
    const read = confinedReadOptions(io.cwd, p.values.get("--allow-dir") ?? [], O.path);
    const result = guard(`${base} / ${ours} / ${theirs}`, () => mergeSidwave(B.text, O.text, T.text, read));
    const warnings = result.warnings ?? [];
    if (result.merged === undefined) {
      emit(io, json, "merge", { base, ours, theirs, merged: false, conflicts: result.conflicts }, conflictReport(result.conflicts), false, json ? "out" : "err");
      return EXIT_FAILED;
    }
    for (const warning of json ? [] : warnings) io.err(`warning: ${warning}\n`);
    if (output === undefined || output === "-") {
      if (json) emit(io, true, "merge", { base, ours, theirs, merged: true, conflicts: [], output: null, preserved: result.preserved ?? true, warnings, text: result.merged }, "");
      else io.out(result.merged);
      return EXIT_OK;
    }
    const path = writeOutput(io, output, result.merged, { force: p.flags.has("--force"), inputs: [B.path, O.path, T.path] });
    emit(io, json, "merge", { base, ours, theirs, merged: true, conflicts: [], output: path, preserved: result.preserved ?? true, warnings }, `${path}: merged without conflicts`);
    return EXIT_OK;
  });
}
