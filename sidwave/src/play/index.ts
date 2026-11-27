// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Playing, previewing and watching: the library behind `sidwave play` and `sidwave watch`.

export { readPlaySource, buildPlayTune, type PlaySource, type PlayTune, type SourceOptions, type TuneOptions } from "./source.js";
export { selectScore, selectVoices, type ScoreSelection, type SelectedScore } from "./select.js";
export { openPlayTarget, type PlayTargetHandle, type TargetOptions } from "./session.js";
export { startLocalPlayback, findAudioPlayer, AUDIO_PLAYERS, type AudioPlayer, type LocalPlaybackOptions } from "./local.js";
export { startVicePlayback, findVice, viceArguments, VICE_SID_PROGRAMS, VICE_PRG_PROGRAMS, type ViceProgram, type VicePlaybackOptions } from "./vice.js";
export { startUltimatePlayback, ultimatePlay, ultimateReset, ultimateBaseUrl, ULTIMATE_PASSWORD_VARIABLE, type UltimateDevice, type UltimatePlaybackOptions } from "./ultimate.js";
export { watchScore, DEFAULT_DEBOUNCE_MS, type WatchEvent, type WatchFinding, type WatchOptions, type WatchSummary } from "./watch.js";
export { scoreLocator, type Position } from "./positions.js";
export { liveChildCount } from "./children.js";
export type { Playback, PlayTarget } from "./types.js";
