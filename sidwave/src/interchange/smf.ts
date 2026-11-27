// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Standard MIDI File (SMF) reader and writer. No dependencies.

export type MidiEvent =
  | { tick: number; type: "noteOn" | "noteOff"; channel: number; note: number; velocity: number }
  | { tick: number; type: "controller"; channel: number; controller: number; value: number }
  | { tick: number; type: "program"; channel: number; program: number }
  | { tick: number; type: "pitchBend"; channel: number; value: number }
  | { tick: number; type: "tempo"; microsecondsPerQuarter: number }
  | { tick: number; type: "timeSignature"; numerator: number; denominator: number }
  | { tick: number; type: "text"; kind: number; text: string }
  | { tick: number; type: "endOfTrack" }
  | { tick: number; type: "other" };

export interface Smf {
  format: 0 | 1 | 2;
  /** Ticks per quarter note. */
  division: number;
  tracks: MidiEvent[][];
}

export class MidiError extends Error {
  constructor(message: string) { super(message); this.name = "MidiError"; }
}

export interface SmfLimits {
  /** Largest file in bytes. Default 8 MiB. */
  maxBytes?: number;
  /** Largest number of tracks. Default 256. */
  maxTracks?: number;
  /** Largest total number of events. Default 2,000,000. */
  maxEvents?: number;
  /** Largest tick of any event. Default 2^31. */
  maxTick?: number;
}

export const SMF_DEFAULT_LIMITS = { maxBytes: 8 * 1024 * 1024, maxTracks: 256, maxEvents: 2_000_000, maxTick: 2 ** 31 } as const;

