// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Commodore BASIC V2 export: the register values of the compiled SIDWave player, sampled at the notes of the score and
// written as DATA statements with a small player loop.
//
// BASIC V2 executes a few hundred POKE statements per second, so the player cannot repeat the register writes of the
// compiled player (up to 25 registers in every call). The program holds one value per note instead: for each note of
// the score the writer takes the registers that the compiled player holds during the note, and writes only the values
// that change. Records are timed with the jiffy clock TI. The writer predicts how long the interpreter needs for each
// record (BASIC_COST), starts a record early by that amount, and reports the records that cannot be on time.

import { compileSidwaveToPrg } from "../sidwaveCompiler.js";
import { songDoc } from "../sidwaveSongs.js";
import { traceDocument, type DocTrace } from "../compose/trace.js";
import { InterchangeLimitError } from "./errors.js";
import { exportEvents, type ExportedNote, type ExportedVoice } from "./events.js";
import type { WriteContext } from "./formatTypes.js";
import type { Loss } from "./loss.js";

/** BASIC RAM of a C64 ($0801-$9FFF), the number of the power-on message. */
export const BASIC_RAM_BYTES = 38_911;
/** The KERNAL increments TI from a CIA 1 timer that runs at 60 Hz on PAL and on NTSC machines. */
export const JIFFY_HZ = 60;
/** Seconds between the reset of TI and score time 0, so that the first record can be started early. */
export const BASIC_LEAD_SECONDS = 0.5;
/**
 * Interpreter time in seconds, measured on a PAL C64 in VICE 3.10: `wait` from the jiffy of a record to the start of
 * its loop, `write` for one pass of `READ R,V:POKE S+R,V:NEXT`, `record` for the work between two records, and `check`
 * for one DATA value of the checksum pass.
 */
export const BASIC_COST = { wait: 0.006, write: 0.0097, record: 0.016, check: 0.0075 };

/** A record whose last gate write is predicted to be later than this is counted as delayed. */
const DELAY_SECONDS = 0.025;
/** Behind this much, pulse width and filter writes are left out to catch up. */
const SHED_SECONDS = 0.05;
/** Note starts closer than this share one record. */
const GROUP_SECONDS = 0.025;
/** A gate-off followed by the next note of the voice within this time is written together with that note. */
const FOLD_SECONDS = 0.065;
/** Notes per kept voice set that are traced first; a score with more of them is usually too large for BASIC. */
const FIRST_TRACE_NOTES = 1500;
const VARIABLES = ["R", "V", "S", "I", "T", "D", "N", "C", "A"];
/** Bytes of one numeric variable in the BASIC V2 variable table. */
const VARIABLE_BYTES = 7;
/** The keywords the program uses, each stored as one token byte. Operators are one byte in text and in tokens. */
const KEYWORDS = ["RESTORE", "PRINT", "DATA", "GOTO", "NEXT", "POKE", "READ", "THEN", "END", "FOR", "IF", "TO"];

/** Bytes of one tokenised line: link (2), line number (2), the text with keywords as tokens, and the end byte. */
export function basicLineBytes(text: string): number {
  let length = 0;
  let quoted = false;
  let data = false;
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ":") data = false;
    else if (!quoted && !data) {
      const keyword = KEYWORDS.find((word) => text.startsWith(word, i));
      if (keyword) { data = keyword === "DATA"; length++; i += keyword.length; continue; }
    }
    length++;
    i++;
  }
  return length + 5;
}

function playerLines(values: number, checksum: number): string[] {
  // Variables are created in the order of their use in the loop: BASIC V2 searches the table from its start.
  return [
    VARIABLES.map((name) => `${name}=${name === "S" ? 54272 : 0}`).join(":"),
    `PRINT"CHECKING DATA":FOR I=1 TO ${values}:READ A:C=C+A:NEXT`,
    `IF C<>${checksum} THEN PRINT"DATA ERROR":END`,
    `RESTORE:FOR I=0 TO 24:POKE S+I,0:NEXT:PRINT"PLAYING":TI$="000000"`,
    "READ D,N:T=T+D",
    "IF TI<T THEN 60",
    "IF N THEN FOR I=1 TO N:READ R,V:POKE S+R,V:NEXT:GOTO 50",
    "FOR I=0 TO 24:POKE S+I,0:NEXT:END",
  ];
}

