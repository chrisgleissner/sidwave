// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SIDWave 1.4 songs: the per-song view of a document, the song selector of the player, the PSID speed bits and the lint

import { parseLayerSequence, type ParsedSidwave } from "./sidwave.js";

/** A finding that the compiler adds to the lint result: code, position of the first occurrence and message. */
export interface SongFinding { code: string; first: string; message: string }

/** True when the document has more than one song, which makes the player select its song at `init`. */
export function hasSongSelect(doc: Pick<ParsedSidwave, "songs">): boolean {
  return (doc.songs?.length ?? 0) > 1;
}

/**
 * The document as it reads for one song: that song's timeline, tempo, speed, loop target and length. Instruments, voices,
 * patterns and named sections are shared, so the result arranges exactly like a SIDWave 1.3 document that holds only
 * this song. Song 0 is already the document's own view (see `ParsedSidwave.songs`).
 */
export function songDoc(doc: ParsedSidwave, index: number): ParsedSidwave {
  const song = doc.songs?.[index];
  if (!song) throw new RangeError(`song ${index} does not exist`);
  const { songs: _songs, definedSections: _defined, ...rest } = doc;
  return {
    ...rest,
    timeline: song.timeline,
    speed: song.speed,
    song: { ...doc.song, tempo: song.tempo, length_bars: song.length_bars },
    loopTo: song.loopTo,
    end: undefined,
  };
}

/**
 * The 32-bit PSID speed field: bit n is set when song n+1 is timed by the CIA timer, which is how the player runs a
 * song with more than one play call per video frame. A document without songs sets bit 0 for its speed.
 */
export function psidSpeedBits(doc: Pick<ParsedSidwave, "songs" | "speed">): number {
  const speeds = doc.songs ? doc.songs.map((song) => song.speed) : [doc.speed];
  return speeds.reduce((bits, speed, i) => (speed > 1 ? (bits | (1 << i)) >>> 0 : bits), 0);
}

/**
 * Lint for documents with songs: voice patterns and named sections that no song plays, and songs that never play a
 * note. Documents without songs are not checked, so their findings do not change.
 */
export function lintSongs(doc: ParsedSidwave): SongFinding[] {
  const songs = doc.songs;
  if (!songs) return [];
  const findings: SongFinding[] = [];
  const owners = [
    ...doc.voices.map((voice) => ({ key: `v${voice.id}`, label: `voice ${voice.id}`, patterns: Object.keys(voice.patterns ?? {}) })),
    ...(doc.digiVoices ?? []).map((digi) => ({ key: digi.id, label: `digi voice ${digi.id}`, patterns: Object.keys(digi.patterns) })),
  ];
  const played = new Set<string>();
  const sections = new Set<string>();
  songs.forEach((song) => {
    let notes = false;
    song.timeline.forEach((entry, i) => {
      if (entry.section) sections.add(entry.section);
      for (const owner of owners) {
        const ref = entry.layers[owner.key];
        if (ref === undefined) continue;
        for (const item of parseLayerSequence(ref, owner.patterns, `$.songs.${song.name}.timeline[${i}].layers.${owner.key}`).items) {
          if (!item.pattern) continue;
          played.add(`${owner.key}:${item.pattern}`);
          notes = true;
        }
      }
    });
    if (!notes) {
      findings.push({ code: "SONG-SILENT", first: `song "${song.name}"`, message: "The song never plays a pattern; every layer of its timeline is a rest" });
    }
  });
  for (const owner of owners) {
    for (const pattern of owner.patterns) {
      if (!played.has(`${owner.key}:${pattern}`)) {
        findings.push({ code: "UNUSED-PATTERN", first: `${owner.label} pattern "${pattern}"`, message: "No song plays this pattern; remove it or add it to a timeline" });
      }
    }
  }
  for (const name of doc.definedSections ?? []) {
    if (!sections.has(name)) {
      findings.push({ code: "UNUSED-SECTION", first: `section "${name}"`, message: "No song uses this named section; remove it or add it to a timeline" });
    }
  }
  return findings;
}

/** Values that depend on the song, one array of bytes per song. */
export type SongValues = number[][];

/** True when the songs do not all have the same bytes. */
export function differsBySong(values: SongValues): boolean {
  return values.some((bytes) => bytes.length !== values[0]!.length || bytes.some((value, i) => value !== values[0]![i]));
}

interface Column { label: string; length: number; values: SongValues }

/**
 * Builds the song selector of a player with several songs: the 6502 routine `song_select`, which `init` calls, and the
 * tables behind it. It clamps the song index to song 0 when it is out of range, copies the song's stream start and loop
 * pointers into RAM, and copies every constant that differs between the songs (filter envelope values, the live
 * voices, the play-once length and so on) over the player's own label, so the rest of the player does not know about
 * songs. A constant that is the same in every song stays a plain constant and costs nothing.
 */
export class SongSelect {
  private readonly columns: Column[] = [];

