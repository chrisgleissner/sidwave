#!/usr/bin/env node
/**
 * Fresh-clone check: clones the repository (committed state), runs `npm ci` and `npm run build`, then runs
 * `npx sidwave --help` in the clone. This fails when the workspace bin link of sidwave is missing because npm
 * created links before dist/ existed.
 *
 *   node scripts/check-fresh-clone.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-clone-"));
const clone = path.join(work, "repo");
const step = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-3000)}`);
  return r.stdout;
};
try {
  step("git", ["clone", "--quiet", root, clone], work);
  step("npm", ["ci", "--no-audit", "--no-fund"], clone);
  step("npm", ["run", "build"], clone);
  const help = step("npx", ["--no-install", "sidwave", "--help"], clone);
  if (!/sidwave/i.test(help)) throw new Error(`unexpected output of npx sidwave --help:\n${help.slice(0, 500)}`);
  console.log("fresh clone ok: npx sidwave --help works after npm ci and npm run build");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
