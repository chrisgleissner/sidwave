// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import type { Development } from "./melody.js";
import type { KeyPlan, ModeName } from "./theory.js";

/**
 * Composer 2 profiles and forms. Both are data. A profile fixes style, tempo, form, mode, density and instrumentation;
 * a seed then chooses the harmony, motif, melody and variation within it. Nothing here names a song.
 */

export type FormName = "aaba" | "verse-chorus" | "rondo" | "binary" | "through" | "loop" | "arch";
export type Role = "lead" | "counter" | "arp" | "bass" | "drums" | "pad";
export type LayoutName = "bass-arp-lead" | "bass-drums-lead" | "bass-counter-lead" | "two-sid-five" | "two-sid-six";
export type PaletteName = "chip" | "saw" | "soft" | "funk";

export interface Layout {
  /** Number of SID chips used; each carries at most three voices. */
  sids: 1 | 2;
  /** Voice id of each role (voices 1-3 are on the first SID, 4-6 on the second). */
  voices: Partial<Record<Role, number>>;
}

export const LAYOUTS: Record<LayoutName, Layout> = {
  "bass-arp-lead": { sids: 1, voices: { bass: 1, arp: 2, lead: 3 } },
  "bass-drums-lead": { sids: 1, voices: { bass: 1, drums: 2, lead: 3 } },
  "bass-counter-lead": { sids: 1, voices: { bass: 1, counter: 2, lead: 3 } },
  "two-sid-five": { sids: 2, voices: { bass: 1, arp: 2, drums: 3, lead: 4, counter: 5 } },
  "two-sid-six": { sids: 2, voices: { bass: 1, arp: 2, pad: 3, lead: 4, counter: 5, drums: 6 } },
};

/** Library instruments per role. None of them uses a filter table, so a profile never depends on a SID filter model. */
export const PALETTES: Record<PaletteName, Record<"lead" | "counter" | "bass" | "pad", string>> = {
  chip: { lead: "lib:lead_pwm", counter: "lib:wide_pwm_pad", bass: "lib:bass_pluck", pad: "lib:wide_pwm_pad" },
  saw: { lead: "lib:octave_bass", counter: "lib:lead_pwm", bass: "lib:bass_pluck", pad: "lib:wide_pwm_pad" },
  soft: { lead: "lib:wide_pwm_pad", counter: "lib:lead_pwm", bass: "lib:bass_pluck", pad: "lib:wide_pwm_pad" },
  funk: { lead: "lib:noise_lead_attack", counter: "lib:lead_pwm", bass: "lib:bass_pluck", pad: "lib:wide_pwm_pad" },
};

export interface ComposeProfile {
  name: string;
  description: string;
  tempo: number;
  /** Player calls per video frame. */
  speed: 1 | 2;
  /** Quarter notes per bar: 4 or 3. */
  meter: 3 | 4;
  mode: ModeName;
  /** Pitch class of the tonic, 0 = C. */
  tonic: number;
  form: FormName;
  /** `loop` drops the outro and loops; `end` keeps the outro and ends the score. */
  ending: "loop" | "end";
  layout: LayoutName;
  palette: PaletteName;
  groove: string;
  bass: string;
  drums: string;
  arp: string;
  /** 0..1 chance of an anticipated onset on beats 2 and 4. */
  syncopation: number;
  /** 0..1 scale on the share of rests. */
  density: number;
  /** Bars per phrase, 2 or 4. */
  phraseBars: 2 | 4;
  /** Chords per bar, 1 or 2. */
  harmonicRhythm: 1 | 2;
  /** Key of the contrasting sections relative to the home key. */
  contrast: KeyPlan;
  /** 0..1 appetite for melodic leaps. */
  leaps: number;
  /** Lowest MIDI note of the lead range. The range spans 19 semitones. */
  register: number;
}

