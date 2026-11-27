// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Types of the format registry used by `sidwave convert`.

import type { SidEmulation, SidEngine } from "../engine/types.js";
import type { ParsedSidwave } from "../sidwave.js";
import type { Loss } from "./loss.js";
import type { ScorePlanResult, TargetCaps } from "./scorePlan.js";

/** Options for reading a file into a score. `song` is 1-based, as in the PSID header and in GoatTracker. */
export interface ReadContext {
  name: string;
  song?: number;
  grid?: number;
  voices?: number;
  mode?: "PAL" | "NTSC";
  title?: string;
  /** Compile an import to prove that SIDWave accepts it. Default true. */
  validate?: boolean;
  /** Horizon of a reconstruct in seconds. */
  seconds?: number;
  createEngine?: (emulation: SidEmulation) => SidEngine;
  signal?: AbortSignal;
  /** Called with a short message when a slow path starts. */
  notice?: (message: string) => void;
}

export interface ReadOutput {
  /** The score as SIDWave text. */
  yaml: string;
  losses: Loss[];
  /** The importer's own report, unchanged. */
  report?: unknown;
  /** True when the score is a recovered approximation of the source (reconstruct). */
  approximate?: boolean;
  /** Number of calls that differ between the source and its recompiled score, when it was measured. */
  fdiff?: { equal: boolean; differingCalls: number; comparedCalls: number };
}

export interface WriteContext {
  doc: ParsedSidwave;
  yaml: string;
  plan: ScorePlanResult;
  /** Song, 0-based. */
  song: number;
  seconds?: number;
  model?: "6581" | "8580";
  createEngine?: (emulation: SidEmulation) => SidEngine;
  signal?: AbortSignal;
}

export interface WriteOutput {
  bytes: Uint8Array | string;
  losses: Loss[];
  report?: unknown;
}

export interface FormatCaps extends TargetCaps {
  /** What the format means in the support table. */
  kind: "score" | "tracker" | "notation" | "audio" | "program" | "events" | "trace";
}

export interface FormatDefinition {
  id: string;
  name: string;
  /** Lower-case extensions with the dot; the first one is the default of an output file. */
  extensions: string[];
  /** Extensions that are recognised on input but never chosen for an output (a compressed variant the writer does not produce). */
  readOnlyExtensions?: string[];
  /** Names accepted by `--from` and `--to` besides the id. */
  aliases?: string[];
  /** Confidence 0..1 that `bytes` are this format, from the content only. 0 means not this format. */
  magic(bytes: Uint8Array): number;
  /** Short description of how the format is recognised, for `sidwave formats`. */
  detection: string;
  caps: FormatCaps;
  /** One sentence on what the format loses when it is the target (or the source). */
  lossSummary: string;
  read?(bytes: Uint8Array, ctx: ReadContext): ReadOutput | Promise<ReadOutput>;
  /** The format holds several songs and `--song` selects one when it is the source. */
  songs?: boolean;
  /** Source is a recovered approximation and slow (needs the engine). */
  readIsApproximate?: boolean;
  write?(ctx: WriteContext): WriteOutput | Promise<WriteOutput>;
  /** Plain-language facts for `sidwave info`. Must not throw for valid files; may throw typed errors for broken ones. */
  describe?(bytes: Uint8Array): Record<string, unknown>;
}
