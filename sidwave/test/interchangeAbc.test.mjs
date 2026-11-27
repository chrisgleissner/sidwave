import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { parseSidwave } from "../src/sidwave.ts";
import { exportEvents } from "../src/interchange/events.ts";
import { detectFormat, getFormat } from "../src/interchange/registry.ts";
import { lossesFromText } from "../src/interchange/loss.ts";
import { convert } from "../src/interchange/convert.ts";
import { importAbc, AbcImportError } from "../src/interchange/abcImport.ts";

// Hand-built ABC strings with exact expected notes. Section numbers refer to the ABC 2.1 standard.

const bytes = (text) => new TextEncoder().encode(text);
const parse = (text, options) => importAbc(bytes(text), options);
// A twelfth of a beat holds eighths, dotted pairs and triplets; at 60 BPM such a cell is long enough to compile.
const fine = { grid: 1 / 12 };
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const round = (value) => Math.round(value * 48) / 48;

/** `voice pitch start length` per note, in beats, ordered by voice and start. */
function events(yaml) {
  const score = exportEvents(parseSidwave(yaml));
  return score.voices.flatMap((voice) => voice.notes.map((note) => [
    voice.name, `${NAMES[note.pitch % 12]}${Math.floor(note.pitch / 12) - 1}`,
    round(note.on.tick / score.ppq), round((note.off.tick - note.on.tick) / score.ppq),
  ].join(" ")));
}
/** A tune with unit length 1/4 at 60 BPM in free metre (4 beats, no pickup padding) unless `fields` say otherwise. */
const tune = (body, fields = "", key = "C") => `X:1\nM:none\nL:1/4\nQ:1/4=60\n${fields}K:${key}\n${body}\n`;
const notes = (body, fields, key, options) => events(parse(tune(body, fields, key), { ...fine, ...options }).yaml);
/** The same for one voice, as `pitch start length`. */
const line = (...args) => notes(...args).map((event) => event.slice(event.indexOf(" ") + 1));
const pitches = (...args) => line(...args).map((event) => event.split(" ")[0]).join(" ");
const losses = (text, options) => lossesFromText("read", parse(text, options).losses).map((l) => `${l.code} ${l.severity} ${l.count}`);
const scoreOf = (text, options) => parseSidwave(parse(text, options).yaml);
const tempos = (text) => exportEvents(scoreOf(text)).tempoMap.map((t) => t.bpm);

function rejects(text, pattern, options) {
  assert.throws(() => parse(text, options), (error) => error instanceof AbcImportError && pattern.test(error.message), `${JSON.stringify(text.slice(0, 60))} -> ${pattern}`);
}

test("ABC T, C, M, L and Q set title, author, metre, unit length and tempo", () => {
  const text = "X:1\nT:Scale\nT:Subtitle\nC:Composer % comment\nM:3/4\nL:1/8\nQ:1/4=90\nK:C\nC D E2 F2|G6|";
  const result = parse(text);
  const song = parseSidwave(result.yaml).song;
  assert.deepEqual([song.title, song.tempo, song.meter], ["Scale", 90, 3]);
  assert.ok(/author: Composer\n/.test(result.yaml));
  assert.deepEqual(events(result.yaml), ["1 C4 0 0.5", "1 D4 0.5 0.5", "1 E4 1 1", "1 F4 2 1", "1 G4 3 3"]);
  assert.deepEqual([result.report.tune, result.report.notes, result.report.bars, result.losses.length], ["1", 5, 2, 0]);
  assert.equal(parseSidwave(parse(text, { title: "Other" }).yaml).song.title, "Other");
});

test("ABC default unit note length follows the metre (3.1.7)", () => {
  const first = (meter) => events(parse(`X:1\n${meter}Q:1/4=60\nK:C\nC D|`, fine).yaml)[1];
  assert.equal(first("M:2/4\n"), "1 D4 0.25 0.25");
  assert.equal(first("M:3/4\n"), "1 D4 0.5 0.5");
  assert.equal(first("M:6/8\n"), "1 D4 0.5 0.5");
  assert.equal(first("M:C\n"), "1 D4 0.5 0.5");
  assert.equal(first("M:C|\n"), "1 D4 0.5 0.5");
  assert.equal(first("M:none\n"), "1 D4 0.5 0.5");
  assert.equal(first(""), "1 D4 0.5 0.5");
});