interface Sound { freq: number; pw: number; ad: number; sr: number; ctrl: number }

/** One change of one voice: a note start, a legato pitch change or a gate-off. */
interface VoiceChange {
  time: number;
  /** Voice of the SID the program plays, 0..2. */
  slot: number;
  kind: "on" | "legato" | "off";
  sound: Sound;
  /** Clear the gate before the new values: the note starts while the voice is still gated, or its gate-off was folded in. */
  retrigger?: boolean;
  /** $D415..$D418 at this change. */
  globals?: number[];
}

interface Slot { voice: ExportedVoice; slot: number; chip: number; chipOffset: number }

interface Extraction { changes: VoiceChange[]; modulated: number; folded: number; filterMoves: number }

/** Reads the register state of every call and turns it into one change per note start and gate-off. */
function extractChanges(trace: DocTrace, slots: Slot[], primary: Slot, callRate: number, clockHz: number, horizon: number): Extraction {
  const calls = trace.callCount;
  const registers = new Uint8Array(0x400);
  const state = slots.map(() => ({ freq: new Uint16Array(calls), pw: new Uint16Array(calls), ad: new Uint8Array(calls), sr: new Uint8Array(calls), ctrl: new Uint8Array(calls), on: [] as number[], off: [] as number[], gate: 0 }));
  const globals = new Uint8Array(calls * 4);
  const controlSlot = new Map(slots.map((s, i) => [s.chipOffset + (s.voice.channel - 1) * 7 + 4, i]));
  for (let call = 0; call < calls; call++) {
    for (let j = trace.starts[call]!; j < trace.starts[call + 1]!; j++) {
      const offset = trace.writes[j]! >>> 8;
      const value = trace.writes[j]! & 255;
      registers[offset] = value;
      const index = controlSlot.get(offset);
      if (index === undefined) continue;
      const v = state[index]!;
      if ((value & 1) !== v.gate) {
        v.gate = value & 1;
        const edges = v.gate ? v.on : v.off;
        if (edges[edges.length - 1] !== call) edges.push(call);
      }
    }
    slots.forEach((s, i) => {
      const base = s.chipOffset + (s.voice.channel - 1) * 7;
      const v = state[i]!;
      v.freq[call] = registers[base]! | (registers[base + 1]! << 8);
      v.pw[call] = registers[base + 2]! | ((registers[base + 3]! & 15) << 8);
      v.ctrl[call] = registers[base + 4]!;
      v.ad[call] = registers[base + 5]!;
      v.sr[call] = registers[base + 6]!;
    });
    for (let r = 0; r < 4; r++) globals[call * 4 + r] = registers[primary.chipOffset + 21 + r]!;
    // The filter routing bits follow the voices to their slot on the first SID.
    let route = registers[primary.chipOffset + 23]! & 0xf0;
    for (const s of slots) if (registers[s.chipOffset + 23]! & (1 << (s.voice.channel - 1))) route |= 1 << s.slot;
    globals[call * 4 + 2] = route;
  }

  const changes: VoiceChange[] = [];
  let modulated = 0, folded = 0;
  const globalsAt = (call: number): number[] => [globals[call * 4]!, globals[call * 4 + 1]!, globals[call * 4 + 2]!, globals[call * 4 + 3]!];
  const foldCalls = Math.max(1, Math.round(FOLD_SECONDS * callRate));
  slots.forEach((s, i) => {
    const v = state[i]!;
    const noteAt = new Map<number, ExportedNote>();
    for (const note of s.voice.notes) {
      const call = Math.round(note.on.time * callRate);
      if (call < calls && note.on.time < horizon) noteAt.set(call, note);
    }
    // Starts: every gate-on of the player, and every score note without one (legato, ties to a new pitch).
    const nearOn = new Set(v.on.flatMap((call) => [call - 1, call, call + 1]));
    const starts = [...v.on.map((call) => ({ call, kind: "on" as const })), ...[...noteAt.keys()].filter((call) => !nearOn.has(call)).map((call) => ({ call, kind: "legato" as const }))]
      .sort((a, b) => a.call - b.call);
    let off = 0;
    let previous: Sound | undefined;
    starts.forEach((start, n) => {
      const { call, kind } = start;
      if (call / callRate >= horizon) return;
      while (off < v.off.length && v.off[off]! <= call) off++;
      const next = starts[n + 1]?.call ?? calls;
      const release = v.off[off] !== undefined && v.off[off]! < next ? v.off[off] : undefined;
      const end = release ?? next;
      const note = noteAt.get(call) ?? noteAt.get(call - 1) ?? noteAt.get(call + 1);
      // A legato note that begins while the gate is closed changes nothing audible that a later note does not set.
      if (kind === "legato" && !(v.ctrl[call]! & 1)) return;
      // The waveform that sounds for the most calls stands for the note; a one-call attack transient is dropped.
      const counts = new Map<number, number>();
      for (let c = call; c < end; c++) if (v.ctrl[c]! & 0xf0) counts.set(v.ctrl[c]! & 0xf6, (counts.get(v.ctrl[c]! & 0xf6) ?? 0) + 1);
      let wave = v.ctrl[call]! & 0xf6;
      let most = 0;
      for (const [value, count] of counts) if (count > most) { wave = value; most = count; }
      // Of those calls, the first at the pitch of the score (the end of a glide, the base of an arpeggio), else the first.
      const target = note ? 440 * 2 ** ((note.pitch - 69) / 12) : 0;
      let chosen = -1;
      for (let c = call; c < end; c++) {
        if ((v.ctrl[c]! & 0xf6) !== wave) continue;
        if (chosen < 0) chosen = c;
        if (target && Math.abs(Math.log2((v.freq[c]! * clockHz / 16_777_216) / target)) < 0.025) { chosen = c; break; }
      }
      if (chosen < 0) chosen = call;
      const sound: Sound = { freq: v.freq[chosen]!, pw: v.pw[chosen]!, ad: v.ad[chosen]!, sr: v.sr[chosen]!, ctrl: wave | 1 };
      for (let c = call; c < end; c++) {
        if (v.freq[c] !== sound.freq || (v.ctrl[c]! & 0xfe) !== wave || (wave & 0x40 && v.pw[c] !== sound.pw)) { modulated++; break; }
      }
      const before = changes[changes.length - 1];
      let retrigger = false;
      if (kind === "on" && before?.slot === s.slot && before.kind === "off" && (call / callRate) - before.time <= FOLD_SECONDS && call - v.off[off - 1]! <= foldCalls) {
        changes.pop();
        retrigger = true;
        folded++;
      } else if (kind === "on" && before?.slot === s.slot && before.kind !== "off") retrigger = true;
      changes.push({ time: call / callRate, slot: s.slot, kind, sound, ...(retrigger ? { retrigger } : {}), globals: globalsAt(chosen) });
      previous = sound;
      if (release !== undefined) {
        // The envelope the player holds after the gate-off applies, unless it prepares the next note (hard restart).
        const restart = next < calls && next - release <= foldCalls;
        changes.push({ time: Math.min(release / callRate, horizon), slot: s.slot, kind: "off", sound: { ...previous, ...(restart ? {} : { ad: v.ad[release]!, sr: v.sr[release]! }), ctrl: wave } });
      }
    });
    // A voice that is still gated at the end is released there.
    const last = changes[changes.length - 1];
    if (previous && last?.slot === s.slot && last.kind !== "off") changes.push({ time: Math.min(calls / callRate, horizon), slot: s.slot, kind: "off", sound: { ...previous, ctrl: previous.ctrl & 0xfe } });
  });
  changes.sort((a, b) => a.time - b.time || a.slot - b.slot);

  // Filter and volume changes that fall between two note starts are not written.
  let filterMoves = 0;
  const sampled = new Set(changes.filter((c) => c.globals).map((c) => c.globals!.join()));
  for (let call = 1; call < calls && call / callRate < horizon; call++) {
    let moved = false;
    for (let r = 0; r < 4; r++) if (globals[call * 4 + r] !== globals[(call - 1) * 4 + r]) moved = true;
    if (moved && !sampled.has(globalsAt(call).join())) filterMoves++;
  }
  return { changes, modulated, folded, filterMoves };
}

