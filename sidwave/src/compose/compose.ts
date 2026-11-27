// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { SidwaveValidationError, midiToNoteName, noteNameToMidi, parseSidwave, type SidwaveDocument, type SystemMode } from "../sidwave.js";
import { compileSidwaveToPrg, maxSidwaveMidi } from "../sidwaveCompiler.js";
import { cellPitches, composeCounterLine, composeMelody, fitLeadToBass, makeMotif, varyMelody, type Motif, type Note } from "./melody.js";
import {
  DEVELOPMENT_PLANS, FORMS, LAYOUTS, PALETTES, getProfile, type ComposeProfile, type FormSection, type Role,
} from "./profiles.js";
import { ARP_PATTERNS, BASS_PATTERNS, DRUM_FILLS, DRUM_PATTERNS, cellString } from "./rhythm.js";
import {
  MODE_GRAMMAR, pc, pick, progression, relatedKey, scalePcs, substream, triad, type Cadence, type Chord, type Key,
} from "./theory.js";
import { traceDocument, worstCycles } from "./trace.js";

/** Cycles per video frame of the CPU: 63 x 312 on PAL, 65 x 263 on NTSC. */
export const FRAME_CYCLES: Record<SystemMode, number> = { PAL: 19_656, NTSC: 17_095 };
/** Share of the player-call budget (a video frame divided by `speed`) that a composed plan may use unless the caller declares another. */
export const DEFAULT_BUDGET_SHARE = 0.8;

export interface ComposeOptions {
  profile: string | ComposeProfile;
  seed: number;
  system?: SystemMode;
  /** Tonic override as a note name such as "D3"; only its pitch class is used. */
  root?: string;
  /** Largest allowed cycles for one player call, measured on the bundled 6502 interpreter. */
  cycleBudget?: number;
  /**
   * Measure the cycles of the plan on the bundled 6502 interpreter (up to `measureFrames` player calls, default 3000)
   * instead of using the compiler's static upper bound. Without it the bound is used first and the interpreter only runs
   * when the bound exceeds the budget, because the measured value never exceeds the bound.
   */
  measure?: boolean;
  measureFrames?: number;
}

export interface PlannedSection {
  name: string;
  material: string;
  role: string;
  startBar: number;
  bars: number;
  key: string;
}

export interface ComposeResult {
  score: SidwaveDocument;
  key: string;
  progression: string[];
  tempo: number;
  bars: number;
  speed: number;
  leadTimeline: Array<{ t: number; note: string; durationMs: number }>;
  profile: ComposeProfile;
  sections: PlannedSection[];
  /** Voice id of each role in the score. */
  voices: Partial<Record<Role, number>>;
  /** Changes made to meet the cycle budget, in order. */
  repairs: string[];
  cycles: { worst: number; budget: number; met: boolean; frames: number; kind: "estimated" | "measured" };
  /** The motif of the piece as scale steps and durations in sixteenths. */
  motif: Motif;
}

interface Flags { vibrato: boolean; drop: Set<Role>; speed: number }

const LEVELS: Partial<Record<Role, number>> = { arp: 9, pad: 8, counter: 10 };
const ROLE_NAME: Record<Role, string> = { lead: "Lead", counter: "Counter line", arp: "Chord arpeggio", bass: "Bass", drums: "Percussion", pad: "Pad" };
const VOICE_ROLE: Partial<Record<Role, "bass" | "lead" | "drums" | "pad" | "arp">> = { bass: "bass", lead: "lead", drums: "drums", pad: "pad", arp: "arp" };

const name = (midi: number) => midiToNoteName(midi);

/** Tokens of one bar of a monophonic line on the sixteenth grid. */
function lineTokens(notes: readonly Note[], from: number, cells: number): string[] {
  const out: string[] = Array.from({ length: cells }, () => "-");
  for (const n of notes) {
    if (n.at < from || n.at >= from + cells) continue;
    const at = n.at - from;
    if (n.midi === null) continue;
    out[at] = name(n.midi);
    for (let i = 1; i < n.dur && at + i < cells; i++) out[at + i] = "~";
  }
  return out;
}

