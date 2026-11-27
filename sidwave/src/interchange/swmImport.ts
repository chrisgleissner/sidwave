// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SID-Wizard import: a `.swm` or `.sws` module (one subtune) or a `.swi` instrument becomes a SIDWave score.
// The module is played on paper: the orderlists, patterns and tempo programs are walked in player calls, so the
// notes land on the call at which the SID-Wizard player starts them. Mapping and losses: doc/interchange.md.

import yaml, { isMap, isScalar, isSeq } from "yaml";
import { SidwaveValidationError, midiToNoteName, parseSidwave } from "../sidwave.js";
import { compileSidwaveToPrg, maxSidwaveMidi } from "../sidwaveCompiler.js";
import { SwmError, instrumentTables, parseSwi, parseSwm, validateModule, SWM_NOTEFX, type SwmInstrument, type SwmModule, type SwmRow } from "./swm.js";

export interface SwmImportOptions {
  /** 1-based subtune. Default 1. */
  subtune?: number;
  title?: string;
  mode?: "PAL" | "NTSC";
  /** Longest song imported, in seconds. Default 600. */
  maxSeconds?: number;
  validate?: boolean;
}

export interface SwmImportReport {
  format: "swm" | "sws" | "swi";
  subtune: number;
  subtunes: number;
  speed: number;
  callsPerCell: number;
  cellBeats: number;
  tempo: number;
  seconds: number;
  truncated: boolean;
  tracks: Array<{ track: number; voice: number; notes: number; gateOffs: number; endedBy: "end" | "jump" | "limit"; jumpTo?: number }>;
  instruments: Array<{ number: number; name: string; id: string; approximated: string[] }>;
  quantisation: { events: number; moved: number };
  losses: string[];
  warnings: string[];
}

export interface SwmImportResult { yaml: string; report: SwmImportReport }

