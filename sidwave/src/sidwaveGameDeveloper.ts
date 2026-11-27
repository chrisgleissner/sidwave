// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Developer integration of the game build: assembler include files and page relocation tables

import { SidwaveValidationError, type ParsedSidwave } from "./sidwave.js";
import { SIDWAVE_GAME_MIN_ORIGIN, SIDWAVE_MEMORY_END, SIDWAVE_GAME_TABLE_BYTES } from "./sidwaveCompiler.js";
import {
  assertDistinct64tassSymbols, commentText, compileSidwave, type SidwaveGameBuild, type SidwaveGameOptions,
} from "./sidwaveGame.js";

export type SidwaveAssembler = "64tass" | "acme" | "kickass" | "ca65";
export const SIDWAVE_ASSEMBLERS: readonly SidwaveAssembler[] = ["64tass", "acme", "kickass", "ca65"];

const hex = (n: number, digits = 4) => `$${n.toString(16).toUpperCase().padStart(digits, "0")}`;
/** Zero page values keep two digits: ACME reads `$00FB` as a request for 16 bit addressing. */
const address = (n: number) => hex(n, n < 0x100 ? 2 : 4);
const range = (start: number, end: number) => `${address(start)}-${address(end - 1)}`;

interface Syntax {
  comment: string;
  constant(name: string, value: string): string;
  /** Lines that open a block of bytes placed at `origin`. */
  origin(segment: string, origin: number): string;
  byte: string;
}

const SYNTAX: Record<SidwaveAssembler, Syntax> = {
  "64tass": { comment: ";", constant: (n, v) => `${n} = ${v}`, origin: (_, o) => `* = ${hex(o)}`, byte: ".byte" },
  acme: { comment: ";", constant: (n, v) => `${n} = ${v}`, origin: (_, o) => `* = ${hex(o)}`, byte: "!byte" },
  kickass: { comment: "//", constant: (n, v) => `.label ${n} = ${v}`, origin: (_, o) => `* = ${hex(o)}`, byte: ".byte" },
  ca65: { comment: ";", constant: (n, v) => `${n} = ${v}`, origin: (segment) => `.segment "${segment}"`, byte: ".byte" },
};

/**
 * Renders one self-contained source include of a game build: a comment header with the memory use and the call API,
 * the symbols of the symbol files as constants, and the player and data bytes placed at their addresses. With ca65
 * the bytes go into the segments `SIDWAVE_PLAYER` and `SIDWAVE_DATA`; the header holds the linker configuration lines.
 */
