import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.ts";
import { exportEvents } from "../src/interchange/events.ts";
import { detectFormat } from "../src/interchange/registry.ts";
import { lossesFromText } from "../src/interchange/loss.ts";
import { importAbc, AbcImportError } from "../src/interchange/abcImport.ts";

const parse = (text, options = {}) => importAbc(new TextEncoder().encode(text), { validate: false, grid: 1 / 48, ...options });
const midi = (letter, octave = 4, accidental = 0) => ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[letter] + (octave + 1) * 12 + accidental;
function notes(text, options = {}) {
  const result = parse(text, options);
  const score = exportEvents(parseSidwave(result.yaml));
  const voices = score.voices;
  return voices.flatMap((voice) => voice.notes.map((note) => ({
    voice: voice.name,
    pitch: note.pitch,
    start: Math.round(note.on.tick / score.ppq * 48) / 48,
    length: Math.round((note.off.tick - note.on.tick) / score.ppq * 48) / 48,
  }))).sort((a, b) => a.start - b.start || a.voice.localeCompare(b.voice) || a.pitch - b.pitch);
}
const n = (voice, pitch, start, length) => ({ voice, pitch, start, length });

test("ABC headers select meter, default length and tempo with exact note events", () => {
  const source = "X:1\nT:Scale\nC:Composer\nM:3/4\nL:1/4\nQ:1/8=240\nK:C\nC D E|";
  const exported = exportEvents(parseSidwave(parse(source).yaml));
  assert.equal(exported.tempoMap[0].bpm, 120);
  assert.deepEqual(notes(source), [
    n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1), n("1", midi("E"), 2, 1),
  ]);
});

test("ABC omitted L: uses the standard short-meter default note length", () => {
  assert.deepEqual(notes("X:1\nM:2/4\nK:C\nC D E|"), [
    n("1", midi("C"), 0, 0.25), n("1", midi("D"), 0.25, 0.25), n("1", midi("E"), 0.5, 0.25),
  ]);
});

test("ABC tune selection follows the requested X number", () => {
  assert.deepEqual(notes("X:1\nK:C\nC|\nX:2\nL:1/4\nK:D\nD E|", { song: 2 }), [
    n("1", midi("D"), 0, 1), n("1", midi("E"), 1, 1),
  ]);
});

test("ABC detection requires an X: tune line and a K: key line", () => {
  const valid = new TextEncoder().encode("X:1\nT:Recognised\nK:C\nC|");
  const incomplete = new TextEncoder().encode("X:1\nT:No key\nC|");
  const reversed = new TextEncoder().encode("K:C\nX:1\nC|");
  assert.equal(detectFormat(valid, "tune.abc").best.id, "abc");
  assert.equal(detectFormat(incomplete, "tune.abc").best, undefined);
  assert.equal(detectFormat(reversed, "tune.abc").best, undefined);
});

test("ABC notes support accidentals and octave marks", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\n^C _D =E c' B,|"), [
    n("1", midi("C", 4, 1), 0, 1), n("1", midi("D", 4, -1), 1, 1),
    n("1", midi("E"), 2, 1), n("1", midi("C", 6), 3, 1), n("1", midi("B", 3), 4, 1),
  ]);
});

test("ABC accidental state resets at bar lines", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\n^F F|F|"), [
    n("1", midi("F", 4, 1), 0, 1), n("1", midi("F", 4, 1), 1, 1), n("1", midi("F"), 4, 1),
  ]);
});

test("ABC multiple declared and inline voices retain independent event timing", () => {
  assert.deepEqual(notes("X:1\nV:1 lead\nV:b harmony\nL:1/4\nK:C\nC D [V:b] G A [V:1] E|"), [
    n("1", midi("C"), 0, 1), n("b", midi("G"), 0, 1), n("1", midi("D"), 1, 1),
    n("b", midi("A"), 1, 1), n("1", midi("E"), 2, 1),
  ]);
});

test("ABC length forms /, //, and 3/2 have exact durations", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\nC/ D// E3/2 F|"), [
    n("1", midi("C"), 0, 0.5), n("1", midi("D"), 0.5, 0.25),
    n("1", midi("E"), 0.75, 1.5), n("1", midi("F"), 2.25, 1),
  ]);
});

test("ABC rests advance onset without creating pitched notes", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\nC z D Z E x F|"), [
    n("1", midi("C"), 0, 1), n("1", midi("D"), 2, 1), n("1", midi("E"), 7, 1), n("1", midi("F"), 9, 1),
  ]);
});

test("ABC broken rhythm changes the paired note durations and preserves total time", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\nC>D E<F|"), [
    n("1", midi("C"), 0, 1.5), n("1", midi("D"), 1.5, 0.5),
    n("1", midi("E"), 2, 0.5), n("1", midi("F"), 2.5, 1.5),
  ]);
});

