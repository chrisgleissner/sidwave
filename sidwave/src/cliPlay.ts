// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// `sidwave play` and `sidwave watch`. Arguments and output only; the work is done by the functions of play/.

import { resolve } from "node:path";
import { EXIT_CODES, EXIT_INPUT, EXIT_OK, SidwaveOperationError, UsageError, classifyError, envelope, type CliIo } from "./cliCore.js";
import { last, parseFlags, parseInteger, parseNumber, splitList, type ParsedFlags } from "./cliAuthoring.js";
import { confinedReadOptions } from "./sidwaveOps.js";
import { readInput } from "./sidwaveTools.js";
import { openPlayTarget, type PlayTargetHandle, type TargetOptions } from "./play/session.js";
import { buildPlayTune, readPlaySource, type TuneOptions } from "./play/source.js";
import { ULTIMATE_PASSWORD_VARIABLE } from "./play/ultimate.js";
import { watchScore, type WatchEvent } from "./play/watch.js";
import type { PlayTarget } from "./play/types.js";

export const PLAY_USAGE = `  sidwave play     <file> [--target local|vice|u64] [--host <h>] [options]   (see "sidwave play --help")
  sidwave watch    <score> [--loop-section <name>] [--no-play] [options]     (see "sidwave watch --help")
`;

const SHARED_OPTIONS = `Targets:
  --target local             (default) The libsidplayfp engine renders into an audio player of the system: paplay,
                             pw-play, aplay, ffplay, mpv or sox (play), the first one found on PATH.
      --player <name|path>       Use this player (or SIDWAVE_PLAYER). A program with another name gets a WAV stream on
                                 standard input.
      --model 6581|8580          Force the SID model.
      --engine residfp|sidlite   Emulation (default residfp; sidlite needs less CPU).
      --rate <hz>                Sample rate (default 44100).
  --target vice              VICE as a child process without a window: vsid for SID files, x64sc or x64 for the PRG of
                             a score that cannot be a SID file. It is ended when playback ends or on Ctrl-C.
      --vice <name|path>         Use this program (or SIDWAVE_VICE).
      --vice-arg <arg>           Pass an argument to VICE; may be repeated.
  --target u64 --host <h>    An Ultimate 64, C64 Ultimate or Ultimate-II through its REST API: the tune is uploaded and
                             started, and the machine is reset when playback ends or on Ctrl-C. Nothing is sent to any
                             device without --target u64 and --host. The network password is read from the
                             environment variable ${ULTIMATE_PASSWORD_VARIABLE}.

What is played:
  --song <n>                 Song of a score or SID file, 1 is the first (as for render and convert).
  --solo <v>,...             Only these voices (ids, names or digi ids such as d1). Scores and imported files only.
  --mute <v>,...             All voices but these.
  --loop-section <name>      One section of the timeline (a name, or its position, 1 is the first) in a loop.
  --allow-dir <dir>          Allow "file:" samples and library files below <dir>. May be repeated.
`;

export const PLAY_HELP = `sidwave play: play a score, a SID file or any file that convert reads

Usage:
  sidwave play <file> [--target local|vice|u64] [options]

A SIDWave score is compiled and played once. A SID file (PSID or RSID) plays until Ctrl-C. Other files (MIDI,
MusicXML, ABC, GoatTracker, Furnace, SID-Wizard, MOD, ...) are imported as by "sidwave convert" and then played. Ctrl-C
stops the sound, ends the player or VICE and exits with status 0.

${SHARED_OPTIONS}  --from-bar <n>             Start at bar <n> of a score. The local target starts exactly there; VICE and the
                             Ultimate start at the first bar of the section that contains it.
  --loop / --no-loop         Repeat the tune until Ctrl-C (default: play a score once).
  --seconds <s>              Stop after <s> seconds.
  --detach                   With --target u64: return once the device has the tune and leave it playing.
  --from <format>            Format of the input, when it cannot be detected.
  --json                     Print a JSON result when playback ends.
  -h, --help                 Show this text.

Examples:
  sidwave play song.yaml
  sidwave play song.yaml --solo 1,2 --from-bar 17
  sidwave play song.yaml --loop-section chorus --mute 3
  sidwave play tune.sid --song 2 --seconds 30
  sidwave play melody.mid --target vice
  sidwave play song.yaml --target u64 --host 192.168.1.20 --detach

Exit codes: 0 played or stopped; 2 usage; 3 unreadable or invalid input; 4 no player, no VICE or the device did not
accept the tune; 5 a limit was exceeded.
`;

