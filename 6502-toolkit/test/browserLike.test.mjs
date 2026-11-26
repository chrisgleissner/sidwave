import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/no-node-preload.mjs", import.meta.url));
const main = fileURLToPath(new URL("./helpers/browser-like-main.mjs", import.meta.url));
// The child process needs Node's loader hooks; the same code paths run under Bun in the other tests.
const skip = typeof globalThis.Bun !== "undefined";

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? jsFiles(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
}

test("the build exists (run npm run build first)", { skip }, () => {
  assert.ok(existsSync(path.join(distDir, "index.js")), `${distDir} is missing; this test needs the built package`);
});

test("the built package assembles and disassembles without Buffer and without Node built-in modules", { skip }, () => {
  const result = spawnSync(process.execPath, ["--import", preload, main, pathToFileURL(distDir).href], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.isUint8Array, true);
  assert.deepEqual(out.prg, [0x00, 0xc0, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x4c, 0x00, 0xc0]);
  assert.equal(out.entry, 0xc000);
  assert.deepEqual(out.lines, ["LDA #$01", "STA $D020", "JMP $C000"]);
});

test("the dist files import no node: module and use no Buffer", { skip }, () => {
  const offenders = [];
  const pattern = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']node:|\bglobalThis\.Buffer\b|\bBuffer\.[A-Za-z]|\bnew Buffer\b/;
  for (const file of jsFiles(distDir)) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (pattern.test(code)) offenders.push(path.relative(distDir, file));
  }
  assert.deepEqual(offenders, []);
});
