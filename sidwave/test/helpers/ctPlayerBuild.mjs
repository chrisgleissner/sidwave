// Builds CheeseCutter's raw player binary (player.bin) from a local checkout: the ACME assembler that ships in the
// checkout (src/asm, C) is compiled with the system C compiler together with a small program of our own that calls its
// library entry point, and then assembles src/c64/player_v4.acme. Nothing from the checkout is committed or copied into
// the repository; the result is cached in the temp directory. Returns undefined when the checkout or a compiler is missing.
import fs from "node:fs";
import os from "node:os";
import { homeDirectory } from "./home.mjs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = path.join(homeDirectory(), ".c64bridge/sidwave-standalone/research-src/theyamo_CheeseCutter");
const HARNESS = `#include <stdio.h>
#include <stdlib.h>
extern char* acme_assemble(const char* src, const int *length, char *error);
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); char *buf = malloc(1 << 20); size_t n = fread(buf, 1, (1 << 20) - 1, f); buf[n] = 0; fclose(f);
  int length = 0; char err[4096] = {0};
  char *out = acme_assemble(buf, &length, err);
  if (!out) { fprintf(stderr, "assemble failed: %s\\n", err); return 1; }
  FILE *o = fopen(argv[2], "wb"); fwrite(out, 1, length, o); fclose(o); return 0; }
`;
const FILES = ["acme", "alu", "basics", "cpu", "dynabuf", "encoding", "flow", "global", "input", "label", "macro", "mnemo", "output", "platform", "section", "tree"];

export function buildCtPlayer() {
  const player = path.join(SRC, "src/c64/player_v4.acme");
  if (!fs.existsSync(player)) return undefined;
  const dir = path.join(os.tmpdir(), "sidwave-ct-player");
  const out = path.join(dir, "player.bin");
  if (fs.existsSync(out)) return fs.readFileSync(out);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "harness.c"), HARNESS);
    execFileSync("gcc", ["-std=gnu99", "-O1", "-w", "-I", path.join(SRC, "src/asm"), ...FILES.map((f) => path.join(SRC, "src/asm", `${f}.c`)), path.join(dir, "harness.c"), "-lm", "-o", path.join(dir, "acme")], { stdio: "ignore" });
    execFileSync(path.join(dir, "acme"), [player, out], { stdio: "ignore" });
    return fs.readFileSync(out);
  } catch { return undefined; }
}
