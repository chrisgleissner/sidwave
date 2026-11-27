// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// MusicXML export (uncompressed partwise, one part per voice).

import type { ParsedSidwave } from "../sidwave.js";
import { exportEvents, type EventExportOptions, type ExportedNote } from "./events.js";
import { drumKey, programFor } from "./gm.js";
import { escapeXml } from "./xml.js";

export interface MusicXmlExportResult {
  xml: string;
  divisions: number;
  bars: number;
  parts: Array<{ voice: number; id: number; name?: string; notes: number; kind: "pitched" | "drums" }>;
  losses: string[];
  warnings: string[];
}

const STEPS: Array<[string, number]> = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const MAX_MEASURES = 20_000;

function pitchXml(midi: number): string {
  const [step, alter] = STEPS[midi % 12]!;
  return `<pitch><step>${step}</step>${alter ? "<alter>1</alter>" : ""}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
}

interface Piece { from: number; to: number; note?: ExportedNote; on?: number; off?: number }

/** Exports one song of a score as uncompressed partwise MusicXML. See doc/interchange.md for the mapping. */
export function exportMusicXml(doc: ParsedSidwave, options: EventExportOptions = {}): MusicXmlExportResult {
  const score = exportEvents(doc, options);
  const ppq = score.ppq;
  const losses = [...score.losses];
  const warnings: string[] = [];
  let endTick = score.totalTicks;
  for (const voice of score.voices) for (const note of voice.notes) endTick = Math.max(endTick, note.off.tick);

  // Bars from the time signature changes (each starts on a bar line by construction).
  const barStarts: number[] = [];
  const barSigs: Array<{ numerator: number; denominator: number }> = [];
  const sigs = score.timeSignatures.length ? score.timeSignatures : [{ tick: 0, time: 0, bar: 1, numerator: 4, denominator: 4 }];
  for (const [i, sig] of sigs.entries()) {
    const barTicks = Math.round(sig.numerator * 4 / sig.denominator * ppq);
    const stop = i + 1 < sigs.length ? sigs[i + 1]!.tick : Math.max(endTick, sig.tick + barTicks);
    for (let at = sig.tick; at < stop; at += barTicks) {
      barStarts.push(at);
      barSigs.push({ numerator: sig.numerator, denominator: sig.denominator });
      if (barStarts.length > MAX_MEASURES) throw new RangeError(`the score has more than ${MAX_MEASURES} bars`);
    }
  }
  const barEnd = (b: number): number => (b + 1 < barStarts.length ? barStarts[b + 1]! : barStarts[b]! + Math.round(barSigs[b]!.numerator * 4 / barSigs[b]!.denominator * ppq));
  const sectionAt = new Map<number, string>();
  for (const section of score.sections) if (section.name) sectionAt.set(section.tick, section.name);
  const tempoAt = new Map<number, number>();
  for (const tempo of score.tempoMap) tempoAt.set(tempo.tick, tempo.bpm);
  const tempoTicks = [...tempoAt.keys()].sort((a, b) => a - b);

  const instruments = new Map(score.instruments.map((inst) => [inst.index, inst]));
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  out.push(`<work><work-title>${escapeXml(score.title)}</work-title></work>`);
  out.push(`<identification>${score.author ? `<creator type="composer">${escapeXml(score.author)}</creator>` : ""}<encoding><software>SIDWave</software></encoding></identification>`);

  // Instruments per part: one score-instrument per distinct GM program (pitched) or per drum key.
  interface PartPlan { voice: typeof score.voices[number]; pid: string; slots: Map<number, string>; channel: number; slotXml: string[] }
  const plans: PartPlan[] = [];
  let unknownDrum = false;
  let pitchedChannels = 0;
  // A pitched voice that also plays drum hits is written as two parts: the pitched notes, and the hits as an unpitched
  // percussion part, so that a reader sees the drums as drums.
  const partVoices: typeof score.voices = [];
  for (const voice of score.voices) {
    const hits = voice.kind === "pitched" ? voice.notes.filter((n) => n.percussion) : [];
    if (hits.length === 0 || hits.length === voice.notes.length) { partVoices.push(voice); continue; }
    partVoices.push({ ...voice, notes: voice.notes.filter((n) => !n.percussion) });
    partVoices.push({ ...voice, kind: "drums", ...(voice.name ? { name: `${voice.name} drums` } : { name: "drums" }), notes: hits });
  }
  for (const voice of partVoices) {
    const pid = `P${plans.length + 1}`;
    const drums = voice.kind === "drums";
    const slotIndex = drums ? -1 : pitchedChannels++ % 15;
    const channel = drums ? 10 : slotIndex < 9 ? slotIndex + 1 : slotIndex + 2;
    const plan: PartPlan = { voice, pid, slots: new Map(), channel, slotXml: [] };
    for (const note of voice.notes) {
      const key = drums ? drumKey(note.drum).key : programFor(voice, instruments.get(note.instrument)) + 1000;
      if (plan.slots.has(key)) continue;
      const id = `${pid}-I${plan.slots.size + 1}`;
      plan.slots.set(key, id);
      if (drums) {
        const mapped = drumKey(note.drum);
        if (!mapped.known) unknownDrum = true;
        plan.slotXml.push(`<score-instrument id="${id}"><instrument-name>${escapeXml(note.drum ?? "drum")}</instrument-name></score-instrument>`);
        plan.slotXml.push(`<midi-instrument id="${id}"><midi-channel>10</midi-channel><midi-unpitched>${mapped.key + 1}</midi-unpitched></midi-instrument>`);
      } else {
        const program = key - 1000;
        plan.slotXml.push(`<score-instrument id="${id}"><instrument-name>${escapeXml(note.instrument ? (instruments.get(note.instrument)?.name ?? `GM ${program + 1}`) : `GM ${program + 1}`)}</instrument-name></score-instrument>`);
        plan.slotXml.push(`<midi-instrument id="${id}"><midi-channel>${channel}</midi-channel><midi-program>${program + 1}</midi-program></midi-instrument>`);
      }
    }
    plans.push(plan);
  }
  out.push("<part-list>");
  for (const plan of plans) {
    const label = `v${plan.voice.id}${plan.voice.name ? ` ${plan.voice.name}` : ""}`;
    out.push(`<score-part id="${plan.pid}"><part-name>${escapeXml(label)}</part-name>${plan.slotXml.join("")}</score-part>`);
  }
  out.push("</part-list>");

  let beyondBar = 0;
  for (const [partIndex, plan] of plans.entries()) {
    const { voice } = plan;
    const drums = voice.kind === "drums";
    const notes = [...voice.notes].sort((a, b) => a.on.tick - b.on.tick || a.id - b.id);
    out.push(`<part id="${plan.pid}">`);
    const eff = notes.map((n, i) => ({ n, on: n.on.tick, off: Math.max(n.on.tick + 1, Math.min(n.off.tick, notes[i + 1]?.on.tick ?? Infinity)) }));
    let ni = 0;
    for (let b = 0; b < barStarts.length; b++) {
      const bs = barStarts[b]!;
      const be = barEnd(b);
      const sig = barSigs[b]!;
      const sigChanged = b === 0 || sig.numerator !== barSigs[b - 1]!.numerator || sig.denominator !== barSigs[b - 1]!.denominator;
      out.push(`<measure number="${b + 1}">`);
      if (b === 0 || sigChanged) {
        out.push(`<attributes>${b === 0 ? `<divisions>${ppq}</divisions><key><fifths>0</fifths></key>` : ""}<time><beats>${sig.numerator}</beats><beat-type>${sig.denominator}</beat-type></time>${b === 0 ? (voice.role === "bass" ? "<clef><sign>F</sign><line>4</line></clef>" : drums ? "<clef><sign>percussion</sign><line>2</line></clef>" : "<clef><sign>G</sign><line>2</line></clef>") : ""}</attributes>`);
      }
      // Pieces: the notes and rests of this bar.
      const pieces: Piece[] = [];
      let cursor = bs;
      while (ni < eff.length && eff[ni]!.off <= bs) ni++;
      let k = ni;
      while (cursor < be) {
        while (k < eff.length && eff[k]!.off <= cursor) k++;
        const e = eff[k];
        if (e && e.on <= cursor) {
          const stop = Math.min(be, e.off);
          if (e.off > be) beyondBar++;
          pieces.push({ from: cursor, to: stop, note: e.n, on: e.on, off: e.off });
          cursor = stop;
        } else {
          const stop = e ? Math.min(be, e.on) : be;
          pieces.push({ from: cursor, to: stop });
          cursor = stop;
        }
      }
      // Split at tempo ticks inside the bar.
      const split: Piece[] = [];
      for (const piece of pieces) {
        let from = piece.from;
        if (partIndex === 0) {
          let lo = 0, hi = tempoTicks.length; // first tempo tick > from
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (tempoTicks[mid]! > from) hi = mid; else lo = mid + 1; }
          for (let k = lo; k < tempoTicks.length && tempoTicks[k]! < piece.to; k++) { split.push({ ...piece, from, to: tempoTicks[k]! }); from = tempoTicks[k]!; }
        }
        split.push({ ...piece, from });
      }
      if (partIndex === 0 && sectionAt.has(bs)) out.push(`<direction placement="above"><direction-type><rehearsal>${escapeXml(sectionAt.get(bs)!)}</rehearsal></direction-type></direction>`);
      const emittedTempo = new Set<number>();
      for (const piece of split) {
        if (partIndex === 0 && tempoAt.has(piece.from) && !emittedTempo.has(piece.from)) {
          emittedTempo.add(piece.from);
          const bpm = tempoAt.get(piece.from)!;
          out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`);
        }
        const duration = piece.to - piece.from;
        if (duration <= 0) continue;
        if (!piece.note) { out.push(`<note><rest/><duration>${duration}</duration><voice>1</voice></note>`); continue; }
        const note = piece.note;
        const tieStop = piece.from > piece.on!;
        const tieStart = piece.to < piece.off!;
        const percussion = drums;
        const slot = plan.slots.get(percussion ? drumKey(note.drum).key : programFor(voice, instruments.get(note.instrument)) + 1000);
        const dynamics = Math.round(note.velocity / 90 * 10000) / 100;
        out.push(`<note dynamics="${dynamics}">${percussion ? "<unpitched><display-step>C</display-step><display-octave>4</display-octave></unpitched>" : pitchXml(note.pitch)}<duration>${duration}</duration>`
          + `${tieStop ? '<tie type="stop"/>' : ""}${tieStart ? '<tie type="start"/>' : ""}${slot ? `<instrument id="${slot}"/>` : ""}<voice>1</voice>`
          + `${tieStop || tieStart ? `<notations>${tieStop ? '<tied type="stop"/>' : ""}${tieStart ? '<tied type="start"/>' : ""}</notations>` : ""}</note>`);
      }
      out.push("</measure>");
    }
    out.push("</part>");
  }
  out.push("</score-partwise>");
  if (beyondBar) warnings.push("A note that crosses a bar line is written as tied notes.");
  if (unknownDrum) warnings.push("Some drum instruments have no General MIDI equivalent by name and are written as acoustic snare (key 38).");
  losses.push("ADSR envelopes, waveforms, pulse width, ring modulation, sync, filter and wavetables are not written; each instrument becomes a General MIDI program in the part list.");
  losses.push("Pitch bend, glides, slides and vibrato are not written.");
  losses.push("Durations are written in ticks without a note type (quarter, eighth); a notation program engraves them from the duration.");
  return {
    xml: out.join("\n") + "\n", divisions: ppq, bars: barStarts.length,
    parts: plans.map((p) => ({ voice: p.voice.index, id: p.voice.id, ...(p.voice.name ? { name: p.voice.name } : {}), notes: p.voice.notes.length, kind: p.voice.kind })),
    losses: [...new Set(losses)], warnings,
  };
}
