// Builds the example game programs of this directory into PRG files: `npm run examples:game` (after `npm run build`).
//
// Each example is a SIDWave 1.4 score (<name>.yaml) and a small 6502 program (<name>.asm). The score is compiled as a
// game build placed on the first page behind the program, its ACME symbol file is given to the assembler as
// "music.acme", and the PRG that results holds the program followed by the player and the music. Load it with
// LOAD"NAME.PRG",8,1 and RUN, or start it with `x64sc -autostart <name>.prg`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GAME_EXAMPLES = ["raster_bars", "sprite_bounce"];
const here = path.dirname(fileURLToPath(import.meta.url));
const LOAD = 0x0801;

/**
 * Builds one example. `api` provides `parseSidwave`, `compileSidwave` (sidwave) and `assemblyToPrgDetailed` (6502-toolkit),
 * so the tests can use the sources and the command can use the built package. Returns the PRG (with its load address),
 * the player build, the program's labels and the addresses that the tests need.
 */
export function buildGameExample(name, api, { dir = here, symbolsAll = false } = {}) {
  const { parseSidwave, compileSidwave, assemblyToPrgDetailed } = api;
  const yaml = fs.readFileSync(path.join(dir, `${name}.yaml`), "utf8");
  const source = fs.readFileSync(path.join(dir, `${name}.asm`), "utf8");
  const doc = parseSidwave(yaml);
  const assemble = (symbols) => assemblyToPrgDetailed(source, { fileName: `${name}.asm`, resolveInclude: () => symbols });
  // The program does not depend on the addresses of the player: assemble it once against a provisional symbol file to
  // learn where it ends, put the player on the next page, and assemble it again against the real symbols.
  const provisional = compileSidwave(doc, { target: "game", origin: 0x4000, symbols: ["acme"], measure: false });
  const first = assemble(provisional.symbols.acme);
  const programEnd = LOAD + first.prg.length - 2;
  const origin = (programEnd + 0xff) & 0xff00;
  const build = compileSidwave(doc, { target: "game", origin, symbols: ["acme"], symbolsAll });
  const program = assemble(build.symbols.acme);
  if (program.prg.length !== first.prg.length) throw new Error(`${name}: the program changed size with the player address`);
  if (build.combinedOrigin !== origin) throw new Error(`${name}: unexpected player origin`);
  const body = program.prg.subarray(2);
  const prg = new Uint8Array(2 + (origin - LOAD) + build.combined.length);
  prg[0] = LOAD & 0xff;
  prg[1] = LOAD >> 8;
  prg.set(body, 2);
  prg.set(build.combined, 2 + origin - LOAD);
  return { name, prg, build, symbols: program.symbols, yaml, origin, programEnd, start: program.symbols.get("start"), end: origin + build.combined.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sidwave = await import("../../dist/index.js");
  const { assemblyToPrgDetailed } = await import("6502-toolkit/assembler");
  const out = path.join(here, "out");
  fs.mkdirSync(out, { recursive: true });
  for (const name of GAME_EXAMPLES) {
    const result = buildGameExample(name, { parseSidwave: sidwave.parseSidwave, compileSidwave: sidwave.compileSidwave, assemblyToPrgDetailed });
    const file = path.join(out, `${name}.prg`);
    fs.writeFileSync(file, result.prg);
    const { cycles } = result.build;
    console.log(`${name}: ${result.prg.length} bytes (program $0801-$${(result.programEnd - 1).toString(16)}, player at $${result.origin.toString(16)}-$${(result.end - 1).toString(16)}), `
      + `play call worst ${cycles.worst} cycles, with effects ${cycles.withEffects.worst} (bound ${cycles.estimatedWorst}) -> ${path.relative(process.cwd(), file)}`);
  }
}