test("ABC tuplets support shorthand and general p:q:r ratios", () => {
  assert.deepEqual(notes("X:1\nL:1/4\nK:C\n(3ABC (5:4:5DEFGA|"), [
    n("1", midi("A"), 0, 2 / 3), n("1", midi("B"), 2 / 3, 2 / 3), n("1", midi("C"), 4 / 3, 2 / 3),
    n("1", midi("D"), 2, 0.8), n("1", midi("E"), 2.8, 0.8), n("1", midi("F"), 3.6, 0.8),
    n("1", midi("G"), 4.4, 0.8), n("1", midi("A"), 5.2, 0.8),
  ]);
});

test("ABC ties join equal adjacent pitches into one sustained event", () => {
  assert.deepEqual(notes("X:1\nM:2/4\nL:1/4\nK:C\n^C-|C D|"), [
    n("1", midi("C", 4, 1), 0, 2), n("1", midi("D"), 2, 1),
  ]);
});

test("ABC repeats and first/second endings expand in playback order", () => {
  assert.deepEqual(notes("X:1\nM:2/4\nL:1/4\nK:C\n|: C D |[1 E F :|[2 G A|"), [
    n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1), n("1", midi("E"), 2, 1), n("1", midi("F"), 3, 1),
    n("1", midi("C"), 4, 1), n("1", midi("D"), 5, 1), n("1", midi("G"), 6, 1), n("1", midi("A"), 7, 1),
  ]);
});

test("ABC chords reduce to simultaneous notes and count an approximation loss", () => {
  const result = parse("X:1\nL:1/4\nK:C\n[CEG]2 A|");
  assert.deepEqual(notesFrom(result.yaml), [
    n("1", midi("C"), 0, 2), n("1-chord2", midi("E"), 0, 2),
    n("1-chord3", midi("G"), 0, 2), n("1", midi("A"), 2, 1),
  ]);
  assert.deepEqual(result.losses.map((line) => line.startsWith("1 ABC chord")), [true]);
  assert.deepEqual(lossesFromText("read", result.losses).map(({ code, severity, count }) => ({ code, severity, count })), [
    { code: "abc.chords", severity: "approx", count: 1 },
  ]);
});
function notesFrom(yaml) {
  const score = exportEvents(parseSidwave(yaml));
  return score.voices.flatMap((voice) => voice.notes.map((note) => ({ voice: voice.name, pitch: note.pitch,
    start: Math.round(note.on.tick / score.ppq * 48) / 48, length: Math.round((note.off.tick - note.on.tick) / score.ppq * 48) / 48 })))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

test("ABC grace groups are skipped with a count and preserve following note timing", () => {
  const result = parse("X:1\nL:1/4\nK:C\n{c} C D|");
  assert.deepEqual(notesFrom(result.yaml), [n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1)]);
  assert.deepEqual(result.losses, ["1 ABC grace note group(s) are skipped."]);
  assert.deepEqual(lossesFromText("read", result.losses).map(({ code, severity, count }) => ({ code, severity, count })), [
    { code: "abc.notation.dropped", severity: "lost", count: 1 },
  ]);
});

test("ABC decorations are skipped with a count and preserve note timing", () => {
  const result = parse("X:1\nL:1/4\nK:C\n!trill! C|");
  assert.deepEqual(notesFrom(result.yaml), [n("1", midi("C"), 0, 1)]);
  assert.deepEqual(result.losses, ["1 ABC decoration(s) are skipped."]);
});

test("ABC slur marks are skipped with a count and preserve note timing", () => {
  const result = parse("X:1\nL:1/4\nK:C\n(C) D|");
  assert.deepEqual(notesFrom(result.yaml), [n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1)]);
  assert.deepEqual(result.losses, ["2 ABC slur mark(s) are skipped."]);
});

test("ABC lyrics are skipped with a count and preserve note timing", () => {
  const result = parse("X:1\nL:1/4\nK:C\nC w:la-la\nD|");
  assert.deepEqual(notesFrom(result.yaml), [n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1)]);
  assert.deepEqual(result.losses, ["1 ABC lyric or annotation field(s) are skipped."]);
});

test("ABC unknown directives are skipped with a count", () => {
  const result = parse("X:1\nR:reel\nL:1/4\nK:C\nC\nI:linebreak\n%%score (1)\nD|");
  assert.deepEqual(notesFrom(result.yaml), [n("1", midi("C"), 0, 1), n("1", midi("D"), 1, 1)]);
  assert.deepEqual(result.losses, ["3 ABC directive(s) are skipped."]);
});

