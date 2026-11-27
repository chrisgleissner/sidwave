// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { EXIT_FAILED, EXIT_OK, UsageError, type CliIo } from "./cliCore.js";
import { brief, emit, guard, readText, requireScore, runAuthoring } from "./cliAuthoring.js";
import { diffSidwave, type SemanticDiff } from "./format/sidwaveFormat.js";
import { confinedReadOptions } from "./sidwaveOps.js";

export const DIFF_HELP = `sidwave diff: show what differs between two SIDWave scores

Usage:
  sidwave diff <a> <b> [--ignore-formatting] [--compile] [--allow-dir <dir>] [--json]
  sidwave diff --git <path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode>

The comparison is on the parsed values, not on the text, so a change of key order, quoting, indentation or comments
is reported as formatting and does not hide a change of a note. Each change has a class (musical, synthesis, hardware,
structural or formatting), the path of the value (a JSON pointer, such as /voices/0/patterns/Lead/groove/2/note) and
the values before and after. With --compile the last line says whether both scores compile to the same PRG.

Like diff(1), the exit code is 0 when the scores are equal and 1 when they differ. A difference of formatting alone
counts as a difference unless --ignore-formatting is given.

Options:
  --ignore-formatting  Treat scores that differ only in formatting as equal (exit 0).
  --allow-dir <dir>    Allow "file:" sources and library files below <dir> when checking that the scores compile
                       to the same PRG. May be repeated.
  --compile            Also compile both scores and report whether the PRG is identical (several times slower on a
                       large score; without it "compiledEqual" is null).
  --git                Run as a git external diff driver (see below). Always exits 0, as git requires, and does not compile the scores.
  --json               Machine-readable output: { "changes": [...], "compiledEqual": bool }.
  -h, --help           Show this text.

Examples:
  sidwave diff song-v1.yaml song-v2.yaml
  sidwave diff a.yaml b.yaml --json
  sidwave diff a.yaml b.yaml --ignore-formatting && echo "same music"
  sidwave diff a.yaml b.yaml --compile      # also compare the compiled PRG

Git integration. Show the semantic changes in "git diff" and "git log -p":
  # .gitattributes
  *.sidwave.yaml diff=sidwave
  # once per clone (or in ~/.gitconfig)
  git config diff.sidwave.command "sidwave diff --git"
To diff the canonical text instead, so that git's own line diff ignores formatting-only edits:
  git config diff.sidwave.textconv "sidwave format"
(set one of the two; with textconv, sidwave must be on the PATH of the shell git uses).
`;

const PLURAL = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MAX_LINES = 200;

const CONTEXT = 24;
const MIDDLE = 60;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * One value pair on a line. Short values are shown whole. Two long strings are shown around the place where they
 * differ: the common start and end are cut to a few characters of context, so that the changed tokens are visible.
 */
export function describeChange(before: unknown, after: unknown, hasBefore = true, hasAfter = true): string {
  const show = (value: unknown, present: boolean) => (present ? brief(value, 70) : "(absent)");
  const long = typeof before === "string" && typeof after === "string" && (before.length > 60 || after.length > 60);
  if (!long) return `${show(before, hasBefore)} -> ${show(after, hasAfter)}`;
  const x: string = before as string, y: string = after as string;
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  // Move to token boundaries so that a note name is not cut in half.
  while (start > 0 && !/\s/.test(x[start - 1]!)) start--;
  while (end > 0 && !/\s/.test(x[x.length - end]!)) end--;
  const head = start > CONTEXT ? `...${x.slice(start - CONTEXT, start)}` : x.slice(0, start);
  const tail = end > CONTEXT ? `${x.slice(x.length - end, x.length - end + CONTEXT)}...` : x.slice(x.length - end);
  const from = clip(x.slice(start, x.length - end), MIDDLE), to = clip(y.slice(start, y.length - end), MIDDLE);
  return `"${head}[${from} -> ${to}]${tail}"`;
}

