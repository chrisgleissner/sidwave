// Helpers shared by the table-driven assembler tests.
import { assemblyToPrg, assemblyToPrgDetailed } from "../../src/assembler.js";

/** Assembles `source` at $C000 (an org line is prepended) and returns the code bytes without the load address. */
export function code(source, options) {
  return [...assemblyToPrg(`.org $C000\n${source}`, options)].slice(2);
}

/** Assembles `source` exactly as given and returns the whole PRG as an array of numbers. */
export function prg(source, options) {
  return [...assemblyToPrg(source, options)];
}

export function detailed(source, options) {
  return assemblyToPrgDetailed(source, options);
}

/** The AssemblyError thrown for `source`; fails when assembly succeeds. */
export function failure(source, options) {
  try {
    assemblyToPrg(source, options);
  } catch (error) {
    return error;
  }
  throw new Error(`Expected an AssemblyError for: ${JSON.stringify(source)}`);
}

/** Message format of AssemblyError: "file:line: text" followed by the trimmed source line. */
export function formatted(file, line, text, shown) {
  return `${file}:${line}: ${text}${shown ? `\n    ${shown}` : ""}`;
}