export const PROFILES: readonly ComposeProfile[] = [
  { name: "chip-aaba-minor", description: "Minor, 130 bpm AABA with a driving groove, arpeggio harmony and a pulse lead", tempo: 130, speed: 1, meter: 4, mode: "minor", tonic: 9, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "driving", bass: "pulse", drums: "backbeat", arp: "eighth", syncopation: 0.2, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.4, register: 62 },
  { name: "chip-aaba-major", description: "Major, 120 bpm AABA with a straight groove and quarter-note arpeggios", tempo: 120, speed: 1, meter: 4, mode: "major", tonic: 0, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "straight", bass: "rootfifth", drums: "backbeat", arp: "quarter", syncopation: 0.1, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.3, register: 64 },
  { name: "chip-drums-minor", description: "Minor, 140 bpm verse and chorus with drums instead of harmony", tempo: 140, speed: 1, meter: 4, mode: "minor", tonic: 4, form: "verse-chorus", ending: "loop", layout: "bass-drums-lead", palette: "chip", groove: "driving", bass: "driving", drums: "fourfloor", arp: "quarter", syncopation: 0.25, density: 0.7, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.5, register: 60 },
  { name: "chip-drums-major", description: "Major, 150 bpm verse and chorus with a syncopated lead over a pulse bass", tempo: 150, speed: 1, meter: 4, mode: "major", tonic: 7, form: "verse-chorus", ending: "loop", layout: "bass-drums-lead", palette: "chip", groove: "syncopated", bass: "pulse", drums: "backbeat", arp: "eighth", syncopation: 0.35, density: 0.7, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.45, register: 62 },
  { name: "chip-rondo-dorian", description: "Dorian, 110 bpm rondo with a flowing lead", tempo: 110, speed: 1, meter: 4, mode: "dorian", tonic: 2, form: "rondo", ending: "end", layout: "bass-arp-lead", palette: "chip", groove: "flowing", bass: "rootfifth", drums: "halftime", arp: "half", syncopation: 0.1, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "subdominant", leaps: 0.3, register: 62 },
  { name: "chip-binary-mixolydian", description: "Mixolydian, 125 bpm two-part form with offbeat arpeggios", tempo: 125, speed: 1, meter: 4, mode: "mixolydian", tonic: 7, form: "binary", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "straight", bass: "octave", drums: "backbeat", arp: "offbeat", syncopation: 0.2, density: 0.55, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.35, register: 64 },
  { name: "chip-loop-minor", description: "Short two-phrase game loop, minor, 135 bpm", tempo: 135, speed: 1, meter: 4, mode: "minor", tonic: 2, form: "loop", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "driving", bass: "pulse", drums: "backbeat", arp: "eighth", syncopation: 0.2, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.4, register: 62 },
  { name: "chip-loop-major", description: "Short two-phrase game loop, major, 145 bpm, two chords per bar", tempo: 145, speed: 1, meter: 4, mode: "major", tonic: 5, form: "loop", ending: "loop", layout: "bass-drums-lead", palette: "chip", groove: "driving", bass: "driving", drums: "fourfloor", arp: "eighth", syncopation: 0.15, density: 0.65, phraseBars: 4, harmonicRhythm: 2, contrast: "home", leaps: 0.4, register: 64 },
  { name: "chip-through-phrygian", description: "Phrygian, 100 bpm through-composed piece that ends", tempo: 100, speed: 1, meter: 4, mode: "phrygian", tonic: 4, form: "through", ending: "end", layout: "bass-counter-lead", palette: "chip", groove: "flowing", bass: "rootfifth", drums: "sparse", arp: "half", syncopation: 0.05, density: 0.4, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.3, register: 60 },
  { name: "chip-arch-lydian", description: "Lydian, 115 bpm arch form with a counter line", tempo: 115, speed: 1, meter: 4, mode: "lydian", tonic: 5, form: "arch", ending: "end", layout: "bass-counter-lead", palette: "chip", groove: "straight", bass: "walking", drums: "halftime", arp: "quarter", syncopation: 0.1, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.3, register: 64 },
  { name: "multi-aaba-minor", description: "Minor, 126 bpm AABA at speed 2 with arpeggio harmony", tempo: 126, speed: 2, meter: 4, mode: "minor", tonic: 0, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "driving", bass: "pulse", drums: "backbeat", arp: "eighth", syncopation: 0.2, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.4, register: 62 },
  { name: "multi-vc-major", description: "Major, 132 bpm verse and chorus at speed 2 with drums", tempo: 132, speed: 2, meter: 4, mode: "major", tonic: 9, form: "verse-chorus", ending: "loop", layout: "bass-drums-lead", palette: "chip", groove: "syncopated", bass: "funk", drums: "funk", arp: "eighth", syncopation: 0.3, density: 0.65, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.45, register: 62 },
  { name: "multi-binary-dorian", description: "Dorian, 118 bpm binary form at speed 2 with a counter line", tempo: 118, speed: 2, meter: 4, mode: "dorian", tonic: 9, form: "binary", ending: "loop", layout: "bass-counter-lead", palette: "soft", groove: "flowing", bass: "walking", drums: "halftime", arp: "quarter", syncopation: 0.1, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.3, register: 62 },
  { name: "saw-aaba-minor", description: "Minor, 128 bpm AABA with a synced sawtooth lead and octave bass", tempo: 128, speed: 1, meter: 4, mode: "minor", tonic: 7, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "saw", groove: "syncopated", bass: "octave", drums: "backbeat", arp: "offbeat", syncopation: 0.3, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.5, register: 60 },
  { name: "saw-vc-minor", description: "Minor, 138 bpm verse and chorus, sawtooth lead, driving drums", tempo: 138, speed: 1, meter: 4, mode: "minor", tonic: 11, form: "verse-chorus", ending: "loop", layout: "bass-drums-lead", palette: "saw", groove: "driving", bass: "driving", drums: "fourfloor", arp: "eighth", syncopation: 0.2, density: 0.7, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.5, register: 60 },
  { name: "saw-rondo-mixolydian", description: "Mixolydian, 112 bpm rondo with a sawtooth lead", tempo: 112, speed: 1, meter: 4, mode: "mixolydian", tonic: 2, form: "rondo", ending: "end", layout: "bass-arp-lead", palette: "saw", groove: "straight", bass: "rootfifth", drums: "backbeat", arp: "quarter", syncopation: 0.15, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "subdominant", leaps: 0.4, register: 62 },
  { name: "saw-loop-phrygian", description: "Phrygian, 120 bpm game loop with drums", tempo: 120, speed: 1, meter: 4, mode: "phrygian", tonic: 9, form: "loop", ending: "loop", layout: "bass-drums-lead", palette: "saw", groove: "driving", bass: "pulse", drums: "breakbeat", arp: "eighth", syncopation: 0.25, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.45, register: 60 },
  { name: "funk-vc-dorian", description: "Dorian, 105 bpm verse and chorus with a funk bass and offbeat lead", tempo: 105, speed: 1, meter: 4, mode: "dorian", tonic: 4, form: "verse-chorus", ending: "loop", layout: "bass-drums-lead", palette: "funk", groove: "syncopated", bass: "funk", drums: "funk", arp: "offbeat", syncopation: 0.4, density: 0.7, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.5, register: 62 },
  { name: "funk-aaba-mixolydian", description: "Mixolydian, 98 bpm AABA, shuffle lead over a funk bass", tempo: 98, speed: 1, meter: 4, mode: "mixolydian", tonic: 0, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "funk", groove: "shuffle", bass: "funk", drums: "funk", arp: "offbeat", syncopation: 0.3, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "subdominant", leaps: 0.4, register: 62 },
  { name: "funk-binary-minor", description: "Minor, 108 bpm binary form, funk bass, counter line", tempo: 108, speed: 1, meter: 4, mode: "minor", tonic: 7, form: "binary", ending: "loop", layout: "bass-counter-lead", palette: "funk", groove: "syncopated", bass: "funk", drums: "funk", arp: "offbeat", syncopation: 0.35, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.45, register: 60 },
  { name: "soft-through-major", description: "Major, 84 bpm sparse through-composed piece that ends", tempo: 84, speed: 1, meter: 4, mode: "major", tonic: 7, form: "through", ending: "end", layout: "bass-arp-lead", palette: "soft", groove: "sparse", bass: "sustained", drums: "sparse", arp: "half", syncopation: 0, density: 0.3, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.2, register: 64 },
  { name: "soft-arch-lydian", description: "Lydian, 76 bpm arch form with long notes", tempo: 76, speed: 1, meter: 4, mode: "lydian", tonic: 0, form: "arch", ending: "end", layout: "bass-arp-lead", palette: "soft", groove: "sparse", bass: "sustained", drums: "sparse", arp: "whole", syncopation: 0, density: 0.3, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.2, register: 64 },
  { name: "soft-aaba-minor", description: "Minor, 80 bpm slow AABA with a flowing lead", tempo: 80, speed: 1, meter: 4, mode: "minor", tonic: 2, form: "aaba", ending: "loop", layout: "bass-counter-lead", palette: "soft", groove: "flowing", bass: "walking", drums: "sparse", arp: "half", syncopation: 0.05, density: 0.4, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.25, register: 62 },
  { name: "soft-loop-dorian", description: "Dorian, 90 bpm ambient loop with slow chords", tempo: 90, speed: 1, meter: 4, mode: "dorian", tonic: 9, form: "loop", ending: "loop", layout: "bass-arp-lead", palette: "soft", groove: "sparse", bass: "sustained", drums: "sparse", arp: "whole", syncopation: 0, density: 0.35, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.2, register: 62 },
  { name: "waltz-aaba-minor", description: "Minor waltz, 3/4 at 120 bpm, AABA", tempo: 120, speed: 1, meter: 3, mode: "minor", tonic: 9, form: "aaba", ending: "loop", layout: "bass-arp-lead", palette: "chip", groove: "straight", bass: "rootfifth", drums: "backbeat", arp: "quarter", syncopation: 0.05, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.3, register: 64 },
  { name: "waltz-rondo-major", description: "Major waltz, 3/4 at 132 bpm, rondo that ends", tempo: 132, speed: 1, meter: 3, mode: "major", tonic: 5, form: "rondo", ending: "end", layout: "bass-arp-lead", palette: "chip", groove: "flowing", bass: "rootfifth", drums: "backbeat", arp: "quarter", syncopation: 0.05, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.3, register: 64 },
  { name: "waltz-binary-dorian", description: "Dorian in 3/4 at 108 bpm, binary form, counter line", tempo: 108, speed: 1, meter: 3, mode: "dorian", tonic: 2, form: "binary", ending: "loop", layout: "bass-counter-lead", palette: "soft", groove: "flowing", bass: "walking", drums: "sparse", arp: "quarter", syncopation: 0.05, density: 0.45, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.25, register: 62 },
  { name: "wide-aaba-minor", description: "Minor, 124 bpm AABA on two SIDs: lead, counter line, arpeggio, bass and drums", tempo: 124, speed: 1, meter: 4, mode: "minor", tonic: 4, form: "aaba", ending: "loop", layout: "two-sid-five", palette: "chip", groove: "driving", bass: "pulse", drums: "backbeat", arp: "eighth", syncopation: 0.2, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "relative", leaps: 0.4, register: 62 },
  { name: "wide-vc-major", description: "Major, 128 bpm verse and chorus on two SIDs with six voices", tempo: 128, speed: 1, meter: 4, mode: "major", tonic: 2, form: "verse-chorus", ending: "loop", layout: "two-sid-six", palette: "chip", groove: "syncopated", bass: "octave", drums: "fourfloor", arp: "offbeat", syncopation: 0.3, density: 0.65, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.45, register: 62 },
  { name: "wide-arch-dorian", description: "Dorian, 102 bpm arch form on two SIDs, six voices, ends", tempo: 102, speed: 1, meter: 4, mode: "dorian", tonic: 11, form: "arch", ending: "end", layout: "two-sid-six", palette: "soft", groove: "flowing", bass: "walking", drums: "halftime", arp: "half", syncopation: 0.1, density: 0.5, phraseBars: 4, harmonicRhythm: 1, contrast: "dominant", leaps: 0.3, register: 64 },
  { name: "wide-loop-minor", description: "Minor, 136 bpm game loop on two SIDs, five voices, speed 2", tempo: 136, speed: 2, meter: 4, mode: "minor", tonic: 0, form: "loop", ending: "loop", layout: "two-sid-five", palette: "saw", groove: "driving", bass: "driving", drums: "breakbeat", arp: "eighth", syncopation: 0.25, density: 0.65, phraseBars: 4, harmonicRhythm: 1, contrast: "home", leaps: 0.45, register: 60 },
  { name: "wide-rondo-mixolydian", description: "Mixolydian, 116 bpm rondo on two SIDs, five voices", tempo: 116, speed: 1, meter: 4, mode: "mixolydian", tonic: 9, form: "rondo", ending: "end", layout: "two-sid-five", palette: "funk", groove: "syncopated", bass: "funk", drums: "funk", arp: "offbeat", syncopation: 0.3, density: 0.6, phraseBars: 4, harmonicRhythm: 1, contrast: "subdominant", leaps: 0.4, register: 62 },
  { name: "brisk-through-major", description: "Major, 156 bpm through-composed piece with two chords per bar", tempo: 156, speed: 1, meter: 4, mode: "major", tonic: 10, form: "through", ending: "end", layout: "bass-drums-lead", palette: "chip", groove: "driving", bass: "pulse", drums: "fourfloor", arp: "eighth", syncopation: 0.2, density: 0.7, phraseBars: 2, harmonicRhythm: 2, contrast: "relative", leaps: 0.5, register: 64 },
];