const WAVES: Array<[number, string]> = [[0x10, "tri"], [0x20, "saw"], [0x40, "pulse"]];
function waveName(w: number): string {
  if (w & 0x80) return "noise";
  const parts = WAVES.filter(([bit]) => w & bit).map(([, n]) => n);
  return parts.length ? parts.join("+") : "tri";
}
/** A 3 (low and band pass together) has no SIDWave name and is played as low pass. */
const FILTER_TYPES = ["", "lowpass", "bandpass", "lowpass", "highpass", "lowpass+highpass", "bandpass+highpass", "all"];
const signed = (v: number): number => (v > 127 ? v - 256 : v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const gcd = (a: number, b: number): number => { while (b) [a, b] = [b, a % b]; return a; };

/** Tempo programs of the table: runs of bytes that end at a byte with bit 7 set. Index 0 is program 1. */
function tempoPrograms(table: Uint8Array): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (const b of table) { cur.push(b); if (b & 0x80) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
}

interface Instr { id: string; yaml: Record<string, unknown>; octave: number; approximated: string[] }

/** Maps one SID-Wizard instrument to a SIDWave instrument; what does not map is listed in `approximated`. */
export function convertInstrument(ins: SwmInstrument, id: string, mode: "PAL" | "NTSC", degrade = 0): Instr {
  const d = ins.data;
  const approximated: string[] = [];
  const t = instrumentTables(d, `instrument ${id}`);
  const out: Record<string, unknown> = {};
  const first = t.wf.find((r) => r.a >= 0x10 && r.a <= 0xfd);
  const wave0 = first ? first.a : d[15]! & 0xf0 ? d[15]! : 0x41;
  out.waveform = waveName(wave0);
  out.adsr = [d[3]! >> 4, d[3]! & 15, d[4]! >> 4, d[4]! & 15];
  const callsPerRow = (d[7]! & 0x3f) + 1;
  // Waveform, arpeggio and detune table.
  const steps: Array<Record<string, unknown>> = [];
  let loop: number | undefined;
  const indexAt = new Map<number, number>();
  for (const [i, r] of t.wf.entries()) {
    indexAt.set(16 + i * 3, steps.length);
    if (r.a <= 0x0f) { const last = steps[steps.length - 1]; if (last) last.calls = (last.calls as number) + r.a * callsPerRow; continue; }
    if (r.a === 0xfe) { const target = indexAt.get(r.b); if (target !== undefined && r.b <= 0x40) loop = target; break; }
    const step: Record<string, unknown> = { wave: waveName(r.a), calls: callsPerRow };
    if (!(r.a & 1)) step.gate = false;
    if (r.a & 4) step.ring = true;
    if (r.a & 2) step.sync = true;
    if (r.a & 8) step.test = true;
    if (degrade >= 2 || r.b === 0x80) { /* keep the pitch */ } else if (r.b >= 0x81 && r.b <= 0xdf) step.note = midiToNoteName(r.b - 0x80 + 11);
    else if (degrade >= 1) { /* relative offsets dropped */ }
    else if (r.b >= 0xe0) step.note = `-${256 - r.b}`;
    else if (r.b <= 0x5f) step.note = `+${r.b}`;
    else approximated.push("a chord jump in the waveform table is played as no pitch change");
    if (r.c !== 0 && r.c !== 0xff) approximated.push("table detune column is not imported");
    steps.push(step);
  }
  if (degrade >= 3) steps.length = 0;
  if (steps.length > 1 || steps.some((s) => s.note !== undefined || s.ring || s.sync || s.test || s.gate === false)) {
    if (steps.length > 255) approximated.push("waveform table cut to 255 steps");
    out.wavetable = steps.slice(0, 255) as unknown[];
    if (loop !== undefined && loop < steps.length) out.loop = loop;
  }
  // Pulse table.
  const pw = t.pw;
  if (pw.length) {
    const pulse: Array<Record<string, unknown>> = [];
    let pwLoop: number | undefined;
    const at = new Map<number, number>();
    for (const [i, r] of pw.entries()) {
      at.set(d[10]! + i * 3, pulse.length);
      if (r.a & 0x80) pulse.push({ set: clamp(((r.a & 0x0f) << 8) | r.b, 1, 4094), frames: 1 });
      else if (r.a === 0xfe) { const target = at.get(r.b); if (target !== undefined) pwLoop = target; break; }
      else if (r.a >= 1 && r.a <= 0x7f && signed(r.b) !== 0) pulse.push({ add: signed(r.b), frames: r.a });
    }
    if (pulse.length) {
      const f = pulse[0]!;
      if (f.set !== undefined) out.pulse_width = f.set;
      out.pulsetable = { steps: pulse.slice(0, 255), ...(pwLoop !== undefined && pwLoop < pulse.length ? { loop: pwLoop } : {}) };
    }
    if (pw.some((r) => r.c !== 0)) approximated.push("pulse keyboard tracking is not imported");
  }
  // Filter table.
  const ft = t.filter;
  if (ft.length && ft[0]!.a !== 0) {
    const steps2: Array<Record<string, unknown>> = [];
    let fLoop: number | undefined;
    const at = new Map<number, number>();
    for (const [i, r] of ft.entries()) {
      at.set(d[11]! + i * 3, steps2.length);
      if (r.a & 0x80) { const type = FILTER_TYPES[(r.a >> 4) & 7]; steps2.push({ cutoff: clamp(r.b << 3, 0, 2047), resonance: r.a & 15, ...(type ? { type } : {}), frames: 1 }); }
      else if (r.a === 0xfe) { const target = at.get(r.b); if (target !== undefined) fLoop = target; break; }
      else if (r.a >= 1 && r.a <= 0x7f && signed(r.b) !== 0) steps2.push({ add: clamp(signed(r.b) * 8, -2048, 2047), frames: r.a });
    }
    if (steps2.length) out.filtertable = { steps: steps2.slice(0, 255), ...(fLoop !== undefined && fLoop < steps2.length ? { loop: fLoop } : {}) };
    approximated.push("filter table cutoff steps are scaled from the high byte (8 units per step); keyboard tracking and the filter switch are not imported");
  }
  // Hard restart.
  const ctrl = d[0]!;
  const timer = ctrl & 3;
  out.hard_restart = timer === 0 ? { frames: 0 } : { frames: timer, adsr: [d[1]! >> 4, d[1]! & 15, d[2]! >> 4, d[2]! & 15], ...(ctrl & 8 ? { test: true } : {}) };
  if (d[5]! !== 0) approximated.push("instrument vibrato is not imported");
  if (d[8]! > 1) approximated.push("default chord is not imported");
  void mode;
  return { id, yaml: out, octave: signed(d[9]!), approximated: [...new Set(approximated)] };
}

interface TrackEvent { at: number; kind: "note" | "off"; pitch?: number; inst?: number; legato?: boolean }
interface TrackResult { events: TrackEvent[]; end: number; endedBy: "end" | "jump" | "limit"; jumpTo?: number; notes: number; gateOffs: number }

interface Tempo { entries: number[]; idx: number }

export function importSwm(input: Uint8Array, options: SwmImportOptions = {}): SwmImportResult {
  const m = parseSwm(input);
  validateModule(m);
  return convertModule(m, options);
}

/** True when a one-note score with the instrument at `pitch` is accepted by the compiler. */
function instrumentFits(instrument: Record<string, unknown>, pitch: number, mode: "PAL" | "NTSC"): boolean {
  const text = yaml.stringify({ sidwave: "1.4", title: "fit", tempo: 100, mode, instruments: { i: instrument }, voices: [{ id: 1, instrument: "i", patterns: { a: { length: 1, bars: 1, groove: `${midiToNoteName(pitch)} ~ - -` } } }], timeline: [{ section: "s", bars: 1, layers: { v1: "a" } }] });
  try { compileSidwaveToPrg(parseSidwave(text)); return true; } catch (error) { if (error instanceof SidwaveValidationError) return false; throw error; }
}

function convertModule(m: SwmModule, options: SwmImportOptions): SwmImportResult {
  const per = m.kind === "sws" ? 6 : 3;
  const subtunes = m.sequences.length === 0 ? 1 : Math.floor((m.sequences.length - 1) / per) + 1;
  const subtune = options.subtune ?? 1;
  if (!Number.isInteger(subtune) || subtune < 1 || subtune > subtunes) throw new RangeError(`--subtune ${subtune} is outside 1 to ${subtunes}`);
  const mode = options.mode ?? "PAL";
  const callRate = m.speed * (mode === "PAL" ? 985_248 / 19_656 : 1_022_727 / 17_095);
  const maxCalls = Math.floor((options.maxSeconds ?? 600) * callRate);
  const losses: string[] = [];
  const warnings: string[] = [];
  const lossSet = new Set<string>();
  const lose = (what: string): void => { lossSet.add(what); };
  if (m.tuning !== 0) lose(`tuning type ${m.tuning} (${m.tuning === 1 ? "432 Hz" : "just intonation"}) is played in equal temperament at 440 Hz`);

  const programs = tempoPrograms(m.tempoTable);
  const [fa, fb] = m.subtuneTempos[subtune - 1] ?? [0x86, 0x83];
  const base: number[] = fa & 0x80 ? [fa] : [fa, fb | 0x80];
  const tracksPerSubtune = per;
  const seqs = Array.from({ length: tracksPerSubtune }, (_, t) => m.sequences[(subtune - 1) * per + t] ?? Uint8Array.of(0xfe, 1));
  const tempos: Tempo[] = seqs.map(() => ({ entries: [...base], idx: 0 }));
  const durations = new Set<number>();
  const insConv = m.instruments.map((ins, i) => convertInstrument(ins, `i${i + 1}`, mode));

  const results: TrackResult[] = [];
  // Per-track state, advanced in order of call time.
  interface St { pos: number; ptn: number; row: number; transpose: number; inst: number; time: number; done: boolean; pitch?: number; visited: Set<number>; res: TrackResult }
  const st: St[] = seqs.map(() => ({ pos: 0, ptn: 0, row: 0, transpose: 0, inst: 0, time: 0, done: false, visited: new Set(), res: { events: [], end: 0, endedBy: "end", notes: 0, gateOffs: 0 } }));
  const fetchPattern = (t: number): void => {
    const s = st[t]!, seq = seqs[t]!;
    for (let guard = 0; guard < 512; guard++) {
      const v = seq[s.pos]!;
      if (v === undefined) { s.done = true; return; }
      if (v >= 1 && v <= 0x7f) { s.ptn = v; s.row = 0; if (s.visited.has(s.pos)) { s.done = true; s.res.endedBy = "jump"; s.res.jumpTo = s.pos; return; } s.visited.add(s.pos); s.pos++; return; }
      s.pos++;
      if (v === 0 || (v >= 0xf0 && v <= 0xfd)) continue;
      if (v >= 0x80 && v <= 0x9f) { s.transpose = v - 0x90; continue; }
      if (v >= 0xa0 && v <= 0xaf) { lose("orderlist volume changes are not imported"); continue; }
      if (v >= 0xb0 && v <= 0xef) { tempos[t] = { entries: [(v - 0xb0) | 0x80], idx: 0 }; continue; }
      if (v === 0xfe) { s.done = true; s.res.endedBy = "end"; return; }
      if (v === 0xff) {
        const target = seq[s.pos];
        if (target === undefined || target >= 0x80) { s.done = true; s.res.endedBy = "end"; lose("a jump to another subtune is treated as the end of the track"); return; }
        s.res.jumpTo = target; s.pos = target;
        if (s.visited.has(target)) { s.done = true; s.res.endedBy = "jump"; return; }
        continue;
      }
    }
    s.done = true;
  };
  for (let t = 0; t < seqs.length; t++) fetchPattern(t);
  let totalRows = 0;
  let truncated = false;
  for (;;) {
    let pick = -1;
    for (let t = 0; t < st.length; t++) if (!st[t]!.done && (pick < 0 || st[t]!.time < st[pick]!.time)) pick = t;
    if (pick < 0) break;
    const s = st[pick]!;
    if (s.time >= maxCalls || ++totalRows > 400_000) { for (const x of st) if (!x.done) { x.done = true; x.res.endedBy = "limit"; } truncated = true; break; }
    const pattern = m.patterns[s.ptn - 1];
    const row: SwmRow = pattern?.rows[s.row] ?? { note: 0 };
    if (row.inst !== undefined && row.inst >= 1 && row.inst <= 0x3e) s.inst = row.inst;
    const legato = row.inst === 0x3f;
    const ev = s.res.events;
    if (row.note >= 1 && row.note <= 95) {
      const oct = insConv[s.inst - 1]?.octave ?? 0;
      s.pitch = row.note + 11 + s.transpose + oct;
      ev.push({ at: s.time, kind: "note", pitch: s.pitch, inst: s.inst, legato });
      s.res.notes++;
    } else if (row.note === SWM_NOTEFX.gateOff) { ev.push({ at: s.time, kind: "off" }); s.res.gateOffs++; }
    else if (row.note === SWM_NOTEFX.gateOn && s.pitch !== undefined) { ev.push({ at: s.time, kind: "note", pitch: s.pitch, inst: s.inst }); s.res.notes++; }
    else if (row.note >= 0x60 && row.note <= 0x6f) lose("note-column vibrato effects are not imported");
    else if (row.note >= 0x78) lose("note-column effects other than gate on and gate off (portamento, sync, ring) are not imported");
    if (row.fx !== undefined) {
      const v = row.value ?? 0;
      if (row.fx === 0x10) for (const tm of tempos) { tm.entries = [(v & 0x7f) | 0x80]; tm.idx = 0; }
      else if (row.fx === 0x11) for (const tm of tempos) { tm.entries = [v >> 4, (v & 15) | 0x80]; tm.idx = 0; }
      else if (row.fx === 0x12) { const p = programs[v - 1]; if (p) for (const tm of tempos) { tm.entries = [...p]; tm.idx = 0; } }
      else if (row.fx === 0x13) tempos[pick] = { entries: [(v & 0x7f) | 0x80], idx: 0 };
      else if (row.fx === 0x14) tempos[pick] = { entries: [v >> 4, (v & 15) | 0x80], idx: 0 };
      else if (row.fx === 0x15) { const p = programs[v - 1]; if (p) tempos[pick] = { entries: [...p], idx: 0 }; }
      else if (row.fx === 0x1d || row.fx === 0x1e) lose("track and note delay effects are not imported");
      else if (row.fx < 0x20 && row.fx !== 0 && ![0x04, 0x05, 0x06, 0x0e, 0x0f].includes(row.fx)) lose(`big effect $${row.fx.toString(16).padStart(2, "0")} is not imported`);
      else if (row.fx >= 0x20 || [0x04, 0x05, 0x06, 0x0e, 0x0f].includes(row.fx)) lose("small effects and register effects in the effect column (ADSR, waveform, pulse and filter settings, volume, detune) are not imported");
    }
    if (row.inst !== undefined && row.inst >= 0x40) lose("small effects in the instrument column (waveform, sustain, release, chord) are not imported");
    const tm = tempos[pick]!;
    const entry = tm.entries[Math.min(tm.idx, tm.entries.length - 1)]!;
    const dur = Math.max(1, entry & 0x7f);
    durations.add(dur);
    tm.idx = entry & 0x80 ? 0 : Math.min(tm.idx + 1, tm.entries.length - 1);
    s.time += dur;
    s.row++;
    if (!pattern || s.row >= pattern.length) fetchPattern(pick);
  }
  for (const [t, s] of st.entries()) { s.res.end = s.time; results[t] = s.res; }

  // Grid: the gcd of all row durations divides every row start. Merge cells until a note can last the minimum 3 frames.
  let g = 0;
  for (const dur of durations) g = gcd(g, dur);
  if (g === 0) g = 1;
  const minCalls = 3 * m.speed;
  let k = 1;
  while (g * k < minCalls) k++;
  const cellCalls = g * k;
  const framesPerBeatBase = 60 * callRate;
  let cellBeats = 0.25;
  for (const candidate of [0.25, 0.125, 0.0625, 0.5, 1, 2]) { const bpm = framesPerBeatBase * candidate / cellCalls; if (bpm >= 60 && bpm <= 200) { cellBeats = candidate; break; } }
  let bpm = framesPerBeatBase * cellBeats / cellCalls;
  if (bpm < 30 || bpm > 220) { warnings.push(`the tempo ${bpm.toFixed(1)} BPM is outside SIDWave's 30 to 220 and was clamped`); bpm = clamp(bpm, 30, 220); }
  if (k > 1) lose(`rows are 1 to ${[...durations].sort((a, b) => a - b)[0]} calls long; SIDWave needs at least 3 frames per note, so ${k} grid steps of ${g} calls are merged and note starts are moved to the merged grid`);
  const alternates = durations.size > 1;

  const end = Math.max(...results.map((r) => r.end), 0);
  const cellsPerBar = Math.round(4 / cellBeats);
  const rawCells = Math.max(1, Math.ceil(end / cellCalls));
  const cellCount = Math.ceil(rawCells / cellsPerBar) * cellsPerBar;
  const maxMidi = maxSidwaveMidi(mode);
  let moved = 0, eventCount = 0, maxShift = 0;
  type Cell = { kind: "rest" } | { kind: "tie" } | { kind: "note"; pitch: number; inst: number; legato: boolean };
  const voiceCells: Cell[][] = results.map((r) => {
    const cells: Cell[] = Array.from({ length: cellCount }, () => ({ kind: "rest" }));
    // Quantise, keeping the last event of a cell.
    const slots = new Map<number, TrackEvent>();
    for (const e of r.events) { eventCount++; const c = Math.round(e.at / cellCalls); if (c * cellCalls !== e.at) { moved++; maxShift = Math.max(maxShift, Math.abs(c * cellCalls - e.at)); } slots.set(c, e); }
    const sorted = [...slots.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < sorted.length; i++) {
      const [c, e] = sorted[i]!;
      if (c >= cellCount) continue;
      const next = sorted[i + 1]?.[0] ?? cellCount;
      if (e.kind === "off") continue;
      let pitch = e.pitch!;
      while (pitch < 12) pitch += 12;
      while (pitch > maxMidi) pitch -= 12;
      cells[c] = { kind: "note", pitch, inst: e.inst || 1, legato: !!e.legato };
      for (let j = c + 1; j < Math.min(next, cellCount); j++) cells[j] = { kind: "tie" };
    }
    return cells;
  });
  if (alternates && moved > 0) {
    lose(`Funk tempo, tempo program or track tempo: the rows are ${[...durations].sort((a, b) => a - b).join(' and ')} calls long and SIDWave has one tempo per bar, so the rows are placed on a grid of ${cellCalls} calls; ${moved} of ${eventCount} note starts move by up to ${maxShift} calls (${(maxShift / callRate * 1000).toFixed(0)} ms)`);
  } else if (alternates) lose(`Funk tempo, tempo program or track tempo: the rows are ${[...durations].sort((a, b) => a - b).join(' and ')} calls long and are placed on a grid of ${cellCalls} calls; no note start moves`);

  // Instruments used, voices, patterns, timeline.
  const used = new Set<number>();
  const topPitch = new Map<number, number>();
  for (const cells of voiceCells) for (const c of cells) if (c.kind === "note") { used.add(c.inst); topPitch.set(c.inst, Math.max(topPitch.get(c.inst) ?? 0, c.pitch)); }
  // A pitch table that moves a high note out of the SID's range makes the score invalid: find the weakest degradation per instrument that fits.
  for (const n of used) {
    const ins = m.instruments[n - 1];
    if (!ins) continue;
    for (let degrade = 0; degrade <= 3; degrade++) {
      const candidate = convertInstrument(ins, `i${n}`, mode, degrade);
      if (instrumentFits(candidate.yaml, topPitch.get(n)!, mode)) {
        if (degrade > 0) { candidate.approximated.push(["", "relative pitch steps of the waveform table are dropped", "all pitch steps of the waveform table are dropped", "the waveform table is dropped"][degrade]! + " because they leave the SID's playable range at the highest note played with this instrument"); insConv[n - 1] = candidate; }
        break;
      }
    }
  }
  const instruments: Record<string, unknown> = {};
  const instReports: SwmImportReport["instruments"] = [];
  for (const n of [...used].sort((a, b) => a - b)) {
    const conv = insConv[n - 1];
    if (!conv) { warnings.push(`instrument ${n} is used but not defined; notes with it use instrument 1`); continue; }
    instruments[conv.id] = conv.yaml;
    instReports.push({ number: n, name: m.instruments[n - 1]!.name.trim(), id: conv.id, approximated: conv.approximated });
    for (const a of conv.approximated) lose(`instrument ${n} (${m.instruments[n - 1]!.name.trim() || "unnamed"}): ${a}`);
  }
  const defaultInst = (cells: Cell[]): number => {
    const count = new Map<number, number>();
    for (const c of cells) if (c.kind === "note") count.set(c.inst, (count.get(c.inst) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
  };
  const voiceDefs: Array<Record<string, unknown>> = [];
  const patternsByVoice: Array<Map<string, string>> = voiceCells.map(() => new Map());
  const voicePatterns: Array<Record<string, unknown>> = voiceCells.map(() => ({}));
  const timeline: Array<Record<string, unknown>> = [];
  const defaults = voiceCells.map(defaultInst);
  const instName = (n: number): string => insConv[n - 1]?.id ?? `i${n}`;
  const tokens = (cells: Cell[], v: number): Array<string | Record<string, unknown>> => cells.map((c) => {
    if (c.kind === "rest") return "-";
    if (c.kind === "tie") return "~";
    const name = midiToNoteName(c.pitch);
    const withInst = c.inst !== defaults[v] && insConv[c.inst - 1] ? `${name}@${instName(c.inst)}` : name;
    return c.legato ? { note: name, legato: true, ...(c.inst !== defaults[v] && insConv[c.inst - 1] ? { inst: instName(c.inst) } : {}) } : withInst;
  });
  const barsPerSection = 4;
  const totalBars = cellCount / cellsPerBar;
  let sectionNo = 0;
  for (let bar = 0; bar < totalBars; bar += barsPerSection) {
    const count = Math.min(barsPerSection, totalBars - bar);
    const layers: Record<string, string> = {};
    for (const [v, cells] of voiceCells.entries()) {
      const slice = cells.slice(bar * cellsPerBar, (bar + count) * cellsPerBar);
      if (slice.every((c) => c.kind === "rest")) { layers[`v${v + 1}`] = "-"; continue; }
      const t = tokens(slice, v);
      const key = JSON.stringify(t);
      let name = patternsByVoice[v]!.get(key);
      if (!name) {
        name = `p${patternsByVoice[v]!.size + 1}`;
        patternsByVoice[v]!.set(key, name);
        voicePatterns[v]![name] = { length: cellBeats, bars: count, groove: t.every((x) => typeof x === "string") ? (t as string[]).join(" ") : t };
      }
      layers[`v${v + 1}`] = name;
    }
    sectionNo++;
    timeline.push({ section: `s${sectionNo}`, bars: count, layers });
  }
  for (const [v] of voiceCells.entries()) {
    if (Object.keys(voicePatterns[v]!).length === 0) continue;
    const def = insConv[defaults[v]! - 1];
    voiceDefs.push({ id: v + 1, name: `Track ${v + 1}`, ...(def ? { instrument: def.id } : {}), patterns: voicePatterns[v] });
  }
  if (voiceDefs.length === 0) throw new SwmError("the subtune holds no notes");
  const authorTitle = m.author.includes(":") ? m.author.split(":").slice(1).join(":").trim() : "";
  const title = options.title ?? (authorTitle || "Imported SID-Wizard module");
  const author = m.author.includes(":") ? m.author.split(":")[0]!.trim() : m.author.trim();
  const doc: Record<string, unknown> = {
    sidwave: "1.4", title: title.slice(0, 80), ...(author ? { author: author.slice(0, 80) } : {}), tempo: Math.round(bpm * 1e6) / 1e6, mode,
    ...(m.speed > 1 ? { speed: m.speed } : {}),
    ...(m.kind === "sws" ? { sids: [{ id: "sid1", address: "$D400" }, { id: "sid2", address: "$D420" }] } : {}),
    ...(Object.keys(instruments).length ? { instruments } : {}), voices: voiceDefs, timeline,
  };
  const document = new yaml.Document(doc);
  yaml.visit(document, {
    Pair(_key, pair) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      if (key !== "adsr" && key !== "groove") return;
      const flow = (node: unknown): void => { if (isSeq(node)) { node.flow = true; node.items.forEach(flow); } else if (isMap(node)) { node.flow = true; node.items.forEach((item) => flow(item.value)); } };
      flow(pair.value);
    },
  });
  const text = `# Imported from a SID-Wizard ${m.kind.toUpperCase()} module (subtune ${subtune} of ${subtunes}) by SIDWave.\n# One cell is ${cellCalls} player calls (${cellBeats} beats); see the import report for what was approximated or dropped.\n${document.toString({ lineWidth: 0, flowCollectionPadding: false })}`;
  if (options.validate !== false) {
    try { compileSidwaveToPrg(parseSidwave(text)); } catch (error) {
      if (error instanceof SidwaveValidationError) throw new SwmError(`the imported score is not accepted by SIDWave (${error.message})`);
      throw error;
    }
  }
  if (m.kind === "sws") lose("SWS: both SIDs are imported as voices 1 to 6 on two SIDs at $D400 and $D420");
  losses.push(...lossSet);
  return {
    yaml: text,
    report: {
      format: m.kind, subtune, subtunes, speed: m.speed, callsPerCell: cellCalls, cellBeats, tempo: Math.round(bpm * 1e6) / 1e6,
      seconds: Math.round(end / callRate * 100) / 100, truncated,
      tracks: results.map((r, i) => ({ track: i + 1, voice: i + 1, notes: r.notes, gateOffs: r.gateOffs, endedBy: r.endedBy, ...(r.jumpTo !== undefined ? { jumpTo: r.jumpTo } : {}) })),
      instruments: instReports, quantisation: { events: eventCount, moved }, losses, warnings,
    },
  };
}

/** `.swi` import: the instrument as a one-note score so that it can be heard, plus the SIDWave instrument definition. */
export function importSwi(input: Uint8Array, options: SwmImportOptions = {}): SwmImportResult & { instrument: Record<string, unknown> } {
  const swi = parseSwi(input);
  const mode = options.mode ?? "PAL";
  let conv = convertInstrument(swi.instrument, "inst", mode);
  for (let degrade = 0; degrade <= 3; degrade++) {
    conv = convertInstrument(swi.instrument, "inst", mode, degrade);
    if (instrumentFits(conv.yaml, 60, mode)) {
      if (degrade > 0) conv.approximated.push(["", "relative pitch steps of the waveform table are dropped", "all pitch steps of the waveform table are dropped", "the waveform table is dropped"][degrade]! + " because they leave the SID's playable range");
      break;
    }
  }
  const doc: Record<string, unknown> = {
    sidwave: "1.4", title: options.title ?? (swi.instrument.name.trim() || "SID-Wizard instrument"), tempo: 100, mode,
    instruments: { inst: conv.yaml },
    voices: [{ id: 1, name: "Instrument", instrument: "inst", patterns: { a: { length: 1, bars: 1, groove: "C4 ~ - -" } } }],
    timeline: [{ section: "demo", bars: 1, layers: { v1: "a" } }],
  };
  const document = new yaml.Document(doc);
  const text = `# Imported from a SID-Wizard instrument (${swi.instrument.name.trim()}) by SIDWave. The score plays the instrument once at C4.\n${document.toString({ lineWidth: 0 })}`;
  if (options.validate !== false) {
    try { compileSidwaveToPrg(parseSidwave(text)); } catch (error) {
      if (error instanceof SidwaveValidationError) throw new SwmError(`the imported instrument is not accepted by SIDWave (${error.message})`);
      throw error;
    }
  }
  return {
    yaml: text, instrument: conv.yaml,
    report: { format: "swi", subtune: 1, subtunes: 1, speed: 1, callsPerCell: 0, cellBeats: 1, tempo: 100, seconds: 0, truncated: false, tracks: [], instruments: [{ number: 1, name: swi.instrument.name.trim(), id: "inst", approximated: conv.approximated }], quantisation: { events: 0, moved: 0 }, losses: [...conv.approximated], warnings: [] },
  };
}
