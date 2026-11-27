// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Recovery pipeline (S5c): frame-state IR to SIDWave score.
//
// Steps (design "Recovery pipeline"):
//   2 tuning        histogram of the residual of every frequency register against equal temperament, in cents
//   3 segmentation  a note starts at a gate-on edge; its hard restart is the run of gate-off calls with changed ADSR before it
//   4 programs      per note the per-call waveform bits, gate, semitone offset and pulse width over note-relative calls;
//                   notes with identical programs (or a program that is a prefix of another one) share an instrument
//   5 global state  filter and volume registers are measured; sequences that change are reported as unsupported
//   6 structure     block patterns by exact repetition, chosen by the size of the emitted score
//   7 emission      a canonical SIDWave score, formatted with the formatter
//
// Section 6 rules: no song is hard-coded, no threshold is tuned for a tune, and a register trace is never replayed
// as data. Where the language cannot express an observed behaviour the recovery keeps the closest expressible
// score and records a language-extension candidate with a minimal reproducer.

import YAML from "yaml";
import { formatSidwave } from "../format/sidwaveFormat.js";
import { midiToHz, midiToNoteName } from "../sidwave.js";
import { mantissaShift, maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { controlRegister, type FrameIr } from "./ir.js";

// ---- named constants -----------------------------------------------------------------------------------------------

/** Largest number of steps of a wavetable or register table in the language. */
export const MAX_TABLE_STEPS = 255;
/** Call timing is reported as irregular when more than this share of the call spacings lies outside the IR jitter tolerance (1 percent of the period): a majority of calls is off the grid. */
export const IRREGULAR_SHARE_REPORT = 0.5;
/** The tuning is reported as unsupported when fewer than this share of the note-start frequency registers match an equal-temperament pitch exactly under the measured tuning: at least nine in ten notes must be expressible as note plus one voice tuning. */
export const TUNING_MATCH_MIN = 0.9;
/**
 * Legato: there is no pitch-step threshold. A note starts at a gate-on edge only. A gate-held pitch change stays inside
 * the note program and is expressed as an exact equal-temperament semitone step (wavetable `note`) or reported as
 * unsupported pitch. Legato and portamento notes of the language are therefore not recovered (see the report).
 */
/** Resolution of the tuning histogram in cents. The residual of a 16-bit register is about 0.1 cent at C5, so 0.5 cent separates real tunings. */
export const TUNING_BIN_CENTS = 0.5;
/** The tuning is refined around the histogram mode by exact register matching: span in cents on each side. */
export const TUNING_REFINE_SPAN_CENTS = 3;
/** Step of the exact refinement in cents. 0.05 cent changes a C5 register by less than 0.1, so smaller steps cannot separate candidates. */
export const TUNING_REFINE_STEP_CENTS = 0.05;
/** Voice detune range of the language in cents. */
export const MAX_DETUNE_CENTS = 100;
/** Calls per beat are 16 times the call rate per frame, which keeps the tempo near 188 BPM on PAL (the language allows 30 to 220). */
export const CALLS_PER_BEAT_PER_SPEED = 16;
/** Used instead when 16 per speed would give a tempo above the language limit (NTSC). */
export const CALLS_PER_BEAT_PER_SPEED_FAST = 18;
/** Highest tempo accepted before the finer grid is used. */
export const TEMPO_LIMIT = 215;
/** Beats per bar of the emitted score. */
export const BEATS_PER_BAR = 4;
/** Candidate block sizes in bars for the structure step; the size with the smallest emitted score wins. */
export const BLOCK_BARS = [1, 2, 4, 8, 16] as const;
/** The audible range of the compiler (MIDI note numbers). */
export const MIDI_MIN = 12;
export const MIDI_MAX = 107;
/** Number of IR calls shown in a language-extension reproducer. */
export const REPRODUCER_CALLS = 6;
/** Vibrato depth search: step in semitones and the relative span around the amplitude estimate. */
export const VIBRATO_DEPTH_STEP = 0.002;
/** Depth and rate limits of the language (parseVibrato): 0.03 to 6 semitones, 0.2 to 12 Hz. */
export const VIBRATO_MIN_DEPTH = 0.03;
export const VIBRATO_MAX_DEPTH = 6;
export const VIBRATO_MIN_RATE_HZ = 0.2;
export const VIBRATO_MAX_RATE_HZ = 12;
export const VIBRATO_DEPTH_SPAN = 0.3;
/** Largest vibrato delay searched, in calls. */
export const VIBRATO_MAX_DELAY_CALLS = 64;
/** At most this many distinct notes of an instrument are checked by every vibrato candidate. */
export const VIBRATO_MAX_MEMBERS = 24;
/** The language limits of the player, shared by all instruments of a score: distinct instrument shapes and steps per table kind. */
export const MAX_INSTRUMENT_SHAPES = 63;
export const MAX_TABLE_STEPS_TOTAL = 255;
/** A gate-off span with changed ADSR before a note is a hard restart only up to this many frames; a longer span is an ordinary rest. */
export const HARD_RESTART_MAX_FRAMES = 8;
/** Spacing deviation (relative) up to which the call rate counts as an integer multiple of the frame rate. */
export const CALL_RATE_TOLERANCE = 0.02;

// ---- types ---------------------------------------------------------------------------------------------------------

export interface Reproducer {
  sid: number;
  voice: number;
  /** IR call indices with the seven registers of the voice as hex bytes. */
  calls: Array<{ call: number; regs: string }>;
}

export interface LanguageExtension {
  id: string;
  construct: string;
  reason: string;
  occurrences: number;
  reproducer: Reproducer;
}

export interface UnsupportedFeature {
  kind: string;
  detail: string;
  evidence: Record<string, unknown>;
}

interface Track {
  sid: number;
  voice: number;
  ctl: Uint8Array;
  freq: Uint16Array;
  pw: Uint16Array;
  ad: Uint8Array;
  sr: Uint8Array;
  /** Filter cutoff (11 bit), resonance and routing ($D417) and mode and volume ($D418) of the SID after each call. */
  cutoff: Uint16Array;
  route: Uint8Array;
  mode: Uint8Array;
}

interface RestartInfo {
  /** Gate-off calls before the note whose ADSR differs from the previous note's. 0 when there is none. */
  calls: number;
  ad: number;
  sr: number;
  test: boolean;
}

interface NoteSegment {
  start: number;
  /** First gate-off call after the start (the track length when the gate stays on). */
  gateOff: number;
  /** End of the entry in calls (start of the next note, or the end of the track). */
  entryEnd: number;
  restart: RestartInfo;
  /** Entry length in calls; shorter than the span to the next note when a rest follows. */
  length: number;
  midi: number;
  ad: number;
  sr: number;
  program: ProgramCall[];
  /** True when the pitch could not be expressed as equal-temperament semitones. */
  pitchApprox: boolean;
  instrument: number;
  /** A note after the horizon that is inferred from a hard restart already visible inside the horizon. */
  phantom?: boolean;
  /** Frames before the entry end at which the gate goes off (the `gate_off` of the note); absent when the gate-off is the hard restart or a wavetable step. */
  gateOffFrames?: number;
  /** Frequency registers from the note start to the start of the next note (gate on, release and restart). */
  freqs: number[];
  /** True when some call is not an equal-temperament pitch; a vibrato fit may explain it. */
  modulated: boolean;
}

/** State of one call of a note program. `offset` is the semitone offset from the first call. */
interface ProgramCall {
  wave: number;
  gate: number;
  offset: number;
  pw: number;
  /** The filter state while this voice is routed through the filter; absent when it is not. */
  filt?: { cutoff: number; res: number; type: number };
  /** The call belongs to a wavetable `slide_to` run: linear in Hz between two semitone offsets over `count` calls. */
  slide?: { from: number; to: number; count: number };
}

interface InstrumentDef {
  name: string;
  program: ProgramCall[];
  ad: number;
  sr: number;
  restart: RestartInfo;
  yaml: Record<string, unknown>;
}

export interface RecoveredScore {
  document: Record<string, unknown>;
  text: string;
  speed: number;
  tempo: number;
  callsPerBeat: number;
  /** The IR call that is row 0 of the score. */
  firstCall: number;
  rows: number;
  tuningCents: number;
  noteCount: number;
  phantomNotes: number;
  instrumentCount: number;
  patternCount: number;
  structure: { blockBars: number | "flat"; bytes: number; alternatives: Array<{ blockBars: number | "flat"; bytes: number }> };
  unsupported: UnsupportedFeature[];
  extensions: LanguageExtension[];
  tuningEvidence: { distinctRegisters: number; matched: number; histogramModeCents: number };
}

export interface RecoverOptions {
  /** Title of the emitted score. */
  title?: string;
}

// ---- helpers -------------------------------------------------------------------------------------------------------

const hex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Register value of an equal-temperament note with a tuning offset (the formula of the compiler's hzToSidFrequency). */
function registerOf(midi: number, cents: number, clockHz: number): number {
  return Math.max(0, Math.min(0xffff, Math.round((midiToHz(midi + cents / 100) * 16_777_216) / clockHz)));
}

function nearestSemitone(freq: number, cents: number, clockHz: number): number {
  const hz = (freq * clockHz) / 16_777_216;
  return Math.round(69 + 12 * Math.log2(hz / 440) - cents / 100);
}

/** The semitone whose register equals `freq` exactly under the tuning, or undefined. */
function exactSemitone(freq: number, cents: number, clockHz: number): number | undefined {
  if (freq <= 0) return undefined;
  const near = nearestSemitone(freq, cents, clockHz);
  for (const midi of [near, near - 1, near + 1]) {
    if (midi >= 0 && midi <= 127 && registerOf(midi, cents, clockHz) === freq) return midi;
  }
  return undefined;
}

/**
 * True when the IR call is the player's init: every register of SID 1 is written. The init of a tune normally
 * clears all registers first and may then set up voices (pulse width, ADSR, even a gate); the first play call follows.
 */
export function isInitCall(ir: FrameIr, index: number): boolean {
  const call = ir.calls[index];
  if (!call) return false;
  const sid = call.sids[0];
  if (!sid || (sid.written & 0x1ffffff) !== 0x1ffffff) return false;
  return true;
}

function reproducer(ir: FrameIr, sid: number, voice: number, call: number): Reproducer {
  const from = Math.max(0, call - 1);
  const calls: Reproducer["calls"] = [];
  for (let i = from; i < Math.min(ir.calls.length, from + REPRODUCER_CALLS); i++) {
    calls.push({ call: i, regs: hex(ir.calls[i]!.sids[sid]!.regs.subarray(voice * 7, voice * 7 + 7)) });
  }
  return { sid, voice, calls };
}

// ---- step 2: tuning ------------------------------------------------------------------------------------------------

function estimateTuning(tracks: Track[], clockHz: number): { cents: number; distinct: number; matched: number; mode: number } {
  const counts = new Map<number, number>();
  for (const t of tracks) {
    // Only the frequency at a gate-on edge is a note pitch; later calls of a note may be modulated.
    for (let k = 0; k < t.freq.length; k++) {
      if (t.ctl[k]! & 1 && (k === 0 || !(t.ctl[k - 1]! & 1)) && t.freq[k]! > 0) counts.set(t.freq[k]!, (counts.get(t.freq[k]!) ?? 0) + 1);
    }
  }
  if (!counts.size) return { cents: 0, distinct: 0, matched: 0, mode: 0 };
  const bins = new Map<number, number>();
  for (const [freq, n] of counts) {
    const hz = (freq * clockHz) / 16_777_216;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const residual = (midi - Math.round(midi)) * 100;
    const bin = Math.round(residual / TUNING_BIN_CENTS) * TUNING_BIN_CENTS;
    // Weight by register size: a large register has a small rounding error.
    bins.set(bin, (bins.get(bin) ?? 0) + n * Math.min(freq, 4096));
  }
  let mode = 0;
  let best = -1;
  for (const [bin, weight] of [...bins].sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))) {
    if (weight > best) {
      best = weight;
      mode = bin;
    }
  }
  const candidates: number[] = [];
  const steps = Math.round(TUNING_REFINE_SPAN_CENTS / TUNING_REFINE_STEP_CENTS);
  for (let i = -steps; i <= steps; i++) {
    const c = Math.round((mode + i * TUNING_REFINE_STEP_CENTS) * 100) / 100;
    if (Math.abs(c) <= MAX_DETUNE_CENTS) candidates.push(c);
  }
  if (!candidates.includes(0)) candidates.push(0);
  candidates.sort((a, b) => Math.abs(a) - Math.abs(b));
  let bestCents = 0;
  let bestMatched = -1;
  for (const c of candidates) {
    let matched = 0;
    for (const [freq, n] of counts) if (exactSemitone(freq, c, clockHz) !== undefined) matched += n;
    if (matched > bestMatched) {
      bestMatched = matched;
      bestCents = c;
    }
  }
  let total = 0;
  for (const n of counts.values()) total += n;
  return { cents: bestCents, distinct: counts.size, matched: bestMatched / Math.max(1, total), mode };
}

