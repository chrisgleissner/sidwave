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
const musical = new Set(["groove", "notes", "motif", "length", "transpositions", "frame_rate", "bars", "layers", "tempo", "meter", "section", "sections", "timeline", "length_bars", "swing", "swing_unit", "transpose", "levels", "volume", "level", "accent", "end", "loop_to"]);
const synthesis = new Set(["adsr", "waveform", "pulse_width", "wavetable", "pulsetable", "filtertable", "filter", "global_fx", "fx", "vibrato", "pwm_sweep", "filter_mod", "slide", "hard_restart", "sync", "ring", "instrument", "echo", "unison", "follow", "detune"]);
const hardware = new Set(["sids", "sid", "address", "model", "mode", "cpu", "speed", "layout", "overrides", "clock"]);
function esc(s: string) { return s.replace(/~/g, "~0").replace(/\//g, "~1"); }
function classify(path: string): ChangeClass {
  const parts = path.split("/").slice(1);
  if (parts.includes("patterns") || parts.includes("timeline") || parts.includes("voices") && parts.includes("groove")) return "musical";
  if (parts.some((x) => hardware.has(x))) return "hardware";
  if (parts.some((x) => synthesis.has(x))) return "synthesis";
  if (parts.some((x) => musical.has(x))) return "musical";
  return "structural";
}
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

export function mergeSidwave(base: string, ours: string, theirs: string): { merged?: string; conflicts: Conflict[] } {
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
    conflicts.push({ path: path || "", ...(bv === undefined ? {} : { base: bv }), ...(ov === undefined ? {} : { ours: ov }), ...(tv === undefined ? {} : { theirs: tv }), summary: `Concurrent edits at ${path || "/"}` });
    return ov;
  };
  const result = merge(b, o, t, "");
  if (conflicts.length) return { conflicts };
  try { const merged = formatSidwave(YAML.stringify(result)); parseSidwave(merged); return { merged, conflicts }; }
  catch (e) { return { conflicts: [{ path: "", summary: e instanceof Error ? e.message : String(e) }] }; }
}
