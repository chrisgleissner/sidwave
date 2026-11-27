import test from "#test/runner";
import assert from "#test/assert";
import { generateSidwave } from "../src/audio/generateSidwave.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { isInfoCode } from "../src/sidwaveLint.js";
import { composeSidwave } from "../src/compose/compose.js";
import { FORMS, LAYOUTS, PROFILES, getProfile } from "../src/compose/profiles.js";
import { GROOVES, BASS_PATTERNS, DRUM_PATTERNS, DRUM_FILLS, ARP_PATTERNS } from "../src/compose/rhythm.js";
import { checkCounterpoint, makeMotif, transformMotif } from "../src/compose/melody.js";
import { measureScore, distinctness } from "../src/compose/measures.js";
import { traceDocument } from "../src/compose/trace.js";
import { Cpu6502 } from "../src/sidwaveEmulator.js";
import { MODE_GRAMMAR, MODE_NAMES, progression, randomSource, triad } from "../src/compose/theory.js";

test("there are at least 30 documented profiles with distinct names", () => {
  assert.ok(PROFILES.length >= 30);
  assert.equal(new Set(PROFILES.map((p) => p.name)).size, PROFILES.length);
  for (const p of PROFILES) {
    assert.ok(p.description.length > 20, p.name);
    assert.ok(FORMS[p.form], p.name);
    assert.ok(LAYOUTS[p.layout], p.name);
    assert.ok(MODE_NAMES.includes(p.mode), p.name);
    assert.ok(GROOVES[p.groove] && BASS_PATTERNS[p.bass] && DRUM_PATTERNS[p.drums] && ARP_PATTERNS[p.arp], p.name);
    for (const layout of [LAYOUTS[p.layout]]) {
      const ids = Object.values(layout.voices);
      assert.equal(new Set(ids).size, ids.length);
      // At most three voices per SID.
      for (let sid = 0; sid < layout.sids; sid++) assert.ok(ids.filter((id) => Math.floor((id - 1) / 3) === sid).length <= 3);
    }
  }
  assert.ok(new Set(PROFILES.map((p) => p.form)).size >= 6);
  assert.ok(new Set(PROFILES.map((p) => p.mode)).size >= 5);
});

test("rhythm tables fill their bars exactly and drum and bass patterns are one bar long", () => {
  for (const [name, g] of Object.entries(GROOVES)) {
    for (const bar of g.bar16) assert.equal(bar.reduce((a, b) => a + b, 0), 16, name);
    for (const bar of g.bar12) assert.equal(bar.reduce((a, b) => a + b, 0), 12, name);
  }
  for (const list of [...Object.values(BASS_PATTERNS), ...Object.values(DRUM_PATTERNS), ...Object.values(ARP_PATTERNS), DRUM_FILLS]) {
    for (const pattern of list) assert.equal(pattern.length, 16, pattern);
  }
});

test("the chord grammar yields only major and minor triads in every mode and ends phrases with the requested cadence", () => {
  const random = randomSource(3);
  for (const mode of MODE_NAMES) {
    const key = { tonic: 2, mode };
    for (const fn of ["T", "P", "D"]) for (const degree of MODE_GRAMMAR[mode][fn]) assert.equal(triad(key, degree, fn).pcs.length, 3);
    for (const cadence of ["authentic", "half", "plagal", "deceptive"]) {
      const chords = progression(random, key, 4, cadence);
      assert.equal(chords.length, 4);
      assert.equal(chords[0].fn, "T");
      if (cadence === "authentic") assert.deepEqual(chords.slice(-2).map((c) => c.fn), ["D", "T"]);
      if (cadence === "half") assert.equal(chords[3].fn, "D");
      if (cadence === "plagal") assert.deepEqual(chords.slice(-2).map((c) => c.fn), ["P", "T"]);
    }
  }
});

