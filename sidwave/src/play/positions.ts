// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Line and column of a validation error or a lint finding in the text of a score.

import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { ParsedSidwave } from "../sidwave.js";

export interface Position { line: number; column: number }

/**
 * A locator for one score text. `path(p)` takes a validation path such as "$.voices[0].patterns.A" and returns the
 * position of the deepest part of it that the text contains. `finding(first, doc)` takes the position string of a lint
 * finding such as "bar 5 v2".
 */
export function scoreLocator(text: string): { path(path: string): Position | undefined; finding(first: string, doc?: ParsedSidwave): Position | undefined } {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const at = (offset: number): Position => { const p = lines.linePos(offset); return { line: p.line, column: p.col }; };

  const path = (wanted: string): Position | undefined => {
    const syntax = document.errors[0];
    if (syntax) return at(syntax.pos[0]);
    let node = document.contents as Node | null;
    let offset: number | undefined;
    let rest = wanted.replace(/^\$/, "");
    while (rest && node) {
      const index = /^\[(\d+)\]/.exec(rest);
      if (index) {
        if (!isSeq(node)) break;
        node = node.items[Number(index[1])] as Node | null;
        rest = rest.slice(index[0].length);
      } else if (rest.startsWith(".")) {
        rest = rest.slice(1);
        if (isMap(node)) {
          // Keys may contain dots, so the longest key that starts the rest of the path wins.
          let best: { key: string; offset: number | undefined; value: Node | null } | undefined;
          for (const pair of node.items) {
            const keyNode = pair.key as Node;
            const key = String(isScalar(keyNode) ? keyNode.value : keyNode);
            const matches = rest === key || rest.startsWith(`${key}.`) || rest.startsWith(`${key}[`);
            if (matches && (!best || key.length > best.key.length)) best = { key, offset: keyNode.range?.[0], value: pair.value as Node | null };
          }
          if (!best) break;
          offset = best.offset;
          node = best.value;
          rest = rest.slice(best.key.length);
          continue;
        }
        // "$.voices.v3" names a voice of a list by its id.
        const voice = /^v(\d+)/.exec(rest);
        if (!voice || !isSeq(node)) break;
        const found = node.items.find((item) => isMap(item) && String(item.get("id")) === voice[1]) ?? node.items[Number(voice[1]) - 1];
        node = (found ?? null) as Node | null;
        rest = rest.slice(voice[0].length);
      } else break;
      if (node?.range) offset = node.range[0];
    }
    return offset === undefined ? (node?.range ? at(node.range[0]) : undefined) : at(offset);
  };

  /** The index in the raw voice list of the voice with this id. */
  const voiceIndex = (id: number, doc: ParsedSidwave): number | undefined => {
    const voices = document.get("voices");
    if (!isSeq(voices)) return undefined;
    const byId = voices.items.findIndex((item) => isMap(item) && Number(item.get("id")) === id);
    if (byId >= 0) return byId;
    const order = doc.voices.findIndex((v) => v.id === id);
    return order < 0 ? undefined : order;
  };

  /** The index in the raw timeline of entry `index` of the expanded one ("chorus*3" stands for three entries). */
  const rawEntry = (index: number): number => {
    const timeline = document.get("timeline");
    if (!isSeq(timeline)) return index;
    let seen = 0;
    for (let i = 0; i < timeline.items.length; i++) {
      const item = timeline.items[i];
      const repeat = isScalar(item) ? Number(/\*(\d+)$/.exec(String(item.value))?.[1] ?? 1) : 1;
      seen += repeat;
      if (index < seen) return i;
    }
    return index;
  };

  const finding = (first: string, doc?: ParsedSidwave): Position | undefined => {
    const pattern = /voice (\d+) pattern "([^"]+)"/.exec(first);
    const bar = /\bbar (\d+)(?: v(\d+))?/.exec(first);
    const voice = /^v(\d+)\b/.exec(first);
    const section = /^section "([^"]+)"/.exec(first);
    if (!doc) return undefined;
    if (pattern) {
      const index = voiceIndex(Number(pattern[1]), doc);
      return index === undefined ? undefined : path(`$.voices[${index}].patterns.${pattern[2]}`);
    }
    if (section) return path(`$.sections.${section[1]}`);
    if (voice) {
      const index = voiceIndex(Number(voice[1]), doc);
      return index === undefined ? undefined : path(`$.voices[${index}]`);
    }
    if (bar && !doc.songs) {
      // The section of the bar, and the first pattern its voice plays there.
      let start = 1;
      let entry = 0;
      for (let i = 0; i < doc.timeline.length * 1000; i++) {
        entry = i % doc.timeline.length;
        start += doc.timeline[entry]!.bars;
        if (Number(bar[1]) < start) break;
      }
      if (bar[2] !== undefined) {
        const id = Number(bar[2]);
        const ref = doc.timeline[entry]?.layers[`v${id}`];
        const patterns = doc.voices.find((v) => v.id === id)?.patterns ?? {};
        const name = ref?.split(/[^\w-]+/).find((word) => Object.prototype.hasOwnProperty.call(patterns, word));
        const index = voiceIndex(id, doc);
        if (name !== undefined && index !== undefined) return path(`$.voices[${index}].patterns.${name}`);
      }
      return path(`$.timeline[${rawEntry(entry)}]`);
    }
    return undefined;
  };

  return {
    path,
    finding: (first, doc) => finding(first, doc),
  };
}