  constructor(
    readonly songs: number,
    /** Voice channels of the player (3 per SID); every song has one stream per channel. */
    readonly channels: number,
    readonly startSong: number,
    /** A PRG or PSID player programs the CIA 1 timer of the song at init; a game build leaves the timer to the game. */
    private readonly ciaLatches?: { lo: number[]; hi: number[] },
  ) {
    if (songs * channels > 255) throw new RangeError("the song tables are indexed by one byte");
  }

  /**
   * The definition line of a column of constants. The assembled bytes are those of the start song. When the songs differ,
   * the copy of the song's own bytes is added to `song_select`.
   */
  column(label: string, values: SongValues): string {
    if (differsBySong(values)) this.columns.push({ label, length: values[0]!.length, values });
    return `${label}: .byte ${values[this.startSong]!.join(", ")}`;
  }

  /** A column whose label is defined elsewhere in the player (the play-once length). */
  copy(label: string, values: SongValues): void {
    this.columns.push({ label, length: values[0]!.length, values });
  }

  /** True when `column` or `copy` registered a constant that differs between the songs. */
  get hasColumns(): boolean { return this.columns.length > 0; }

  /** Source lines of the selector and its tables; `starts` and `loops` hold one assembler expression per stream. */
  asm(starts: string[], loops: string[]): string[] {
    const n = this.songs;
    const c = this.channels;
    const lines = [
      "song_select:",
      "  stx ss_clock",
      "  lda song_sel",
      `  cmp #${n}`,
      "  bcc ss_ok",
      "  lda #0",
      "  sta song_sel",
      "ss_ok:",
      "  tax",
    ];
    if (this.ciaLatches) {
      lines.push("  asl", "  ora ss_clock", "  tay", "  lda ss_cia_lo,y", "  sta $DC04", "  lda ss_cia_hi,y", "  sta $DC05");
    }
    lines.push(
      `  lda song_mul${c},x`,
      "  tax",
      "  ldy #0",
      "ss_streams:",
      "  lda ss_start_lo,x",
      "  sta start_lo,y",
      "  lda ss_start_hi,x",
      "  sta start_hi,y",
      "  lda ss_loop_lo,x",
      "  sta loop_lo,y",
      "  lda ss_loop_hi,x",
      "  sta loop_hi,y",
      "  inx",
      "  iny",
      `  cpy #${c}`,
      "  bne ss_streams",
    );
    const lengths = new Set<number>([c]);
    this.columns.forEach((column, k) => {
      lines.push("  ldx song_sel");
      if (column.length === 1) {
        lines.push(`  lda ss_col${k},x`, `  sta ${column.label}`);
        return;
      }
      lengths.add(column.length);
      lines.push(`  lda song_mul${column.length},x`, "  tax", "  ldy #0", `ss_copy${k}:`, `  lda ss_col${k},x`, `  sta ${column.label},y`,
        "  inx", "  iny", `  cpy #${column.length}`, `  bne ss_copy${k}`);
    });
    lines.push("  ldx ss_clock", "  rts", "ss_clock: .byte 0", `song_sel: .byte ${this.startSong}`);
    for (const length of [...lengths].sort((a, b) => a - b)) {
      lines.push(`song_mul${length}: .byte ${Array.from({ length: n }, (_, i) => i * length).join(", ")}`);
    }
    lines.push(`ss_start_lo: .byte ${starts.map((s) => `<${s}`).join(", ")}`, `ss_start_hi: .byte ${starts.map((s) => `>${s}`).join(", ")}`,
      `ss_loop_lo: .byte ${loops.map((s) => `<${s}`).join(", ")}`, `ss_loop_hi: .byte ${loops.map((s) => `>${s}`).join(", ")}`);
    if (this.ciaLatches) {
      lines.push(`ss_cia_lo: .byte ${this.ciaLatches.lo.join(", ")}`, `ss_cia_hi: .byte ${this.ciaLatches.hi.join(", ")}`);
    }
    this.columns.forEach((column, k) => lines.push(`ss_col${k}: .byte ${column.values.flat().join(", ")}`));
    lines.push("start_lo: .res " + c, "start_hi: .res " + c, "loop_lo: .res " + c, "loop_hi: .res " + c);
    return lines;
  }
}

/** Merges the sample start and stop commands of several songs into one table and renumbers the stream events. */
export interface SampleCommandLike { chip: number; at: number[]; pitch: number; name?: string; stopChips?: number[] }

export function mergeSampleCommands(songCommands: Array<SampleCommandLike[] | undefined>,
  events: Array<Array<Array<{ bytes: number[] }>>>, sampleOp: number): SampleCommandLike[] {
  const merged: SampleCommandLike[] = [];
  const index = new Map<string, number>();
  songCommands.forEach((commands, song) => {
    if (!commands) return;
    const map = commands.map((command) => {
      const key = JSON.stringify([command.chip, command.pitch, command.name, command.stopChips]);
      let found = index.get(key);
      if (found === undefined) {
        found = merged.length;
        index.set(key, found);
        merged.push({ ...command, at: [] });
      }
      merged[found]!.at.push(...command.at);
      return found;
    });
    for (const voice of events[song]!) {
      for (const event of voice) if (event.bytes[0] === sampleOp) event.bytes = [sampleOp, map[event.bytes[1]!]!];
    }
  });
  return merged;
}
