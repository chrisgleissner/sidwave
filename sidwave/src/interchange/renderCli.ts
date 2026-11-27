// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// `sidwave render --stems`: the stem branch of the render command in cliVerify.ts.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { EXIT_OK, SidwaveOperationError, UsageError, envelope, withFile, type CliIo } from "../cliCore.js";
import { createLibsidplayfpEngine } from "../engine/libsidplayfp.js";
import type { SidEmulation } from "../engine/types.js";
import { parseSidwave } from "../sidwave.js";
import { confinedReadOptions } from "../sidwaveOps.js";
import { readBounded } from "./cli.js";
import { StemsRefusedError } from "./errors.js";
import { renderStems, stemVoiceGroups, STEM_ENERGY_TOLERANCE } from "./stems.js";
import { writeWav } from "./wav.js";

/** What the stem renderer reads from the parsed command line of `render`. */
export interface StemsCommandInput {
  file: string;
  output?: string;
  json: boolean;
  force: boolean;
  allowDirs: string[];
  /** `--song` of the run options, 1-based like the other run commands. */
  song?: number;
  seconds?: number;
  rate?: number;
  model?: "6581" | "8580";
  engine?: SidEmulation;
  maxSeconds?: number;
  maxBytes?: number;
}

/** Writes the mix, one WAV per voice and a manifest into a directory. Engine and signal come from `io`. */
export async function renderStemsCommand(io: CliIo, input: StemsCommandInput): Promise<number> {
  if (input.output === "-") throw new UsageError("render --stems writes a directory; -o - is not possible");
  const { file } = input;
  const { bytes } = readBounded(io, file);
  const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
  const doc = withFile(file, () => parseSidwave(bytes.toString("utf8"), confinedReadOptions(io.cwd, input.allowDirs)));
  if (input.song !== undefined && !doc.songs) throw new UsageError("--song needs a score with songs; this score has none");
  const dir = input.output ?? `${stem}-stems`;
  // Target names follow from the voices and their dependencies, so existence is checked before any rendering.
  const targets = [
    join(dir, `${stem}.mix.wav`), ...stemVoiceGroups(doc, (input.song ?? 1) - 1).map((g) => join(dir, `${stem}.v${g.join("+v")}.wav`)), join(dir, `${stem}.stems.json`),
  ];
  if (!input.force) {
    const taken = targets.map((t) => resolve(io.cwd, t)).find((t) => existsSync(t));
    if (taken) throw new UsageError(`${taken} exists; use --force to overwrite it`);
  }
  const emulation = input.engine ?? "residfp";
  const engine = io.createEngine ? io.createEngine(emulation) : createLibsidplayfpEngine({ emulation });
  let result;
  try {
    result = await renderStems(doc, {
      engine, emulation, sampleRate: input.rate ?? 48_000,
      ...(input.seconds === undefined ? {} : { seconds: input.seconds }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.song === undefined ? {} : { song: input.song - 1 }),
      ...(io.signal ? { signal: io.signal } : {}),
      ...(input.maxSeconds === undefined ? {} : { maxSeconds: input.maxSeconds }),
    });
  } catch (error) {
    if (error instanceof StemsRefusedError) throw new SidwaveOperationError("limit_exceeded", error.message, {}, { cause: error });
    if (error instanceof RangeError) throw new UsageError(error.message);
    throw error;
  }
  const entries: Array<{ kind: string; target: string; data: Uint8Array | string; voices?: number[] }> = [
    { kind: "mix", target: resolve(io.cwd, targets[0]!), data: writeWav(result.mix, result.sampleRate) },
    ...result.stems.map((s, i) => ({ kind: "stem", target: resolve(io.cwd, targets[i + 1]!), data: writeWav(s.samples, result.sampleRate), voices: s.voices })),
  ];
  const files = entries.map((e) => ({ kind: e.kind, path: e.target, bytes: e.data.length, ...(e.voices ? { voices: e.voices } : {}) }));
  const ratio = result.sumError.energyRatio.toFixed(3);
  const manifest = {
    score: file, sampleRate: result.sampleRate, seconds: result.seconds, engine: result.engine,
    additive: result.additive, energyRatio: result.sumError.energyRatio, energyWithinTolerance: result.energyWithinTolerance,
    note: result.additive
      ? `Measured energy ratio ${ratio}: the stems add up to the mix in energy within ${STEM_ENERGY_TOLERANCE * 100}% (not sample by sample); each stem has the idle SID baseline removed.`
      : result.coupling.length
        ? `NON-ADDITIVE: the voices influence each other (see coupling), so the stems do not add up to the mix. Measured energy ratio ${ratio}.`
        : `NON-ADDITIVE: the measured energy ratio ${ratio} is outside the tolerance of ${STEM_ENERGY_TOLERANCE * 100}%.`,
    coupling: result.coupling, sumError: result.sumError, files: [...files],
  };
  const manifestTarget = resolve(io.cwd, targets[targets.length - 1]!);
  entries.push({ kind: "manifest", target: manifestTarget, data: `${JSON.stringify(manifest, null, 2)}\n` });
  // Every size is known before the first write, so a --max-bytes refusal leaves no partial output.
  if (input.maxBytes !== undefined) {
    for (const e of entries) {
      if (e.data.length > input.maxBytes) throw new SidwaveOperationError("limit_exceeded", `${e.target} would have ${e.data.length} bytes; the limit is ${input.maxBytes}`);
    }
  }
  for (const e of entries) {
    try {
      mkdirSync(dirname(e.target), { recursive: true });
      writeFileSync(e.target, e.data);
    } catch (error) {
      throw new SidwaveOperationError("input", `cannot write ${e.target}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { file: e.target });
    }
  }
  files.push({ kind: "manifest", path: manifestTarget, bytes: entries[entries.length - 1]!.data.length });
  const summary = { file, directory: resolve(io.cwd, dir), additive: result.additive, energyRatio: result.sumError.energyRatio,
    energyWithinTolerance: result.energyWithinTolerance, coupling: result.coupling, sumError: result.sumError, files };
  io.out(input.json ? `${JSON.stringify(envelope("render", true, { result: summary }), null, 2)}\n`
    : `${files.map((f) => f.path).join("\n")}\n${result.additive ? `stems are additive (energy ratio ${ratio})` : `stems are NON-ADDITIVE: ${result.coupling.map((c) => c.kind).join(", ") || `energy ratio ${ratio}`}`}\n`);
  return EXIT_OK;
}