export function renderSidwaveGameInclude(build: SidwaveGameBuild, assembler: SidwaveAssembler = "64tass", title = "SIDWave score"): string {
  if (!SIDWAVE_ASSEMBLERS.includes(assembler)) {
    throw new SidwaveValidationError("$.assembler", `unknown assembler "${assembler}"; use ${SIDWAVE_ASSEMBLERS.join(", ")}`);
  }
  if (assembler === "64tass") assertDistinct64tassSymbols(Object.keys(build.labels));
  const syntax = SYNTAX[assembler];
  const { contract, cycles } = build;
  const { player, variables, data } = contract.memory;
  const { entryPoints, registers } = contract;
  const clobbers = (list: string[]) => (list.length ? list.join(", ") : "nothing");
  const worst = cycles.worst === null ? null : Math.max(cycles.worst, cycles.withEffects?.worst ?? 0);
  const header = [
    `${title} - SIDWave game include (${assembler})`,
    `player ${range(player.start, player.end)}`,
    `variables ${range(variables.start, variables.end)} (written at run time, no bytes here; keep this memory free)`,
    data ? `data ${range(data.start, data.end)}` : "data: part of the player block",
    `zero page ${contract.zeroPage.map((z) => range(z.address, z.address + z.bytes)).join(", ")} (saved and restored)`,
    `SID registers written: ${contract.sidRegisters.map((s) => range(s.address, s.address + s.bytes)).join(", ")}`,
    `init ${address(entryPoints.init)}: in A = ${registers.init.in.A}; X = ${registers.init.in.X}; clobbers ${clobbers(registers.init.clobbers)}`,
    `play ${address(entryPoints.play)}: in ${registers.play.in}; clobbers ${clobbers(registers.play.clobbers)}; call ${contract.playCallsPerFrame} time(s) per video frame${contract.songs ? " (song 0; each song has its own rate)" : ""}`,
    `stop ${address(entryPoints.stop)}: in ${registers.stop.in}; clobbers ${clobbers(registers.stop.clobbers)}`,
    `sfx ${address(entryPoints.sfx)}: in ${registers.sfx.in}; clobbers ${clobbers(registers.sfx.clobbers)}; ${registers.sfx.note}`,
    `flags: ${contract.flags}`,
    `$01: ${contract.port01}`,
    worst === null
      ? `cycles per play call: upper bound ${cycles.estimatedWorst} (estimated; not measured)`
      : `cycles per play call: worst ${worst} (measured), upper bound ${cycles.estimatedWorst} (estimated)`,
  ];
  if (assembler === "ca65") {
    const blocks = [["SIDWAVE_PLAYER", player], ...(data ? [["SIDWAVE_DATA", data] as const] : [])] as const;
    header.push(
      "ld65: add these lines to MEMORY { } in the linker configuration:",
      ...blocks.map(([name, block]) => `  ${name}_RAM: start = ${hex(block.start)}, size = ${hex(block.end - block.start)}, file = %O;`),
      "ld65: add these lines to SEGMENTS { }:",
      ...blocks.map(([name]) => `  ${name}: load = ${name}_RAM, type = rw;`),
    );
  } else {
    header.push("this include moves the program counter; set it again before any code or data that follows");
  }
  const lines = header.map((line) => `${syntax.comment} ${commentText(line)}`);
  for (const [name, value] of Object.entries(build.labels)) lines.push(syntax.constant(name, address(value)));
  if (assembler === "ca65") lines.push(".pushseg");
  const block = (segment: string, origin: number, bytes: Uint8Array) => {
    lines.push(syntax.origin(segment, origin));
    for (let i = 0; i < bytes.length; i += 16) {
      lines.push(`${syntax.byte} ${Array.from(bytes.subarray(i, i + 16), (b) => hex(b, 2)).join(", ")}`);
    }
  };
  block("SIDWAVE_PLAYER", player.start, build.player);
  if (build.data) block("SIDWAVE_DATA", data!.start, build.data);
  if (assembler === "ca65") lines.push(".popseg");
  return `${lines.join("\n")}\n`;
}

/** Byte offsets into the player image and into the data block. */
export interface SidwaveRelocationOffsets {
  player: number[];
  data: number[];
}

/**
 * Which bytes of a game build change when it moves by whole pages. `player` and `data` list the offsets that get the
 * page difference (modulo 256) when player and data move by the same number of pages.
 */
export interface SidwaveRelocationTable extends SidwaveRelocationOffsets {
  origin: number;
  dataOrigin: number | null;
  granularity: 256;
  /**
   * Present with a data origin, for moving the two blocks by different amounts: add the player's page difference to the
   * offsets of `playerPages` and the data block's page difference to the offsets of `dataPages`.
   */
  independent?: { playerPages: SidwaveRelocationOffsets; dataPages: SidwaveRelocationOffsets };
}

/** Page shifts to try, in order of preference. */
const PAGE_SHIFTS: readonly number[] = [...new Set([1, -1, 16, -16, ...Array.from({ length: 0xce }, (_, i) => [i + 1, -i - 1]).flat()])];

function changedOffsets(base: Uint8Array, moved: Uint8Array, pages: number): number[] {
  if (base.length !== moved.length) throw new Error("relocation verification failed: shifted image sizes differ");
  const offsets: number[] = [];
  for (let i = 0; i < base.length; i++) {
    if (base[i] === moved[i]) continue;
    if (((moved[i]! - base[i]!) & 0xff) !== (pages & 0xff)) {
      throw new Error(`relocation verification failed: the byte at offset ${i} does not change by the page difference ${pages}`);
    }
    offsets.push(i);
  }
  return offsets;
}

/** Checks that adding the page differences of `moves` to the listed bytes of `base` gives `target` byte for byte. */
export function verifySidwaveRelocation(base: Uint8Array, target: Uint8Array, moves: ReadonlyArray<{ offsets: readonly number[]; pages: number }>): void {
  const moved = Uint8Array.from(base);
  for (const { offsets, pages } of moves) for (const i of offsets) moved[i] = (moved[i]! + pages) & 0xff;
  if (moved.length !== target.length || moved.some((value, i) => value !== target[i])) {
    throw new Error("relocation verification failed: the table does not reproduce the third build");
  }
}

