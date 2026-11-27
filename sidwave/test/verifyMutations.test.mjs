import test from "#test/runner";
import assert from "#test/assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.ts";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.ts";
import { MUTATION_CATALOG, diffPaths, mutateScore, readRawScore, seededIndex } from "../src/verify/mutations.ts";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/sound/examples");
const read = (name) => readFileSync(path.join(examples, `${name}.yaml`), "utf8");
const kind = (cls, severity) => MUTATION_CATALOG.find((k) => k.class === cls && k.severity === severity);
const parsed = (doc) => parseSidwave(JSON.parse(JSON.stringify(doc)));
const covered = (p, targets) => targets.some((t) => p === t || p.startsWith(`${t}.`) || p.startsWith(`${t}[`));

function apply(name, cls, severity, context = {}) {
  const outcome = mutateScore(read(name), kind(cls, severity), { tuneId: name, ...context });
  return outcome;
}

test("the catalogue lists every class of the design with its label", () => {
  const byClass = {};
  for (const k of MUTATION_CATALOG) (byClass[k.class] ??= []).push(k);
  const summary = Object.fromEntries(Object.entries(byClass).map(([c, ks]) => [c, ks.map((k) => `${k.severity}:${k.label}`).join(" ")]));
  assert.deepEqual(summary, {
    wrong_note: "1:M 2:M", octave_error: "12:M", missing_note: "1:M", extra_note: "1:M",
    detune_voice: "3:B 8:X 25:M 50:M", timing_shift: "1:X 3:M 6:M", tempo_drift: "0.5:X 2:M", gate_length: "frame:X half:M",
    envelope: "release:X attack_decay:M", waveform: "1:M", pulse_width: "64:X 512:M", filter: "5:X 40:M off:M", sync_ring: "off:M",
    missing_percussion: "1:M", sound_in_silence: "50ms:M", sections_swapped: "1:M", loop_point: "1:M", long_tune_defect: "1:M",
    identical: "recompile:B", refactor_rename_instrument: "1:B", refactor_duplicate_pattern: "1:B",
  });
  assert.equal(MUTATION_CATALOG.length, 33);
});

test("seededIndex is the first four bytes of the SHA-256 of the key, modulo n", () => {
  assert.equal(seededIndex("fuer_elise|wrong_note|1", 1000), seededIndex("fuer_elise|wrong_note|1", 1000));
  assert.equal(seededIndex("a", 4294967296), 0xca978112);
  assert.equal(seededIndex("a", 7), 0xca978112 % 7);
  assert.notEqual(seededIndex("a|1", 1 << 30), seededIndex("a|2", 1 << 30));
});

test("readRawScore returns an independent copy and accepts YAML text or an object", () => {
  const raw = readRawScore("a: &x { n: 1 }\nb: *x\n");
  raw.a.n = 2;
  assert.equal(raw.b.n, 1);
  const object = { v: [1] };
  const copy = readRawScore(object);
  copy.v.push(2);
  assert.deepEqual(object.v, [1]);
});

test("diffPaths names the differing leaves of arrays, objects and maps", () => {
  assert.deepEqual(diffPaths({ a: [1, { b: 2 }], c: 3 }, { a: [1, { b: 5 }, 9], c: 3 }), ["$.a[1].b", "$.a[2]"]);
  assert.deepEqual(diffPaths(new Map([["x", 1]]), new Map([["x", 2], ["y", 1]])), ["$.x", "$.y"]);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffPaths(NaN, NaN), []);
  assert.deepEqual(diffPaths([1], { 0: 1 }), ["$"]);
  assert.deepEqual(diffPaths(null, {}), ["$"]);
});