test("ABC Q: forms give quarter notes per minute (3.1.8, 10.1)", () => {
  const cases = [
    ["Q:1/4=100", 100], ["Q:3/8=80", 120], ['Q:"Allegro" 1/4=100', 100], ['Q:3/8=50 "Slowly"', 75], ['Q:"Andante"', 120],
    ["Q:1/4 3/8 1/4 3/8=40", 200], ["Q:C=100", 50], ["Q:C3=40", 60], ["Q:120", 60], ["T:no tempo", 120],
  ];
  for (const [field, bpm] of cases) assert.equal(parseSidwave(parse(`X:1\nL:1/8\n${field}\nK:C\nC4|`).yaml).song.tempo, bpm, field);
  // The deprecated forms count unit note lengths wherever L: stands in the header.
  assert.equal(parseSidwave(parse("X:1\nQ:C=100\nL:1/4\nK:C\nC|").yaml).song.tempo, 100);
});

test("ABC tune selection takes the first tune, or the one with the requested X number", () => {
  const book = "X:5\nL:1/4\nQ:1/4=60\nK:C\nC|\n\nX:2 % second\nL:1/4\nQ:1/4=60\nK:D\nD F|\nX:12\nK:C\nE|";
  assert.deepEqual(events(parse(book).yaml), ["1 C4 0 1"]);
  assert.deepEqual(events(parse(book, { song: 2 }).yaml), ["1 D4 0 1", "1 F#4 1 1"]);
  assert.equal(parse(book, { song: 12 }).report.tune, "12");
  rejects(book, /no ABC tune X:3; the file has X: 5, 2, 12/, { song: 3 });
  assert.deepEqual(getFormat("abc").describe(bytes("X:1\nT:One\nK:C\nC|\n\nX:2\nK:C\nD|")), { tunes: 2, tuneList: ["X:1 One", "X:2"] });
});

test("ABC a tune ends at an empty line and the file header applies to every tune (2.2)", () => {
  const book = "%abc-2.1\nM:2/4\nL:1/4\nQ:1/4=60\n\nFree text: not music.\n\nX:1\nK:G\nF F|\nF|\n\nfree text after the tune\n\nX:2\nL:1/8\nK:C\nC D|";
  assert.deepEqual(events(parse(book).yaml), ["1 F#4 0 1", "1 F#4 1 1", "1 F#4 2 1"]);
  const second = parse(book, { song: 2 });
  assert.deepEqual(events(second.yaml), ["1 C4 0 0.5", "1 D4 0.5 0.5"]);
  assert.ok(/^meter: 2\/4$/m.test(second.yaml));
});

test("ABC detection requires an X: tune line followed by a K: key line", () => {
  assert.equal(detectFormat(bytes("X:1\nT:Recognised\nK:C\nC|"), "tune.abc").best.id, "abc");
  assert.equal(detectFormat(bytes("% note\r\nX: 1 % first\r\nK:\r\nC|"), "tune.txt").best.id, "abc");
  assert.equal(detectFormat(bytes("X:1\nT:No key\nC|"), "tune.abc").best, undefined);
  assert.equal(detectFormat(bytes("K:C\nX:1\nC|"), "tune.abc").best, undefined);
});

test("ABC accidentals and octave marks give exact pitches (4.1, 4.2)", () => {
  assert.equal(pitches("^C _D =F ^^C __E| c' B, C,, c C' c,|"), "C#4 C#4 F4 D4 D4 C6 B3 C2 C5 C5 C4");
});

test("ABC an accidental carries to the end of the bar, in all octaves by default (11.3)", () => {
  assert.equal(pitches("^F F f|F f|"), "F#4 F#4 F#5 F4 F5");
  assert.equal(pitches("_B B| =B B|B|", "", "F"), "A#4 A#4 B4 B4 A#4");
  assert.equal(pitches("%%propagate-accidentals octave\n^F F f|F|"), "F#4 F#4 F5 F4");
  assert.equal(pitches("^F F f|", "I:propagate-accidentals not\n"), "F#4 F4 F5");
});

// The table of section 3.1.14: signature (sharps positive) and the key in each mode that has it.
const MODE_NAMES = ["major", "minor", "mixolydian", "dorian", "phrygian", "lydian", "locrian"];
const KEY_TABLE = `
7 C# A# G# D# E# F# B#
6 F# D# C# G# A# B E#
5 B G# F# C# D# E A#
4 E C# B F# G# A D#
3 A F# E B C# D G#
2 D B A E F# G C#
1 G E D A B C F#
0 C A G D E F B
-1 F D C G A Bb E
-2 Bb G F C D Eb A
-3 Eb C Bb F G Ab D
-4 Ab F Eb Bb C Db G
-5 Db Bb Ab Eb F Gb C
-6 Gb Eb Db Ab Bb Cb F
-7 Cb Ab Gb Db Eb Fb Bb`.trim().split("\n").map((row) => row.split(" "));
function scale(signature) {
  const order = signature > 0 ? "FCGDAEB" : "BEADGCF";
  const altered = new Set(order.slice(0, Math.abs(signature)));
  const step = { C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, B: 71 };
  return [..."CDEFGAB"].map((letter) => step[letter] + (altered.has(letter) ? Math.sign(signature) : 0))
    .map((pitch) => `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`).join(" ");
}

