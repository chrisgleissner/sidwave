// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

export type PlayTarget = "local" | "vice" | "u64";

/** One running playback. */
export interface Playback {
  /**
   * Resolves when the target has the tune: the first audio was handed to the player, VICE was started, or the device
   * accepted the upload. Rejects when playback could not start.
   */
  readonly started: Promise<void>;
  /** Resolves when playback ended, by itself or through stop(). Rejects when the player or the device failed. */
  readonly done: Promise<void>;
  /**
   * Stops playback and waits until every process it started has ended. Safe to call more than once. "replace" says
   * that another tune follows at once, so a device is not reset in between.
   */
  stop(reason?: "end" | "replace"): Promise<void>;
  /** The target in words, for example "local audio through paplay". */
  readonly detail: string;
}

/** A promise with its resolve functions, which counts as handled even when nobody waits for it. */
export function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
