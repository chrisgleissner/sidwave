// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Instrument extraction: the instruments of a score, or of the reconstruction of a SID tune, written as a SIDWave
// asset library (sidwave: 1.4, or 1.5 for a 1.5 source; `library` header) with provenance. `checkInstrumentReuse` places an extracted instrument
// in a new score and compares the register output of its voice with the same instrument defined inline.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { SidEngine } from "../engine/libsidplayfp.js";
import { formatSidwave } from "../format/sidwaveFormat.js";
import { fdiff } from "../reconstruct/fdiff.js";
import { DEFAULT_HORIZON_SECONDS, irOfTrace, reconstructSid } from "../reconstruct/reconstruct.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes, confinedReadOptions } from "../sidwaveOps.js";
import { md5, restrictIrToVoice, sha256 } from "./common.js";
import { parseSidFile } from "../sidFile.js";

export const INSTRUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExtractOptions {
  /** Library name (letters, digits, dots, dashes, underscores). Default: extracted-<first 8 hex digits of the source hash>. */
  name?: string;
  /** SPDX licence identifier written to the library. Default LicenseRef-unknown: extracted instruments carry the rights of their source. */
  licence?: string;
  /** Author for the provenance. Default: the author of the PSID header, else "unknown". */
  author?: string;
  /** Date (YYYY-MM-DD) for provenance.created. Default: today. */
  created?: string;
  /** SID input: subtune (1-based) and horizon in seconds. */
  song?: number;
  seconds?: number;
  /** SID input: engine. */
  engine?: SidEngine;
}

export interface ExtractedInstrument {
  name: string;
  /** Name in the source score (`name` may differ: it is made a valid library identifier). */
  sourceName: string;
  /** The instrument definition as written in the score. */
  definition: Record<string, unknown>;
  /** Voices (as declared, by id) that use the instrument and the number of pattern entries that name it. */
  usedByVoices: number[];
  patternEntries: number;
  /** Names of the tables of the note program: wavetable, pulsetable, filtertable. */
  programs: string[];
}

