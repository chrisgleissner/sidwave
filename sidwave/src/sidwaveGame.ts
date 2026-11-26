// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SIDWave game build: the player as a library for games and demos (S4a)

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { SidwaveValidationError, type ParsedSidwave, type SystemMode } from "./sidwave.js";
import {
  SIDWAVE_GAME_DEFAULT_ZERO_PAGE, SIDWAVE_GAME_ENTRY, SIDWAVE_GAME_TABLE_BYTES, SIDWAVE_MEMORY_END,
  compileSidwaveGameImage, compileSidwaveToSid, type SidwaveGameImage,
} from "./sidwaveCompiler.js";
import type { SidwaveFinding } from "./sidwaveLint.js";
import { Cpu6502 } from "./sidwaveEmulator.js";

export type SidwaveSymbolFormat = "acme" | "kickass" | "ca65" | "vice" | "json";
export const SIDWAVE_SYMBOL_FORMATS: readonly SidwaveSymbolFormat[] = ["acme", "kickass", "ca65", "vice", "json"];

export interface SidwaveGameOptions {
  target: "game";
  /** Address of the entry table (`origin+0` init, `+3` play, `+6` stop, `+9` sfx), $0200-$CFFF. */
  origin: number;
  /** Address of a separate data block (streams and tables); without it the data is part of `player`. */
  dataOrigin?: number;
  /** Zero page base of the player's pointers; default $FB. */
  zeroPage?: number;
  /** Symbol file formats to generate. */
  symbols?: SidwaveSymbolFormat[];
  /** Export every label of the player (as `sidwave_int_<label>`), not only the entry points and contract labels. */
  symbolsAll?: boolean;
  /** Loop the song (default); a score with an `end` section never loops. */
  loop?: boolean;
  /** Run the score on the bundled emulator and report measured cycles (default true). Without it the measured values are null. */
  measure?: boolean;
}

export interface SidwaveGameCycles {
  /** Highest cycle count of one play call (entry jump included) over the measured run; null without measurement. */
  worst: number | null;
  /** Mean cycles per play call over the measured run; null without measurement. */
  average: number | null;
  /** Conservative analytic upper bound for one play call. */
  estimatedWorst: number;
  /** Seconds of music the measured run covered: every play call of the full song plus one more pass of its loop. */
  measuredOverSeconds: number | null;
  /** Play calls of the measured run; 0 without measurement. */
  measuredCalls: number;
  /** Which values were measured on the emulator and which are computed. */
  kinds: { worst: "measured"; average: "measured"; estimatedWorst: "estimated" };
}

export interface SidwaveGameContract {
  /** Version of this contract layout. */
  version: 1;
  entryPoints: { init: number; play: number; stop: number; sfx: number };
  entryTableBytes: number;
  /** Register use per entry point. */
  registers: {
    init: { in: { A: string; X: string }; clobbers: string[] };
    play: { in: string; clobbers: string[] };
    stop: { in: string; clobbers: string[] };
    sfx: { in: string; clobbers: string[]; note: string };
  };
  /** Processor flags and the processor port. */
  flags: string;
  port01: string;
  /** Zero page bytes the player uses; each is saved on entry and restored on return. */
  zeroPage: Array<{ address: number; bytes: number; label: string }>;
  /** SID register blocks written ($D400-$D418 of every SID). */
  sidRegisters: Array<{ address: number; bytes: number }>;
  /** Everything the player writes besides the zero page, the stack, $01 and the SID registers: [start, end) ranges. */
  ram: Array<{ start: number; end: number }>;
  /** The part of `ram` that lies inside the player image: operand bytes of instructions the player patches while it runs. Empty for most scores. */
  patchedCode: Array<{ start: number; end: number }>;
  /** Where the bytes go: the player image, the variable block behind it and the optional data block. */
  memory: { player: { start: number; end: number }; variables: { start: number; end: number }; data?: { start: number; end: number } };
  interrupts: string;
  /** Deepest stack use of init, play and stop in bytes, return address included; measured, or null without measurement. */
  maxStackBytes: number | null;
  /** The game calls `play` this many times per video frame, evenly spaced. */
  playCallsPerFrame: number;
  /** Play calls per second of music and the clock the score was written for. */
  playCallsPerSecond: number;
  system: SystemMode;
  /** Present with a data origin: the player expects exactly these data bytes (not verified at run time). */
  data?: { origin: number; bytes: number; sha256: string };
}

