// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
import YAML from "yaml";
import { parseSidwave, SIDWAVE_NOTE_RANGE, SIDWAVE_TEMPO_RANGE, noteNameToMidi, midiToNoteName } from "../sidwave.js";
import { maxSidwaveMidi } from "../sidwaveCompiler.js";
import { formatSidwave } from "../format/sidwaveFormat.js";

export class SidwaveTransformError extends Error {
  constructor(public readonly code: "precondition" | "out_of_range" | "unsupported", message: string) { super(message); this.name = "SidwaveTransformError"; }
}
export interface TransformReport { changed: string[]; preserved: string[]; warnings: string[] }
export interface TransformResult { text: string; report: TransformReport }
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const ptr = (p: string[]) => "/" + p.map(esc).join("/");
type AnyDoc = YAML.Document<any>;
function docFor(text: string): AnyDoc {
  const doc = YAML.parseDocument(text, { version: "1.2", keepSourceTokens: true });
  if (doc.errors.length) throw new SidwaveTransformError("precondition", doc.errors[0]!.message);
  return doc;
}
function finish(doc: AnyDoc, changed: string[], preserved: string[], warnings: string[] = []): TransformResult {
  return { text: formatSidwave(doc.toString()), report: { changed, preserved, warnings } };
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
function shiftedNote(raw: string, amount: number, max: number, path: string): string {
  const midi = noteNameToMidi(raw)! + amount;
  if (midi < SIDWAVE_NOTE_RANGE.min || midi > SIDWAVE_NOTE_RANGE.max || midi > max) throw new SidwaveTransformError("out_of_range", `Offending note at ${path}`);
  return midiToNoteName(midi);
}
function replacements(raw: string, amount: number, max: number, path: string): string {
  const tokens = noteTokens(raw); let result = raw;
  for (const t of tokens.reverse()) result = result.slice(0,t.start) + shiftedNote(t.value, amount, max, path) + result.slice(t.end);
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

/** Preconditions: semitones is an integer; every shifted pitched note stays in SIDWAVE_NOTE_RANGE and the selected clock's SID frequency range. Preserves rhythm, percussion encodings, instruments, and voices outside scope. Scope is restricted to patterns used only in selected named sections; ambiguous shared/inline/sequence scoping is unsupported. */
export function transpose(text: string, options: { semitones: number; scope?: { voices?: string[]; sections?: string[] } }): TransformResult {
  if (!Number.isInteger(options?.semitones)) throw new SidwaveTransformError("precondition", "semitones must be an integer");
  const doc = docFor(text), root = js(doc), changed: string[] = [], max = maxSidwaveMidi(root.mode === "NTSC" ? "NTSC" : "PAL");
  const selectedSections = new Set(options.scope?.sections ?? []);
  for (const name of selectedSections) if (!(root.sections?.[name]) && !(root.timeline ?? []).some((e: any) => e?.section === name)) throw new SidwaveTransformError("precondition", `Unknown section ${name}`);
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
        if (exempt || !noteTokens(val).length) return;
        const next = replacements(val, options.semitones, max, ptr(path.map(String)));
        if (next !== val) { setAt(doc,path,next); changed.push(ptr(path.map(String))); }
      };
      if (typeof pattern.groove === "string") mutateString([...base,"groove"], pattern.groove);
      else if (Array.isArray(pattern.groove)) pattern.groove.forEach((entry:any, ei:number) => {
        const path=[...base,"groove",ei] as (string|number)[];
        if (typeof entry === "string") mutateString(path,entry);
        else if (entry && typeof entry.note === "string") { mutateString([...path,"note"],entry.note,entry.kitNote === true); if(typeof entry.slide_from==="string") mutateString([...path,"slide_from"],entry.slide_from,entry.kitNote===true); if(entry.bend && typeof entry.bend.to==="string") mutateString([...path,"bend","to"],entry.bend.to,entry.kitNote===true); }
        else if (entry && entry.chord) mutateString([...path,"chord"],entry.chord);
        else if (entry && typeof entry === "object") throw new SidwaveTransformError("unsupported", `Cannot transpose groove construct at ${ptr(path.map(String))}`);
      });
      if (Array.isArray(pattern.notes)) pattern.notes.forEach((note:string, ni:number) => mutateString([...base,"notes",ni],note));
      if (typeof pattern.motif === "string") {
        // Motif chord symbols and integer offsets need musical transposition, not text note substitution.
        const tokens=pattern.motif.split(/([\s,]+)/); let did=false;
        const next=tokens.map((tok:string)=>{
          if (/^[+-]?\d+$/.test(tok)) { did=true; const n=Number(tok)+options.semitones; const rootMidi=noteNameToMidi(pattern.root??"C3")??48; if(rootMidi+n<SIDWAVE_NOTE_RANGE.min||rootMidi+n>max) throw new SidwaveTransformError("out_of_range",`Offending note at ${ptr([...base,"motif"].map(String))}`); return String(n); }
          if (/^[A-Ga-g](?:#|b)?\d+$/.test(tok)) { did=true; return shiftedNote(tok,options.semitones,max,ptr([...base,"motif"].map(String))); }
          const chord=/^([A-Ga-g](?:#|b)?)(.*)$/.exec(tok);
          if (chord && /^(?:m|min|maj|dim|aug|sus2|sus4|sus|6|m6|min6|7|maj7|m7|min7|dim7|m7b5|9|maj9|m9|min9|add9)?$/.test(chord[2]!)) { did=true; const pitch=noteNameToMidi(`${chord[1]}3`)!+options.semitones; if(pitch<12||pitch>max) throw new SidwaveTransformError("out_of_range",`Offending note at ${ptr([...base,"motif"].map(String))}`); return midiToNoteName(pitch).replace(/-1$/,"")+chord[2]; }
          return tok;
        }).join("");
        if(did&&next!==pattern.motif){setAt(doc,[...base,"motif"],next);changed.push(ptr([...base,"motif"].map(String)));}
      }
      void pnames;
    }
  }
  return finish(doc, changed, ["rhythm", "percussion", "instruments", "voices outside scope"]);
}

/** Preconditions: bpm is finite and within SIDWAVE_TEMPO_RANGE. Preserves all note and pitch fields. */
export function setTempo(text:string,{bpm}:{bpm:number}):TransformResult {
  if(!Number.isFinite(bpm)||bpm<SIDWAVE_TEMPO_RANGE.min||bpm>SIDWAVE_TEMPO_RANGE.max) throw new SidwaveTransformError("out_of_range",`bpm must be ${SIDWAVE_TEMPO_RANGE.min}..${SIDWAVE_TEMPO_RANGE.max}`);
  const doc=docFor(text), root=js(doc), changed=[setTempoNode(doc,root,bpm)]; return finish(doc,changed,["notes","pitches"]);
}
/** Preconditions: factor is finite and positive and the resulting tempo is within SIDWAVE_TEMPO_RANGE. Preserves all note and pitch fields. */
export function scaleTempo(text:string,{factor}:{factor:number}):TransformResult {
  if(!Number.isFinite(factor)||factor<=0) throw new SidwaveTransformError("precondition","factor must be positive and finite");
  const root=YAML.parse(text) as any, current=numericTempo(root), bpm=current*factor;
  if(!Number.isFinite(bpm)||bpm<SIDWAVE_TEMPO_RANGE.min||bpm>SIDWAVE_TEMPO_RANGE.max) throw new SidwaveTransformError("out_of_range",`scaled tempo ${bpm} is outside ${SIDWAVE_TEMPO_RANGE.min}..${SIDWAVE_TEMPO_RANGE.max}`);
  return setTempo(text,{bpm});
}
/** Preconditions: target is a named instrument defined in instruments or an accepted lib: recipe; the source reference exists. Preserves all other instrument definitions and references. */
export function substituteInstrument(text:string,{from,to}:{from:string;to:string}):TransformResult {
  const doc=docFor(text), root=js(doc);
  const exists=!!root.instruments?.[to] || (to.startsWith("lib:") && /^(kick|snare|hat|bass_pluck|filter_bass|lead_pwm|chip_arp_major|chip_arp_minor|bell_ring|sync_lead|pad_slow)$/.test(to.slice(4)));
  if(!exists) throw new SidwaveTransformError("precondition",`Instrument ${to} does not exist`);
  const changed:string[]=[];
  const walk=(node:any,path:(string|number)[])=>{if(Array.isArray(node)){node.forEach((v,i)=>walk(v,[...path,i]));return;}if(!node||typeof node!=="object")return;
    for(const [k,v] of Object.entries(node)) { const p=[...path,k]; if((k==="instrument"||k==="inst")&&v===from){setAt(doc,p,to);changed.push(ptr(p.map(String)));} else walk(v,p); }
  }; walk(root,[]);
  if(!changed.length) throw new SidwaveTransformError("precondition",`Instrument reference ${from} does not exist`);
  return finish(doc,changed,["instrument definitions", "all references other than the selected source"]);
}
/** Preconditions: grid is a positive finite number of beats; supported duration-bearing groove/arpeggio entries use explicit len. Preserves total length of every pattern; reports unsupported tokenized grooves rather than changing their grammar. */
export function quantise(text:string,{grid}:{grid:number}):TransformResult {
  if(!Number.isFinite(grid)||grid<=0) throw new SidwaveTransformError("precondition","grid must be positive and finite");
  const doc=docFor(text), root=js(doc), changed:string[]=[], warnings:string[]=[];
  for(const [vi,voice] of (root.voices??[]).entries()) for(const [pn,pat] of Object.entries<any>(voice.patterns??{})) {
    const entries:any[] = pat.groove ?? pat.notes ?? [];
    if(typeof pat.groove==="string") { warnings.push(`/voices/${vi}/patterns/${esc(pn)}/groove uses implicit entry lengths; unchanged`); continue; }
    const explicitCount=entries.filter(e=>e&&typeof e==="object"&&typeof e.len==="number").length;
    if(explicitCount===1 && entries.some(e=>e&&typeof e==="object"&&typeof e.len==="number"&&Math.max(grid,Math.round(e.len/grid)*grid)!==e.len)) { warnings.push(`/voices/${vi}/patterns/${esc(pn)} has no second explicit duration for length-preserving quantisation; unchanged`); continue; }
    for(const [ei,entry] of entries.entries()) if(entry&&typeof entry==="object"&&typeof entry.len==="number") {
      const before=entry.len, after=Math.max(grid,Math.round(before/grid)*grid);
      // Preserve sum by compensating the final explicit duration in this pattern.
      if(after!==before){
        const path=["voices",vi,"patterns",pn,pat.groove?"groove":"notes",ei,"len"] as (string|number)[];
        setAt(doc,path,after); changed.push(ptr(path.map(String)));
      }
    }
    const deltas=entries.map(e=>e&&typeof e==="object"&&typeof e.len==="number"?Math.max(grid,Math.round(e.len/grid)*grid)-e.len:0);
    const total=deltas.reduce((a,b)=>a+b,0);
    if(Math.abs(total)>1e-9 && entries.filter(e=>e&&typeof e==="object"&&typeof e.len==="number").length < 2){warnings.push(`/voices/${vi}/patterns/${esc(pn)} has no second explicit duration for length-preserving quantisation; unchanged`);continue;}
    if(Math.abs(total)>1e-9){let ix=-1;for(let j=entries.length-1;j>=0;j--)if(entries[j]&&typeof entries[j]==="object"&&typeof entries[j].len==="number"){ix=j;break;}if(ix<0)throw new SidwaveTransformError("unsupported",`Cannot preserve pattern length at /voices/${vi}/patterns/${esc(pn)}`);const corrected=entries[ix]!.len+deltas[ix]!-total;if(corrected<=0)throw new SidwaveTransformError("unsupported",`Grid cannot preserve pattern length at /voices/${vi}/patterns/${esc(pn)}`);setAt(doc,["voices",vi,"patterns",pn,pat.groove?"groove":"notes",ix,"len"],corrected);}
  }
  return finish(doc,changed,["total length of every pattern"],warnings);
}
/** Preconditions: every requested name exists as a named section or sequence item. Preserves section definitions and their contents; order may duplicate sections. */
export function restructure(text:string,{order}:{order:string[]}):TransformResult {
  if(!Array.isArray(order)||order.some(x=>typeof x!=="string")) throw new SidwaveTransformError("precondition","order must be an array of names");
  const doc=docFor(text), root=js(doc); const names=new Set([...Object.keys(root.sections??{}),...(root.timeline??[]).map((x:any)=>typeof x==="string"?x.split(/[+*]/)[0]:x?.section??x?.use).filter(Boolean)]);
  const missing=order.find(n=>!names.has(n));if(missing)throw new SidwaveTransformError("precondition",`Unknown section or sequence item ${missing}`);
  if(root.sections){const current=doc.get("timeline",true) as any;if(!current)throw new SidwaveTransformError("precondition","Document has no timeline");const values=order.map(name=>root.sections[name]?name:root.timeline.find((e:any)=>e?.section===name||e?.use===name)??name);doc.set("timeline",values as any);}
  else doc.set("timeline",order as any);
  return finish(doc,["/timeline"],["section definitions and contents"]);
}
/** Preconditions: seed is an integer; maxShift is finite and nonnegative. Uses seeded bounded variation of per-note len values (beats), a language-supported duration field. Preserves note pitches, instrument references, and each pattern's total length. Notes without explicit len are unsupported and named in warnings. */
export function humanise(text:string,{seed,maxShift,scope}:{seed:number;maxShift:number;scope?:{voices?:string[]}}):TransformResult {
  if(!Number.isInteger(seed)) throw new SidwaveTransformError("precondition","seed must be an integer");
  if(!Number.isFinite(maxShift)||maxShift<0) throw new SidwaveTransformError("precondition","maxShift must be finite and nonnegative");
  const doc=docFor(text), root=js(doc), changed:string[]=[], warnings:string[]=[]; let state=seed>>>0;
  const rand=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  if(maxShift===0) return finish(doc,changed,["pitches","pattern lengths"],["maxShift is zero; no variation applied."]);
  for(const [vi,voice] of (root.voices??[]).entries()) {
    const id=String(voice.id??vi+1), name=String(voice.name??"");if(scope?.voices&&!scope.voices.includes(id)&&!scope.voices.includes(name))continue;
    for(const [pn,pat] of Object.entries<any>(voice.patterns??{})) {
      if(typeof pat.groove==="string") { warnings.push(`/voices/${vi}/patterns/${esc(pn)}/groove uses implicit note lengths; unchanged`); continue; }
      const key=Array.isArray(pat.groove)?"groove":"notes", entries=pat[key]??[];const explicit=entries.map((e:any,i:number)=>e&&typeof e==="object"&&typeof e.len==="number"?i:-1).filter((i:number)=>i>=0);
      if(!explicit.length) { warnings.push(`/voices/${vi}/patterns/${esc(pn)} has no explicit per-note len; unchanged`); continue; }
      const deltas=new Map<number,number>();
      for(let j=0;j+1<explicit.length;j+=2){const d=(rand()*2-1)*maxShift;deltas.set(explicit[j]!,d);deltas.set(explicit[j+1]!,-d);}
      for(const ix of explicit){if(!deltas.has(ix))continue;const old=entries[ix].len, next=old+deltas.get(ix)!;if(next<=0)throw new SidwaveTransformError("unsupported",`Bounded variation would make duration nonpositive at /voices/${vi}/patterns/${esc(pn)}/${key}/${ix}/len`);if(next!==old){setAt(doc,["voices",vi,"patterns",pn,key,ix,"len"],next);changed.push(ptr(["voices",String(vi),"patterns",pn,key,String(ix),"len"]));}}
    }
  }
  return finish(doc,changed,["note pitches","instrument references","pattern lengths"],warnings);
}
