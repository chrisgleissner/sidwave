// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import YAML from "yaml";
import type { SidwaveReadOptions } from "../sidwavePcm.js";
import { parseSidwave, SIDWAVE_NOTE_RANGE, SIDWAVE_TEMPO_RANGE, noteNameToMidi } from "../sidwave.js";
import { compileSidwaveToPrg, estimateSidwaveCycles, maxSidwaveMidi } from "../sidwaveCompiler.js";
import { formatSidwave } from "../format/sidwaveFormat.js";

export class SidwaveTransformError extends Error {
  constructor(public readonly code: "input" | "precondition" | "out_of_range" | "unsupported", message: string) { super(message); this.name = "SidwaveTransformError"; }
}
export interface TransformReport { changed: string[]; preserved: string[]; warnings: string[] }
export interface TransformResult { text: string; report: TransformReport }
/**
 * How a transformation checks its input and result: "compile" (default) parses the score and compiles it to a PRG,
 * "parse" only parses it, "none" skips the check (for fragments that are not complete scores). The input must parse
 * (otherwise code "input"); a result that does not pass the check is never returned, the transformation throws
 * code "precondition" with the message of the parser or compiler instead. "arrange" parses the result and runs the
 * compiler up to the assembler (it finds the errors of the score, such as a bend that does not fit its note, in about
 * 40 % of the time of "compile"; it does not assemble the player).
 */
