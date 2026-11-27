// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Standard MIDI File export of a parsed score (format 1: a conductor track plus one track per voice).

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type ExportedInstrument, type ExportedScore, type EventExportOptions } from "./events.js";
import { drumKey, programFor } from "./gm.js";
import { writeSmf, type MidiEvent, type Smf } from "./smf.js";

export interface MidiExportOptions extends EventExportOptions {
  /** Write pitch bend for glides, instrument slides and vibrato. Off by default. */
  bend?: boolean;
}

export interface MidiExportTrack {
  voice: number;
  id: number;
  name?: string;
  channel: number;
  /** GM program (0-based) of the first note; undefined for the drum channel. */
  program?: number;
  notes: number;
  pitchBendEvents: number;
}

export interface MidiExportResult {
  bytes: Uint8Array;
  ppq: number;
  tracks: MidiExportTrack[];
  losses: string[];
  warnings: string[];
}

const BEND_RANGE_SEMITONES = 12;
const MAX_BEND_EVENTS = 400_000;

/** Channels for pitched voices: 0..8 and 10..15; channel 9 is the GM percussion channel. */
const PITCHED_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

function bendValue(semitones: number): number {
  return Math.max(0, Math.min(16383, Math.round(8192 + (semitones / BEND_RANGE_SEMITONES) * 8192)));
}

function secondsToTicks(score: ExportedScore, seconds: number): number {
  const map = score.tempoMap;
  let i = map.length - 1;
  while (i > 0 && map[i]!.time > seconds + 1e-12) i--;
  const entry = map[i]!;
  return Math.round(entry.tick + (seconds - entry.time) * entry.bpm / 60 * score.ppq);
}

/** Pitch offset in semitones, relative to the note pitch, at `t` seconds after the note start. */
function pitchOffset(note: ExportedScore["voices"][number]["notes"][number], inst: ExportedInstrument | undefined, t: number): number {
  let offset = 0;
  const bend = note.effects?.bend;
  if (bend) offset += t >= bend.seconds ? 0 : (bend.from - note.pitch) * (1 - t / bend.seconds);
  else if (inst?.slide) {
    // A slide starts `semitones` below the note and reaches it after `speed` player calls.
    const span = inst.slide.speed > 0 ? inst.slide.speed / 100 : 0.05;
    if (t < span) offset -= inst.slide.semitones * (1 - t / span);
  }
  if (inst?.vibrato && inst.vibrato.depthSemitones > 0) {
    const start = inst.vibrato.delayCalls / 100;
    if (t >= start) {
      const phase = ((t - start) * inst.vibrato.rateHz) % 1;
      const triangle = phase < 0.25 ? phase * 4 : phase < 0.75 ? 2 - phase * 4 : phase * 4 - 4;
      offset += triangle * inst.vibrato.depthSemitones;
    }
  }
  return offset;
}