interface BasicRecord {
  /** Jiffy (value of TI) at which the program may start the record. */
  jiffy: number;
  /** Score seconds of the record. */
  time: number;
  writes: Array<[number, number]>;
}

interface Schedule { records: BasicRecord[]; delayed: number; maxDelay: number; meanError: number; maxError: number; shed: number }

/** Groups the changes into records, keeps only register values that change and places the records on the jiffy clock. */
function schedule(changes: VoiceChange[]): Schedule {
  const shadow = new Array<number>(25).fill(0);
  const records: BasicRecord[] = [];
  let jiffy = 0, free = 0, delayed = 0, maxDelay = 0, sumError = 0, maxError = 0, shed = 0;
  for (let i = 0; i < changes.length;) {
    const time = changes[i]!.time;
    const group: VoiceChange[] = [];
    const slots = new Set<number>();
    while (i < changes.length && changes[i]!.time - time < GROUP_SECONDS && !slots.has(changes[i]!.slot)) {
      slots.add(changes[i]!.slot);
      group.push(changes[i++]!);
    }
    const desired = time + BASIC_LEAD_SECONDS;
    const behind = free - desired > SHED_SECONDS;
    const writes: Array<[number, number]> = [];
    const put = (reg: number, value: number, optional = false): void => {
      if (shadow[reg] === value) return;
      if (optional && behind) { shed++; return; }
      shadow[reg] = value;
      writes.push([reg, value]);
    };
    // Restarted gates are cleared first. Then the values of all voices, then the gates, so that the notes of a chord
    // start together, then the gate-offs of voices that end here.
    for (const c of group) if (c.retrigger) put(c.slot * 7 + 4, shadow[c.slot * 7 + 4]! & 0xfe);
    for (const c of group) {
      const base = c.slot * 7;
      if (c.kind !== "off") {
        put(base, c.sound.freq & 255);
        put(base + 1, c.sound.freq >> 8);
        if (c.sound.ctrl & 0x40) {
          put(base + 2, c.sound.pw & 255, shadow[base + 2] !== 0 || shadow[base + 3] !== 0);
          put(base + 3, c.sound.pw >> 8, shadow[base + 2] !== 0 || shadow[base + 3] !== 0);
        }
      }
      put(base + 5, c.sound.ad);
      put(base + 6, c.sound.sr);
    }
    // $D415 holds the lowest 3 bits of the filter cutoff only; it is not worth the time of a write.
    for (const c of group) c.globals?.forEach((value, r) => { if (r > 0) put(21 + r, value, r === 1); });
    let anchor = -1;
    for (const c of group) {
      if (c.kind === "off") continue;
      const length = writes.length;
      put(c.slot * 7 + 4, c.sound.ctrl);
      if (writes.length > length) anchor = writes.length - 1;
    }
    for (const c of group) if (c.kind === "off") put(c.slot * 7 + 4, c.sound.ctrl);
    if (!writes.length) continue;
    if (anchor < 0) anchor = writes.length - 1;
    const latency = BASIC_COST.wait + (anchor + 1) * BASIC_COST.write;
    const previous = jiffy;
    jiffy = Math.max(previous, Math.round((desired - latency) * JIFFY_HZ));
    const start = Math.max(jiffy / JIFFY_HZ + BASIC_COST.wait, free);
    const error = start + (anchor + 1) * BASIC_COST.write - desired;
    free = start + writes.length * BASIC_COST.write + BASIC_COST.record;
    if (error > DELAY_SECONDS) { delayed++; maxDelay = Math.max(maxDelay, error); }
    sumError += Math.abs(error);
    maxError = Math.max(maxError, Math.abs(error));
    records.push({ jiffy, time, writes });
  }
  return { records, delayed, maxDelay, meanError: records.length ? sumError / records.length : 0, maxError, shed };
}