test("ABC every key and mode of the standard table gives its accidentals", () => {
  assert.equal(KEY_TABLE.length, 15);
  for (const [signature, ...tonics] of KEY_TABLE) {
    for (const [i, tonic] of tonics.entries()) {
      const key = `${tonic} ${MODE_NAMES[i]}`;
      assert.equal(pitches("CDEFGAB|", "", key, { validate: false }), scale(Number(signature)), key);
    }
  }
});

test("ABC mode spellings, explicit and modified keys, bagpipe keys and clef words", () => {
  const same = [["Am", "A minor"], ["Aaeo", "A MINOR"], ["Cion", "C"], ["C maj", "Cmajor"], ["Ddor", "D Dorian"], ["F#Mix", "F# MIXOLYDIAN"], ["Ephr", "E phrygian"], ["Flyd", "F lydian"], ["Bloc", "B locrian"]];
  for (const [short, long] of same) assert.equal(pitches("CDEFGAB|", "", short), pitches("CDEFGAB|", "", long), short);
  assert.equal(pitches("B F c e|", "", "D exp _b _e ^f"), "A#4 F#4 C4 D#5".replace("C4", "C5"));
  assert.equal(pitches("F c B|", "", "D =c"), "F#4 C5 B4");
  assert.equal(pitches("B e f|", "", "D phr ^f"), "A#4 D#5 F#5");
  assert.equal(pitches("F c g|", "", "Hp"), "F#4 C#5 G5");
  assert.equal(pitches("F c|", "", "HP"), "F4 C5");
  assert.equal(pitches("F c|", "", "none"), "F4 C5");
  assert.equal(pitches("F c|", "", ""), "F4 C5");
  assert.equal(pitches("F|", "", "D treble"), "F#4");
  assert.equal(pitches("B|", "", "F clef=bass middle=d"), "A#4");
  assert.equal(pitches("B|", "", "Bb bass"), "A#4");
  assert.equal(pitches("C|", "", "bass"), "C4");
  assert.equal(pitches("C|", "", "C octave=-1"), "C3");
  assert.equal(pitches("C|", "", "C transpose=2"), "D4");
  assert.equal(pitches("C|", "", "C treble-8"), "C3");
});

test("ABC length forms /, //, /4, 3/2 and 3// have exact durations (4.3)", () => {
  assert.deepEqual(line("C/ D// E3/2 F/4 G3// A2|"), ["C4 0 0.5", "D4 0.5 0.25", "E4 0.75 1.5", "F4 2.25 0.25", "G4 2.5 0.75", "A4 3.25 2"]);
});

test("ABC rests z and x, and multi-measure rests Z and X (4.5)", () => {
  assert.deepEqual(line("C z D x2 E|"), ["C4 0 1", "D4 2 1", "E4 5 1"]);
  assert.deepEqual(line("C4|Z|D4|Z2|E4|X|F4|"), ["C4 0 4", "D4 8 4", "E4 20 4", "F4 28 4"]);
  assert.deepEqual(line("C3|Z|[M:2/4]Z2|D2|", "M:3/4\n"), ["C4 0 3", "D4 10 2"]);
});

test("ABC broken rhythm with one to three marks, around grace notes, chords and rests (4.4)", () => {
  assert.deepEqual(line("C>D E<F|"), ["C4 0 1.5", "D4 1.5 0.5", "E4 2 0.5", "F4 2.5 1.5"]);
  assert.deepEqual(line("C2>>D2|"), ["C4 0 3.5", "D4 3.5 0.5"]);
  assert.deepEqual(line("C2<<<D2|"), ["C4 0 0.25", "D4 0.25 3.75"]);
  assert.deepEqual(line("C<{g}D E{g}>F|"), ["C4 0 0.5", "D4 0.5 1.5", "E4 2 1.5", "F4 3.5 0.5"]);
  assert.deepEqual(line("[CE]>G z>A|", "", "C", { voices: 1 }), ["E4 0 1.5", "G4 1.5 0.5", "A4 3.5 0.5"]);
  assert.deepEqual(line("C>|D|"), ["C4 0 1.5", "D4 1.5 0.5"]);
});

test("ABC simple tuplets use the default q of the metre (4.13)", () => {
  // With a whole note as the unit, the start of the second note is four times the tuplet factor.
  const second = (meter, p) => round(Number(events(parse(`X:1\nM:${meter}\nL:1\nQ:1/4=60\nK:C\n(${p}CDEFGABcd|`, fine).yaml)[1].split(" ")[2]));
  const simple = { 2: 3 / 2, 3: 2 / 3, 4: 3 / 4, 5: 2 / 5, 6: 2 / 6, 7: 2 / 7, 8: 3 / 8, 9: 2 / 9 };
  const compound = { ...simple, 5: 3 / 5, 7: 3 / 7, 9: 3 / 9 };
  for (const [meter, table] of [["4/4", simple], ["6/8", compound], ["9/8", compound], ["12/8", compound], ["3/4", simple]]) {
    for (const [p, length] of Object.entries(table)) assert.equal(second(meter, p), round(Math.round(4 * length * 12) / 12), `(${p} in ${meter}`);
  }
});

