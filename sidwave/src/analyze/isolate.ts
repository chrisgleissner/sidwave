// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.

// Diagnostic voice isolation. Method: reconstruct and recompile. The libsidplayfp engine binding can render a tune
// but cannot replay a list of register writes, so a voice cannot be muted by masking its writes in a trace replay.
// The tune is reconstructed as a SIDWave score, the voices to silence get an empty layer in every section, the score is
// compiled and rendered. The result therefore is as exact as the reconstruction (reported), and it is diagnostic audio,
// not a stem of the original player. The result is marked non-additive where the trace shows that voices are coupled.

import YAML from "yaml";
import { SidwaveOperationError } from "../cliCore.js";
import { psidClock, type SidEmulation, type SidEngine } from "../engine/libsidplayfp.js";
import { type FrameIr } from "../reconstruct/ir.js";
import { DEFAULT_HORIZON_SECONDS, irOfTrace, reconstructSid } from "../reconstruct/reconstruct.js";
import { parseSidFile } from "../sidFile.js";
import { parseSidwave } from "../sidwave.js";
import { compileSidwaveBytes } from "../sidwaveOps.js";
import { encodeWav } from "../sidwaveTools.js";
import { globalVoice, memoEngine, sha256, voiceRegs } from "./common.js";

export interface IsolateOptions {
  /** Global voice number, 1-based over all SIDs (SID 1 has voices 1 to 3). */
  voice: number;
  /** "solo" (default) keeps only `voice`; "mute" silences only `voice`. */
  mode?: "solo" | "mute";
  /** Engine for the trace and the reconstruction (SIDLite). */
  engine: SidEngine;
  /** Engine for the render; default `engine`. */
  renderEngine?: SidEngine;
  song?: number;
  seconds?: number;
  sampleRate?: number;
  signal?: AbortSignal;
}

export interface Coupling {
  /** True when the isolated audio is not part of an additive mix of the original: voices are coupled. */
  nonAdditive: boolean;
  reasons: string[];
  /** Voices (global, 1-based) routed through the filter, and voices that use sync or ring modulation, with their modulator. */
  filterRouted: number[];
  sync: Array<{ voice: number; source: number }>;
  ring: Array<{ voice: number; source: number }>;
  sampleStreams: boolean;
}

export interface IsolateResult {
  wav: Uint8Array;
  method: "reconstruct-and-recompile";
  methodNote: string;
  mode: "solo" | "mute";
  voice: number;
  /** Voices silenced in the render. */
  silenced: number[];
  coupling: Coupling;
  /** Whether the reconstruction that the audio comes from reproduces the tune exactly (strict F-diff). */
  reconstructionStrictExact: boolean;
  horizon: { seconds: number; song: number; sampleRate: number };
  engine: { id: string; version: string; emulation: SidEmulation };
  /** SHA-256 of the WAV. */
  sha256: string;
}

/** Detects filter routing, sync and ring modulation in a trace: the couplings that make a voice's sound depend on other voices. */
export function detectCoupling(ir: FrameIr, target: number | undefined): Coupling {
  const routed = new Set<number>();
  const sync = new Map<number, number>();
  const ring = new Map<number, number>();
  const modes = new Set<number>();
  for (const call of ir.calls) {
    call.sids.forEach((state, sid) => {
      const route = state.regs[0x17]! & 7;
      const mode = state.regs[0x18]! & 0x70;
      if (route && mode) { modes.add(mode); for (let v = 0; v < 3; v++) if (route & (1 << v)) routed.add(globalVoice(sid, v)); }
      for (let v = 0; v < 3; v++) {
        const c = voiceRegs(state.regs, v).control;
        const source = globalVoice(sid, (v + 2) % 3);
        if (c & 0xf0) {
          if (c & 2) sync.set(globalVoice(sid, v), source);
          if (c & 4) ring.set(globalVoice(sid, v), source);
        }
      }
    });
  }
  const reasons: string[] = [];
  if (routed.size > 0 && (target === undefined || routed.has(target) || routed.size > 1)) {
    reasons.push(`voices ${[...routed].sort((a, b) => a - b).join(", ")} go through the filter, which does not give the sum of its inputs (on the 6581 it is nonlinear)`);
  }
  for (const [voice, source] of sync) {
    if (target === undefined || voice === target || source === target) reasons.push(`voice ${voice} is hard-synchronised to voice ${source}`);
  }
  for (const [voice, source] of ring) {
    if (target === undefined || voice === target || source === target) reasons.push(`voice ${voice} is ring-modulated by voice ${source}`);
  }
  const sampleStreams = ir.unsupported.streams.some((s) => s.register === 0x18);
  if (sampleStreams) reasons.push("sample playback writes the shared volume register $D418, which is not a voice");
  return {
    nonAdditive: reasons.length > 0, reasons, filterRouted: [...routed].sort((a, b) => a - b),
    sync: [...sync].map(([voice, source]) => ({ voice, source })), ring: [...ring].map(([voice, source]) => ({ voice, source })), sampleStreams,
  };
}

