// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID count retargeting: fewer SIDs means fewer voices; voices are ranked and the lowest ranks are dropped.

import YAML from "yaml";
import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave } from "../sidwaveCompiler.js";
import { isObject, pointer, type AnyDoc, type RetargetChange } from "./types.js";

export type VoiceClass = "lead" | "bass" | "harmony" | "percussion" | "copy";
const CLASS_ORDER: VoiceClass[] = ["lead", "bass", "harmony", "percussion", "copy"];

export interface VoiceDecision {
  /** Voice id in the source score. */
  id: number;
  name?: string;
  role?: string;
  class: VoiceClass;
  /** 1 is the most important voice. */
  rank: number;
  notes: number;
  soundingSeconds: number;
  meanMidi: number | null;
  decision: "kept" | "dropped";
  /** Voice id in the result for a kept voice. */
  newId?: number;
  reason: string;
}

export interface SidsResult {
  changes: RetargetChange[];
  voices: VoiceDecision[];
}

interface Candidate {
  id: number;
  raw: any;
  slot: number;
  cls: VoiceClass;
  notes: number;
  seconds: number;
  meanMidi: number | null;
  density: number;
  source?: number;
}

const ROLE_CLASS: Record<string, VoiceClass> = { lead: "lead", bass: "bass", drums: "percussion", pad: "harmony", arp: "harmony" };

/** Voice ids named by copy fields: echo, unison and follow voices play another voice's notes. */
function copySource(raw: any): number | undefined {
  for (const key of ["echo", "unison", "follow"]) if (isObject(raw[key]) && typeof raw[key].voice === "number") return raw[key].voice;
  return undefined;
}

/** The deterministic voice ranking used for reductions: class order, then sounding time, then lower id. */
export function rankVoices(parsed: ParsedSidwave, js: any): Candidate[] {
  const arrangement = arrangeSidwave(parsed);
  const seconds = arrangement.totalFrames / arrangement.fps;
  const raws: any[] = (js.voices ?? []).filter((voice: any) => isObject(voice) && voice.digi === undefined);
  const candidates: Candidate[] = parsed.voices.map((voice, i) => {
    const raw = raws[i] ?? {};
    const slot = parsed.voiceSlots.get(voice.id)!;
    const notes = (arrangement.voices[slot]?.notes ?? []).filter((note) => !note.hidden);
    const sounding = notes.reduce((sum, note) => sum + Math.max(0, note.end - note.start), 0) / arrangement.fps;
    const pitched = notes.filter((note) => !note.percussion);
    const mean = pitched.length ? pitched.reduce((sum, note) => sum + note.midi, 0) / pitched.length : null;
    const percussionShare = notes.length ? notes.filter((note) => note.percussion).length / notes.length : 0;
    const source = copySource(raw);
    let cls: VoiceClass;
    if (source !== undefined) cls = "copy";
    else if (voice.role && ROLE_CLASS[voice.role]) cls = ROLE_CLASS[voice.role]!;
    else if (percussionShare >= 0.5 || (notes.length > 0 && pitched.length === 0)) cls = "percussion";
    else if (mean !== null && mean < 48) cls = "bass";
    else cls = "harmony";
    return { id: voice.id, raw, slot, cls, notes: notes.length, seconds: sounding, meanMidi: mean, density: seconds > 0 ? notes.length / seconds : 0, ...(source === undefined ? {} : { source }) };
  });
  // Without an explicit lead role, the voice with the highest mean pitch among those at or above the median note density leads.
  if (!candidates.some((c) => c.cls === "lead")) {
    const melodic = candidates.filter((c) => c.cls === "harmony" && c.meanMidi !== null);
    const densities = melodic.map((c) => c.density).sort((a, b) => a - b);
    const median = densities.length ? densities[Math.floor(densities.length / 2)]! : 0;
    const lead = melodic.filter((c) => c.density >= median).sort((a, b) => b.meanMidi! - a.meanMidi! || a.id - b.id)[0];
    if (lead) lead.cls = "lead";
  }
  const byImportance = (a: Candidate, b: Candidate) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) || b.seconds - a.seconds || a.id - b.id;
  return candidates.sort(byImportance);
}