export const WATCH_HELP = `sidwave watch: compile a score on every save, report problems and restart playback

Usage:
  sidwave watch <score> [--target local|vice|u64] [options]

The score, the samples it reads and the libraries it imports are watched, also when an editor saves by renaming a new
file over the old one. A valid version restarts playback; an invalid one is reported with file:line:column and the last
valid version keeps playing. Lint findings are listed with their place. Ctrl-C ends the watch and the playback.

${SHARED_OPTIONS}  --from-bar <n>             Start at bar <n> (local target; VICE and the Ultimate start at the section).
  --loop / --no-loop         The tune repeats (default) or plays once per save. A score with "end" plays once.
  --no-play                  Only check: compile and lint, play nothing, need no player.
  --debounce <ms>            Quiet time after the last change before the file is read (default 60).
  --json                     One JSON object per line for every event (ok, error, playing, finished, missing,
                             playback-error), then a final result object. For editors and tools.
  -h, --help                 Show this text.

Examples:
  sidwave watch song.yaml
  sidwave watch song.yaml --loop-section verse
  sidwave watch song.yaml --solo 1 --target vice
  sidwave watch song.yaml --no-play --json

Exit codes: 0 stopped with Ctrl-C (--no-play: 3 when the last version was invalid); 2 usage; 3 the score cannot be
read; 4 no player, no VICE.
`;

const VALUE_FLAGS = ["--target", "--host", "--player", "--model", "--engine", "--rate", "--vice", "--vice-arg", "--song", "--solo", "--mute",
  "--from-bar", "--loop-section", "--allow-dir"];

function oneOf<T extends string>(flag: string, text: string, values: readonly T[]): T {
  if (!values.includes(text as T)) throw new UsageError(`${flag} must be one of ${values.join(", ")}, not "${text}"`);
  return text as T;
}

interface Selected { tune: Omit<TuneOptions, "file">; target: () => TargetOptions; allowDirs: string[] }

/** The options both commands share. */
function sharedOptions(io: CliIo, p: ParsedFlags): Selected {
  const kind: PlayTarget = oneOf("--target", last(p, "--target") ?? "local", ["local", "vice", "u64"] as const);
  const only = (target: PlayTarget, flags: string[]) => {
    for (const flag of flags) {
      if (kind !== target && (p.values.has(flag) || p.flags.has(flag))) throw new UsageError(`${flag} applies to --target ${target} only`);
    }
  };
  only("u64", ["--host", "--detach"]);
  only("local", ["--player", "--model", "--engine", "--rate"]);
  only("vice", ["--vice", "--vice-arg"]);
  const host = last(p, "--host");
  if (kind === "u64" && !host) throw new UsageError("--target u64 needs --host <name or address>");
  const number = (flag: string) => (p.values.has(flag) ? parseInteger(flag, last(p, flag)!, 1) : undefined);
  const list = (flag: string) => (p.values.get(flag) ?? []).flatMap(splitList);
  for (const flag of ["--solo", "--mute"]) if (p.values.has(flag) && list(flag).length === 0) throw new UsageError(`${flag} needs voice ids separated by commas, for example 1,3`);
  if (p.values.has("--solo") && p.values.has("--mute")) throw new UsageError("use --solo or --mute, not both");
  if (p.values.has("--from-bar") && p.values.has("--loop-section")) throw new UsageError("use --from-bar or --loop-section, not both");
  if (p.flags.has("--loop") && p.flags.has("--no-loop")) throw new UsageError("use --loop or --no-loop, not both");
  if (p.flags.has("--no-loop") && p.values.has("--loop-section")) throw new UsageError("--loop-section loops; leave out --no-loop");
  const song = number("--song"), fromBar = number("--from-bar"), loopSection = last(p, "--loop-section");
  const tune: Omit<TuneOptions, "file"> = {
    target: kind, ...(song === undefined ? {} : { song }), ...(fromBar === undefined ? {} : { fromBar }), ...(loopSection === undefined ? {} : { loopSection }),
    ...(p.values.has("--solo") ? { solo: list("--solo") } : {}), ...(p.values.has("--mute") ? { mute: list("--mute") } : {}),
  };
  const target = (): TargetOptions => {
    if (kind === "vice") {
      const vice = last(p, "--vice");
      return { kind, ...(vice === undefined ? {} : { vice }), viceArgs: p.values.get("--vice-arg") ?? [] };
    }
    if (kind === "u64") {
      const password = process.env[ULTIMATE_PASSWORD_VARIABLE];
      return { kind, device: { host: host!, ...(password ? { password } : {}) }, detach: p.flags.has("--detach") };
    }
    const player = last(p, "--player"), model = last(p, "--model"), engine = last(p, "--engine"), rate = last(p, "--rate");
    return {
      kind, ...(player === undefined ? {} : { player }),
      ...(model === undefined ? {} : { model: oneOf("--model", model, ["6581", "8580"] as const) }),
      ...(engine === undefined ? {} : { emulation: oneOf("--engine", engine, ["residfp", "sidlite"] as const) }),
      ...(rate === undefined ? {} : { sampleRate: parseInteger("--rate", rate, 4000, 192_000) }),
      ...(io.createEngine ? { createEngine: io.createEngine } : {}),
    };
  };
  return { tune, target, allowDirs: p.values.get("--allow-dir") ?? [] };
}

