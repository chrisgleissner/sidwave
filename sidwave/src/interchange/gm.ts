// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// General MIDI mapping tables shared by the MIDI and MusicXML interchange code.

import type { ExportedInstrument, ExportedVoice } from "./events.js";

/** GM program numbers (0-based) for the built-in library instruments. */
export const LIBRARY_PROGRAM: Record<string, number> = {
  bass_pluck: 33, filter_bass: 38, lead_pwm: 80, chip_arp_major: 80, chip_arp_minor: 80, bell_ring: 14, sync_lead: 81,
  pad_slow: 89, octave_bass: 39, wide_pwm_pad: 90, pluck_arp: 46, noise_lead_attack: 81,
};

/** GM percussion keys for the library drum instruments and for common drum instrument names. */
export const LIBRARY_DRUM_KEY: Record<string, number> = { kick: 36, snare: 38, clap: 39, hat: 42, open_hat: 46, tom: 45, crash: 49 };

const DRUM_NAME_PATTERNS: Array<[RegExp, number]> = [
  [/kick|bass.?drum|\bbd\b/i, 36], [/snare|\bsd\b|\bsn\b/i, 38], [/clap/i, 39], [/open|\boh\b/i, 46], [/hat|\bhh\b|\bch\b/i, 42],
  [/tom/i, 45], [/crash|cym|ride/i, 49], [/rim|stick/i, 37],
];

/** GM percussion key for a drum instrument name; 38 (acoustic snare) for a name it does not know. */
export function drumKey(name: string | undefined): { key: number; known: boolean } {
  const bare = (name ?? "").replace(/^lib:/, "");
  if (Object.prototype.hasOwnProperty.call(LIBRARY_DRUM_KEY, bare)) return { key: LIBRARY_DRUM_KEY[bare]!, known: true };
  for (const [pattern, key] of DRUM_NAME_PATTERNS) if (pattern.test(bare)) return { key, known: true };
  return { key: 38, known: false };
}

/** Role and waveform fallbacks for score instruments that are not library instruments. */
export function programFor(voice: Pick<ExportedVoice, "role">, instrument: ExportedInstrument | undefined): number {
  const name = instrument?.name?.replace(/^lib:/, "");
  if (name !== undefined && Object.prototype.hasOwnProperty.call(LIBRARY_PROGRAM, name)) return LIBRARY_PROGRAM[name]!;
  const wave = instrument?.waveform ?? "pulse";
  if (voice.role === "bass") return wave.includes("saw") ? 38 : wave.includes("triangle") ? 33 : 39;
  if (voice.role === "pad") return wave.includes("triangle") ? 89 : 90;
  if (voice.role === "arp") return 80;
  if (wave.includes("noise")) return 120;
  if (wave.includes("saw")) return 81;
  if (wave.includes("triangle")) return 79;
  return 80;
}

/** Import side: SIDWave instrument recipe for each family of GM programs. */
export interface ImportInstrument { name: string; waveform: "pulse" | "sawtooth" | "triangle"; adsr: [number, number, number, number]; pulse_width?: number }

const FAMILIES: Array<[number, number, ImportInstrument]> = [
  [0, 7, { name: "keys", waveform: "pulse", adsr: [0, 6, 6, 4], pulse_width: 0.4 }],
  [8, 15, { name: "mallet", waveform: "triangle", adsr: [0, 5, 4, 5] }],
  [16, 23, { name: "organ", waveform: "pulse", adsr: [0, 0, 12, 1], pulse_width: 0.5 }],
  [24, 31, { name: "guitar", waveform: "pulse", adsr: [0, 6, 4, 3], pulse_width: 0.3 }],
  [32, 39, { name: "bass", waveform: "sawtooth", adsr: [0, 6, 8, 3] }],
  [40, 55, { name: "strings", waveform: "sawtooth", adsr: [4, 5, 10, 6] }],
  [56, 63, { name: "brass", waveform: "sawtooth", adsr: [2, 5, 10, 4] }],
  [64, 79, { name: "wind", waveform: "triangle", adsr: [2, 4, 11, 4] }],
  [80, 87, { name: "lead", waveform: "pulse", adsr: [1, 4, 10, 3], pulse_width: 0.5 }],
  [88, 103, { name: "pad", waveform: "triangle", adsr: [5, 4, 11, 7] }],
  [104, 119, { name: "pluck", waveform: "pulse", adsr: [0, 5, 3, 3], pulse_width: 0.25 }],
];

/** Instrument recipe for a GM program (0-based); the plain lead for an unknown program or none. */
export function instrumentForProgram(program: number | undefined): ImportInstrument {
  const hit = program === undefined ? undefined : FAMILIES.find(([lo, hi]) => program >= lo && program <= hi);
  return hit ? hit[2] : { name: "lead", waveform: "pulse", adsr: [1, 4, 10, 3], pulse_width: 0.5 };
}

/** Import side: library drum instrument for a GM percussion key, with the one-letter kit key used in the score. */
export const IMPORT_DRUMS: Record<number, { lib: string; letter: string; priority: number }> = (() => {
  const table: Record<number, { lib: string; letter: string; priority: number }> = {};
  const add = (keys: number[], lib: string, letter: string, priority: number) => { for (const key of keys) table[key] = { lib, letter, priority }; };
  add([35, 36], "kick", "k", 7);
  add([37, 38, 40], "snare", "s", 6);
  add([39], "clap", "p", 5);
  add([41, 43, 45, 47, 48, 50], "tom", "t", 4);
  add([49, 51, 52, 53, 55, 57, 59], "crash", "x", 3);
  add([46], "open_hat", "o", 2);
  add([42, 44, 54, 56, 69, 70, 80, 81], "hat", "h", 1);
  return table;
})();
