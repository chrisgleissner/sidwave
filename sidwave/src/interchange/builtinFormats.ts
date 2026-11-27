// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The formats SIDWave reads and writes itself. Each entry wraps the existing importer or exporter; none of them is
// reimplemented here. `convert` reaches them only through the registry (registry.ts).

import { constants, inflateSync } from "node:zlib";
import { createLibsidplayfpEngine } from "../engine/libsidplayfp.js";
import { parseSidwave } from "../sidwave.js";
import { sidwaveFrameRate } from "../sidwaveCompiler.js";
import { reconstructSid, type ReconstructReport } from "../reconstruct/reconstruct.js";
import { parseSidFile } from "../sidFile.js";
import { compileSidwaveBytes, describeSidwave } from "../sidwaveOps.js";
import { InterchangeUsageError } from "./errors.js";
import { exportEvents } from "./events.js";
import { exportFurnace } from "./furnaceExport.js";
import { importFurnace } from "./furnaceImport.js";
import { parseFurnace } from "./furnace.js";
import { exportGoatTracker } from "./goattrackerExport.js";
import { importGoatTracker } from "./goattrackerImport.js";
import { parseGoatTracker } from "./goattracker.js";
import { exportMidi } from "./midiExport.js";
import { importMidi } from "./midiImport.js";
import { parseSmf } from "./smf.js";
import { exportMusicXml } from "./musicxmlExport.js";
import { importMusicXml } from "./musicxmlImport.js";
import { writeWav } from "./wav.js";
import type { FormatDefinition, ReadContext } from "./formatTypes.js";
import { lossesFromText, type Loss, type LossStage } from "./loss.js";

const head = (bytes: Uint8Array, n: number): string => Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(n, bytes.length)).toString("latin1");
const startsWith = (bytes: Uint8Array, text: string): boolean => head(bytes, text.length) === text;

/** Warnings of importers and exporters, as losses. A dropped note is a loss; a row grid that does not fit is an approximation. */
export function warningLosses(stage: LossStage, warnings: readonly string[]): Loss[] {
  return warnings.map((message): Loss => {
    const lost = /is dropped|are dropped|dropped\./i.test(message);
    return { stage, code: lost ? "notes.dropped" : /row length/i.test(message) ? "timing.row-grid" : "warning", severity: lost ? "lost" : "approx", count: 1, message };
  });
}

const importOptions = (ctx: ReadContext) => ({
  ...(ctx.title === undefined ? {} : { title: ctx.title }), ...(ctx.mode ? { mode: ctx.mode } : {}), validate: ctx.validate !== false,
});

function fromImport(result: { yaml: string; report: { losses: string[]; warnings?: string[] } }) {
  return { yaml: result.yaml, report: result.report, losses: [...lossesFromText("read", result.report.losses), ...warningLosses("read", result.report.warnings ?? [])] };
}

function fromExport(result: { losses: string[]; warnings: string[] }, extra: Record<string, unknown> = {}): { losses: Loss[]; warnings: string[] } & Record<string, unknown> {
  return { ...extra, losses: [...lossesFromText("write", result.losses), ...warningLosses("write", result.warnings)], warnings: result.warnings };
}

function rangeToUsage<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof RangeError) throw new InterchangeUsageError(error.message);
    throw error;
  }
}