// ---- step 3 and 4: segmentation and programs -----------------------------------------------------------------------

function extractTracks(ir: FrameIr, first: number): Track[] {
  const tracks: Track[] = [];
  const n = ir.calls.length - first;
  for (let sid = 0; sid < ir.sidCount; sid++) {
    for (let voice = 0; voice < 3; voice++) {
      const t: Track = {
        sid, voice,
        ctl: new Uint8Array(n), freq: new Uint16Array(n), pw: new Uint16Array(n), ad: new Uint8Array(n), sr: new Uint8Array(n),
        cutoff: new Uint16Array(n), route: new Uint8Array(n), mode: new Uint8Array(n),
      };
      const o = voice * 7;
      for (let k = 0; k < n; k++) {
        const r = ir.calls[first + k]!.sids[sid]!.regs;
        t.ctl[k] = r[o + 4]!;
        t.freq[k] = r[o]! | (r[o + 1]! << 8);
        t.pw[k] = r[o + 2]! | ((r[o + 3]! & 15) << 8);
        t.ad[k] = r[o + 5]!;
        t.sr[k] = r[o + 6]!;
        t.cutoff[k] = (r[0x15]! & 7) | (r[0x16]! << 3);
        t.route[k] = r[0x17]!;
        t.mode[k] = r[0x18]!;
      }
      tracks.push(t);
    }
  }
  return tracks;
}

