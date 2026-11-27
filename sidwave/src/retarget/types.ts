// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import YAML from "yaml";

/**
 * How a change relates to the music:
 * - exact: the target plays the same thing (same pitch, same time, same register values where they matter);
 * - approximate: the target plays something close, and the change carries the measured or computed difference;
 * - dropped: something that the source plays is absent in the target.
 */
export type ChangeClass = "exact" | "approximate" | "dropped";

export interface RetargetChange {
  step: "clock" | "model" | "sids" | "optimise";
  /** Short name of the construct, such as `wavetable.frames` or `voice`. */
  construct: string;
  class: ChangeClass;
  /** Location in the score (JSON pointer style) when the change belongs to one place. */
  path?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  /** Timing difference in milliseconds that this change introduces (frame arithmetic of the two clocks). */
  errorMs?: number;
  /** Other measured numbers, such as Hz deviations or cycle and byte deltas. */
  measured?: Record<string, number | string | boolean | null>;
}

export class RetargetError extends Error {
  constructor(public readonly code: "input" | "unsupported" | "infeasible", message: string) {
    super(message);
    this.name = "RetargetError";
  }
}

export type AnyDoc = YAML.Document<any>;

const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
/** JSON pointer of a path. */
export function pointer(path: ReadonlyArray<string | number>): string {
  return "/" + path.map((part) => esc(String(part))).join("/");
}

export function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Replaces every alias (`*name`) by a copy of the node it refers to and removes the anchors, so that edits to one
 * place cannot be lost below an alias and do not change other places.
 */
export function expandAliases(doc: AnyDoc): boolean {
  let found = false;
  YAML.visit(doc, {
    Alias(_key, node) {
      found = true;
      const target = node.resolve(doc);
      return target ? (target as any).clone() : undefined;
    },
  });
  if (found) YAML.visit(doc, { Node(_key, node) { if ((node as any).anchor) (node as any).anchor = undefined; } });
  return found;
}