test("motif transformations: inversion mirrors the steps, augmentation doubles the durations, fragmentation keeps the head", () => {
  const motif = { steps: [0, 1, -2, 1], durs: [2, 2, 2, 2] };
  assert.deepEqual(transformMotif(motif, "invert", 16).steps, [0, -1, 2, -1]);
  assert.deepEqual(transformMotif(motif, "augment", 16).durs, [4, 4, 4, 4]);
  assert.deepEqual(transformMotif(motif, "augment", 7), motif);
  const fragment = transformMotif(motif, "fragment", 16);
  assert.equal(fragment.steps.length, 2);
  assert.equal(fragment.durs.reduce((a, b) => a + b, 0), 8);
  const made = makeMotif(randomSource(9), 0.4);
  assert.equal(made.steps.length, made.durs.length);
});

test("the counterpoint checker reports parallel fifths and octaves, dissonance and crossing on strong beats", () => {
  const note = (start, midi) => ({ start, end: start + 2, midi });
  const clean = checkCounterpoint([note(0, 72), note(2, 74), note(4, 71)], [note(0, 60), note(2, 59), note(4, 55)], 2, 6);
  assert.equal(clean.violations.length, 0);
  assert.equal(clean.sonorities, 3);
  const fifths = checkCounterpoint([note(0, 67), note(2, 69)], [note(0, 60), note(2, 62)], 2, 4);
  assert.deepEqual(fifths.violations.map((v) => v.kind), ["parallel-fifth"]);
  const octaves = checkCounterpoint([note(0, 72), note(2, 74)], [note(0, 60), note(2, 62)], 2, 4);
  assert.deepEqual(octaves.violations.map((v) => v.kind), ["parallel-octave"]);
  const dissonant = checkCounterpoint([note(0, 62)], [note(0, 60)], 2, 2);
  assert.deepEqual(dissonant.violations.map((v) => v.kind), ["dissonance"]);
  const crossed = checkCounterpoint([note(0, 55)], [note(0, 60)], 2, 2);
  assert.ok(crossed.violations.some((v) => v.kind === "voice-crossing"));
  // Same fifth held by a repeated pitch is not parallel motion.
  assert.equal(checkCounterpoint([note(0, 67), note(2, 67)], [note(0, 60), note(2, 60)], 2, 4).violations.length, 0);
  // A rest on a strong beat breaks the comparison.
  assert.equal(checkCounterpoint([note(0, 67), note(4, 69)], [note(0, 60), note(4, 62)], 2, 6).violations.length, 0);
});

test("composer 2 is deterministic per seed and profile, and different seeds give different scores", () => {
  const a = JSON.stringify(composeSidwave({ profile: "chip-aaba-minor", seed: 5 }).score);
  assert.equal(JSON.stringify(composeSidwave({ profile: "chip-aaba-minor", seed: 5 }).score), a);
  assert.notEqual(JSON.stringify(composeSidwave({ profile: "chip-aaba-minor", seed: 6 }).score), a);
  assert.notEqual(JSON.stringify(composeSidwave({ profile: "chip-aaba-major", seed: 5 }).score), a);
});

test("composer 2 is opt-in through generateSidwave and leaves the default generator alone", () => {
  const base = { root: "C3", preset: "classic", style: "chiptune", seed: 9, system: "PAL" };
  const v1 = generateSidwave(base);
  assert.equal(v1.bars, 8);
  assert.equal(v1.score.timeline.length, 1);
  const v2 = generateSidwave({ ...base, composer: 2 });
  assert.ok(v2.score.timeline.length > 1);
  assert.equal(v2.score.sidwave, "1.2");
  assert.ok(v2.profile && v2.sections.length > 1);
  assert.equal(JSON.stringify(generateSidwave({ ...base, composer: 2 })), JSON.stringify(v2));
  const named = generateSidwave({ ...base, composer: 2, profile: "waltz-aaba-minor" });
  assert.equal(named.score.meter, 3);
  assert.throws(() => generateSidwave({ ...base, composer: 2, profile: "no-such-profile" }), /unknown composer profile/);
});