function segmentTrack(track: Track, cents: number, clockHz: number, speed: number, maxMidi: number, notes: { unsupported: Array<{ call: number; kind: string; detail: string }> }): NoteSegment[] {
  const n = track.ctl.length;
  const starts: number[] = [];
  for (let k = 0; k < n; k++) if (track.ctl[k]! & 1 && (k === 0 || !(track.ctl[k - 1]! & 1))) starts.push(k);
  const segs: NoteSegment[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    let gateOff = start;
    while (gateOff < n && track.ctl[gateOff]! & 1) gateOff++;
    // Hard restart: the gate-off calls just before the start whose ADSR differs from the previous note's.
    let restart: RestartInfo = { calls: 0, ad: 0, sr: 0, test: false };
    if (i > 0) {
      const prev = segs[i - 1]!;
      const tailStart = prev.gateOff;
      let r = start;
      const rAd = track.ad[start - 1]!;
      const rSr = track.sr[start - 1]!;
      if (start - 1 >= tailStart && !(rAd === prev.ad && rSr === prev.sr)) {
        while (r - 1 >= tailStart && track.ad[r - 1] === rAd && track.sr[r - 1] === rSr) r--;
        let test = false;
        for (let k = r; k < start; k++) if (track.ctl[k]! & 8) test = true;
        if (start - r <= HARD_RESTART_MAX_FRAMES * speed) restart = { calls: start - r, ad: rAd, sr: rSr, test };
      }
    }
    const seg: NoteSegment = {
      start, gateOff, entryEnd: n, restart, length: 0, midi: 60, ad: track.ad[start]!, sr: track.sr[start]!,
      program: [], pitchApprox: false, instrument: -1, freqs: [], modulated: false,
    };
    segs.push(seg);
  }
  // A hard restart that is already running at the end of the trace belongs to a note after the horizon. The note is
  // inferred (it is not observed) so that the restart inside the horizon is reproduced; it starts after the horizon.
  const lastSeg = segs[segs.length - 1];
  if (lastSeg && lastSeg.gateOff < n) {
    const ad = track.ad[n - 1]!;
    const sr = track.sr[n - 1]!;
    if (!(ad === lastSeg.ad && sr === lastSeg.sr)) {
      let r = 1;
      while (n - 1 - r >= lastSeg.gateOff && track.ad[n - 1 - r] === ad && track.sr[n - 1 - r] === sr) r++;
      let test = false;
      for (let k = n - r; k < n; k++) if (track.ctl[k]! & 8) test = true;
      const known = segs.slice(1).map((x) => x.restart.calls).filter((c) => c >= r);
      const total = known.length ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)]! : Math.max(r, 2 * speed);
      segs.push({
        start: n - r + total, gateOff: n - r + total + 1, entryEnd: n - r + total + speed, restart: { calls: total, ad, sr, test }, length: total + speed,
        midi: lastSeg.midi, ad: lastSeg.ad, sr: lastSeg.sr, program: [], pitchApprox: false, instrument: -1, phantom: true, freqs: [], modulated: false,
      });
    }
  }
  // The window of a note ends where the next note's restart begins.
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.phantom) {
      const before = segs[i - 1]!;
      // The inferred note uses the program of the note before it, so that every table offset stays in the playable range.
      seg.program = before.program.map((c) => ({ ...c }));
      seg.midi = before.midi;
      continue;
    }
    const next = segs[i + 1];
    const windowEnd = next ? next.start - Math.max(1, next.restart.calls) : n;
    const end = Math.max(seg.start + 1, windowEnd);
    // Is the part after the gate-off a plain release (no change of waveform or pulse)? The frequency is not checked here: arpeggio
    // steps and a vibrato continue in the release, and the instrument's tables and the vibrato fit reproduce them; the F-diff checks the result.
    let plainTail = true;
    for (let k = seg.gateOff; k < end; k++) {
      if (k > 0 && (track.pw[k] !== track.pw[k - 1] || (track.ctl[k]! & ~1) !== (track.ctl[k - 1]! & ~1))) plainTail = false;
    }
    // With a plain release the entry runs to the next note and the note's `gate_off` (frames before the end) switches the
    // gate off at the observed call, so the note program covers the gate-on calls only and notes of different duration
    // share one instrument. This needs the distance to the entry end to be a multiple of the call rate per frame.
    seg.entryEnd = next ? next.start : n;
    const releaseCalls = seg.entryEnd - seg.gateOff;
    const holdHr = next ? seg.gateOff >= end : false;
    const viaGateOff = seg.gateOff < end && plainTail && !holdHr && releaseCalls % speed === 0 && releaseCalls / speed <= 255
      && seg.entryEnd - seg.start > releaseCalls;
    if (viaGateOff) seg.gateOffFrames = releaseCalls / speed;
    // Otherwise a short gate-on part is written as a wavetable that switches the gate off.
    const minEntry = (i === 0 ? 2 * speed : seg.restart.calls) + speed;
    const useGateEnd = viaGateOff || (seg.gateOff < end && plainTail && seg.gateOff - seg.start >= minEntry);
    seg.length = useGateEnd && !viaGateOff ? seg.gateOff - seg.start : seg.entryEnd - seg.start;
    const progEnd = useGateEnd ? seg.gateOff : end;
    const base = exactSemitone(track.freq[seg.start]!, cents, clockHz);
    seg.pitchApprox = base === undefined;
    seg.midi = base ?? Math.max(MIDI_MIN, Math.min(maxMidi, nearestSemitone(track.freq[seg.start]!, cents, clockHz)));
    // The vibrato continues through the release and the restart calls, so the whole span up to the next note is checked.
    for (let k = seg.start; k < (next ? next.start : n); k++) seg.freqs.push(track.freq[k]!);
    seg.modulated = seg.freqs.some((f) => exactSemitone(f, cents, clockHz) === undefined);
    if (seg.modulated) notes.unsupported.push({ call: seg.start, kind: "pitch", detail: "frequency register is not an equal-temperament semitone under the measured tuning" });
    for (let k = seg.start; k < progEnd; k++) {
      const m = exactSemitone(track.freq[k]!, cents, clockHz);
      if (m === undefined) {
        seg.pitchApprox = true;
      }
      seg.program.push({
        wave: track.ctl[k]! & 0xfe, gate: track.ctl[k]! & 1,
        offset: m === undefined ? 0 : m - seg.midi, pw: track.pw[k]!,
        ...(track.route[k]! & (1 << track.voice) ? { filt: { cutoff: track.cutoff[k]!, res: track.route[k]! >> 4, type: track.mode[k]! & 0x70 } } : {}),
      });
    }
    markSlides(seg, track, progEnd, clockHz);
    // Pitch that is approximated keeps the semitone offset of the first call.
    if (seg.length < 1) seg.length = 1;
  }
  return segs;
}


// ---- vibrato fit ---------------------------------------------------------------------------------------------------

export interface VibratoFit {
  depth: number;
  rate: number;
  delayCalls: number;
}

/**
 * The frequency registers of a note under a vibrato, as the SIDWave player computes them: the base register `ft`,
 * a triangle of phase `ph` (increment `rateStep` per call after `delay` calls) scaled by the amplitudes
 * ft * mantissa / 2^(8 + shift), rounded half up, above and below the note.
 */
export function simulateVibrato(ft: number, up: [number, number], down: [number, number], rateStep: number, delay: number, length: number): number[] {
  // shr_p shifts the 24-bit product right by the shift, then rounds the upper two bytes by the top bit of the low byte.
  const amplitude = (mantissa: number, shift: number): number => {
    const q = Math.floor((ft * mantissa) / 2 ** shift);
    return (q >> 8) + ((q & 0xff) >= 0x80 ? 1 : 0);
  };
  const ampUp = amplitude(up[0], up[1]);
  const ampDown = amplitude(down[0], down[1]);
  const out: number[] = [];
  let phase = 0;
  let wait = delay;
  for (let k = 0; k < length; k++) {
    let f = ft;
    if ((ampUp || ampDown) && wait === 0) {
      let t = phase & 0x7f;
      if (t >= 0x40) t ^= 0x7f;
      const scale = t * 2;
      const down2 = phase & 0x80;
      const product = ((down2 ? ampDown : ampUp) * scale) * 2;
      const delta = Math.floor(product / 256) + ((product & 0xff) >= 0x80 ? 1 : 0);
      f = down2 ? Math.max(0, ft - delta) : Math.min(0xffff, ft + delta);
    }
    out.push(f);
    if (wait > 0) wait--;
    else phase = (phase + rateStep) & 0xff;
  }
  return out;
}

/**
 * Searches depth, rate and delay that reproduce the frequency registers of every note of an instrument exactly.
 * The depth candidates come from the amplitude seen in the trace; the rate is every phase step 1 to 255 and the delay
 * every call count up to the first deviation. Returns the first exact fit, preferring a smaller delay and then a
 * depth with fewer decimals.
 */