/** Parses an SMF. Throws MidiError for malformed or oversized input; never reads outside the buffer. */
export function parseSmf(bytes: Uint8Array, limits: SmfLimits = {}): Smf {
  const maxBytes = limits.maxBytes ?? SMF_DEFAULT_LIMITS.maxBytes;
  const maxTracks = limits.maxTracks ?? SMF_DEFAULT_LIMITS.maxTracks;
  const maxEvents = limits.maxEvents ?? SMF_DEFAULT_LIMITS.maxEvents;
  const maxTick = limits.maxTick ?? SMF_DEFAULT_LIMITS.maxTick;
  if (bytes.length > maxBytes) throw new MidiError(`the MIDI file has ${bytes.length} bytes; the limit is ${maxBytes}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || tag(0) !== "MThd") throw new MidiError("not a Standard MIDI File (no MThd header)");
  const headerLength = view.getUint32(4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) throw new MidiError("invalid MThd header length");
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  if (format > 2) throw new MidiError(`unsupported SMF format ${format}`);
  if (format === 2) throw new MidiError("SMF format 2 (independent sequences) is not supported; use format 0 or 1");
  if (division & 0x8000) throw new MidiError("SMPTE time division is not supported; use ticks per quarter note");
  if (division === 0) throw new MidiError("time division is zero");
  if (trackCount > maxTracks) throw new MidiError(`the MIDI file declares ${trackCount} tracks; the limit is ${maxTracks}`);
  const tracks: MidiEvent[][] = [];
  let events = 0;
  let pos = 8 + headerLength;
  while (pos + 8 <= bytes.length && tracks.length < trackCount) {
    const id = tag(pos);
    const length = view.getUint32(pos + 4);
    pos += 8;
    if (pos + length > bytes.length) throw new MidiError(`chunk ${id} runs past the end of the file`);
    if (id !== "MTrk") { pos += length; continue; } // unknown chunks are skipped, as the specification requires
    const end = pos + length;
    const track: MidiEvent[] = [];
    let tick = 0;
    let running = -1;
    const byte = (): number => {
      if (pos >= end) throw new MidiError("track data ends in the middle of an event");
      return bytes[pos++]!;
    };
    const vlq = (): number => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        const b = byte();
        value = value * 128 + (b & 0x7f);
        if (!(b & 0x80)) return value;
      }
      throw new MidiError("variable-length quantity longer than 4 bytes");
    };
    while (pos < end) {
      tick += vlq();
      if (tick > maxTick) throw new MidiError(`event tick ${tick} exceeds the limit ${maxTick}`);
      if (++events > maxEvents) throw new MidiError(`the MIDI file has more than ${maxEvents} events`);
      let status = byte();
      let first: number | undefined;
      if (status < 0x80) {
        if (running < 0) throw new MidiError("data byte without a status byte");
        first = status;
        status = running;
      }
      if (status === 0xff) {
        // Lenient: a meta event does not cancel running status here (the specification cancels it), so a data byte
        // after a meta event continues the previous channel message instead of failing; real files rely on this.
        const kind = byte();
        const size = vlq();
        if (pos + size > end) throw new MidiError("meta event runs past the end of its track");
        const data = bytes.subarray(pos, pos + size);
        pos += size;
        if (kind === 0x2f) { track.push({ tick, type: "endOfTrack" }); break; }
        if (kind === 0x51 && size === 3) track.push({ tick, type: "tempo", microsecondsPerQuarter: (data[0]! << 16) | (data[1]! << 8) | data[2]! });
        else if (kind === 0x58 && size >= 2) track.push({ tick, type: "timeSignature", numerator: data[0]!, denominator: 2 ** Math.min(data[1]!, 16) });
        else if (kind >= 0x01 && kind <= 0x07) track.push({ tick, type: "text", kind, text: new TextDecoder("latin1").decode(data) });
        else track.push({ tick, type: "other" });
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const size = vlq();
        if (pos + size > end) throw new MidiError("system exclusive event runs past the end of its track");
        pos += size;
        track.push({ tick, type: "other" });
        running = -1;
        continue;
      }
      if (status >= 0xf1) throw new MidiError(`unsupported status byte 0x${status.toString(16)}`);
      running = status;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const a = first ?? byte();
      if (kind === 0xc0) { track.push({ tick, type: "program", channel, program: a & 0x7f }); continue; }
      if (kind === 0xd0) { track.push({ tick, type: "other" }); continue; }
      const b = byte();
      if (kind === 0x80) track.push({ tick, type: "noteOff", channel, note: a & 0x7f, velocity: b & 0x7f });
      else if (kind === 0x90) track.push({ tick, type: b === 0 ? "noteOff" : "noteOn", channel, note: a & 0x7f, velocity: b & 0x7f });
      else if (kind === 0xb0) track.push({ tick, type: "controller", channel, controller: a & 0x7f, value: b & 0x7f });
      else if (kind === 0xe0) track.push({ tick, type: "pitchBend", channel, value: ((b & 0x7f) << 7) | (a & 0x7f) });
      else track.push({ tick, type: "other" }); // polyphonic key pressure
    }
    tracks.push(track);
    pos = end;
  }
  if (tracks.length === 0) throw new MidiError("the MIDI file has no tracks");
  return { format: format as 0 | 1 | 2, division, tracks };
}

function pushVlq(out: number[], value: number): void {
  const parts = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) parts.push((rest & 0x7f) | 0x80);
  out.push(...parts.reverse());
}

const typeRank = (e: MidiEvent): number => e.type === "tempo" || e.type === "timeSignature" || e.type === "text" ? 0
  : e.type === "noteOff" ? 2 : e.type === "noteOn" ? 4 : e.type === "endOfTrack" ? 9 : 1;

/** Serialises an SMF. Events are sorted by tick (stable; note-offs precede note-ons at equal ticks); each track gets an end-of-track event. */
export function writeSmf(smf: Smf): Uint8Array {
  if (!Number.isInteger(smf.division) || smf.division < 1 || smf.division > 0x7fff) throw new MidiError("division must be 1..32767");
  const chunks: number[][] = [];
  for (const track of smf.tracks) {
    const sorted: MidiEvent[] = track.filter((e) => e.type !== "endOfTrack").map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.tick - b.e.tick || typeRank(a.e) - typeRank(b.e) || a.i - b.i).map(({ e }) => e);
    let end = 0;
    for (const e of track) if (e.tick > end) end = e.tick;
    sorted.push({ tick: end, type: "endOfTrack" });
    const data: number[] = [];
    let last = 0;
    for (const event of sorted) {
      pushVlq(data, event.tick - last);
      last = event.tick;
      switch (event.type) {
        case "noteOn": data.push(0x90 | event.channel, event.note, event.velocity); break;
        case "noteOff": data.push(0x80 | event.channel, event.note, event.velocity); break;
        case "controller": data.push(0xb0 | event.channel, event.controller, event.value); break;
        case "program": data.push(0xc0 | event.channel, event.program); break;
        case "pitchBend": data.push(0xe0 | event.channel, event.value & 0x7f, (event.value >> 7) & 0x7f); break;
        case "tempo": data.push(0xff, 0x51, 3, (event.microsecondsPerQuarter >> 16) & 255, (event.microsecondsPerQuarter >> 8) & 255, event.microsecondsPerQuarter & 255); break;
        case "timeSignature": data.push(0xff, 0x58, 4, event.numerator, Math.round(Math.log2(event.denominator)), 24, 8); break;
        case "text": {
          const text = Buffer.from(event.text, "latin1");
          data.push(0xff, event.kind);
          pushVlq(data, text.length);
          data.push(...text);
          break;
        }
        case "endOfTrack": data.push(0xff, 0x2f, 0); break;
        default: break;
      }
    }
    chunks.push(data);
  }
  const total = 14 + chunks.reduce((sum, c) => sum + 8 + c.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64]);
  view.setUint32(4, 6);
  view.setUint16(8, smf.format);
  view.setUint16(10, smf.tracks.length);
  view.setUint16(12, smf.division);
  let pos = 14;
  for (const chunk of chunks) {
    out.set([0x4d, 0x54, 0x72, 0x6b], pos);
    view.setUint32(pos + 4, chunk.length);
    out.set(chunk, pos + 8);
    pos += 8 + chunk.length;
  }
  return out;
}
