#!/usr/bin/env node
/**
 * Type check of the packed packages as a consumer sees them. Verifies that every entry in each package's `exports`
 * map that points at JavaScript has a `types` entry, packs 6502-toolkit and sidwave, installs the tarballs in a
 * temporary project, writes a TypeScript file that imports every subpath, and runs tsc --noEmit on it with the
 * repository's TypeScript. Run the build first (npm run build); the script does not build.
 *
 *   node scripts/check-types-consumer.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-4000)}`);
  return r.stdout;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-types-"));
try {
  const tarballs = [];
  const imports = [];
  for (const dir of ["6502-toolkit", "sidwave"]) {
    const pkgDir = path.join(root, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (!fs.existsSync(path.join(pkgDir, "dist"))) throw new Error(`${dir}/dist is missing; run the build first`);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === "string") continue; // data files and package.json
      if (typeof target.types !== "string") throw new Error(`${pkg.name} exports "${subpath}" has no types entry`);
      if (!fs.existsSync(path.join(pkgDir, target.types))) throw new Error(`${pkg.name} exports "${subpath}": ${target.types} does not exist`);
      imports.push(subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`);
    }
    const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], pkgDir));
    tarballs.push(path.join(work, info.filename));
  }

  const consumer = path.join(work, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "types-consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", ...tarballs], consumer);
  fs.writeFileSync(path.join(consumer, "consumer.ts"), `${imports.map((name, i) => `import * as m${i} from "${name}";`).join("\n")}\nexport const all = [${imports.map((_, i) => `m${i}`).join(", ")}];\n`);
  fs.writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false,
      types: ["node"], typeRoots: [path.join(root, "node_modules", "@types")],
    },
    files: ["consumer.ts"],
  }));
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], consumer);
  console.log(`types consumer ok: ${imports.length} subpaths (${imports.join(", ")})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
