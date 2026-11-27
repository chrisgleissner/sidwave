// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Turns a file into something a target can play: a SIDWave score is compiled, a PSID or RSID is played as it is, and any
// other input that `sidwave convert` reads is imported into a score first.

import { extname } from "node:path";
import { SidwaveOperationError, UsageError, withFile } from "../cliCore.js";
import type { SidClock, SidEmulation, SidEngine } from "../engine/types.js";
import { parseSidFile } from "../sidFile.js";
import { parseSidwave, type ParsedSidwave } from "../sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid, type CompileResult } from "../sidwaveCompiler.js";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { selectScore, type ScoreSelection } from "./select.js";
import type { PlayTarget } from "./types.js";

export type PlaySource =
  /** `songChosen`: the importer already took the song asked for, so the score holds that song only. */
  | { kind: "score"; format: string; doc: ParsedSidwave; notes: string[]; songChosen?: boolean }
  | { kind: "sid"; format: "sid"; bytes: Uint8Array; notes: string[] };

export interface SourceOptions {
  name: string;
  /** Input format, as for `sidwave convert --from`; default: detected. */
  from?: string;
  /** Song of an imported file with several songs, 1-based. For scores and SID files it is chosen by buildPlayTune. */
  song?: number;
  readOptions?: SidwaveReadOptions;
  createEngine?: (emulation: SidEmulation) => SidEngine;
  signal?: AbortSignal;
  notice?: (message: string) => void;
}

const SCORE_EXTENSIONS = new Set([".yaml", ".yml", ".sidwave"]);

const magic = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 4));

/** Reads a score, a SID file or a convertible input. */
export async function readPlaySource(bytes: Uint8Array, options: SourceOptions): Promise<PlaySource> {
  const text = () => Buffer.from(bytes).toString("utf8");
  const parse = (yaml: string) => withFile(options.name, () => parseSidwave(yaml, options.readOptions ?? {}));
  const from = options.from?.toLowerCase();
  const isSid = magic(bytes) === "PSID" || magic(bytes) === "RSID";
  if (isSid && (from === undefined || from === "sid" || from === "psid" || from === "rsid")) {
    parseSidFile(bytes);
    return { kind: "sid", format: "sid", bytes, notes: [] };
  }
  if (from === undefined && SCORE_EXTENSIONS.has(extname(options.name).toLowerCase())) {
    return { kind: "score", format: "sidwave", doc: parse(text()), notes: [] };
  }
  // The importers are loaded only for inputs that need them.
  const { inputFormat } = await import("../interchange/convert.js");
  const { format } = inputFormat(bytes, { inputName: options.name, ...(from === undefined ? {} : { from }) });
  if (format.id === "sidwave") return { kind: "score", format: "sidwave", doc: parse(text()), notes: [] };
  if (format.id === "sid") {
    parseSidFile(bytes);
    return { kind: "sid", format: "sid", bytes, notes: [] };
  }
  if (!format.read) throw new SidwaveOperationError("input", `${options.name} is ${format.id}, which cannot be read; "sidwave formats" lists the formats that can be played`);
  const { song } = options;
  if (song !== undefined && song > 1 && !format.songs) throw new SidwaveOperationError("input", `--song ${song}: a ${format.name} file holds one song (1 is the first)`);
  const notes: string[] = [];
  const read = await format.read(bytes, {
    name: options.name, ...(song === undefined ? {} : { song }), notice: (message) => options.notice?.(message),
    ...(options.createEngine ? { createEngine: options.createEngine } : {}), ...(options.signal ? { signal: options.signal } : {}),
  });
  const lost = read.losses.reduce((sum, loss) => sum + (loss.severity === "info" ? 0 : 1), 0);
  if (lost) notes.push(`imported from ${format.id} with ${lost} kind${lost === 1 ? "" : "s"} of loss ("sidwave convert" lists them)`);
  else notes.push(`imported from ${format.id}`);
  return { kind: "score", format: format.id, doc: parse(read.yaml), notes, ...(song === undefined ? {} : { songChosen: true }) };
}

/** A compiled tune, ready for a target. */
export interface PlayTune {
  title: string;
  /** The PSID; absent when the score cannot be one (see sidUnavailable). */
  sid?: Uint8Array;
  /** Why there is no PSID. */
  sidUnavailable?: string;
  /** The PRG of a score; a SID file has none. */
  prg?: Uint8Array;
  /** A device must run the PRG, not play the SID file: the PRG switches the CPU to turbo speed. */
  needsPrg?: boolean;
  /** 1-based song of the SID file; absent for the song of the header. */
  song?: number;
  /** Length of one pass from the start of the compiled tune; unknown for a SID file. */
  seconds?: number;
  /** Seconds between the start of the compiled tune and --from-bar. */
  skipSeconds: number;
  startBar: number;
  loop: boolean;
  clock?: SidClock;
  sids: Array<{ address: number; model?: string }>;
  notes: string[];
  /** The result of the compiler, with its lint findings. */
  compiled?: CompileResult;
}