const SIDWAVE_TEXT = /^[ \t]*["']?sidwave["']?[ \t]*:/m;

export const SIDWAVE_SCORE: FormatDefinition = {
  songs: true, id: "sidwave", name: "SIDWave score", extensions: [".yaml", ".yml", ".sidwave"], aliases: ["score", "yaml", "yml"],
  magic: (bytes) => {
    const text = head(bytes, 8192);
    if (SIDWAVE_TEXT.test(text)) return 1;
    // Scores before SIDWave 1.1 have no version key: the top-level keys song and voices identify them.
    return /^song[ \t]*:/m.test(text) && /^voices[ \t]*:/m.test(text) ? 0.7 : 0;
  },
  detection: "the top-level key `sidwave:` (older scores: the top-level keys `song:` and `voices:`)",
  caps: { kind: "score", tempo: "exact", instruments: "native", expression: "exact", loop: true, metadata: true },
  lossSummary: "none: the native format",
  read: (bytes) => ({ yaml: Buffer.from(bytes).toString("utf8"), losses: [] }),
  write: ({ yaml }) => ({ bytes: yaml.endsWith("\n") ? yaml : `${yaml}\n`, losses: [] }),
  describe: (bytes) => ({ ...describeSidwave(parseSidwave(Buffer.from(bytes).toString("utf8"))) }),
};

export const EVENTS: FormatDefinition = {
  id: "events", name: "Event list (JSON)", extensions: [".json"], aliases: ["json"],
  magic: (bytes) => (/"schema"\s*:\s*"sidwave\.events\/1"/.test(head(bytes, 4096)) ? 1 : 0),
  detection: "the JSON key schema: sidwave.events/1",
  caps: { kind: "events", tempo: "map", instruments: "native", expression: "none", loop: false, metadata: true },
  lossSummary: "write only: a lossy view (notes, tempo map, instrument descriptions); filters, pulse modulation, samples are not exported",
  write: ({ doc, plan }) => {
    const events = rangeToUsage(() => exportEvents(doc, plan.exportOptions));
    return { bytes: `${JSON.stringify(events, null, 2)}\n`, losses: lossesFromText("write", events.losses) };
  },
  describe: (bytes) => { const e = JSON.parse(Buffer.from(bytes).toString("utf8")) as { title?: string; durationSeconds?: number; voices?: unknown[] }; return { title: e.title, seconds: e.durationSeconds, voices: e.voices?.length }; },
};

/** The notes of a Standard MIDI File with their times in seconds (tempo map applied), independent of the importer. */
function midiNotes(bytes: Uint8Array): Array<{ time: number; end: number; pitch: number; voice: number }> {
  const smf = parseSmf(bytes);
  const tempos: Array<{ tick: number; us: number }> = [{ tick: 0, us: 500_000 }];
  for (const track of smf.tracks) for (const e of track) if (e.type === "tempo") tempos.push({ tick: e.tick, us: e.microsecondsPerQuarter });
  tempos.sort((a, b) => a.tick - b.tick);
  const marks: Array<{ tick: number; seconds: number; us: number }> = [];
  let seconds = 0, last = tempos[0]!;
  for (const t of tempos) { seconds += (t.tick - last.tick) * last.us / 1e6 / smf.division; marks.push({ tick: t.tick, seconds, us: t.us }); last = t; }
  const toSeconds = (tick: number): number => {
    let m = marks[0]!;
    for (const c of marks) { if (c.tick <= tick) m = c; else break; }
    return m.seconds + (tick - m.tick) * m.us / 1e6 / smf.division;
  };
  const notes: Array<{ time: number; end: number; pitch: number; voice: number }> = [];
  smf.tracks.forEach((track, ti) => {
    const open = new Map<string, number[]>();
    for (const e of track) {
      if (e.type !== "noteOn" && e.type !== "noteOff") continue;
      const key = `${e.channel}:${e.note}`;
      if (e.type === "noteOn" && e.velocity > 0) { const q = open.get(key) ?? open.set(key, []).get(key)!; q.push(e.tick); continue; }
      const start = open.get(key)?.shift();
      if (start !== undefined) notes.push({ time: toSeconds(start), end: toSeconds(e.tick), pitch: e.note, voice: ti * 16 + e.channel });
    }
  });
  return notes.sort((a, b) => a.time - b.time);
}

export const MIDI: FormatDefinition = {
  readQuantises: true, id: "midi", name: "Standard MIDI File", extensions: [".mid", ".midi", ".smf"], aliases: ["mid", "smf"],
  magic: (bytes) => (startsWith(bytes, "MThd") ? 1 : 0),
  detection: "the header chunk MThd",
  caps: { kind: "notation", tempo: "map", instruments: "program", expression: "none", loop: false, metadata: true },
  lossSummary: "ADSR, waveforms, pulse width, ring, sync and filter are not written (instruments become GM programs); import keeps one note per voice and quantises to a grid",
  read: (bytes, ctx) => fromImport(rangeToUsage(() => importMidi(bytes, { ...importOptions(ctx), ...(ctx.grid === undefined ? {} : { grid: ctx.grid }), ...(ctx.voices === undefined ? {} : { voices: ctx.voices }) }))),
  write: ({ doc, plan }) => {
    const result = rangeToUsage(() => exportMidi(doc, plan.exportOptions));
    const out = fromExport(result, { report: { ppq: result.ppq, tracks: result.tracks } });
    return { bytes: result.bytes, losses: out.losses, report: out.report };
  },
  sourceNotes: (bytes) => midiNotes(bytes),
  describe: (bytes) => { const smf = parseSmf(bytes); return { format: smf.format, ticksPerQuarter: smf.division, tracks: smf.tracks.length, events: smf.tracks.reduce((s, t) => s + t.length, 0) }; },
};

export const MUSICXML: FormatDefinition = {
  readQuantises: true, id: "musicxml", name: "MusicXML", extensions: [".musicxml", ".xml", ".mxl"], readOnlyExtensions: [".mxl"], aliases: ["xml"],
  magic: (bytes) => {
    const text = head(bytes, 4096);
    if (/<score-(partwise|timewise)\b/.test(text)) return 1;
    // A compressed .mxl is a zip archive; it is recognised but cannot be read yet.
    return startsWith(bytes, "PK\x03\x04") ? 0.3 : 0;
  },
  detection: "the root element score-partwise or score-timewise (a zip archive is recognised as compressed MusicXML)",
  caps: { kind: "notation", tempo: "map", instruments: "program", expression: "none", loop: false, metadata: true },
  lossSummary: "write: instruments become GM programs, no articulations or note types; read: uncompressed files only, dynamics, slurs, ornaments and repeats are not imported",
  read: (bytes, ctx) => fromImport(rangeToUsage(() => importMusicXml(bytes, { ...importOptions(ctx), ...(ctx.grid === undefined ? {} : { grid: ctx.grid }), ...(ctx.voices === undefined ? {} : { voices: ctx.voices }) }))),
  write: ({ doc, plan }) => {
    const result = rangeToUsage(() => exportMusicXml(doc, plan.exportOptions));
    const out = fromExport(result);
    return { bytes: result.xml, losses: out.losses };
  },
  describe: (bytes) => {
    const text = Buffer.from(bytes).toString("utf8");
    return { parts: (text.match(/<score-part\b/g) ?? []).length, measures: (text.match(/<measure\b/g) ?? []).length };
  },
};

export const GOATTRACKER: FormatDefinition = {
  songs: true, id: "goattracker", name: "GoatTracker song", extensions: [".sng"], aliases: ["gt", "gt2", "goat", "sng"],
  magic: (bytes) => (["GTS!", "GTS2", "GTS3", "GTS4", "GTS5"].includes(head(bytes, 4)) ? 1 : 0),
  detection: "the magic GTS!, GTS2, GTS3, GTS4 or GTS5",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "partial", loop: false, metadata: true },
  lossSummary: "three channels; no filter, vibrato, slides or pulse modulation on export; notes move to a row grid; import maps commands it knows and reports the rest",
  read: (bytes, ctx) => fromImport(rangeToUsage(() => importGoatTracker(bytes, { ...importOptions(ctx), ...(ctx.song === undefined ? {} : { song: ctx.song }) }))),
  write: ({ doc, plan }) => {
    const result = rangeToUsage(() => exportGoatTracker(doc, plan.exportOptions));
    const out = fromExport(result, { report: { ticksPerRow: result.ticksPerRow, rowSeconds: result.ticksPerRow / sidwaveFrameRate(doc.song.mode), rows: result.rows, patterns: result.patterns, instruments: result.instruments, voices: result.voices, maxTimingErrorCalls: result.maxTimingErrorCalls } });
    return { bytes: result.bytes, losses: out.losses, report: out.report };
  },
  describe: (bytes) => { const s = parseGoatTracker(bytes); return { version: s.family, magic: s.magic, title: s.name, author: s.author, songs: s.songs.length }; },
};