export type TransformValidation = "compile" | "arrange" | "parse" | "none";
export interface TransformOptions {
  validate?: TransformValidation;
  /** The input was checked by an earlier step: do not parse it again. The result is still checked as `validate` says. */
  inputChecked?: boolean;
  /** Read options for the parser, as for compiling: a score with `imports` needs `imports` (see `confinedReadOptions`). */
  read?: SidwaveReadOptions;
}
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const ptr = (p: string[]) => "/" + p.map(esc).join("/");
type AnyDoc = YAML.Document<any>;
function docFor(text: string, validate: TransformValidation = "compile", read?: SidwaveReadOptions, inputChecked = false): AnyDoc {
  const doc = YAML.parseDocument(text, { version: "1.2", keepSourceTokens: true });
  if (doc.errors.length) throw new SidwaveTransformError("input", doc.errors[0]!.message);
  if (!YAML.isMap(doc.contents)) throw new SidwaveTransformError("input", "The input is not a SIDWave score: expected a YAML mapping at the top level");
  if (validate !== "none" && !inputChecked) {
    try { parseSidwave(text, read); } catch (e) { throw new SidwaveTransformError("input", `The input is not a valid SIDWave score: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return doc;
}
function finish(doc: AnyDoc, changed: string[], preserved: string[], warnings: string[] = [], validate: TransformValidation = "compile", read?: SidwaveReadOptions): TransformResult {
  const text = formatSidwave(doc.toString());
  if (validate !== "none") {
    let parsed;
    try { parsed = parseSidwave(text, read); } catch (e) { throw new SidwaveTransformError("precondition", `The result is not a valid SIDWave score: ${e instanceof Error ? e.message : String(e)}`); }
    if (validate === "arrange") {
      try { estimateSidwaveCycles(parsed, { loop: false }); } catch (e) { throw new SidwaveTransformError("precondition", `The result does not compile: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (validate === "compile") {
      try { compileSidwaveToPrg(parsed, { loop: false }); } catch (e) { throw new SidwaveTransformError("precondition", `The result does not compile: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  return { text, report: { changed, preserved, warnings } };
}
function js(doc: AnyDoc): any { return doc.toJS(); }
function nodeAt(doc: AnyDoc, path: (string | number)[]): any { return doc.getIn(path, true) as any; }
function setAt(doc: AnyDoc, path: (string | number)[], value: unknown): void { doc.setIn(path, value as any); }
function numericTempo(root: any): number { return root.tempo ?? root.song?.tempo ?? 100; }
function setTempoNode(doc: AnyDoc, root: any, bpm: number): string {
  const path = root.tempo !== undefined ? ["tempo"] : root.song?.tempo !== undefined ? ["song", "tempo"] : ["tempo"];
  setAt(doc, path, bpm); return ptr(path.map(String));
}
function noteTokens(raw: string): Array<{ value: string; start: number; end: number }> {
  const out: Array<{value:string;start:number;end:number}> = [];
  const re = /(?<![A-Za-z0-9_@])([A-Ga-g](?:#|b)?-?\d+)(?![A-Za-z0-9_])/g;
  for (let m; (m = re.exec(raw));) if (noteNameToMidi(m[1]!) !== undefined) out.push({ value: m[1]!, start: m.index, end: m.index + m[1]!.length });
  return out;
}
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Pitch-class name of a MIDI note. A token that already has an accidental keeps its style (Bb stays flat); a natural note takes the document style. */
function pitchClass(midi: number, original: string, flatDefault: boolean): string {
  const flat = /^[A-Ga-g]b/.test(original) ? true : /^[A-Ga-g]#/.test(original) ? false : flatDefault;
  return (flat ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12]!;
}
/** The document style for naturals that become black keys: flats when the score spells more notes with flats than with sharps. */
function prefersFlats(text: string): boolean {
  let flats = 0, sharps = 0;
  for (const spelled of [...noteTokens(text).map((n) => n.value), ...chordTokens(text).map((c) => c.root)]) { if (/^[A-Ga-g]b/.test(spelled)) flats++; else if (/^[A-Ga-g]#/.test(spelled)) sharps++; }
  return flats > sharps;
}
function shiftedNote(raw: string, amount: number, max: number, path: string, flatDefault = false): string {
  const midi = noteNameToMidi(raw)! + amount;
  if (midi < SIDWAVE_NOTE_RANGE.min || midi > SIDWAVE_NOTE_RANGE.max || midi > max) throw new SidwaveTransformError("out_of_range", `Offending note at ${path}`);
  return pitchClass(midi, raw, flatDefault) + (Math.floor(midi / 12) - 1);
}
const CHORD_NAMED = "m|min|maj|dim|aug|sus2|sus4|sus|m6|min6|maj7|m7|min7|dim7|m7b5|maj9|m9|min9|add9";
const CHORD_QUALITY = new RegExp(`^(?:${CHORD_NAMED}|6|7|9)?$`);
/** Chord root of a chord symbol shifted by `amount` semitones, written as a pitch class without octave (Cm7 + 2 gives Dm7). */
function shiftedChord(root: string, quality: string, amount: number, max: number, path: string, flatDefault = false): string {
  const pitch = noteNameToMidi(`${root}3`)! + amount;
  if (pitch < 12 || pitch > max) throw new SidwaveTransformError("out_of_range", `Offending note at ${path}`);
  return pitchClass(pitch, root, flatDefault) + quality;
}
/** Chord symbols inside a groove string, such as the Cm7 of "Cm7@arp". Qualities that are only digits (C7) are note names and are found by noteTokens. */
function chordTokens(raw: string): Array<{ root: string; quality: string; start: number; end: number }> {
  const out: Array<{root:string;quality:string;start:number;end:number}> = [];
  const re = new RegExp(`(?<![A-Za-z0-9_@#/])([A-G](?:#|b)?)(${CHORD_NAMED})(?![A-Za-z0-9_#/])`, "g");
  for (let m; (m = re.exec(raw));) out.push({ root: m[1]!, quality: m[2]!, start: m.index, end: m.index + m[0].length });
  return out;
}
function replacements(raw: string, amount: number, max: number, path: string, flatDefault: boolean): string {
  const tokens = [
    ...noteTokens(raw).map((n) => ({ start: n.start, end: n.end, text: () => shiftedNote(n.value, amount, max, path, flatDefault) })),
    ...chordTokens(raw).map((c) => ({ start: c.start, end: c.end, text: () => shiftedChord(c.root, c.quality, amount, max, path, flatDefault) })),
  ].sort((x, y) => y.start - x.start);
  let result = raw;
  for (const t of tokens) result = result.slice(0, t.start) + t.text() + result.slice(t.end);
  return result;
}
function patternNamesFor(root: any, voice: any): string[] { return Object.keys(voice.patterns ?? {}); }
/** Pattern names that voice `voiceId` plays in the sections accepted by `pick`. Inline timeline entries have no name (undefined). */
function sectionPatternUse(root: any, pick: (name: string | undefined) => boolean, voiceId: string): Set<string> {
  const defs = root.sections ?? {};
  const result = new Set<string>();
  const add = (layers: any) => {
    const v = layers?.[`v${voiceId}`];
    if (typeof v === "string") for (const part of v.split(/[\s()*]+/)) result.add(part.replace(/[+-]\d+$/, ""));
  };
  for (const [name, def] of Object.entries<any>(defs)) if (pick(name)) add(def?.layers);
  for (const entry of root.timeline ?? []) {
    const name = typeof entry === "string" ? entry.split(/[+*]/)[0] : entry?.use ?? entry?.section;
    if (!pick(name)) continue;
    add(typeof entry === "object" ? { ...(name !== undefined ? defs[name]?.layers ?? {} : {}), ...(entry.layers ?? {}) } : defs[name!]?.layers);
  }
  return result;
}

/** Bar group (count of preceding "|" separators in string entries) of each groove entry. Duration-bearing object entries belong to the group they appear in. */
function entryGroups(entries: any[]): number[] {
  let group = 0;
  return entries.map((entry) => {
    const at = group;
    if (typeof entry === "string") group += entry.split(/\s+/).filter((token) => token === "|").length;
    return at;
  });
}
const tidy = (x: number) => Number(x.toPrecision(12));

/** Preconditions: the input is a valid score; semitones is an integer; every shifted pitched note stays in SIDWAVE_NOTE_RANGE and the selected clock's SID frequency range. Preserves rhythm, percussion encodings, instruments, and voices outside scope. Scope is restricted to patterns used only in selected named sections; ambiguous shared/inline/sequence scoping is unsupported. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function transpose(text: string, options: TransformOptions & { semitones: number; scope?: { voices?: string[]; sections?: string[] } }): TransformResult {
  if (!Number.isInteger(options?.semitones)) throw new SidwaveTransformError("precondition", "semitones must be an integer");
  const doc = docFor(text, options.validate, options.read, options.inputChecked), flat = prefersFlats(text), root = js(doc), changed: string[] = [], max = maxSidwaveMidi(root.mode === "NTSC" ? "NTSC" : "PAL");
  const selectedSections = new Set(options.scope?.sections ?? []);
  for (const name of selectedSections) if (!(root.sections?.[name]) && !(root.timeline ?? []).some((e: any) => e?.section === name)) throw new SidwaveTransformError("precondition", `Unknown section ${name}`);
  // Nothing moves: return the text as it was given, not a re-spelled copy.
  if (options.semitones === 0) return { text, report: { changed, preserved: ["rhythm", "percussion", "instruments", "voices outside scope"], warnings: [] } };
  for (const [vi, voice] of (root.voices ?? []).entries()) {
    const id = String(voice.id ?? vi + 1), name = String(voice.name ?? "");
    if (voice.role === "drums") continue;
    if (options.scope?.voices && !options.scope.voices.includes(id) && !options.scope.voices.includes(name)) continue;
    const allowed = selectedSections.size ? sectionPatternUse(root, (n) => n !== undefined && selectedSections.has(n), id) : undefined;
    const outside = allowed ? sectionPatternUse(root, (n) => n === undefined || !selectedSections.has(n), id) : undefined;
    const pnames = patternNamesFor(root, voice);
    for (const [pname, pattern] of Object.entries<any>(voice.patterns ?? {})) {
      if (allowed && !allowed.has(pname)) continue;
      if (outside?.has(pname)) throw new SidwaveTransformError("unsupported", `Pattern ${pname} of voice ${id} is also played outside the selected sections`);
      const base = ["voices", vi, "patterns", pname] as (string|number)[];
      const mutateString = (path: (string|number)[], val: string, exempt = false) => {
        if (exempt || !(noteTokens(val).length || chordTokens(val).length)) return;
        const next = replacements(val, options.semitones, max, ptr(path.map(String)), flat);
        if (next !== val) { setAt(doc,path,next); changed.push(ptr(path.map(String))); }
      };
      if (typeof pattern.groove === "string") mutateString([...base,"groove"], pattern.groove);
      else if (Array.isArray(pattern.groove)) pattern.groove.forEach((entry:any, ei:number) => {
        const path=[...base,"groove",ei] as (string|number)[];
        if (typeof entry === "string") mutateString(path,entry);
        else if (entry && typeof entry.note === "string") { mutateString([...path,"note"],entry.note,entry.kitNote === true); if(typeof entry.slide_from==="string") mutateString([...path,"slide_from"],entry.slide_from,entry.kitNote===true); if(entry.bend && typeof entry.bend.to==="string") mutateString([...path,"bend","to"],entry.bend.to,entry.kitNote===true); }
        else if (entry && typeof entry.chord === "string") {
          const symbol = /^([A-Ga-g](?:#|b)?)(.*)$/.exec(entry.chord);
          if (!symbol || !CHORD_QUALITY.test(symbol[2]!)) throw new SidwaveTransformError("unsupported", `Cannot transpose chord ${entry.chord} at ${ptr(path.map(String))}`);
          setAt(doc, [...path, "chord"], shiftedChord(symbol[1]!, symbol[2]!, options.semitones, max, ptr([...path, "chord"].map(String)), flat)); changed.push(ptr([...path, "chord"].map(String)));
        }
        else if (entry && typeof entry === "object") throw new SidwaveTransformError("unsupported", `Cannot transpose groove construct at ${ptr(path.map(String))}`);
      });
      if (Array.isArray(pattern.notes)) pattern.notes.forEach((note:string, ni:number) => mutateString([...base,"notes",ni],note));
      if (typeof pattern.motif === "string") {
        // Motif chord symbols and integer offsets need musical transposition, not text note substitution.
        const tokens=pattern.motif.split(/([\s,]+)/); let did=false;
        const next=tokens.map((tok:string)=>{
          if (/^[+-]?\d+$/.test(tok)) { did=true; const n=Number(tok)+options.semitones; const rootMidi=noteNameToMidi(pattern.root??"C3")??48; if(rootMidi+n<SIDWAVE_NOTE_RANGE.min||rootMidi+n>max) throw new SidwaveTransformError("out_of_range",`Offending note at ${ptr([...base,"motif"].map(String))}`); return String(n); }
          if (/^[A-Ga-g](?:#|b)?\d+$/.test(tok)) { did=true; return shiftedNote(tok,options.semitones,max,ptr([...base,"motif"].map(String)),flat); }
          const chord=/^([A-Ga-g](?:#|b)?)(.*)$/.exec(tok);
          if (chord && CHORD_QUALITY.test(chord[2]!)) { did=true; const pitch=noteNameToMidi(`${chord[1]}3`)!+options.semitones; if(pitch<12||pitch>max) throw new SidwaveTransformError("out_of_range",`Offending note at ${ptr([...base,"motif"].map(String))}`); return pitchClass(pitch,chord[1]!,flat)+chord[2]; }
          return tok;
        }).join("");
        if(did&&next!==pattern.motif){setAt(doc,[...base,"motif"],next);changed.push(ptr([...base,"motif"].map(String)));}
      }
      void pnames;
    }
  }
  return finish(doc, changed, ["rhythm", "percussion", "instruments", "voices outside scope"], [], options.validate, options.read);
}

/** Preconditions: the input is a valid score; bpm is finite and within SIDWAVE_TEMPO_RANGE. Preserves all note and pitch fields. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function setTempo(text:string,{bpm,validate,read,inputChecked}:TransformOptions&{bpm:number}):TransformResult {
  if(!Number.isFinite(bpm)||bpm<SIDWAVE_TEMPO_RANGE.min||bpm>SIDWAVE_TEMPO_RANGE.max) throw new SidwaveTransformError("out_of_range",`bpm must be ${SIDWAVE_TEMPO_RANGE.min}..${SIDWAVE_TEMPO_RANGE.max}`);
  const doc=docFor(text,validate,read,inputChecked), root=js(doc), changed=[setTempoNode(doc,root,bpm)]; return finish(doc,changed,["notes","pitches"],[],validate,read);
}
/** Preconditions: the input is a valid score; factor is finite and positive and the resulting tempo is within SIDWAVE_TEMPO_RANGE. Preserves all note and pitch fields. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function scaleTempo(text:string,{factor,validate,read,inputChecked}:TransformOptions&{factor:number}):TransformResult {
  if(!Number.isFinite(factor)||factor<=0) throw new SidwaveTransformError("precondition","factor must be positive and finite");
  const root=js(docFor(text,validate,read,inputChecked)), current=numericTempo(root), bpm=current*factor;
  if(!Number.isFinite(bpm)||bpm<SIDWAVE_TEMPO_RANGE.min||bpm>SIDWAVE_TEMPO_RANGE.max) throw new SidwaveTransformError("out_of_range",`scaled tempo ${bpm} is outside ${SIDWAVE_TEMPO_RANGE.min}..${SIDWAVE_TEMPO_RANGE.max}`);
  return setTempo(text,{bpm,validate,read,inputChecked:true});
}
/** Preconditions: the input is a valid score; target is a named instrument defined in instruments or an accepted lib: recipe; the source reference exists. Preserves all other instrument definitions and references. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function substituteInstrument(text:string,{from,to,validate,read,inputChecked}:TransformOptions&{from:string;to:string}):TransformResult {
  const doc=docFor(text,validate,read,inputChecked), root=js(doc);
  const exists=!!root.instruments?.[to] || (to.startsWith("lib:") && /^(kick|snare|hat|bass_pluck|filter_bass|lead_pwm|chip_arp_major|chip_arp_minor|bell_ring|sync_lead|pad_slow)$/.test(to.slice(4)));
  if(!exists) throw new SidwaveTransformError("precondition",`Instrument ${to} does not exist`);
  const changed:string[]=[];
  const walk=(node:any,path:(string|number)[])=>{if(Array.isArray(node)){node.forEach((v,i)=>walk(v,[...path,i]));return;}if(!node||typeof node!=="object")return;
    for(const [k,v] of Object.entries(node)) { const p=[...path,k]; if((k==="instrument"||k==="inst")&&v===from){setAt(doc,p,to);changed.push(ptr(p.map(String)));} else walk(v,p); }
  }; walk(root,[]);
  if(!changed.length) throw new SidwaveTransformError("precondition",`Instrument reference ${from} does not exist`);
  return finish(doc,changed,["instrument definitions", "all references other than the selected source"],[],validate,read);
}
/** Preconditions: the input is a valid score; grid is a positive finite number of beats; supported duration-bearing groove/arpeggio entries use explicit len. Preserves total length of every pattern; reports unsupported tokenized grooves rather than changing their grammar. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function quantise(text:string,{grid,validate,read,inputChecked}:TransformOptions&{grid:number}):TransformResult {
  if(!Number.isFinite(grid)||grid<=0) throw new SidwaveTransformError("precondition","grid must be positive and finite");
  const doc=docFor(text,validate,read,inputChecked), root=js(doc), changed:string[]=[], warnings:string[]=[];
  for(const [vi,voice] of (root.voices??[]).entries()) for(const [pn,pat] of Object.entries<any>(voice.patterns??{})) {
    const where=`/voices/${vi}/patterns/${esc(pn)}`;
    if(typeof pat.groove==="string") { warnings.push(`${where}/groove uses implicit entry lengths; unchanged`); continue; }
    const key=pat.groove?"groove":"notes", entries:any[] = pat.groove ?? pat.notes ?? [];
    const groups=entryGroups(entries), next=new Map<number,number>();
    const explicit=entries.map((e,i)=>e&&typeof e==="object"&&typeof e.len==="number"?i:-1).filter(i=>i>=0);
    let unsupported=false;
    for(const g of new Set(explicit.map(i=>groups[i]!))) {
      const inGroup=explicit.filter(i=>groups[i]===g);
      const grid_=inGroup.map(i=>Math.max(grid,tidy(Math.round(entries[i].len/grid)*grid)));
      const total=tidy(grid_.reduce((sum,v,k)=>sum+v-entries[inGroup[k]!].len,0));
      if(Math.abs(total)>1e-9) {
        // Keep the bar group's length: the last explicit duration in the group absorbs the difference.
        if(inGroup.length<2) { unsupported=true; break; }
        const last=inGroup.length-1, corrected=tidy(grid_[last]!-total);
        if(corrected<=0) throw new SidwaveTransformError("unsupported",`Grid cannot preserve pattern length at ${where}`);
        grid_[last]=corrected;
      }
      inGroup.forEach((i,k)=>next.set(i,grid_[k]!));
    }
    if(unsupported) { warnings.push(`${where} has no second explicit duration for length-preserving quantisation; unchanged`); continue; }
    for(const [i,len] of next) if(len!==entries[i].len) { const path=["voices",vi,"patterns",pn,key,i,"len"] as (string|number)[]; setAt(doc,path,len); changed.push(ptr(path.map(String))); }
  }
  return finish(doc,changed,["total length of every pattern"],warnings,validate,read);
}
/** Preconditions: the input is a valid score; every requested name exists as a named section or sequence item. Preserves section definitions and their contents; order may duplicate sections. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function restructure(text:string,{order,validate,read,inputChecked}:TransformOptions&{order:string[]}):TransformResult {
  if(!Array.isArray(order)||order.some(x=>typeof x!=="string")) throw new SidwaveTransformError("precondition","order must be an array of names");
  const doc=docFor(text,validate,read,inputChecked), root=js(doc), entries:any[]=root.timeline??[];
  const entryName=(x:any):string|undefined=>typeof x==="string"?x.split(/[+*]/)[0]:x?.section??x?.use;
  const names=new Set([...Object.keys(root.sections??{}),...entries.map(entryName).filter(Boolean)]);
  const missing=order.find(n=>!names.has(n));if(missing)throw new SidwaveTransformError("precondition",`Unknown section or sequence item ${missing}`);
  if(root.sections&&!doc.get("timeline",true))throw new SidwaveTransformError("precondition","Document has no timeline");
  // Keep the existing timeline entry (with its modifiers, layer overrides or inline definition) where there is one.
  // An entry that defines a section inline (section: name) is used once; later repeats refer to it by name.
  const used=new Set<string>();
  const values=order.map(name=>{
    const entry=entries.find(e=>entryName(e)===name);
    if(entry===undefined||(used.has(name)&&entry&&typeof entry==="object"&&entry.section!==undefined))return name;
    used.add(name);return entry;
  });
  // The same order again changes nothing: return the text as it was given.
  if(root.timeline!==undefined&&JSON.stringify(values)===JSON.stringify(entries)) return {text,report:{changed:[],preserved:["section definitions and contents"],warnings:[]}};
  doc.set("timeline",values as any);
  return finish(doc,["/timeline"],["section definitions and contents"],[],validate,read);
}
/** Preconditions: the input is a valid score; seed is an integer; maxShift is finite and nonnegative. Uses seeded bounded variation of per-note len values (beats), a language-supported duration field. Preserves note pitches, instrument references, and each pattern's total length. Notes without explicit len are unsupported and named in warnings. The result must parse and compile (see TransformValidation); otherwise code "precondition" with the compiler message. */
export function humanise(text:string,{seed,maxShift,scope,validate,read,inputChecked}:TransformOptions&{seed:number;maxShift:number;scope?:{voices?:string[]}}):TransformResult {
  if(!Number.isInteger(seed)) throw new SidwaveTransformError("precondition","seed must be an integer");
  if(!Number.isFinite(maxShift)||maxShift<0) throw new SidwaveTransformError("precondition","maxShift must be finite and nonnegative");
  const doc=docFor(text,validate,read,inputChecked), root=js(doc), changed:string[]=[], warnings:string[]=[]; let state=seed>>>0;
  const rand=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  if(maxShift===0) return finish(doc,changed,["pitches","pattern lengths"],["maxShift is zero; no variation applied."],validate,read);
  for(const [vi,voice] of (root.voices??[]).entries()) {
    const id=String(voice.id??vi+1), name=String(voice.name??"");if(scope?.voices&&!scope.voices.includes(id)&&!scope.voices.includes(name))continue;
    for(const [pn,pat] of Object.entries<any>(voice.patterns??{})) {
      if(typeof pat.groove==="string") { warnings.push(`/voices/${vi}/patterns/${esc(pn)}/groove uses implicit note lengths; unchanged`); continue; }
      const key=Array.isArray(pat.groove)?"groove":"notes", entries=pat[key]??[];const explicit=entries.map((e:any,i:number)=>e&&typeof e==="object"&&typeof e.len==="number"?i:-1).filter((i:number)=>i>=0);
      if(!explicit.length) { warnings.push(`/voices/${vi}/patterns/${esc(pn)} has no explicit per-note len; unchanged`); continue; }
      const groups=entryGroups(entries), deltas=new Map<number,number>(), open=new Map<number,number>();
      // Pair consecutive explicit durations inside one "|" group so that every bar keeps its length.
      for(const ix of explicit){const g=groups[ix]!;if(open.has(g)){const d=(rand()*2-1)*maxShift;deltas.set(open.get(g)!,d);deltas.set(ix,-d);open.delete(g);}else open.set(g,ix);}
      for(const ix of explicit){if(!deltas.has(ix))continue;const old=entries[ix].len, next=tidy(old+deltas.get(ix)!);if(next<=0)throw new SidwaveTransformError("unsupported",`Bounded variation would make duration nonpositive at /voices/${vi}/patterns/${esc(pn)}/${key}/${ix}/len`);if(next!==old){setAt(doc,["voices",vi,"patterns",pn,key,ix,"len"],next);changed.push(ptr(["voices",String(vi),"patterns",pn,key,String(ix),"len"]));}}
    }
  }
  return finish(doc,changed,["note pitches","instrument references","pattern lengths"],warnings,validate,read);
}
