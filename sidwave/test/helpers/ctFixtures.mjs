// Hand-built CheeseCutter 2.x files. They hold song data only: the importer does not need the player, so no player
// bytes are committed. Tables sit at the addresses CheeseCutter's own player uses.
import { deflateSync } from "node:zlib";

export const A = { songsets: 0x2000, track1: 0x2200, track2: 0x2600, track3: 0x2a00, seqlo: 0x2e00, seqhi: 0x2e80, seq0: 0x2f00, arp1: 0xaf00, arp2: 0xb000, filt: 0xb400, puls: 0xb500, inst: 0xb100, cmd1: 0xb300, chord: 0xb600, chordIndex: 0xb680, editor: 0x0e02 };

/** Pointer table order (the 96 words at $0FA0), only the entries the importer reads are meaningful. */
function pointers() {
  const p = new Array(96).fill(0x1862);
  Object.assign(p, { 0: 0xe00, 2: A.editor, 3: A.songsets, 14: A.arp1, 15: A.arp2, 16: A.filt, 17: A.puls, 18: A.inst, 19: A.track1, 20: A.track2, 21: A.track3, 22: A.seqlo, 23: A.seqhi, 24: A.cmd1, 26: 0x193c, 30: A.chord, 32: A.chordIndex });
  return p;
}

/** Order list bytes: pairs of (transposition, sequence); the list ends with a wrap marker to entry `loop`. */
export function orderList(entries, loop = 0) {
  const b = new Uint8Array(1024);
  for (let i = 0; i < 512; i++) { b[i * 2] = 0xf0; b[i * 2 + 1] = 0; }
  entries.forEach(([trans, seq], i) => { b[i * 2] = 0xa0 + trans; b[i * 2 + 1] = seq; });
  b[entries.length * 2] = 0xf0; b[entries.length * 2 + 1] = (loop * 2) & 0xff;
  return b;
}

/** Four-byte editor rows of one sequence: [{ note, inst, cmd, tied }] with note values 0 hold, 1 gate off, 3.. a note. */
export function rowsToSequence(rows) {
  const b = new Uint8Array(256);
  rows.forEach((r, i) => { b[i * 4] = r.inst === undefined ? 0xf0 : 0xc0 + r.inst; b[i * 4 + 1] = r.tied ? 0x5f : 0xf0; b[i * 4 + 2] = 0x60 + r.note; b[i * 4 + 3] = r.cmd ?? 0; });
  if (rows.length < 64) b[rows.length * 4] = 0xbf;
  return b;
}

/**
 * Builds an inflated .ct image.
 * `sequences`: { number: Uint8Array(256) }, `orders`: three order lists, `instruments`: { number: [ad, sr, hr, hrWave, filter, pulse, hrSr, wave] },
 * `wave`: [[arp1, arp2], ...] from row 1, `pulse`/`filter`: lists of 4-byte entries from entry 1, `chord`: bytes.
 */
export function ctInflated({ sequences = {}, orders, instruments = {}, wave = [], pulse = [], filter = [], chord = [], chordIndex = [], cmds = {}, speed = 5, multiplier = 1, clock = 0, title = "Fixture", author = "Tester", version = 12, subtunes } = {}) {
  const d = new Uint8Array(300_000);
  const p = pointers();
  p.forEach((w, i) => { d[0xfa0 + i * 2] = w & 255; d[0xfa0 + i * 2 + 1] = w >> 8; });
  for (let n = 0; n < 128; n++) {
    const at = A.seq0 + n * 256;
    d[A.seqlo + n] = at & 255; d[A.seqhi + n] = at >> 8;
    d.set([0xf0, 0xf0, 0x60, 0x00, 0xbf], at);
  }
  for (const [n, seq] of Object.entries(sequences)) d.set(seq, A.seq0 + Number(n) * 256);
  for (const [n, row] of Object.entries(instruments)) row.forEach((v, c) => { d[A.inst + c * 48 + Number(n)] = v; });
  wave.forEach(([a, b], i) => { d[A.arp1 + 1 + i] = a; d[A.arp2 + 1 + i] = b; });
  d.set([0x7f, 0x00, 0xff, 0x7f], A.puls); d.set([0x7f, 0x00, 0xff, 0x7f], A.filt);
  pulse.forEach((e, i) => d.set(e, A.puls + 4 + i * 4));
  filter.forEach((e, i) => d.set(e, A.filt + 4 + i * 4));
  for (const [r, row] of Object.entries(cmds)) row.forEach((v, c) => { d[A.cmd1 + c * 64 + Number(r)] = v; });
  d.set(chord, A.chord); d.set(chordIndex, A.chordIndex);
  let o = 65536;
  d[o++] = version; d[o++] = clock; d[o++] = multiplier; d[o++] = 1; d[o++] = 0;
  for (let i = 0; i < 32; i++) d[o++] = speed;
  d[o++] = 4; d[o++] = 0;
  const text = (s, at) => { for (let i = 0; i < 32; i++) d[at + i] = i < s.length ? s.charCodeAt(i) : 0x20; };
  text(title, 65536 + 261); text(author, 65536 + 261 + 32); text("2026", 65536 + 261 + 64);
  const subs = subtunes ?? [orders];
  const base = 65536 + 261 + 160 + 2048;
  for (let s = 0; s < 32; s++) for (let v = 0; v < 3; v++) d.set(s < subs.length ? subs[s][v] : orderList([[0, 0]].slice(0, 0)).fill(0).map((_, i) => (i % 2 === 0 ? (i === 0 ? 0xa0 : 0xf0) : 0)), base + (s * 3 + v) * 1024);
  return d;
}

export const ctFile = (inflated) => Buffer.concat([Buffer.from("CC2"), deflateSync(inflated)]);

/** Small song: voice 1 plays C-4 E-4 G-4 C-5 (instrument 0, a pulse program and a wave program), voice 2 a bass, voice 3 silent. */
export function smallSong(extra = {}) {
  const seq1 = rowsToSequence([{ note: 36, inst: 0 }, { note: 0 }, { note: 40, inst: 0 }, { note: 0 }, { note: 43, inst: 0 }, { note: 0 }, { note: 48, inst: 0 }, { note: 1 }]);
  const seq2 = rowsToSequence([{ note: 24, inst: 1 }, { note: 0 }, { note: 0 }, { note: 0 }, { note: 24, inst: 1 }, { note: 0 }, { note: 31, inst: 1 }, { note: 1 }]);
  return ctInflated({
    sequences: { 1: seq1, 2: seq2 },
    orders: [orderList([[0, 1], [0, 1]]), orderList([[0, 2], [0, 2]]), orderList([[0, 0], [0, 0]])],
    // AD, SR, restart type, restart wave, filter, pulse, restart SR, wave pointer
    instruments: { 0: [0x08, 0xa5, 0x80, 0x41, 0, 1, 0, 1], 1: [0x0a, 0x89, 0x00, 0x21, 0, 0, 0, 3] },
    wave: [[0x00, 0x41], [0x7e, 0x00], [0x00, 0x21], [0x7e, 0x00]],
    pulse: [[0x20, 0x08, 0x88, 0x7f]],
    ...extra,
  });
}
