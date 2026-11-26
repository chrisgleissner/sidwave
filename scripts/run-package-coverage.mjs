#!/usr/bin/env node
/**
 * Line coverage of each workspace package, measured with Bun over the package's own tests and
 * limited to the package's src/. Blank and comment-only lines that Bun reports inside executed
 * functions are dropped, as in scripts/run-coverage.mjs. Each package has a .c8rc.json whose
 * `lines` value is the minimum percentage.
 *
 * Bun's LCOV has line data only. When .c8rc.json also has a `branches` value, the package's tests are run
 * a second time on Node under c8 (V8 block coverage), the branch percentage is enforced against `branches`,
 * and the BRDA, BRF and BRH records of c8 are added to the package's coverage/lcov.info next to Bun's line
 * records, so Codecov receives line and branch data. Packages without `branches` are measured as before.
 *
 *   node scripts/run-package-coverage.mjs [package-dir ...]   default: every package directory next to scripts/
 *
 * This file lives in packages/scripts. packages/ is the root of the standalone sidwave repository, so the
 * script only refers to its own parent directory and works in c64bridge and in the standalone repository.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARD_SIZE = Number(process.env.C64BRIDGE_COVERAGE_SHARD_SIZE) || 12;

export function parseLcov(text, packageDir) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const abs = path.resolve(packageDir, line.slice(3).trim());
      const rel = path.relative(packageDir, abs).split(path.sep).join("/");
      current = rel.startsWith("src/") && rel.endsWith(".ts") ? (files.get(rel) ?? files.set(rel, new Map()).get(rel)) : null;
    } else if (current && line.startsWith("DA:")) {
      const [no, hits] = line.slice(3).split(",").map(Number);
      current.set(no, Math.max(current.get(no) ?? 0, hits));
    }
  }
  return files;
}

export function codeLinesOnly(files, packageDir) {
  const result = new Map();
  for (const [rel, lines] of files) {
    const source = fs.readFileSync(path.join(packageDir, rel), "utf8").split(/\r?\n/);
    const kept = new Map();
    for (const [no, hits] of lines) {
      const text = (source[no - 1] ?? "").trim();
      if (text === "" || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) continue;
      kept.set(no, hits);
    }
    result.set(rel, kept);
  }
  return result;
}

/** Branch records of a c8 LCOV report, by file relative to the package (only src/*.ts): [[line, block, branch, hits], ...]. */
export function parseBranchLcov(text, packageDir) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const abs = path.resolve(packageDir, line.slice(3).trim());
      const rel = path.relative(packageDir, abs).split(path.sep).join("/");
      current = rel.startsWith("src/") && rel.endsWith(".ts") ? (files.get(rel) ?? files.set(rel, []).get(rel)) : null;
    } else if (current && line.startsWith("BRDA:")) {
      const [no, block, branch, hits] = line.slice(5).split(",");
      current.push([Number(no), Number(block), Number(branch), hits === "-" ? 0 : Number(hits)]);
    }
  }
  return files;
}

export function summariseBranches(branches) {
  let covered = 0, total = 0;
  const perFile = {};
  for (const [rel, records] of branches) {
    const c = records.filter((record) => record[3] > 0).length;
    perFile[rel] = records.length ? Math.round((c * 10000) / records.length) / 100 : 100;
    covered += c; total += records.length;
  }
  return { covered, total, pct: total ? Math.round((covered * 10000) / total) / 100 : 100, perFile };
}

export function summarise(files) {
  let covered = 0, total = 0;
  const perFile = {};
  for (const [rel, lines] of files) {
    let c = 0;
    for (const hits of lines.values()) if (hits > 0) c++;
    perFile[rel] = lines.size ? Math.round((c * 10000) / lines.size) / 100 : 100;
    covered += c; total += lines.size;
  }
  return { covered, total, pct: total ? Math.round((covered * 10000) / total) / 100 : 0, perFile };
}

