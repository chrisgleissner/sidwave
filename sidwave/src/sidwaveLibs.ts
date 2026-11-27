// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// SIDWave 1.4 asset libraries: `imports` of a score, resolved at compile time.
//
// A library is a SIDWave file with `library` metadata and the maps `instruments`, `patterns` and `effects`.
// Resolution replaces the `imports` of a score by the library items the score refers to, under the names
// `<namespace>.<name>`. The result is an ordinary score (without `imports`), so the compiler and the player do not
// know about libraries and a score that uses them compiles to the same bytes as the equivalent flattened score.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { formatSidwave } from "./format/sidwaveFormat.js";
import { SidwaveValidationError } from "./sidwave.js";
import { DEFAULT_MAX_PCM_FILE_BYTES, type SidwaveUsedLibrary } from "./sidwavePcm.js";

export const SIDWAVE_LIBRARY_LIMITS = {
  /** Deepest chain of libraries that import libraries, counted from the score. */
  maxDepth: 16,
  /** Most distinct library files of one score. */
  maxFiles: 64,
  /** Bytes of one library file. */
  maxFileBytes: 256 * 1024,
  /** Bytes of all library files of one score. */
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

export interface SidwaveLibraryMeta {
  name: string;
  version: string;
  licence: string;
  provenance: { author: string; source: string; created: string };
}

export interface ImportResolverOptions {
  /** The score file. Local library paths are relative to the importing file and must stay inside its directory. */
  file: string;
  /** More directories that libraries may be read from (the explicit library search path). */
  allowedDirs?: readonly string[];
}

export interface ResolvedImports {
  score: Record<string, unknown>;
  libraries: SidwaveUsedLibrary[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const LIBRARY_KEYS = new Set(["sidwave", "library", "imports", "instruments", "patterns", "effects"]);
const IMPORT_KEYS = new Set(["as", "from", "version", "sha256", "effects"]);
const QUALIFIED = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isMap = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, detail: string): never {
  throw new SidwaveValidationError(path, detail);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Versions

type Version = [number, number, number];

function parseVersion(text: string): Version | undefined {
  const m = SEMVER.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Ranges: exact `1.2.3`, `^1.2.0`, `~1.2.0`, partial `1` or `1.2` (or with x or *), comparators `>=` `>` `<=` `<` `=`
 * separated by spaces (all must hold), and alternatives separated by `||`. Pre-release tags are not supported.
 */
export function satisfiesVersion(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) throw new Error(`"${version}" is not a version such as 1.2.3`);
  return range.split("||").some((set) => {
    const tokens = set.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error("empty version range");
    return tokens.every((token) => {
      const m = /^(\^|~|>=|<=|>|<|=)?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(token);
      if (!m) throw new Error(`cannot read the version range "${token}"`);
      const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[x*]$/i.test(p) ? undefined : Number(p)));
      const wild = parts.indexOf(undefined);
      const given = (wild < 0 ? 3 : wild);
      if (parts.slice(given).some((p) => p !== undefined)) throw new Error(`cannot read the version range "${token}"`);
      const low: Version = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      const op = m[1] ?? "";
      const upper = (kind: "caret" | "tilde" | "partial"): Version => {
        if (given === 0) return [Infinity, 0, 0];
        if (kind === "caret") {
          if (low[0] > 0 || given === 1) return [low[0] + 1, 0, 0];
          if (given === 2 || low[1] > 0) return [0, low[1] + 1, 0];
          return [0, 0, low[2] + 1];
        }
        if (kind === "tilde" && given === 1) return [low[0] + 1, 0, 0];
        if (given === 1) return [low[0] + 1, 0, 0];
        return [low[0], low[1] + 1, 0];
      };
      if (op === "^") return compare(v, low) >= 0 && compare(v, upper("caret")) < 0;
      if (op === "~") return compare(v, low) >= 0 && compare(v, upper("tilde")) < 0;
      if (op === ">=") return compare(v, low) >= 0;
      if (op === ">") return given === 3 ? compare(v, low) > 0 : compare(v, upper("partial")) >= 0;
      if (op === "<=") return given === 3 ? compare(v, low) <= 0 : compare(v, upper("partial")) < 0;
      if (op === "<") return compare(v, low) < 0;
      // exact or partial
      return given === 3 ? compare(v, low) === 0 : compare(v, low) >= 0 && compare(v, upper("partial")) < 0;
    });
  });
}

// ---------------------------------------------------------------------------
// Reading libraries

interface LoadedImport { as: string; lib: LoadedLibrary }

interface LoadedLibrary {
  /** Real path of the file. */
  file: string;
  /** Display name used in messages (relative to the score directory when possible). */
  label: string;
  meta: SidwaveLibraryMeta;
  /** Hash of this file's canonical text alone. */
  contentHash: string;
  /** The pin: the content hash, combined with the pins of the libraries it imports (Merkle style). */
  sha256: string;
  size: number;
  instruments: Record<string, Record<string, any>>;
  patterns: Record<string, Record<string, any>>;
  effects: Record<string, Record<string, any>>;
  imports: LoadedImport[];
  resolved: boolean;
  /** 0 for a library without imports, otherwise 1 plus the greatest height of the libraries it imports. */
  height: number;
  /** The `from` of every import of this file, in order, with the entry's other fields. */
  entries: ImportEntry[];
}

export interface ImportEntry {
  as: string;
  from: string;
  version?: string;
  sha256?: string;
  effects: string[];
}

/** SHA-256 of the canonical library text: the formatted text without the `from` of each import (its location). */
export function canonicalLibraryHash(text: string): string {
  let formatted: string;
  try {
    formatted = formatSidwave(text);
  } catch (error) {
    throw new Error(`cannot format the library: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const doc = YAML.parseDocument(formatted);
  const imports = doc.get("imports");
  if (YAML.isSeq(imports)) for (const item of imports.items) if (YAML.isMap(item)) item.delete("from");
  return sha256Hex(doc.toString({ indent: 2, lineWidth: 0 }));
}

function licenceOk(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/.test(text.replace(/[()]/g, "").replace(/\s+/g, " ").trim());
}

function dateText(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function parseEntries(raw: unknown, path: string): ImportEntry[] {
  if (!Array.isArray(raw)) fail(path, "expected a list of imports such as [{ as: drums, from: \"./libs/drums.yaml\" }]");
  const seen = new Set<string>();
  return raw.map((item, i): ImportEntry => {
    const at = `${path}[${i}]`;
    if (!isMap(item)) fail(at, "expected an import mapping with as and from");
    for (const key of Object.keys(item)) if (!IMPORT_KEYS.has(key)) fail(`${at}.${key}`, `unknown import field (use ${[...IMPORT_KEYS].join(", ")})`);
    if (typeof item.as !== "string" || !NAME.test(item.as)) fail(`${at}.as`, "expected a namespace made of letters, digits and underscores");
    if (item.as === "lib") fail(`${at}.as`, "the namespace lib is reserved for the built-in instruments");
    if (seen.has(item.as)) fail(`${at}.as`, `the namespace ${item.as} is imported twice`);
    seen.add(item.as);
    if (typeof item.from !== "string" || item.from.trim() === "") fail(`${at}.from`, "expected the path of a library file or pkg:<package>/<file>");
    if (item.version !== undefined) {
      if (typeof item.version !== "string") fail(`${at}.version`, "expected a version range such as \"^1.2.0\"");
      try { satisfiesVersion("0.0.0", item.version); } catch (error) { fail(`${at}.version`, (error as Error).message); }
    }
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !SHA256.test(item.sha256))) fail(`${at}.sha256`, "expected 64 hexadecimal digits");
    if (item.effects !== undefined && (!Array.isArray(item.effects) || item.effects.some((e: unknown) => typeof e !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(e)))) {
      fail(`${at}.effects`, "expected a list of effect names of the library");
    }
    return {
      as: item.as, from: item.from, ...(item.version === undefined ? {} : { version: item.version }),
      ...(item.sha256 === undefined ? {} : { sha256: item.sha256.toLowerCase() }), effects: [...(item.effects ?? [])],
    };
  });
}

class Loader {
  readonly roots: string[];
  readonly scoreRoot: string;
  readonly cache = new Map<string, LoadedLibrary>();
  totalBytes = 0;

  constructor(readonly scoreFile: string, allowedDirs: readonly string[]) {
    this.scoreRoot = realpathSync(dirname(resolve(scoreFile)));
    this.roots = [this.scoreRoot, ...allowedDirs.map((dir) => realpathSync(resolve(dir)))];
  }

  inside(target: string): boolean {
    return this.roots.some((root) => {
      const rel = relative(root, target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }

  /** The file relative to the directory it was found in, so that messages never show host paths. */
  label(file: string): string {
    const root = this.roots.find((r) => this.insideRoot(r, file)) ?? this.scoreRoot;
    return relative(root, file).split(sep).join("/");
  }

  /** The real path of the file an import names, or a validation error. */
  locate(from: string, importingFile: string, path: string): string {
    if (from.includes("\0")) fail(path, "the library path contains a NUL character");
    if (/^(?:https?|file|data|ftp|sftp|wss?):/i.test(from) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(from) || from.startsWith("//")) {
      fail(path, `${JSON.stringify(from)} is a URL; SIDWave never fetches libraries from the network`);
    }
    if (isAbsolute(from) || from.startsWith("/") || from.startsWith("\\") || /^[A-Za-z]:/.test(from)) {
      fail(path, `absolute library paths are not allowed (${JSON.stringify(from)}); use a path relative to the importing file`);
    }
    if (from.startsWith("pkg:")) return this.locatePackage(from.slice(4), importingFile, path);
    return this.confine(resolve(dirname(importingFile), from), from, path);
  }

  private locatePackage(spec: string, importingFile: string, path: string): string {
    const parts = spec.split("/");
    const nameLength = spec.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, nameLength).join("/");
    const rest = parts.slice(nameLength);
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || rest.length === 0 || rest.some((p) => p === "" || p === "." || p === "..")) {
      fail(path, `pkg:${spec} must look like pkg:<package>/<file inside the package>`);
    }
    // Node resolution: node_modules of the importing file's directory, then of each parent up to the confinement root.
    const importingDir = dirname(importingFile);
    const base = this.roots.find((root) => this.insideRoot(root, importingDir)) ?? this.scoreRoot;
    const candidates: string[] = [];
    for (let dir = importingDir; ; dir = dirname(dir)) {
      candidates.push(join(dir, "node_modules", name, ...rest));
      if (dir === base || dirname(dir) === dir) break;
    }
    for (const root of this.roots.slice(1)) candidates.push(join(root, "node_modules", name, ...rest));
    for (const candidate of candidates) if (existsSync(candidate)) return this.confine(candidate, `pkg:${spec}`, path);
    return fail(path, `package file pkg:${spec} was not found in a node_modules directory of the score directory${this.roots.length > 1 ? " or the library search path" : ""}`);
  }

  private insideRoot(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private confine(candidate: string, shown: string, path: string): string {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch (error) {
      if (!this.inside(resolve(candidate))) fail(path, `library ${JSON.stringify(shown)} is outside the score directory and the library search path; pass --allow-dir to add a directory`);
      return fail(path, `library ${JSON.stringify(shown)} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (!this.inside(real)) {
      fail(path, `library ${JSON.stringify(shown)} is outside the score directory and the library search path; pass --allow-dir to add a directory`);
    }
    if (!statSync(real).isFile()) fail(path, `library ${JSON.stringify(shown)} is not a file`);
    return real;
  }

  /** Reads one library file, with the checks of its own header. Cached per real path. */
  load(file: string, path: string): LoadedLibrary {
    const cached = this.cache.get(file);
    if (cached) return cached;
    if (this.cache.size >= SIDWAVE_LIBRARY_LIMITS.maxFiles) fail(path, `a score may use at most ${SIDWAVE_LIBRARY_LIMITS.maxFiles} library files`);
    const label = this.label(file);
    const size = statSync(file).size;
    if (size > SIDWAVE_LIBRARY_LIMITS.maxFileBytes) fail(path, `library ${label} is ${size} bytes; the limit is ${SIDWAVE_LIBRARY_LIMITS.maxFileBytes}`);
    this.totalBytes += size;
    if (this.totalBytes > SIDWAVE_LIBRARY_LIMITS.maxTotalBytes) fail(path, `the libraries add up to more than ${SIDWAVE_LIBRARY_LIMITS.maxTotalBytes} bytes`);
    const text = readFileSync(file, "utf8");
    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (error) {
      return fail(path, `library ${label} could not be parsed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    const at = (p: string) => `${path} (${label}) ${p}`;
    if (!isMap(raw)) fail(at("$"), "a library is a mapping with library, instruments, patterns and effects");
    for (const key of Object.keys(raw)) {
      if (!LIBRARY_KEYS.has(key)) fail(at(`$.${key}`), `not allowed in a library (a library has ${[...LIBRARY_KEYS].join(", ")} and no timeline)`);
    }
    if (!["1.4", "1.5"].includes(String(raw.sidwave))) fail(at("$.sidwave"), "a library requires sidwave: 1.4 or 1.5");
    const lib = raw.library;
    if (!isMap(lib)) fail(at("$.library"), "missing library metadata (name, version, licence, provenance)");
    for (const key of Object.keys(lib)) if (!["name", "version", "licence", "provenance"].includes(key)) fail(at(`$.library.${key}`), "unknown library field");
    if (typeof lib.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lib.name)) fail(at("$.library.name"), "expected a short name of letters, digits, dots, dashes and underscores");
    if (typeof lib.version !== "string" || !parseVersion(lib.version)) fail(at("$.library.version"), "expected a version such as 1.2.0");
    if (typeof lib.licence !== "string" || !licenceOk(lib.licence)) fail(at("$.library.licence"), "expected an SPDX licence identifier or expression such as CC0-1.0 or MIT OR Apache-2.0");
    const prov = lib.provenance;
    if (!isMap(prov)) fail(at("$.library.provenance"), "expected { author, source, created }");
    for (const key of Object.keys(prov)) if (!["author", "source", "created"].includes(key)) fail(at(`$.library.provenance.${key}`), "unknown provenance field");
    const created = dateText(prov.created);
    if (typeof prov.author !== "string" || !prov.author.trim()) fail(at("$.library.provenance.author"), "expected the author");
    if (typeof prov.source !== "string" || !prov.source.trim()) fail(at("$.library.provenance.source"), "expected where the library comes from (a URL, a repository or \"original\")");
    if (!created) fail(at("$.library.provenance.created"), "expected a date such as 2026-11-27");
    const bodies: Record<"instruments" | "patterns" | "effects", Record<string, Record<string, any>>> = { instruments: {}, patterns: {}, effects: {} };
    for (const kind of ["instruments", "patterns", "effects"] as const) {
      const value = raw[kind];
      if (value === undefined) continue;
      if (!isMap(value)) fail(at(`$.${kind}`), `expected a mapping of ${kind} names to definitions`);
      for (const [name, def] of Object.entries(value)) {
        if (!NAME.test(name)) fail(at(`$.${kind}.${name}`), "names are letters, digits and underscores, starting with a letter or underscore");
        if (!isMap(def)) fail(at(`$.${kind}.${name}`), "expected a mapping");
        bodies[kind][name] = def;
      }
    }
    const entries = raw.imports === undefined ? [] : parseEntries(raw.imports, at("$.imports"));
    const loaded: LoadedLibrary = {
      file, label, size, contentHash: "", sha256: "", imports: [], resolved: false, height: 0, entries, ...bodies,
      meta: { name: lib.name, version: lib.version, licence: lib.licence, provenance: { author: prov.author, source: prov.source, created } },
    };
    try {
      loaded.contentHash = canonicalLibraryHash(text);
      loaded.sha256 = loaded.contentHash;
    } catch (error) {
      fail(at("$"), (error as Error).message);
    }
    this.cache.set(file, loaded);
    return loaded;
  }

  /** Reads the libraries of `entries`, which belong to `importingFile`, and checks pins, cycles and depth. */
  resolveEntries(entries: ImportEntry[], importingFile: string, basePath: string, stack: string[]): LoadedImport[] {
    return entries.map((entry, i) => {
      const path = `${basePath}[${i}]`;
      const file = this.locate(entry.from, importingFile, `${path}.from`);
      const chain = [...stack, file];
      if (stack.includes(file)) fail(path, `import cycle: ${chain.slice(chain.indexOf(file)).map((f) => this.label(f)).join(" -> ")}`);
      const lib = this.load(file, path);
      if (entry.version !== undefined) {
        let ok: boolean;
        try { ok = satisfiesVersion(lib.meta.version, entry.version); } catch (error) { return fail(`${path}.version`, (error as Error).message); }
        if (!ok) fail(`${path}.version`, `library ${lib.meta.name} (${lib.label}) is version ${lib.meta.version}, which does not satisfy ${entry.version}`);
      }
      if (!lib.resolved) {
        lib.imports = this.resolveEntries(lib.entries, file, `${path} (${lib.label}) $.imports`, chain);
        lib.height = lib.imports.length === 0 ? 0 : 1 + Math.max(...lib.imports.map((i) => i.lib.height));
        lib.resolved = true;
        const nested = [...new Set(lib.imports.map((i) => i.lib.sha256))].sort();
        if (nested.length) lib.sha256 = sha256Hex([lib.contentHash, ...nested].join("\n"));
      }
      if (entry.sha256 !== undefined && entry.sha256 !== lib.sha256) {
        fail(`${path}.sha256`, `library ${lib.meta.name} (${lib.label}) has sha256 ${lib.sha256}, but the import pins ${entry.sha256}`);
      }
      if (stack.length + 1 + lib.height > SIDWAVE_LIBRARY_LIMITS.maxDepth) fail(path, `libraries import each other more than ${SIDWAVE_LIBRARY_LIMITS.maxDepth} levels deep`);
      return { as: entry.as, lib };
    });
  }
}

export interface LibraryClosureEntry {
  /** Real path of the library file. */
  file: string;
  meta: SidwaveLibraryMeta;
  sha256: string;
  /** The imports of this file with the libraries they resolve to. */
  imports: Array<{ as: string; file: string }>;
}

/** Every library the score depends on, directly or not, in first-seen order. */
export function libraryClosure(scoreFile: string, entries: ImportEntry[], allowedDirs: readonly string[] = []): LibraryClosureEntry[] {
  const loader = new Loader(scoreFile, allowedDirs);
  const imports = loader.resolveEntries(entries, resolve(scoreFile), "$.imports", []);
  const out: LibraryClosureEntry[] = [];
  const seen = new Set<string>();
  const visit = (lib: LoadedLibrary) => {
    if (seen.has(lib.file)) return;
    seen.add(lib.file);
    out.push({ file: lib.file, meta: lib.meta, sha256: lib.sha256, imports: lib.imports.map((i) => ({ as: i.as, file: i.lib.file })) });
    lib.imports.forEach((i) => visit(i.lib));
  };
  imports.forEach((i) => visit(i.lib));
  return out;
}

export function readImportEntries(raw: unknown): ImportEntry[] {
  return parseEntries(raw, "$.imports");
}

// ---------------------------------------------------------------------------
// Expansion

interface Item { qualified: string; def: Record<string, any>; owner: LoadedLibrary; namespace: string }

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, visit));
  else if (isMap(value)) Object.values(value).forEach((v) => walkStrings(v, visit));
}

/**
 * Rewrites the instrument references of a library pattern into qualified names: `@bell` becomes `@ns.bell` and the
 * instruments of a drum kit likewise. `lib:` names and names the library does not define stay as written.
 */
function qualifyPattern(def: Record<string, any>, resolveName: (name: string) => string): Record<string, any> {
  const rewrite = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return value.replace(/@([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g, (_m, name: string) => `@${resolveName(name)}`);
    if (Array.isArray(value)) return value.map((v) => rewrite(v));
    if (isMap(value)) {
      if (key === "kit") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? resolveName(v) : v]));
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
    }
    return value;
  };
  return rewrite(def) as Record<string, any>;
}

function voiceIdOf(voice: Record<string, any>, sids: unknown): number | undefined {
  if (typeof voice.id === "number") return voice.id;
  if (typeof voice.id === "string" && /^\d+$/.test(voice.id)) return Number(voice.id);
  if (voice.sid !== undefined && voice.channel !== undefined && Array.isArray(sids)) {
    const chip = sids.findIndex((s) => isMap(s) && String(s.id) === String(voice.sid));
    const channel = Number(voice.channel);
    if (chip >= 0 && channel >= 1 && channel <= 3) return chip * 3 + channel;
  }
  return undefined;
}

export function expandImports(raw: Record<string, unknown>, options: ImportResolverOptions): ResolvedImports {
  const score = structuredClone(raw) as Record<string, any>;
  const entries = parseEntries(score.imports, "$.imports");
  delete score.imports;
  const loader = new Loader(options.file, options.allowedDirs ?? []);
  const scoreFile = resolve(options.file);
  const imports = loader.resolveEntries(entries, scoreFile, "$.imports", []);

  // Tables of every item the score can name: instruments and patterns by `ns.name`, effects by `ns_name`.
  const instruments = new Map<string, Item>();
  const patterns = new Map<string, Item>();
  const effects = new Map<string, Item>();
  const register = (list: LoadedImport[], prefix: string) => {
    for (const { as, lib } of list) {
      const ns = `${prefix}${as}`;
      const resolveName = (name: string): string => {
        if (!name.includes(".") && hasOwn(lib.instruments, name)) return `${ns}.${name}`;
        const dot = name.indexOf(".");
        if (dot > 0 && lib.imports.some((i) => i.as === name.slice(0, dot))) return `${ns}.${name}`;
        return name;
      };
      for (const [name, def] of Object.entries(lib.instruments)) instruments.set(`${ns}.${name}`, { qualified: `${ns}.${name}`, def: structuredClone(def), owner: lib, namespace: ns });
      for (const [name, def] of Object.entries(lib.patterns)) patterns.set(`${ns}.${name}`, { qualified: `${ns}.${name}`, def: qualifyPattern(def, resolveName), owner: lib, namespace: ns });
      for (const [name, def] of Object.entries(lib.effects)) effects.set(`${ns}.${name}`, { qualified: `${ns.replace(/\./g, "_")}_${name}`, def: structuredClone(def), owner: lib, namespace: ns });
      register(lib.imports, `${ns}.`);
    }
  };
  register(imports, "");

  // Collisions with the score's own names.
  if (isMap(score.instruments)) {
    for (const name of Object.keys(score.instruments)) if (instruments.has(name)) fail(`$.instruments.${name}`, `collides with the library instrument ${name}; the namespace ${name.split(".")[0]} belongs to an import`);
  }

  const included = new Set<Item>();
  const injected = new Set<string>();
  // Library patterns: added to every voice whose layers name them.
  const voices: any[] = Array.isArray(score.voices) ? score.voices : [];
  const addPattern = (voiceKey: string, name: string, path: string) => {
    const item = patterns.get(name);
    if (!item) return;
    const id = Number(voiceKey.slice(1));
    const index = voices.findIndex((v) => isMap(v) && voiceIdOf(v, score.sids) === id);
    if (index < 0) return;
    const voice = voices[index];
    if (voice.patterns === undefined) voice.patterns = {};
    if (!isMap(voice.patterns)) return;
    if (hasOwn(voice.patterns, name)) {
      if (!injected.has(`${index}:${name}`)) fail(`$.voices[${index}].patterns.${name}`, `collides with the library pattern ${name} used at ${path}`);
      return;
    }
    voice.patterns[name] = structuredClone(item.def);
    injected.add(`${index}:${name}`);
    included.add(item);
  };
  const scanLayers = (node: unknown, path: string): void => {
    if (Array.isArray(node)) node.forEach((v, i) => scanLayers(v, `${path}[${i}]`));
    else if (isMap(node)) {
      if (isMap(node.layers)) {
        for (const [key, ref] of Object.entries(node.layers)) {
          if (!/^v\d+$/.test(key) || typeof ref !== "string") continue;
          for (const m of ref.matchAll(QUALIFIED)) addPattern(key, m[0], `${path}.layers.${key}`);
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "layers" && typeof v === "object") scanLayers(v, `${path}.${k}`);
    }
  };
  for (const key of ["sections", "timeline", "songs"]) if (score[key] !== undefined) scanLayers(score[key], `$.${key}`);

  // Instruments: every library instrument a name in the score (or in an added library pattern) refers to.
  const mentioned = new Set<string>();
  const note = (s: string) => { for (const m of s.matchAll(QUALIFIED)) mentioned.add(m[0]); };
  // Only the fields that name instruments: voice defaults, followers, pattern text and the kit; not titles or names.
  for (const voice of voices) {
    if (!isMap(voice)) continue;
    if (typeof voice.instrument === "string") note(voice.instrument);
    if (isMap(voice.follow) && typeof voice.follow.instrument === "string") note(voice.follow.instrument);
    walkStrings(voice.patterns, note);
  }
  if (isMap(score.kit)) walkStrings(score.kit, note);
  const add: Item[] = [];
  for (const name of mentioned) {
    const item = instruments.get(name);
    if (item) { add.push(item); included.add(item); }
  }
  if (add.length) {
    // Deterministic order: the order of the libraries, then the order within each.
    const order = [...instruments.keys()];
    add.sort((a, b) => order.indexOf(a.qualified) - order.indexOf(b.qualified));
    if (score.instruments === undefined) score.instruments = {};
    if (isMap(score.instruments)) for (const item of add) score.instruments[item.qualified] = item.def;
  }

  // Effects: only those an import lists in its `effects`.
  const selected: Item[] = [];
  const addEffects = (list: LoadedImport[], prefix: string, entryList: ImportEntry[], basePath: string) => {
    list.forEach(({ as, lib }, i) => {
      for (const name of entryList[i]!.effects) {
        const item = effects.get(`${prefix}${as}.${name}`);
        if (!item) fail(`${basePath}[${i}].effects`, `the library ${as} has no effect ${name}`);
        if (!selected.includes(item)) selected.push(item);
      }
      // The imports of a library may select effects of their own libraries.
      addEffects(lib.imports, `${prefix}${as}.`, lib.entries, `${basePath}[${i}] (${lib.label}) $.imports`);
    });
  };
  addEffects(imports, "", entries, "$.imports");
  if (selected.length) {
    if (score.effects === undefined) score.effects = {};
    if (!isMap(score.effects)) fail("$.effects", "expected a mapping");
    for (const item of selected) {
      if (hasOwn(score.effects, item.qualified)) fail(`$.effects.${item.qualified}`, `collides with the library effect ${item.qualified}`);
      score.effects[item.qualified] = item.def;
      included.add(item);
    }
  }

  const used = new Map<string, SidwaveUsedLibrary>();
  const everything = [...instruments.values(), ...patterns.values(), ...effects.values()];
  for (const item of [...included].sort((a, b) => everything.indexOf(a) - everything.indexOf(b))) {
    if (!used.has(item.owner.file)) {
      used.set(item.owner.file, { namespace: item.namespace, name: item.owner.meta.name, version: item.owner.meta.version, sha256: item.owner.sha256, licence: item.owner.meta.licence });
    }
  }
  return { score, libraries: [...used.values()] };
}

/** A resolver for the `imports` option of {@link parseSidwave}: libraries are read relative to `file`. */
export function createImportResolver(options: ImportResolverOptions): (score: Record<string, unknown>) => ResolvedImports {
  return (score) => expandImports(score, options);
}

// ---------------------------------------------------------------------------
// lock and bundle

export interface LockedImport { as: string; from: string; sha256: string; changed: boolean }

/** Writes the content hash of each imported library into the score text; everything else in the text stays. */
export function lockScore(text: string, file: string, allowedDirs: readonly string[] = []): { text: string; imports: LockedImport[] } {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new SidwaveValidationError("$", `YAML could not be parsed: ${doc.errors[0]!.message.split("\n")[0]}`);
  const seq = doc.get("imports");
  if (!YAML.isSeq(seq)) throw new SidwaveValidationError("$.imports", "the score has no imports to lock");
  const entries = parseEntries(doc.toJS().imports, "$.imports");
  const loader = new Loader(file, allowedDirs);
  const result: LockedImport[] = [];
  entries.forEach((entry, i) => {
    const path = `$.imports[${i}]`;
    // Check the whole chain (including the version range) before the hash is written.
    const lib = loader.resolveEntries([{ ...entry, sha256: undefined } as ImportEntry], resolve(file), path, [])[0]!.lib;
    const item = seq.items[i] as YAML.YAMLMap;
    const changed = entry.sha256 !== lib.sha256;
    item.set("sha256", lib.sha256);
    result.push({ as: entry.as, from: entry.from, sha256: lib.sha256, changed });
  });
  return { text: doc.toString({ lineWidth: 0 }), imports: result };
}

export interface BundleManifest {
  format: "sidwave-bundle";
  version: 1;
  score: { file: string; sha256: string };
  /** The `file:` samples of the score, copied to samples/ with the paths in the score rewritten to match. */
  samples: Array<{ file: string; sha256: string; bytes: number }>;
  libraries: Array<{
    file: string; name: string; version: string; sha256: string; licence: string;
    provenance: SidwaveLibraryMeta["provenance"]; imports: Array<{ as: string; file: string }>;
  }>;
}

function safeStem(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Writes the score and every library it depends on into `outDir`: the score as `<name>`, the libraries in `libs/`,
 * the `from` of each import rewritten to a relative path inside the bundle, and `bundle.json`. The imports that
 * used `pkg:` become local paths, so the bundle compiles without node_modules or any other directory.
 * `file:` samples are copied to `samples/` (read like the compiler reads them: relative to `sampleRoot`, inside it or
 * `allowedDirs`, at most 16 MiB each and 64 MiB together) and their paths rewritten, so the bundle is compiled with
 * its own directory as the working directory.
 */
export function bundleScore(text: string, file: string, outDir: string, allowedDirs: readonly string[] = [], force = false, sampleRoot: string = dirname(resolve(file))): BundleManifest {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new SidwaveValidationError("$", `YAML could not be parsed: ${doc.errors[0]!.message.split("\n")[0]}`);
  const seq = doc.get("imports");
  const entries = YAML.isSeq(seq) ? parseEntries(doc.toJS().imports, "$.imports") : [];
  const loader = new Loader(file, allowedDirs);
  const scoreImports = loader.resolveEntries(entries, resolve(file), "$.imports", []);
  const order: LoadedLibrary[] = [];
  const visit = (lib: LoadedLibrary) => {
    if (order.includes(lib)) return;
    order.push(lib);
    lib.imports.forEach((i) => visit(i.lib));
  };
  scoreImports.forEach((i) => visit(i.lib));

  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const lib of order) {
    let name = `${safeStem(lib.meta.name)}-${lib.meta.version}.yaml`;
    if (used.has(name)) name = `${safeStem(lib.meta.name)}-${lib.meta.version}-${lib.sha256.slice(0, 8)}.yaml`;
    used.add(name);
    names.set(lib.file, name);
  }

  const target = resolve(outDir);
  if (existsSync(target) && readdirSync(target).length > 0 && !force) {
    throw new Error(`${target} is not empty; use --force to write the bundle into it`);
  }
  mkdirSync(join(target, "libs"), { recursive: true });

  const rewrite = (source: string, prefix: string, resolved: Array<{ as: string; lib: LoadedLibrary }>): string => {
    const d = YAML.parseDocument(source);
    const s = d.get("imports");
    if (!YAML.isSeq(s)) return source;
    s.items.forEach((item, i) => {
      if (YAML.isMap(item)) item.set("from", `${prefix}${names.get(resolved[i]!.lib.file)}`);
    });
    return d.toString({ lineWidth: 0 });
  };

  const scoreName = basename(file);
  const withLibs = rewrite(text, "./libs/", scoreImports);
  const copied = copySamples(withLibs, target, sampleRoot, allowedDirs);
  const scoreText = copied.text;
  writeFileSync(join(target, scoreName), scoreText);
  const manifest: BundleManifest = { format: "sidwave-bundle", version: 1, score: { file: scoreName, sha256: sha256Hex(scoreText) }, samples: copied.samples, libraries: [] };
  for (const lib of order) {
    const source = readFileSync(lib.file, "utf8");
    const out = rewrite(source, "./", lib.imports);
    const rel = `libs/${names.get(lib.file)}`;
    writeFileSync(join(target, rel), out);
    const check = canonicalLibraryHash(out);
    if (check !== lib.contentHash) throw new Error(`internal error: the bundled copy of ${lib.label} hashes to ${check}, not ${lib.contentHash}`);
    manifest.libraries.push({
      file: rel, name: lib.meta.name, version: lib.meta.version, sha256: lib.sha256, licence: lib.meta.licence,
      provenance: lib.meta.provenance, imports: lib.imports.map((i) => ({ as: i.as, file: `libs/${names.get(i.lib.file)}` })),
    });
  }
  manifest.libraries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  writeFileSync(join(target, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const MAX_BUNDLE_SAMPLE_BYTES = 64 * 1024 * 1024;

/** Copies the `file:` samples of a score text into `<target>/samples` and returns the text with the new paths. */
function copySamples(text: string, target: string, sampleRoot: string, allowedDirs: readonly string[]): { text: string; samples: BundleManifest["samples"] } {
  const doc = YAML.parseDocument(text);
  const node = doc.get("samples", true);
  const scalars: YAML.Scalar[] = [];
  if (node && typeof node === "object") {
    YAML.visit(node as YAML.Node, {
      Pair(_key, pair) {
        if (YAML.isScalar(pair.key) && pair.key.value === "file" && YAML.isScalar(pair.value) && typeof pair.value.value === "string") scalars.push(pair.value);
      },
    });
  }
  if (!scalars.length) return { text, samples: [] };
  const root = realpathSync(resolve(sampleRoot));
  const roots = [root, ...allowedDirs.map((dir) => realpathSync(resolve(dir)))];
  const inside = (p: string) => roots.some((r) => { const rel = relative(r, p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
  const byReal = new Map<string, string>();
  const names = new Set<string>();
  const out: BundleManifest["samples"] = [];
  let total = 0;
  mkdirSync(join(target, "samples"), { recursive: true });
  for (const scalar of scalars) {
    const name = scalar.value as string;
    const lexical = resolve(root, name);
    let real: string;
    try {
      real = realpathSync(lexical);
    } catch (error) {
      if (!inside(lexical)) throw new Error(`sample ${name} is outside the allowed directories; pass --allow-dir to permit it`);
      throw new Error(`sample ${name} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (!inside(real)) throw new Error(`sample ${name} is outside the allowed directories; pass --allow-dir to permit it`);
    let rel = byReal.get(real);
    if (rel === undefined) {
      const size = statSync(real).size;
      if (size > DEFAULT_MAX_PCM_FILE_BYTES) throw new Error(`sample ${name} is ${size} bytes, which exceeds the sample size limit of ${DEFAULT_MAX_PCM_FILE_BYTES}`);
      total += size;
      if (total > MAX_BUNDLE_SAMPLE_BYTES) throw new Error(`the samples add up to more than ${MAX_BUNDLE_SAMPLE_BYTES} bytes`);
      const bytes = readFileSync(real);
      const digest = sha256Hex(bytes);
      let base = safeStem(basename(real));
      if (names.has(base)) base = `${digest.slice(0, 8)}-${base}`;
      names.add(base);
      rel = `samples/${base}`;
      writeFileSync(join(target, rel), bytes);
      byReal.set(real, rel);
      out.push({ file: rel, sha256: digest, bytes: bytes.length });
    }
    scalar.value = rel;
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { text: doc.toString({ lineWidth: 0 }), samples: out };
}
