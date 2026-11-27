// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Structured event export: a parsed score as a JSON event list. The MIDI and MusicXML exporters build on it.

import type { ParsedSidwave } from "../sidwave.js";
import { songDoc } from "../sidwaveSongs.js";
import { arrangeSidwave, type ArrangedNote, type Arrangement, type Instrument } from "../sidwaveCompiler.js";

export const EVENT_SCHEMA = "sidwave.events/1";
export const DEFAULT_PPQ = 480;

export interface ExportedTempo { tick: number; time: number; bpm: number }
export interface ExportedTimeSignature { tick: number; time: number; bar: number; numerator: number; denominator: number }
export interface ExportedSection { index: number; name?: string; bar: number; bars: number; tick: number; time: number }

export interface ExportedInstrument {
  /** Index in the compiled instrument table; notes refer to it. Instrument 0 is the neutral placeholder and is not exported. */
  index: number;
  /** Score name of the instrument, `lib:` prefix for the built-in library, when a note names one. */
  name?: string;
  waveform: string;
  adsr: [number, number, number, number];
  pulseWidth?: number;
  vibrato?: { depthSemitones: number; rateHz: number; delayCalls: number };
  arpeggio?: { offsets: number[]; callsPerStep: number };
  slide?: { semitones: number; speed: number };
  ring: boolean;
  sync: boolean;
  filterRouted: boolean;
  /** True when a wavetable, pulse table or filter table changes the sound after the note starts. */
  tables: { wave: boolean; pulse: boolean; filter: boolean };
}

export interface ExportedNoteEffects {
  legato?: boolean;
  accented?: boolean;
  /** Pitch glide: the note starts at `from` and reaches its pitch after `seconds`. */
  bend?: { from: number; to: number; seconds: number };
  /** Frames after the note start at which the gate closes early (SIDWave `gate_off`), in seconds. */
  gateOffSeconds?: number;
  chord?: { offsets: number[]; callsPerStep: number };
}

export interface ExportedNote {
  id: number;
  /** Index into `voices`. */
  voice: number;
  pitch: number;
  /** MIDI velocity 1..127 derived from the sustain level and the SID volume; see doc/interchange.md. */
  velocity: number;
  velocityBasis: "sustain" | "default";
  instrument: number;
  on: { tick: number; time: number };
  off: { tick: number; time: number };
  durationTicks: number;
  percussion?: boolean;
  /** Name of the percussion instrument when the note is a drum hit. */
  drum?: string;
  effects?: ExportedNoteEffects;
}

export type ExportedEvent =
  | { type: "noteOn"; tick: number; time: number; voice: number; note: number; pitch: number; velocity: number }
  | { type: "noteOff"; tick: number; time: number; voice: number; note: number; pitch: number }
  | { type: "tempo"; tick: number; time: number; bpm: number }
  | { type: "timeSignature"; tick: number; time: number; numerator: number; denominator: number };

export interface ExportedVoice {
  index: number;
  /** Declared voice id of the score. */
  id: number;
  name?: string;
  role?: string;
  /** Zero-based SID and channel (1..3) the voice plays on. */
  sid: number;
  channel: number;
  kind: "pitched" | "drums";
  notes: ExportedNote[];
}

export interface ExportedScore {
  schema: typeof EVENT_SCHEMA;
  title: string;
  author?: string;
  mode: "PAL" | "NTSC";
  song: number;
  ppq: number;
  /** Player calls per second. Times are exact multiples of one call at this rate. */
  callRate: number;
  durationSeconds: number;
  totalTicks: number;
  tempoMap: ExportedTempo[];
  timeSignatures: ExportedTimeSignature[];
  sections: ExportedSection[];
  instruments: ExportedInstrument[];
  voices: ExportedVoice[];
  /** All note and meta events in time order (note-offs before note-ons at the same tick). */
  events: ExportedEvent[];
  /** What the export leaves out or approximates for this score. */
  losses: string[];
}

