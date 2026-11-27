// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// `sidwave watch`: compile a score again whenever it (or a sample or library it reads) changes, report errors and lint
// findings with their place in the text, and restart playback. The directories of the files are watched, not the files,
// so that an editor which replaces a file by renaming another one over it keeps being followed.

import { createHash } from "node:crypto";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as parseYaml } from "yaml";
import { SidwaveOperationError, classifyError, type ErrorCategory } from "../cliCore.js";
import { parseSidwave, SidwaveValidationError, type ParsedSidwave } from "../sidwave.js";
import { isInfoCode, type SidwaveFinding } from "../sidwaveLint.js";
import { libraryClosure, readImportEntries } from "../sidwaveLibs.js";
import { confinedReadOptions, lintSidwave } from "../sidwaveOps.js";
import { scoreLocator, type Position } from "./positions.js";
import type { PlayTargetHandle } from "./session.js";
import { buildPlayTune, type PlayTune, type TuneOptions } from "./source.js";
import type { Playback } from "./types.js";

export type WatchFinding = SidwaveFinding & Partial<Position> & { info: boolean };

export type WatchEvent =
  | { type: "ok"; file: string; title: string; seconds: number; voices: number; sids: number; findings: WatchFinding[]; notes: string[]; buildMs: number }
  | ({ type: "error"; file: string; message: string; category: ErrorCategory; path?: string; keptPlaying: boolean } & Partial<Position>)
  /** `latencyMs` runs from the moment the change was seen until the target had the new tune. */
  | { type: "playing"; latencyMs: number; detail: string; startBar: number; loop: boolean }
  | { type: "finished" }
  | { type: "playback-error"; message: string }
  | { type: "missing"; file: string };

export interface WatchOptions extends Omit<TuneOptions, "file"> {
  /** The score file, absolute or relative to cwd. */
  file: string;
  cwd?: string;
  allowDirs?: readonly string[];
  /** The target to play on; without it the score is only checked. */
  player?: PlayTargetHandle;
  /** Quiet time after the last change before the score is read. Default 100 ms. */
  debounceMs?: number;
  /** Ends the watch. */
  signal: AbortSignal;
  onEvent(event: WatchEvent): void;
}

export interface WatchSummary {
  builds: number;
  errors: number;
  /** Whether the last version of the score was valid. */
  ok: boolean;
}

export const DEFAULT_DEBOUNCE_MS = 60;

const hashOf = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const contentOf = (path: string): string => {
  try {
    return hashOf(readFileSync(path));
  } catch {
    return "missing";
  }
};

const signatureOf = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "missing";
  }
};

/** The files named by the `imports` of a score, directly and through other libraries, as far as they can be read. */
function libraryFiles(text: string, scorePath: string, allowDirs: readonly string[]): string[] {
  let raw: unknown;
  try { raw = (parseYaml(text) as { imports?: unknown } | null)?.imports; } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const direct = raw.flatMap((entry: unknown) => {
    const from = (entry as { from?: unknown } | null)?.from;
    return typeof from === "string" ? [resolve(dirname(scorePath), from)] : [];
  });
  try {
    return [...direct, ...libraryClosure(scorePath, readImportEntries(raw), allowDirs).map((lib) => lib.file)];
  } catch {
    return direct;
  }
}

