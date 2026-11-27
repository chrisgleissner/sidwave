// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// MOD import: a ProTracker-family module becomes a SIDWave 1.3 score plus a report. See doc/interchange.md for the mapping.

import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";
import { IMPORT_DRUMS } from "./gm.js";
import { GridScoreError, buildGridScore, type GridBar, type GridCell, type GridVoice } from "./gridScore.js";
import { ModError, parseMod, MOD_ROWS, type ModSong } from "./mod.js";
import { collectNotes, EFFECT_NAMES, playRows, type EffectTally, type ModNote, type PlaySequence } from "./modPlay.js";
import { measureModQuality } from "./modQuality.js";
import { analyzeSample, type SampleAnalysis } from "./modSamples.js";

export interface ModImportOptions {
  title?: string;
  mode?: "PAL" | "NTSC";
  validate?: boolean;
  /** Number of SIDs (3 voices each) to spread the channels over, 1 to 10. Default 1. */
  sids?: number;
  /** Semitones added to every note before it is moved into the playable range. Default 0. */
  transpose?: number;
  /** Longest import in played rows. Default 100,000. */
  maxRows?: number;
  /** Add `report.quality`: the notes of the MOD against the notes of the imported score. Costs one parse of the result. */
  quality?: boolean;
}

export interface ModImportReport {
  format: "mod";
  variant: string;
  title: string;
  channels: number;
  samples: number;
  patterns: number;
  songLength: number;
  rows: number;
  seconds: number;
  loop: { end: "loop" | "end" | "stop"; toRow: number; jumps: number; patternLoops: number; patternDelays: number };
  timing: { rowsPerBeat: number; bars: number; speedRange: [number, number]; bpmRange: [number, number]; mistimedRows: number; clampedBars: number; alignedChanges: number };
  voicePolicy: { sids: number; capacity: number; ranking: Array<{ unit: string; score: number; kept: boolean }> };
  voices: Array<{ id: number; sid: number; name: string; kind: "melodic" | "drums"; channels: number[]; notes: number; octaveShifted: number; drumCollisions: number }>;
  channelStats: Array<{ channel: number; notes: number; drumNotes: number; lowest?: number; highest?: number; kept: boolean; voice?: number }>;
  droppedNotes: Record<string, number>;
  instruments: Array<{ sample: number; name: string; sidwave: string; waveform: string; adsr: [number, number, number, number]; drum?: string; notes: number; variants: string[] }>;
  effects: Record<string, { uses: number; mapped: number }>;
  losses: string[];
  warnings: string[];
  quality?: unknown;
}
export interface ModImportResult { yaml: string; report: ModImportReport; song: ModSong; sequence: PlaySequence; notes: Map<number, ModNote[]>; kept: Array<{ channels: number[]; kind: "melodic" | "drums" }> }

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 14);
const hex = (n: number): string => n.toString(16);
const GM_NAMES: Record<number, string> = { 36: "kick", 38: "snare", 39: "clap", 42: "hat", 45: "tom", 46: "open_hat", 49: "crash" };
const drumInfo = (gm: number): { lib: string; letter: string; priority: number } => IMPORT_DRUMS[gm] ?? IMPORT_DRUMS[38]!;
const sidAddress = (i: number): string => `$D${(4 + (i >> 3)).toString(16).toUpperCase()}${((i & 7) * 2).toString(16).toUpperCase()}0`;

interface Unit { name: string; channels: number[]; drums: boolean; notes: ModNote[]; score: number }

