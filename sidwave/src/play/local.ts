// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The local target: the libsidplayfp engine renders in slices of 20 ms into the standard input of an audio player that
// is installed on the system. The player's consumption paces the render, so sound starts after the first slice.

import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { SidwaveOperationError } from "../cliCore.js";
import type { SidClock, SidEngine } from "../engine/types.js";
import { exitOf, outputTail, spawnTracked, stopChild } from "./children.js";
import { deferred, type Playback } from "./types.js";

export interface AudioPlayer {
  name: string;
  /** Path of the program. */
  command: string;
  /** "raw": 16-bit little-endian mono PCM on standard input. "wav": the same after a WAV header of unknown length. */
  input: "raw" | "wav";
  args(sampleRate: number): string[];
}

type PlayerKind = Omit<AudioPlayer, "name" | "command">;

const PLAYERS: Record<string, PlayerKind> = {
  paplay: { input: "raw", args: (rate) => ["--raw", "--format=s16le", `--rate=${rate}`, "--channels=1", "--latency-msec=100"] },
  // pw-play before PipeWire 1.4 has no raw mode; every version reads a WAV from standard input.
  "pw-play": { input: "wav", args: () => ["--latency=100ms", "-"] },
  aplay: { input: "raw", args: (rate) => ["-q", "-t", "raw", "-f", "S16_LE", "-r", String(rate), "-c", "1", "--buffer-time=150000", "-"] },
  ffplay: { input: "wav", args: () => ["-nodisp", "-autoexit", "-loglevel", "error", "-fflags", "nobuffer", "-probesize", "32", "-i", "-"] },
  mpv: { input: "wav", args: () => ["--no-video", "--really-quiet", "--cache=no", "-"] },
  play: { input: "raw", args: (rate) => ["-q", "-t", "raw", "-e", "signed", "-b", "16", "-r", String(rate), "-c", "1", "-"] },
};

/** The players that are searched for on PATH, in this order. */
export const AUDIO_PLAYERS: readonly string[] = Object.keys(PLAYERS);

function isProgram(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The path of `name` in the directories of PATH, or undefined. */
export function findOnPath(name: string, pathValue: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isProgram(candidate)) return candidate;
  }
  return undefined;
}

/** Resolves a program given by name or path, relative to `cwd`; undefined when there is no such program. */
export function findProgram(nameOrPath: string, cwd: string, pathValue?: string): string | undefined {
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || isAbsolute(nameOrPath)) {
    const path = resolve(cwd, nameOrPath);
    return isProgram(path) ? path : undefined;
  }
  return findOnPath(nameOrPath, pathValue);
}

/**
 * The audio player to use: `choice` (a name or a path), else the SIDWAVE_PLAYER environment variable, else the first of
 * AUDIO_PLAYERS on PATH. A program with another name receives a WAV stream on standard input and no arguments.
 */
export function findAudioPlayer(choice?: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): AudioPlayer {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const wanted = choice ?? (env.SIDWAVE_PLAYER || undefined);
  if (wanted !== undefined) {
    const command = findProgram(wanted, cwd, env.PATH);
    if (!command) {
      throw new SidwaveOperationError("engine_unavailable", `audio player "${wanted}" was not found or is not executable; give a path or the name of a program on PATH with --player`);
    }
    const name = basename(command).replace(/\.exe$/i, "");
    const kind: PlayerKind = Object.prototype.hasOwnProperty.call(PLAYERS, name) ? PLAYERS[name]! : { input: "wav", args: () => [] };
    return { name, command, ...kind };
  }
  for (const name of AUDIO_PLAYERS) {
    const command = findOnPath(name, env.PATH);
    if (command) return { name, command, ...PLAYERS[name]! };
  }
  throw new SidwaveOperationError("engine_unavailable", `no audio player found on PATH (looked for ${AUDIO_PLAYERS.join(", ")}); install one, name one with --player, or use --target vice`);
}