interface Program { text: string; programBytes: number; values: number; checksum: number; lines: number; fitSeconds?: number }

/** The listing, and the score time up to which it fits into BASIC RAM when it is too large. */
function assemble(records: BasicRecord[], endJiffies: number): Program {
  const data: string[] = [];
  let row = "", values = 0, checksum = 0, dataBytes = 0;
  let fitSeconds: number | undefined;
  // Upper bound of the player and the variables, with the longest count and checksum.
  const fixed = playerLines(999_999, 999_999_999).reduce((sum, line) => sum + basicLineBytes(line), 2) + VARIABLES.length * VARIABLE_BYTES;
  const add = (value: number): void => {
    const part = String(value);
    if (row && row.length + 1 + part.length > 70) { data.push(`DATA${row}`); dataBytes += basicLineBytes(`DATA${row}`); row = ""; }
    row += row ? `,${part}` : part;
    values++;
    checksum += value;
  };
  let jiffy = 0;
  for (const record of records) {
    add(record.jiffy - jiffy);
    jiffy = record.jiffy;
    add(record.writes.length);
    for (const [reg, value] of record.writes) { add(reg); add(value); }
    // The first record with which the program, ended here, would no longer fit.
    if (fitSeconds === undefined && fixed + dataBytes + basicLineBytes(`DATA${row},${endJiffies},0`) > BASIC_RAM_BYTES) fitSeconds = record.time;
  }
  add(endJiffies);
  add(0);
  data.push(`DATA${row}`);
  const source = [...playerLines(values, checksum), ...data];
  const programBytes = source.reduce((sum, line) => sum + basicLineBytes(line), 2);
  return { text: source.map((line, i) => `${(i + 1) * 10} ${line}\n`).join(""), programBytes, values, checksum, lines: source.length, ...(fitSeconds === undefined ? {} : { fitSeconds }) };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const ms = (seconds: number): number => Math.round(seconds * 1000);

export function writeBasic(ctx: WriteContext): { bytes: string; losses: Loss[]; report: Record<string, unknown> } {
  const view = ctx.doc.songs ? songDoc(ctx.doc, ctx.song) : ctx.doc;
  const score = exportEvents(ctx.doc, ctx.plan.exportOptions);
  const losses: Loss[] = [];
  const loss = (code: string, severity: Loss["severity"], count: number, message: string): void => {
    if (count > 0) losses.push({ stage: "write", code, severity, count, message });
  };

  // The program plays one SID: voices keep their channel when it is free, so ring modulation and sync keep their source.
  // The plan has already limited the score to three voices and reported the voices it dropped.
  const kept = score.voices.filter((v) => v.notes.length > 0).slice(0, 3);
  const taken = new Set<number>();
  const slots: Slot[] = kept.map((voice) => {
    let slot = voice.channel - 1;
    if (taken.has(slot)) slot = [0, 1, 2].find((n) => !taken.has(n) && !kept.some((other) => other.channel - 1 === n))!;
    taken.add(slot);
    return { voice, slot, chip: voice.sid, chipOffset: (view.sids[voice.sid]?.address ?? 0xd400) - 0xd400 };
  });
  loss("basic.sid.moved", "approx", slots.filter((s) => s.chip !== 0).length, "Voices of other SIDs play on the SID at $D400, with one filter and one volume for all voices.");

  const horizon = ctx.seconds ?? Infinity;
  let extraction: Extraction = { changes: [], modulated: 0, folded: 0, filterMoves: 0 };
  let plan = schedule([]);
  let program = assemble([], 0);
  if (slots.length) {
    const callRate = score.callRate;
    const clockHz = view.song.mode === "NTSC" ? 1_022_727 : 985_248;
    const primary = slots.find((s) => s.chip === 0) ?? slots[0]!;
    const compiled = compileSidwaveToPrg(view, { loop: false });
    const totalFrames = compiled.totalFrames;
    const starts = slots.flatMap((s) => s.voice.notes.map((n) => n.on.time)).sort((a, b) => a - b);
    const wanted = Math.min(totalFrames, Number.isFinite(horizon) ? Math.ceil(horizon * callRate) + 1 : totalFrames);
    // A long score is traced up to its FIRST_TRACE_NOTES first: if that part already exceeds BASIC RAM, the rest is not needed.
    const first = starts.length > FIRST_TRACE_NOTES ? Math.min(wanted, Math.ceil(starts[FIRST_TRACE_NOTES]! * callRate)) : wanted;
    for (const calls of first < wanted ? [first, wanted] : [wanted]) {
      const trace = traceDocument(view, { compiled, calls });
      extraction = extractChanges(trace, slots, primary, callRate, clockHz, Math.min(horizon, calls === totalFrames ? Infinity : calls / callRate));
      plan = schedule(extraction.changes);
      program = assemble(plan.records, JIFFY_HZ);
      if (program.programBytes + VARIABLES.length * VARIABLE_BYTES > BASIC_RAM_BYTES) break;
    }
  }
  const size = program.programBytes + VARIABLES.length * VARIABLE_BYTES;
  if (size > BASIC_RAM_BYTES) {
    const fit = Math.max(1, Math.floor(program.fitSeconds ?? 1));
    throw new InterchangeLimitError(`the tokenised BASIC V2 program needs more than the ${BASIC_RAM_BYTES} bytes of BASIC RAM (program and ${VARIABLES.length} variables). Shorten the score: --seconds ${fit} writes its first ${fit} seconds, which fit; --voices 1 or 2 makes the program smaller; or split the score into several programs.`);
  }

  const omitted = kept.reduce((n, v) => n + v.notes.filter((note) => note.on.time >= horizon).length, 0);
  loss("basic.truncated", "lost", omitted, `${plural(omitted, "note")} after ${ctx.seconds} seconds are not written (--seconds).`);
  loss("basic.modulation.dropped", "lost", extraction.modulated, `${plural(extraction.modulated, "note")} change pitch, waveform or pulse width while sounding (wavetable, vibrato, arpeggio, glide, pulse sweep); the program holds one value of each per note.`);
  loss("basic.filter.sampled", "approx", extraction.filterMoves, `${plural(extraction.filterMoves, "change")} of the filter or volume registers between note starts are not written; the values are updated at note starts only.`);
  loss("basic.digi.dropped", "lost", view.samples ? 1 : 0, "Digi samples are not played by the BASIC program.");
  loss("basic.timing.jiffy", "approx", plan.records.length, `Records are timed with TI (${JIFFY_HZ} Hz, 16.7 ms steps) and the interpreter writes one register about every ${ms(BASIC_COST.write)} ms: predicted note start error ${ms(plan.meanError)} ms mean, ${ms(plan.maxError)} ms maximum; the phase of TI adds up to 17 ms, and gate-offs are less exact than note starts. ${plural(extraction.folded, "gate-off")} shortly before the next note of a voice are written together with that note.`);
  loss("basic.timing.dense", "approx", plan.delayed, `${plural(plan.delayed, "event")} are too dense for BASIC V2 and are delayed by more than ${ms(DELAY_SECONDS)} ms, at most ${ms(plan.maxDelay)} ms (predicted). --voices 2 or 1 writes fewer registers.`);
  loss("basic.timing.shed", "approx", plan.shed, `${plural(plan.shed, "pulse width or filter write")} are left out to catch up in dense passages.`);

  return {
    bytes: program.text,
    losses,
    report: {
      events: plan.records.length,
      writes: plan.records.reduce((n, r) => n + r.writes.length, 0),
      clock: `TI (${JIFFY_HZ} Hz)`,
      leadSeconds: BASIC_LEAD_SECONDS,
      checkSeconds: Math.ceil(program.values * BASIC_COST.check),
      predictedMeanErrorMs: ms(plan.meanError),
      predictedMaxErrorMs: ms(plan.maxError),
      delayedEvents: plan.delayed,
      maxDelayMs: ms(plan.maxDelay),
      tokenisedBytes: size,
      programTokenBytes: program.programBytes,
      variableBytes: VARIABLES.length * VARIABLE_BYTES,
      availableBytes: BASIC_RAM_BYTES,
      values: program.values,
      checksum: program.checksum,
      lineCount: program.lines,
    },
  };
}