test("ABC general tuplets (p:q:r, chords and rests in tuplets", () => {
  assert.deepEqual(line("(3CDE F|"), ["C4 0 2/3", "D4 2/3 2/3", "E4 4/3 2/3", "F4 2 1"].map(evaluate));
  assert.deepEqual(line("(3:2:2 C2D E|"), ["C4 0 4/3", "D4 4/3 2/3", "E4 2 1"].map(evaluate));
  assert.deepEqual(line("(3::2 CD E|"), ["C4 0 2/3", "D4 2/3 2/3", "E4 4/3 1"].map(evaluate));
  assert.deepEqual(line("(3:2:4 C2D2EF G|"), ["C4 0 4/3", "D4 4/3 4/3", "E4 8/3 2/3", "F4 10/3 2/3", "G4 4 1"].map(evaluate));
  assert.deepEqual(line("(3 z D [EG] F|", "", "C", { voices: 1 }), ["D4 2/3 2/3", "G4 4/3 2/3", "F4 2 1"].map(evaluate));
});
/** "C4 2/3 4/3" with the fractions as numbers. */
function evaluate(event) {
  return event.split(" ").map((part) => (part.includes("/") ? round(Number(part.split("/")[0]) / Number(part.split("/")[1])) : part)).join(" ");
}

test("ABC ties join notes of the same pitch within and across bars (4.11)", () => {
  assert.deepEqual(line("C-C D2-|D C|"), ["C4 0 2", "D4 2 3", "C4 5 1"]);
  assert.deepEqual(line("C4-|C4-|C4|D|"), ["C4 0 12", "D4 12 1"]);
  assert.deepEqual(line("CDEF-|FGAB|c|"), ["C4 0 1", "D4 1 1", "E4 2 1", "F4 3 2", "G4 5 1", "A4 6 1", "B4 7 1", "C5 8 1"]);
  // The tied note keeps the accidental; the note after it does not.
  assert.deepEqual(line("z3 ^F-|F F|"), ["F#4 3 2", "F4 5 1"]);
  assert.deepEqual(line("C.-C|"), ["C4 0 2"]);
});

test("ABC ties in chords, into repeats, and ties that cannot be connected", () => {
  assert.deepEqual(notes("[CE]2- [CE] [C-E] C|"), [
    "1 E4 0 3", "1 E4 3 1", "1-chord2 C4 0 3", "1-chord2 C4 3 2",
  ]);
  assert.deepEqual(line("|:C3 D-|1 D4:|2 D2 E2|]"), ["C4 0 3", "D4 3 5", "C4 8 3", "D4 11 3", "E4 14 2"]);
  const text = tune("C- D C-|z C- |");
  assert.deepEqual(events(parse(text).yaml), ["1 C4 0 1", "1 D4 1 1", "1 C4 2 1", "1 C4 4 1"]);
  assert.deepEqual(losses(text), ["abc.ties.dropped lost 3"]);
});

test("ABC repeats and first and second endings play in order (4.8, 4.9)", () => {
  const played = (body) => pitches(body, "M:none\n").replaceAll("4", "").replaceAll(" ", "");
  assert.equal(played("|:CD:|E|"), "CDCDE");
  assert.equal(played("CD:|E|"), "CDCDE");
  assert.equal(played("|:CD|1EF:|2GA|]B|"), "CDEFCDGAB");
  assert.equal(played("|:CD|[1EF:|[2GA||B|"), "CDEFCDGAB");
  assert.equal(played("|:CD| [1 EF :| [2 GA |] B|"), "CDEFCDGAB");
  assert.equal(played("|:C|1D|E:|2F|]"), "CDECF");
  assert.equal(played("|:C|1D:|E|F|"), "CDCEF");
  assert.equal(played("CD::EF:|G|"), "CDCDEFEFG");
  assert.equal(played("|:CD:||:EF:|"), "CDCDEFEF");
  assert.equal(played("|:CD:|:EF:|"), "CDCDEFEF");
  assert.equal(played("|::CD::|E|"), "CDCDCDE");
  // A repeat without |: starts after the previous repeat or double bar.
  assert.equal(played("C:|D||E:|F|"), "CCDEEF");
  assert.equal(played("|:A||B:|C|]"), "ABABC");
  assert.equal(played("|:C|1D:|2E|]|:F|1G:|2A|]"), "CDCEFGFA");
});

