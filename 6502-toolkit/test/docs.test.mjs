import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import * as api from "../src/index.js";
import { lookupNamedPetscii } from "../src/petscii.js";
import { docFiles, packageRoot } from "./helpers/docBlocks.js";

const read = (file) => fs.readFileSync(path.join(packageRoot, file), "utf8");
const manifest = JSON.parse(read("package.json"));

/** The anchor GitHub makes for a heading: lower case, punctuation removed, spaces to dashes. */
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

function headings(markdown) {
  let fenced = false;
  const found = [];
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    const match = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (match) found.push(match[1].replace(/`/g, ""));
  }
  return found;
}

test("every relative link in README.md and doc/*.md points to an existing file and heading", () => {
  const problems = [];
  for (const file of docFiles()) {
    const text = read(file);
    const withoutFences = text.replace(/^```[\s\S]*?^```/gm, "");
    for (const match of withoutFences.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [filePart, anchor] = target.split("#");
      const resolved = filePart === "" ? path.join(packageRoot, file) : path.resolve(packageRoot, path.dirname(file), filePart);
      if (!fs.existsSync(resolved)) {
        problems.push(`${file}: ${target} does not exist`);
        continue;
      }
      if (anchor && resolved.endsWith(".md")) {
        const anchors = headings(fs.readFileSync(resolved, "utf8")).map(slug);
        if (!anchors.includes(anchor)) problems.push(`${file}: ${target} has no heading with the anchor #${anchor}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("README.md links to every page of doc/", () => {
  const readme = read("README.md");
  for (const page of fs.readdirSync(path.join(packageRoot, "doc")).filter((name) => name.endsWith(".md"))) {
    assert.ok(readme.includes(`(doc/${page}`), `README.md does not link to doc/${page}`);
  }
});

test("doc/api.md has a heading for every runtime export and every exported type", () => {
  const apiHeadings = new Set(headings(read("doc/api.md")).flatMap((heading) => heading.split(" and ")));
  const runtime = Object.keys(api);
  assert.ok(runtime.length > 20);
  const types = [];
  for (const file of fs.readdirSync(path.join(packageRoot, "src")).filter((name) => name.endsWith(".ts"))) {
    for (const match of read(`src/${file}`).matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)) types.push(match[1]);
  }
  assert.deepEqual(types.sort(), ["AssembleOptions", "AssemblyResult", "BraceToken", "DisassembleOptions", "DisassemblyLine", "OpcodeAddressingMode", "OpcodeInventoryEntry", "ScreenAsciiOptions"]);
  const missing = [...new Set([...runtime, ...types])].filter((name) => !apiHeadings.has(name));
  assert.deepEqual(missing, []);
});

test("README.md mentions every runtime export", () => {
  const readme = read("README.md");
  const missing = Object.keys(api).filter((name) => !readme.includes(name));
  assert.deepEqual(missing, []);
});

test("package.json publishes README.md, LICENSE, doc and dist, and exports the documented subpaths", () => {
  assert.deepEqual(manifest.files, ["dist/**", "!dist/.tsbuildinfo", "doc", "CHANGELOG.md", "LICENSE", "README.md"]);
  assert.deepEqual(Object.keys(manifest.exports), [".", "./assembler", "./disassembler", "./opcodeInventory", "./petscii", "./ioRange", "./package.json"]);
  const api = read("doc/api.md");
  for (const subpath of Object.keys(manifest.exports).filter((key) => key.startsWith("./") && key !== "./package.json")) {
    assert.ok(api.includes(`6502-toolkit/${subpath.slice(2)}`), `doc/api.md does not name 6502-toolkit/${subpath.slice(2)}`);
  }
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("the control-code table in doc/commodore.md matches the names the package accepts", () => {
  const rows = read("doc/commodore.md").split("\n").filter((line) => /^\| \d+ \| \$[0-9A-F]{2} \|/.test(line));
  assert.equal(rows.length, 48);
  for (const row of rows) {
    const [, code, hex, names] = row.split("|").map((cell) => cell.trim());
    assert.equal(hex, `$${Number(code).toString(16).toUpperCase().padStart(2, "0")}`);
    for (const name of names.split(", ").map((entry) => entry.replace(/`/g, ""))) {
      assert.equal(lookupNamedPetscii(name), Number(code), `${name} should be code ${code}`);
    }
  }
});

test("pages avoid emoji and marketing words", () => {
  const banned = /\b(great|excellent|best|blazing|powerful|seamless|seamlessly|effortless|cutting-edge|robust|world-class)\b/i;
  for (const file of docFiles()) {
    const text = read(file);
    assert.equal(banned.test(text), false, `${file} uses a marketing word`);
    assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${file} contains an emoji`);
  }
});