/** Runs until `signal` aborts; then stops playback and resolves. */
export async function watchScore(options: WatchOptions): Promise<WatchSummary> {
  const cwd = options.cwd ?? process.cwd();
  const file = options.file;
  const path = resolve(cwd, file);
  const allowDirs = options.allowDirs ?? [];
  const debounce = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const summary: WatchSummary = { builds: 0, errors: 0, ok: false };

  const signatures = new Map<string, string>();
  const watchers = new Map<string, FSWatcher>();
  /** The content of every file the last build read, as it was before the build read it. */
  let built = new Map<string, string>();
  let current: Playback | undefined;
  /** The playback before one that failed to start: a device may still be playing it. */
  let replaced: Playback | undefined;
  let timer: NodeJS.Timeout | undefined;
  let changeSeen: number | undefined;
  let working: Promise<void> | undefined;
  let again = false;
  let ended = false;
  let fail!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; });

  const emit = (event: WatchEvent) => { if (!ended) options.onEvent(event); };

  /** True when a watched file differs from what was last seen. */
  const changed = (): boolean => {
    let any = false;
    for (const [watched, signature] of signatures) {
      const now = signatureOf(watched);
      if (now !== signature) {
        signatures.set(watched, now);
        any = true;
      }
    }
    return any;
  };

  const schedule = () => {
    if (ended) return;
    changeSeen ??= performance.now();
    clearTimeout(timer);
    timer = setTimeout(run, debounce);
  };

  const check = () => { if (changed()) schedule(); };

  const follow = (files: string[]) => {
    for (const watched of files) if (!signatures.has(watched)) signatures.set(watched, signatureOf(watched));
    for (const dir of new Set(files.map((f) => dirname(f)))) {
      if (watchers.has(dir)) continue;
      try {
        // Every event of the directory leads to a look at the watched files only; other files are ignored that way.
        const watcher = watch(dir, check);
        watcher.on("error", (error) => {
          if (dir === dirname(path)) fail(new SidwaveOperationError("input", `cannot watch ${dir}: ${error.message}`, { file: dir }));
          else {
            // The directory of a sample or library went away; it is watched again when a build reads from it.
            watcher.close();
            watchers.delete(dir);
          }
        });
        watchers.set(dir, watcher);
      } catch (error) {
        if (dir === dirname(path)) throw new SidwaveOperationError("input", `cannot watch ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: dir });
      }
    }
  };

  /** Starts `tune` in place of what plays and returns the event that says so. */
  const startPlayback = async (tune: PlayTune, seen: number): Promise<WatchEvent | undefined> => {
    replaced = current ?? replaced;
    await current?.stop("replace");
    current = undefined;
    if (ended) return undefined;
    try {
      const playback = options.player!.play(tune);
      current = playback;
      await playback.started;
      replaced = undefined;
      return { type: "playing", latencyMs: Math.round(performance.now() - seen), detail: playback.detail, startBar: tune.startBar, loop: tune.loop };
    } catch (error) {
      current = undefined;
      return { type: "playback-error", message: classifyError(error).message };
    }
  };

  /** Reports the end of a playback that nothing has replaced. */
  const followEnd = (playback: Playback) => {
    playback.done.then(
      () => { if (current === playback) emit({ type: "finished" }); },
      (error: unknown) => { if (current === playback) emit({ type: "playback-error", message: classifyError(error).message }); },
    );
  };

  /** Watches `watched` from now on and returns what it holds; call it before the content is used. */
  const note = (watched: string): string => {
    follow([watched]);
    return contentOf(watched);
  };

  const rebuild = async (seen: number): Promise<void> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") emit({ type: "playback-error", message: `cannot read ${file}: ${(error as Error).message}` });
      else {
        built = new Map();
        emit({ type: "missing", file });
      }
      return;
    }
    // A save without a change (or a change of another file in the directory) does not restart the music.
    if (built.get(path) === hashOf(text) && [...built].every(([watched, content]) => watched === path || contentOf(watched) === content)) return;
    const reading = new Map([[path, hashOf(text)]]);
    for (const library of libraryFiles(text, path, allowDirs)) reading.set(library, note(library));

    const start = performance.now();
    const read = confinedReadOptions(cwd, allowDirs, path);
    const readFile = read.readFile!;
    let doc: ParsedSidwave | undefined;
    let tune: PlayTune | undefined;
    try {
      doc = parseSidwave(text, {
        ...read,
        readFile: (name) => {
          const sample = resolve(cwd, name);
          reading.set(sample, note(sample));
          return readFile(name);
        },
      });
      const selecting = options.solo?.length || options.mute?.length || options.fromBar !== undefined || options.loopSection !== undefined || (options.song ?? 1) !== 1;
      // The findings are those of the whole score; without a selection the compile for playback provides them.
      const whole = !options.player || selecting || doc.songs ? lintSidwave(doc, options.loop === undefined ? {} : { loop: options.loop }).findings : undefined;
      if (options.player || selecting) {
        tune = buildPlayTune({ kind: "score", format: "sidwave", doc, notes: [] }, { ...options, target: options.target });
      }
      built = reading;
      summary.builds++;
      summary.ok = true;
      const buildMs = Math.round(performance.now() - start);
      // The new tune is started first: finding the places of the lint findings would delay the sound.
      const playing = tune && options.player ? await startPlayback(tune, seen) : undefined;
      const findings = whole ?? tune!.compiled!.lint ?? [];
      const locator = findings.length ? scoreLocator(text) : undefined;
      emit({
        type: "ok", file, title: doc.song.title, voices: doc.voices.length, sids: doc.sids.length,
        seconds: tune?.seconds ?? 0, notes: tune?.notes ?? [],
        findings: findings.map((f) => ({ ...f, info: isInfoCode(f.code), ...(locator!.finding(f.first, doc) ?? {}) })),
        buildMs,
      });
      if (playing) emit(playing);
      if (playing?.type === "playing" && current) followEnd(current);
    } catch (error) {
      const report = classifyError(error);
      const where = error instanceof SidwaveValidationError || report.category === "validation"
        ? scoreLocator(text).path(typeof report.details.path === "string" ? report.details.path : "$") : undefined;
      // After a failure the files of the earlier build still count: the fix may be in one that was not reached.
      for (const [watched, content] of built) if (!reading.has(watched)) reading.set(watched, content === "missing" ? content : contentOf(watched));
      built = reading;
      summary.errors++;
      summary.ok = false;
      emit({
        type: "error", file, message: report.message, category: report.category, keptPlaying: current !== undefined,
        ...(typeof report.details.path === "string" ? { path: report.details.path } : {}), ...(where ?? {}),
      });
    }
  };

  const run = () => {
    if (ended) return;
    if (working) { again = true; return; }
    const seen = changeSeen ?? performance.now();
    changeSeen = undefined;
    working = rebuild(seen).catch(fail).finally(() => {
      working = undefined;
      if (again) {
        again = false;
        run();
      } else check();
    });
  };

  const aborted = new Promise<void>((resolveAbort) => {
    if (options.signal.aborted) resolveAbort();
    else options.signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });

  try {
    // A score that cannot be read at the start is an error; later it only means that it is being replaced.
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file });
    }
    follow([path]);
    if (!options.signal.aborted) run();
    await Promise.race([aborted, failed]);
  } finally {
    ended = true;
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    // Stopping first releases a rebuild that waits for the player to start.
    const report = (error: unknown) => options.onEvent({ type: "playback-error", message: classifyError(error).message });
    const stopped = current;
    await stopped?.stop("end").catch(report);
    await working;
    const left = current ?? replaced;
    if (left !== stopped) await left?.stop("end").catch(report);
  }
  return summary;
}
