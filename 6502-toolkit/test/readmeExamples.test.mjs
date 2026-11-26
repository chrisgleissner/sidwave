import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { AssemblyError, assemblyToPrg } from "../src/assembler.js";
import { DOC_INCLUDES, docFiles, extractBlocks, packageRoot, runJs, toHex } from "./helpers/docBlocks.js";

/**
 * Every fenced js and asm block of README.md and doc/*.md is executed here. See helpers/docBlocks.js for the
 * rules. A page whose example output changes has to be updated together with the code.
 */
for (const file of docFiles()) {
  const text = fs.readFileSync(path.join(packageRoot, file), "utf8");
  const blocks = extractBlocks(text);
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    const where = `${file}:${block.line}`;

    if (block.info === "js") {
      test(`example ${where} runs and prints the documented output`, () => {
        const result = runJs(block.code);
        assert.equal(result.stderr, "", `stderr of ${where}`);
        assert.equal(result.status, 0, `exit status of ${where}`);
        if (next?.info === "output") assert.equal(result.stdout, `${next.code}\n`, `stdout of ${where}`);
      });
    }

    if (block.info === "asm") {
      test(`example ${where} assembles to the documented result`, () => {
        if (next?.info === "error") {
          let thrown;
          try {
            assemblyToPrg(block.code, DOC_INCLUDES);
          } catch (error) {
            thrown = error;
          }
          assert.ok(thrown instanceof AssemblyError, `${where} must fail with an AssemblyError`);
          assert.equal(thrown.message, next.code);
          return;
        }
        const prg = assemblyToPrg(block.code, DOC_INCLUDES);
        if (next?.info === "hex") assert.equal(toHex(prg), next.code);
      });
    }
  });
}

test("every documentation page has at least one executed example, and no block uses an unknown kind", () => {
  const known = new Set(["js", "asm", "hex", "error", "output", "sh", "ts", "text", "json"]);
  for (const file of docFiles()) {
    const blocks = extractBlocks(fs.readFileSync(path.join(packageRoot, file), "utf8"));
    for (const block of blocks) assert.ok(known.has(block.info), `${file}:${block.line} uses the fence kind "${block.info}"`);
    // `hex`, `error` and `output` blocks belong to the block before them.
    blocks.forEach((block, index) => {
      if (["hex", "error", "output"].includes(block.info)) {
        const expected = block.info === "output" ? "js" : block.info === "hex" || block.info === "error" ? "asm" : "";
        assert.equal(blocks[index - 1]?.info, expected, `${file}:${block.line}: a ${block.info} block must follow a ${expected} block`);
      }
    });
  }
});
