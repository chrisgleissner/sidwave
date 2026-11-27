// Hand-authored GoatTracker song files, one per format family, built byte by byte from the file layout of
// GoatTracker 2.77 (src/gsong.c). Nothing here uses the SIDWave parser or writer.
const pad = (text, size) => { const out = new Array(size).fill(0); for (let i = 0; i < Math.min(size - 1, text.length); i++) out[i] = text.charCodeAt(i); return out; };
const C4 = 0x60 + 48;

/** Pattern rows as [note, instrument, command, data]; the end row is appended. */
export const MELODY = [
  [C4, 1, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 + 4, 1, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 + 7, 1, 0, 0], [0xbd, 0, 0, 0], [0xbe, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 + 12, 1, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
];
export const BASS = [
  [C4 - 24, 2, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 - 24, 2, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 - 19, 2, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
  [C4 - 24, 2, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0], [0xbd, 0, 0, 0],
];
const REST16 = Array.from({ length: 16 }, () => [0xbd, 0, 0, 0]);
/** Instrument 1: triangle lead with a vibrato-free wavetable; instrument 2: pulse bass with a pulse table. */
const INSTR = [
  { ad: 0x09, sr: 0xa4, wave: [[0x11, 0x00], [0xff, 0x00]], name: "lead" },
  { ad: 0x08, sr: 0x96, wave: [[0x41, 0x00], [0xff, 0x00]], name: "bass", pulse: true },
];
const flat = (rows) => rows.flatMap((r) => r);

/** GTS3, GTS4 and GTS5 share one layout. */
export function gts(magic = "GTS5") {
  const out = [...Buffer.from(magic, "latin1"), ...pad("Fixture", 32), ...pad("Tester", 32), ...pad("none", 32)];
  out.push(1); // one song
  for (const pattern of [0, 1, 2]) out.push(1 + 1, pattern, 0xff, 0x00); // length byte = entries + 1, entry, LOOPSONG, position
  out.push(2);
  // wave table: lead (2 entries), bass (2 entries); pulse table: set 0x0800, then jump to 0 (stop)
  const wave = [[0x11, 0x00], [0xff, 0x00], [0x41, 0x00], [0xff, 0x00]];
  const pulse = [[0x88, 0x00], [0xff, 0x00]];
  out.push(INSTR[0].ad, INSTR[0].sr, 1, 0, 0, 0, 0, 0x02, 0x11, ...pad("lead", 16));
  out.push(INSTR[1].ad, INSTR[1].sr, 3, 1, 0, 0, 0, 0x02, 0x41, ...pad("bass", 16));
  out.push(wave.length, ...wave.map((e) => e[0]), ...wave.map((e) => e[1]));
  out.push(pulse.length, ...pulse.map((e) => e[0]), ...pulse.map((e) => e[1]));
  out.push(0, 0); // empty filter and speed tables
  out.push(3);
  for (const rows of [MELODY, BASS, REST16]) { out.push(rows.length + 1, ...flat(rows), 0xff, 0, 0, 0); }
  return Buffer.from(out);
}

/** GTS2: three tables, the instrument layout has the vibrato delay before the speed value. */
export function gts2() {
  const out = [...Buffer.from("GTS2", "latin1"), ...pad("Fixture", 32), ...pad("Tester", 32), ...pad("none", 32)];
  out.push(1);
  for (const pattern of [0, 1, 2]) out.push(2, pattern, 0xff, 0x00);
  out.push(2);
  const wave = [[0x11, 0x00], [0xff, 0x00], [0x41, 0x00], [0xff, 0x00]];
  const pulse = [[0x88, 0x00], [0xff, 0x00]];
  // ad, sr, wave, pulse, filter, vibdelay, speed, gatetimer, firstwave, name
  out.push(INSTR[0].ad, INSTR[0].sr, 1, 0, 0, 0, 0, 0x02, 0x11, ...pad("lead", 16));
  out.push(INSTR[1].ad, INSTR[1].sr, 3, 1, 0, 0, 0, 0x02, 0x41, ...pad("bass", 16));
  out.push(wave.length, ...wave.map((e) => e[0]), ...wave.map((e) => e[1]));
  out.push(pulse.length, ...pulse.map((e) => e[0]), ...pulse.map((e) => e[1]));
  out.push(0);
  out.push(3);
  for (const rows of [MELODY, BASS, REST16]) { out.push(rows.length + 1, ...flat(rows), 0xff, 0, 0, 0); }
  return Buffer.from(out);
}

/** GTS!: 31 instruments with inline wavetables, three-byte pattern rows with notes counted from C-0 = 0, a 256-byte filter table. */
export function gts1() {
  const out = [...Buffer.from("GTS!", "latin1"), ...pad("Fixture", 32), ...pad("Tester", 32), ...pad("none", 32)];
  out.push(1);
  for (const pattern of [0, 1, 2]) out.push(2, pattern, 0xff, 0x00);
  for (let i = 1; i < 32; i++) {
    const def = INSTR[i - 1];
    if (!def) { out.push(0, 0, 0, 0, 0, 0, 0, 0, ...pad("", 16)); continue; }
    // ad, sr, pulse (0x80 with the no-hard-restart bit clear), pulseadd, limit low, limit high, filter pointer, wavetable bytes, name
    out.push(def.ad, def.sr, def.pulse ? 0x80 : 0, 0, 0, 0, 0, def.wave.length * 2, ...pad(def.name, 16), ...flat(def.wave));
  }
  out.push(3);
  for (const rows of [MELODY, BASS, REST16]) {
    const bytes = [];
    for (const [note, instr] of rows) {
      const old = note === 0xbd ? 0x5f : note === 0xbe ? 0x5e : note - 0x60;
      bytes.push(old, instr << 3, 0);
    }
    bytes.push(0xff, 0, 0);
    out.push(bytes.length, ...bytes);
  }
  out.push(...new Array(256).fill(0));
  return Buffer.from(out);
}

export const VERSIONS = { "GTS!": gts1, GTS2: gts2, GTS3: () => gts("GTS3"), GTS4: () => gts("GTS4"), GTS5: () => gts("GTS5") };
