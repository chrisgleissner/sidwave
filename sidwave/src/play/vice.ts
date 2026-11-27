// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The VICE target: vsid plays a PSID; x64sc (or x64) runs the PRG. The emulator is a child process of this one, runs
// without a window (-console) and is ended when playback stops.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SidwaveOperationError } from "../cliCore.js";
import type { SidClock } from "../engine/types.js";
import { exitOf, makeTempDir, outputTail, removeTempDir, spawnTracked, stopChild } from "./children.js";
import { findOnPath, findProgram } from "./local.js";
import { deferred, type Playback } from "./types.js";

/** Programs that play a SID file, and programs that run a PRG, in the order they are searched for on PATH. */
export const VICE_SID_PROGRAMS: readonly string[] = ["vsid", "x64sid"];
export const VICE_PRG_PROGRAMS: readonly string[] = ["x64sc", "x64"];

export interface ViceProgram { command: string; mode: "sid" | "prg" }

/**
 * The VICE program to use: `choice` (a name or a path), else the SIDWAVE_VICE environment variable, else the first
 * suitable program on PATH. A program whose name contains "sid" is given the SID file, any other the PRG. `available`
 * says which of the two files the tune has.
 */
export function findVice(choice: string | undefined, available: { sid: boolean; prg: boolean }, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ViceProgram {
  const env = options.env ?? process.env;
  const wanted = choice ?? (env.SIDWAVE_VICE || undefined);
  if (wanted !== undefined) {
    const command = findProgram(wanted, options.cwd ?? process.cwd(), env.PATH);
    if (!command) throw new SidwaveOperationError("engine_unavailable", `VICE program "${wanted}" was not found or is not executable; check --vice or SIDWAVE_VICE`);
    const mode = /sid/i.test(basename(command)) ? "sid" : "prg";
    if (!available[mode]) {
      throw new SidwaveOperationError("input", mode === "sid"
        ? `${basename(command)} plays SID files and this tune cannot be one; use x64sc`
        : `${basename(command)} runs PRG files and a SID file is not one; use vsid`);
    }
    return { command, mode };
  }
  for (const mode of ["sid", "prg"] as const) {
    if (!available[mode]) continue;
    for (const name of mode === "sid" ? VICE_SID_PROGRAMS : VICE_PRG_PROGRAMS) {
      const command = findOnPath(name, env.PATH);
      if (command) return { command, mode };
    }
  }
  const names = [...(available.sid ? VICE_SID_PROGRAMS : []), ...(available.prg ? VICE_PRG_PROGRAMS : [])];
  throw new SidwaveOperationError("engine_unavailable", `no VICE program found on PATH (looked for ${names.join(", ")}); install VICE or name the program with --vice`);
}

export interface VicePlaybackOptions {
  program: ViceProgram;
  /** The SID file or the PRG, according to program.mode. */
  bytes: Uint8Array;
  /** 1-based song of a SID file. */
  song?: number;
  /** Seconds after which VICE is stopped; without it VICE runs until stop(). */
  seconds?: number;
  clock?: SidClock;
  sids?: ReadonlyArray<{ address: number; model?: string }>;
  /** Further arguments, placed after the ones of this module so that they take precedence. */
  extraArgs?: readonly string[];
  /** Test hook: seconds allowed for the start of the emulator on top of `seconds`. */
  startupSeconds?: number;
}

/** The arguments of the VICE command line for a tune stored in `file`. */
export function viceArguments(options: VicePlaybackOptions, file: string): string[] {
  const common = ["+saveres", "+warp", "-console"];
  const extra = options.extraArgs ?? [];
  if (options.program.mode === "sid") {
    return [...common, ...(options.song === undefined ? [] : ["-tune", String(options.song)]), ...extra, file];
  }
  const sids = options.sids ?? [];
  const machine = [options.clock === "NTSC" ? "-ntsc" : "-pal"];
  const model = sids[0]?.model;
  if (model) machine.push("-sidenginemodel", model === "8580" ? "257" : "256");
  if (sids.length > 1) {
    // VICE places SID 1 at $D400 and takes the addresses of up to three more.
    const others = sids.filter((sid) => sid.address !== 0xd400).slice(0, 3);
    machine.push("-sidextra", String(others.length));
    others.forEach((sid, i) => machine.push(`-sid${i + 2}address`, `0x${sid.address.toString(16)}`));
  }
  return [...common, ...machine, "-autostartprgmode", "1", ...extra, "-autostart", file];
}

export function startVicePlayback(options: VicePlaybackOptions): Playback {
  const started = deferred();
  const done = deferred();
  const dir = makeTempDir();
  const file = join(dir, options.program.mode === "sid" ? "tune.sid" : "tune.prg");
  writeFileSync(file, options.bytes);
  const child = spawnTracked(options.program.command, viceArguments(options, file), { stdio: ["ignore", "pipe", "pipe"] });
  const tail = outputTail(child);
  const name = basename(options.program.command);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  child.once("spawn", () => {
    started.resolve();
    if (options.seconds !== undefined) {
      // The emulator needs this long before it sounds; x64sc boots BASIC first.
      const startup = options.startupSeconds ?? (options.program.mode === "sid" ? 1 : 2.5);
      timer = setTimeout(() => { stopped = true; void stopChild(child); }, Math.min(2_147_000_000, (options.seconds + startup) * 1000));
    }
  });
  const finished = exitOf(child).then((exit) => {
    clearTimeout(timer);
    removeTempDir(dir);
    const interrupted = exit.signal === "SIGINT" || exit.signal === "SIGTERM" || exit.signal === "SIGHUP";
    if (stopped || (exit.error === undefined && (exit.code === 0 || interrupted))) {
      started.resolve();
      done.resolve();
      return;
    }
    const how = exit.error ? `could not be started: ${exit.error.message}` : exit.signal ? `ended by ${exit.signal}` : `exited with status ${exit.code}`;
    const error = new SidwaveOperationError("engine_unavailable", `${name} ${how}${tail() ? `: ${tail().split("\n").slice(-4).join(" | ")}` : ""}`);
    started.reject(error);
    done.reject(error);
  });
  return {
    started: started.promise,
    done: done.promise,
    detail: `VICE (${name})`,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await stopChild(child, 1000);
      await finished;
    },
  };
}