export function fitVibrato(members: Array<{ midi: number; freqs: number[] }>, cents: number, clockHz: number, speed: number, fps: number): VibratoFit | undefined {
  const sample = members.slice(0, VIBRATO_MAX_MEMBERS);
  const fts = sample.map((m) => registerOf(m.midi, cents, clockHz));
  let maxDev = 0;
  let firstDeviation = Infinity;
  sample.forEach((m, i) => {
    const k = m.freqs.findIndex((f) => f !== fts[i]);
    if (k >= 0) firstDeviation = Math.min(firstDeviation, k);
    for (const f of m.freqs) maxDev = Math.max(maxDev, Math.abs(f - fts[i]!) / fts[i]!);
  });
  if (!Number.isFinite(firstDeviation)) return undefined;
  const estimate = 12 * Math.log2(1 + maxDev);
  if (estimate > VIBRATO_MAX_DEPTH * (1 + VIBRATO_DEPTH_SPAN)) return undefined;
  const pairs = new Map<string, { depth: number; up: [number, number]; down: [number, number] }>();
  const decimals = (x: number): number => (String(x).split(".")[1] ?? "").length;
  const low = Math.max(VIBRATO_MIN_DEPTH, estimate * (1 - VIBRATO_DEPTH_SPAN));
  const high = Math.min(VIBRATO_MAX_DEPTH, estimate * (1 + VIBRATO_DEPTH_SPAN) + VIBRATO_DEPTH_STEP);
  for (let d = Math.ceil(low / VIBRATO_DEPTH_STEP); d * VIBRATO_DEPTH_STEP <= high; d++) {
    const depth = Math.round(d * VIBRATO_DEPTH_STEP * 1000) / 1000;
    const up = mantissaShift((128 / 126) * (2 ** (depth / 12) - 1));
    const down = mantissaShift((128 / 126) * (1 - 2 ** (-depth / 12)));
    const key = `${up}:${down}`;
    const known = pairs.get(key);
    if (!known || decimals(depth) < decimals(known.depth)) pairs.set(key, { depth, up, down });
  }
  const minRate = Math.max(1, Math.ceil((VIBRATO_MIN_RATE_HZ * 256) / fps));
  const maxRate = Math.min(255, Math.floor((VIBRATO_MAX_RATE_HZ * 256) / fps));
  // The vibrato changes the register at the earliest on the call after its delay has run out.
  const maxDelay = Math.min(VIBRATO_MAX_DELAY_CALLS, firstDeviation);
  for (let delay = 0; delay <= maxDelay; delay += speed) {
    for (let rateStep = minRate; rateStep <= maxRate; rateStep++) {
      for (const c of pairs.values()) {
        let ok = true;
        for (let i = 0; i < sample.length && ok; i++) ok = matchesVibrato(fts[i]!, c.up, c.down, rateStep, delay, sample[i]!.freqs);
        if (ok) return { depth: c.depth, rate: Math.round((rateStep * fps) / 256 * 10000) / 10000, delayCalls: delay };
      }
    }
  }
  return undefined;
}

function matchesVibrato(ft: number, up: [number, number], down: [number, number], rateStep: number, delay: number, want: number[]): boolean {
  // Same arithmetic as simulateVibrato, compared call by call so that a candidate is rejected at its first difference.
  const amplitude = (mantissa: number, shift: number): number => {
    const q = Math.floor((ft * mantissa) / 2 ** shift);
    return (q >> 8) + ((q & 0xff) >= 0x80 ? 1 : 0);
  };
  const ampUp = amplitude(up[0], up[1]);
  const ampDown = amplitude(down[0], down[1]);
  let phase = 0;
  let wait = delay;
  for (let k = 0; k < want.length; k++) {
    let f = ft;
    if ((ampUp || ampDown) && wait === 0) {
      let t = phase & 0x7f;
      if (t >= 0x40) t ^= 0x7f;
      const down2 = phase & 0x80;
      const product = (down2 ? ampDown : ampUp) * t * 4;
      const delta = Math.floor(product / 256) + ((product & 0xff) >= 0x80 ? 1 : 0);
      f = down2 ? Math.max(0, ft - delta) : Math.min(0xffff, ft + delta);
    }
    if (f !== want[k]) return false;
    if (wait > 0) wait--;
    else phase = (phase + rateStep) & 0xff;
  }
  return true;
}


/**
 * Marks runs of calls whose frequency registers are a linear interpolation in Hz between two equal-temperament
 * pitches (the `slide_to` of a wavetable step, which the player writes as raw registers, without the voice tuning).
 * The run starts on an equal-temperament call, ends on one, and the calls between are not equal-temperament pitches.
 */
function markSlides(seg: NoteSegment, track: Track, progEnd: number, clockHz: number): void {
  const hzOf = (midi: number): number => midiToHz(midi);
  const register = (hz: number): number => Math.max(0, Math.min(0xffff, Math.round((hz * 16_777_216) / clockHz)));
  for (let k = seg.start + 1; k < progEnd; k++) {
    const call = seg.program[k - seg.start]!;
    if (call.slide || exactSemitone(track.freq[k]!, 0, clockHz) !== undefined) continue;
    const k0 = k - 1;
    const from = exactSemitone(track.freq[k0]!, 0, clockHz);
    if (from === undefined || seg.program[k0 - seg.start]!.slide) continue;
    for (let e = k + 1; e < progEnd && e - k0 < 255; e++) {
      const to = exactSemitone(track.freq[e]!, 0, clockHz);
      if (to === undefined) continue;
      const n = e - k0 + 1;
      let ok = true;
      for (let c = 0; c < n && ok; c++) {
        const hz = hzOf(from) + (hzOf(to) - hzOf(from)) * (c / (n - 1));
        ok = register(hz) === track.freq[k0 + c];
      }
      if (!ok) continue;
      for (let c = 0; c < n; c++) {
        const target = seg.program[k0 + c - seg.start]!;
        target.slide = { from: from - seg.midi, to: to - seg.midi, count: n };
        target.offset = from - seg.midi;
      }
      k = e;
      break;
    }
  }
}

// ---- instruments ---------------------------------------------------------------------------------------------------

const WAVE_NAMES: Record<number, string> = {
  0x10: "tri", 0x20: "saw", 0x40: "pulse", 0x80: "noise", 0x30: "tri+saw", 0x50: "tri+pulse", 0x60: "saw+pulse", 0x70: "tri+saw+pulse",
};

function waveName(wave: number): string | undefined {
  return WAVE_NAMES[wave & 0xf0];
}

function sameCall(a: ProgramCall, b: ProgramCall): boolean {
  return a.wave === b.wave && a.gate === b.gate && a.offset === b.offset && a.pw === b.pw
    && a.slide?.from === b.slide?.from && a.slide?.to === b.slide?.to && a.slide?.count === b.slide?.count
    && a.filt?.cutoff === b.filt?.cutoff && a.filt?.res === b.filt?.res && a.filt?.type === b.filt?.type;
}

function isPrefix(shorter: ProgramCall[], longer: ProgramCall[]): boolean {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i++) if (!sameCall(shorter[i]!, longer[i]!)) return false;
  return true;
}

/** Run-length encodes the per-call wave, gate and offset into wavetable steps. */
function wavetableSteps(program: ProgramCall[]): Array<Record<string, unknown>> | undefined {
  const steps: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < program.length) {
    const c = program[i]!;
    if (c.slide) {
      const name = waveName(c.wave);
      if (!name) return undefined;
      const step: Record<string, unknown> = { wave: name };
      if (c.wave & 0x08) step.test = true;
      if (c.wave & 0x04) step.ring = true;
      if (c.wave & 0x02) step.sync = true;
      if (!c.gate) step.gate = false;
      if (c.slide.from !== 0) step.note = c.slide.from > 0 ? `+${c.slide.from}` : String(c.slide.from);
      step.slide_to = c.slide.to >= 0 ? `+${c.slide.to}` : String(c.slide.to);
      step.calls = c.slide.count;
      steps.push(step);
      i += c.slide.count;
      continue;
    }
    let j = i + 1;
    while (j < program.length && !program[j]!.slide && program[j]!.wave === c.wave && program[j]!.gate === c.gate && program[j]!.offset === c.offset) j++;
    const name = waveName(c.wave);
    if (!name) return undefined;
    const step: Record<string, unknown> = { wave: name };
    if (c.wave & 0x08) step.test = true;
    if (c.wave & 0x04) step.ring = true;
    if (c.wave & 0x02) step.sync = true;
    if (!c.gate) step.gate = false;
    if (c.offset !== 0) step.note = c.offset > 0 ? `+${c.offset}` : String(c.offset);
    step.calls = Math.min(255, j - i);
    steps.push(step);
    // A run longer than 255 calls continues in a further step.
    for (let left = j - i - 255; left > 0; left -= 255) steps.push({ ...step, calls: Math.min(255, left) });
    i = j;
  }
  return steps;
}