test("ABC variant endings with lists and ranges (4.10)", () => {
  const played = (body) => pitches(body, "M:none\n").replaceAll("4", "").replaceAll(" ", "");
  assert.equal(played("|:C|[1,3 D:|[2 E:|[4 F|]G|"), "CDCECDCFG");
  assert.equal(played("|:C|[1-3 D:|[4 E|]"), "CDCDCDCE");
  assert.equal(played("|:C[1D:|[2E|]"), "CDCE");
});

test("ABC a pickup bar is padded so that bar lines line up", () => {
  const result = parse(tune("G|c4|", "M:4/4\n"), fine);
  assert.deepEqual(events(result.yaml), ["1 G4 3 1", "1 C5 4 4"]);
  assert.deepEqual(result.losses, ["A pickup bar of 1 beats is preceded by 3 beats of rest so that the bar lines line up."]);
  assert.deepEqual(line("G|c4|", "M:none\n"), ["G4 0 1", "C5 1 4"]);
  assert.deepEqual(line("G|", "M:4/4\n"), ["G4 0 1"]);
});

test("ABC voices declared in the header and switched in the body keep their own time (7)", () => {
  const text = "X:1\nL:1/4\nQ:1/4=60\nV:1 name=\"Lead\"\nV:b clef=bass\nK:C\nC D [V:b] G, A, [V:1] E|\nV:b\nB,|";
  assert.deepEqual(events(parse(text).yaml), ["1 C4 0 1", "1 D4 1 1", "1 E4 2 1", "b G3 0 1", "b A3 1 1", "b B3 2 1"]);
  // Voice order is the order of the declarations, not of the music.
  assert.deepEqual(events(parse("X:1\nL:1/4\nQ:1/4=60\nV:a\nV:z\nK:C\n[V:z]D|\n[V:a]C|").yaml), ["a C4 0 1", "z D4 0 1"]);
});

test("ABC voices only named in the body do not lose a slot to an empty default voice", () => {
  const result = parse(tune("V:S\nC|\nV:A\nE|\nV:B\nG|"));
  assert.deepEqual(events(result.yaml), ["S C4 0 1", "A E4 0 1", "B G4 0 1"]);
  assert.deepEqual(result.losses, []);
});

test("ABC voice octave and clef shifts apply to playback", () => {
  assert.deepEqual(notes("[V:1] C|\n[V:2] C|", "V:1 octave=-1\nV:2 clef=treble+8\n"), ["1 C3 0 1", "2 C5 0 1"]);
});

test("ABC voices beyond the voice limit are counted", () => {
  const text = tune("[V:1]C|\n[V:2]D|\n[V:3]E|\n[V:4]F|");
  assert.deepEqual(events(parse(text).yaml).length, 3);
  assert.deepEqual(losses(text), ["voices.dropped lost 1"]);
  assert.deepEqual(losses(text, { voices: 1 }), ["voices.dropped lost 3"]);
});

test("ABC chords put the highest note in the voice and count the reduction (4.17)", () => {
  const result = parse(tune("[CEG]2 A|"));
  assert.deepEqual(events(result.yaml), ["1 G4 0 2", "1 A4 2 1", "1-chord2 E4 0 2", "1-chord3 C4 0 2"]);
  assert.deepEqual(result.losses, ["1 ABC chord(s) are reduced to simultaneous SID voice lanes."]);
  // Lengths inside and outside multiply; the first note gives the length of the chord.
  assert.deepEqual(notes("[C2E2]2 [G/E] D|"), ["1 E4 0 4", "1 G4 4 0.5", "1 D4 4.5 1", "1-chord2 C4 0 4", "1-chord2 E4 4 1"]);
});

test("ABC chord tones that do not fit keep every voice's top note first", () => {
  const text = tune("[V:1][CEG]|\n[V:2]C,|\n[V:3]G,|");
  assert.deepEqual(events(parse(text).yaml), ["1 G4 0 1", "2 C3 0 1", "3 G3 0 1"]);
  assert.deepEqual(losses(text), ["abc.chords approx 1", "abc.chord-tones.dropped lost 2"]);
});

test("ABC fields in the body change key, length, metre and tempo (3.2)", () => {
  assert.equal(pitches("F [K:D] F|\nK:F\nB F|"), "F4 F#4 A#4 F4");
  assert.equal(pitches("^C [K:G] C|"), "C#4 C4");
  assert.equal(pitches("F|[K: clef=bass]F|", "", "D"), "F#4 F#4");
  assert.deepEqual(line("C [L:1/8] C C|\nL:1/2\nC|"), ["C4 0 1", "C4 1 0.5", "C4 1.5 0.5", "C4 2 2"]);
  const text = tune("C4|[M:3/4][Q:1/4=90]C3|\nM:2/4\nQ:1/4=60\nC2|", "M:4/4\n");
  const sections = scoreOf(text).timeline.map((s) => [s.bars, s.tempo, s.meterSig ?? s.meter]);
  assert.deepEqual(sections.map((s) => s[0]), [1, 1, 1]);
  assert.deepEqual(tempos(text), [60, 90, 60]);
  assert.ok(/meter: 3\/4/.test(parse(text).yaml) && /meter: 2\/4/.test(parse(text).yaml));
});

