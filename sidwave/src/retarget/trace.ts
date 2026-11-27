// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Measurement for SIDWave retargeting: register traces, note timing, bytes and cycles of a compiled score.

import { createHash } from "node:crypto";
import type { ParsedSidwave } from "../sidwave.js";
import {
  SIDWAVE_GAME_DEFAULT_ZERO_PAGE, SIDWAVE_GAME_ENTRY, arrangeSidwave, compileSidwaveGameImage, compileSidwaveToPrg,
} from "../sidwaveCompiler.js";
import { Cpu6502 } from "../sidwaveEmulator.js";

/** Where the measured player image is placed; the score must fit between here and $D000. */
const MEASURE_ORIGIN = 0x1000;

export interface SongTrace {
  /** Play calls per second of this song. */
  fps: number;
  /**
   * One entry per play call: the ordered SID register writes of the call as a flat list of [address, value] pairs,
   * with every write removed that stores the value the register already holds. A gate retrigger or a test-bit pulse
   * inside one call stays visible. This is what "the music is unchanged" compares.
   */
  writes: number[][];
  /** One entry per play call: the registers whose value after the call differs from the value after the previous call, ordered by address. Used for timing and filter measurements. */
  changes: number[][];
  /** Worst and mean cycles of one play call over the run. */
  worstCycles: number;
  meanCycles: number;
  /** SID base addresses. */
  sids: number[];
}

export interface TimingEvent {
  /** Voice slot (SID index * 3 + channel). */
  voice: number;
  /**
   * `on` and `off` are gate edges. `wave` is a change of the control register bits other than the gate, `freq` a
   * jump of the frequency by more than 6 % (a new pitch, not vibrato or a glide) and `pw` a jump of the pulse width
   * by more than 256 (a new setting, not a sweep).
   */
  kind: "on" | "off" | "wave" | "freq" | "pw";
  /** Seconds from the start of the song. */
  time: number;
}

export interface ScoreMeasurement {
  /** Bytes of the compiled PRG (what the byte budget limits). */
  bytes: number;
  /** Worst-case cycles of one play call. `measured` runs the score on the bundled emulator, `estimated` is the compiler's bound. */
  cycles: { worst: number; mean: number | null; kind: "measured" | "estimated" };
  /** Register trace of every song, or undefined when the score cannot be built for the game target (CIA2 digis). */
  songs?: SongTrace[];
  /** Note on/off events of every song, in seconds. From the register trace, or from the arrangement when there is none. */
  timing: TimingEvent[][];
  /** Hash of the compiled behaviour: the register trace, or the arrangement and instruments without a trace. */
  digest: string;
  basis: "register trace" | "arrangement";
  durationSeconds: number;
}

/** Collects the SID register writes of each play call into the ordered `writes` and the net `changes` of a {@link SongTrace}. */
export class WriteRecorder {
  readonly writes: number[][] = [];
  readonly changes: number[][] = [];
  private readonly live = new Map<number, number>();
  private readonly previous = new Map<number, number>();
  private touched = new Set<number>();
  private current: number[] = [];

  /** A write of the value the register already holds is not recorded; every other write is, in order. */
  write(address: number, value: number): void {
    this.touched.add(address);
    if ((this.live.get(address) ?? 0) === value) return;
    this.live.set(address, value);
    this.current.push(address, value);
  }

  /** Ends the play call. */
  commit(): void {
    this.writes.push(this.current);
    const net: number[] = [];
    for (const address of [...this.touched].sort((a, b) => a - b)) {
      const value = this.live.get(address) ?? 0;
      if ((this.previous.get(address) ?? 0) !== value) { net.push(address, value); this.previous.set(address, value); }
    }
    this.changes.push(net);
    this.current = [];
    this.touched = new Set();
  }
}

function runSong(image: ReturnType<typeof compileSidwaveGameImage>, song: number, calls: number): SongTrace {
  const mem = new Uint8Array(0x10000);
  mem.set(image.player, image.origin);
  if (image.data) mem.set(image.data, image.dataOrigin!);
  const sids = image.sidAddresses;
  const recorder = new WriteRecorder();
  const cpu = new Cpu6502(mem, {
    write: (address, value) => {
      if (sids.some((base) => address >= base && address < base + 0x20)) recorder.write(address, value);
    },
  });
  cpu.call(image.origin + SIDWAVE_GAME_ENTRY.init, { a: song, x: image.system === "NTSC" ? 1 : 0 });
  let worst = 0;
  let total = 0;
  for (let i = 0; i < calls; i++) {
    const cycles = cpu.call(image.origin + SIDWAVE_GAME_ENTRY.play);
    worst = Math.max(worst, cycles);
    total += cycles;
    recorder.commit();
  }
  const fps = image.songs ? image.songs[song]!.framesPerSecond : image.framesPerSecond;
  return { fps, writes: recorder.writes, changes: recorder.changes, worstCycles: worst, meanCycles: total / calls, sids: [...sids] };
}