// ---------------------------------------------------------------------------------------------------------
// Forms

export type SectionRole = "intro" | "theme" | "contrast" | "verse" | "chorus" | "bridge" | "outro";

export interface FormSection {
  name: string;
  /** Sections with the same material play the same harmony and melody; `vary` ornaments the repeat. */
  material: string;
  role: SectionRole;
  /** Length in phrases of `phraseBars` bars. */
  phrases: number;
  /** Whether the key follows the profile's `contrast` plan. */
  contrast?: boolean;
  /** Ornament the lead of this repeat. */
  vary?: boolean;
  level: "pp" | "p" | "mp" | "mf" | "f" | "ff";
  /** True for sections dropped when the profile loops. */
  outro?: boolean;
}

export const FORMS: Record<FormName, readonly FormSection[]> = {
  aaba: [
    { name: "A1", material: "A", role: "theme", phrases: 2, level: "mf" },
    { name: "A2", material: "A", role: "theme", phrases: 2, level: "mf", vary: true },
    { name: "B", material: "B", role: "contrast", phrases: 2, contrast: true, level: "p" },
    { name: "A3", material: "A", role: "theme", phrases: 2, level: "ff", vary: true },
  ],
  "verse-chorus": [
    { name: "Intro", material: "I", role: "intro", phrases: 1, level: "p" },
    { name: "Verse1", material: "V", role: "verse", phrases: 2, level: "mp" },
    { name: "Chorus1", material: "C", role: "chorus", phrases: 2, level: "f" },
    { name: "Verse2", material: "V", role: "verse", phrases: 2, level: "mp", vary: true },
    { name: "Chorus2", material: "C", role: "chorus", phrases: 2, level: "ff", vary: true },
    { name: "Outro", material: "I", role: "outro", phrases: 1, level: "pp", outro: true },
  ],
  rondo: [
    { name: "A1", material: "A", role: "theme", phrases: 2, level: "mp" },
    { name: "B", material: "B", role: "contrast", phrases: 1, contrast: true, level: "p" },
    { name: "A2", material: "A", role: "theme", phrases: 2, level: "mf", vary: true },
    { name: "C", material: "C", role: "contrast", phrases: 1, contrast: true, level: "ff" },
    { name: "A3", material: "A", role: "theme", phrases: 2, level: "f", vary: true },
  ],
  binary: [
    { name: "A", material: "A", role: "theme", phrases: 2, level: "p" },
    { name: "B", material: "B", role: "contrast", phrases: 2, contrast: true, level: "ff" },
  ],
  through: [
    { name: "Intro", material: "I", role: "intro", phrases: 1, level: "pp" },
    { name: "A", material: "A", role: "theme", phrases: 2, level: "p" },
    { name: "B", material: "B", role: "contrast", phrases: 2, contrast: true, level: "mp" },
    { name: "C", material: "C", role: "bridge", phrases: 2, level: "ff" },
    { name: "D", material: "A", role: "theme", phrases: 1, level: "mp", vary: true },
    { name: "Outro", material: "I", role: "outro", phrases: 1, level: "pp", outro: true },
  ],
  loop: [
    { name: "A", material: "A", role: "theme", phrases: 1, level: "p" },
    { name: "B", material: "B", role: "contrast", phrases: 1, contrast: true, level: "ff" },
  ],
  arch: [
    { name: "A", material: "A", role: "theme", phrases: 1, level: "pp" },
    { name: "B", material: "B", role: "contrast", phrases: 1, contrast: true, level: "p" },
    { name: "C", material: "C", role: "bridge", phrases: 2, level: "ff" },
    { name: "B2", material: "B", role: "contrast", phrases: 1, contrast: true, level: "p", vary: true },
    { name: "A2", material: "A", role: "theme", phrases: 1, level: "pp", vary: true },
  ],
};

/** Development of the motif in the bars of a phrase, by material. The last bar of a phrase is always the cadence. */
export const DEVELOPMENT_PLANS: Record<string, readonly Development[]> = {
  A: ["state", "sequence", "fragment"],
  B: ["invert", "sequence", "augment"],
  C: ["fragment", "state", "invert"],
  V: ["state", "transpose", "fragment"],
  I: ["augment", "state", "augment"],
};

export function getProfile(name: string): ComposeProfile {
  const found = PROFILES.find((p) => p.name === name);
  if (!found) throw new Error(`unknown composer profile "${name}"; known profiles: ${PROFILES.map((p) => p.name).join(", ")}`);
  return found;
}