/** Exports one song of a score as a Standard MIDI File. See doc/interchange.md for the mapping. */
export function exportMidi(doc: ParsedSidwave, options: MidiExportOptions = {}): MidiExportResult {
  const score = exportEvents(doc, options);
  const losses = [...score.losses];
  const warnings: string[] = [];
  const instruments = new Map(score.instruments.map((inst) => [inst.index, inst]));
  const smf: Smf = { format: 1, division: score.ppq, tracks: [] };

  const conductor: MidiEvent[] = [{ tick: 0, type: "text", kind: 0x03, text: score.title }];
  if (score.author) conductor.push({ tick: 0, type: "text", kind: 0x02, text: score.author });
  for (const tempo of score.tempoMap) conductor.push({ tick: tempo.tick, type: "tempo", microsecondsPerQuarter: Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / tempo.bpm))) });
  for (const sig of score.timeSignatures) conductor.push({ tick: sig.tick, type: "timeSignature", numerator: sig.numerator, denominator: sig.denominator });
  for (const section of score.sections) if (section.name) conductor.push({ tick: section.tick, type: "text", kind: 0x06, text: section.name });
  conductor.push({ tick: score.totalTicks, type: "endOfTrack" });
  smf.tracks.push(conductor);

  const tracks: MidiExportTrack[] = [];
  let pitchedIndex = 0;
  let bendTotal = 0;
  let unknownDrum = false;
  let shared = false;
  for (const voice of score.voices) {
    const events: MidiEvent[] = [];
    const drums = voice.kind === "drums";
    let pitchChannel = 9;
    if (!drums) {
      if (pitchedIndex >= PITCHED_CHANNELS.length) shared = true;
      pitchChannel = PITCHED_CHANNELS[pitchedIndex % PITCHED_CHANNELS.length]!;
      pitchedIndex++;
    }
    events.push({ tick: 0, type: "text", kind: 0x03, text: `v${voice.id}${voice.name ? ` ${voice.name}` : ""}` });
    let program: number | undefined;
    let current: number | undefined;
    let bendCount = 0;
    if (options.bend && !drums) {
      for (const [controller, value] of [[101, 0], [100, 0], [6, BEND_RANGE_SEMITONES], [38, 0], [101, 127], [100, 127]] as const) {
        events.push({ tick: 0, type: "controller", channel: pitchChannel, controller, value });
      }
    }
    for (const note of voice.notes) {
      const inst = instruments.get(note.instrument);
      let key = note.pitch;
      // Drum hits of a pitched voice go to the percussion channel (channel 10) of the same track, as General MIDI expects.
      const hit = drums || note.percussion === true;
      const channel = hit ? 9 : pitchChannel;
      if (hit) {
        const mapped = drumKey(note.drum);
        key = mapped.key;
        if (!mapped.known) unknownDrum = true;
      } else {
        const wanted = programFor(voice, inst);
        if (wanted !== current) {
          events.push({ tick: note.on.tick, type: "program", channel, program: wanted });
          current = wanted;
          program ??= wanted;
        }
      }
      events.push({ tick: note.on.tick, type: "noteOn", channel, note: key, velocity: note.velocity });
      events.push({ tick: note.off.tick, type: "noteOff", channel, note: key, velocity: 0 });
      if (options.bend && !drums && !note.percussion && (note.effects?.bend || inst?.vibrato || inst?.slide)) {
        const seconds = note.off.time - note.on.time;
        const step = inst?.vibrato ? Math.max(0.005, 1 / (inst.vibrato.rateHz * 8)) : 0.02;
        let last = 8192;
        let lastTick = -1;
        for (let t = 0; t < seconds; t += step) {
          const value = bendValue(pitchOffset(note, inst, t));
          const tick = Math.min(note.off.tick - 1, Math.max(note.on.tick, secondsToTicks(score, note.on.time + t)));
          if (value === last || tick === lastTick) continue;
          if (++bendTotal > MAX_BEND_EVENTS) throw new RangeError(`the pitch bend output exceeds ${MAX_BEND_EVENTS} events; export without --bend`);
          events.push({ tick, type: "pitchBend", channel, value });
          bendCount++;
          last = value;
          lastTick = tick;
        }
        if (last !== 8192) { events.push({ tick: note.off.tick, type: "pitchBend", channel, value: 8192 }); bendCount++; }
      }
    }
    events.push({ tick: score.totalTicks, type: "endOfTrack" });
    smf.tracks.push(events);
    tracks.push({ voice: voice.index, id: voice.id, ...(voice.name ? { name: voice.name } : {}), channel: pitchChannel,
      ...(program === undefined ? {} : { program }), notes: voice.notes.length, pitchBendEvents: bendCount });
  }

  if (!options.bend) losses.push("Pitch bend is not written (use --bend); glides, slides and vibrato are lost.");
  else losses.push("Vibrato fade and exact slide timing are approximated in the pitch bend; bend range is set to 12 semitones by RPN 0.");
  if (shared) warnings.push(`The score has more than ${PITCHED_CHANNELS.length} pitched voices; voices share MIDI channels${options.bend ? ", so pitch bend of one voice affects the others on the same channel" : ""}.`);
  if (unknownDrum) warnings.push("Some drum instruments have no General MIDI equivalent by name and play as acoustic snare (key 38).");
  losses.push("ADSR envelopes, waveforms, pulse width, ring modulation and sync are not written; each instrument becomes a General MIDI program.");
  return { bytes: writeSmf(smf), ppq: score.ppq, tracks, losses: [...new Set(losses)], warnings };
}