test("ABC a field before the first note and V: applies to all voices, afterwards to the current voice", () => {
  assert.deepEqual(notes("K:D\nL:1/2\n[V:1]F|\n[V:2]F|\nK:C\n[V:2]F|\n[V:1]F|"), ["1 F#4 0 2", "1 F#4 2 2", "2 F#4 0 2", "2 F4 2 2"]);
  assert.deepEqual(notes("V:1\nK:D\nF|\nV:2\nF|"), ["1 F#4 0 1", "2 F4 0 1"]);
});

test("ABC tempo changes are replayed by repeats, and a change inside a bar moves to the next bar", () => {
  assert.deepEqual(tempos(tune("|:C4|[Q:1/4=90]D4:|E4|", "M:4/4\n")), [60, 90, 60, 90]);
  const text = tune("C2 [Q:1/4=90] C2|D4|", "M:4/4\n");
  assert.deepEqual(tempos(text), [60, 90]);
  assert.deepEqual(losses(text), ["abc.change.moved approx 1"]);
});

test("ABC line continuation, comments and CR or CRLF line ends (6.1, 8)", () => {
  const expected = ["C4 0 1", "D4 1 1", "E4 2 1", "F4 3 1"];
  assert.deepEqual(line("C D\\\nE F|"), expected);
  assert.deepEqual(line("C D \\ % more follows\n% a comment line\nE F|"), expected);
  assert.deepEqual(line("C D \\\nK:C\nE F|"), expected);
  assert.deepEqual(line("C D % E F\nE F|"), expected);
  assert.deepEqual(events(parse(tune("C D|\nE F|").replaceAll("\n", "\r\n")).yaml).length, 4);
  assert.deepEqual(events(parse(tune("C D|\nE F|").replaceAll("\n", "\r")).yaml).length, 4);
});