/**
 * A signal that aborts on Ctrl-C (through io.signal, or SIGINT itself when the caller provides none), SIGTERM and
 * SIGHUP, so that every way of ending the command stops the playback first.
 */
function stopSignal(io: CliIo): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals: NodeJS.Signals[] = io.signal ? ["SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of signals) process.on(name, abort);
  if (io.signal?.aborted) abort();
  io.signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    release() {
      for (const name of signals) process.off(name, abort);
      io.signal?.removeEventListener("abort", abort);
    },
  };
}

async function report(command: string, args: readonly string[], io: CliIo, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const failure = classifyError(error);
    // The output of watch is one JSON object per line.
    if (args.includes("--json")) io.out(`${JSON.stringify(envelope(command, false, { error: failure }), null, command === "watch" ? undefined : 2)}\n`);
    else if (failure.category === "usage") io.err(`sidwave: ${failure.message}\nRun "sidwave ${command} --help" for usage.\n`);
    else if (failure.category === "validation" && typeof failure.details.file === "string") io.err(`${failure.details.file}: ${failure.message}\n`);
    else io.err(`sidwave: ${failure.message}\n`);
    return EXIT_CODES[failure.category];
  }
}

/** `sidwave play`. `args` excludes the command name. */
export function runPlayCli(args: string[], io: CliIo): Promise<number> {
  return report("play", args, io, async () => {
    const p = parseFlags(args, { value: [...VALUE_FLAGS, "--seconds", "--from"], bool: ["--loop", "--no-loop", "--detach"] });
    if (p.help) { io.out(PLAY_HELP); return EXIT_OK; }
    if (p.positional.length !== 1) throw new UsageError("play needs exactly one file");
    const file = p.positional[0]!;
    const options = sharedOptions(io, p);
    const seconds = p.values.has("--seconds") ? parseNumber("--seconds", last(p, "--seconds")!) : undefined;
    if (seconds !== undefined && seconds <= 0) throw new UsageError("--seconds needs a number above 0");
    if (p.flags.has("--detach") && seconds !== undefined) throw new UsageError("--detach leaves the machine playing; --seconds does not apply");
    const target = openPlayTarget(options.target(), io.cwd);
    const bytes = readInput(file, { cwd: io.cwd });
    const stop = stopSignal(io);
    try {
      const source = await readPlaySource(bytes, {
        name: file, readOptions: confinedReadOptions(io.cwd, options.allowDirs, resolve(io.cwd, file)), signal: stop.signal,
        notice: (message) => io.err(`${message}\n`), ...(options.tune.song === undefined ? {} : { song: options.tune.song }),
        ...(io.createEngine ? { createEngine: io.createEngine } : {}), ...(last(p, "--from") === undefined ? {} : { from: last(p, "--from")! }),
      });
      const tune = buildPlayTune(source, { ...options.tune, loop: p.flags.has("--loop"), file });
      for (const note of tune.notes) io.err(`note: ${note}\n`);
      if (stop.signal.aborted) return EXIT_OK;
      const playback = target.play(tune, seconds === undefined ? {} : { seconds });
      const interrupt = new Promise<"interrupted">((done) => {
        if (stop.signal.aborted) done("interrupted");
        else stop.signal.addEventListener("abort", () => done("interrupted"), { once: true });
      });
      let ended: "finished" | "interrupted" | "detached";
      try {
        const first = await Promise.race([playback.started.then(() => "started" as const), interrupt]);
        if (first === "started") {
          const length = seconds ?? (tune.loop || tune.seconds === undefined ? undefined : tune.seconds);
          const detach = p.flags.has("--detach");
          if (!p.json) {
            io.err(`playing ${file} on ${playback.detail}: ${tune.title}${tune.startBar > 1 ? `, from bar ${tune.startBar}` : ""}`
              + `${detach ? "" : length === undefined ? " (Ctrl-C stops)" : `, ${length.toFixed(1)} s (Ctrl-C stops)`}\n`);
          }
          ended = await Promise.race([playback.done.then(() => (detach ? "detached" as const : "finished" as const)), interrupt]);
        } else ended = "interrupted";
      } finally {
        await playback.stop();
      }
      if (ended === "interrupted") await playback.done;
      if (p.json) {
        io.out(`${JSON.stringify(envelope("play", true, { result: {
          file, format: source.format, target: options.tune.target, detail: playback.detail, title: tune.title, startBar: tune.startBar,
          seconds: seconds ?? tune.seconds ?? null, loop: tune.loop, ended, notes: tune.notes,
        } }), null, 2)}\n`);
      }
      return EXIT_OK;
    } finally {
      stop.release();
    }
  });
}