export interface TuneOptions extends ScoreSelection {
  loop?: boolean;
  target: PlayTarget;
  file?: string;
}

/** Compiles the selected part of a score, or checks the selection of a SID file. */
export function buildPlayTune(source: PlaySource, options: TuneOptions): PlayTune {
  if (source.kind === "sid") {
    const flag = options.solo?.length ? "--solo" : options.mute?.length ? "--mute" : options.fromBar !== undefined ? "--from-bar" : options.loopSection !== undefined ? "--loop-section" : undefined;
    if (flag) throw new UsageError(`${flag} needs a score; a SID file has no voices or bars to select (see "sidwave isolate" for single voices, or "sidwave reconstruct")`);
    const file = parseSidFile(source.bytes);
    if (options.song !== undefined && options.song > file.songs) throw new SidwaveOperationError("input", `--song ${options.song}: the file has ${file.songs} song${file.songs === 1 ? "" : "s"} (1 is the first)`);
    const notes = [...source.notes];
    if (file.magic === "RSID" && options.target === "local") notes.push("an RSID tune may need C64 ROMs, which the local engine does not have; if it stays silent, use --target vice");
    return {
      title: file.name, sid: source.bytes, ...(options.song === undefined ? {} : { song: options.song }), skipSeconds: 0, startBar: 1, loop: true,
      ...(file.clock === "PAL" || file.clock === "NTSC" ? { clock: file.clock as SidClock } : {}),
      sids: [{ address: 0xd400 }], notes,
    };
  }
  const run = <T>(fn: () => T): T => (options.file === undefined ? fn() : withFile(options.file, fn));
  const selection: TuneOptions = source.songChosen ? { ...options, song: undefined } : options;
  let selected = selectScore(source.doc, selection, options.loop ?? false);
  const compile = (score: ParsedSidwave) => compileSidwaveToPrg(score, { loop: selected.loop });
  let compiled: CompileResult;
  try {
    compiled = run(() => compile(selected.doc));
  } catch (error) {
    // A section that ends on a very short note cannot be followed by its own first note; a bar of rest makes room.
    if (options.loopSection === undefined || !/hard restart calls after the preceding note/.test((error as Error).message)) throw error;
    selected = selectScore(source.doc, selection, options.loop ?? false, 1);
    compiled = run(() => compile(selected.doc));
  }
  const { doc, loop } = selected;
  const notes = [...source.notes, ...selected.notes];
  const tune: PlayTune = {
    title: doc.song.title, prg: compiled.prg, seconds: compiled.durationSeconds, skipSeconds: selected.skipSeconds, startBar: selected.startBar,
    loop, clock: doc.song.mode, sids: doc.sids.map(({ address, model }) => ({ address, ...(model ? { model } : {}) })), notes, compiled,
  };
  const toSid = (score: ParsedSidwave, prg: Uint8Array) => new Uint8Array(compileSidwaveToSid(score, prg).sid);
  try {
    tune.sid = toSid(doc, compiled.prg);
  } catch (error) {
    if (!(error instanceof Error && error.name === "SidwaveValidationError")) throw error;
    tune.sidUnavailable = error.message;
    // The local engine plays SID files only. Digi samples need a PRG, so the engine plays the score without them.
    if (options.target === "local" && doc.samples) {
      const digi = new Set((doc.digiVoices ?? []).map((v) => v.id));
      const silent: ParsedSidwave = {
        ...doc, samples: undefined, digiVoices: [],
        timeline: doc.timeline.map((section) => ({ ...section, layers: Object.fromEntries(Object.entries(section.layers).filter(([key]) => !digi.has(key))) })),
      };
      try {
        tune.sid = toSid(silent, run(() => compile(silent)).prg);
        notes.push("the local engine does not play digi samples; the other voices are played (use --target vice or u64 to hear the samples)");
      } catch (again) {
        if (!(again instanceof Error && again.name === "SidwaveValidationError")) throw again;
      }
    }
  }
  if (selected.skipSeconds > 0 && options.target !== "local") {
    notes.push(`playback starts at bar ${selected.startBar}, the start of the section that contains bar ${options.fromBar}; only the local target starts inside a section`);
    tune.skipSeconds = 0;
  } else if (options.fromBar !== undefined) tune.startBar = options.fromBar;
  if (doc.cpu === "turbo") {
    tune.needsPrg = true;
    notes.push(options.target === "u64"
      ? "the score needs a turbo CPU: set Turbo Control of the device to its Turbo Registers mode; the PRG selects the speed"
      : "the score needs a turbo CPU; at 1 MHz it may not play at the right speed");
  }
  if (doc.sids.length > 4 && options.target === "vice") notes.push(`VICE plays at most 4 SIDs; the score has ${doc.sids.length}`);
  if (doc.sids.length > 1 && options.target === "u64") notes.push(`set the SID addresses of the device to ${doc.sids.map((s) => `$${s.address.toString(16).toUpperCase()}`).join(", ")} before playing`);
  return tune;
}