/** Run-length encodes the per-call pulse width into table steps: `set` for the first call, `add` for runs of equal difference. */
function pulseSteps(program: ProgramCall[]): Array<Record<string, unknown>> | undefined {
  const pw = program.map((c) => c.pw);
  if (pw.every((v) => v === pw[0])) return undefined;
  const steps: Array<Record<string, unknown>> = [];
  const first = pw[0]!;
  if (first < 1 || first > 4094) return undefined;
  steps.push({ set: first, calls: 1 });
  let i = 1;
  while (i < pw.length) {
    const d = pw[i]! - pw[i - 1]!;
    let j = i + 1;
    while (j < pw.length && pw[j]! - pw[j - 1]! === d) j++;
    if (d < -2048 || d > 2047) {
      if (pw[i]! < 1 || pw[i]! > 4094) return undefined;
      steps.push({ set: pw[i], calls: 1 });
      j = i + 1;
    } else {
      steps.push({ add: d, calls: Math.min(255, j - i) });
      for (let left = j - i - 255; left > 0; left -= 255) steps.push({ add: d, calls: Math.min(255, left) });
    }
    i = j;
  }
  return steps;
}


const FILTER_TYPE_NAMES: Record<number, string> = {
  0x10: "lowpass", 0x20: "bandpass", 0x40: "highpass", 0x50: "lowpass+highpass", 0x60: "bandpass+highpass", 0x70: "all",
};

/** Filter table steps of a note: a `cutoff` step for the first call, then `add` runs of equal cutoff difference. */
function filterSteps(program: ProgramCall[]): Array<Record<string, unknown>> | undefined {
  const f = [];
  for (const c of program) {
    if (!c.filt) break;
    f.push(c.filt);
  }
  if (!f.length) return undefined;
  if (!FILTER_TYPE_NAMES[f[0]!.type]) return undefined;
  const steps: Array<Record<string, unknown>> = [{ cutoff: f[0]!.cutoff, resonance: f[0]!.res, type: FILTER_TYPE_NAMES[f[0]!.type], calls: 1 }];
  let i = 1;
  while (i < f.length) {
    const changed = f[i]!.res !== f[i - 1]!.res || f[i]!.type !== f[i - 1]!.type;
    const d = f[i]!.cutoff - f[i - 1]!.cutoff;
    if (changed) {
      if (!FILTER_TYPE_NAMES[f[i]!.type] || d < -2048 || d > 2047) return undefined;
      steps.push({ add: d, resonance: f[i]!.res, type: FILTER_TYPE_NAMES[f[i]!.type], calls: 1 });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < f.length && f[j]!.res === f[j - 1]!.res && f[j]!.type === f[j - 1]!.type && f[j]!.cutoff - f[j - 1]!.cutoff === d) j++;
    if (d < -2048 || d > 2047) return undefined;
    steps.push({ add: d, calls: Math.min(255, j - i) });
    for (let left = j - i - 255; left > 0; left -= 255) steps.push({ add: d, calls: Math.min(255, left) });
    i = j;
  }
  return steps;
}

/** Folds a step list whose tail repeats into a shorter list with a loop index; a shorter last step still matches. */
function foldLoop(steps: Array<Record<string, unknown>>): { steps: Array<Record<string, unknown>>; loop?: number } {
  const key = (s: Record<string, unknown>): string => JSON.stringify({ ...s, calls: undefined });
  const n = steps.length;
  for (let start = 0; start < n; start++) {
    for (let period = 1; start + 2 * period <= n && period <= (n - start) / 2; period++) {
      let ok = true;
      for (let t = start + period; t < n && ok; t++) {
        const template = steps[start + ((t - start) % period)]!;
        const s = steps[t]!;
        const sameCalls = s.calls === template.calls;
        const lastShort = t === n - 1 && Number(s.calls) <= Number(template.calls);
        ok = key(s) === key(template) && (sameCalls || lastShort);
      }
      if (ok) return { steps: steps.slice(0, start + period), loop: start };
    }
  }
  return { steps };
}

function buildInstrumentYaml(program: ProgramCall[], ad: number, sr: number, restart: RestartInfo, speed: number,
  gap: { unsupported: Array<{ kind: string; detail: string }>; filterRecovered?: boolean }, vibrato?: VibratoFit): Record<string, unknown> {
  const first = program[0]!;
  const inst: Record<string, unknown> = {};
  const name = waveName(first.wave);
  inst.waveform = name ?? "pulse";
  if (!name) gap.unsupported.push({ kind: "waveform", detail: `control value $${first.wave.toString(16)} has no waveform bits` });
  if (first.wave & 0x04) inst.ring = true;
  if (first.wave & 0x02) inst.sync = true;
  inst.adsr = [ad >> 4, ad & 15, sr >> 4, sr & 15];
  const pulse = pulseSteps(program);
  if (pulse) {
    const folded = foldLoop(pulse);
    const table: Record<string, unknown> = { steps: folded.steps };
    if (folded.loop !== undefined) table.loop = folded.loop;
    if (folded.steps.length > MAX_TABLE_STEPS) gap.unsupported.push({ kind: "pulsetable", detail: `${folded.steps.length} steps exceed ${MAX_TABLE_STEPS}` });
    inst.pulsetable = table;
  } else if (first.pw !== 0x800 && first.pw >= 1 && first.pw <= 4094) {
    inst.pulse_width = first.pw;
  }
  if (!pulse && program.some((c) => c.pw !== first.pw)) {
    gap.unsupported.push({ kind: "pulsetable", detail: "the pulse width sequence reaches 0 or 4095 or wraps; the language clamps pulse width to 1..4094" });
  }
  if (!pulse && first.pw === 0) gap.unsupported.push({ kind: "pulsetable", detail: "pulse width 0 is not expressible (1..4094)" });
  const filter = filterSteps(program);
  if (filter) {
    const folded = foldLoop(filter);
    const table: Record<string, unknown> = { steps: folded.steps };
    if (folded.loop !== undefined) table.loop = folded.loop;
    inst.filtertable = table;
    gap.filterRecovered = true;
  } else if (program.some((c) => c.filt)) {
    gap.unsupported.push({ kind: "filtertable", detail: "the filter state of a routed note cannot be written as a filter table" });
  }
  const needsWavetable = program.some((c) => c.wave !== first.wave || !c.gate || c.offset !== 0 || !!c.slide);
  if (needsWavetable) {
    const steps = wavetableSteps(program);
    if (steps) {
      const folded = foldLoop(steps);
      if (folded.steps.length > MAX_TABLE_STEPS) gap.unsupported.push({ kind: "wavetable", detail: `${folded.steps.length} steps exceed ${MAX_TABLE_STEPS}` });
      inst.wavetable = folded.steps;
      if (folded.loop !== undefined) inst.loop = folded.loop;
    }
  }
  if (vibrato) inst.vibrato = { depth: vibrato.depth, rate: vibrato.rate, ...(vibrato.delayCalls ? { delay: vibrato.delayCalls / speed } : {}) };
  const frames = restart.calls / speed;
  const isDefault = restart.calls === 2 * speed && restart.ad === 0 && restart.sr === 0 && !restart.test;
  if (!isDefault) {
    if (!Number.isInteger(frames)) gap.unsupported.push({ kind: "hard_restart", detail: `${restart.calls} restart calls are not a multiple of speed ${speed}` });
    // The language counts a restart in whole frames: 1 to 255, and zero disables it (then it cannot set ADSR or the test bit).
    const wholeFrames = restart.calls === 0 ? 0 : Math.max(1, Math.min(255, Math.round(frames)));
    const hr: Record<string, unknown> = { frames: wholeFrames };
    if (wholeFrames > 0 && (restart.ad || restart.sr)) hr.adsr = [restart.ad >> 4, restart.ad & 15, restart.sr >> 4, restart.sr & 15];
    if (wholeFrames > 0 && restart.test) hr.test = true;
    inst.hard_restart = hr;
  }
  return inst;
}

// ---- step 6 and 7: structure and emission --------------------------------------------------------------------------

type Entry = { kind: "note"; seg: NoteSegment; len: number } | { kind: "rest"; len: number } | { kind: "tie"; len: number };