function furnaceMagic(bytes: Uint8Array): number {
  if (startsWith(bytes, "-Furnace module-")) return 1;
  if (bytes.length > 2 && bytes[0] === 0x78 && (bytes[0]! * 256 + bytes[1]!) % 31 === 0) {
    try {
      const inflated = inflateSync(bytes.subarray(0, Math.min(bytes.length, 512)), { finishFlush: constants.Z_SYNC_FLUSH });
      if (inflated.toString("latin1", 0, 16) === "-Furnace module-") return 1;
      return 0.2;
    } catch { return 0.2; }
  }
  return 0;
}

export const FURNACE: FormatDefinition = {
  id: "furnace", name: "Furnace module", extensions: [".fur"], aliases: ["fur"],
  magic: furnaceMagic,
  detection: "the header -Furnace module- (also inside a zlib stream)",
  caps: { kind: "tracker", maxVoices: 3, tempo: "grid", instruments: "native", expression: "partial", loop: false, metadata: true },
  lossSummary: "C64 (SID) chip only, three channels; export has no filter, PWM, vibrato or slides; import drops effect commands and macros it cannot map",
  read: (bytes, ctx) => fromImport(rangeToUsage(() => importFurnace(bytes, importOptions(ctx)))),
  write: ({ doc, plan }) => {
    const result = rangeToUsage(() => exportFurnace(doc, plan.exportOptions));
    const out = fromExport(result, { report: { ticksPerRow: result.ticksPerRow, rowSeconds: result.ticksPerRow / sidwaveFrameRate(doc.song.mode), rows: result.rows, voices: result.voices } });
    return { bytes: result.bytes, losses: out.losses, report: out.report };
  },
  describe: (bytes) => { const s = parseFurnace(bytes); return { version: s.version, title: s.name, author: s.author, chips: s.chips, channels: s.channels, subsongs: s.subsongs }; },
};

