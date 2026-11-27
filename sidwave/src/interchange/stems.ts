// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Stem rendering: each voice alone, through the same player and engine as the mix.

import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "../sidwaveCompiler.js";
import { songDoc } from "../sidwaveSongs.js";
import { createLibsidplayfpEngine, type SidEngine, type SidEmulation } from "../engine/libsidplayfp.js";

export interface StemOptions {
  /** Seconds to render per file. Default: the song length, at most 600. */
  seconds?: number;
  sampleRate?: number;
  model?: "6581" | "8580";
  /** Song of a document with `songs` (0-based). */
  song?: number;
  emulation?: SidEmulation;
  engine?: SidEngine;
}

export interface StemInfo {
  /** Voice ids that sound in this file. A voice that echoes, follows or doubles another voice is rendered together with its source. */
  voices: number[];
  name?: string;
  samples: Int16Array;
}

/**
 * The stems of a score without coupling add up to the mix in energy within this relative tolerance. They do not add up
 * sample by sample: a muted voice shortens the player's play call, so the register writes of the voices after it land a few
 * hundred cycles earlier and their oscillator phases differ from the mix. (Measured on SIDLite: relative RMS error 0.3 to 0.4.)
 */
export const STEM_ENERGY_TOLERANCE = 0.15;

export interface CouplingFinding { kind: "filter" | "ring" | "sync" | "copy"; detail: string }

export interface StemResult {
  sampleRate: number;
  seconds: number;
  mix: Int16Array;
  stems: StemInfo[];
  /** Facts that make the voices influence each other. Empty when the stems add up to the mix. */
  coupling: CouplingFinding[];
  /** True when nothing couples the voices and the measured energy ratio is within STEM_ENERGY_TOLERANCE. */
  additive: boolean;
  energyWithinTolerance: boolean;
  /** Difference between the sum of the stems and the mix without its idle baseline. A pass/fail check only when `additive`. */
  sumError: {
    /** Energy of the stems added up, divided by the energy of the mix without its baseline. 1 when the stems add up exactly. */
    energyRatio: number;
    /** Sample-exact differences. Not a pass/fail value: see STEM_ENERGY_TOLERANCE. */
    maxAbs: number;
    rms: number;
    mixRms: number;
    relativeRms: number;
  };
  engine: { id: string; version: string; emulation: SidEmulation };
}

/** Facts of the score that couple voices: a filter shared by several voices, ring modulation and hard sync. */
export function detectCoupling(doc: ParsedSidwave, arrangement = arrangeSidwave(doc)): CouplingFinding[] {
  const findings: CouplingFinding[] = [];
  const instruments = new Set(arrangement.voices.flatMap((voice) => voice.notes.map((note) => note.inst)));
  const routed = [...instruments].filter((i) => arrangement.instruments[i]!.filter).length;
  const tables = [...instruments].filter((i) => arrangement.instruments[i]!.filtertable).length;
  if (arrangement.filter.used || arrangement.chips?.some((chip) => chip.filter?.used || chip.hasFilterTable || chip.hasFilterMod) || tables) {
    findings.push({ kind: "filter", detail: `the SID filter is in use (${routed} instrument variants routed through it); it is shared by the routed voices` });
  }
  const ring = [...instruments].filter((i) => arrangement.instruments[i]!.wave & 0x04).length;
  const sync = [...instruments].filter((i) => arrangement.instruments[i]!.wave & 0x02).length;
  if (ring) findings.push({ kind: "ring", detail: `${ring} instrument variants use ring modulation, which follows the oscillator of the neighbouring voice` });
  if (sync) findings.push({ kind: "sync", detail: `${sync} instrument variants use hard sync, which follows the oscillator of the neighbouring voice` });
  return findings;
}

/** Voice ids that must sound together with `id`: the sources of its echo, unison and follow copies. */
function dependencies(doc: ParsedSidwave, id: number): Set<number> {
  const byId = new Map(doc.voices.map((voice) => [voice.id, voice]));
  const out = new Set<number>([id]);
  const stack = [id];
  while (stack.length) {
    const voice = byId.get(stack.pop()!);
    const source = voice?.echo?.voice ?? voice?.unison?.voice ?? voice?.follow?.voice;
    if (source !== undefined && !out.has(source)) { out.add(source); stack.push(source); }
  }
  return out;
}