export interface SidwaveGameBuild {
  player: Uint8Array;
  data: Uint8Array | undefined;
  /** One image from the lowest to the highest address of player and data; the gap between them, if any, is zero. */
  combined: Uint8Array;
  /** Load address of `combined`. */
  combinedOrigin: number;
  /** Symbol file text per requested format. */
  symbols: Partial<Record<SidwaveSymbolFormat, string>>;
  contract: SidwaveGameContract;
  cycles: SidwaveGameCycles;
  /** Addresses of the entry points and every exported label. */
  labels: Record<string, number>;
  /** Number of play calls of one pass of the song. */
  totalFrames: number;
  durationSeconds: number;
  streamBytes: number[];
  lint?: SidwaveFinding[];
  warnings: string[];
  /** The assembled image, for {@link sidwaveGamePsid}. */
  image: SidwaveGameImage;
}

const hex = (n: number, digits = 4) => n.toString(16).toUpperCase().padStart(digits, "0");
const addr = (n: number) => `$${hex(n, n < 0x100 ? 2 : 4)}`;

/** Entry points and contract labels exported by default, in file order. */
function publicLabels(image: SidwaveGameImage): Array<[string, number, string]> {
  const sym = (label: string) => image.symbols.get(label)!;
  const labels: Array<[string, number, string]> = [
    ["sidwave_init", image.origin + SIDWAVE_GAME_ENTRY.init, "init: A = subtune (0), X = clock (0 PAL, 1 NTSC, $FF read $02A6)"],
    ["sidwave_play", image.origin + SIDWAVE_GAME_ENTRY.play, "play: one call per play period"],
    ["sidwave_stop", image.origin + SIDWAVE_GAME_ENTRY.stop, "stop: silence all voices"],
    ["sidwave_sfx", image.origin + SIDWAVE_GAME_ENTRY.sfx, "sfx: stub (rts) until sound effects exist"],
    ["sidwave_ram", sym("game_image_end"), "start of the variable block behind the image"],
    ["sidwave_ram_end", image.ramEnd, "first address behind the variable block"],
  ];
  if (image.dataOrigin !== undefined) {
    labels.push(["sidwave_data", image.dataOrigin, "start of the data block"], ["sidwave_data_end", image.dataEnd!, "first address behind the data block"]);
  }
  labels.push(["sidwave_zp_ptr", image.zeroPage, "zero page: stream pointer (2 bytes)"]);
  if (image.zeroPageRanges.length > 1) labels.push(["sidwave_zp_sid_io", image.zeroPage + 2, "zero page: SID pointer (2 bytes)"]);
  labels.push(["sidwave_play_calls_per_frame", image.playCallsPerFrame, "play calls per video frame"]);
  return labels;
}

function contractLines(contract: SidwaveGameContract, build: { cycles: SidwaveGameCycles }): string[] {
  const range = (r: { start: number; end: number }) => `$${hex(r.start)}-$${hex(r.end - 1)}`;
  const lines = [
    "SIDWave game build contract",
    `entry points: init $${hex(contract.entryPoints.init)}, play $${hex(contract.entryPoints.play)}, stop $${hex(contract.entryPoints.stop)}, sfx $${hex(contract.entryPoints.sfx)} (3 bytes each)`,
    `init: A = ${contract.registers.init.in.A}; X = ${contract.registers.init.in.X}; clobbers ${contract.registers.init.clobbers.join(", ")}`,
    `play, stop: no input; clobber ${contract.registers.play.clobbers.join(", ")}`,
    `sfx: ${contract.registers.sfx.note}`,
    `flags: ${contract.flags}`,
    `$01: ${contract.port01}`,
    `zero page: ${contract.zeroPage.map((z) => `${z.label} ${addr(z.address)}-${addr(z.address + z.bytes - 1)}`).join(", ")} (saved and restored)`,
    `SID registers written: ${contract.sidRegisters.map((s) => `$${hex(s.address)}-$${hex(s.address + s.bytes - 1)}`).join(", ")}`,
    `RAM written: ${contract.ram.map(range).join(", ")}`,
    ...(contract.patchedCode.length ? [`code patched at run time (not ROM safe): ${contract.patchedCode.map(range).join(", ")}`] : []),
    `memory: player ${range(contract.memory.player)}, variables ${range(contract.memory.variables)}${contract.memory.data ? `, data ${range(contract.memory.data)}` : ""}`,
    `interrupts: ${contract.interrupts}`,
    `stack: ${contract.maxStackBytes === null ? "not measured" : `${contract.maxStackBytes} bytes (measured)`}`,
    `play calls per frame: ${contract.playCallsPerFrame}; ${contract.playCallsPerSecond} per second; written for ${contract.system}`,
    `cycles per play call: ${build.cycles.worst === null ? "not measured" : `worst ${build.cycles.worst} (measured), average ${build.cycles.average!.toFixed(1)} (measured)`}, upper bound ${build.cycles.estimatedWorst} (estimated)`,
  ];
  if (contract.data) lines.push(`data: ${contract.data.bytes} bytes at $${hex(contract.data.origin)}, SHA-256 ${contract.data.sha256} (not verified at run time)`);
  return lines;
}