test("wrong note, octave error, missing and extra note change exactly one groove entry of Fuer Elise", () => {
  const before = parsed(readRawScore(read("fuer_elise")));
  const cases = [
    ["wrong_note", "1"], ["wrong_note", "2"], ["octave_error", "12"], ["missing_note", "1"], ["extra_note", "1"],
  ];
  const seen = {};
  for (const [cls, severity] of cases) {
    const outcome = apply("fuer_elise", cls, severity);
    assert.equal(outcome.applied, true, `${cls} ${outcome.reason}`);
    const after = parsed(outcome.document);
    const paths = diffPaths(before, after);
    assert.equal(paths.length, 1, `${cls}: ${paths}`);
    assert.deepEqual(outcome.mutation.targets, paths);
    assert.match(paths[0], /^\$\.voices\[\d\]\.patterns\.(theme|accomp|bass)\.groove\[\d+\]$/);
    const [, voice, pattern, index] = /voices\[(\d)\]\.patterns\.(\w+)\.groove\[(\d+)\]/.exec(paths[0]);
    seen[cls + severity] = [before.voices[voice].patterns[pattern].groove[index], after.voices[voice].patterns[pattern].groove[index]];
  }
  const midi = (n) => ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[n[0]] + (n[1] === "#" ? 1 : 0) + 12 * (Number(n.at(-1)) + 1));
  assert.equal(Math.abs(midi(seen.wrong_note1[1]) - midi(seen.wrong_note1[0])), 1);
  assert.equal(Math.abs(midi(seen.wrong_note2[1]) - midi(seen.wrong_note2[0])), 2);
  assert.equal(Math.abs(midi(seen.octave_error12[1]) - midi(seen.octave_error12[0])), 12);
  assert.equal(seen.missing_note1[1], "-");
  assert.notEqual(seen.missing_note1[0], "-");
  assert.equal(seen.extra_note1[0], "-");
  assert.notEqual(seen.extra_note1[1], "-");
});