/** Note events per voice from the register changes of each call: gate edges, waveform changes and jumps of pitch and pulse width. */
function voiceEvents(trace: SongTrace): TimingEvent[] {
  const events: TimingEvent[] = [];
  const state = new Map<number, { gate: number; control: number; freq: number; pw: number }>();
  trace.changes.forEach((call, index) => {
    const voices = new Set<number>();
    const next = new Map<number, { gate: number; control: number; freq: number; pw: number }>();
    for (let i = 0; i < call.length; i += 2) {
      const address = call[i]!;
      const chip = trace.sids.findIndex((base) => address >= base && address < base + 0x20);
      if (chip < 0) continue;
      const offset = address - trace.sids[chip]!;
      if (offset > 20) continue;
      const channel = Math.floor(offset / 7);
      const voice = chip * 3 + channel;
      voices.add(voice);
      const was = next.get(voice) ?? { ...(state.get(voice) ?? { gate: 0, control: 0, freq: 0, pw: 0 }) };
      const value = call[i + 1]!;
      switch (offset % 7) {
        case 0: was.freq = (was.freq & 0xff00) | value; break;
        case 1: was.freq = (was.freq & 0xff) | (value << 8); break;
        case 2: was.pw = (was.pw & 0xf00) | value; break;
        case 3: was.pw = (was.pw & 0xff) | ((value & 15) << 8); break;
        default: was.gate = value & 1; was.control = value & 0xfe;
      }
      next.set(voice, was);
    }
    for (const voice of voices) {
      const before = state.get(voice) ?? { gate: 0, control: 0, freq: 0, pw: 0 };
      const after = next.get(voice)!;
      const at = index / trace.fps;
      if (after.gate !== before.gate) events.push({ voice, kind: after.gate ? "on" : "off", time: at });
      if (after.control !== before.control) events.push({ voice, kind: "wave", time: at });
      if (after.freq !== before.freq && Math.abs(after.freq - before.freq) > Math.max(1, before.freq * 0.06)) events.push({ voice, kind: "freq", time: at });
      if (Math.abs(after.pw - before.pw) > 256) events.push({ voice, kind: "pw", time: at });
      state.set(voice, after);
    }
  });
  return events;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Compiles a score and measures it: PRG size, cycles per play call and the register trace. The trace is what
 * "the music is unchanged" means for the retargeting: two scores whose traces are equal play the same register writes
 * at the same play calls. A score with CIA2 digis has no game build, so its behaviour is compared through the
 * arrangement and its cycles are the compiler's estimate.
 */
export function measureScore(doc: ParsedSidwave): ScoreMeasurement {
  const prg = compileSidwaveToPrg(doc);
  let image: ReturnType<typeof compileSidwaveGameImage> | undefined;
  // Larger scores need the room below $1000 as well.
  for (const origin of [MEASURE_ORIGIN, 0x0400]) {
    try {
      image = compileSidwaveGameImage(doc, { origin, zeroPage: SIDWAVE_GAME_DEFAULT_ZERO_PAGE }, { loop: false });
      break;
    } catch (error) {
      if (doc.samples || doc.digiVoices?.length) break;
      if (origin === 0x0400 || (error as { path?: string }).path !== "$.timeline") throw error;
    }
  }
  if (image) {
    const songs = image.songs
      ? image.songs.map((song, k) => runSong(image!, k, song.totalFrames + 4))
      : [runSong(image, 0, image.totalFrames + 4)];
    const calls = songs.reduce((sum, song) => sum + song.writes.length, 0);
    return {
      bytes: prg.prg.length,
      cycles: {
        worst: Math.max(...songs.map((song) => song.worstCycles)),
        mean: songs.reduce((sum, song) => sum + song.meanCycles * song.writes.length, 0) / calls,
        kind: "measured",
      },
      songs,
      timing: songs.map(voiceEvents),
      digest: hashJson(songs.map((song) => ({ fps: song.fps, writes: song.writes }))),
      basis: "register trace",
      durationSeconds: songs.reduce((sum, song) => sum + song.writes.length / song.fps, 0),
    };
  }
  // Digi scores: compare the arrangement (note events, stream events, instruments and chips).
  const arrangement = arrangeSidwave(doc);
  const timing: TimingEvent[] = arrangement.voices.flatMap((voice, slot) => voice.notes.filter((note) => !note.hidden).flatMap((note): TimingEvent[] => [
    { voice: slot, kind: "on", time: note.start / arrangement.fps },
    { voice: slot, kind: "off", time: note.end / arrangement.fps },
  ])).sort((a, b) => a.time - b.time || a.voice - b.voice);
  return {
    bytes: prg.prg.length,
    cycles: { worst: prg.worstCaseCyclesPerCall + prg.digiCyclesPerCall, mean: null, kind: "estimated" },
    timing: [timing],
    digest: hashJson({
      fps: arrangement.fps, frames: arrangement.totalFrames, instruments: arrangement.instruments,
      voices: arrangement.voices.map((voice) => voice.events), chips: arrangement.chips, samples: arrangement.samples?.commands,
    }),
    basis: "arrangement",
    durationSeconds: arrangement.totalFrames / arrangement.fps,
  };
}

export interface KindTiming {
  /** `measured` when at least one voice has the same number of events of this kind in both scores, otherwise `not measured`. */
  timing: "measured" | "not measured";
  /** Pairs measured. Only voices whose event counts match are measured. */
  paired: number;
  /** Events of voices whose counts differ: they are not measured and never enter the error. */
  unmatched: number;
  /** Voices of this kind whose event counts differ, with the count in the source and in the result. */
  mismatches: Array<{ voice: number; before: number; after: number }>;
  /** Worst and 95th percentile error over the measured pairs; null when nothing was measured. */
  worstMs: number | null;
  p95Ms: number | null;
}

export interface TimingComparison {
  /** Largest |time difference| in milliseconds over all paired events. */
  worstMs: number;
  meanMs: number;
  paired: number;
  /** Events of voices and kinds whose counts differ (not measured). They are counted here and per kind and never enter an error. */
  unpaired: number;
  /** Per voice slot: worst error in ms. */
  perVoiceMs: Record<string, number>;
  /** Per event kind (on, off, wave, freq, pw): pairs, unmatched events, worst and 95th percentile error. */
  perKind: Record<string, KindTiming>;
}

const percentile = (sorted: number[], fraction: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]! : 0);