/** A WAV header whose sizes say "until the end of the stream". */
export function streamingWavHeader(sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

export interface LocalPlaybackOptions {
  sid: Uint8Array;
  /** 1-based song of the SID file. */
  song?: number;
  /** Seconds of sound to play. */
  seconds: number;
  /** Seconds rendered and discarded before the sound starts (--from-bar inside a section). */
  skipSeconds?: number;
  sampleRate?: number;
  model?: "6581" | "8580";
  clock?: SidClock;
  engine: SidEngine;
  player: AudioPlayer;
}

export function startLocalPlayback(options: LocalPlaybackOptions): Playback {
  const { player, engine } = options;
  const sampleRate = options.sampleRate ?? 44_100;
  const skipSeconds = options.skipSeconds ?? 0;
  const started = deferred();
  const done = deferred();
  const abort = new AbortController();
  let stopped = false;

  const child = spawnTracked(player.command, player.args(sampleRate), { stdio: ["pipe", "ignore", "pipe"] });
  const stdin = child.stdin!;
  // A player that ends early breaks the pipe; its exit status tells what happened.
  stdin.on("error", () => abort.abort());
  const tail = outputTail(child);
  const exited = exitOf(child);
  void exited.then(() => abort.abort());

  /** Writes and, when the pipe is full, waits until the player has taken the data or playback ends. */
  const write = (bytes: Uint8Array): Promise<void> | void => {
    if (abort.signal.aborted || stdin.destroyed || stdin.write(bytes)) return;
    return new Promise<void>((resolveWrite) => {
      const finish = () => {
        stdin.off("drain", finish);
        abort.signal.removeEventListener("abort", finish);
        resolveWrite();
      };
      stdin.once("drain", finish);
      abort.signal.addEventListener("abort", finish);
    });
  };

  const run = async (): Promise<void> => {
    let skip = Math.round(skipSeconds * sampleRate);
    let sounding = false;
    let renderFailure: unknown;
    if (player.input === "wav") await write(streamingWavHeader(sampleRate));
    const total = skipSeconds + options.seconds;
    try {
      await engine.render({
        sid: options.sid, seconds: total, maxSeconds: total, sampleRate, channels: 1, signal: abort.signal,
        ...(options.song === undefined ? {} : { song: options.song }),
        ...(options.model ? { model: options.model } : {}), ...(options.clock ? { clock: options.clock } : {}),
        onSamples: async (samples) => {
          const from = Math.min(skip, samples.length);
          skip -= from;
          if (from === samples.length) return;
          // Int16Array is little-endian on every platform Node and Bun run on here.
          const bytes = Buffer.from(samples.buffer, samples.byteOffset + from * 2, (samples.length - from) * 2);
          const pending = write(Buffer.from(bytes));
          if (!sounding) {
            sounding = true;
            started.resolve();
          }
          await pending;
        },
      });
    } catch (error) {
      if (!abort.signal.aborted) renderFailure = error;
    }
    if (renderFailure !== undefined) {
      await stopChild(child);
      throw renderFailure;
    }
    if (!stdin.destroyed) stdin.end();
    const exit = await exited;
    // An interrupt from the terminal reaches the player as well as this process.
    const interrupted = exit.signal === "SIGINT" || exit.signal === "SIGTERM" || exit.signal === "SIGHUP";
    if (!stopped && (exit.error !== undefined || (exit.code !== 0 && !interrupted))) {
      const how = exit.error ? exit.error.message : exit.signal ? `ended by ${exit.signal}` : `exited with status ${exit.code}`;
      throw new SidwaveOperationError("engine_unavailable", `audio player ${player.name} ${how}${tail() ? `: ${tail()}` : ""}`);
    }
  };

  const finished = run().then(
    () => { started.resolve(); done.resolve(); },
    (error: unknown) => { started.reject(error); done.reject(error); },
  );

  return {
    started: started.promise,
    done: done.promise,
    detail: `local audio through ${player.name}`,
    async stop() {
      stopped = true;
      abort.abort();
      await stopChild(child);
      await finished;
    },
  };
}