const clock = (): string => new Date().toTimeString().slice(0, 8);

function watchLines(file: string, event: WatchEvent, playing: boolean): string {
  const place = (line?: number, column?: number) => (line === undefined ? file : `${file}:${line}:${column}`);
  switch (event.type) {
    case "ok": {
      const actionable = event.findings.filter((f) => !f.info).length;
      return [
        `[${clock()}] ok: ${event.title}, ${event.voices} voice${event.voices === 1 ? "" : "s"}, ${event.sids} SID${event.sids === 1 ? "" : "s"}${event.seconds ? `, ${event.seconds.toFixed(1)} s` : ""}`
          + `, ${actionable === 0 ? "no lint findings" : `${actionable} lint finding${actionable === 1 ? "" : "s"}`} (${event.buildMs} ms)`,
        ...event.findings.map((f) => `  ${place(f.line, f.column)}: ${f.code}: ${f.message} (${f.count > 1 ? `${f.count} times, first at ` : "at "}${f.first})`),
        ...event.notes.map((note) => `  note: ${note}`),
      ].join("\n");
    }
    case "error": return `[${clock()}] error ${place(event.line, event.column)}: ${event.message}${event.keptPlaying && playing ? " (the last valid version keeps playing)" : ""}`;
    case "playing": return `[${clock()}] playing on ${event.detail}${event.startBar > 1 ? ` from bar ${event.startBar}` : ""}${event.loop ? ", looping" : ""} (${(event.latencyMs / 1000).toFixed(2)} s after the change)`;
    case "finished": return `[${clock()}] finished; save the score to play it again`;
    case "playback-error": return `[${clock()}] playback failed: ${event.message}`;
    case "missing": return `[${clock()}] ${event.file} is missing; waiting for it to return`;
  }
}

/** `sidwave watch`. `args` excludes the command name. */
export function runWatchCli(args: string[], io: CliIo): Promise<number> {
  return report("watch", args, io, async () => {
    const p = parseFlags(args, { value: [...VALUE_FLAGS, "--debounce"], bool: ["--loop", "--no-loop", "--no-play"] });
    if (p.help) { io.out(WATCH_HELP); return EXIT_OK; }
    if (p.positional.length !== 1) throw new UsageError("watch needs exactly one score file");
    const file = p.positional[0]!;
    const options = sharedOptions(io, p);
    const noPlay = p.flags.has("--no-play");
    const debounceMs = p.values.has("--debounce") ? parseInteger("--debounce", last(p, "--debounce")!, 0, 60_000) : undefined;
    let player: PlayTargetHandle | undefined;
    if (!noPlay) player = openPlayTarget(options.target(), io.cwd);
    const first = readInput(file, { cwd: io.cwd });
    const head = Buffer.from(first.subarray(0, 4)).toString("latin1");
    if (head === "PSID" || head === "RSID" || head === "MThd") throw new SidwaveOperationError("input", `watch needs a SIDWave score; ${file} is not one (use "sidwave play", or import it with "sidwave convert")`, { file });
    const stop = stopSignal(io);
    try {
      if (!p.json) io.err(`watching ${file}${noPlay ? " (checking only)" : ""}; Ctrl-C stops\n`);
      const summary = await watchScore({
        ...options.tune, file, cwd: io.cwd, allowDirs: options.allowDirs, signal: stop.signal, loop: !p.flags.has("--no-loop"),
        ...(player ? { player } : {}), ...(debounceMs === undefined ? {} : { debounceMs }),
        onEvent: (event) => io.out(p.json ? `${JSON.stringify(event)}\n` : `${watchLines(file, event, player !== undefined)}\n`),
      });
      if (p.json) io.out(`${JSON.stringify(envelope("watch", summary.ok || !noPlay, { result: { file, ...summary } }))}\n`);
      return noPlay && !summary.ok ? EXIT_INPUT : EXIT_OK;
    } finally {
      stop.release();
    }
  });
}
