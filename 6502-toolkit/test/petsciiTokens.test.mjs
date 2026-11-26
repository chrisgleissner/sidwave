import test from "#test/runner";
import assert from "#test/assert";
import {
  asciiToPetscii,
  encodeStringWithNames,
  lookupNamedPetscii,
  parseBraceToken,
  parseNamedCharToken,
  petsciiControlName,
  petsciiToAscii,
  petsciiToScreenCode,
  screenCodesToAscii,
} from "../src/petscii.js";
import { code, failure } from "./helpers/asm.js";

const bytes = (text, options) => [...encodeStringWithNames(text, options)];

test("every brace name of the control-code table gives its code, with spaces, dashes and case ignored", () => {
  const table = {
    stop: 3, wht: 5, white: 5, bell: 7, dis_case_switch: 8, ena_case_switch: 9, lf: 10, return: 13, cr: 13, newline: 13, lowercase: 14, swlc: 14,
    down: 17, cursor_down: 17, crsr_down: 17, rvs_on: 18, reverse_on: 18, rvon: 18, home: 19, cursor_home: 19, crsr_home: 19, del: 20, delete: 20,
    red: 28, right: 29, cursor_right: 29, crsr_right: 29, grn: 30, green: 30, blu: 31, blue: 31, up_arrow: 94, uparrow: 94, left_arrow: 95,
    leftarrow: 95, heart: 115, org: 129, orange: 129, run: 131, f1: 133, f3: 134, f5: 135, f7: 136, f2: 137, f4: 138, f6: 139, f8: 140,
    shift_return: 141, uppercase: 142, swuc: 142, blk: 144, black: 144, up: 145, cursor_up: 145, crsr_up: 145, rvs_off: 146, reverse_off: 146,
    rvoff: 146, clr: 147, clear: 147, inst: 148, ins: 148, insert: 148, brn: 149, brown: 149, lred: 150, light_red: 150, dgry: 151, dark_grey: 151,
    dark_gray: 151, gry1: 151, mgry: 152, medium_grey: 152, medium_gray: 152, gry2: 152, lgrn: 153, light_green: 153, lblu: 154, light_blue: 154,
    lgry: 155, light_grey: 155, light_gray: 155, gry3: 155, pur: 156, purple: 156, left: 157, cursor_left: 157, crsr_left: 157, yel: 158, yellow: 158,
    cyn: 159, cyan: 159, pi: 222,
  };
  for (const [name, value] of Object.entries(table)) {
    assert.equal(lookupNamedPetscii(name), value, name);
    assert.deepEqual(parseBraceToken(`{${name}}`, 0), { ok: true, value, endIndex: name.length + 2 }, name);
  }
  assert.equal(lookupNamedPetscii("  Light-Blue "), 154);
  assert.equal(lookupNamedPetscii("light  blue"), 154);
  assert.equal(lookupNamedPetscii("nothing"), undefined);
});

test("canonical listing names: the first name of each row with spaces, none for codes 7 and 10", () => {
  assert.equal(petsciiControlName(147), "clr");
  assert.equal(petsciiControlName(17), "down");
  assert.equal(petsciiControlName(18), "rvs on");
  assert.equal(petsciiControlName(151), "dgry");
  assert.equal(petsciiControlName(222), "pi");
  assert.equal(petsciiControlName(7), undefined);
  assert.equal(petsciiControlName(10), undefined);
  assert.equal(petsciiControlName(0x41), undefined);
});

test("parseBraceToken: hex with one or two digits, decimal up to 255, whitespace, candidates and non-candidates", () => {
  assert.deepEqual(parseBraceToken("{$1}", 0), { ok: true, value: 1, endIndex: 4 });
  assert.deepEqual(parseBraceToken("{$FF}", 0), { ok: true, value: 255, endIndex: 5 });
  assert.deepEqual(parseBraceToken("x{ 147 }", 1), { ok: true, value: 147, endIndex: 8 });
  assert.deepEqual(parseBraceToken("{0}", 0), { ok: true, value: 0, endIndex: 3 });
  assert.deepEqual(parseBraceToken("{255}", 0), { ok: true, value: 255, endIndex: 5 });
  assert.deepEqual(parseBraceToken("{256}", 0), { ok: false, token: "{256}", reason: "decimal codes are 0-255", endIndex: 5 });
  assert.deepEqual(parseBraceToken("{0147}", 0), { ok: false, token: "{0147}", reason: "decimal codes are 0-255", endIndex: 6 });
  assert.deepEqual(parseBraceToken("{nope}", 0), { ok: false, token: "{nope}", reason: "unknown control-code name", endIndex: 6 });
  assert.deepEqual(parseBraceToken("{$123}", 0), { ok: false, token: "{$123}", reason: "unknown control-code name", endIndex: 6 });
  assert.equal(parseBraceToken("{}", 0), null);
  assert.equal(parseBraceToken("x", 0), null);
  assert.equal(parseBraceToken("{a", 0), null);
  assert.equal(parseBraceToken("{a.b}", 0), null);
  assert.equal(parseBraceToken("a{red}", 0), null);
});

