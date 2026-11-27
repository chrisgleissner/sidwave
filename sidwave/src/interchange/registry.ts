// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The format registry of `sidwave convert`: one entry per format, detection by content, lookup by name or extension.
// To add a format see formatsExtra.ts (one new file and one line there).

import { extname } from "node:path";
import { BUILTIN_FORMATS } from "./builtinFormats.js";
import { EXTRA_FORMATS } from "./formatsExtra.js";
import type { FormatCaps, FormatDefinition } from "./formatTypes.js";
import { UsageError } from "../cliCore.js";

export type { FormatDefinition, FormatCaps, ReadContext, ReadOutput, WriteContext, WriteOutput } from "./formatTypes.js";

const formats: FormatDefinition[] = [...BUILTIN_FORMATS, ...EXTRA_FORMATS];
const seen = new Set<string>();
for (const f of formats) {
  if (seen.has(f.id)) throw new Error(`duplicate format id ${f.id}`);
  seen.add(f.id);
}

export interface FormatInfo {
  id: string;
  name: string;
  extensions: string[];
  aliases: string[];
  read: boolean;
  write: boolean;
  detection: string;
  kind: FormatCaps["kind"];
  caps: FormatCaps;
  lossSummary: string;
  /** Reading is an approximate recovery (slow). */
  readApproximate: boolean;
}

/** All registered formats, in registry order. */
export function listFormats(): FormatInfo[] {
  return formats.map((f) => ({
    id: f.id, name: f.name, extensions: [...f.extensions], aliases: [...(f.aliases ?? [])], read: f.read !== undefined, write: f.write !== undefined,
    detection: f.detection, kind: f.caps.kind, caps: f.caps, lossSummary: f.lossSummary, readApproximate: f.readIsApproximate === true,
  }));
}

export function formatDefinitions(): readonly FormatDefinition[] { return formats; }

/** The format with this id, alias or extension (with or without the dot); undefined when unknown. */
export function findFormat(name: string): FormatDefinition | undefined {
  const key = name.toLowerCase().replace(/^\./, "");
  return formats.find((f) => f.id === key || f.aliases?.includes(key))
    ?? formats.find((f) => f.extensions.includes(`.${key}`));
}

export function getFormat(name: string): FormatDefinition {
  const found = findFormat(name);
  if (!found) {
    throw new UsageError(`unknown format "${name}"; the formats are ${formats.map((f) => f.id).join(", ")} (run "sidwave formats")`);
  }
  return found;
}

/** Formats that have this extension (with the dot), e.g. ".xml". */
export function formatsForExtension(extension: string): FormatDefinition[] {
  const ext = extension.toLowerCase();
  return formats.filter((f) => f.extensions.includes(ext));
}

export interface DetectionCandidate { id: string; confidence: number; by: "magic" | "magic+extension" | "extension" }

export interface Detection {
  /** The chosen format; undefined when nothing matches or the choice is ambiguous. */
  best?: DetectionCandidate;
  candidates: DetectionCandidate[];
  /** True when there is no clear winner: the best confidence is below 0.6 or the best two are within 0.2. */
  ambiguous: boolean;
  /** The extension contradicts a clear magic. */
  warnings: string[];
}

/** Confidence at or above which the content alone settles the format. */
export const CLEAR_MAGIC = 0.9;
const MIN_CONFIDENCE = 0.6;
const MIN_MARGIN = 0.2;

/**
 * Detects the format of a file: by content first. The extension corroborates a weak match and breaks ties between
 * equal ones; it never overrides a clear magic. Without any magic the extension alone gives confidence 0.5, which
 * `convert` treats as ambiguous.
 */
export function detectFormat(bytes: Uint8Array, name?: string, definitions: readonly FormatDefinition[] = formats): Detection {
  const ext = name === undefined ? "" : extname(name).toLowerCase();
  const byExtension = ext ? definitions.filter((f) => f.extensions.includes(ext)) : [];
  const candidates: DetectionCandidate[] = [];
  for (const f of definitions) {
    let confidence = f.magic(bytes);
    if (confidence <= 0) continue;
    let by: DetectionCandidate["by"] = "magic";
    if (confidence < CLEAR_MAGIC && byExtension.includes(f)) { confidence = Math.min(0.95, confidence + 0.35); by = "magic+extension"; }
    candidates.push({ id: f.id, confidence: Math.round(confidence * 100) / 100, by });
  }
  if (candidates.length === 0) for (const f of byExtension) candidates.push({ id: f.id, confidence: 0.5, by: "extension" });
  candidates.sort((a, b) => b.confidence - a.confidence);
  const [first, second] = candidates;
  let ambiguous = first === undefined || first.confidence < MIN_CONFIDENCE || (second !== undefined && first.confidence - second.confidence < MIN_MARGIN);
  // Extension breaks a tie between equally good candidates, when exactly one of them claims the extension.
  if (ambiguous && first && second && first.confidence >= MIN_CONFIDENCE && first.by !== "extension") {
    const tied = candidates.filter((c) => first.confidence - c.confidence < MIN_MARGIN);
    const claimed = tied.filter((c) => byExtension.some((f) => f.id === c.id));
    if (claimed.length === 1) {
      const winner = claimed[0]!;
      candidates.splice(candidates.indexOf(winner), 1);
      candidates.unshift({ ...winner, confidence: Math.max(winner.confidence, first.confidence), by: "magic+extension" });
      ambiguous = false;
    }
  }
  const warnings: string[] = [];
  const best = ambiguous ? undefined : candidates[0];
  if (best && best.by === "magic" && best.confidence >= CLEAR_MAGIC && name !== undefined && ext && byExtension.length > 0 && !byExtension.some((f) => f.id === best.id)) {
    warnings.push(`${name} has the extension ${ext}, but its content is ${best.id} (${definitions.find((f) => f.id === best.id)!.detection}); the content is used.`);
  }
  return { ...(best ? { best } : {}), candidates, ambiguous, warnings };
}

/** The target format from `--to`, else from the extension of the output name. */
export function resolveTarget(to: string | undefined, outputName: string | undefined): FormatDefinition {
  if (to !== undefined) return getFormat(to);
  if (outputName === undefined || outputName === "-") {
    throw new UsageError(`name the target: --to <${formats.filter((f) => f.write).map((f) => f.id).join("|")}> or an output file with a known extension`);
  }
  const ext = extname(outputName).toLowerCase();
  const matches = formatsForExtension(ext).filter((f) => f.write && !f.readOnlyExtensions?.includes(ext));
  if (matches.length === 1) return matches[0]!;
  const any = formatsForExtension(ext);
  if (any.length >= 1 && matches.length === 0) throw new UsageError(`${outputName}: ${any[0]!.write ? `the extension ${ext} is read only (use ${any[0]!.extensions.find((e) => !any[0]!.readOnlyExtensions?.includes(e))})` : `${any[0]!.id} cannot be written`}; the target formats are ${formats.filter((f) => f.write).map((f) => f.id).join(", ")}`);
  throw new UsageError(`cannot tell the target format from "${outputName}"; pass --to <${formats.filter((f) => f.write).map((f) => f.id).join("|")}>`);
}