function voiceEntries(segs: NoteSegment[], rows: number): Entry[] {
  const entries: Entry[] = [];
  let pos = 0;
  for (const seg of segs) {
    if (seg.start > pos) entries.push({ kind: "rest", len: seg.start - pos });
    entries.push({ kind: "note", seg, len: seg.length });
    pos = seg.start + seg.length;
  }
  if (pos < rows) entries.push({ kind: "rest", len: rows - pos });
  return entries;
}

/**
 * Splits the entries into blocks that end at the first entry boundary at or after each multiple of the block size.
 * A note is never cut: the compiler checks the minimum length of the first part of a note that continues in a tie.
 */
function blockEntries(entries: Entry[], block: number): Entry[][] {
  const blocks: Entry[][] = [];
  let pos = 0;
  let blockStart = 0;
  let current: Entry[] = [];
  for (const e of entries) {
    // A rest is split at the boundary; a note is not. The boundary is a block length after the start of the current block.
    let left = e.len;
    while (left > 0) {
      const room = blockStart + block - pos;
      const take = e.kind === "rest" ? Math.min(room, left) : left;
      current.push(e.kind === "note" ? { kind: "note", seg: e.seg, len: take } : { kind: e.kind, len: take });
      pos += take;
      left -= take;
      if (pos >= blockStart + block) {
        blocks.push(current);
        current = [];
        blockStart = pos;
      }
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function entryKey(e: Entry): string {
  return e.kind === "note" ? `n${e.seg.midi}:${e.seg.instrument}:${e.len}:${e.seg.gateOffFrames ?? 0}` : `${e.kind[0]}${e.len}`;
}

function grooveOf(entries: Entry[], unit: number, callsPerBeat: number, instNames: string[], defaultInst: number): { length: number; groove: unknown[] } {
  const groove: unknown[] = [];
  const beat = (calls: number): number => calls / callsPerBeat;
  for (const e of entries) {
    if (e.kind === "note") {
      const name = midiToNoteName(e.seg.midi);
      const inst = e.seg.instrument !== defaultInst ? instNames[e.seg.instrument]! : undefined;
      if (e.len === unit && !e.seg.gateOffFrames) groove.push(inst ? `${name}@${inst}` : name);
      else groove.push({ note: name, ...(inst ? { inst } : {}), len: beat(e.len), ...(e.seg.gateOffFrames ? { gate_off: e.seg.gateOffFrames } : {}) });
      continue;
    }
    for (let i = 0; i < e.len / unit; i++) groove.push(e.kind === "rest" ? "-" : "~");
  }
  return { length: beat(unit), groove };
}

function sequenceText(names: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length;) {
    let j = i;
    while (j < names.length && names[j] === names[i]) j++;
    parts.push(j - i > 1 ? `${names[i]}*${j - i}` : names[i]!);
    i = j;
  }
  return parts.join(" ");
}

interface Layout {
  blockBars: number | "flat";
  voices: Array<{ patterns: Record<string, { length: number; groove: unknown[] }>; sequence: string }>;
}

function layoutVoices(entriesByVoice: Entry[][], rows: number, callsPerBeat: number, instNames: string[], defaults: number[],
  blockBars: number | "flat"): Layout {
  const block = blockBars === "flat" ? rows : blockBars * BEATS_PER_BAR * callsPerBeat;
  const voices = entriesByVoice.map((entries, v) => {
    const blocks = blockEntries(entries, block);
    const names: string[] = [];
    const known = new Map<string, string>();
    const patterns: Record<string, { length: number; groove: unknown[] }> = {};
    for (const b of blocks) {
      const key = b.map(entryKey).join("|");
      let name = known.get(key);
      if (!name) {
        name = `P${known.size + 1}`;
        known.set(key, name);
        let unit = 0;
        for (const e of b) unit = gcd(unit, e.len);
        patterns[name] = grooveOf(b, unit || 1, callsPerBeat, instNames, defaults[v]!);
      }
      names.push(name);
    }
    return { patterns, sequence: sequenceText(names) };
  });
  return { blockBars, voices };
}

/** Removes tables and vibrato (level 1), then pulse width, ring and sync (level 2), then the hard restart (level 3). */
function simplifyInstrument(y: Record<string, unknown>, level: number): Record<string, unknown> {
  const out: Record<string, unknown> = { waveform: y.waveform, adsr: y.adsr };
  if (level <= 1) {
    for (const k of ["ring", "sync", "pulse_width", "hard_restart"]) if (y[k] !== undefined) out[k] = y[k];
  } else if (level === 2 && y.hard_restart !== undefined) out.hard_restart = y.hard_restart;
  return out;
}

// ---- the recovery --------------------------------------------------------------------------------------------------

export function recoverScore(ir: FrameIr, options: RecoverOptions = {}): RecoveredScore {
  const unsupported: UnsupportedFeature[] = [];
  const extensions = new Map<string, LanguageExtension>();
  const extend = (id: string, construct: string, reason: string, rep: Reproducer): void => {
    const known = extensions.get(id);
    if (known) known.occurrences++;
    else extensions.set(id, { id, construct, reason, occurrences: 1, reproducer: rep });
  };

  if (ir.calls.length < 2) throw new Error("the trace holds fewer than two player calls");
  const firstCall = isInitCall(ir, 0) ? 1 : 0;
  const rows = ir.calls.length - firstCall;
  const exact = ir.callsPerFrameExact;
  const speed = Math.max(1, ir.callsPerFrame);
  if (Math.abs(exact - speed) > CALL_RATE_TOLERANCE * speed) {
    unsupported.push({
      kind: "call_rate", detail: `calls per frame is ${exact.toFixed(3)}, not an integer multiple of the frame rate`,
      evidence: { periodCycles: ir.periodCycles, callsPerFrameExact: exact },
    });
  }
  if (ir.unsupported.writes > 0) {
    unsupported.push({
      kind: "non_periodic_writes",
      detail: `${ir.unsupported.writes} writes (${(ir.unsupported.share * 100).toFixed(1)} percent) are outside the periodic calls`,
      evidence: { streams: ir.unsupported.streams },
    });
  }
  if (ir.jitter.irregularSpacings > 0 && ir.jitter.irregularShare > IRREGULAR_SHARE_REPORT) {
    unsupported.push({ kind: "call_timing", detail: "call spacing is irregular", evidence: { ...ir.jitter } });
  }
  const system = ir.clock;
  const frameRate = sidwaveFrameRate(system);
  let callsPerBeat = CALLS_PER_BEAT_PER_SPEED * speed;
  if ((60 * frameRate * speed) / callsPerBeat > TEMPO_LIMIT) callsPerBeat = CALLS_PER_BEAT_PER_SPEED_FAST * speed;
  const tempo = (60 * frameRate * speed) / callsPerBeat;

  const tracks = extractTracks(ir, firstCall);
  if (ir.sidCount > 1) {
    unsupported.push({
      kind: "multi_sid", detail: `${ir.sidCount} SIDs; only SID 1 is recovered`,
      evidence: { sidCount: ir.sidCount },
    });
    extend("sid-address", "SID address map from the trace", "the IR numbers SIDs; their addresses are not in the trace", reproducer(ir, 1, 0, firstCall));
  }
  const used = tracks.filter((t) => t.sid === 0 && t.ctl.some((c) => c & 1));
  const tuning = estimateTuning(used, ir.clockHz);
  if (tuning.matched < TUNING_MATCH_MIN && tuning.distinct) {
    unsupported.push({
      kind: "tuning", detail: `only ${(tuning.matched * 100).toFixed(1)} percent of the gate-on frequency values match a tuned equal-temperament note`,
      evidence: { cents: tuning.cents, mode: tuning.mode },
    });
  }
  const gaps = { unsupported: [] as Array<{ call: number; kind: string; detail: string }> };
  const segsByTrack = used.map((t) => segmentTrack(t, tuning.cents, ir.clockHz, speed, maxSidwaveMidi(system), gaps));
  // Global registers: filter cutoff, resonance and routing, mode and volume.
  const globalSeen = new Map<number, Set<number>>();
  for (let k = firstCall; k < ir.calls.length; k++) {
    const regs = ir.calls[k]!.sids[0]!.regs;
    for (const r of [0x15, 0x16, 0x17, 0x18]) {
      let set = globalSeen.get(r);
      if (!set) globalSeen.set(r, (set = new Set()));
      set.add(regs[r]!);
    }
  }
  // The player ramps the volume up over its first calls; that start ramp is the player's, not the score's.
  const volumeRamp = (() => {
    let k = firstCall;
    let end = k;
    while (k + 1 < ir.calls.length && ir.calls[k + 1]!.sids[0]!.regs[0x18]! === ir.calls[k]!.sids[0]!.regs[0x18]! + 1) k++;
    end = k + 1;
    return end;
  })();
  const volumeAfterRamp = new Set<number>();
  for (let k = volumeRamp; k < ir.calls.length; k++) volumeAfterRamp.add(ir.calls[k]!.sids[0]!.regs[0x18]!);
  if (volumeAfterRamp.size) globalSeen.set(0x18, volumeAfterRamp);
  const changing = [...globalSeen].filter(([, set]) => set.size > 1).map(([r]) => r);

  // The first note of a voice has no predecessor, so its restart is unobservable: it takes the most common restart of its voice.
  for (const segs of segsByTrack) {
    const counts = new Map<string, { n: number; restart: RestartInfo }>();
    for (const s of segs.slice(1)) {
      const k = JSON.stringify(s.restart);
      counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, restart: s.restart });
    }
    const common = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.restart ?? { calls: 2 * speed, ad: 0, sr: 0, test: false };
    if (segs[0]) segs[0].restart = segs[0].length >= common.calls + speed ? common : { calls: 0, ad: 0, sr: 0, test: false };
  }

  // The last note may be cut by the horizon; the compiler needs its full minimum length, which lies after the horizon.
  for (const segs of segsByTrack) {
    const last = segs[segs.length - 1];
    if (last) last.length = Math.max(last.length, last.restart.calls + speed);
  }

  // The language needs a note to last at least its hard restart plus one call group; a restart longer than that is
  // shortened for this note so that the score compiles. The shortening is reported as an unsupported hard restart.
  let shortenedRestarts = 0;
  for (const segs of segsByTrack) {
    for (const seg of segs) {
      const room = Math.floor((seg.length - speed) / speed) * speed;
      if (seg.restart.calls > 0 && !seg.phantom && room < seg.restart.calls) {
        seg.restart = room > 0 ? { ...seg.restart, calls: room } : { calls: 0, ad: 0, sr: 0, test: false };
        shortenedRestarts++;
      }
    }
  }
  if (shortenedRestarts) unsupported.push({ kind: "hard_restart", detail: `${shortenedRestarts} notes are shorter than their hard restart plus one call group; the restart was shortened`, evidence: {} });

  // Instruments: cluster notes by attributes, then by program prefix.
  const defs: InstrumentDef[] = [];
  const allSegs = segsByTrack.flat();
  const groups = new Map<string, NoteSegment[]>();
  for (const seg of allSegs) {
    const r = seg.restart;
    const key = `${seg.ad}:${seg.sr}:${r.calls}:${r.ad}:${r.sr}:${r.test}:${seg.program[0]?.wave}`;
    const list = groups.get(key);
    if (list) list.push(seg);
    else groups.set(key, [seg]);
  }
  for (const list of [...groups.values()].sort((a, b) => allSegs.indexOf(a[0]!) - allSegs.indexOf(b[0]!))) {
    const sorted = [...list].sort((a, b) => b.program.length - a.program.length);
    const reps: Array<{ program: ProgramCall[]; defIndex: number }> = [];
    for (const seg of sorted) {
      let rep = reps.find((r) => isPrefix(seg.program, r.program));
      if (!rep) {
        rep = { program: seg.program, defIndex: defs.length };
        defs.push({ name: "", program: seg.program, ad: seg.ad, sr: seg.sr, restart: seg.restart, yaml: {} });
        reps.push(rep);
      }
      seg.instrument = rep.defIndex;
    }
  }
  // Names in order of first use across voices, then definitions.
  const order: number[] = [];
  const seenDef = new Set<number>();
  for (const seg of [...allSegs].sort((a, b) => a.start - b.start)) {
    if (!seenDef.has(seg.instrument)) {
      seenDef.add(seg.instrument);
      order.push(seg.instrument);
    }
  }
  const remap = new Map(order.map((d, i) => [d, i]));
  const renamed: InstrumentDef[] = order.map((d, i) => ({ ...defs[d]!, name: `i${i + 1}` }));
  for (const seg of allSegs) seg.instrument = remap.get(seg.instrument)!;
  const membersOf: NoteSegment[][] = renamed.map(() => []);
  for (const seg of allSegs) if (!seg.phantom) membersOf[seg.instrument]!.push(seg);
  // Table budget (repair): the player holds at most 63 instrument shapes and 255 steps per table kind for the whole score.
  // Instruments are kept in full in order of use (most notes first) while the budgets hold; the others lose their tables
  // and vibrato, and the simplified shapes that become equal share one instrument. Search space: the number of fully kept
  // instruments and the simplification level (3 levels); objective: most notes fully kept; deterministic, no work budget needed (linear in the instruments).
  const budgetGap = { unsupported: [] as Array<{ kind: string; detail: string }>, filterRecovered: false };
  const fullYaml = renamed.map((def) => buildInstrumentYaml(def.program, def.ad, def.sr, def.restart, speed, budgetGap));
  const sizes = fullYaml.map((y) => ({
    wave: Array.isArray(y.wavetable) ? (y.wavetable as unknown[]).length : 0,
    pulse: y.pulsetable ? ((y.pulsetable as { steps: unknown[] }).steps.length) : 0,
    filter: y.filtertable ? ((y.filtertable as { steps: unknown[] }).steps.length) : 0,
  }));
  const rank = renamed.map((_, i) => i).sort((a, b) => membersOf[b]!.length - membersOf[a]!.length || a - b);
  const keyOf = (y: Record<string, unknown>): string => JSON.stringify(y);
  const fullKeys = fullYaml.map(keyOf);
  let budget: { keep: Set<number>; level: number } | undefined;
  for (let level = 1; level <= 3 && !budget; level++) {
    const simple = renamed.map((_, i) => keyOf(simplifyInstrument(fullYaml[i]!, level)));
    for (let k = renamed.length; k >= 0 && !budget; k--) {
      const keep = new Set<number>();
      const tot = { wave: 0, pulse: 0, filter: 0 };
      for (const i of rank) {
        if (keep.size >= k) break;
        const z = sizes[i]!;
        if (z.wave > MAX_TABLE_STEPS_TOTAL || z.pulse > MAX_TABLE_STEPS_TOTAL || z.filter > MAX_TABLE_STEPS_TOTAL) continue;
        if (tot.wave + z.wave > MAX_TABLE_STEPS_TOTAL || tot.pulse + z.pulse > MAX_TABLE_STEPS_TOTAL || tot.filter + z.filter > MAX_TABLE_STEPS_TOTAL) continue;
        keep.add(i);
        tot.wave += z.wave; tot.pulse += z.pulse; tot.filter += z.filter;
      }
      const shapes = new Set<string>();
      for (let i = 0; i < renamed.length; i++) shapes.add(keep.has(i) ? fullKeys[i]! : simple[i]!);
      if (shapes.size <= MAX_INSTRUMENT_SHAPES) budget = { keep, level };
      if (k > 0 && keep.size < k) k = keep.size + 1;
    }
  }
  const finalYaml: Array<Record<string, unknown>> = [];
  const finalIndex = new Map<string, number>();
  const defToFinal: number[] = [];
  let simplifiedCount = 0;
  for (let i = 0; i < renamed.length; i++) {
    const kept = budget?.keep.has(i) ?? false;
    let y = fullYaml[i]!;
    if (!kept) {
      y = simplifyInstrument(y, budget?.level ?? 3);
      simplifiedCount += membersOf[i]!.length;
    }
    const key = keyOf(y);
    let index = finalIndex.get(key);
    if (index === undefined) {
      index = finalYaml.length;
      finalIndex.set(key, index);
      finalYaml.push(y);
    }
    defToFinal.push(index);
  }
  if (simplifiedCount > 0) {
    unsupported.push({
      kind: "instrument_budget",
      detail: `${simplifiedCount} notes use instruments whose tables or vibrato were dropped to stay within ${MAX_INSTRUMENT_SHAPES} instrument shapes and ${MAX_TABLE_STEPS_TOTAL} table steps per kind`,
      evidence: { instruments: renamed.length, fullyKept: budget?.keep.size ?? 0, simplificationLevel: budget?.level ?? 3 },
    });
  }
  for (const seg of allSegs) seg.instrument = defToFinal[seg.instrument]!;
  const instruments: Record<string, unknown> = {};
  const finalDefs: InstrumentDef[] = finalYaml.map((y, i) => ({ name: `i${i + 1}`, program: [], ad: 0, sr: 0, restart: { calls: 0, ad: 0, sr: 0, test: false }, yaml: y }));
  // Vibrato fit (a search over depth, rate and delay) only for the instruments that keep their tables, one fit per final instrument.
  const fitted = new Set<number>();
  for (let i = 0; i < renamed.length; i++) {
    const fi = defToFinal[i]!;
    if (!(budget?.keep.has(i) ?? false) || fitted.has(fi)) continue;
    const members = allSegs.filter((x) => x.instrument === fi && !x.phantom);
    const modulated = members.find((x) => x.modulated);
    if (!modulated) continue;
    fitted.add(fi);
    const vibrato = fitVibrato(members, tuning.cents, ir.clockHz, speed, frameRate * speed);
    if (vibrato) {
      finalYaml[fi] = { ...finalYaml[fi]!, vibrato: { depth: vibrato.depth, rate: vibrato.rate, ...(vibrato.delayCalls ? { delay: vibrato.delayCalls / speed } : {}) } };
      finalDefs[fi]!.yaml = finalYaml[fi]!;
    } else {
      const track = used[segsByTrack.findIndex((list) => list.includes(modulated))]!;
      unsupported.push({
        kind: "pitch", detail: `instrument ${finalDefs[fi]!.name}: the frequency registers of ${members.filter((x) => x.modulated).length} notes are not equal-temperament pitches and no vibrato reproduces them`,
        evidence: { note: modulated.start, midi: modulated.midi },
      });
      const changes = modulated.freqs.filter((f, i2) => i2 > 0 && f !== modulated.freqs[i2 - 1]).length;
      if (changes * 3 <= modulated.freqs.length) {
        extend("exact-frequency", "a note given as an exact frequency register value (or a per-note cents offset)",
          "constant frequency registers that are not equal-temperament pitches under any single tuning", reproducer(ir, track.sid, track.voice, firstCall + modulated.start));
      } else {
        extend("pitch-table", "per-call frequency register values (pitch table, portamento or a vibrato shape the language lacks)",
          "frequency registers deviate from the note pitch in a way no vibrato of the language reproduces", reproducer(ir, track.sid, track.voice, firstCall + modulated.start));
      }
    }
  }
  for (const def of finalDefs) instruments[def.name] = def.yaml;
  for (const g of budgetGap.unsupported) {
    unsupported.push({ kind: g.kind, detail: g.detail, evidence: {} });
    extend(`table-${g.kind}`, `${g.kind} that the language cannot express`, g.detail, reproducer(ir, 0, 0, firstCall));
  }
  const gapInst = budgetGap;
  // Filter state that a recovered per-note filter table reproduces is not reported; the F-diff shows whether it does.
  gapInst.filterRecovered = Object.values(instruments).some((y) => !!(y as Record<string, unknown>).filtertable);
  if (changing.length && !gapInst.filterRecovered) {
    unsupported.push({
      kind: "global_state",
      detail: "filter, resonance, routing, mode or volume registers change during the tune; global filter and volume sequences are not recovered",
      evidence: { registers: Object.fromEntries(changing.map((r) => [`$D4${r.toString(16)}`, [...globalSeen.get(r)!].slice(0, 8)])) },
    });
    const firstChange = ir.calls.findIndex((c, i) => i > firstCall && changing.some((r) => c.sids[0]!.regs[r] !== ir.calls[firstCall]!.sids[0]!.regs[r]));
    extend("global-register-sequence", "per-call global filter and volume register sequence",
      "the language has no construct for an arbitrary cutoff, resonance, routing, mode or volume sequence",
      reproducer(ir, 0, 0, Math.max(firstCall, firstChange)));
  }

  const instNames = finalDefs.map((d) => d.name);

  // Per voice entries, structure alternatives and emission.
  const voiceIds = used.map((t) => t.voice + 1);
  // The section ends at a bar line, so every voice is padded with rests to that line; otherwise a pattern would wrap inside the horizon.
  let lastRow = rows;
  for (const segs of segsByTrack) for (const x of segs) lastRow = Math.max(lastRow, x.start + x.length);
  const bars = Math.max(1, Math.ceil(lastRow / (BEATS_PER_BAR * callsPerBeat)));
  const paddedRows = bars * BEATS_PER_BAR * callsPerBeat;
  const entriesByVoice = segsByTrack.map((segs) => voiceEntries(segs, paddedRows));
  const defaults = segsByTrack.map((segs) => {
    const counts = new Map<number, number>();
    for (const s of segs) counts.set(s.instrument, (counts.get(s.instrument) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  });
  const build = (layout: Layout): Record<string, unknown> => ({
    sidwave: "1.4",
    title: options.title ?? "Reconstructed",
    tempo,
    mode: system,
    speed,
    ...(Object.keys(instruments).length ? { instruments } : {}),
    voices: layout.voices.map((v, i) => ({
      id: voiceIds[i], ...(tuning.cents ? { detune: tuning.cents } : {}), instrument: instNames[defaults[i]!], patterns: v.patterns,
    })),
    timeline: [{
      section: "Song", bars,
      layers: Object.fromEntries(layout.voices.map((v, i) => [`v${voiceIds[i]}`, v.sequence])),
    }],
  });
  const alternatives: Array<{ blockBars: number | "flat"; bytes: number; document: Record<string, unknown> }> = [];
  for (const blockBars of ["flat", ...BLOCK_BARS] as const) {
    if (!entriesByVoice.length) break;
    const layout = layoutVoices(entriesByVoice, paddedRows, callsPerBeat, instNames, defaults, blockBars);
    const document = build(layout);
    alternatives.push({ blockBars, bytes: formatSidwave(YAML.stringify(document)).length, document });
  }
  const chosen = alternatives.length ? alternatives.reduce((a, b) => (b.bytes < a.bytes ? b : a)) : undefined;
  // A tune without a gated note still needs one voice for the score to compile: a single rest.
  const silent: Layout = { blockBars: "flat", voices: [{ patterns: { P1: { length: 1 / callsPerBeat, groove: ["-"] } }, sequence: "P1" }] };
  if (!used.length) { voiceIds.push(1); entriesByVoice.push([]); defaults.push(0); }
  const document = chosen?.document ?? build(silent);
  const text = formatSidwave(YAML.stringify(document));
  let patternCount = 0;
  for (const v of (document.voices as Array<{ patterns: object }>)) patternCount += Object.keys(v.patterns).length;
  return {
    document, text, speed, tempo, callsPerBeat, firstCall, rows, tuningCents: tuning.cents,
    noteCount: allSegs.filter((x) => !x.phantom).length, phantomNotes: allSegs.filter((x) => x.phantom).length, instrumentCount: finalDefs.length, patternCount,
    structure: {
      blockBars: chosen?.blockBars ?? "flat", bytes: chosen?.bytes ?? text.length,
      alternatives: alternatives.map(({ blockBars, bytes }) => ({ blockBars, bytes })),
    },
    unsupported, extensions: [...extensions.values()],
    tuningEvidence: { distinctRegisters: tuning.distinct, matched: tuning.matched, histogramModeCents: tuning.mode },
  };
}

export { controlRegister };