function symbolFile(format: SidwaveSymbolFormat, entries: Array<[string, number, string]>, contract: SidwaveGameContract,
  build: { cycles: SidwaveGameCycles }): string {
  const comments = (token: string) => contractLines(contract, build).map((line) => `${token} ${line}`);
  switch (format) {
    case "acme":
      return [...comments(";"), ...entries.map(([name, value, note]) => `${name} = ${addr(value)} ; ${note}`)].join("\n") + "\n";
    case "kickass":
      return [...comments("//"), ...entries.map(([name, value, note]) => `.label ${name}=${addr(value)} // ${note}`)].join("\n") + "\n";
    case "ca65":
      return [
        ...comments(";"),
        "; To export the symbols from this unit, remove the leading semicolon:",
        `; .export ${entries.map(([name]) => name).join(", ")}`,
        ...entries.map(([name, value, note]) => `${name} = ${addr(value)} ; ${note}`),
      ].join("\n") + "\n";
    case "vice":
      // The monitor takes addresses only, so the play call rate is left out.
      return entries.filter(([name]) => name !== "sidwave_play_calls_per_frame").map(([name, value]) => `al C:${hex(value)} .${name}`).join("\n") + "\n";
    default:
      return `${JSON.stringify({ symbols: Object.fromEntries(entries.map(([name, value]) => [name, value])), contract }, null, 2)}\n`;
  }
}

/** Runs the compiled score on the bundled emulator: init, every play call of the song plus one loop, then stop. */
function measure(image: SidwaveGameImage): { worst: number; average: number; calls: number; stack: number } {
  const mem = new Uint8Array(0x10000);
  mem.set(image.player, image.origin);
  if (image.data) mem.set(image.data, image.dataOrigin!);
  const cpu = new Cpu6502(mem);
  const clock = image.system === "NTSC" ? 1 : 0;
  cpu.call(image.origin + SIDWAVE_GAME_ENTRY.init, { a: 0, x: clock });
  let stack = cpu.lastStackDepth;
  const calls = image.totalFrames + (image.loop ? image.totalFrames - (image.loopFrame ?? 0) : 0) + 4;
  let worst = 0;
  let total = 0;
  for (let i = 0; i < calls; i++) {
    const cycles = cpu.call(image.origin + SIDWAVE_GAME_ENTRY.play);
    worst = Math.max(worst, cycles);
    total += cycles;
    stack = Math.max(stack, cpu.lastStackDepth);
  }
  cpu.call(image.origin + SIDWAVE_GAME_ENTRY.stop);
  return { worst, average: total / calls, calls, stack: Math.max(stack, cpu.lastStackDepth) };
}

/**
 * Compiles a score into a player for use inside a game or demo: assembled at `origin` with no BASIC stub, IRQ or CIA
 * setup and no KERNAL use, optionally with the data in a separate block, with symbol files, a documented register
 * contract and cycle counts. The PRG and PSID outputs of the same score are unaffected.
 */