/** Slurs each run of two or more notes in a bar so that only the first attacks with a hard restart. */
function slur(tokens: string[]): string[] {
  const out = [...tokens];
  let i = 0;
  while (i < out.length) {
    if (out[i] === "-" || out[i] === "~") { i++; continue; }
    let end = i;
    let notes = 1;
    while (end + 1 < out.length && out[end + 1] !== "-") {
      end++;
      if (out[end] !== "~") notes++;
    }
    if (notes >= 2) { out[i] = `(${out[i]}`; out[end] = `${out[end]})`; }
    i = end + 1;
  }
  return out;
}

function bassMidi(pcValue: number, offset = 0): number { return 36 + pcValue + offset; }

function bassBar(pattern: string, chords: readonly Chord[], cells: number, nextRoot: number | undefined, key: Key, approach: boolean,
  clashes: (cell: number, midi: number) => boolean): string[] {
  const slotCells = cells / chords.length;
  const scale = new Set(scalePcs(key));
  const chars = cellString(pattern, cells).split("");
  if (approach && nextRoot !== undefined && chars[Math.max(0, cells - 4)] !== "." && !pattern.startsWith("r~~~~~~~")) {
    chars[cells - 4] = "n";
    for (let i = cells - 3; i < cells; i++) chars[i] = "~";
  }
  const out: string[] = [];
  chars.forEach((c, i) => {
    const chord = chords[Math.min(chords.length - 1, Math.floor(i / slotCells))]!;
    let midi: number | undefined;
    switch (c) {
      case "r": midi = bassMidi(chord.root); break;
      case "R": midi = bassMidi(chord.root, 12); break;
      case "f": midi = bassMidi(chord.root, 7); break;
      case "t": midi = bassMidi(chord.root, chord.minor ? 3 : 4); break;
      case "n": {
        const target = bassMidi(nextRoot!);
        midi = scale.has(pc(target - 1)) ? target - 1 : target - 2;
        break;
      }
      case "~": out.push(out.length > 0 && out[out.length - 1] !== "-" ? "~" : "-"); return;
      default: out.push("-"); return;
    }
    // A bass note on a beat must not sit a minor second or ninth from a sounding lead, counter or arpeggio note.
    if (i % 4 === 0 && clashes(i, midi)) {
      const alternatives = [bassMidi(chord.root), bassMidi(chord.root, 12), bassMidi(chord.root, 7), bassMidi(chord.root, 19)];
      midi = alternatives.find((m) => !clashes(i, m));
    }
    out.push(midi === undefined ? "-" : name(midi));
  });
  return out;
}

/** The MIDI note sounding at an absolute cell in a bar-by-bar token list, or undefined for a rest. */
function soundingFromTokens(bars: readonly string[][], cell: number): number | undefined {
  const cells = bars[0]!.length;
  let bar = Math.floor(cell / cells);
  let i = cell % cells;
  for (;;) {
    const token = bars[bar]?.[i];
    if (token === undefined) return undefined;
    if (token === "-") return undefined;
    if (token !== "~") return noteNameToMidi(token.replace(/[()]/g, "").split("@")[0]!);
    i--;
    if (i < 0) { bar--; i = cells - 1; }
    if (bar < 0) return undefined;
  }
}

function arpBar(pattern: string, chords: readonly Chord[], cells: number): string[] {
  const slotCells = cells / chords.length;
  const out: string[] = [];
  cellString(pattern, cells).split("").forEach((c, i) => {
    const chord = chords[Math.min(chords.length - 1, Math.floor(i / slotCells))]!;
    if (c === "x") out.push(`${name(48 + chord.root)}@lib:chip_arp_${chord.minor ? "minor" : "major"}`);
    else if (c === "~") out.push(out.length > 0 && out[out.length - 1] !== "-" ? "~" : "-");
    else out.push("-");
  });
  return out;
}