test("exact result for Fuer Elise: the seeded wrong note", () => {
  const outcome = apply("fuer_elise", "wrong_note", "1");
  assert.deepEqual(outcome.mutation, {
    class: "wrong_note", severity: "1", label: "M",
    description: outcome.mutation.description, targets: outcome.mutation.targets, firstUseSeconds: 0,
  });
  assert.match(outcome.mutation.description, /^wrong note: [A-G]#?\d to [A-G]#?\d at \w+\[\d+\]$/);
  const again = apply("fuer_elise", "wrong_note", "1");
  assert.deepEqual(again.document, outcome.document);
  const other = mutateScore(read("fuer_elise"), kind("wrong_note", "1"), { tuneId: "another tune" });
  assert.notDeepEqual(other.mutation.targets, outcome.mutation.targets);
});

test("timing shift keeps the total length of the pair and moves the onset by the requested frames", () => {
  for (const frames of ["1", "3", "6"]) {
    const outcome = apply("fuer_elise", "timing_shift", frames);
    assert.equal(outcome.applied, true);
    const [before, target] = outcome.mutation.targets;
    assert.match(before, /groove\[\d+\]$/);
    const [, voice, pattern, index] = /voices\[(\d)\]\.patterns\.(\w+)\.groove\[(\d+)\]/.exec(target);
    const groove = parsed(outcome.document).voices[voice].patterns[pattern].groove;
    const length = parsed(readRawScore(read("fuer_elise"))).voices[voice].patterns[pattern].length ?? 1;
    const delay = (Number(frames) / 50.125) * (76 / 60);
    assert.ok(Math.abs(groove[index - 1].len - (length + delay)) < 1e-5, `${groove[index - 1].len}`);
    assert.ok(Math.abs(groove[index - 1].len + groove[index].len - 2 * length) < 1e-12);
  }
});

test("tempo drift scales the song tempo, detune adds cents, and legacy scores skip what they cannot express", () => {
  const drift = apply("fuer_elise", "tempo_drift", "2");
  assert.deepEqual(drift.mutation.targets, ["$.song.tempo"]);
  assert.ok([77.52, 74.48].includes(drift.document.song.tempo), String(drift.document.song.tempo));
  const small = apply("fuer_elise", "tempo_drift", "0.5");
  assert.ok([76.38, 75.62].includes(small.document.song.tempo));
  const modern = apply("title_fanfare", "detune_voice", "25");
  assert.equal(modern.applied, true);
  const [path_] = modern.mutation.targets;
  const index = Number(/voices\[(\d+)\]/.exec(path_)[1]);
  assert.ok([25, -25].includes(modern.document.voices[index].detune), String(modern.document.voices[index].detune));
  assert.equal(apply("fuer_elise", "detune_voice", "25").reason, "voice detune needs SIDWave 1.2 or later");
  assert.equal(apply("fuer_elise", "gate_length", "half").reason, "gate_off needs SIDWave 1.2 or later");
  assert.equal(apply("fuer_elise", "sound_in_silence", "50ms").reason, "the score declares no instruments");
  assert.equal(apply("fuer_elise", "long_tune_defect", "1").reason, "the tune is shorter than 90 s");
  assert.equal(apply("fuer_elise", "loop_point", "1").reason, "the score has no numeric loop_to");
  assert.equal(apply("fuer_elise", "missing_percussion", "1").reason, "no drum voice");
  assert.equal(apply("fuer_elise", "sections_swapped", "1").reason, "the score has no timeline list");
  assert.equal(apply("fuer_elise", "envelope", "release").reason, "no instrument with an ADSR");
  assert.equal(apply("fuer_elise", "filter", "off").reason, "no instrument with a filter table");
  assert.equal(apply("fuer_elise", "sync_ring", "off").reason, "no instrument with ring or sync");
  assert.equal(apply("fuer_elise", "waveform", "1").reason, "no instrument with a pitched waveform");
  assert.equal(apply("fuer_elise", "pulse_width", "64").reason, "no pulse instrument with a pulse width");
  assert.equal(apply("fuer_elise", "refactor_rename_instrument", "1").reason, "no instrument to rename");
});

test("a score that does not parse is reported, and a mutation that never compiles is reported after its attempts", () => {
  const broken = mutateScore("voices: 3\n", kind("wrong_note", "1"), { tuneId: "x" });
  assert.equal(broken.applied, false);
  assert.match(broken.reason, /^the score does not parse: Invalid SIDWAVE/);
  const identical = mutateScore("voices: 3\n", kind("identical", "recompile"), { tuneId: "x" });
  assert.equal(identical.applied, true);
  assert.deepEqual(identical.mutation.targets, []);
});

test("the horizon keeps targets whose pattern first plays after it out of the choice", () => {
  const early = apply("title_fanfare", "wrong_note", "1", { horizonSeconds: 8 });
  assert.equal(early.applied, true);
  assert.ok(early.mutation.firstUseSeconds <= 6, String(early.mutation.firstUseSeconds));
  assert.equal(apply("title_fanfare", "wrong_note", "1", { horizonSeconds: 1 }).applied, false);
});

// One small modern score exercises every class that needs instruments, sections and a timeline.
const MODERN = ["chamber_waltz", "title_fanfare", "acid_line"];

for (const name of MODERN) {
  test(`every class either skips with a reason or changes only its targets, and the result compiles (${name})`, () => {
    const before = parsed(readRawScore(read(name)));
    const applied = [];
    for (const k of MUTATION_CATALOG) {
      const outcome = mutateScore(read(name), k, { tuneId: name, horizonSeconds: 180 });
      if (!outcome.applied) {
        assert.ok(outcome.reason.length > 0);
        continue;
      }
      applied.push(`${k.class}/${k.severity}`);
      const after = parsed(outcome.document);
      compileSidwaveToPrg(after);
      const paths = diffPaths(before, after);
      if (k.class === "identical") { assert.deepEqual(paths, []); continue; }
      assert.ok(paths.length > 0, `${k.class}/${k.severity} changed nothing`);
      const outside = paths.filter((p) => !covered(p, outcome.mutation.targets));
      assert.deepEqual(outside, [], `${k.class}/${k.severity} changed ${outside.slice(0, 3)} outside ${outcome.mutation.targets}`);
      assert.equal(outcome.mutation.label, k.label);
    }
    for (const required of ["wrong_note/1", "wrong_note/2", "octave_error/12", "missing_note/1", "extra_note/1", "detune_voice/25", "tempo_drift/2", "gate_length/half",
      "envelope/attack_decay", "waveform/1", "sections_swapped/1", "refactor_duplicate_pattern/1", "refactor_rename_instrument/1", "identical/recompile"]) {
      assert.ok(applied.includes(required), `${name} should apply ${required}; applied ${applied}`);
    }
  });
}

test("instrument, percussion, section and refactor mutations change what they say", () => {
  const name = "acid_line";
  const before = parsed(readRawScore(read(name)));
  const env = apply(name, "envelope", "attack_decay");
  const inst = env.mutation.targets[0].replace("$.instruments.", "");
  assert.notDeepEqual(parsed(env.document).instruments[inst].adsr, before.instruments[inst].adsr);
  const diffs = parsed(env.document).instruments[inst].adsr.map((v, i) => Math.abs(v - before.instruments[inst].adsr[i]));
  assert.deepEqual(diffs.filter(Boolean), [4]);
  const release = apply(name, "envelope", "release");
  const rInst = release.mutation.targets[0].replace("$.instruments.", "");
  assert.equal(Math.abs(parsed(release.document).instruments[rInst].adsr[3] - before.instruments[rInst].adsr[3]), 1);
  const wave = apply(name, "waveform", "1");
  const wInst = wave.mutation.targets[0].replace("$.instruments.", "");
  assert.notEqual(parsed(wave.document).instruments[wInst].waveform, before.instruments[wInst].waveform);
  const off = apply(name, "filter", "off");
  const fInst = off.mutation.targets[0].replace("$.instruments.", "");
  assert.equal(parsed(off.document).instruments[fInst].filtertable, undefined);
  assert.notEqual(before.instruments[fInst].filtertable, undefined);
  const cutoff = apply(name, "filter", "40");
  const cInst = cutoff.mutation.targets[0].replace("$.instruments.", "");
  assert.notDeepEqual(parsed(cutoff.document).instruments[cInst].filtertable, before.instruments[cInst].filtertable);
  const drums = apply(name, "missing_percussion", "1");
  const muted = drums.mutation.targets.map((t) => /layers\.(v\d+)$/.exec(t)[1]);
  assert.equal(new Set(muted).size, 1);
  assert.ok(drums.mutation.targets.every((t) => parsed(drums.document).timeline[Number(/timeline\[(\d+)\]/.exec(t)[1])].layers[muted[0]] === "-"));
  const swap = apply(name, "sections_swapped", "1");
  const i = Number(/timeline\[(\d+)\]/.exec(swap.mutation.targets[0])[1]);
  const swapped = parsed(swap.document).timeline;
  assert.deepEqual(swapped[i].layers, before.timeline[i + 1].layers);
  assert.deepEqual(swapped[i + 1].layers, before.timeline[i].layers);
  const burst = apply(name, "sound_in_silence", "50ms");
  assert.deepEqual(parsed(burst.document).instruments.sw_burst.adsr, [0, 0, 15, 0]);
  assert.equal(parsed(burst.document).instruments.sw_burst.waveform, "noise");
  const entry = parsed(burst.document).voices;
  assert.ok(JSON.stringify(entry).includes('"inst":"sw_burst"'));
  const rename = apply(name, "refactor_rename_instrument", "1");
  const renamed = Object.keys(parsed(rename.document).instruments).filter((n) => n.endsWith("_r"));
  assert.equal(renamed.length, 1);
  assert.deepEqual(parsed(rename.document).instruments[renamed[0]], before.instruments[renamed[0].slice(0, -2)]);
  const dup = apply(name, "refactor_duplicate_pattern", "1");
  const pattern = Object.keys(parsed(dup.document).voices.flatMap((v) => Object.keys(v.patterns ?? {}))).length;
  assert.ok(pattern > 0);
  assert.ok(dup.mutation.targets[0].endsWith(".patterns"));
});

test("pulse width, sync and ring, and the loop point", () => {
  const pw = apply("acid_line", "pulse_width", "512");
  assert.equal(pw.applied, true);
  const name = pw.mutation.targets[0].replace("$.instruments.", "");
  const raw = pw.document.instruments[name];
  const rawBefore = readRawScore(read("acid_line")).instruments[name];
  const widths = (inst) => [inst.pulse_width, inst.pulsetable?.[0]?.set, inst.pulsetable?.steps?.[0]?.set].filter((v) => v !== undefined);
  const to = (v) => (v <= 1 ? Math.round(v * 4095) : v);
  assert.equal(Math.abs(to(widths(raw)[0]) - to(widths(rawBefore)[0])), 512);
  const sync = mutateScore(read("metal_sync"), kind("sync_ring", "off"), { tuneId: "metal_sync" });
  assert.equal(sync.applied, true);
  const syncName = sync.mutation.targets[0].replace("$.instruments.", "");
  const frames = sync.document.instruments[syncName].wavetable;
  assert.ok(frames.every((f) => f.ring !== true && f.sync !== true));
  const raw2 = readRawScore(read("title_fanfare"));
  delete raw2.end;
  raw2.loop_to = 3;
  const loop = mutateScore(raw2, kind("loop_point", "1"), { tuneId: "t" });
  assert.equal(loop.applied, true);
  assert.equal(loop.document.loop_to, 4);
  assert.deepEqual(loop.mutation.targets, ["$.loopTo"]);
  const gate = apply("acid_line", "gate_length", "frame");
  const half = apply("acid_line", "gate_length", "half");
  const gateOf = (o) => Number(JSON.stringify(parsed(o.document)).match(/"gate_off":(\d+)/g).map((s) => Number(s.slice(11))).sort((a, b) => b - a)[0]);
  assert.ok(gateOf(half) > gateOf(gate) || gateOf(gate) === 1);
  assert.equal(gate.applied && half.applied, true);
});

test("a mutation that never compiles is reported with its last failure", () => {
  const outcome = apply("chiptune_drive", "detune_voice", "3");
  assert.equal(outcome.applied, false);
  assert.match(outcome.reason, /^the mutated score does not compile: Invalid SIDWAVE at \$\.cpu: the player needs up to \d+ cycles/);
});

test("whole-instrument and refactor mutations change exactly these leaves of the parsed score", () => {
  const leaves = (name, cls, severity) => {
    const outcome = apply(name, cls, severity, { horizonSeconds: 180 });
    assert.equal(outcome.applied, true, `${cls} ${outcome.reason}`);
    return diffPaths(parsed(readRawScore(read(name))), parsed(outcome.document));
  };
  assert.deepEqual(leaves("acid_line", "waveform", "1"), ["$.instruments.l2a.waveform"]);
  assert.deepEqual(leaves("acid_line", "filter", "off"), ["$.instruments.bpa.filtertable"]);
  assert.deepEqual(leaves("acid_line", "filter", "40"), ["$.instruments.bpa.filtertable.steps[0].hz"]);
  assert.deepEqual(leaves("acid_line", "envelope", "attack_decay"), ["$.instruments.ohat.adsr[1]"]);
  assert.deepEqual(leaves("acid_line", "pulse_width", "512"), ["$.instruments.line2.pulsetable.steps[0].value"]);
  assert.deepEqual(leaves("acid_line", "refactor_duplicate_pattern", "1"), ["$.voices[0].patterns.bp1_dup", "$.timeline[0].layers.v1"]);
  assert.deepEqual(leaves("acid_line", "sound_in_silence", "50ms"), ["$.voices[2].patterns.s2.groove[23]", "$.instruments.sw_burst"]);
  // Sync and ring: only the flag of the frames that had one changes; the other frames of the table are untouched.
  assert.deepEqual(leaves("metal_sync", "sync_ring", "off"), ["$.instruments.scr.wavetable[0].sync", "$.instruments.scr.wavetable[1].sync"]);
  const rename = leaves("acid_line", "refactor_rename_instrument", "1");
  assert.ok(rename.length > 5);
  assert.ok(rename.every((p) => p.startsWith("$.voices[") || p.startsWith("$.instruments")), rename.join());
  assert.ok(rename.filter((p) => p.endsWith(".inst")).length > 5);
});
