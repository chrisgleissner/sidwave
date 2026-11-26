// Module loader hooks for the browser-like test: any import of a Node built-in module fails.
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules);

export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (specifier.startsWith("node:") || builtins.has(bare)) {
    throw new Error(`browser-like environment: import of Node built-in "${specifier}" from ${context.parentURL ?? "(entry)"}`);
  }
  return nextResolve(specifier, context);
}