export interface ExtractResult {
  /** The library file: YAML text with a comment header that records the provenance. */
  library: string;
  libraryName: string;
  instruments: ExtractedInstrument[];
  /** Instruments the score uses but does not define itself (built-in `lib:` instruments and imports). They are not copied. */
  external: string[];
  provenance: {
    source: { kind: "score" | "sid"; sha256: string; md5?: string };
    subtune?: number;
    horizonSeconds?: number;
    /** SID input: whether the reconstruction was exact; an inexact reconstruction may have wrong instruments. */
    reconstructionStrictExact?: boolean;
  };
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The version of a document derived from `source`: 1.5 when the source declares 1.5, because its instruments may use 1.5 constructs, else 1.4. */
const derivedVersion = (source: Record<string, unknown>): "1.4" | "1.5" => (String(source.sidwave) === "1.5" ? "1.5" : "1.4");

function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Instrument names a voice or pattern entry refers to: voice.instrument and the `inst` of groove entries. */
function usage(doc: Record<string, unknown>): Map<string, { voices: Set<number>; entries: number }> {
  const out = new Map<string, { voices: Set<number>; entries: number }>();
  const touch = (name: unknown, voice: number | undefined, entry: boolean) => {
    if (typeof name !== "string") return;
    let u = out.get(name);
    if (!u) out.set(name, (u = { voices: new Set(), entries: 0 }));
    if (voice !== undefined) u.voices.add(voice);
    if (entry) u.entries++;
  };
  const voices = Array.isArray(doc.voices) ? doc.voices : [];
  voices.forEach((voice, index) => {
    if (!isMap(voice)) return;
    const id = typeof voice.id === "number" ? voice.id : index + 1;
    touch(voice.instrument, id, false);
    if (isMap(voice.patterns)) {
      for (const pattern of Object.values(voice.patterns)) {
        if (!isMap(pattern) || !Array.isArray(pattern.groove)) continue;
        for (const entry of pattern.groove) if (isMap(entry)) touch(entry.inst, id, true);
      }
    }
  });
  return out;
}

/** Extracts the instruments of a score text. */
export function extractInstrumentsFromScore(text: string, options: ExtractOptions = {}, source?: ExtractResult["provenance"]): ExtractResult {
  const doc = YAML.parse(text);
  if (!isMap(doc)) throw new Error("the score is not a YAML mapping");
  const defined = isMap(doc.instruments) ? doc.instruments : {};
  const uses = usage(doc);
  const provenance = source ?? { source: { kind: "score" as const, sha256: sha256(text) } };
  const libraryName = options.name ?? `extracted-${provenance.source.sha256.slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(libraryName)) throw new Error(`library name "${libraryName}" must be letters, digits, dots, dashes and underscores`);
  const instruments: ExtractedInstrument[] = [];
  const renamed = new Map<string, string>();
  const taken = new Set<string>();
  for (const [name, def] of Object.entries(defined)) {
    if (!isMap(def)) continue;
    let target = sanitize(name);
    while (taken.has(target)) target = `${target}_`;
    taken.add(target);
    renamed.set(name, target);
    const u = uses.get(name);
    instruments.push({
      name: target, sourceName: name, definition: JSON.parse(JSON.stringify(def)) as Record<string, unknown>,
      usedByVoices: [...(u?.voices ?? [])].sort((a, b) => a - b), patternEntries: u?.entries ?? 0,
      programs: ["wavetable", "pulsetable", "filtertable"].filter((k) => def[k] !== undefined),
    });
  }
  const external = [...uses.keys()].filter((n) => !(n in defined)).sort();
  const created = options.created ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) throw new Error(`created must be a date such as 2026-11-27, not "${created}"`);
  const author = (options.author ?? (typeof doc.author === "string" ? doc.author : undefined) ?? "unknown").trim() || "unknown";
  const sourceText = provenance.source.kind === "sid"
    ? `reconstructed from SID file md5 ${provenance.source.md5} sha256 ${provenance.source.sha256}, subtune ${provenance.subtune}, horizon ${provenance.horizonSeconds} s`
    : `extracted from a SIDWave score, sha256 ${provenance.source.sha256}`;
  const library = {
    sidwave: derivedVersion(doc),
    library: { name: libraryName, version: "1.0.0", licence: options.licence ?? "LicenseRef-unknown", provenance: { author, source: sourceText, created } },
    instruments: Object.fromEntries(instruments.map((i) => [i.name, i.definition])),
  };
  const header = [
    `# SIDWave instrument library extracted by sidwave. Source ${provenance.source.kind}: sha256 ${provenance.source.sha256}${provenance.source.md5 ? `, md5 ${provenance.source.md5}` : ""}.`,
    ...(provenance.subtune === undefined ? [] : [`# Subtune ${provenance.subtune}, horizon ${provenance.horizonSeconds} s${provenance.reconstructionStrictExact === undefined ? "" : `, reconstruction ${provenance.reconstructionStrictExact ? "strictly exact" : "not strictly exact"}`}.`]),
    "# The licence field is a placeholder when the rights of the source are unknown; set it before you publish the library.",
  ].join("\n");
  return { library: `${header}\n${formatSidwave(YAML.stringify(library))}`, libraryName, instruments, external, provenance };
}

/**
 * Extracts instruments from a score (a string) or from a SID tune (bytes). A SID tune is reconstructed first, so the
 * engine is required for it; the library then holds the instruments of the reconstruction.
 */
export async function extractInstruments(input: string | Uint8Array, options: ExtractOptions = {}): Promise<ExtractResult> {
  if (typeof input === "string") return extractInstrumentsFromScore(input, options);
  const file = parseSidFile(input);
  if (!options.engine) throw new Error("extractInstruments needs an engine to reconstruct a SID tune");
  const song = options.song ?? file.startSong;
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const { score, report } = await reconstructSid(input, { engine: options.engine, song, seconds });
  return extractInstrumentsFromScore(score, { author: file.author || undefined, ...options }, {
    source: { kind: "sid", sha256: sha256(input), md5: md5(input) }, subtune: song, horizonSeconds: seconds, reconstructionStrictExact: report.strictExact,
  });
}

// ---- reuse ---------------------------------------------------------------------------------------------------------

export interface ReuseCheck {
  instrument: string;
  equal: boolean;
  comparedCalls: number;
  differingCalls: number;
  first?: { class: string; call: number; register?: number; expected?: number; observed?: number };
  notes: string[];
}

export interface ReuseOptions {
  /** The library text written by extractInstruments. */
  library: string;
  /** Name of the instrument in the library. */
  instrument: string;
  /** The score the instrument came from. Its own definition of the instrument is the reference of the comparison; tempo, mode, speed and SID setup of the probe follow it. */
  source: string;
  /** Name of the instrument in the source score when it differs from the library name. */
  sourceInstrument?: string;
  engine: SidEngine;
  /** Notes of the probe, default C3 E4 A4 C5 G3 D5. */
  notes?: string[];
  seconds?: number;
}

const PROBE_NOTES = ["C3", "E4", "A4", "C5"];

