// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The part of a score that is played: one song, some of the voices, from a bar, or one section in a loop. The result is
// an ordinary score that the production compiler compiles, so every target plays the same thing.

import { isModern, sectionBarBeats, type ParsedSidwave, type SidwaveTimelineSection } from "../sidwave.js";
import { sidwaveFrameRate } from "../sidwaveCompiler.js";
import { makeTimelineClock } from "../sidwaveForm.js";
import { songDoc } from "../sidwaveSongs.js";
import { SidwaveOperationError, UsageError } from "../cliCore.js";

export interface ScoreSelection {
  /** Song of a score with songs, 1-based. */
  song?: number;
  /** Play only these voices: ids, names, or digi voice ids such as "d1". */
  solo?: readonly string[];
  /** Silence these voices. */
  mute?: readonly string[];
  /** Start at this bar, 1-based. */
  fromBar?: number;
  /** Play one section in a loop: its name, or its 1-based position in the timeline. */
  loopSection?: string;
}

export interface SelectedScore {
  doc: ParsedSidwave;
  /** Whether the tune should loop: the caller's choice, and always true with loopSection. */
  loop: boolean;
  /** The bar of the score at which the compiled tune starts (the first bar of a section). */
  startBar: number;
  /** Seconds between that bar and --from-bar; a target that renders can discard them to start exactly there. */
  skipSeconds: number;
  /** What the listener should know about the selection. */
  notes: string[];
}

const input = (message: string) => new SidwaveOperationError("input", message);

function voiceList(doc: ParsedSidwave): string {
  return [...doc.voices.map((v) => `${v.id}${v.name && v.name !== `Voice${v.id}` ? ` (${v.name})` : ""}`), ...(doc.digiVoices ?? []).map((v) => v.id)].join(", ");
}

/** The layer keys ("v1", "d1") that `names` stand for. */
function layerKeys(doc: ParsedSidwave, flag: string, names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const voice = doc.voices.find((v) => String(v.id) === name || `v${v.id}` === name) ?? doc.voices.find((v) => v.name?.toLowerCase() === name.toLowerCase());
    if (voice) { keys.add(`v${voice.id}`); continue; }
    const digi = doc.digiVoices?.find((v) => v.id === name);
    if (digi) { keys.add(digi.id); continue; }
    throw input(`${flag} ${name}: the score has no such voice; its voices are ${voiceList(doc)}`);
  }
  return keys;
}

/** The score with only the chosen voices. A silenced voice rests and no longer copies or follows another voice. */
export function selectVoices(doc: ParsedSidwave, solo: readonly string[], mute: readonly string[]): { doc: ParsedSidwave; notes: string[] } {
  if (!solo.length && !mute.length) return { doc, notes: [] };
  if (solo.length && mute.length) throw new UsageError("use --solo or --mute, not both");
  const notes: string[] = [];
  const all = new Set([...doc.voices.map((v) => `v${v.id}`), ...(doc.digiVoices ?? []).map((v) => v.id)]);
  const sourceOf = (key: string): number | undefined => {
    const voice = doc.voices.find((v) => `v${v.id}` === key);
    return voice?.echo?.voice ?? voice?.unison?.voice ?? voice?.follow?.voice;
  };
  let keep: Set<string>;
  if (solo.length) {
    keep = layerKeys(doc, "--solo", solo);
    // A copy needs the notes of its source, so the source plays too.
    for (const key of keep) {
      const source = sourceOf(key);
      if (source !== undefined && !keep.has(`v${source}`)) {
        keep.add(`v${source}`);
        notes.push(`voice ${key.slice(1)} copies voice ${source}, which therefore plays too`);
      }
    }
  } else {
    const silent = layerKeys(doc, "--mute", mute);
    keep = new Set([...all].filter((key) => !silent.has(key)));
    // The notes of a copy come from its source: a muted source silences the copy as well.
    for (let changed = true; changed;) {
      changed = false;
      for (const key of keep) {
        const source = sourceOf(key);
        if (source !== undefined && !keep.has(`v${source}`)) {
          keep.delete(key);
          changed = true;
          notes.push(`voice ${key.slice(1)} copies voice ${source}, which is muted, so it is silent too`);
        }
      }
    }
  }
  const filterTimeline = (timeline: SidwaveTimelineSection[]) => timeline.map((section) => ({
    ...section,
    layers: Object.fromEntries(Object.entries(section.layers).map(([key, value]) => [key, keep.has(key) ? value : "-"])),
  }));
  const voices = doc.voices.map((voice) => {
    if (keep.has(`v${voice.id}`)) return voice;
    const { echo: _echo, unison: _unison, follow: _follow, ...plain } = voice;
    return plain;
  });
  let samples = doc.samples;
  if (solo.length && samples?.triggers.length) {
    const kept = (doc.digiVoices ?? []).some((v) => keep.has(v.id));
    if (!kept) {
      samples = { ...samples, triggers: [] };
      notes.push("sample triggers are silent with --solo; add the digi voice (for example d1) to hear samples");
    }
  }
  return { doc: { ...doc, voices, samples, timeline: filterTimeline(doc.timeline), ...(doc.songs ? { songs: doc.songs.map((s) => ({ ...s, timeline: filterTimeline(s.timeline) })) } : {}) }, notes };
}

interface Entry {
  section: SidwaveTimelineSection;
  bars: number;
  startBeat: number;
  endBeat: number;
  /** First bar, 1-based. */
  bar: number;
}