export interface EventExportOptions {
  /** Song of a document with `songs` (0-based). Default 0. */
  song?: number;
  /** Ticks per quarter note, 24..9600. Default 480. */
  ppq?: number;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
/** Beat grid used to snap derived tick positions: 1/24 beat covers 32nd notes, 16th notes and triplets. */
const GRID = 24;

export function waveformName(wave: number): string {
  const names: string[] = [];
  if (wave & 0x10) names.push("triangle");
  if (wave & 0x20) names.push("saw");
  if (wave & 0x40) names.push("pulse");
  if (wave & 0x80) names.push("noise");
  return names.length ? names.join("+") : "none";
}

function vibratoDepth(mantissa: number, shift: number): number {
  const k = (mantissa / 2 ** (8 + shift)) * (126 / 128);
  return round6(12 * Math.log2(1 + k));
}

function describeInstrument(inst: Instrument, index: number, fps: number, name: string | undefined): ExportedInstrument {
  const out: ExportedInstrument = {
    index,
    ...(name ? { name } : {}),
    waveform: waveformName(inst.wave),
    adsr: [inst.ad >> 4, inst.ad & 15, inst.sr >> 4, inst.sr & 15],
    ring: !!(inst.wave & 0x04),
    sync: !!(inst.wave & 0x02),
    filterRouted: !!inst.filter,
    tables: { wave: !!inst.wavetable?.length, pulse: !!inst.pulsetable?.steps.length, filter: !!inst.filtertable?.steps.length },
  };
  if (inst.wave & 0x40) out.pulseWidth = inst.pw;
  if (inst.vibRate) {
    out.vibrato = { depthSemitones: vibratoDepth(inst.vibUp[0], inst.vibUp[1]), rateHz: round6(inst.vibRate * fps / 256), delayCalls: inst.vibDelay };
  }
  if (inst.arp.length) out.arpeggio = { offsets: inst.arp, callsPerStep: inst.arpSpeed };
  if (inst.slideSemis) out.slide = { semitones: inst.slideSemis, speed: inst.slideSpeed };
  return out;
}

/** Converts seconds to quarter-note beats against the arrangement's tempo curve. */
export function makeBeatMapper(arr: Arrangement, songTempo: number): { beatAt: (seconds: number) => number; fps: number } {
  const clock = arr.clock;
  const fps = arr.fps;
  if (!clock) return { fps, beatAt: (seconds) => seconds * songTempo / 60 };
  const sections = clock.sections;
  const beatAt = (seconds: number): number => {
    let item = sections[sections.length - 1]!;
    for (const candidate of sections) if (seconds < candidate.endTime) { item = candidate; break; }
    const tempo = typeof item.section.tempo === "number" ? item.section.tempo : songTempo;
    const length = item.endBeat - item.startBeat;
    const slope = typeof item.section.tempo === "object" ? (item.section.tempo.to - tempo) / length : 0;
    const t = seconds - item.startTime;
    if (!slope) return item.startBeat + t * tempo / 60;
    // Inverse of seconds = 60 * ln(1 + slope * beats / tempo) / slope.
    return item.startBeat + tempo * (Math.exp(t * slope / 60) - 1) / slope;
  };
  return { fps, beatAt };
}

function parseSig(sig: string | undefined, beats: number): { numerator: number; denominator: number } {
  const match = sig === undefined ? null : /^(\d+)\/(\d+)$/.exec(sig);
  if (match) return { numerator: Number(match[1]), denominator: Number(match[2]) };
  return Number.isInteger(beats) ? { numerator: beats, denominator: 4 } : { numerator: Math.round(beats * 2), denominator: 8 };
}

function velocityOf(note: ArrangedNote, inst: Instrument): { velocity: number; basis: "sustain" | "default" } {
  const sustain = note.sustain ?? (inst.sr >> 4);
  const volume = note.volume === undefined ? 1 : Math.max(0, Math.min(15, note.volume)) / 15;
  if (sustain > 0) return { velocity: Math.max(1, Math.min(127, Math.round(127 * sustain / 15 * volume))), basis: "sustain" };
  return { velocity: Math.max(1, Math.min(127, Math.round(100 * volume))), basis: "default" };
}

/** Exports one song of a parsed score as a structured event list. */
export function exportEvents(doc: ParsedSidwave, options: EventExportOptions = {}): ExportedScore {
  const ppq = options.ppq ?? DEFAULT_PPQ;
  if (!Number.isInteger(ppq) || ppq < 24 || ppq > 9600) throw new RangeError("ppq must be an integer from 24 to 9600");
  const song = options.song ?? 0;
  if (doc.songs ? !Number.isInteger(song) || song < 0 || song >= doc.songs.length : song !== 0) {
    throw new RangeError(`song ${song} does not exist; the score has ${doc.songs?.length ?? 1}`);
  }
  const view = doc.songs ? songDoc(doc, song) : doc;
  const arr = arrangeSidwave(view);
  const songTempo = view.song.tempo;
  const timeline = view.timeline;
  const { beatAt, fps } = makeBeatMapper(arr, songTempo);
  const peakTempo = Math.max(songTempo, ...(arr.clock?.sections.map((item) => Math.max(
    typeof item.section.tempo === "number" ? item.section.tempo : songTempo, item.endTempo)) ?? []));
  const halfFrame = 0.5 * peakTempo / (fps * 60) + 1e-9; // half a player call in beats at the fastest tempo
  const snap = (beat: number, toleranceBeats: number): number => {
    const grid = Math.round(beat * GRID) / GRID;
    return Math.abs(grid - beat) <= toleranceBeats ? grid : beat;
  };
  const tickOf = (frame: number): number => {
    const beat = beatAt(frame / fps);
    return Math.round(snap(beat, halfFrame) * ppq);
  };
  const losses: string[] = [];

  // Tempo map and time signatures.
  const tempoMap: ExportedTempo[] = [];
  const timeSignatures: ExportedTimeSignature[] = [];
  const sections: ExportedSection[] = [];
  const ramps: Array<{ start: number; end: number; tempo: number; slope: number }> = [];
  const pushTempo = (beat: number, seconds: number, bpm: number) => {
    const value = round6(bpm);
    const last = tempoMap[tempoMap.length - 1];
    if (last && last.bpm === value) return;
    tempoMap.push({ tick: Math.round(beat * ppq), time: round6(seconds), bpm: value });
  };
  const legacyMeter = doc.song.meterSig;
  if (arr.clock) {
    let bar = 1;
    for (const item of arr.clock.sections) {
      const tempo = typeof item.section.tempo === "number" ? item.section.tempo : songTempo;
      const length = item.endBeat - item.startBeat;
      if (typeof item.section.tempo === "object") {
        const slope = (item.section.tempo.to - tempo) / length;
        for (let beat = item.startBeat; beat < item.endBeat - 1e-9; beat += 1) pushTempo(beat, item.at(beat), tempo + slope * (beat - item.startBeat));
        ramps.push({ start: item.startBeat, end: item.endBeat, tempo, slope });
        losses.push("Tempo ramps are exported as one tempo change per beat and one per note start inside the ramp; between two entries the tempo is constant.");
      } else pushTempo(item.startBeat, item.startTime, tempo);
      const meter = item.section.meter ?? legacyMeter;
      const beatsPerBar = meter?.beats ?? doc.song.meter;
      const sig = parseSig(meter?.sig, beatsPerBar);
      const last = timeSignatures[timeSignatures.length - 1];
      if (!last || last.numerator !== sig.numerator || last.denominator !== sig.denominator) {
        timeSignatures.push({ tick: Math.round(item.startBeat * ppq), time: round6(item.startTime), bar, ...sig });
      }
      const sectionBars = Math.round(length / beatsPerBar);
      const rawIndex = item.index;
      sections.push({ index: rawIndex, ...(item.section.section ? { name: item.section.section } : {}), bar, bars: sectionBars,
        tick: Math.round(item.startBeat * ppq), time: round6(item.startTime) });
      bar += sectionBars;
    }
  } else {
    pushTempo(0, 0, songTempo);
    timeSignatures.push({ tick: 0, time: 0, bar: 1, ...parseSig(legacyMeter?.sig, doc.song.meter) });
    let bar = 1;
    for (const [index, section] of timeline.entries()) {
      sections.push({ index, ...(section.section ? { name: section.section } : {}), bar, bars: section.bars, tick: 0, time: 0 });
      bar += section.bars;
    }
    // Legacy timelines repeat or cut at length_bars; list the sections once with their ticks.
    let beat = 0;
    for (const entry of sections) { entry.tick = Math.round(beat * ppq); entry.time = round6(beat * 60 / songTempo); beat += entry.bars * doc.song.meter; }
  }
  if (doc.songs === undefined && arr.clock === undefined) losses.push("Legacy (pre-1.2) scores have a constant tempo and metre.");

  // Voices and notes.
  const instrumentNames = new Map<number, string>();
  const used = new Set<number>();
  const voices: ExportedVoice[] = [];
  const notesOut: ExportedNote[] = [];
  let hidden = 0;
  let nextId = 0;
  const mirrorTargets = new Set((arr.mirrors ?? []).map(([, target]) => target));
  for (const voice of doc.voices) {
    const slot = doc.voiceSlots.get(voice.id)!;
    if (mirrorTargets.has(slot)) continue;
    const arranged = arr.voices[slot];
    if (!arranged) continue;
    const entries: ExportedNote[] = [];
    let previous: ArrangedNote | undefined;
    for (const note of arranged.notes) {
      if (note.hidden) { hidden += 1; continue; }
      const inst = arr.instruments[note.inst]!;
      if (note.instrumentName && !instrumentNames.has(note.inst)) instrumentNames.set(note.inst, note.instrumentName);
      used.add(note.inst);
      const { velocity, basis } = velocityOf(note, inst);
      const on = tickOf(note.start);
      const off = Math.max(on + 1, tickOf(note.end));
      const effects: ExportedNoteEffects = {};
      if (note.legato) effects.legato = true;
      if (note.accented) effects.accented = true;
      if (note.portamento && (note.glideFrom !== undefined || previous)) {
        effects.bend = { from: note.glideFrom ?? previous!.midi, to: note.midi, seconds: round6(note.portamento / fps) };
      }
      if (note.gateOff !== undefined) effects.gateOffSeconds = round6(note.gateOff / fps);
      if (note.chord) effects.chord = { offsets: note.chord.offsets, callsPerStep: note.chord.speed };
      const percussion = !!note.percussion;
      entries.push({
        id: nextId++, voice: voices.length, pitch: note.midi, velocity, velocityBasis: basis, instrument: note.inst,
        on: { tick: on, time: round6(note.start / fps) }, off: { tick: off, time: round6(note.end / fps) }, durationTicks: off - on,
        ...(percussion ? { percussion: true, ...(note.instrumentName ? { drum: note.instrumentName.replace(/^lib:/, "") } : {}) } : {}),
        ...(Object.keys(effects).length ? { effects } : {}),
      });
      previous = note;
    }
    const kind = voice.role === "drums" || (entries.length > 0 && entries.every((entry) => entry.percussion)) ? "drums" : "pitched";
    voices.push({
      index: voices.length, id: voice.id, ...(voice.name ? { name: voice.name } : {}), ...(voice.role ? { role: voice.role } : {}),
      sid: Math.floor(slot / 3), channel: slot % 3 + 1, kind, notes: entries,
    });
    notesOut.push(...entries);
  }
  if (hidden) losses.push(`${hidden} silent notes that only drive a sync or ring source oscillator are not exported.`);
  if (doc.samples || doc.digiVoices?.length) losses.push("Digi sample playback (CIA2 NMI samples) is not exported.");
  if (doc.effects?.length) losses.push("Sound effects (sfx) are not exported; they are triggered by the host program.");
  if (doc.sids.some((sid) => sid.filter) || doc.song.global_fx.filter_env || [...used].some((i) => arr.instruments[i]!.filtertable)) {
    losses.push("Filter settings, cutoff sweeps and resonance are not exported.");
  }
  if ([...used].some((i) => arr.instruments[i]!.pulsetable || arr.instruments[i]!.pwStep)) losses.push("Pulse width modulation is described per instrument but not exported as events.");
  losses.push("Pitches are the written notes; vibrato, arpeggio wavetables and slides are described per instrument.");

  // A ramp is linear in beats, a stepped tempo map is constant between entries: add an entry at every note start inside
  // a ramp, so a note's tick and its time agree to within the tempo change between two neighbouring notes.
  if (ramps.length) {
    const have = new Set(tempoMap.map((t) => t.tick));
    for (const note of notesOut) {
      const beat = note.on.tick / ppq;
      const ramp = ramps.find((r) => beat >= r.start && beat < r.end);
      if (!ramp || have.has(note.on.tick)) continue;
      have.add(note.on.tick);
      tempoMap.push({ tick: note.on.tick, time: note.on.time, bpm: round6(ramp.tempo + ramp.slope * (beat - ramp.start)) });
    }
    tempoMap.sort((a, b) => a.tick - b.tick);
    // Inside a ramp, set each entry's tempo to the mean tempo up to the next entry, so the stepped map reproduces the
    // exact time of every entry (the error between entries is the deviation of the ramp from its mean, not accumulated).
    for (let i = 0; i + 1 < tempoMap.length; i++) {
      const here = tempoMap[i]!, next = tempoMap[i + 1]!;
      if (!ramps.some((r) => here.tick / ppq >= r.start && here.tick / ppq < r.end) || next.time <= here.time) continue;
      here.bpm = round6((next.tick - here.tick) / ppq * 60 / (next.time - here.time));
    }
    for (let i = tempoMap.length - 1; i > 0; i--) if (tempoMap[i]!.bpm === tempoMap[i - 1]!.bpm) tempoMap.splice(i, 1);
  }

  const instruments = [...used].sort((a, b) => a - b).map((index) => describeInstrument(arr.instruments[index]!, index, fps, instrumentNames.get(index)));

  // Flat event list.
  const events: ExportedEvent[] = [];
  for (const tempo of tempoMap) events.push({ type: "tempo", tick: tempo.tick, time: tempo.time, bpm: tempo.bpm });
  for (const sig of timeSignatures) events.push({ type: "timeSignature", tick: sig.tick, time: sig.time, numerator: sig.numerator, denominator: sig.denominator });
  for (const note of notesOut) {
    events.push({ type: "noteOn", tick: note.on.tick, time: note.on.time, voice: note.voice, note: note.id, pitch: note.pitch, velocity: note.velocity });
    events.push({ type: "noteOff", tick: note.off.tick, time: note.off.time, voice: note.voice, note: note.id, pitch: note.pitch });
  }
  const rank = (e: ExportedEvent) => e.type === "tempo" ? 0 : e.type === "timeSignature" ? 1 : e.type === "noteOff" ? 2 : 3;
  events.sort((a, b) => a.tick - b.tick || rank(a) - rank(b) || ((a as { voice?: number }).voice ?? 0) - ((b as { voice?: number }).voice ?? 0));

  const totalTicks = Math.round(snap(beatAt(arr.totalFrames / fps), halfFrame) * ppq);
  return {
    schema: EVENT_SCHEMA,
    title: doc.song.title, ...(doc.song.author ? { author: doc.song.author } : {}), mode: doc.song.mode, song, ppq,
    callRate: round6(fps), durationSeconds: round6(arr.totalFrames / fps), totalTicks,
    tempoMap, timeSignatures, sections, instruments, voices, events, losses: [...new Set(losses)],
  };
}