/** The bar plan: bars of 2 to 5 beats that end where the row length changes when it can, otherwise 4 beats. */
export function planBars(rowSeconds: number[], rpb: number): { bars: Array<{ start: number; rows: number; beats: number; seconds: number }>; mistimed: number; aligned: number } {
  const bars: Array<{ start: number; rows: number; beats: number; seconds: number }> = [];
  const R = rowSeconds.length;
  const prefix = new Float64Array(R + 1);
  for (let i = 0; i < R; i++) prefix[i + 1] = prefix[i]! + rowSeconds[i]!;
  let aligned = 0, mistimed = 0;
  let pos = 0;
  while (pos < R) {
    const d = rowSeconds[pos]!;
    let change = pos + 1;
    while (change < R && Math.abs(rowSeconds[change]! - d) <= d * 1e-4) change++;
    let beats = 4;
    const rest = R - pos;
    if (change < R && change - pos < 4 * rpb) {
      const span = change - pos;
      if (span % rpb === 0 && span / rpb >= 2) { beats = span / rpb; aligned++; }
    } else if (change >= R && rest <= 5 * rpb) beats = Math.max(2, Math.ceil(rest / rpb));
    const rows = Math.min(beats * rpb, R - pos);
    // A last bar that is not full is padded with rests at the mean row length.
    const real = prefix[pos + rows]! - prefix[pos]!;
    const seconds = real * beats * rpb / rows;
    const mean = real / rows;
    for (let i = pos; i < pos + rows; i++) if (Math.abs(rowSeconds[i]! - mean) > mean * 0.01) mistimed++;
    bars.push({ start: pos, rows: beats * rpb, beats, seconds });
    pos += rows;
  }
  return { bars, mistimed, aligned };
}

function chooseRowsPerBeat(rowSeconds: number[]): number {
  let best = 4, bestClamped = Infinity;
  for (const rpb of [4, 8, 2, 16, 1]) {
    const plan = planBars(rowSeconds, rpb);
    let clamped = 0;
    for (const bar of plan.bars) { const t = 60 * bar.beats / bar.seconds; if (t < 30 || t > 220) clamped++; }
    if (clamped < bestClamped) { bestClamped = clamped; best = rpb; }
    if (clamped === 0) break;
  }
  return best;
}

