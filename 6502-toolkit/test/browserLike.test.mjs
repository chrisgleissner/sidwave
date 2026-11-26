import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/no-node-preload.mjs", import.meta.url));
const main = fileURLToPath(new URL("./helpers/browser-like-main.mjs", import.meta.url));

// The child process needs Node's loader hooks; Bun runs the same code paths in the other tests.
test("the built package assembles and disassembles without Buffer and without Node built-in modules", { skip: typeof globalThis.Bun !== "undefined" || !existsSync(distDir) }, () => {
  const result = spawnSync(process.execPath, ["--import", preload, main, pathToFileURL(distDir).href], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.isUint8Array, true);
  assert.deepEqual(out.prg, [0x00, 0xc0, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x4c, 0x00, 0xc0]);
  assert.equal(out.entry, 0xc000);
  assert.deepEqual(out.lines, ["LDA #$01", "STA $D020", "JMP $C000"]);
});

test("the dist files import nothing from node: and use no Buffer", { skip: !existsSync(distDir) }, () => {
  const grep = spawnSync("grep", ["-rEl", "node:|\\bBuffer\\b", distDir, "--include=*.js"], { encoding: "utf8" });
  assert.equal(grep.stdout.trim(), "", "dist files that mention node: or Buffer");
});
