// Shared pieces of the format import and export tests: seeded mutation fuzzing and CPU-time measurement.
import { prng } from "./sidwaveFuzzKit.mjs";

/** Mutates a byte array in one of several ways: flip, overwrite, insert, delete, truncate, duplicate a slice. */
export function mutateBytes(input, r) {
  const b = Array.from(input);
  const edits = 1 + Math.floor(r() * 4);
  for (let e = 0; e < edits; e++) {
    const at = b.length ? Math.floor(r() * b.length) : 0;
    switch (Math.floor(r() * 7)) {
      case 0: if (b.length) b[at] ^= 1 << Math.floor(r() * 8); break;
      case 1: if (b.length) b[at] = Math.floor(r() * 256); break;
      case 2: b.splice(at, 0, Math.floor(r() * 256)); break;
      case 3: if (b.length) b.splice(at, 1 + Math.floor(r() * 4)); break;
      case 4: b.length = Math.floor(r() * (b.length + 1)); break;
      case 5: { const n = Math.floor(r() * 32); b.splice(at, 0, ...b.slice(at, at + n)); break; }
      default: if (b.length) b[at] = [0, 0xff, 0x7f, 0x80][Math.floor(r() * 4)]; break;
    }
  }
  return Uint8Array.from(b);
}

/**
 * Runs `cases` mutated inputs through `parse`. Every call must return or throw an instance of one of the `typed`
 * classes, and finish within `limitMs`. Returns counts.
 */
export function fuzz({ seed, cases, base, parse, typed, limitMs = 2000, mutate = mutateBytes }) {
  const r = prng(seed);
  let accepted = 0, rejected = 0, slowest = 0;
  for (let i = 0; i < cases; i++) {
    const input = mutate(base[Math.floor(r() * base.length)], r);
    const t0 = performance.now();
    try { parse(input); accepted++; } catch (error) {
      if (!typed.some((T) => error instanceof T)) throw new Error(`case ${i} (seed ${seed}): untyped ${error?.constructor?.name}: ${error?.message}`);
      rejected++;
    }
    const ms = performance.now() - t0;
    slowest = Math.max(slowest, ms);
    if (ms > limitMs) throw new Error(`case ${i} (seed ${seed}) took ${ms.toFixed(0)} ms`);
  }
  return { accepted, rejected, slowest };
}

/** CPU time of `fn` in milliseconds (user plus system of this process). */
export function cpuMs(fn) {
  const before = process.cpuUsage();
  const value = fn();
  const after = process.cpuUsage(before);
  return { ms: (after.user + after.system) / 1000, value };
}