test("every profile composes a valid, lint-clean, in-budget score that compiles to a PRG and a PSID", { timeout: 300_000 }, () => {
  for (const profile of PROFILES) {
    for (const seed of [11, 4242]) {
      const result = composeSidwave({ profile: profile.name, seed });
      const doc = parseSidwave(result.score);
      const compiled = compileSidwaveToPrg(doc);
      assert.ok(compileSidwaveToSid(doc, compiled.prg).sid.length > 100);
      const actionable = (compiled.lint ?? []).filter((f) => !isInfoCode(f.code));
      assert.deepEqual(actionable.map((f) => `${f.code} ${f.first}`), [], `${profile.name} seed ${seed}`);
      assert.ok(result.cycles.met, `${profile.name} seed ${seed}: ${result.cycles.worst} > ${result.cycles.budget}`);
      assert.ok(result.cycles.worst <= result.cycles.budget);
      // Voices per SID: at most three, and every voice has a distinct id.
      const ids = result.score.voices.map((v) => v.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(Math.max(...ids) <= 3 * (result.score.sids?.length ?? 1));
      // Form and loop point.
      assert.equal(result.sections.reduce((n, s) => n + s.bars, 0), result.bars);
      if (profile.ending === "end") assert.ok(result.score.end);
      else if (result.sections[0].role === "intro") assert.equal(result.score.loop_to, result.sections[1].name);
    }
  }
});

test("a profile's score varies the repeats and the contrast section modulates when the profile asks for it", () => {
  const r = composeSidwave({ profile: "chip-aaba-minor", seed: 31 });
  const keys = r.sections.map((s) => s.key);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[2], keys[0]);
  assert.equal(keys[3], keys[0]);
  const lead = r.score.voices.find((v) => v.name === "Lead").patterns;
  assert.ok(Object.keys(lead).length >= 3, "the varied repeats use their own lead patterns");
  const m = measureScore(parseSidwave(r.score));
  assert.ok(m.motifRecurrence > 0.3, `motif recurrence ${m.motifRecurrence}`);
  assert.equal(m.sections, 4);
});

test("a cycle budget that the plan exceeds is met by dropping voices or features, and the repairs are reported", () => {
  const free = composeSidwave({ profile: "wide-vc-major", seed: 3, measure: true });
  assert.equal(free.repairs.length, 0);
  const tight = composeSidwave({ profile: "wide-vc-major", seed: 3, cycleBudget: Math.floor(free.cycles.worst * 0.8) });
  assert.ok(tight.repairs.length > 0);
  assert.ok(tight.cycles.met);
  assert.ok(tight.cycles.worst <= tight.cycles.budget);
  assert.ok(tight.score.voices.length < free.score.voices.length || tight.speed < free.speed || tight.repairs.includes("lead vibrato removed"));
  // A budget nothing can meet is reported as not met rather than hidden.
  const impossible = composeSidwave({ profile: "chip-aaba-minor", seed: 3, cycleBudget: 10 });
  assert.equal(impossible.cycles.met, false);
  assert.deepEqual(impossible.repairs, ["lead vibrato removed", "arp voice dropped"]);
});

test("inter-seed distinctness is 0 for identical leads and near 1 for unrelated ones", () => {
  const sig = (n) => Array.from({ length: 12 }, (_, i) => `${i}:${n + i}`);
  assert.equal(distinctness([sig(60), sig(60)]), 0);
  assert.equal(distinctness([sig(60), sig(80)]), 1);
  const leads = [1, 2, 3, 4].map((seed) => measureScore(parseSidwave(composeSidwave({ profile: "funk-vc-dorian", seed }).score)).leadSignature);
  assert.ok(distinctness(leads) > 0.5);
});

test("getProfile reports the known names for an unknown profile", () => {
  assert.throws(() => getProfile("x"), /known profiles: chip-aaba-minor/);
});