/** The sections of the song as they are played: the timeline repeated or cut to the length of the song. */
function playedSections(doc: ParsedSidwave): { entries: Entry[]; clock: ReturnType<typeof makeTimelineClock> } {
  const clock = makeTimelineClock(doc, sidwaveFrameRate(doc.song.mode) * doc.speed);
  let bar = 1;
  const entries = clock.sections.map((item) => {
    const bars = Math.round((item.endBeat - item.startBeat) / sectionBarBeats(item.section, doc.song.meter));
    const entry = { section: { ...item.section, bars }, bars, startBeat: item.startBeat, endBeat: item.endBeat, bar };
    bar += bars;
    return entry;
  });
  return { entries, clock };
}

function findSection(entries: Entry[], name: string): Entry {
  const byName = entries.find((e) => e.section.section === name);
  if (byName) return byName;
  if (/^\d+$/.test(name) && Number(name) >= 1 && Number(name) <= entries.length) return entries[Number(name) - 1]!;
  const names = [...new Set(entries.map((e) => e.section.section).filter(Boolean))];
  throw input(`--loop-section ${name}: the timeline has no such section; ${names.length ? `its sections are ${names.join(", ")}` : "its sections have no names"} (positions 1 to ${entries.length} also work)`);
}

/** The score cut to `parts` (in order), with the positional sample triggers moved along. */
function cut(doc: ParsedSidwave, parts: Entry[], loopTo: number | undefined): ParsedSidwave {
  const timeline = parts.map((e) => e.section);
  const length_bars = parts.reduce((sum, e) => sum + e.bars, 0);
  const result: ParsedSidwave = { ...doc, timeline, loopTo, end: undefined, song: { ...doc.song, length_bars } };
  if (!doc.samples?.triggers.length) return result;
  const before = playedSections(doc).clock;
  const after = playedSections(result).clock;
  let newStart = 0;
  const segments = parts.map((e) => {
    const segment = { from: e.startBeat, to: e.endBeat, at: newStart };
    newStart += e.endBeat - e.startBeat;
    return segment;
  });
  type Trigger = NonNullable<ParsedSidwave["samples"]>["triggers"][number];
  const triggers: Trigger[] = [];
  for (const trigger of doc.samples.triggers) {
    for (const s of segments) {
      if (trigger.at !== undefined) {
        const first = before.frameAt(s.from);
        if (trigger.at >= first && trigger.at < before.frameAt(s.to)) triggers.push({ ...trigger, at: trigger.at - first + after.frameAt(s.at) });
      } else if (trigger.beat! >= s.from && trigger.beat! < s.to) triggers.push({ ...trigger, beat: trigger.beat! - s.from + s.at });
    }
  }
  return { ...result, samples: { ...doc.samples, triggers } };
}

/** Applies a selection to a parsed score. */
export function selectScore(score: ParsedSidwave, selection: ScoreSelection = {}, loopWanted = false, gapBars = 0): SelectedScore {
  const { song, fromBar, loopSection } = selection;
  if (fromBar !== undefined && loopSection !== undefined) throw new UsageError("use --from-bar or --loop-section, not both");
  let doc = score;
  let loop = loopWanted;
  const songIndex = (song ?? 1) - 1;
  if (score.songs) {
    const chosen = score.songs[songIndex];
    if (!chosen) throw input(`--song ${song}: the score has ${score.songs.length} song${score.songs.length === 1 ? "" : "s"} (1 is the first)`);
    doc = songDoc(score, songIndex);
    loop = loopWanted && chosen.loop;
  } else if (songIndex !== 0) throw input(`--song ${song}: the score has one song (1 is the first)`);

  const voices = selectVoices(doc, selection.solo ?? [], selection.mute ?? []);
  doc = voices.doc;
  const notes = [...voices.notes];
  if (fromBar === undefined && loopSection === undefined) return { doc, loop, startBar: 1, skipSeconds: 0, notes };

  const { entries, clock } = playedSections(doc);
  if (loopSection !== undefined) {
    const entry = findSection(entries, loopSection);
    const rest: Entry[] = gapBars === 0 ? [] : [{
      section: { section: "", bars: gapBars, layers: Object.fromEntries(Object.keys(entry.section.layers).map((key) => [key, "-"])) },
      bars: gapBars, startBeat: entry.endBeat, endBeat: entry.endBeat + gapBars * doc.song.meter, bar: entry.bar + entry.bars,
    }];
    if (gapBars) notes.push(`the last note of the section is too short to be followed by its start; ${gapBars} bar of rest separates the repeats`);
    return { doc: cut(doc, [entry, ...rest], 0), loop: true, startBar: entry.bar, skipSeconds: 0, notes };
  }
  const total = doc.song.length_bars;
  if (!Number.isInteger(fromBar) || fromBar! < 1 || fromBar! > total) throw input(`--from-bar ${fromBar}: the song has bars 1 to ${total}`);
  const index = entries.findIndex((e) => fromBar! < e.bar + e.bars);
  const entry = entries[index]!;
  // With a loop, the rest of the song plays once and is followed by what the song repeats.
  const target = doc.loopTo ?? 0;
  const rest = entries.slice(index);
  const parts = !loop || index <= target ? rest : [...rest, ...entries.slice(target)];
  const loopTo = !loop ? undefined : index <= target ? target - index : rest.length;
  const barBeat = clock.barStarts[fromBar! - 1]!;
  const skipSeconds = isModern(doc)
    ? clock.sections[index]!.at(barBeat) - clock.sections[index]!.startTime
    : (barBeat - entry.startBeat) * 60 / doc.song.tempo;
  // An unchanged score keeps its `end`, so that --from-bar 1 plays what the score plays.
  const cutDoc = index === 0 && parts.length === entries.length ? doc : cut(doc, parts, loopTo);
  return { doc: cutDoc, loop, startBar: entry.bar, skipSeconds, notes };
}
