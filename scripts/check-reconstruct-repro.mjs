#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
//
// Reproducibility check of the development report:
//
//   HVSC_DIR=/path/to/C64Music nice -n 10 node scripts/check-reconstruct-repro.mjs [--count 3] [--report path] [--only substring,...]
//
// Reruns N development tunes with an empty cache in a temporary directory (the cache is never reused, so a stale entry cannot
// hide a difference) and compares each result with the committed report: verdicts, differing calls, first difference and
// the score hash. The code identity (SHA-256 of sidwave/dist) must also match the report. Exit 0 when every compared field
// is equal, 1 when a field differs, 2 when the check could not run. Rebuild first: `rm -rf sidwave/dist && npm run build`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "3" },
    report: { type: "string", default: path.join(root, "sidwave/data/reconstruct/dev-report.json") },
    only: { type: "string" },
    "max-horizon": { type: "string" },
  },
});

/** The fields of a tune result that must reproduce. */
export function comparable(r) {
  return {
    strictExact: r.strictExact, registerStateExact: r.registerStateExact, verification: r.verification?.mode ?? null, compileOk: r.compileOk, turbo: r.turbo ?? false,
    calls: r.calls, differingCalls: r.fdiff?.differingCalls, callsWithDifference: r.fdiff?.callsWithDifference,
    comparedCalls: r.fdiff?.comparedCalls, first: r.fdiff?.first ?? null, scoreSha256: r.scoreSha256,
  };
}

/** Names of the fields in which two comparable results differ. */
export function differences(a, b) {
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function main() {
  if (!process.env.HVSC_DIR) { console.error("HVSC_DIR is not set"); return 2; }
  if (!existsSync(args.report)) { console.error(`no report at ${args.report}`); return 2; }
  const committed = JSON.parse(readFileSync(args.report, "utf8"));
  const wanted = args.only ? args.only.split(",") : undefined;
  const pool = committed.tunes.filter((t) => !t.error && (!wanted || wanted.some((w) => t.path.includes(w))));
  // An even spread over the report, so that early and late tunes are both covered.
  const count = Math.min(pool.length, Math.max(1, Number(args.count)));
  const picked = Array.from({ length: count }, (_, i) => pool[Math.floor((i * pool.length) / count)]);
  const dir = mkdtempSync(path.join(tmpdir(), "sidwave-repro-"));
  try {
    const out = path.join(dir, "rerun.json");
    const run = spawnSync(process.execPath, [
      path.join(root, "scripts/reconstruct-corpus.mjs"), "--cache", path.join(dir, "cache"), "--out", out, "--no-a1", "--workers", "2",
      "--only", picked.map((t) => t.path).join(","),
      ...(args["max-horizon"] ? ["--max-horizon", args["max-horizon"]] : committed.settings.maxHorizon !== 180 ? ["--max-horizon", String(committed.settings.maxHorizon)] : []),
    ], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
    if (run.status !== 0 || !existsSync(out)) { console.error(`the rerun failed (exit ${run.status})`); return 2; }
    const rerun = JSON.parse(readFileSync(out, "utf8"));
    let bad = 0;
    if (rerun.versions.code !== committed.versions.code) {
      console.error(`code identity differs: report ${committed.versions.code}, this build ${rerun.versions.code}; the report was made with other code (rebuild dist from the revision ${committed.source?.commit ?? "unknown"})`);
      bad++;
    }
    for (const t of rerun.tunes) {
      const before = committed.tunes.find((c) => c.path === t.path && c.subtune === t.subtune);
      const d = before ? differences(comparable(before), comparable(t)) : ["missing in report"];
      console.error(`${t.path}:${t.subtune}: ${d.length ? `DIFFERS in ${d.join(", ")}` : "reproduced"}`);
      if (d.length) bad++;
    }
    return bad ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