function pickVoices(ranked: Candidate[], capacity: number): { kept: Set<number>; reasons: Map<number, string> } {
  const kept = new Set<number>();
  const reasons = new Map<number, string>();
  const take = (candidate: Candidate, why: string) => {
    if (kept.size >= capacity || kept.has(candidate.id)) return false;
    if (candidate.source !== undefined && !kept.has(candidate.source)) return false;
    kept.add(candidate.id);
    reasons.set(candidate.id, why);
    return true;
  };
  // One voice of each class first (lead, bass, harmony, percussion), so that a small result keeps every part of the tune.
  for (const cls of CLASS_ORDER.slice(0, 4)) {
    const best = ranked.find((c) => c.cls === cls);
    if (best) take(best, `best ${cls} voice`);
  }
  for (const candidate of ranked.filter((c) => c.cls !== "copy")) take(candidate, `${candidate.cls} voice with the next highest rank`);
  for (let pass = 0; pass < ranked.length; pass++) {
    let any = false;
    for (const candidate of ranked.filter((c) => c.cls === "copy")) any = take(candidate, "copy voice kept: free slot and its source is kept") || any;
    if (!any) break;
  }
  return { kept, reasons };
}

const sidHex = (address: number) => `$${address.toString(16).toUpperCase().padStart(4, "0")}`;

/** Paths of the maps in sections and timelines whose keys name voices (`v3`) or SIDs. */
export function layerHolders(js: any): Array<Array<string | number>> {
  const holders: Array<Array<string | number>> = [];
  const collect = (entry: any, base: Array<string | number>) => {
    if (!isObject(entry)) return;
    for (const field of ["layers", "levels", "volume", "filter"]) if (isObject(entry[field])) holders.push([...base, field]);
  };
  for (const [name, section] of Object.entries<any>(js.sections ?? {})) collect(section, ["sections", name]);
  (js.timeline ?? []).forEach((entry: any, i: number) => collect(entry, ["timeline", i]));
  (js.songs ?? []).forEach((song: any, s: number) => (song.timeline ?? []).forEach((entry: any, i: number) => collect(entry, ["songs", s, "timeline", i])));
  return holders;
}

/** Removes the items of a YAML map for which `drop` is true and renames keys through `rename`. */
export function editKeys(doc: AnyDoc, path: Array<string | number>, drop: (key: string) => boolean, rename: (key: string) => string): number {
  const node = doc.getIn(path, true);
  if (!YAML.isMap(node)) return 0;
  let removed = 0;
  node.items = node.items.filter((pair: any) => {
    const key = String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
    if (drop(key)) { removed++; return false; }
    const next = rename(key);
    if (next !== key) { if (YAML.isScalar(pair.key)) pair.key.value = next; else pair.key = next; }
    return true;
  });
  return removed;
}

/**
 * Reduces the score to `count` SIDs. Keeps up to 3 x count voices chosen by rank, moves kept voices from removed
 * SIDs into free channels of the remaining SIDs and drops everything else. Edits `doc` in place.
 */