/** Probe scores: the same notes on one voice, once with the source score's own definition inline and once with the instrument imported from the extracted library. */
export function reuseProbes(options: Pick<ReuseOptions, "library" | "instrument" | "source" | "sourceInstrument" | "notes">): { inline: string; imported: string } {
  const lib = YAML.parse(options.library) as { instruments?: Record<string, unknown> };
  const src = YAML.parse(options.source) as Record<string, unknown>;
  if (!lib.instruments?.[options.instrument]) throw new Error(`the library has no instrument ${options.instrument}`);
  // The reference is the source score's own definition, not a copy taken from the library.
  const sourceName = options.sourceInstrument ?? options.instrument;
  const definition = (src.instruments as Record<string, unknown> | undefined)?.[sourceName];
  if (!definition) throw new Error(`the source score has no instrument ${sourceName}`);
  const notes = options.notes ?? PROBE_NOTES;
  const base = {
    sidwave: derivedVersion(src), title: "Instrument reuse probe", tempo: 100, mode: src.mode ?? "PAL", ...(src.speed === undefined ? {} : { speed: src.speed }),
    ...(src.sids === undefined ? {} : { sids: src.sids }), ...(src.cpu === undefined ? {} : { cpu: src.cpu }),
  };
  const groove = notes.map((note) => ({ note, len: 2 }));
  const timeline = [{ section: "Probe", bars: Math.ceil((notes.length * 2) / 4), layers: { v1: "P" } }];
  const inline = { ...base, instruments: { X: definition }, voices: [{ id: 1, instrument: "X", patterns: { P: { length: 1, groove } } }], timeline };
  const imported = { ...base, imports: [{ as: "ex", from: "./lib.yaml" }], voices: [{ id: 1, instrument: `ex.${options.instrument}`, patterns: { P: { length: 1, groove } } }], timeline };
  return { inline: YAML.stringify(inline), imported: YAML.stringify(imported) };
}

/**
 * Compiles the probe with the inline instrument and the probe with the imported instrument, traces both and compares
 * the register output of voice 1 call by call (F-diff restricted to that voice).
 */
export async function checkInstrumentReuse(options: ReuseOptions): Promise<ReuseCheck> {
  const probes = reuseProbes(options);
  const dir = mkdtempSync(join(tmpdir(), "sidwave-reuse-"));
  try {
    writeFileSync(join(dir, "lib.yaml"), options.library);
    writeFileSync(join(dir, "score.yaml"), probes.imported);
    const compile = (text: string, file?: string) => new Uint8Array(compileSidwaveBytes(parseSidwave(text, confinedReadOptions(dir, [], file)), { format: "sid", loop: false }).bytes);
    const inline = compile(probes.inline);
    const imported = compile(probes.imported, join(dir, "score.yaml"));
    const seconds = options.seconds ?? 5;
    const [a, b] = await Promise.all([options.engine.trace({ sid: inline, seconds }), options.engine.trace({ sid: imported, seconds })]);
    const result = fdiff(restrictIrToVoice(irOfTrace(a), 1), restrictIrToVoice(irOfTrace(b), 1), { alignExpected: 1, alignObserved: 1 });
    const differing = Object.values(result.classes).reduce((n, c) => n + c.differingCalls, 0);
    return {
      instrument: options.instrument, equal: result.equal, comparedCalls: result.alignment.compared, differingCalls: differing,
      ...(result.first ? { first: { class: result.first.class, call: result.first.call, register: result.first.register, expected: result.first.expected, observed: result.first.observed } } : {}),
      notes: options.notes ?? PROBE_NOTES,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The source score with every extracted instrument replaced by an import from the library (`ex.<name>`). Compiled and
 * traced next to the source, every voice must give the same registers.
 */
export function replaceWithImports(source: string, instruments: string[], libraryFile = "./lib.yaml", namespace = "ex"): string {
  const doc = YAML.parse(source) as Record<string, any>;
  const names = new Set(instruments);
  const rename = (n: unknown) => (typeof n === "string" && names.has(n) ? `${namespace}.${n}` : n);
  for (const name of names) delete doc.instruments?.[name];
  if (doc.instruments && Object.keys(doc.instruments).length === 0) delete doc.instruments;
  doc.sidwave = derivedVersion(doc);
  doc.imports = [...(Array.isArray(doc.imports) ? doc.imports : []), { as: namespace, from: libraryFile }];
  for (const voice of doc.voices ?? []) {
    voice.instrument = rename(voice.instrument);
    for (const pattern of Object.values<any>(voice.patterns ?? {})) for (const entry of pattern.groove ?? []) if (entry && typeof entry === "object") entry.inst = rename(entry.inst);
  }
  return YAML.stringify(doc);
}