/** The score with the given voices (global numbers) silenced: an empty layer in every timeline section. */
export function silenceVoices(score: string, voices: readonly number[]): string {
  const doc = YAML.parse(score) as Record<string, any>;
  const slots = parseSidwave(score).voiceSlots;
  const ids = new Set<number>();
  for (const [id, slot] of slots) if (voices.includes(slot + 1)) ids.add(id);
  for (const section of doc.timeline ?? []) for (const id of ids) if (section.layers && `v${id}` in section.layers) section.layers[`v${id}`] = "-";
  for (const song of doc.songs ?? []) for (const section of song.timeline ?? []) for (const id of ids) if (section.layers && `v${id}` in section.layers) section.layers[`v${id}`] = "-";
  return YAML.stringify(doc);
}

export async function isolateVoice(sidBytes: Uint8Array, options: IsolateOptions): Promise<IsolateResult> {
  const file = parseSidFile(sidBytes);
  const song = options.song ?? file.startSong;
  if (!Number.isInteger(song) || song < 1 || song > file.songs) throw new SidwaveOperationError("input", `song ${song} is outside 1..${file.songs}`);
  const seconds = options.seconds ?? DEFAULT_HORIZON_SECONDS;
  const mode = options.mode ?? "solo";
  const engine = memoEngine(options.engine);
  const clock = psidClock(sidBytes) ?? "PAL";
  const { score, report } = await reconstructSid(sidBytes, { engine, song, seconds });
  const trace = await engine.trace({ sid: sidBytes, song, seconds, clock });
  const ir = irOfTrace(trace);
  const voices = Math.max(ir.sidCount, 1) * 3;
  if (!Number.isInteger(options.voice) || options.voice < 1 || options.voice > voices) {
    throw new SidwaveOperationError("usage", `--voice ${options.voice} is outside 1..${voices}, the voices of ${ir.sidCount} SID${ir.sidCount === 1 ? "" : "s"}`);
  }
  const silenced = Array.from({ length: voices }, (_, i) => i + 1).filter((v) => (mode === "solo" ? v !== options.voice : v === options.voice));
  const masked = silenceVoices(score, silenced);
  const compiled = compileSidwaveBytes(parseSidwave(masked), { format: "sid", loop: true });
  const sampleRate = options.sampleRate ?? 48_000;
  const render = await (options.renderEngine ?? options.engine).render({
    sid: new Uint8Array(compiled.bytes), seconds, sampleRate, channels: 1, clock,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const wav = encodeWav(render.samples, render.sampleRate, 1);
  return {
    wav, method: "reconstruct-and-recompile",
    methodNote: "The engine binding cannot replay a list of register writes, so the tune was reconstructed as a SIDWave score, the other voices got empty layers, and the score was compiled and rendered. The audio is as exact as the reconstruction; oscillator phases differ from the original because the SIDWave player writes a few cycles apart from the original player, so the solo renders add up in power, not sample by sample.",
    mode, voice: options.voice, silenced, coupling: detectCoupling(ir, options.voice), reconstructionStrictExact: report.strictExact,
    horizon: { seconds, song, sampleRate: render.sampleRate }, engine: render.engine, sha256: sha256(wav),
  };
}