/** Standard LCOV text for the given files (relative to the package), with SF paths relative to the repository root. */
export function formatLcov(files, packageDir, repoRoot = packagesRoot, branches = new Map()) {
  const prefix = path.relative(repoRoot, packageDir).split(path.sep).join("/");
  const out = [];
  for (const [rel, lines] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entries = [...lines].sort(([a], [b]) => a - b);
    out.push(`SF:${prefix ? `${prefix}/` : ""}${rel}`);
    for (const [no, hits] of entries) out.push(`DA:${no},${hits}`);
    const records = branches.get(rel) ?? [];
    for (const [no, block, branch, hits] of records) out.push(`BRDA:${no},${block},${branch},${hits}`);
    if (branches.has(rel)) out.push(`BRF:${records.length}`, `BRH:${records.filter((record) => record[3] > 0).length}`);
    out.push(`LF:${entries.length}`, `LH:${entries.filter(([, hits]) => hits > 0).length}`, "end_of_record");
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

function listTests(packageDir) {
  const dir = path.join(packageDir, "test");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `test/${name}`);
}

/**
 * Runs the package's Node tests under c8 and returns the branch records of src/*.ts. The line thresholds of c8
 * are switched off: lines come from Bun, branches are checked by the caller.
 */
export function measureBranches(packageDir, outDir) {
  const c8 = path.join(packagesRoot, "node_modules", "c8", "bin", "c8.js");
  if (!fs.existsSync(c8)) throw new Error(`c8 is not installed (${c8}); run npm ci`);
  const reportDir = path.join(outDir, "c8");
  const tests = listTests(packageDir);
  const run = spawnSync(
    process.execPath,
    [c8, "--check-coverage=false", "--reporter", "lcovonly", "--report-dir", reportDir, "--temp-directory", path.join(outDir, "c8-tmp"),
      process.execPath, "--import", "tsx/esm", "--test", ...tests],
    { cwd: packageDir, stdio: "inherit", env: process.env },
  );
  if (run.status !== 0) throw new Error(`node test under c8 failed in ${packageDir} (exit ${run.status})`);
  return parseBranchLcov(fs.readFileSync(path.join(reportDir, "lcov.info"), "utf8"), packageDir);
}

export function coverPackage(packageDir) {
  const config = JSON.parse(fs.readFileSync(path.join(packageDir, ".c8rc.json"), "utf8"));
  const minimum = Number(config.lines);
  const minimumBranches = config.branches === undefined ? undefined : Number(config.branches);
  const outDir = path.join(packageDir, "coverage");
  fs.rmSync(outDir, { recursive: true, force: true });
  const bun = process.env.C64BRIDGE_BUN_BIN || "bun";
  const tests = listTests(packageDir);
  const merged = new Map();
  for (let i = 0; i < tests.length; i += SHARD_SIZE) {
    const shard = path.join(outDir, `shard-${i / SHARD_SIZE}`);
    const run = spawnSync(bun, ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${shard}`, ...tests.slice(i, i + SHARD_SIZE)], { cwd: packageDir, stdio: "inherit", env: process.env });
    if (run.status !== 0) throw new Error(`bun test failed in ${packageDir} (exit ${run.status})`);
    const files = parseLcov(fs.readFileSync(path.join(shard, "lcov.info"), "utf8"), packageDir);
    for (const [rel, lines] of files) {
      const target = merged.get(rel) ?? merged.set(rel, new Map()).get(rel);
      for (const [no, hits] of lines) target.set(no, Math.max(target.get(no) ?? 0, hits));
    }
  }
  const codeLines = codeLinesOnly(merged, packageDir);
  const branches = minimumBranches === undefined ? new Map() : measureBranches(packageDir, outDir);
  fs.writeFileSync(path.join(outDir, "lcov.info"), formatLcov(codeLines, packageDir, packagesRoot, branches));
  const summary = summarise(codeLines);
  const branchSummary = minimumBranches === undefined ? undefined : summariseBranches(branches);
  return { name: path.basename(packageDir), minimum, minimumBranches, branches: branchSummary, ...summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).length
    ? process.argv.slice(2).map((dir) => path.resolve(dir))
    : fs.readdirSync(packagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(packagesRoot, e.name, ".c8rc.json"))).map((e) => path.join(packagesRoot, e.name));
  let failed = false;
  for (const dir of dirs) {
    const result = coverPackage(dir);
    console.log(JSON.stringify({
      package: result.name,
      lines: { covered: result.covered, total: result.total, pct: result.pct },
      minimum: result.minimum,
      below90: Object.entries(result.perFile).filter(([, pct]) => pct < result.minimum),
      ...(result.branches ? { branches: { covered: result.branches.covered, total: result.branches.total, pct: result.branches.pct }, minimumBranches: result.minimumBranches } : {}),
    }, null, 2));
    if (!(result.pct >= result.minimum)) { console.error(`Line coverage ${result.pct}% of ${result.name} is below the required ${result.minimum}%`); failed = true; }
    if (result.branches && !(result.branches.pct >= result.minimumBranches)) {
      console.error(`Branch coverage ${result.branches.pct}% of ${result.name} is below the required ${result.minimumBranches}%`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