/**
 * Builds the relocation table of a game build. The score is built at the requested layout and again with the player,
 * and separately the data block, moved by whole pages; the table lists the bytes that differ. It is returned only if
 * applying it to the first build gives a third build, with other page differences, byte for byte. The shifted builds
 * use addresses at which the build fits below $D000, so any valid layout can be requested.
 */
export function sidwaveRelocationTable(doc: ParsedSidwave, options: SidwaveGameOptions): SidwaveRelocationTable {
  const at = (origin: number, dataOrigin: number | undefined) => compileSidwave(doc, {
    ...options, origin, dataOrigin, measure: false, maxCycles: undefined, symbols: [], symbolsAll: false,
  });
  const base = at(options.origin, options.dataOrigin);
  const { image } = base;
  const split = options.dataOrigin !== undefined;
  const playerSpan = image.ramEnd - image.origin;
  const dataSpan = split ? image.dataEnd! - options.dataOrigin! : 0;
  const fits = (playerPages: number, dataPages: number) => {
    const origin = options.origin + playerPages * 0x100;
    if (origin < SIDWAVE_GAME_MIN_ORIGIN || origin + Math.max(playerSpan, SIDWAVE_GAME_TABLE_BYTES) > SIDWAVE_MEMORY_END) return false;
    if (!split) return true;
    const data = options.dataOrigin! + dataPages * 0x100;
    if (data < SIDWAVE_GAME_MIN_ORIGIN || data + dataSpan > SIDWAVE_MEMORY_END) return false;
    return !(data < origin + playerSpan && origin < data + dataSpan);
  };
  const noRoom = () => new SidwaveValidationError("$.origin",
    "the relocation table cannot be verified: no page-shifted copy of this build fits below $D000; choose a layout with free pages");
  const build = (playerPages: number, dataPages: number) =>
    at(options.origin + playerPages * 0x100, split ? options.dataOrigin! + dataPages * 0x100 : undefined);
  const offsetsFor = (playerPages: number, dataPages: number): SidwaveRelocationOffsets => {
    const moved = build(playerPages, dataPages);
    const pages = playerPages || dataPages;
    return {
      player: changedOffsets(base.player, moved.player, pages),
      data: split ? changedOffsets(base.data!, moved.data!, pages) : [],
    };
  };
  const playerShift = PAGE_SHIFTS.find((p) => fits(p, 0));
  const dataShift = split ? PAGE_SHIFTS.find((d) => fits(0, d)) : 0;
  if (playerShift === undefined || dataShift === undefined) throw noRoom();
  const playerPages = offsetsFor(playerShift, 0);
  const dataPages = split ? offsetsFor(0, dataShift) : { player: [], data: [] };

  // The third build moves both blocks by page differences that no table was derived from.
  let third: [number, number] | undefined;
  for (const p of PAGE_SHIFTS) {
    if (p === playerShift) continue;
    const d = split ? PAGE_SHIFTS.find((value) => value !== p && value !== dataShift && fits(p, value)) : 0;
    if (d !== undefined && fits(p, d)) { third = [p, d]; break; }
  }
  if (!third) throw noRoom();
  const [p, d] = third;
  const check = build(p, d);
  verifySidwaveRelocation(base.player, check.player, [{ offsets: playerPages.player, pages: p }, { offsets: dataPages.player, pages: d }]);
  if (split) verifySidwaveRelocation(base.data!, check.data!, [{ offsets: playerPages.data, pages: p }, { offsets: dataPages.data, pages: d }]);

  const union = (a: number[], b: number[]) => {
    if (b.some((i) => a.includes(i))) throw new Error("relocation verification failed: a byte depends on both origins");
    return [...a, ...b].sort((x, y) => x - y);
  };
  return {
    origin: options.origin,
    dataOrigin: options.dataOrigin ?? null,
    granularity: 256,
    player: union(playerPages.player, dataPages.player),
    data: union(playerPages.data, dataPages.data),
    ...(split ? { independent: { playerPages, dataPages } } : {}),
  };
}