/**
 * Pairs the n-th event of each kind of each voice in the two measurements and reports the time differences in ms.
 * A voice and kind is measured only when both scores have the same number of such events: with different counts the
 * order says nothing about which event corresponds to which, so that group is reported as not measured, with both
 * counts, and none of its events enters an error. The error is not capped.
 */
export function compareTiming(before: ScoreMeasurement, after: ScoreMeasurement): TimingComparison {
  const errors = new Map<string, number[]>();
  const unmatched = new Map<string, number>();
  const mismatches = new Map<string, Array<{ voice: number; before: number; after: number }>>();
  const perVoice: Record<string, number> = {};
  const songs = Math.max(before.timing.length, after.timing.length);
  for (let song = 0; song < songs; song++) {
    const group = (events: TimingEvent[] | undefined) => {
      const map = new Map<string, number[]>();
      for (const event of events ?? []) {
        const key = `${event.voice}:${event.kind}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(event.time);
      }
      return map;
    };
    const a = group(before.timing[song]);
    const b = group(after.timing[song]);
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(key) ?? [];
      const y = b.get(key) ?? [];
      const [voice, kind] = key.split(":") as [string, string];
      if (!errors.has(kind)) errors.set(kind, []);
      if (x.length !== y.length) {
        unmatched.set(kind, (unmatched.get(kind) ?? 0) + x.length + y.length);
        if (!mismatches.has(kind)) mismatches.set(kind, []);
        mismatches.get(kind)!.push({ voice: Number(voice), before: x.length, after: y.length });
        continue;
      }
      const n = x.length;
      for (let k = 0; k < n; k++) {
        const ms = Math.abs(x[k]! - y[k]!) * 1000;
        errors.get(kind)!.push(ms);
        perVoice[voice] = Math.max(perVoice[voice] ?? 0, ms);
      }
    }
  }
  const perKind: Record<string, KindTiming> = {};
  let worst = 0;
  let sum = 0;
  let paired = 0;
  let unpaired = 0;
  for (const [kind, list] of errors) {
    const sorted = [...list].sort((p, q) => p - q);
    perKind[kind] = {
      timing: list.length ? "measured" : "not measured", paired: list.length, unmatched: unmatched.get(kind) ?? 0, mismatches: mismatches.get(kind) ?? [],
      worstMs: list.length ? sorted[sorted.length - 1]! : null, p95Ms: list.length ? percentile(sorted, 0.95) : null,
    };
    worst = Math.max(worst, perKind[kind]!.worstMs ?? 0);
    sum += list.reduce((t, v) => t + v, 0);
    paired += list.length;
    unpaired += perKind[kind]!.unmatched;
  }
  return { worstMs: worst, meanMs: paired ? sum / paired : 0, paired, unpaired, perVoiceMs: perVoice, perKind };
}

export interface TraceDifference {
  /** Play calls compared (the shorter of the two runs per song). */
  compared: number;
  /** Calls whose SID register writes differ. */
  differing: number;
  /** Differing calls as a fraction of the compared calls. */
  fraction: number;
}

/** Compares two register traces call by call. Undefined when either score has no trace. */
export function compareTraces(a: ScoreMeasurement, b: ScoreMeasurement): TraceDifference | undefined {
  if (!a.songs || !b.songs) return undefined;
  let compared = 0;
  let differing = 0;
  a.songs.forEach((song, k) => {
    const other = b.songs![k];
    if (!other) return;
    const n = Math.min(song.writes.length, other.writes.length);
    compared += n;
    for (let i = 0; i < n; i++) if (song.writes[i]!.join() !== other.writes[i]!.join()) differing++;
    differing += Math.abs(song.writes.length - other.writes.length);
  });
  return { compared, differing, fraction: compared ? differing / compared : 0 };
}
