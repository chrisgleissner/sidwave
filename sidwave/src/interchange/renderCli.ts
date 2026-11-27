// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// `sidwave render`: WAV of the mix, or `--stems` for one WAV per voice. Asynchronous because the engine is.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import { SidEngineError } from "../engine/libsidplayfp.js";
import { parseSidwave } from "../sidwave.js";
import { confinedReadOptions, validationFailure } from "../sidwaveOps.js";
import { InterchangeUsageError, numberFlag, parseFlags, readBounded } from "./cli.js";
import { renderStems, STEM_ENERGY_TOLERANCE } from "./stems.js";
import { writeWav } from "./wav.js";

/** Runs `sidwave render`. `args` excludes the command name. */
export async function runRender(args: string[], io: CliIo): Promise<number> {
  try {
    const a = parseFlags(args, ["-o", "--output", "--seconds", "--sample-rate", "--model", "--song", "--emulation", "--allow-dir"], ["--stems", "--json", "--force"]);
    if (a.positional.length !== 1) throw new InterchangeUsageError("render needs exactly one score file");
    const file = a.positional[0]!;
    const model = a.flags.get("--model") as string | undefined;
    if (model !== undefined && model !== "6581" && model !== "8580") throw new InterchangeUsageError("--model must be 6581 or 8580");
    const emulation = (a.flags.get("--emulation") as string | undefined) ?? "residfp";
    if (emulation !== "residfp" && emulation !== "sidlite") throw new InterchangeUsageError("--emulation must be residfp or sidlite");
    const seconds = numberFlag(a, "--seconds");
    const sampleRate = numberFlag(a, "--sample-rate");
    const song = numberFlag(a, "--song");
    const { bytes } = readBounded(io, file);
    const stem = basename(file, extname(file)).replace(/\.sidwave$/i, "");
    const output = (a.flags.get("-o") ?? a.flags.get("--output")) as string | undefined;
    let doc;
    try { doc = parseSidwave(bytes.toString("utf8"), confinedReadOptions(io.cwd, a.allowDirs)); } catch (error) {
      const failure = validationFailure(error);
      if (!failure) throw error;
      io.err(`${file}: ${failure.message}\n`);
      return 1;
    }
    let result;
    try {
      result = await renderStems(doc, {
        emulation, ...(seconds === undefined ? {} : { seconds }), ...(sampleRate === undefined ? {} : { sampleRate }),
        ...(model ? { model } : {}), ...(song === undefined ? {} : { song }),
      });
    } catch (error) {
      if (error instanceof SidEngineError) throw new InterchangeUsageError(error.message);
      if (error instanceof RangeError || (error instanceof Error && /^stems? /.test(error.message))) throw new InterchangeUsageError(error.message);
      throw error;
    }
    const files: Array<{ kind: string; path: string; bytes: number; voices?: number[] }> = [];
    const put = (path: string, data: Uint8Array | string, kind: string, voices?: number[]) => {
      const target = resolve(io.cwd, path);
      if (existsSync(target) && !a.flags.has("--force")) throw new InterchangeUsageError(`${target} exists; use --force to overwrite it`);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, data);
      files.push({ kind, path: target, bytes: data.length, ...(voices ? { voices } : {}) });
    };
    if (!a.flags.has("--stems")) {
      put(output ?? `${stem}.wav`, writeWav(result.mix, result.sampleRate), "mix");
    } else {
      const dir = output ?? `${stem}-stems`;
      put(join(dir, `${stem}.mix.wav`), writeWav(result.mix, result.sampleRate), "mix");
      for (const s of result.stems) put(join(dir, `${stem}.v${s.voices.join("+v")}.wav`), writeWav(s.samples, result.sampleRate), "stem", s.voices);
      const manifest = {
        score: file, sampleRate: result.sampleRate, seconds: result.seconds, engine: result.engine,
        additive: result.additive,
        note: result.additive
          ? `The stems add up to the mix in energy within ${STEM_ENERGY_TOLERANCE * 100}% (not sample by sample); each stem has the idle SID baseline removed.`
          : "NON-ADDITIVE: the voices influence each other (see coupling), so the stems do not add up to the mix.",
        coupling: result.coupling, sumError: result.sumError, files,
      };
      put(join(dir, `${stem}.stems.json`), `${JSON.stringify(manifest, null, 2)}\n`, "manifest");
    }
    io.out(a.flags.has("--json") ? `${JSON.stringify({ ok: true, additive: result.additive, coupling: result.coupling, sumError: result.sumError, files }, null, 2)}\n`
      : `${files.map((f) => f.path).join("\n")}\n${a.flags.has("--stems") ? (result.additive ? "stems are additive\n" : `stems are NON-ADDITIVE: ${result.coupling.map((c) => c.kind).join(", ")}\n`) : ""}`);
    return 0;
  } catch (error) {
    if (error instanceof InterchangeUsageError) { io.err(`sidwave: ${error.message}\nRun "sidwave --help" for usage.\n`); return 2; }
    throw error;
  }
}