const KEY_SIGNATURES = [
  ["C", []], ["G", ["F"]], ["D", ["F", "C"]], ["A", ["F", "C", "G"]],
  ["E", ["F", "C", "G", "D"]], ["B", ["F", "C", "G", "D", "A"]], ["F#", ["F", "C", "G", "D", "A", "E"]],
  ["C#", ["F", "C", "G", "D", "A", "E", "B"]], ["F", ["B"]], ["Bb", ["B", "E"]],
  ["Eb", ["B", "E", "A"]], ["Ab", ["B", "E", "A", "D"]], ["Db", ["B", "E", "A", "D", "G"]],
  ["Gb", ["B", "E", "A", "D", "G", "C"]], ["Cb", ["B", "E", "A", "D", "G", "C", "F"]],
];
const MODES = [["", 0], ["minor", -3], ["dorian", -2], ["phrygian", -4], ["lydian", 1], ["mixolydian", -1], ["locrian", -5]];
function expectedScale(sf) {
  const altered = new Map();
  const order = sf > 0 ? ["F", "C", "G", "D", "A", "E", "B"] : ["B", "E", "A", "D", "G", "C", "F"];
  for (const letter of order.slice(0, Math.abs(sf))) altered.set(letter, Math.sign(sf));
  return "CDEFGAB".split("").map((letter, index) => midi(letter, 4, altered.get(letter) ?? 0));
}
test("ABC all common key accidental sets and all seven modes produce the expected scale pitches", () => {
  for (const [key, alterations] of KEY_SIGNATURES) {
    const majorSf = key.startsWith("F#") ? 6 : key.startsWith("C#") ? 7 : key === "G" ? 1 : key === "D" ? 2 : key === "A" ? 3 : key === "E" ? 4 : key === "B" ? 5 : key === "F" ? -1 : key === "Bb" ? -2 : key === "Eb" ? -3 : key === "Ab" ? -4 : key === "Db" ? -5 : key === "Gb" ? -6 : key === "Cb" ? -7 : 0;
    for (const [mode, shift] of MODES) {
      const tonicPitch = ({ C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, F: 5, "F#": 6, "C#": 1, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6, Cb: 11 })[key];
      const relativeMajorPitch = (tonicPitch - shift + 12) % 12;
      let candidates = KEY_SIGNATURES.map(([name], ix) => ({ name, sf: [0, 1, 2, 3, 4, 5, 6, 7, -1, -2, -3, -4, -5, -6, -7][ix] }))
        .filter((candidate) => ({ C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, "F#": 6, "C#": 1, F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6, Cb: 11 })[candidate.name] === relativeMajorPitch)
        .sort((a, b) => Math.abs(a.sf) - Math.abs(b.sf));
      const preference = key.endsWith("#") ? 1 : key.endsWith("b") ? -1 : 0;
      if (preference) candidates = candidates.filter((candidate) => Math.sign(candidate.sf) === preference).concat(candidates.filter((candidate) => Math.sign(candidate.sf) !== preference));
      let sf = candidates[0].sf;
      const text = `${key}${mode ? ` ${mode}` : ""}`;
      const actual = notes(`X:1\nL:1/4\nK:${text}\nCDEFGAB|`).map((note) => note.pitch);
      const expected = expectedScale(sf);
      assert.deepEqual(actual, expected, `${text}; tonic key set ${alterations.join("")}; major signature ${majorSf}`);
    }
  }
});

test("ABC common abbreviated mode names match their long forms", () => {
  for (const [short, full] of [["Am", "A minor"], ["Cion", "C ionian"], ["Ddor", "D dorian"],
    ["Ephr", "E phrygian"], ["Flyd", "F lydian"], ["Gmix", "G mixolydian"], ["Bloc", "B locrian"]]) {
    const events = (key) => notes(`X:1\nL:1/4\nK:${key}\nCDEFGAB|`).map((note) => note.pitch);
    assert.deepEqual(events(short), events(full), `${short} should match ${full}`);
  }
});

test("ABC malformed input always raises its typed input error", () => {
  for (const text of ["", "X:1\nC D", "X:1\nK:H\nC", "X:1\nK:C\n[CEG", "X:1\nK:C\n^", "X:1\nM:3/0\nK:C\nC"]) {
    assert.throws(() => parse(text), AbcImportError);
  }
});

test("ABC seeded random text never leaks an untyped exception", () => {
  let seed = 0x12345678;
  for (let run = 0; run < 250; run++) {
    let text = "X:1\nK:C\n";
    for (let i = 0; i < 96; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; text += String.fromCharCode(32 + ((seed >>> 0) % 95)); }
    try { parse(text); } catch (error) { assert.ok(error instanceof AbcImportError, `untyped error: ${error}`); }
  }
});

test("ABC parses ten thousand notes under one second of CPU time", () => {
  const text = `X:1\nL:1/16\nK:C\n${"C".repeat(10_000)}`;
  const start = process.cpuUsage();
  parse(text);
  const used = process.cpuUsage(start);
  assert.ok((used.user + used.system) / 1000 < 1000);
});