/** A copy of the score in which only the listed voices play: the other voices' layers become rests. */
export function keepVoices(doc: ParsedSidwave, keep: ReadonlySet<number>): ParsedSidwave {
  const mute = (timeline: ParsedSidwave["timeline"]) => timeline.map((section) => ({
    ...section,
    layers: Object.fromEntries(Object.entries(section.layers).map(([key, value]) => {
      const id = /^v(\d+)$/.exec(key);
      return [key, id && !keep.has(Number(id[1])) ? "-" : value];
    })),
  }));
  return { ...doc, timeline: mute(doc.timeline), ...(doc.songs ? { songs: doc.songs.map((song) => ({ ...song, timeline: mute(song.timeline) })) } : {}) };
}

function toPsid(doc: ParsedSidwave): Uint8Array {
  const prg = compileSidwaveToPrg(doc);
  return new Uint8Array(compileSidwaveToSid(doc, prg.prg, { initAddress: prg.initAddress, playAddress: prg.playAddress }).sid);
}

/** Renders the mix and one stem per voice. Throws for scores that cannot be a PSID (digi samples, more than 3 SIDs). */
export async function renderStems(input: ParsedSidwave, options: StemOptions = {}): Promise<StemResult> {
  const doc = input.songs ? songDoc(input, options.song ?? 0) : input;
  if (options.song && !input.songs) throw new RangeError("the score has no songs");
  if (doc.samples || doc.digiVoices?.length) throw new Error("stems of scores with digi samples are not supported (the PSID player omits the CIA2 NMI samples)");
  if (doc.sids.length > 3) throw new Error("stems are rendered through a PSID, which supports at most 3 SIDs");
  const emulation = options.emulation ?? "sidlite";
  const engine = options.engine ?? createLibsidplayfpEngine({ emulation });
  const arrangement = arrangeSidwave(doc);
  const seconds = options.seconds ?? Math.min(600, arrangement.totalFrames / arrangement.fps);
  const sampleRate = options.sampleRate ?? 44_100;
  const request = { seconds, sampleRate, channels: 1 as const, ...(options.model ? { model: options.model } : {}) };
  const mix = await engine.render({ sid: toPsid(doc), ...request });
  const coupling = detectCoupling(doc, arrangement);

  // An idle SID is not silent: the emulation adds a constant offset per voice and for the master volume. Render the
  // score with every voice muted and subtract that baseline, so that a stem holds only what its voices add.
  const baseline = (await engine.render({ sid: toPsid(keepVoices(doc, new Set())), ...request })).samples;
  const clip = (value: number): number => Math.max(-32768, Math.min(32767, value));
  const stems: StemInfo[] = [];
  for (const voice of doc.voices) {
    const group = [...dependencies(doc, voice.id)].sort((a, b) => a - b);
    const rendered = (await engine.render({ sid: toPsid(keepVoices(doc, new Set(group))), ...request })).samples;
    const samples = new Int16Array(rendered.length);
    for (let i = 0; i < samples.length; i++) samples[i] = clip(rendered[i]! - (baseline[i] ?? 0));
    stems.push({ voices: group, ...(voice.name ? { name: voice.name } : {}), samples });
  }

  const n = mix.samples.length;
  let maxAbs = 0, sq = 0, mixSq = 0, stemSq = 0;
  const copies = doc.voices.filter((voice) => dependencies(doc, voice.id).size > 1).length;
  if (copies) coupling.push({ kind: "copy", detail: `${copies} voices echo, follow or double another voice and are rendered together with their source, so their stems overlap` });
  // Compared without the idle baseline: sum of stems against mix - baseline.
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const stem of stems) { const v = stem.samples[i] ?? 0; sum += v; stemSq += v * v; }
    const target = mix.samples[i]! - (baseline[i] ?? 0);
    const diff = sum - target;
    maxAbs = Math.max(maxAbs, Math.abs(diff));
    sq += diff * diff;
    mixSq += target * target;
  }
  const rms = Math.sqrt(sq / Math.max(1, n));
  const mixRms = Math.sqrt(mixSq / Math.max(1, n));
  return {
    sampleRate, seconds: n / sampleRate, mix: mix.samples, stems, coupling,
    additive: coupling.length === 0 && Math.abs((mixSq > 0 ? stemSq / mixSq : 1) - 1) <= STEM_ENERGY_TOLERANCE,
    energyWithinTolerance: Math.abs((mixSq > 0 ? stemSq / mixSq : 1) - 1) <= STEM_ENERGY_TOLERANCE,
    sumError: { energyRatio: mixSq > 0 ? stemSq / mixSq : 1, maxAbs, rms, mixRms, relativeRms: mixRms > 0 ? rms / mixRms : 0 },
    engine: mix.engine,
  };
}