export function compileSidwave(doc: ParsedSidwave, options: SidwaveGameOptions): SidwaveGameBuild {
  if ((options as { target?: string }).target !== "game") {
    throw new SidwaveValidationError("$.target", `only the "game" target is available here (use compileSidwaveToPrg for a PRG)`);
  }
  for (const format of options.symbols ?? []) {
    if (!SIDWAVE_SYMBOL_FORMATS.includes(format)) {
      throw new SidwaveValidationError("$.symbols", `unknown symbol format "${format}"; use ${SIDWAVE_SYMBOL_FORMATS.join(", ")}`);
    }
  }
  const image = compileSidwaveGameImage(doc, {
    origin: options.origin,
    dataOrigin: options.dataOrigin,
    zeroPage: options.zeroPage ?? SIDWAVE_GAME_DEFAULT_ZERO_PAGE,
  }, options.loop === undefined ? {} : { loop: options.loop });
  const warnings = [...image.warnings];
  const covers = (start: number, end: number) => start <= 0x02a6 && end > 0x02a6;
  if (covers(image.origin, image.ramEnd) || (image.dataOrigin !== undefined && covers(image.dataOrigin, image.dataEnd!))) {
    warnings.push("The player covers $02A6, the KERNAL PAL/NTSC flag; pass the clock to init in X instead of $FF.");
  }
  const measured = options.measure === false ? undefined : measure(image);
  if (measured && measured.worst > image.estimatedWorstCycles) {
    throw new Error(`SIDWAVE compiler defect: the measured worst case of ${measured.worst} cycles per play call exceeds the estimate of ${image.estimatedWorstCycles}`);
  }
  const cycles: SidwaveGameCycles = {
    worst: measured?.worst ?? null,
    average: measured?.average ?? null,
    estimatedWorst: image.estimatedWorstCycles,
    measuredOverSeconds: measured ? measured.calls / image.framesPerSecond : null,
    measuredCalls: measured?.calls ?? 0,
    kinds: { worst: "measured", average: "measured", estimatedWorst: "estimated" },
  };
  const entryPoints = {
    init: image.origin + SIDWAVE_GAME_ENTRY.init, play: image.origin + SIDWAVE_GAME_ENTRY.play,
    stop: image.origin + SIDWAVE_GAME_ENTRY.stop, sfx: image.origin + SIDWAVE_GAME_ENTRY.sfx,
  };
  const variablesStart = image.symbols.get("game_image_end")!;
  const clobbers = ["A", "X", "Y"];
  const contract: SidwaveGameContract = {
    version: 1,
    entryPoints,
    entryTableBytes: SIDWAVE_GAME_TABLE_BYTES,
    registers: {
      init: {
        in: { A: "subtune index, 0-based (only 0 exists; the value is ignored)", X: "clock: 0 PAL, 1 NTSC, $FF reads the KERNAL flag at $02A6" },
        clobbers,
      },
      play: { in: "none", clobbers },
      stop: { in: "none; silences all voices and leaves interrupts alone (call init to start again)", clobbers },
      sfx: { in: "none yet", clobbers: [], note: "a stub that returns at once (sound effects come later); the registers and the carry flag are unchanged" },
    },
    flags: "the interrupt and decimal flags are never changed; the other flags are undefined on return",
    port01: "saved on entry and restored on return; set to $36 (I/O and KERNAL visible, BASIC ROM off) while the routine runs",
    zeroPage: image.zeroPageRanges.map(([start, end], i) => ({ address: start, bytes: end - start, label: i === 0 ? "ptr" : "sid_io" })),
    sidRegisters: image.sidAddresses.map((address) => ({ address, bytes: 25 })),
    ram: image.ramRanges.map(([start, end]) => ({ start, end })),
    patchedCode: image.patchedCode.map(([start, end]) => ({ start, end })),
    memory: {
      player: { start: image.origin, end: image.imageEnd },
      variables: { start: variablesStart, end: image.ramEnd },
      ...(image.dataOrigin === undefined ? {} : { data: { start: image.dataOrigin, end: image.dataEnd! } }),
    },
    interrupts: "none: no interrupt vector, CIA or VIC timer is touched and the I flag is not changed; the game calls play itself",
    maxStackBytes: measured?.stack ?? null,
    playCallsPerFrame: image.playCallsPerFrame,
    playCallsPerSecond: image.framesPerSecond,
    system: image.system,
    ...(image.data ? { data: { origin: image.dataOrigin!, bytes: image.data.length, sha256: createHash("sha256").update(image.data).digest("hex") } } : {}),
  };
  const labelEntries = publicLabels(image);
  const entries: Array<[string, number, string]> = [...labelEntries];
  if (options.symbolsAll) {
    for (const [label, value] of [...image.symbols].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
      if (/^[A-Za-z_]\w*$/.test(label) && !label.startsWith("game_")) entries.push([`sidwave_int_${label}`, value, "internal label"]);
    }
  }
  const symbols: Partial<Record<SidwaveSymbolFormat, string>> = {};
  for (const format of options.symbols ?? []) symbols[format] = symbolFile(format, entries, contract, { cycles });
  const low = Math.min(image.origin, image.dataOrigin ?? image.origin);
  const high = Math.max(image.origin + image.player.length, image.dataOrigin === undefined ? 0 : image.dataOrigin + image.data!.length);
  const combined = new Uint8Array(high - low);
  combined.set(image.player, image.origin - low);
  if (image.data) combined.set(image.data, image.dataOrigin! - low);
  return {
    player: image.player,
    data: image.data,
    combined,
    combinedOrigin: low,
    symbols,
    contract,
    cycles,
    labels: Object.fromEntries(entries.map(([name, value]) => [name, value])),
    totalFrames: image.totalFrames,
    durationSeconds: image.totalFrames / image.framesPerSecond,
    streamBytes: image.streamBytes,
    lint: image.lint,
    warnings,
    image,
  };
}

