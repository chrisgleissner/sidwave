#!/usr/bin/env node
/**
 * Evaluation of composer 2 against the version 1 generator.
 *
 *   nice -n 10 node scripts/evaluate-composer.mjs [--seeds <n>] [--out <dir>] [--label <text>]
 *
 * For every composer 2 profile and every held-out seed it generates a score with composer 2 and one with the version 1
 * generator (style chosen from the profile's palette, the profile's tonic as root), and measures: whether the score parses,
 * compiles to a PRG and a PSID, the lint findings by code, the cycles of the worst player call against the profile's budget,
 * structure (sections, bars, repetition of the lead's bars, recurrence of motifs), variation (pitch-class and interval
 * entropy, rhythmic diversity, distinctness between seeds) and counterpoint rule violations on strong beats.
 * It then runs the four completion operations on every composer 2 profile and compares the protected material.
 *
 * Held-out seeds: seed i is the first four bytes (big endian) of SHA-256("sidwave-composer-eval:<label>:<i>") with the
 * default label "heldout-v1". The rule is fixed in advance; no seed was chosen or discarded for its result, and the seeds
 * used while developing the composer (small numbers and a few arbitrary values) are not drawn from it.
 *
 * These are proxy measures: they count properties of the notes and of the compiled score. None of them measures musical
 * quality, and the report makes no claim about it.
 *
 * Needs a built package (npm run build). Writes composer-eval.json and composer-eval.md to sidwave/data/compose/.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dist = (file) => import(pathToFileURL(path.join(repo, "sidwave", "dist", file)).href);
const { generateSidwave } = await dist("audio/generateSidwave.js");
const { parseSidwave, midiToNoteName } = await dist("sidwave.js");
const { compileSidwaveToPrg, compileSidwaveToSid } = await dist("sidwaveCompiler.js");
const { isInfoCode } = await dist("sidwaveLint.js");
const compose = await dist("compose/index.js");
const { PROFILES, composeSidwave, measureScore, distinctness, traceDocument, worstCycles, completeScore } = compose;

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const SEEDS = Number(flag("--seeds", "8"));
const LABEL = flag("--label", "heldout-v1");
const OUT = path.resolve(flag("--out", path.join(repo, "sidwave", "data", "compose")));
const FRAME_CYCLES = { PAL: 19656, NTSC: 17095 };
const STYLE_OF_PALETTE = { chip: "chiptune", saw: "chiptune", soft: "ambient", funk: "funk" };
const seeds = Array.from({ length: SEEDS }, (_, i) => createHash("sha256").update(`sidwave-composer-eval:${LABEL}:${i}`).digest().readUInt32BE(0));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "sidwave", "package.json"), "utf8"));

function evaluate(version, profile, seed) {
  const item = { version, profile: profile.name, seed, ok: false };
  try {
    let score;
    if (version === 2) score = composeSidwave({ profile: profile.name, seed, measure: true }).score;
    else score = generateSidwave({ root: `${midiToNoteName(48 + profile.tonic).slice(0, -1)}3`, preset: "classic", style: STYLE_OF_PALETTE[profile.palette], seed, system: "PAL" }).score;
    const doc = parseSidwave(score);
    const compiled = compileSidwaveToPrg(doc);
    compileSidwaveToSid(doc, compiled.prg);
    item.ok = true;
    item.lint = {};
    for (const f of compiled.lint ?? []) if (!isInfoCode(f.code)) item.lint[f.code] = f.count;
    item.lintClean = Object.keys(item.lint).length === 0;
    const budget = Math.floor((FRAME_CYCLES[doc.song.mode] / doc.speed) * 0.8);
    const trace = traceDocument(doc, { calls: Math.min(3000, compiled.totalFrames) });
    item.cycles = { worst: worstCycles(trace), budget, within: worstCycles(trace) <= budget };
    item.prgBytes = compiled.prg.length;
    const m = measureScore(doc);
    item.measures = { ...m, leadSignature: undefined };
    item.signature = m.leadSignature;
  } catch (error) {
    item.error = String(error.message).slice(0, 200);
  }
  return item;
}

const items = [];
for (const profile of PROFILES) for (const seed of seeds) for (const version of [1, 2]) items.push(evaluate(version, profile, seed));

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const round = (x, d = 3) => (x === null ? null : Number(x.toFixed(d)));
const byVersion = {};
for (const version of [1, 2]) {
  const set = items.filter((i) => i.version === version);
  const good = set.filter((i) => i.ok);
  const lintTotals = {};
  for (const i of good) for (const [code, n] of Object.entries(i.lint)) lintTotals[code] = (lintTotals[code] ?? 0) + n;
  const lintItems = {};
  for (const i of good) for (const code of Object.keys(i.lint)) lintItems[code] = (lintItems[code] ?? 0) + 1;
  const sonorities = good.reduce((n, i) => n + i.measures.counterpoint.sonorities, 0);
  const violations = good.reduce((n, i) => n + i.measures.counterpoint.violations, 0);
  const kinds = {};
  for (const i of good) for (const [k, n] of Object.entries(i.measures.counterpoint.byKind)) kinds[k] = (kinds[k] ?? 0) + n;
  const perProfile = PROFILES.map((p) => distinctness(good.filter((i) => i.profile === p.name).map((i) => i.signature)));
  const mm = (key) => round(mean(good.map((i) => i.measures[key])));
  byVersion[version] = {
    scores: set.length, compiled: good.length, lintClean: good.filter((i) => i.lintClean).length, lintItemsByCode: lintItems, lintFindingsByCode: lintTotals,
    withinBudget: good.filter((i) => i.cycles.within).length, meanWorstCycles: round(mean(good.map((i) => i.cycles.worst)), 0),
    meanBars: mm("bars"), meanSections: mm("sections"), meanVoices: mm("voices"), meanLeadNotes: mm("leadNotes"),
    meanRepetitionRatio: mm("repetitionRatio"), meanMotifRecurrence: mm("motifRecurrence"),
    meanPitchClassEntropy: mm("pitchClassEntropy"), meanIntervalEntropy: mm("intervalEntropy"),
    meanDistinctDurations: mm("distinctDurations"), meanRhythmEntropy: mm("rhythmEntropy"),
    meanInterSeedDistinctness: round(mean(perProfile)),
    counterpoint: { sonorities, violations, per100: round(sonorities === 0 ? 0 : (100 * violations) / sonorities, 2), byKind: kinds },
  };
}

// Completion operations on every composer 2 profile (first seed), with the protected-material comparison.
const completion = [];
for (const profile of PROFILES) {
  const full = composeSidwave({ profile: profile.name, seed: seeds[0] });
  const lead = structuredClone(full.score);
  const leadId = full.voices.lead;
  lead.voices = lead.voices.filter((v) => v.id === leadId);
  for (const e of lead.timeline) e.layers = { [`v${leadId}`]: e.layers[`v${leadId}`] };
  const free = Array.from({ length: 3 * (lead.sids?.length ?? 1) }, (_, i) => i + 1).filter((id) => id !== leadId);
  const runs = [
    ["continue", full.score, { bars: 8 }],
    ["fill-section", full.score, { section: "Coda", bars: 4 }],
    ["harmonise", lead, { voice: leadId, target: free[0], style: "arp" }],
    ["accompany", lead, { bass: free[0], drums: free[1] }],
  ];
  for (const [op, input, options] of runs) {
    const row = { profile: profile.name, op };
    try {
      const r = completeScore(input, op, { ...options, seed: seeds[1] });
      row.ok = true;
      row.identical = r.protected.identical;
      row.cellsCompared = r.protected.cellsCompared;
      row.callsCompared = r.protected.callsCompared;
    } catch (error) {
      row.ok = false;
      row.error = String(error.message).slice(0, 160);
    }
    completion.push(row);
  }
}
const completionSummary = {};
for (const op of ["continue", "fill-section", "harmonise", "accompany"]) {
  const rows = completion.filter((r) => r.op === op);
  completionSummary[op] = { runs: rows.length, ok: rows.filter((r) => r.ok).length, identical: rows.filter((r) => r.identical).length, callsCompared: rows.reduce((n, r) => n + (r.callsCompared ?? 0), 0) };
}

const report = {
  note: "Proxy measures of generated scores. They are not measures of musical quality and make no claim about it.",
  package: pkg.version, profiles: PROFILES.length, seedRule: `first 4 bytes (big endian) of SHA-256("sidwave-composer-eval:${LABEL}:<i>"), i = 0..${SEEDS - 1}`, seeds,
  v1Mapping: "style from the profile palette (chip and saw: chiptune, soft: ambient, funk: funk); root is the profile tonic; preset classic; PAL; the same seeds",
  budget: "80 percent of a video frame divided by the score's speed, in cycles of the worst player call of up to 3000 calls on the bundled 6502 interpreter",
  summary: byVersion, completionSummary, completion, items: items.map(({ signature, ...rest }) => rest),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "composer-eval.json"), `${JSON.stringify(report, null, 1)}\n`);

const s1 = byVersion[1];
const s2 = byVersion[2];
const pct = (a, b) => `${a} / ${b}`;
const row = (label, f) => `| ${label} | ${f(s1)} | ${f(s2)} |`;
const lintCodes = [...new Set([...Object.keys(s1.lintItemsByCode), ...Object.keys(s2.lintItemsByCode)])].sort();
const md = `# Composer 2 evaluation

These are proxy measures. They count properties of the generated notes and of the compiled scores. None of them measures
musical quality, and nothing here claims that composer 2 sounds better or worse than the version 1 generator.

- Package version: ${pkg.version}
- Profiles: ${PROFILES.length}; held-out seeds per profile: ${SEEDS}; scores per version: ${s2.scores}
- Seed rule: ${report.seedRule}. The seeds are ${seeds.join(", ")}.
- Version 1 mapping: ${report.v1Mapping}.
- Budget: ${report.budget}.
- Regenerate with \`nice -n 10 node scripts/evaluate-composer.mjs\`; the JSON file next to this one has every score's numbers.

## Technical correctness and lint

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
${row("Parse, compile to PRG and PSID", (s) => pct(s.compiled, s.scores))}
${row("Lint clean (no finding except informational notes)", (s) => pct(s.lintClean, s.compiled))}
${row("Worst player call within the budget", (s) => pct(s.withinBudget, s.compiled))}
${row("Mean worst player call (cycles)", (s) => s.meanWorstCycles)}
${lintCodes.map((code) => row(`Scores with lint ${code}`, (s) => s.lintItemsByCode[code] ?? 0)).join("\n")}

## Structure

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
${row("Mean bars", (s) => s.meanBars)}
${row("Mean timeline sections", (s) => s.meanSections)}
${row("Mean pitched voices", (s) => s.meanVoices)}
${row("Mean lead notes", (s) => s.meanLeadNotes)}
${row("Repetition: share of lead bars equal to an earlier lead bar", (s) => s.meanRepetitionRatio)}
${row("Motif recurrence: share of lead 3-interval windows (or their inversions) that occur more than once", (s) => s.meanMotifRecurrence)}

## Variation

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
${row("Pitch-class entropy of the lead (bits, at most 3.58)", (s) => s.meanPitchClassEntropy)}
${row("Interval entropy of the lead (bits)", (s) => s.meanIntervalEntropy)}
${row("Distinct lead note durations", (s) => s.meanDistinctDurations)}
${row("Entropy of lead note durations (bits)", (s) => s.meanRhythmEntropy)}
${row("Inter-seed distinctness (mean over profiles of 1 - Jaccard similarity of lead 4-note windows)", (s) => s.meanInterSeedDistinctness)}

## Counterpoint rule violations

Lead against the lowest voice, and against the counter line where there is one, on strong beats (beats 1 and 3 in 4/4, beat 1 in 3/4).
The rules are consonance, no parallel fifths or octaves between consecutive strong beats, and no voice crossing.

| Measure | Version 1 | Composer 2 |
| --- | --- | --- |
${row("Strong-beat sonorities compared", (s) => s.counterpoint.sonorities)}
${row("Violations", (s) => s.counterpoint.violations)}
${row("Violations per 100 sonorities", (s) => s.counterpoint.per100)}
${row("By kind", (s) => JSON.stringify(s.counterpoint.byKind))}

## Completion operations and protected material

Each operation ran on every composer 2 profile (first held-out seed, second seed for the generated material). The original
and the completed score were run on the bundled 6502 interpreter and the SID register writes of every protected voice were
compared call by call.

| Operation | Runs | Completed | Protected material identical | Player calls compared |
| --- | --- | --- | --- | --- |
${Object.entries(completionSummary).map(([op, c]) => `| ${op} | ${c.runs} | ${c.ok} | ${c.identical} | ${c.callsCompared} |`).join("\n")}
`;
fs.writeFileSync(path.join(OUT, "composer-eval.md"), md);
console.log(md);

// The documented profile list, from the data records.
const profileDoc = `# Composer 2 profiles

Each profile is a data record in \`sidwave/src/compose/profiles.ts\` (style, tempo, form, mode, density and instrumentation).
A seed chooses harmony, motif, melody and variation within a profile. Select one with
\`generateSidwave({ composer: 2, profile: "<name>", seed, root, style, system })\`. Without \`composer: 2\` the version 1
generator runs and its output is unchanged. This file is generated by \`scripts/evaluate-composer.mjs\`.

| Profile | Tempo | Speed | Metre | Mode | Form | Ending | Layout | Palette | Groove | Bass | Drums | Arp | Syncopation | Density | Phrase bars | Chords per bar | Contrast key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${PROFILES.map((p) => `| ${p.name} | ${p.tempo} | ${p.speed} | ${p.meter}/4 | ${p.mode} | ${p.form} | ${p.ending} | ${p.layout} | ${p.palette} | ${p.groove} | ${p.bass} | ${p.drums} | ${p.arp} | ${p.syncopation} | ${p.density} | ${p.phraseBars} | ${p.harmonicRhythm} | ${p.contrast} |`).join("\n")}

${PROFILES.map((p) => `- **${p.name}**: ${p.description}.`).join("\n")}
`;
fs.writeFileSync(path.join(OUT, "profiles.md"), profileDoc);
