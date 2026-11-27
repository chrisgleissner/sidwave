// Hand assembly of SID-Wizard files from the layout in SWM-spec.src, independent of the library's writer.
export const instrumentBytes = ({ ad = 0x09, sr = 0xa9, wave = 0x41, pulse, name = "TEST", ctrl = 0x1a } = {}) => {
  const wf = [wave, 0, 0, 0xff];
  const pw = pulse === undefined ? [0xff] : [0x80 | (pulse >> 8), pulse & 0xff, 0, 0xff];
  const data = [ctrl, 0x0f, 0, ad, sr, 0, 0, 0, 1, 0, 16 + wf.length, 16 + wf.length + pw.length, 0, 0, 0, 0x09, ...wf, ...pw];
  return { data, name: name.padEnd(8, " ") };
};

/** patterns: { packed: bytes in the file, unpacked: bytes before NOP packing, rows }. */
export function buildSwm({ magic = "SWM1", speed = 1, seqs, patterns, instruments, chords = [0, 0x7f], tempo = [], subtunes = [[0x86, 0x83]], author = "TESTER:TEST TUNE", defaultLength = 32, load = [0x33, 0x33] }) {
  const header = new Array(64).fill(0);
  [...magic].forEach((c, i) => { header[i] = c.charCodeAt(0); });
  header[4] = speed; header[5] = 4; header[8] = header[9] = header[10] = 0xff; header[11] = defaultLength;
  header[12] = seqs.length; header[13] = patterns.length; header[14] = instruments.length; header[15] = chords.length; header[16] = tempo.length;
  const text = author.padEnd(40, " ");
  [...text].forEach((c, i) => { header[24 + i] = c.charCodeAt(0); });
  const out = [...load, ...header];
  for (const s of seqs) out.push(...s, s.length);
  for (const p of patterns) out.push(...p.packed, p.unpacked + 1, p.rows);
  for (const i of instruments) out.push(...i.data, i.data.length, ...[...i.name].map((c) => c.charCodeAt(0)));
  out.push(...chords, ...tempo);
  for (const [a, b] of subtunes) out.push(a, b);
  return Uint8Array.from(out);
}

export function buildSwi({ instrument, load = [0x33, 0x33] }) {
  return Uint8Array.from([...load, ...instrument.data, instrument.data.length, ...[...instrument.name].map((c) => c.charCodeAt(0))]);
}

// Two patterns. P1: C-4 with instrument 1, five-and-one NOP rows (zero byte plus packed byte $73 = 5 rows), gate off.
// P2: E-4 with instrument 2 and big effect $10 (set main single tempo 6), then a zero byte and packed byte $74 (6 rows).
export const P1 = { packed: [0xb1, 0x01, 0x00, 0x73, 0x7e], unpacked: 2 + 6 + 1, rows: 8 };
export const P2 = { packed: [0xb5, 0x82, 0x10, 0x06, 0x00, 0x74], unpacked: 4 + 7, rows: 8 };
export const HAND = () => buildSwm({
  seqs: [[0x01, 0x02, 0xff, 0x00], [0x02, 0x01, 0xff, 0x00], [0xfe]],
  patterns: [P1, P2],
  instruments: [instrumentBytes({ name: "LEAD", wave: 0x41, ad: 0x09, sr: 0xa9 }), instrumentBytes({ name: "PULSE", wave: 0x41, pulse: 0x800, ad: 0x08, sr: 0xa8 })],
});
export const HAND_SWS = () => buildSwm({
  magic: "SWMS",
  seqs: [[0x01, 0xff, 0x00], [0x02, 0xff, 0x00], [0xfe], [0x02, 0xff, 0x00], [0x01, 0xff, 0x00], [0xfe]],
  patterns: [P1, P2],
  instruments: [instrumentBytes({ name: "LEAD" }), instrumentBytes({ name: "PULSE", pulse: 0x800 })],
  subtunes: [[0x86, 0x83]],
});
export const HAND_SWI = () => buildSwi({ instrument: instrumentBytes({ name: "PIANO", wave: 0x41, pulse: 0x600, ad: 0x07, sr: 0xa5 }) });