/** Alias of {@link compileSidwave}. */
export const compileSidwaveGame = compileSidwave;

/**
 * The largest run of pages in $0400-$CFFF that a tune occupying `used` (half-open address ranges) leaves free, as the
 * PSID v2NG `startPage` and `pageLength`. When no page is free the file records $FF and 0, the value the format
 * defines for "no space available".
 */
export function freePageRange(used: ReadonlyArray<readonly [number, number]>): { startPage: number; pageLength: number } {
  const busy = new Array<boolean>(0xd0).fill(false);
  for (const [start, end] of used) {
    for (let page = Math.max(0, start >> 8); page <= Math.min(0xcf, (end - 1) >> 8); page++) busy[page] = true;
  }
  let best = { startPage: 0xff, pageLength: 0 };
  for (let page = 0x04; page < 0xd0;) {
    if (busy[page]) { page++; continue; }
    let end = page;
    while (end < 0xd0 && !busy[end]) end++;
    if (end - page > best.pageLength) best = { startPage: page, pageLength: end - page };
    page = end;
  }
  return best;
}

/**
 * A PSID file of a game build, for players such as sidplayfp. The image (player, zero filled variables and data) is
 * loaded at its lowest address; a start routine behind it (five bytes, ten more for a multispeed score that programs CIA1 timer A) passes the score's clock to `init` in X, and
 * `play` is the entry at origin+3. The header records the largest free page range of $0400-$CFFF.
 */
export function sidwaveGamePsid(doc: ParsedSidwave, build: SidwaveGameBuild): Buffer {
  const { image } = build;
  const low = build.combinedOrigin;
  const high = Math.max(image.ramEnd, image.dataEnd ?? 0);
  // A score with several play calls per frame is timed by CIA1 timer A (the header says so): the start routine
  // programs the latch like the PRG installer does. The player itself never touches the CIA.
  const latch = Math.round((image.system === "NTSC" ? 1_022_727 : 985_248) / image.framesPerSecond) - 1;
  const start = [
    ...(image.playCallsPerFrame > 1 ? [0xa9, latch & 0xff, 0x8d, 0x04, 0xdc, 0xa9, latch >> 8, 0x8d, 0x05, 0xdc] : []),
    0xa2, image.system === "NTSC" ? 1 : 0, 0x4c, image.origin & 0xff, image.origin >> 8,
  ];
  if (high + start.length > SIDWAVE_MEMORY_END) {
    throw new SidwaveValidationError("$.origin", "the PSID start routine would end past $D000; lower the origin");
  }
  const body = Buffer.alloc(2 + (high - low) + start.length);
  body.writeUInt16LE(low, 0);
  body.set(build.combined, 2);
  body.set(start, 2 + high - low);
  const relocation = freePageRange([[low, high + start.length]]);
  return compileSidwaveToSid(doc, body, { initAddress: high, playAddress: image.origin + SIDWAVE_GAME_ENTRY.play, relocation }).sid;
}