export const WAV: FormatDefinition = {
  writeNeedsEngine: true, id: "wav", name: "WAV audio", extensions: [".wav"], aliases: ["wave"],
  magic: (bytes) => (startsWith(bytes, "RIFF") && head(bytes, 12).slice(8) === "WAVE" ? 1 : 0),
  detection: "RIFF header with WAVE",
  caps: { kind: "audio", tempo: "none", instruments: "none", expression: "exact", loop: false, metadata: false },
  lossSummary: "write only: a rendered mix (mono, 48 kHz); no notes remain. Reading audio is not supported",
  write: async ({ doc, song, seconds, model, createEngine, signal, plan }) => {
    const sid = compileSidwaveBytes(doc, { format: "sid", song }).bytes;
    const emulation = "residfp" as const;
    const engine = createEngine ? createEngine(emulation) : createLibsidplayfpEngine({ emulation });
    const length = Math.min(600, seconds ?? Math.max(1, Math.ceil(plan.summary.durationSeconds)));
    const result = await engine.render({ sid: new Uint8Array(sid), song: song + 1, seconds: length, sampleRate: 48_000, channels: 1, ...(model ? { model } : {}), ...(signal ? { signal } : {}) });
    return { bytes: writeWav(result.samples, result.sampleRate), losses: [{ stage: "write", code: "audio.rendered", severity: "lost", count: 1, message: `The score is rendered to ${result.seconds} s of audio; no notes, instruments or tempo remain in the file.` }], report: { seconds: result.seconds, sampleRate: result.sampleRate, engine: result.engine } };
  },
  describe: (bytes) => {
    if (bytes.length < 44) return { error: "truncated WAV header" };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = view.getUint32(24, true), channels = view.getUint16(22, true), bits = view.getUint16(34, true);
    return { sampleRate: rate, channels, bitsPerSample: bits, seconds: rate && channels && bits ? Math.round(((bytes.length - 44) / (rate * channels * (bits / 8))) * 100) / 100 : undefined };
  },
};

export const PRG: FormatDefinition = {
  id: "prg", name: "C64 program (PRG)", extensions: [".prg"],
  magic: () => 0,
  detection: "extension only (a PRG has no header)",
  caps: { kind: "program", tempo: "exact", instruments: "native", expression: "exact", loop: true, metadata: false },
  lossSummary: "write only: the compiled player and score; the title and author are not stored; cannot be read back",
  write: ({ doc, song }) => {
    const { bytes, summary } = compileSidwaveBytes(doc, { format: "prg", song });
    return { bytes, losses: lossesFromText("write", summary.warnings), report: summary };
  },
};