export function retargetSids(doc: AnyDoc, parsed: ParsedSidwave, count: number, options: { digis: "remap" | "drop" } = { digis: "remap" }): SidsResult {
  const changes: RetargetChange[] = [];
  const js = doc.toJS() as any;
  const have = parsed.sids.length;
  if (count >= have) {
    changes.push({ step: "sids", construct: "sids", class: "exact", summary: `the score has ${have} SID(s) and the target ${count === have ? "has the same number" : `has ${count}`}; no change needed` });
    return { changes, voices: [] };
  }
  const capacity = count * 3;
  const ranked = rankVoices(parsed, js);
  const { kept, reasons } = pickVoices(ranked, capacity);

  // Slots: a kept voice on a remaining SID keeps its channel; the others take the free channels in rank order.
  const newSlot = new Map<number, number>();
  const used = new Set<number>();
  for (const candidate of ranked) if (kept.has(candidate.id) && candidate.slot < capacity) { newSlot.set(candidate.id, candidate.slot); used.add(candidate.slot); }
  let free = 0;
  for (const candidate of ranked) {
    if (!kept.has(candidate.id) || newSlot.has(candidate.id)) continue;
    while (used.has(free)) free++;
    newSlot.set(candidate.id, free);
    used.add(free);
  }
  const newId = (id: number) => newSlot.get(id)! + 1;
  /** Whether the voice was routed through the filter of its source SID. */
  const routed = (id: number) => {
    const slot = ranked.find((c) => c.id === id)!.slot;
    const filter = parsed.sids[Math.floor(slot / 3)]?.filter;
    return !!filter && (filter.route ?? []).includes(slot % 3 + 1);
  };

  const decisions: VoiceDecision[] = ranked.map((candidate, index) => {
    const isKept = kept.has(candidate.id);
    const label = candidate.raw.name ?? candidate.raw.role ?? `voice ${candidate.id}`;
    const moved = isKept && newSlot.get(candidate.id) !== candidate.slot;
    const decision: VoiceDecision = {
      id: candidate.id, ...(candidate.raw.name ? { name: String(candidate.raw.name) } : {}), ...(candidate.raw.role ? { role: String(candidate.raw.role) } : {}),
      class: candidate.cls, rank: index + 1, notes: candidate.notes, soundingSeconds: Number(candidate.seconds.toFixed(2)),
      meanMidi: candidate.meanMidi === null ? null : Number(candidate.meanMidi.toFixed(1)),
      decision: isKept ? "kept" : "dropped",
      ...(isKept ? { newId: newId(candidate.id) } : {}),
      reason: isKept ? `${reasons.get(candidate.id)}${moved ? `; moved from voice slot ${candidate.slot + 1} to ${newSlot.get(candidate.id)! + 1}` : ""}`
        : candidate.cls === "copy" && candidate.source !== undefined && !kept.has(candidate.source)
          ? `copy of voice ${candidate.source}, which is dropped`
          : `rank ${index + 1} of ${ranked.length} does not fit in ${capacity} voice(s)`,
    };
    changes.push({
      step: "sids", construct: "voice", path: `/voices/id=${candidate.id}`,
      class: isKept ? "exact" : "dropped",
      summary: isKept
        ? `voice ${candidate.id} (${label}, ${candidate.cls}) kept${moved ? ` as voice ${newId(candidate.id)}` : ""}`
        : `voice ${candidate.id} (${label}, ${candidate.cls}, ${candidate.notes} notes, ${candidate.seconds.toFixed(1)} s sounding) dropped: ${decision.reason}`,
      measured: { rank: index + 1, notes: candidate.notes, soundingSeconds: decision.soundingSeconds },
    });
    return decision;
  });
  // Kept voices are exact only when nothing about them changed; a moved voice shares a SID with other voices (filter, volume).
  for (const change of changes) {
    const id = Number(/id=(\d+)/.exec(change.path ?? "")?.[1]);
    if (change.class === "exact" && newSlot.get(id) !== undefined && newSlot.get(id) !== ranked.find((c) => c.id === id)!.slot) change.class = "approximate";
  }

  // Voice list.
  const keptSids = parsed.sids.slice(0, count);
  const keptSidIds = new Set(keptSids.map((sid) => String(sid.id)));
  const droppedSidIds = new Set(parsed.sids.slice(count).map((sid) => String(sid.id)));
  const rawVoices: any[] = js.voices ?? [];
  let voiceIndex = -1;
  const entries = rawVoices.map((raw, i) => {
    if (isObject(raw) && raw.digi === undefined) { voiceIndex++; return { i, voice: parsed.voices[voiceIndex]!.id, digi: false }; }
    return { i, voice: 0, digi: true };
  });
  const firstSid = String(keptSids[0]!.id);
  const droppedDigis = new Set<string>();
  for (const entry of [...entries].reverse()) {
    if (entry.digi) {
      const raw = rawVoices[entry.i];
      if (droppedSidIds.has(String(raw.digi))) {
        if (options.digis === "remap") {
          doc.setIn(["voices", entry.i, "digi"], firstSid);
          changes.push({ step: "sids", construct: "digi-voice", path: pointer(["voices", entry.i, "digi"]), class: "approximate", before: raw.digi, after: firstSid,
            summary: `digi voice ${raw.id} moved from the removed SID ${raw.digi} to ${firstSid}; its samples now share $D418 with that SID's voices` });
        } else {
          doc.deleteIn(["voices", entry.i]);
          droppedDigis.add(String(raw.id));
          changes.push({ step: "sids", construct: "digi-voice", class: "dropped", summary: `digi voice ${raw.id} on the removed SID ${raw.digi} dropped` });
        }
      }
      continue;
    }
    if (!kept.has(entry.voice)) { doc.deleteIn(["voices", entry.i]); continue; }
    const raw = rawVoices[entry.i];
    doc.setIn(["voices", entry.i, "id"], newId(entry.voice));
    for (const key of ["sid", "channel"]) if (raw[key] !== undefined) doc.deleteIn(["voices", entry.i, key]);
    if (raw.center !== undefined) {
      doc.deleteIn(["voices", entry.i, "center"]);
      changes.push({
        step: "sids", construct: "center-mirror", path: pointer(["voices", entry.i, "center"]), class: "dropped",
        summary: `voice ${entry.voice} was mirrored to ${raw.center.sid ?? "another SID"} channel ${raw.center.channel ?? "?"}; the mirror is dropped because the mirror voice lives on a SID that no longer exists or has no free channel`,
      });
    }
    for (const key of ["echo", "unison", "follow"]) {
      if (isObject(raw[key]) && typeof raw[key].voice === "number") doc.setIn(["voices", entry.i, key, "voice"], newId(raw[key].voice));
    }
  }

  // References by voice id and SID id in sections and timelines.
  const voiceKey = (key: string) => {
    const match = /^v(\d+)$/.exec(key);
    return match ? Number(match[1]) : undefined;
  };
  const holders = layerHolders(js);
  let sectionDrops = 0;
  for (const path of holders) {
    const field = String(path[path.length - 1]);
    if (field === "layers" || field === "levels") {
      sectionDrops += editKeys(doc, path, (key) => {
        const id = voiceKey(key);
        if (droppedDigis.has(key)) return true;
        return id !== undefined && !kept.has(id);
      }, (key) => {
        const id = voiceKey(key);
        return id !== undefined ? `v${newId(id)}` : key;
      });
    } else {
      sectionDrops += editKeys(doc, path, (key) => droppedSidIds.has(key), (key) => key);
    }
  }
  if (sectionDrops > 0) {
    changes.push({ step: "sids", construct: "section-entries", class: "dropped", summary: `${sectionDrops} section layer, level, volume or filter entr${sectionDrops === 1 ? "y" : "ies"} for dropped voices and SIDs removed`, measured: { count: sectionDrops } });
  }

  // Samples that name a removed SID.
  if (isObject(js.samples)) {
    for (const key of ["voices", "triggers"]) {
      const list = js.samples[key];
      if (!Array.isArray(list)) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const sid = list[i]?.sid;
        if (sid === undefined || !droppedSidIds.has(String(sid))) continue;
        if (options.digis === "remap") doc.setIn(["samples", key, i, "sid"], firstSid);
        else doc.deleteIn(["samples", key, i]);
      }
    }
  }
  if (options.digis === "drop" && (parsed.samples || parsed.digiVoices?.length) && droppedSidIds.size > 0) {
    // Keep the document consistent when no digi voice is left.
    const remaining = (doc.toJS() as any).voices?.some((voice: any) => isObject(voice) && voice.digi !== undefined);
    if (!remaining && !(doc.toJS() as any).samples?.voices?.length && !(doc.toJS() as any).samples?.triggers?.length) doc.deleteIn(["samples"]);
  }

  // The SID list.
  const rawSids: any[] = Array.isArray(js.sids) ? js.sids : [];
  const sidEntries = keptSids.map((sid, j) => {
    const sourceEntry = Array.isArray(js.sids) ? rawSids[j] : js.sids?.overrides?.[sid.id] ?? {};
    const entry: Record<string, unknown> = { id: sid.id, address: sidHex(sid.address) };
    if (sid.model) entry.model = sid.model;
    if (sid.volume !== 15) entry.volume = sid.volume;
    if (sid.pan && count > 1) entry.pan = sid.pan;
    else if (sid.pan) {
      changes.push({ step: "sids", construct: "sid-pan", class: "dropped", before: sid.pan, summary: `pan "${sid.pan}" of ${sid.id} is dropped: a single SID has nothing to pan against` });
    }
    const filter = isObject(sourceEntry?.filter) ? { ...sourceEntry.filter } : undefined;
    if (filter) {
      const owner = typeof filter.owner === "string" ? Number(/^v(\d+)$/.exec(filter.owner)?.[1]) : typeof filter.owner === "number" ? filter.owner : undefined;
      const here = ranked.filter((c) => kept.has(c.id) && Math.floor(newSlot.get(c.id)! / 3) === j);
      let ownerId: number | undefined;
      if (owner !== undefined && kept.has(owner) && Math.floor(newSlot.get(owner)! / 3) === j) ownerId = owner;
      else if (here.length) ownerId = here[0]!.id;
      if (ownerId === undefined) {
        changes.push({ step: "sids", construct: "filter", class: "dropped", summary: `the filter of ${sid.id} (owner voice ${owner}) is dropped: no kept voice plays on that SID` });
      } else {
        const ownerSlot = newSlot.get(ownerId)!;
        if (ownerId !== owner) {
          changes.push({ step: "sids", construct: "filter-owner", class: "approximate", before: owner, after: newId(ownerId), summary: `the filter owner of ${sid.id} was voice ${owner}, which is gone or moved; voice ${newId(ownerId)} owns it now` });
          if (!routed(ownerId)) {
            changes.push({ step: "sids", construct: "filter-route", class: "approximate", summary: `voice ${newId(ownerId)} is now routed through the filter of ${sid.id} because it owns the filter; it was not filtered before` });
          }
        }
        filter.owner = `v${newId(ownerId)}`;
        // The route follows the voices: a voice that was routed to the filter of its old SID stays routed on its new channel.
        const route = new Set<number>([ownerSlot % 3 + 1]);
        for (const voice of here) if (routed(voice.id)) route.add(newSlot.get(voice.id)! % 3 + 1);
        filter.route = [...route].sort();
        entry.filter = filter;
      }
    }
    if (!entry.filter) {
      const lost = ranked.filter((c) => kept.has(c.id) && Math.floor(newSlot.get(c.id)! / 3) === j && routed(c.id));
      if (lost.length) {
        changes.push({ step: "sids", construct: "filter-route", class: "approximate", summary: `voice(s) ${lost.map((c) => newId(c.id)).join(", ")} were routed through a filter that ${sid.id} does not have; they now play unfiltered` });
      }
    }
    return entry;
  });
  for (const sid of parsed.sids.slice(count)) {
    const parts = [`address ${sidHex(sid.address)}`, ...(sid.model ? [`model ${sid.model}`] : []), `volume ${sid.volume}`, ...(sid.pan ? [`pan "${sid.pan}"`] : []),
      ...(sid.filter ? [`filter owned by voice ${sid.filter.owner ?? "?"}${sid.filter.filter_env ? " with a filter envelope" : ""}${sid.filter.filter_mod ? " with a filter modulation" : ""}`] : [])];
    const moved = ranked.filter((c) => kept.has(c.id) && Math.floor(c.slot / 3) === parsed.sids.indexOf(sid)).length;
    changes.push({
      step: "sids", construct: "sid", path: `/sids/${sid.id}`, class: sid.filter || moved > 0 ? "approximate" : "dropped",
      summary: `${sid.id} removed with its settings (${parts.join(", ")})${moved > 0 ? `; ${moved} kept voice(s) from it now play with the volume${sid.pan ? ", pan" : ""} and filter of the remaining SID(s)` : ""}`,
      measured: { volume: sid.volume, voicesMoved: moved },
    });
  }
  doc.setIn(["sids"], doc.createNode(sidEntries));
  changes.push({
    step: "sids", construct: "sids", class: kept.size < ranked.length ? "dropped" : "exact", before: have, after: count,
    summary: `${have} SIDs reduced to ${count}: ${kept.size} of ${ranked.length} voices kept`,
    measured: { kept: kept.size, dropped: ranked.length - kept.size },
  });
  return { changes, voices: decisions };
}
