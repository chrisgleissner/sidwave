// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

import { SidwaveOperationError } from "../cliCore.js";
import { createLibsidplayfpEngine } from "../engine/libsidplayfp.js";
import type { SidEmulation, SidEngine } from "../engine/types.js";
import { findAudioPlayer, startLocalPlayback, type AudioPlayer } from "./local.js";
import type { PlayTune } from "./source.js";
import { findVice, startVicePlayback } from "./vice.js";
import { startUltimatePlayback, ultimateBaseUrl, type UltimateDevice } from "./ultimate.js";
import type { Playback } from "./types.js";

export type TargetOptions =
  | { kind: "local"; player?: string; sampleRate?: number; model?: "6581" | "8580"; emulation?: SidEmulation; createEngine?: (emulation: SidEmulation) => SidEngine }
  | { kind: "vice"; vice?: string; viceArgs?: readonly string[] }
  | { kind: "u64"; device: UltimateDevice; detach?: boolean };

export interface PlayTargetHandle {
  /** Starts playing `tune`. `seconds` limits the playback; without it a looping tune plays until stop(). */
  play(tune: PlayTune, options?: { seconds?: number }): Playback;
}

/** A day: "until stopped" for the local engine, which renders a given length. */
const UNLIMITED_SECONDS = 86_400;
/** Added to one pass of a score so that its last player call is heard. */
const END_TAIL_SECONDS = 0.25;

/**
 * Prepares a target: finds the audio player or checks the host at once, so that a missing program fails before anything
 * is compiled or watched. One handle can play many tunes; the local engine is loaded once.
 */
export function openPlayTarget(options: TargetOptions, cwd: string = process.cwd()): PlayTargetHandle {
  const length = (tune: PlayTune, seconds: number | undefined): number | undefined =>
    seconds ?? (tune.loop || tune.seconds === undefined ? undefined : tune.seconds + END_TAIL_SECONDS);

  if (options.kind === "local") {
    const player: AudioPlayer = findAudioPlayer(options.player, { cwd });
    const emulation = options.emulation ?? "residfp";
    const engine = options.createEngine ? options.createEngine(emulation) : createLibsidplayfpEngine({ emulation });
    return {
      play(tune, { seconds } = {}) {
        if (!tune.sid) throw new SidwaveOperationError("input", `the local engine cannot play this tune: ${tune.sidUnavailable}. Use --target vice or u64`);
        // The default length counts from --from-bar, not from the start of its section.
        const full = length(tune, undefined);
        return startLocalPlayback({
          sid: tune.sid, engine, player, skipSeconds: tune.skipSeconds,
          seconds: seconds ?? (full === undefined ? UNLIMITED_SECONDS : Math.max(END_TAIL_SECONDS, full - tune.skipSeconds)),
          ...(tune.song === undefined ? {} : { song: tune.song }),
          ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
          ...(options.model ? { model: options.model } : {}),
        });
      },
    };
  }
  if (options.kind === "vice") {
    // Which program is needed depends on the tune; check here that there is one at all.
    findVice(options.vice, { sid: true, prg: true }, { cwd });
    return {
      play(tune, { seconds } = {}) {
        const program = findVice(options.vice, { sid: tune.sid !== undefined, prg: tune.prg !== undefined }, { cwd });
        const duration = length(tune, seconds);
        return startVicePlayback({
          program, bytes: program.mode === "sid" ? tune.sid! : tune.prg!, sids: tune.sids,
          ...(tune.song === undefined ? {} : { song: tune.song }), ...(tune.clock ? { clock: tune.clock } : {}),
          ...(duration === undefined ? {} : { seconds: duration }), ...(options.viceArgs ? { extraArgs: options.viceArgs } : {}),
        });
      },
    };
  }
  ultimateBaseUrl(options.device.host);
  return {
    play(tune, { seconds } = {}) {
      const duration = length(tune, seconds);
      // A score with samples or more than three SIDs is run as a PRG.
      const upload = tune.sid
        ? { kind: "sid" as const, bytes: tune.sid, ...(tune.song === undefined ? {} : { song: tune.song }) }
        : { kind: "prg" as const, bytes: tune.prg! };
      return startUltimatePlayback({ device: options.device, tune: upload, ...(duration === undefined ? {} : { seconds: duration }), ...(options.detach ? { detach: true } : {}) });
    },
  };
}
