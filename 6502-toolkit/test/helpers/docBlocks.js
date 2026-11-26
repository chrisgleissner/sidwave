// Extracts and runs the fenced code blocks of README.md and doc/*.md.
//
//  js block      -> run in a child process (fresh directory as working directory); the import specifiers of
//                   the package ("6502-toolkit", "6502-toolkit/disassembler", ...) are rewritten to src/.
//                   A following `output` block must equal the standard output exactly.
//  asm block     -> assembled with assemblyToPrg. A following `hex` block must equal the PRG bytes as upper-case
//                   hex pairs separated by spaces; a following `error` block must equal the AssemblyError message.
//                   The resolvers return fixed data: include "lib.asm" gives "  nop", incbin "data.bin" gives 1,2,3,4.
//  other blocks  -> not executed (shell commands, TypeScript signatures, plain text).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function docFiles() {
  const pages = fs.readdirSync(path.join(packageRoot, "doc")).filter((name) => name.endsWith(".md")).sort();
  return ["README.md", ...pages.map((name) => `doc/${name}`)];
}

/** Fenced blocks in file order: { info, code, line } where line is the 1-based line of the opening fence. */
export function extractBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^```(\S*)\s*$/.exec(lines[index]);
    if (!open) continue;
    const start = index;
    const body = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ info: open[1], code: body.join("\n"), line: start + 1 });
  }
  return blocks;
}

const SPECIFIERS = {
  "6502-toolkit": "index.ts",
  "6502-toolkit/assembler": "assembler.ts",
  "6502-toolkit/disassembler": "disassembler.ts",
  "6502-toolkit/opcodeInventory": "opcodeInventory.ts",
  "6502-toolkit/petscii": "petscii.ts",
  "6502-toolkit/ioRange": "ioRange.ts",
};

/** Source of a js block with the package specifiers pointing at the TypeScript sources of this checkout. */
export function localizeImports(code) {
  return code.replace(/(from\s+)(["'])(6502-toolkit(?:\/[A-Za-z]+)?)\2/g, (whole, from, quote, specifier) => {
    const file = SPECIFIERS[specifier];
    if (!file) throw new Error(`Unknown package specifier ${specifier} in a documentation example`);
    return `${from}${quote}${pathToFileURL(path.join(packageRoot, "src", file)).href}${quote}`;
  });
}

/** Runs a js block; returns { status, stdout, stderr }. The block runs in a new empty directory. */
export function runJs(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-docs-"));
  try {
    const file = path.join(dir, "example.mjs");
    fs.writeFileSync(file, localizeImports(code));
    const bun = typeof globalThis.Bun !== "undefined";
    const args = bun ? [file] : ["--import", import.meta.resolve("tsx/esm"), file];
    // The examples are documentation tests, not coverage tests. Node passes NODE_V8_COVERAGE on to child
    // processes even when the key is removed from `env`; an empty value switches it off, so the examples do not
    // add partial duplicate coverage entries of the same source files to a c8 run.
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    const run = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, files: fs.readdirSync(dir).filter((name) => name !== "example.mjs").sort() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const DOC_INCLUDES = {
  resolveInclude: (requested) => {
    if (requested === "lib.asm") return "  nop";
    throw new Error(`no such include ${requested}`);
  },
  resolveIncbin: (requested) => {
    if (requested === "data.bin") return Uint8Array.of(1, 2, 3, 4);
    throw new Error(`no such binary ${requested}`);
  },
};

export const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