/** Losses of a reconstruct (from a PSID or from an imported trace), as structured losses of the read stage. */
export function reconstructLosses(report: ReconstructReport, what: string): Loss[] {
  const losses: Loss[] = [
    { stage: "read", code: "reconstruct.horizon", severity: "approx", count: report.horizon.calls, message: `Only the first ${report.horizon.seconds} s (${report.horizon.calls} player calls) of ${what} were analysed.` },
  ];
  for (const u of report.unsupported) losses.push({ stage: "read", code: `reconstruct.${u.kind}`, severity: "lost", count: 1, message: u.detail });
  if (report.languageExtensions.length) losses.push({ stage: "read", code: "reconstruct.extensions", severity: "info", count: report.languageExtensions.length, message: `${report.languageExtensions.length} constructs of the tune have no SIDWave equivalent and were approximated.` });
  if (!report.strictExact) {
    losses.push({ stage: "read", code: "reconstruct.fdiff", severity: "approx", count: report.fdiff.differingCalls, message: `F-diff: the recovered score differs from the tune in ${report.fdiff.differingCalls} register-class differences over ${report.fdiff.comparedCalls} compared player calls (a call can differ in several classes).` });
  }
  return losses;
}

export const SID: FormatDefinition = {
  songs: true, id: "sid", name: "PSID/RSID tune", extensions: [".sid"], aliases: ["psid", "rsid"],
  magic: (bytes) => ((startsWith(bytes, "PSID") || startsWith(bytes, "RSID")) && bytes.length >= 0x76 ? 1 : 0),
  detection: "the magic PSID or RSID",
  caps: { kind: "program", tempo: "exact", instruments: "native", expression: "exact", loop: true, metadata: true },
  lossSummary: "write: none beyond the SIDWave player; read: approximate recovery (reconstruct), slow, limited to a horizon",
  readIsApproximate: true,
  read: async (bytes, ctx) => {
    const header = parseSidFile(bytes);
    const song = ctx.song ?? header.startSong;
    if (song < 1 || song > header.songs) throw new InterchangeUsageError(`--song ${song} is outside 1..${header.songs}, the subtunes of ${ctx.name}`);
    ctx.notice?.("Reading a .sid recovers the score by tracing the tune; the result is approximate and slower than other formats.");
    const engine = ctx.createEngine ? ctx.createEngine("sidlite") : createLibsidplayfpEngine({ emulation: "sidlite" });
    let recovered;
    try {
      recovered = await reconstructSid(bytes, { engine, song, ...(ctx.seconds === undefined ? {} : { seconds: ctx.seconds }), ...(ctx.title === undefined ? {} : { title: ctx.title }) });
    } catch (error) {
      // recoverScore reports a tune without enough player calls with a plain Error; that is a property of the input.
      if (error instanceof Error && error.constructor === Error) throw new InterchangeUsageError(`cannot recover a score from ${ctx.name}: ${error.message}`);
      throw error;
    }
    const { score, report } = recovered;
    const losses = reconstructLosses(report, `subtune ${song}`);
    return { yaml: score, losses, report, approximate: true, fdiff: { equal: report.strictExact, differingCalls: report.fdiff.differingCalls, comparedCalls: report.fdiff.comparedCalls } };
  },
  write: ({ doc, song }) => {
    const { bytes, summary } = compileSidwaveBytes(doc, { format: "sid", song });
    return { bytes, losses: lossesFromText("write", summary.warnings), report: summary };
  },
  describe: (bytes) => { const s = parseSidFile(bytes); return { magic: String.fromCharCode(...bytes.subarray(0, 4)), version: s.version, title: s.name, author: s.author, released: s.released, songs: s.songs, startSong: s.startSong, clock: s.clock, loadAddress: s.loadAddress, initAddress: s.initAddress, playAddress: s.playAddress }; },
};

export const BUILTIN_FORMATS: FormatDefinition[] = [SIDWAVE_SCORE, SID, MIDI, MUSICXML, GOATTRACKER, FURNACE, WAV, PRG, EVENTS];