/** Imports a MOD file as SIDWave text. See doc/interchange.md for the mapping and the losses. */
export function importMod(bytes: Uint8Array, options: ModImportOptions = {}): ModImportResult {
  const song = parseMod(bytes);
  const mode = options.mode ?? "PAL";
  const fps = sidwaveFrameRate(mode);
  const maxMidi = maxSidwaveMidi(mode);
  const sidCount = options.sids ?? 1;
  if (!Number.isInteger(sidCount) || sidCount < 1 || sidCount > 10) throw new RangeError("sids must be an integer from 1 to 10");
  const transpose = options.transpose ?? 0;
  if (!Number.isInteger(transpose) || transpose < -48 || transpose > 48) throw new RangeError("transpose must be an integer from -48 to 48");
  const capacity = sidCount * 3;
  const warnings = [...song.warnings];
  const losses: string[] = [];
  const seq = playRows(song, options.maxRows ?? 100_000);
  const totalRows = seq.rows.length;
  const tallies = Array.from({ length: song.channels }, () => new Map<string, EffectTally>());
  const perChannel = collectNotes(song, seq, tallies);
  const notesBy = new Map<number, ModNote[]>(perChannel.map((c) => [c.channel, c.notes]));

  // Sample analysis, once per sample that a note uses.
  const analysis = new Map<number, SampleAnalysis>();
  const sampleUses = new Map<number, number>();
  for (const c of perChannel) for (const n of c.notes) sampleUses.set(n.sample, (sampleUses.get(n.sample) ?? 0) + 1);
  for (const s of sampleUses.keys()) analysis.set(s, analyzeSample(song.samples[s - 1]!));
  const isDrum = (n: ModNote): boolean => analysis.get(n.sample)?.drum !== undefined;

  // Voice reduction. A channel is a drum channel when at least 60 % of its notes are percussion samples.
  const channelStats: ModImportReport["channelStats"] = [];
  const melodic: Unit[] = [];
  const drumChannels: Unit[] = [];
  for (const { channel, notes } of perChannel) {
    const hits = notes.filter(isDrum).length;
    const pitched = notes.filter((n) => !isDrum(n));
    let lo = Infinity, hi = -Infinity;
    for (const n of pitched) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    const range = pitched.length ? hi - lo : 0;
    const drum = notes.length > 0 && hits >= 0.6 * notes.length;
    channelStats.push({ channel: channel + 1, notes: notes.length, drumNotes: hits, ...(pitched.length ? { lowest: lo + transpose, highest: hi + transpose } : {}), kept: false });
    if (notes.length === 0) continue;
    const unit: Unit = { name: `Channel ${channel + 1}`, channels: [channel], drums: drum, notes, score: drum ? notes.length * 1.25 : notes.length * (1 + range / 24) };
    (drum ? drumChannels : melodic).push(unit);
  }
  let units: Unit[] = [...melodic, ...drumChannels];
  if (units.length > capacity && drumChannels.length > 1) {
    const merged: Unit = {
      name: `Drums (channels ${drumChannels.map((u) => u.channels[0]! + 1).join(", ")})`, channels: drumChannels.map((u) => u.channels[0]!), drums: true,
      notes: drumChannels.flatMap((u) => u.notes).sort((a, b) => a.startTime - b.startTime), score: drumChannels.reduce((t, u) => t + u.score, 0),
    };
    units = [...melodic, merged];
  }
  const ranked = [...units].sort((a, b) => b.score - a.score || a.channels[0]! - b.channels[0]!);
  const keptSet = new Set<Unit>();
  const drumUnit = ranked.find((u) => u.drums && u.notes.length >= 4);
  if (units.length <= capacity) for (const u of units) keptSet.add(u);
  else {
    if (drumUnit) keptSet.add(drumUnit);
    for (const u of ranked) if (keptSet.size < capacity) keptSet.add(u);
  }
  const kept = units.filter((u) => keptSet.has(u)).sort((a, b) => Number(a.drums) - Number(b.drums) || a.channels[0]! - b.channels[0]!);
  const dropped: Record<string, number> = {};
  for (const u of units) if (!keptSet.has(u)) for (const c of u.channels) dropped[String(c + 1)] = notesBy.get(c)!.length;
  if (kept.length === 0) throw new ModError("the song has no notes");
  if (Object.keys(dropped).length) losses.push(`Channels ${Object.keys(dropped).join(", ")} are not imported because the score has ${capacity} voice${capacity === 1 ? "" : "s"} (${Object.entries(dropped).map(([c, n]) => `channel ${c}: ${n} notes`).join(", ")}); use --sids to keep more channels.`);
  const voiceOf = new Map<number, number>();
  kept.forEach((u, i) => { for (const c of u.channels) voiceOf.set(c, i + 1); });
  for (const stat of channelStats) { const v = voiceOf.get(stat.channel - 1); if (v) { stat.kept = true; stat.voice = v; } }

  // Timing. Every played row is one grid cell; bars take their tempo from the real length of their rows.
  const rowSeconds = seq.rows.map((r) => r.seconds);
  const rpb = chooseRowsPerBeat(rowSeconds);
  const plan = planBars(rowSeconds, rpb);
  if (plan.bars.length > 2048) throw new ModError(`the song has ${plan.bars.length} bars; the limit is 2048`);
  const bars: GridBar[] = [];
  let clampedBars = 0;
  for (const bar of plan.bars) {
    const raw = 60 * bar.beats / bar.seconds;
    const bpm = Math.round(Math.max(30, Math.min(220, raw)) * 10000) / 10000;
    if (bpm !== Math.round(raw * 10000) / 10000) clampedBars++;
    bars.push({ cells: bar.rows, sig: `${bar.beats}/4`, tempo: bpm });
  }
  const totalCells = bars.reduce((t, b) => t + b.cells, 0);
  if (plan.mistimed) losses.push(`${plan.mistimed} row(s) have a different length from the rest of their bar (a speed or tempo change inside a bar, or a pattern delay); the bar plays them with its mean row length, so notes inside that bar move by up to one row. Bar lengths stay exact.`);
  if (clampedBars) losses.push(`${clampedBars} bar(s) have a row length outside the SIDWave tempo range of 30 to 220 BPM and are clamped, so the song drifts there.`);
  if (seq.end === "loop" && seq.loopTo !== 0) losses.push(`The song loops back to row ${seq.loopTo} (order ${seq.rows[seq.loopTo]!.order}); SIDWave loops the whole timeline, so the part before the loop point plays again on each pass.`);
  if (seq.end === "stop") warnings.push("The song ends with F00 (stop).");
  if (seq.end === "end") warnings.push("The song ends at the end of the order list without a jump back.");

  // Cell helpers.
  const rowStarts = seq.rows.map((r) => r.start);
  const rowIndexAt = (time: number): number => {
    let lo = 0, hi = totalRows - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rowStarts[mid]! <= time + 1e-9) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const used = new Map<string, { def: Record<string, unknown>; sample: number; base: string; arp?: [number, number, number] }>();
  const effectUse = { noteDelayRounded: 0, cutInsideRow: 0, bendNegligible: 0, bendClamped: 0, vibratoDropped: 0, arpOverBudget: 0 };

  const baseName = (sample: number): string => `s${String(sample).padStart(2, "0")}${slug(song.samples[sample - 1]!.name) ? `_${slug(song.samples[sample - 1]!.name)}` : ""}`;
  const baseDef = (a: SampleAnalysis): Record<string, unknown> => ({ waveform: a.waveform, adsr: a.adsr, ...(a.waveform === "pulse" && a.pulseWidth ? { pulse_width: a.pulseWidth } : {}) });
  const instrumentFor = (n: ModNote, arpOk: boolean): string => {
    const a = analysis.get(n.sample)!;
    const base = baseName(n.sample);
    if (!used.has(base)) used.set(base, { def: baseDef(a), sample: n.sample, base });
    if (arpOk && n.arpeggio) {
      const frames = Math.max(1, Math.min(255, Math.round(n.tickSec * fps)));
      const name = `${base}_a${hex(n.arpeggio.x)}${hex(n.arpeggio.y)}_${frames}`;
      if (!used.has(name)) {
        const offs = [0, n.arpeggio.x, n.arpeggio.y];
        used.set(name, { def: { ...baseDef(a), wavetable: offs.map((o) => ({ note: `+${o}`, frames })), loop: 0 }, sample: n.sample, base, arp: [n.arpeggio.x, n.arpeggio.y, frames] });
      }
      return name;
    }
    return base;
  };

  interface Features { vibrato: boolean; bend: boolean; portamento: boolean; arp: boolean }
  const buildVoices = (features: Features): { voices: GridVoice[]; stats: ModImportReport["voices"]; usedNotes: Map<string, number> } => {
    used.clear();
    const usedNotes = new Map<string, number>();
    const voices: GridVoice[] = [];
    const stats: ModImportReport["voices"] = [];
    const arpCap = 63 - 31;
    for (const [vi, unit] of kept.entries()) {
      const cells: GridCell[] = Array.from({ length: totalCells }, () => ({ kind: "rest" as const }));
      let shifted = 0, collisions = 0, count = 0;
      const sorted = unit.notes;
      for (const [k, n] of sorted.entries()) {
        const next = sorted[k + 1];
        const pr = seq.rows[n.row]!;
        let start = n.row;
        if (n.delayTicks > 0) { if (n.delayTicks * 2 >= pr.speed && start + 1 < totalRows) start++; effectUse.noteDelayRounded++; }
        const a = analysis.get(n.sample)!;
        const drumNote = a.drum !== undefined;
        if (unit.drums) {
          const info = drumInfo(drumNote ? a.drum! : 45);
          const existing = cells[start];
          if (existing && existing.kind === "note") {
            collisions++;
            const oldPriority = [...Object.values(IMPORT_DRUMS)].find((d) => d.letter === existing.drum)?.priority ?? 0;
            if (info.priority > oldPriority) cells[start] = { kind: "note", pitch: 48, drum: info.letter };
          } else { cells[start] = { kind: "note", pitch: 48, drum: info.letter }; count++; }
          continue;
        }
        // End of the note in cells. A note that ends inside a row occupies that row and closes its gate early (gate_off).
        let end: number;
        let gateOff: number | undefined;
        const endRow = n.endTime >= seq.seconds - 1e-9 ? totalRows : rowIndexAt(n.endTime);
        if (endRow >= totalRows) end = totalRows;
        else {
          const into = (n.endTime - rowStarts[endRow]!) / seq.rows[endRow]!.seconds;
          if (into < 1e-6) end = endRow;
          else {
            end = endRow + 1;
            const frames = Math.round((rowStarts[endRow]! + seq.rows[endRow]!.seconds - n.endTime) * fps);
            if (frames >= 1) { gateOff = Math.min(255, frames); effectUse.cutInsideRow++; }
          }
        }
        const nextStart = next ? next.row + (next.delayTicks * 2 >= seq.rows[next.row]!.speed ? 1 : 0) : totalRows;
        if (end > nextStart) { end = nextStart; gateOff = undefined; }
        if (end <= start) { end = start + 1; gateOff = undefined; }
        let pitch = n.midi + transpose;
        const original = pitch;
        while (pitch < 12) pitch += 12;
        while (pitch > maxMidi) pitch -= 12;
        if (pitch !== original) shifted++;
        const level = Math.max(1, Math.min(15, Math.round(15 * n.meanVolume / 64)));
        const arpOk = features.arp && !!n.arpeggio;
        let inst: string;
        if (drumNote) inst = `lib:${GM_NAMES[a.drum!] ?? drumInfo(a.drum!).lib}`;
        else {
          let wantArp = arpOk;
          if (wantArp) {
            const key = `${baseName(n.sample)}_a${hex(n.arpeggio!.x)}${hex(n.arpeggio!.y)}_${Math.max(1, Math.min(255, Math.round(n.tickSec * fps)))}`;
            if (!used.has(key) && [...used.values()].filter((u) => u.arp).length >= arpCap) { wantArp = false; effectUse.arpOverBudget++; }
          }
          inst = instrumentFor(n, wantArp);
        }
        usedNotes.set(inst, (usedNotes.get(inst) ?? 0) + 1);
        const cell: GridCell = { kind: "note", pitch, level, inst, ...(gateOff === undefined ? {} : { gateOff }) };
        if (n.glide && features.portamento && n.portamento) {
          const frames = Math.max(1, Math.min(255, Math.round(n.portamento.seconds * fps)));
          cell.legato = true; cell.portamento = frames;
        } else if (n.slide && features.bend && !drumNote && !(arpOk)) {
          const room = Math.max(12 - pitch, Math.min(maxMidi - pitch, n.slide.semitones));
          if (room !== n.slide.semitones) effectUse.bendClamped++;
          const durFrames = Math.max(1, Math.floor((n.endTime - n.startTime) * fps));
          if (room !== 0) cell.bend = { to: room, frames: Math.max(1, Math.min(255, durFrames, Math.round(n.slide.seconds * fps))) };
          else effectUse.bendNegligible++;
        }
        if (n.vibrato && features.vibrato && !drumNote && !arpOk && !n.glide) {
          const noteRows = Math.max(1, end - start);
          if (n.vibrato.rows >= Math.ceil(noteRows / 2)) {
            const rate = Math.max(0.2, Math.min(12, n.vibrato.speed / n.tickSec / 64));
            const d = 255 * n.vibrato.depth / 128;
            const p = n.vibrato.period;
            const depth = Math.round(Math.max(0.03, Math.min(6, 6 * Math.log2((p + d) / Math.max(1, p - d)))) * 100) / 100;
            const delay = Math.max(0, Math.min(255, Math.round((seq.rows[n.vibrato.firstRow]!.start - n.startTime) * fps)));
            cell.vibrato = { depth, rate: Math.round(rate * 100) / 100, ...(delay > 0 ? { delay } : {}) };
          } else effectUse.vibratoDropped++;
        }
        cells[start] = cell;
        count++;
        for (let r = start + 1; r < end && r < totalCells; r++) cells[r] = { kind: "tie" };
      }
      voices.push({ name: unit.name, ...(unit.drums ? { drum: true } : {}), cells });
      stats.push({ id: vi + 1, sid: Math.floor(vi / 3) + 1, name: unit.name, kind: unit.drums ? "drums" : "melodic", channels: unit.channels.map((c) => c + 1), notes: count, octaveShifted: shifted, drumCollisions: collisions });
    }
    return { voices, stats, usedNotes };
  };

  const title = options.title ?? (song.title || "Imported MOD");
  const sidsDecl = sidCount > 1 ? Array.from({ length: Math.ceil(kept.length / 3) }, (_, i) => ({ id: `sid${i + 1}`, address: sidAddress(i) })) : undefined;
  const header = [
    `Imported from a ${song.variant} module (${song.channels} channels) by SIDWave.`,
    `One grid cell is one pattern row (${rpb} rows per beat); see the import report for what was approximated or dropped.`,
  ];
  let features: Features = { vibrato: true, bend: true, portamento: true, arp: true };
  let built = buildVoices(features);
  let yamlText = "";
  const attemptOrder: Array<keyof Features> = ["vibrato", "bend", "portamento", "arp"];
  for (let attempt = 0; ; attempt++) {
    try {
      yamlText = buildGridScore({
        title, mode, grid: 1 / rpb, bars, voices: built.voices, instruments: Object.fromEntries([...used].map(([name, u]) => [name, u.def])),
        header, validate: options.validate !== false, ...(sidsDecl ? { sids: sidsDecl } : {}),
      });
      break;
    } catch (error) {
      if (!(error instanceof GridScoreError) || attempt >= attemptOrder.length) throw error;
      const dropped = attemptOrder[attempt]!;
      features = { ...features, [dropped]: false };
      losses.push(`SIDWave did not accept the ${dropped === "arp" ? "arpeggio instruments" : dropped === "portamento" ? "tone portamento" : dropped === "bend" ? "slides" : "vibrato"} on this score (${error.message}); they are not imported.`);
      built = buildVoices(features);
    }
  }

  // Effects of the kept channels.
  const keptChannels = new Set<number>(kept.flatMap((u) => u.channels));
  const effectTotals = new Map<string, EffectTally>();
  for (const c of keptChannels) for (const [k, v] of tallies[c]!) { const t = effectTotals.get(k) ?? { uses: 0, mapped: 0 }; t.uses += v.uses; t.mapped += v.mapped; effectTotals.set(k, t); }
  const effects: ModImportReport["effects"] = {};
  const APPROX = new Set(["0", "1", "2", "3", "4", "5", "6", "A", "C", "E1", "E2", "EA", "EB", "EC", "ED"]);
  for (const [key, t] of [...effectTotals].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = EFFECT_NAMES[key] ?? key;
    effects[name] = { uses: t.uses, mapped: t.mapped };
    if (t.mapped < t.uses) losses.push(`Effect ${name}: ${t.uses - t.mapped} of ${t.uses} use(s) are not imported.`);
    else if (APPROX.has(key)) losses.push(`Effect ${name}: ${t.uses} use(s) are imported approximately (see doc/interchange.md).`);
  }
  if (effectUse.noteDelayRounded) losses.push(`${effectUse.noteDelayRounded} delayed note(s) (EDx) start on the nearest row.`);
  if (effectUse.bendClamped) losses.push(`${effectUse.bendClamped} slide(s) would leave the playable range and are limited to it.`);
  if (effectUse.vibratoDropped) losses.push(`${effectUse.vibratoDropped} vibrato(s) cover less than half of their note and are not imported.`);
  if (effectUse.arpOverBudget) losses.push(`${effectUse.arpOverBudget} arpeggio note(s) use the plain instrument because SIDWave allows 63 instruments.`);
  const shiftedTotal = built.stats.reduce((t, v) => t + v.octaveShifted, 0);
  if (shiftedTotal) losses.push(`${shiftedTotal} notes are outside the SIDWave range and were moved by octaves.`);
  const collisionTotal = built.stats.reduce((t, v) => t + v.drumCollisions, 0);
  if (collisionTotal) losses.push(`${collisionTotal} drum hit(s) fell on the same row as a harder-priority hit of another channel in a merged drum voice and are dropped.`);
  losses.push("Sample waveforms are not reproduced: each sample becomes a SID waveform and ADSR chosen from its harmonics, loop and envelope (approximate). Panning, sample offsets, finetune changes, tremolo, retrigger and per-tick volume are not imported.");

  const instrumentReports: ModImportReport["instruments"] = [];
  for (const [sample, a] of [...analysis].sort((x, y) => x[0] - y[0])) {
    const base = baseName(sample);
    const variants = [...used].filter(([, u]) => u.arp && u.sample === sample).map(([name]) => name);
    const uses = [...built.usedNotes].filter(([name]) => name === base || variants.includes(name)).reduce((t, [, n]) => t + n, 0)
      + (a.drum !== undefined ? built.usedNotes.get(`lib:${GM_NAMES[a.drum] ?? drumInfo(a.drum).lib}`) ?? 0 : 0);
    instrumentReports.push({
      sample, name: song.samples[sample - 1]!.name, sidwave: a.drum !== undefined ? `lib:${GM_NAMES[a.drum] ?? drumInfo(a.drum).lib}` : base,
      waveform: a.drum !== undefined ? "drum" : a.waveform, adsr: a.adsr, ...(a.drum !== undefined ? { drum: `${GM_NAMES[a.drum] ?? "snare"} (${a.drumReason})` } : {}), notes: sampleUses.get(sample) ?? uses, variants,
    });
  }
  const speeds = seq.rows.map((r) => r.speed), bpms = seq.rows.map((r) => r.bpm);
  const report: ModImportReport = {
    format: "mod", variant: song.variant, title: song.title, channels: song.channels, samples: sampleUses.size, patterns: song.patterns.length,
    songLength: song.songLength, rows: totalRows, seconds: Math.round(seq.seconds * 1000) / 1000,
    loop: { end: seq.end, toRow: seq.loopTo, jumps: seq.jumps, patternLoops: seq.patternLoops, patternDelays: seq.patternDelays },
    timing: { rowsPerBeat: rpb, bars: bars.length, speedRange: [Math.min(...speeds), Math.max(...speeds)], bpmRange: [Math.min(...bpms), Math.max(...bpms)], mistimedRows: plan.mistimed, clampedBars, alignedChanges: plan.aligned },
    voicePolicy: { sids: sidCount, capacity, ranking: ranked.map((u) => ({ unit: u.name, score: Math.round(u.score * 10) / 10, kept: keptSet.has(u) })) },
    voices: built.stats, channelStats, droppedNotes: dropped, instruments: instrumentReports, effects, losses: [...new Set(losses)], warnings,
  };
  const result: ModImportResult = { yaml: yamlText, report, song, sequence: seq, notes: notesBy, kept: kept.map((u) => ({ channels: u.channels, kind: u.drums ? "drums" : "melodic" })) };
  if (options.quality) report.quality = measureModQuality(result, { transpose, mode });
  return result;
}

export { MOD_ROWS };
