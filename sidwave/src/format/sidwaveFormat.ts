// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import YAML from "yaml";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveToPrg } from "../sidwaveCompiler.js";

export type ChangeClass = "formatting" | "musical" | "synthesis" | "hardware" | "structural";
export interface SemanticChange { class: ChangeClass; path: string; before?: unknown; after?: unknown; summary: string }
export interface SemanticDiff { changes: SemanticChange[]; compiledEqual: boolean }
export interface Conflict { path: string; base?: unknown; ours?: unknown; theirs?: unknown; summary: string }

// Ordered from the SIDWave spec/schema. Nested objects use their own schema field order.
const orders: Record<string, string[]> = {
  $: ["sidwave", "song", "title", "author", "tempo", "meter", "mode", "length_bars", "speed", "cpu", "sids", "instruments", "global_fx", "samples", "kit", "voices", "sections", "timeline", "loop_to", "accent", "end", "swing", "swing_unit"],
  song: ["title", "author", "tempo", "mode", "length_bars", "global_fx"],
  voices: ["id", "sid", "channel", "name", "role", "center", "level", "waveform", "pulse_width", "adsr", "detune", "instrument", "echo", "unison", "follow", "patterns"],
  pattern: ["type", "groove", "drums", "notes", "motif", "root", "length", "frame_rate", "transpositions", "fx", "bars"],
  section: ["section", "bars", "meter", "tempo", "swing", "transpose", "level", "levels", "volume", "filter", "layers"],
  note: ["note", "inst", "len", "legato", "portamento", "slide_from", "bend", "gate_off", "level", "vibrato"],
  sid: ["id", "address", "model", "volume", "pan", "filter"],
  instrument: ["waveform", "pulse_width", "adsr", "portamento", "legato", "hard_restart", "sync", "ring", "wavetable", "pulsetable", "filtertable", "vibrato", "fx"],
  fx: ["vibrato", "pwm_sweep", "slide", "filter_mod"],
};
// Classification is by position in the score schema, never by a key name found at an arbitrary depth: an instrument
// named "sid" or "timeline", or a section named "mode", is user data and classifies by where it sits.
const ROOT_HARDWARE = new Set(["sids", "mode", "cpu", "speed", "clock", "layout", "overrides"]);
const ROOT_SYNTHESIS = new Set(["instruments", "global_fx", "samples", "kit"]);
const ROOT_MUSICAL = new Set(["tempo", "meter", "length_bars", "sections", "timeline", "loop_to", "accent", "end", "swing", "swing_unit"]);
const VOICE_SYNTHESIS = new Set(["waveform", "pulse_width", "adsr", "detune", "instrument", "echo", "unison", "follow", "fx"]);
const VOICE_MUSICAL = new Set(["patterns", "level", "center"]);
const SYNTHESIS_ENTRY = new Set(["inst", "instrument", "fx", "vibrato"]);
const un = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");
function classify(path: string): ChangeClass {
  const parts = path.split("/").slice(1).map(un);
  const [root, , third] = parts;
  if (root === undefined) return "structural";
  if (root === "song") return parts[1] === "global_fx" ? "synthesis" : parts[1] === "tempo" || parts[1] === "length_bars" ? "musical" : parts[1] === "mode" ? "hardware" : "structural";
  if (ROOT_HARDWARE.has(root)) return "hardware";
  if (ROOT_SYNTHESIS.has(root)) return "synthesis";
  if (root === "voices") {
    // /voices/<index>/<field>/...
    if (third === undefined) return "structural";
    if (third === "sid") return "hardware";
    if (VOICE_SYNTHESIS.has(third)) return "synthesis";
    if (third === "patterns") {
      // /voices/<i>/patterns/<name>/<field>/...: effects and instrument choices are decided before the pattern rule.
      const [field, index, key] = parts.slice(4);
      if (field === "fx" || ((field === "groove" || field === "notes") && key !== undefined && index !== undefined && SYNTHESIS_ENTRY.has(key))) return "synthesis";
      return "musical";
    }
    return VOICE_MUSICAL.has(third) ? "musical" : "structural";
  }
  if (root === "sections" || root === "timeline") {
    return parts[2] === "filter" || parts[2] === "fx" ? "synthesis" : "musical";
  }
  return ROOT_MUSICAL.has(root) ? "musical" : "structural";
}
function esc(s: string) { return s.replace(/~/g, "~0").replace(/\//g, "~1"); }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function compileEqual(a: string, b: string): boolean {
  try { const x = compileSidwaveToPrg(parseSidwave(a), { loop: false }).prg; const y = compileSidwaveToPrg(parseSidwave(b), { loop: false }).prg; return x.equals(y); }
  catch { return false; }
}
/** Schema kind of the value under each key, per parent kind. "named" is a map whose keys are user chosen names and whose values have the given kind; "list" is a sequence of that kind. */
const children: Record<string, Record<string, string>> = {
  $: { song: "song", voices: "list:voices", sections: "named:section", timeline: "list:section", instruments: "named:instrument", sids: "list:sid", global_fx: "fx" },
  voices: { patterns: "named:pattern", fx: "fx" },
  pattern: { groove: "list:note", fx: "fx" },
  section: {},
  instrument: { fx: "fx" },
  song: { global_fx: "fx" },
};
function reorder(node: any, kind = "$"): void {
  if (YAML.isSeq(node)) {
    for (const item of node.items) reorder(item, kind);
    return;
  }
  if (!YAML.isMap(node)) return;
  const order = orders[kind] ?? [];
  node.items.sort((a: any, b: any) => {
    const ai = order.indexOf(String((a.key as any)?.value ?? "")), bi = order.indexOf(String((b.key as any)?.value ?? ""));
    return (ai < 0 ? 1e6 : ai) - (bi < 0 ? 1e6 : bi);
  });
  for (const item of node.items) {
    const key = String((item.key as any)?.value ?? "");
    const spec = children[kind]?.[key];
    if (!spec) continue;
    const [shape, inner] = spec.includes(":") ? spec.split(":") : ["map", spec];
    if (shape === "named" && YAML.isMap(item.value)) for (const entry of item.value.items) reorder(entry.value, inner);
    else reorder(item.value, inner);
  }
}
/** Canonical YAML: two spaces, double quoted strings, and short scalar lists flow when <= 6 items and <= 72 chars. */
export function formatSidwave(text: string): string {
  const doc = YAML.parseDocument(text, { version: "1.2", keepSourceTokens: true });
  if (doc.errors.length) throw doc.errors[0];
  // A comment block that is separated from the first key by a blank line is a file header. It is attached to the
  // first key by the YAML library and would otherwise move with that key when the keys are sorted.
  const first: any = YAML.isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  const header: string | undefined = first?.commentBefore;
  if (header?.includes("\n\n")) {
    const cut = header.lastIndexOf("\n\n");
    doc.commentBefore = doc.commentBefore ? `${doc.commentBefore}\n\n${header.slice(0, cut)}` : header.slice(0, cut);
    first.commentBefore = header.slice(cut + 2) || undefined;
  }
  reorder(doc.contents);
  const setFlow = (n: any): void => {
    if (YAML.isSeq(n)) {
      const shortScalars = n.items.length <= 6 && n.items.every((v: any) => YAML.isScalar(v))
        && n.items.reduce((sum: number, v: any) => sum + String(v.value).length, 0) <= 72;
      if (shortScalars) n.flow = true;
      n.items.forEach(setFlow);
    } else if (YAML.isMap(n)) n.items.forEach((i: any) => { setFlow(i.value); });
    else if (YAML.isScalar(n) && typeof n.value === "string") n.type = YAML.Scalar.QUOTE_DOUBLE;
  };
  setFlow(doc.contents);
  return doc.toString({ indent: 2, lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", flowCollectionPadding: false });
}

export function diffSidwave(a: string, b: string): SemanticDiff {
  const av = YAML.parse(a), bv = YAML.parse(b);
  const changes: SemanticChange[] = [];
  const walk = (x: any, y: any, path: string) => {
    if (equal(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) {
      x.forEach((v, i) => walk(v, y[i], `${path}/${i}`));
    } else if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])]) walk(x[k], y[k], `${path}/${esc(k)}`);
    } else changes.push({ class: classify(path), path, ...(x === undefined ? {} : { before: x }), ...(y === undefined ? {} : { after: y }), summary: `${path || "/"} changed` });
  };
  walk(av, bv, "");
  if (!changes.length && a !== b) changes.push({ class: "formatting", path: "", summary: "YAML formatting changed" });
  return { changes, compiledEqual: compileEqual(a, b) };
}