test("ABC skipped notation is counted by kind and leaves the timing unchanged", () => {
  const body = '{c}C !trill!D +fermata+E .F|(G A) "Am"B ~c|HD uE $ y `F G!\nw: la la la\nA|';
  const result = parse(tune(body));
  assert.deepEqual(events(result.yaml).map((e) => e.split(" ")[2]), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.deepEqual(result.losses, [
    "1 ABC grace note group(s) are skipped.", "6 ABC decoration(s) are skipped.", "2 ABC slur mark(s) are skipped.",
    "1 ABC chord symbol(s) or annotation(s) are skipped.", "1 ABC lyric line(s) are skipped.",
  ]);
  assert.deepEqual(lossesFromText("read", result.losses).map((l) => `${l.code} ${l.severity}`), Array(5).fill("abc.notation.dropped lost"));
});

test("ABC unknown directives, fields, overlays and part order are counted", () => {
  const text = "X:1\nR:reel\nP:AB\nL:1/4\nQ:1/4=60\nK:C\nC\nI:linebreak $\n%%score (1)\n%%begintext\nnot music\n%%endtext\nD & E F|G|";
  assert.deepEqual(events(parse(text).yaml), ["1 C4 0 1", "1 D4 1 1", "1 G4 2 1"]);
  assert.deepEqual(losses(text), ["abc.notation.dropped lost 4", "abc.overlay.dropped lost 1", "abc.parts.ignored lost 1"]);
});

test("ABC metre, tempo, grid, pitch range, metadata and charset approximations are reported", () => {
  const metre = parse("X:1\nM:3/8\nL:1/8\nQ:1/4=60\nK:C\nCDE|FGA|");
  assert.deepEqual(metre.losses, ["3/8 time signature is approximated by 6/8."]);
  assert.equal(events(metre.yaml)[3], "1 F4 1.5 0.5");
  const fast = `X:1\nL:1/4\nQ:1/2=150\nK:C\nC4|`;
  assert.equal(parseSidwave(parse(fast).yaml).song.tempo, 220);
  assert.deepEqual(losses(fast), ["abc.tempo.clamped approx 1"]);
  assert.deepEqual(losses(tune("(3CDE F|"), { grid: 0.25 }), ["abc.timing.quantized approx 3"]);
  assert.deepEqual(losses(tune("c'''''' C|")), ["pitch.octave approx 1"]);
  assert.deepEqual(losses(tune("C|", `T:${"a".repeat(81)}\n`)), ["abc.metadata.truncated approx 1"]);
  const latin = Buffer.from(tune("C|", "T:Café\n"), "latin1");
  const read = importAbc(latin);
  assert.ok(read.yaml.includes("title: Café"));
  assert.deepEqual(read.losses, ["The file is not UTF-8 and is read as Latin-1."]);
});

test("ABC unsupported grid and voice options give the typed error", () => {
  rejects(tune("C|"), /grid must be/, { grid: 0 });
  rejects(tune("C|"), /voices must be/, { voices: 4 });
  rejects(tune("C|"), /does not divide/, { grid: 3 });
});

test("ABC malformed input raises the typed input error with a reason", () => {
  const body = (text, pattern) => rejects(`X:1\nK:C\n${text}`, pattern);
  rejects("", /no ABC tune/);
  rejects("X:1\nC D", /line 2: unexpected line/);
  rejects("X:1\nT:no key", /no K: field/);
  rejects("X:abc\nK:C\nC", /invalid ABC tune number/);
  rejects("X:1\nK:H\nC", /invalid ABC key/);
  rejects("X:1\nK:Cfoo\nC", /invalid ABC key/);
  rejects("X:1\nK:G#\nC", /more than seven/);
  rejects("X:1\nM:3/0\nK:C\nC", /metre/);
  rejects("X:1\nM:waltz\nK:C\nC", /metre/);
  rejects("X:1\nL:0\nK:C\nC", /unit note length/);
  rejects("X:1\nQ:fast\nK:C\nC", /tempo/);
  body("[CEG", /line 3: unterminated ABC chord/);
  body("[]", /unexpected|no notes|bar/);
  body("[CEZ]", /unexpected "Z"/);
  body("^", /accidental/);
  body("C>", /no following note/);
  body(">C", /no preceding note/);
  body("C>>>>D", /more than three/);
  body("{c", /grace/);
  body('"Am', /chord symbol/);
  body("+trill", /decoration/);
  body("C0", /note length/);
  body("C/0", /note length/);
  body("C99999", /note length/);
  body("(1CD", /tuplet/);
  body("(12CD", /tuplet/);
  body("C|[99 D", /ending/);
  body("C|[3-1 D", /ending/);
  body("C \\ D", /end of a line/);
  body("[K:H]C", /invalid ABC key/);
  body("[K:D C", /inline field/);
  body("C : D", /unexpected ":"/);
  body("hello", /line 3: unexpected character "h" at column 1/);
  body("z4|", /contains no notes/);
});

test("ABC repeat bombs, huge lengths and large counts are refused quickly", () => {
  const cases = [
    ["X:1\nK:C\n" + "|::::::::C::::::::|\n".repeat(8000), /expanded ABC repeats/],
    [`X:1\nK:C\n|:${"C".repeat(150_000)}::::::::|`, /expanded ABC repeats/],
    ["X:1\nK:C\n|:::::::::C|", /longer than nine passes/],
    [`X:1\nK:C\n${":".repeat(1_000_000)}`, /too long/],
    [`X:1\nK:C\n${"C".repeat(200_001)}`, /more than 200000/],
    [`X:1\nK:C\n${"C|".repeat(8200)}`, /written bars/],
    [`X:1\nK:C\nC${"9".repeat(100_000)}`, /note length/],
    [`X:1\nK:C\nC${"/".repeat(100_000)}`, /note length/],
    ["X:1\nL:64\nK:C\nC1024", /note length/],
    ["X:1\nM:4/4\nK:C\nCZ999", /note length/],
    [`X:1\nM:4/4\nK:C\nC${"|Z500".repeat(1000)}`, /grid cells|bars/],
    [`X:1\nK:C\n${Array.from({ length: 65 }, (_, i) => `[V:v${i}]C`).join("")}`, /more than 64 voices/],
    [`X:1\nK:C\n[${"C".repeat(100_000)}]`, /chord has more than/],
    [`X:1\nT:${"a".repeat(5000)}\nK:C\nC`, /4096/],
    ["X:1\nK:C\nC" + "\n".repeat(500_001), /500000 lines/],
  ];
  for (const [text, pattern] of cases) {
    const start = process.cpuUsage();
    rejects(text, pattern, { grid: 0.25 });
    const used = process.cpuUsage(start);
    assert.ok((used.user + used.system) / 1000 < 5000, `${pattern}: ${(used.user + used.system) / 1000} ms`);
  }
  rejects("X:1\nK:C\n" + " ".repeat(8 * 1024 * 1024), /limit is/);
});

test("ABC seeded random text and random ABC fragments never leak an untyped exception", () => {
  let seed = 0x12345678;
  const random = (n) => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const parts = ["C", "d", "^", "_", "=", ",", "'", "2", "/", "|", ":", "[", "]", "(", ")", "3", "-", ">", "<", "z", "Z", "x", "{", "}", '"', "!", "+", "&", " ", "\\", "%", "\n",
    "|:", ":|", "[1", "[2", "[V:2]", "[K:D]", "[M:6/8]", "[L:1/8]", "[Q:90]", "K:", "V:", "M:", "L:", "Q:", "w:", "%%x", "C D E F|"];
  let accepted = 0;
  for (let run = 0; run < 1500; run++) {
    let text = "X:1\nK:C\n";
    // One run in five is printable noise; the others mix notes with ABC syntax.
    for (let i = 1 + random(24); i > 0; i--) text += run % 5 === 0 ? String.fromCharCode(32 + random(95)) : random(2) ? "CDEFGabc|"[random(9)] : parts[random(parts.length)];
    try { parse(text, { grid: 0.25, validate: false }); accepted++; } catch (error) { assert.ok(error instanceof AbcImportError, `${JSON.stringify(text)}: untyped error: ${error.stack}`); }
  }
  for (let run = 0; run < 300; run++) {
    const raw = Uint8Array.from({ length: random(200) }, () => random(256));
    try { importAbc(Uint8Array.from([...bytes("X:1\nK:C\n"), ...raw]), { validate: false }); } catch (error) { assert.ok(error instanceof AbcImportError, `untyped error: ${error.stack}`); }
  }
  assert.ok(accepted > 100, `only ${accepted} random tunes were accepted`);
});

test("ABC parses ten thousand notes under one second of CPU time", () => {
  const text = `X:1\nL:1/16\nK:C\n${"CDEF GABc|\n".repeat(1250)}`;
  const start = process.cpuUsage();
  const result = importAbc(bytes(text), { validate: false });
  const used = process.cpuUsage(start);
  assert.equal(result.report.notes, 10_000);
  assert.ok((used.user + used.system) / 1000 < 1000, `${(used.user + used.system) / 1000} ms`);
});

test("ABC convert detects the format and passes the tune number, grid, voices and title to the reader", async () => {
  const book = bytes("X:1\nK:C\nC4|\n\nX:2\nT:Two\nL:1/4\nQ:1/4=60\nK:C\n(3[CE]DE F|\n");
  const result = await convert(book, { inputName: "book.abc", to: "sidwave", song: 2, grid: 1 / 12, voices: 1, title: "Chosen" });
  assert.deepEqual([result.from, result.reports.read.tune, result.reports.read.gridBeats], ["abc", "2", 1 / 12]);
  assert.equal(parseSidwave(result.score).song.title, "Chosen");
  assert.deepEqual(events(result.score), ["1 E4 0 2/3", "1 D4 2/3 2/3", "1 E4 4/3 2/3", "1 F4 2 1"].map(evaluate));
  assert.deepEqual(result.losses.filter((l) => l.stage === "read").map((l) => l.code), ["abc.chords", "abc.chord-tones.dropped"]);
});

// ---- whole tunes (original test data in test/fixtures/abc) -------------------------------------------------------

const fixture = (name, options) => importAbc(fs.readFileSync(new URL(`./fixtures/abc/${name}.abc`, import.meta.url)), options);
const sounding = (yaml) => exportEvents(parseSidwave(yaml)).voices;

test("ABC a reel with a pickup, two endings, triplets and a metre change compiles with every bar", () => {
  const result = fixture("lantern-reel");
  // Pickup padded to a bar, A with its two endings (3 + 3 bars), B twice (3 x 4 beats and one bar of 6).
  assert.equal(result.report.notes, 108);
  const [voice] = sounding(result.yaml);
  assert.deepEqual([voice.notes[0].pitch, voice.notes[1].pitch], [69, 74]);
  assert.equal(voice.notes.at(-1).pitch, 74);
  assert.deepEqual(lossesFromText("read", result.losses).map((l) => l.code).sort(), [
    "abc.notation.dropped", "abc.notation.dropped", "abc.notation.dropped", "abc.notation.dropped", "abc.pickup.padded",
    "abc.timing.quantized", "meter.approximated", "meter.approximated",
  ]);
});

test("ABC a tunebook selects its jig and its slip jig", () => {
  assert.equal(fixture("quarry-jig").report.title, "Quarry Road Jig");
  const slip = fixture("quarry-jig", { song: 9 });
  assert.deepEqual([slip.report.title, slip.report.notes, slip.report.bars, slip.losses.length], ["Slip Across", 13, 2, 0]);
});

test("ABC a two-part air keeps both parts and the chord note of the last bar", () => {
  const result = fixture("two-part-air");
  const voices = sounding(result.yaml);
  assert.deepEqual(voices.map((v) => v.name), ["S", "S-chord2", "B"]);
  assert.deepEqual(voices.map((v) => v.notes.length), [18, 1, 10]);
  assert.equal(result.report.bars, 8);
});