function padBar(chords: readonly Chord[], cells: number): string[] {
  const slotCells = cells / chords.length;
  const out: string[] = [];
  for (let i = 0; i < cells; i++) {
    const chord = chords[Math.min(chords.length - 1, Math.floor(i / slotCells))]!;
    out.push(i % slotCells === 0 ? name(48 + chord.pcs[1]) : "~");
  }
  return out;
}

interface MaterialPlan { key: Key; chords: Chord[]; lead?: Note[] }

export function composeSidwave(options: ComposeOptions): ComposeResult {
  const profile = typeof options.profile === "string" ? getProfile(options.profile) : options.profile;
  const system: SystemMode = options.system ?? "PAL";
  const requested = options.cycleBudget;
  const repairs: string[] = [];
  const flags: Flags = { vibrato: true, drop: new Set(), speed: profile.speed };
  const steps: Array<[string, () => boolean]> = [
    ["lead vibrato removed", () => { const had = flags.vibrato; flags.vibrato = false; return had; }],
    ...(["pad", "counter", "arp", "drums"] as Role[]).map((role): [string, () => boolean] => [`${role} voice dropped`, () => {
      if (!(role in LAYOUTS[profile.layout].voices) || flags.drop.has(role)) return false;
      flags.drop.add(role);
      return true;
    }]),
    ["speed lowered by one", () => { if (flags.speed <= 1) return false; flags.speed -= 1; return true; }],
  ];
  for (;;) {
    const built = buildScore(profile, options, system, flags);
    const budget = requested ?? Math.floor((FRAME_CYCLES[system] / flags.speed) * DEFAULT_BUDGET_SHARE);
    const parsed = parseSidwave(built.score);
    let worst: number;
    let frames = 0;
    let kind: "estimated" | "measured" = "estimated";
    let estimate: number;
    try {
      estimate = compileSidwaveToPrg(parsed).worstCaseCyclesPerCall;
    } catch (error) {
      // The compiler refuses a plan above the player's own budget; treat that as over budget and repair.
      if (!(error instanceof SidwaveValidationError)) throw error;
      estimate = Infinity;
    }
    worst = estimate;
    if (options.measure || estimate > budget) {
      if (estimate !== Infinity || options.measure) {
        const trace = traceDocument(parsed, { calls: Math.min(options.measureFrames ?? 3000, 3000) });
        worst = worstCycles(trace);
        frames = trace.calls.length;
        kind = "measured";
      }
    }
    if (worst <= budget) return { ...built, profile, repairs, cycles: { worst, budget, met: true, frames, kind } };
    let applied = false;
    while (steps.length > 0 && !applied) {
      const [label, run] = steps.shift()!;
      if (run()) { repairs.push(label); applied = true; }
    }
    if (!applied) return { ...built, profile, repairs, cycles: { worst, budget, met: false, frames, kind } };
  }
}

type Built = Omit<ComposeResult, "profile" | "repairs" | "cycles">;