/**
 * The merged value written as YAML text. The edits are applied to the YAML document of "ours", so its comments,
 * anchors, aliases and flow style stay wherever the merge did not change a value. A value that was changed by the
 * merge is written from the merged data; an edit that cannot be applied in place (for example below an alias) makes
 * the whole result be written from the merged data, which drops comments and expands aliases.
 */
function applyToOurs(ours: string, oursValue: any, merged: any): { text: string; preserved: boolean; reason?: string } {
  try {
    const doc = YAML.parseDocument(ours, { version: "1.2", keepSourceTokens: true });
    if (doc.errors.length) throw doc.errors[0];
    const isObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
    const apply = (o: any, m: any, path: (string | number)[]): void => {
      if (equal(o, m)) return;
      if (isObject(o) && isObject(m)) {
        for (const k of new Set([...Object.keys(o), ...Object.keys(m)])) {
          if (m[k] === undefined) doc.deleteIn([...path, k]);
          else if (o[k] === undefined) doc.setIn([...path, k], doc.createNode(m[k]));
          else apply(o[k], m[k], [...path, k]);
        }
      } else if (Array.isArray(o) && Array.isArray(m) && o.length === m.length) {
        m.forEach((v, i) => apply(o[i], v, [...path, i]));
      } else if (path.length === 0) doc.contents = doc.createNode(m) as any;
      else doc.setIn(path, doc.createNode(m));
    };
    apply(oursValue, merged, []);
    const text = doc.toString();
    if (!equal(YAML.parse(text), JSON.parse(JSON.stringify(merged)))) throw new Error("in-place merge differs from the merged data");
    return { text, preserved: true };
  } catch (e) {
    return { text: YAML.stringify(merged), preserved: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface MergeResult {
  merged?: string;
  conflicts: Conflict[];
  /** Present with `merged`: false when the result was written from plain data, which drops comments and expands anchors and aliases. */
  preserved?: boolean;
  /** Present with `merged` when `preserved` is false: why the edits could not be applied to the document of ours. */
  warnings?: string[];
}
export function mergeSidwave(base: string, ours: string, theirs: string): MergeResult {
  const b: any = YAML.parse(base), o: any = YAML.parse(ours), t: any = YAML.parse(theirs), conflicts: Conflict[] = [];
  const merge = (bv: any, ov: any, tv: any, path: string): any => {
    if (equal(ov, tv)) return ov;
    if (equal(ov, bv)) return tv;
    if (equal(tv, bv)) return ov;
    if (bv && ov && tv && [bv, ov, tv].every(v => typeof v === "object" && !Array.isArray(v))) {
      const out: any = {};
      for (const k of new Set([...Object.keys(bv), ...Object.keys(ov), ...Object.keys(tv)])) {
        const value = merge(bv[k], ov[k], tv[k], `${path}/${esc(k)}`);
        if (value !== undefined) out[k] = value;
      }
      return out;
    }
    if ([bv, ov, tv].every(Array.isArray) && bv.length === ov.length && ov.length === tv.length) {
      // Lists of equal length (voices, timeline entries, groove entries) merge entry by entry.
      return ov.map((_: unknown, i: number) => merge(bv[i], ov[i], tv[i], `${path}/${i}`));
    }
    conflicts.push({ path: path || "", ...(bv === undefined ? {} : { base: bv }), ...(ov === undefined ? {} : { ours: ov }), ...(tv === undefined ? {} : { theirs: tv }), summary: `Concurrent edits at ${path || "/"}` });
    return ov;
  };
  const result = merge(b, o, t, "");
  if (conflicts.length) return { conflicts };
  try {
    const applied = applyToOurs(ours, o, result), merged = formatSidwave(applied.text);
    parseSidwave(merged);
    return applied.preserved ? { merged, conflicts, preserved: true } : { merged, conflicts, preserved: false, warnings: [`Comments and aliases of the ours side were not kept: ${applied.reason}`] };
  }
  catch (e) { return { conflicts: [{ path: "", summary: e instanceof Error ? e.message : String(e) }] }; }
}