/** The text of a diff; `names` label the two sides. */
export function formatDiff(diff: Omit<SemanticDiff, "compiledEqual"> & { compiledEqual: boolean | null }, names: [string, string]): string {
  if (diff.changes.length === 0) return `${names[0]} and ${names[1]} are semantically identical`;
  if (diff.changes.every((c) => c.class === "formatting")) return `${names[0]} -> ${names[1]}: formatting only (no musical change)`;
  const byClass = new Map<string, number>();
  for (const change of diff.changes) byClass.set(change.class, (byClass.get(change.class) ?? 0) + 1);
  const summary = [...byClass].map(([name, count]) => `${count} ${name}`).join(", ");
  const lines = [`${names[0]} -> ${names[1]}: ${PLURAL(diff.changes.length, "change")} (${summary})`];
  const width = Math.max(...diff.changes.slice(0, MAX_LINES).map((c) => c.class.length));
  for (const change of diff.changes.slice(0, MAX_LINES)) {
    lines.push(`  ${change.class.padEnd(width)}  ${change.path || "/"}  ${describeChange(change.before, change.after, "before" in change, "after" in change)}`);
  }
  if (diff.changes.length > MAX_LINES) lines.push(`  ... ${diff.changes.length - MAX_LINES} more changes; use --json for all of them`);
  if (diff.compiledEqual !== null) lines.push(`compiled output: ${diff.compiledEqual ? "identical" : "different"}`);
  return lines.join("\n");
}

function gitDriver(io: CliIo, rest: string[]): number {
  if (rest.length === 1) { io.out(`${rest[0]}: unmerged path, no semantic diff\n`); return EXIT_OK; }
  if (rest.length !== 7) throw new UsageError("--git needs the seven arguments git passes to an external diff driver: path old-file old-hex old-mode new-file new-hex new-mode");
  const [path, oldFile, , , newFile] = rest as [string, string, string, string, string, string, string];
  if (oldFile === "/dev/null") { io.out(`${path}: new score\n`); return EXIT_OK; }
  if (newFile === "/dev/null") { io.out(`${path}: score deleted\n`); return EXIT_OK; }
  const a = readText(io, oldFile).text, b = readText(io, newFile).text;
  let diff;
  try { diff = guard(path, () => diffSidwave(a, b, confinedReadOptions(io.cwd, []), { compile: false })); } catch {
    io.out(`${path}: not a valid SIDWave score, no semantic diff\n`);
    return EXIT_OK;
  }
  io.out(`${formatDiff(diff, [`a/${path}`, `b/${path}`])}\n`);
  return EXIT_OK;
}

/** `sidwave diff`. `args` excludes the command name. */
export function runDiffCli(args: string[], io: CliIo): number {
  if (args[0] === "--git") {
    return runAuthoring("diff", DIFF_HELP, { value: [] }, [], io, () => gitDriver(io, args.slice(1)));
  }
  return runAuthoring("diff", DIFF_HELP, { value: ["--allow-dir"], bool: ["--ignore-formatting", "--compile"] }, args, io, (p, { json }) => {
    if (p.positional.length !== 2) throw new UsageError("diff needs two score files: sidwave diff <a> <b>");
    const [a, b] = p.positional as [string, string];
    const A = readText(io, a), B = readText(io, b);
    const allow = p.values.get("--allow-dir") ?? [];
    const read = confinedReadOptions(io.cwd, allow, A.path);
    requireScore(io, a, A.text, A.path, allow);
    requireScore(io, b, B.text, B.path, allow);
    const diff = guard(`${a} / ${b}`, () => p.flags.has("--compile") ? diffSidwave(A.text, B.text, read) : diffSidwave(A.text, B.text, read, { compile: false }));
    const onlyFormatting = diff.changes.length > 0 && diff.changes.every((c) => c.class === "formatting");
    const equal = diff.changes.length === 0 || (onlyFormatting && p.flags.has("--ignore-formatting"));
    emit(io, json, "diff", { a, b, equal, changes: diff.changes, compiledEqual: diff.compiledEqual }, formatDiff(diff, [a, b]), equal);
    return equal ? EXIT_OK : EXIT_FAILED;
  });
}