test("parseNamedCharToken accepts {name}, :name: and <name> and reports the index after the token", () => {
  assert.deepEqual(parseNamedCharToken("{red}x", 0), { value: 28, endIndex: 5 });
  assert.deepEqual(parseNamedCharToken("{$93}", 0), { value: 147, endIndex: 5 });
  assert.deepEqual(parseNamedCharToken(":clear:x", 0), { value: 147, endIndex: 7 });
  assert.deepEqual(parseNamedCharToken("<home>", 0), { value: 19, endIndex: 6 });
  assert.deepEqual(parseNamedCharToken("<Reverse-On>", 0), { value: 18, endIndex: 12 });
  assert.equal(parseNamedCharToken("{nope}", 0), null);
  assert.equal(parseNamedCharToken(":nope:", 0), null);
  assert.equal(parseNamedCharToken(":red:", 0), null);
  assert.equal(parseNamedCharToken("<a b>", 0), null);
  assert.equal(parseNamedCharToken(":open", 0), null);
  assert.equal(parseNamedCharToken("plain", 0), null);
  assert.equal(parseNamedCharToken("", 0), null);
});

test("encodeStringWithNames: names become codes, other text is passed through, lower case may be folded", () => {
  assert.deepEqual(bytes("{clear}Hello{return}"), [147, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 13]);
  assert.deepEqual(bytes("a{red}b", { foldLowercase: true }), [0x41, 28, 0x42]);
  assert.deepEqual(bytes("a{red}b"), [0x61, 28, 0x62]);
  assert.deepEqual(bytes("<home>:heart:"), [19, 115]);
  assert.deepEqual(bytes("{unknown}"), [...Buffer.from("{unknown}")]);
  assert.deepEqual(bytes(""), []);
  assert.deepEqual(bytes("é"), [0xe9]);
  assert.throws(() => encodeStringWithNames("€"), { message: "Character out of PETSCII range: €" });
});

test("asciiToPetscii passes single characters up to 255 and rejects the rest with exact messages", () => {
  assert.equal(asciiToPetscii("A"), 0x41);
  assert.equal(asciiToPetscii("a"), 0x61);
  assert.equal(asciiToPetscii("ÿ"), 0xff);
  assert.equal(asciiToPetscii("\n"), 10);
  assert.throws(() => asciiToPetscii(""), { message: "Expected a single character" });
  assert.throws(() => asciiToPetscii("ab"), { message: "Expected a single character" });
  assert.throws(() => asciiToPetscii("Ā"), { message: "Character out of PETSCII range: Ā" });
});

test("petsciiToAscii maps letters, digits, control codes and unknown bytes", () => {
  assert.equal(petsciiToAscii(Uint8Array.of(0x48, 0x49, 0x20, 0x31)), "HI 1");
  assert.equal(petsciiToAscii(Uint8Array.of(0x0d, 0x11, 0x8d)), "\n\n\n");
  assert.equal(petsciiToAscii(Uint8Array.of(0xc1, 0xda, 0xa0, 0x00)), "AZ  ");
  assert.equal(petsciiToAscii(Uint8Array.of(0x07)), "\u0007");
  assert.equal(petsciiToAscii(Uint8Array.of(0x01, 0x93, 0xff, 0x7f)), "    ");
  assert.equal(petsciiToAscii(new Uint8Array(0)), "");
});

test("petsciiToScreenCode follows the KERNAL rule in every range and has none for control codes", () => {
  const cases = [
    [0x00, undefined], [0x1f, undefined], [0x20, 0x20], [0x3f, 0x3f], [0x40, 0x00], [0x41, 0x01], [0x5f, 0x1f], [0x60, 0x40], [0x7f, 0x5f],
    [0x80, undefined], [0x9f, undefined], [0xa0, 0x60], [0xbf, 0x7f], [0xc0, 0x40], [0xc1, 0x41], [0xfe, 0x7e], [0xff, 0x5e], [0x141, 0x01],
  ];
  for (const [petscii, expected] of cases) assert.equal(petsciiToScreenCode(petscii), expected, `$${petscii.toString(16)}`);
});

test("screenCodesToAscii: columns, rows and trimming options", () => {
  const hello = Uint8Array.from([8, 5, 12, 12, 15, 32, 32, 32, 1, 2, 32, 32]);
  assert.equal(screenCodesToAscii(hello, { columns: 8 }), "HELLO\nAB");
  assert.equal(screenCodesToAscii(hello, { columns: 8, trimTrailingSpaces: false }), "HELLO   \nAB  ");
  assert.equal(screenCodesToAscii(hello, { columns: 4, rows: 2 }), "HELL\nO");
  assert.equal(screenCodesToAscii(hello, { columns: 8, rows: 1 }), "HELLO");
  assert.equal(screenCodesToAscii(Uint8Array.from([32, 32, 32, 32, 1, 32, 32, 32]), { columns: 4 }), "\nA");
  assert.equal(screenCodesToAscii(Uint8Array.from([1, 32, 32, 32, 32, 32, 32, 32]), { columns: 4, trimTrailingEmptyRows: false }), "A\n");
  assert.equal(screenCodesToAscii(Uint8Array.from([1, 2]), { columns: 0 }), "AB");
  assert.equal(screenCodesToAscii(Uint8Array.from([1, 2]), { rows: 0 }), "AB");
  assert.equal(screenCodesToAscii(new Uint8Array(0)), "");
});

test("the assembler's .text directive and encodeStringWithNames agree on brace control codes", () => {
  const text = "{clear}{wht}HI{$0d}";
  assert.deepEqual(code(`  .text "${text}"`), [0x93, 0x05, 0x48, 0x49, 0x0d]);
  assert.deepEqual(bytes(text), [0x93, 0x05, 0x48, 0x49, 0x0d]);
  assert.equal(failure('  .text "{purple}{bogus}"').message, '(input):1: {bogus} is not a known control code (unknown control-code name); write \\x7b for a literal brace\n    .text "{purple}{bogus}"');
});