test("every composed section ends on its cadence: tonic after dominant, or the dominant for a half cadence", () => {
  let sections = 0;
  for (const profile of PROFILES) {
    for (const seed of [3, 17]) {
      const r = composeSidwave({ profile: profile.name, seed });
      for (const s of r.sections) {
        sections++;
        if (s.cadence === "authentic") {
          assert.equal(s.endFunction, "T", `${profile.name} ${s.name}`);
          assert.ok(s.finalChord.includes(s.tonic), `${profile.name} ${s.name}: the final chord holds the tonic`);
        } else {
          assert.equal(s.cadence, "half");
          assert.equal(s.endFunction, "D", `${profile.name} ${s.name}`);
        }
        // A contrasting section returns through the dominant of the home key; the others end in their own key.
        if (s.finalNote !== undefined) assert.ok(s.finalChord.includes(((s.finalNote % 12) + 12) % 12), `${profile.name} ${s.name}: the last melody note is a tone of the last chord`);
      }
      // A score that ends closes on the tonic; a looping score may end its last section on the dominant that leads back to the start.
      const last = r.sections.at(-1);
      if (profile.ending === "end") assert.equal(last.cadence, "authentic", profile.name);
    }
  }
  assert.ok(sections > 200);
});

test("the cycle figure says whether it was estimated or measured, and measuring runs the whole score", () => {
  const estimated = composeSidwave({ profile: "chip-aaba-minor", seed: 5 });
  assert.equal(estimated.cycles.kind, "estimated");
  const measured = composeSidwave({ profile: "chip-aaba-minor", seed: 5, measure: true });
  assert.equal(measured.cycles.kind, "measured");
  const doc = parseSidwave(measured.score);
  assert.equal(measured.cycles.frames, compileSidwaveToPrg(doc).totalFrames);
  assert.ok(measured.cycles.worst <= estimated.cycles.worst, "the measured worst call does not exceed the compiler's bound");
});

test("the register-write interpreter gives the same writes and cycles as the bundled interpreter", () => {
  for (const profile of ["chip-aaba-minor", "wide-vc-major", "waltz-aaba-minor", "funk-vc-dorian"]) {
    const doc = parseSidwave(composeSidwave({ profile, seed: 9 }).score);
    const compiled = compileSidwaveToPrg(doc);
    const mem = new Uint8Array(65536);
    mem.set(compiled.prg.subarray(2), compiled.loadAddress);
    mem[0xea31] = 0x60;
    mem[0x02a6] = 1;
    let raster = 100;
    let writes = [];
    const cpu = new Cpu6502(mem, {
      write(a, v) { if (a >= 0xd400 && a < 0xd800) writes.push(((a - 0xd400) << 8) | v); },
      read(a) { if (a === 0xd012) return (raster = (raster + 1) % 312) & 0xff; return undefined; },
    });
    cpu.call(compiled.initAddress);
    const trace = traceDocument(doc, { compiled });
    for (let i = 0; i < trace.callCount; i++) {
      writes = [];
      const cycles = cpu.call(compiled.playAddress);
      assert.equal(trace.cycles[i], cycles, `${profile} call ${i}`);
      assert.deepEqual(Array.from(trace.writes.subarray(trace.starts[i], trace.starts[i + 1])), writes, `${profile} call ${i}`);
    }
  }
});

test("variation measures over a fixed window do not depend on the length of the score", () => {
  const short = measureScore(parseSidwave(composeSidwave({ profile: "chip-loop-minor", seed: 4 }).score), { windowBars: 8 });
  const long = measureScore(parseSidwave(composeSidwave({ profile: "chip-aaba-minor", seed: 4 }).score), { windowBars: 8 });
  assert.ok(short.leadNotes > 0 && long.leadNotes > 0);
  assert.ok(long.leadSignature.every((entry) => Number(entry.split(":")[0]) < 8 * 16 + 16), "the signature stays in the window");
  const full = measureScore(parseSidwave(composeSidwave({ profile: "chip-aaba-minor", seed: 4 }).score));
  assert.ok(full.leadNotes > long.leadNotes);
});