function buildScore(profile: ComposeProfile, options: ComposeOptions, system: SystemMode, flags: Flags): Built {
  const { seed } = options;
  const tonic = options.root ? pc(rootPc(options.root)) : profile.tonic;
  const home: Key = { tonic, mode: profile.mode };
  const beats = profile.meter;
  const barCells = beats * 4;
  const hr = profile.harmonicRhythm;
  const phraseBars = profile.phraseBars;
  const layout = LAYOUTS[profile.layout];
  const palette = PALETTES[profile.palette];
  const roles = (Object.keys(layout.voices) as Role[]).filter((r) => !flags.drop.has(r));
  const has = (r: Role) => roles.includes(r);
  const motif = makeMotif(substream(seed, "motif"), profile.leaps);
  const maxMidi = maxSidwaveMidi(system);

  const sections = FORMS[profile.form].filter((s) => !(s.outro && profile.ending === "loop"));
  const lengths = sections.map((s) => s.phrases * phraseBars);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  const materials = new Map<string, MaterialPlan>();
  const patterns = new Map<Role, Map<string, string>>();
  const defs = new Map<Role, Record<string, unknown>>();
  const layersFor: Array<Record<string, string>> = sections.map(() => ({}));
  const leadTimeline: Array<{ t: number; note: string; durationMs: number }> = [];
  const msPerCell = 60_000 / profile.tempo / 4;
  const range: [number, number] = [profile.register, profile.register + 19];
  const planned: PlannedSection[] = [];
  let carry: { u: number; l: number } | undefined;
  const keyName = (k: Key) => `${midiToNoteName(12 + k.tonic).slice(0, -1)} ${k.mode}`;

  const addPattern = (role: Role, sectionIndex: number, text: string, extra: Record<string, unknown>) => {
    const byText = patterns.get(role) ?? new Map<string, string>();
    patterns.set(role, byText);
    const key = JSON.stringify([text, extra]);
    let patternName = byText.get(key);
    if (!patternName) {
      patternName = `${role}${byText.size + 1}`;
      byText.set(key, patternName);
      const bars = lengths[sectionIndex]!;
      const patternsOf = (defs.get(role) ?? {}) as Record<string, unknown>;
      defs.set(role, patternsOf);
      patternsOf[patternName] = role === "drums"
        ? { length: 0.25, bars, drums: { kit: { k: "lib:kick", s: "lib:snare", h: "lib:hat" }, steps: text }, ...extra }
        : { length: 0.25, bars, groove: text, ...extra };
    }
    layersFor[sectionIndex]![`v${layout.voices[role]}`] = patternName;
  };
  const barsText = (bars: string[][]) => bars.map((bar) => bar.join(" ")).join(" | ");

  sections.forEach((section, si) => {
    const bars = lengths[si]!;
    const contrasting = section.contrast === true && profile.contrast !== "home";
    const key = contrasting ? relatedKey(home, profile.contrast) : home;
    const finalSection = si === sections.length - 1;
    const cacheKey = `${section.material}:${section.phrases}:${contrasting}`;
    let material = materials.get(cacheKey);
    const harmony = substream(seed, `harmony:${cacheKey}`);
    if (!material) {
      const chords: Chord[] = [];
      for (let p = 0; p < section.phrases; p++) {
        const lastPhrase = p === section.phrases - 1;
        const cadence: Cadence = !lastPhrase ? "half" : contrasting ? "half" : section.role === "intro" ? "half" : "authentic";
        chords.push(...progression(harmony, key, phraseBars * hr, cadence));
      }
      // A modulated section returns home through the home dominant.
      if (contrasting) chords[chords.length - 1] = triad(home, MODE_GRAMMAR[home.mode].D[0]!, "D");
      material = { key, chords };
      materials.set(cacheKey, material);
    }
    const chordsAt = (bar: number) => material!.chords.slice(bar * hr, bar * hr + hr);
    const lead = section.role === "intro" || section.role === "outro" ? undefined : (() => {
      if (!material!.lead) {
        const shift = section.role === "chorus" || section.role === "bridge" ? 2 : 0;
        const cadences: Cadence[] = Array.from({ length: section.phrases }, (_, p) =>
          p < section.phrases - 1 || contrasting ? "half" : "authentic");
        material!.lead = composeMelody({
          random: substream(seed, `melody:${cacheKey}`), key, chords: material!.chords, slotsPerBar: hr, bars, barCells, phraseBars,
          groove: profile.groove, syncopation: profile.syncopation, density: profile.density, motif,
          plan: DEVELOPMENT_PLANS[section.material] ?? DEVELOPMENT_PLANS.A!, cadences,
          range: [range[0] + shift, range[1] + shift], leaps: profile.leaps, sequenceStep: section.material === "B" ? 1 : -1,
        }).notes;
      }
      const base = material!.lead;
      return section.vary ? varyMelody(substream(seed, `vary:${section.name}`), base, key, range, 0.8) : base;
    })();

    // The lead is composed first. The bass is built against it, then the lead's strong-beat notes are fitted to the bass,
    // then the counter line is composed against the fitted lead and the bass is built once more to avoid the counter line.
    const leadNotes = lead?.map((n) => ({ ...n }));
    const bassRandom = substream(seed, `bass:${section.name}`);
    const bassPattern = pick(bassRandom, BASS_PATTERNS[profile.bass]!);
    const firstRoot = material.chords[0]!.root;
    let leadCells = leadNotes ? cellPitches(leadNotes, bars * barCells) : undefined;
    let counterCells: Int16Array | undefined;
    const makeBass = (): string[][] => Array.from({ length: bars }, (_, b) => {
      const here = chordsAt(b);
      const next = chordsAt(b + 1)[0];
      const last = b === bars - 1;
      const nextRoot = next?.root ?? (finalSection && profile.ending === "end" ? undefined : firstRoot);
      const clashes = (cell: number, midi: number) => {
        const at = b * barCells + cell;
        const near = (m: number) => m >= 0 && (Math.abs(m - midi) === 1 || Math.abs(m - midi) === 13);
        return near(leadCells?.[at] ?? -1) || near(counterCells?.[at] ?? -1)
          || (has("arp") && near(48 + here[Math.min(hr - 1, Math.floor(cell / (barCells / hr)))]!.root));
      };
      return bassBar(bassPattern, here, barCells, nextRoot, material!.key, section.role !== "outro" && nextRoot !== undefined && (b % phraseBars === phraseBars - 1 || last), clashes);
    });
    let bassTokens = has("bass") ? makeBass() : undefined;
    if (leadNotes && bassTokens) {
      const tokens = bassTokens;
      const fitted = fitLeadToBass(leadNotes, (cell) => soundingFromTokens(tokens, cell), (cell) => chordsAt(Math.floor(cell / barCells))[Math.min(hr - 1, Math.floor((cell % barCells) / (barCells / hr)))]!,
        barCells === 12 ? 12 : 8, bars * barCells, [range[0] - 2, range[1] + 4], carry);
      carry = fitted.last;
      leadCells = cellPitches(leadNotes, bars * barCells);
    }
    let counterLine: Note[] | undefined;
    if (has("counter") && leadNotes) {
      counterLine = composeCounterLine({
        random: substream(seed, `counter:${section.name}`), lead: leadNotes, chords: material.chords, slotsPerBar: hr, barCells, bars,
        range: [range[0] - 14, range[1] - 3],
      });
      if (bassTokens) { counterCells = cellPitches(counterLine, bars * barCells); bassTokens = makeBass(); }
    }
    if (has("lead")) {
      if (leadNotes) {
        const tokens = Array.from({ length: bars }, (_, b) => slur(lineTokens(leadNotes, b * barCells, barCells)));
        const high = leadNotes.every((n) => n.midi === null || n.midi < maxMidi - 1);
        addPattern("lead", si, barsText(tokens), flags.vibrato && high ? { fx: { vibrato: { depth: 0.2, rate: 5, delay: 6 } } } : {});
        for (const n of leadNotes) if (n.midi !== null) leadTimeline.push({ t: (starts[si]! * barCells + n.at) * msPerCell, note: name(n.midi), durationMs: n.dur * msPerCell });
      } else addPattern("lead", si, barsText(Array.from({ length: bars }, () => Array.from({ length: barCells }, () => "-"))), {});
    }
    // Quiet sections are thinned: the counter line and the pad rest, so the dynamics do not rest on the level alone.
    const thin = section.level === "pp" || section.level === "p";
    if (has("counter")) {
      addPattern("counter", si, barsText(Array.from({ length: bars }, (_, b) => counterLine && !thin ? lineTokens(counterLine, b * barCells, barCells) : Array.from({ length: barCells }, () => "-"))), {});
    }
    if (bassTokens) addPattern("bass", si, barsText(bassTokens), {});
    // Arpeggio and pad.
    if (has("arp")) {
      const arpPattern = pick(substream(seed, `arp:${section.name}`), ARP_PATTERNS[profile.arp]!);
      addPattern("arp", si, barsText(Array.from({ length: bars }, (_, b) => arpBar(arpPattern, chordsAt(b), barCells))), {});
    }
    if (has("pad")) addPattern("pad", si, barsText(Array.from({ length: bars }, (_, b) => thin ? Array.from({ length: barCells }, () => "-") : padBar(chordsAt(b), barCells))), {});
    // Percussion: hats only in the intro, silence in the outro, a fill at the end of the section.
    if (has("drums")) {
      const drumRandom = substream(seed, `drums:${section.name}`);
      const base = cellString(pick(drumRandom, DRUM_PATTERNS[profile.drums]!), barCells);
      const text = Array.from({ length: bars }, (_, b) => {
        let bar = base;
        if (b === bars - 1 && section.role !== "outro" && profile.drums !== "sparse" && !(finalSection && profile.ending === "end")) {
          bar = cellString(pick(drumRandom, DRUM_FILLS), barCells);
        }
        if (section.role === "intro") bar = bar.replace(/[ks]/g, ".");
        if (section.role === "outro") bar = ".".repeat(barCells);
        return bar;
      }).join("");
      addPattern("drums", si, text, {});
    }
    planned.push({ name: section.name, material: section.material, role: section.role, startBar: starts[si]!, bars, key: keyName(material.key) });
  });

  const voices = roles.map((role) => ({
    id: layout.voices[role]!,
    name: ROLE_NAME[role],
    ...(VOICE_ROLE[role] ? { role: VOICE_ROLE[role] } : {}),
    ...(role === "lead" || role === "counter" || role === "bass" || role === "pad" ? { instrument: palette[role] } : {}),
    ...(LEVELS[role] !== undefined ? { level: LEVELS[role] } : {}),
    patterns: defs.get(role) ?? {},
  }));
  const firstTheme = sections.findIndex((s) => s.role !== "intro");
  const totalBars = lengths.reduce((a, b) => a + b, 0);
  const score: SidwaveDocument = {
    sidwave: "1.2",
    title: `Composer 2 | ${profile.name} | ${seed.toString(16).toUpperCase()}`,
    author: "SIDWave composer 2",
    tempo: profile.tempo, mode: system, speed: flags.speed,
    ...(beats === 3 ? { meter: 3 } : {}),
    ...(layout.sids === 2 ? { sids: [{ id: "sid1", address: "$D400" }, { id: "sid2", address: "$D420" }] } : {}),
    voices: voices as unknown as SidwaveDocument["voices"],
    timeline: sections.map((section, i) => ({
      section: section.name, bars: lengths[i]!, level: section.level as unknown as number, layers: layersFor[i]!,
    })) as SidwaveDocument["timeline"],
    ...(profile.ending === "end" ? { end: { hold_beats: 2, release: true } } : firstTheme > 0 ? { loop_to: sections[firstTheme]!.name } : {}),
  } as SidwaveDocument;
  const first = materials.get([...materials.keys()][0]!)!;
  return {
    score, key: keyName(home), progression: [...new Set(first.chords.map((c) => c.name))], tempo: profile.tempo, bars: totalBars, speed: flags.speed,
    leadTimeline, sections: planned, voices: Object.fromEntries(roles.map((r) => [r, layout.voices[r]!])) as Partial<Record<Role, number>>, motif,
  };
}

function rootPc(root: string): number {
  const m = /^([A-Ga-g])([#b]?)/.exec(root.trim());
  if (!m) throw new Error(`invalid root note "${root}"`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return base[m[1]!.toUpperCase()]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

export type { FormSection };
