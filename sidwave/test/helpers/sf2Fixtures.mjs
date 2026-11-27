// Hand-built SID Factory II files (driver 11.00 layout, no driver code): header blocks, tables, order lists and sequences.
export const L = { load: 0x0d7e, init: 0x1744, instr: 0x1784, cmd: 0x1844, hr: 0x1904, wave: 0x1924, pulse: 0x1b24, filter: 0x1e24, arp: 0x2124, tempo: 0x2224, oplo: 0x2324, ophi: 0x2327, seqlo: 0x232a, seqhi: 0x23aa, ol1: 0x242a, seq0: 0x272a };

const TABLES = [[0x81, 0, "Commands", L.cmd, 3, 64], [0x80, 1, "Instruments", L.instr, 6, 32], [0, 2, "Wave", L.wave, 2, 256], [0, 3, "Pulse", L.pulse, 3, 256], [0, 4, "Filter", L.filter, 3, 256],
  [0, 6, "Arp", L.arp, 1, 256], [0, 7, "Tempo", L.tempo, 1, 256], [0, 5, "HR", L.hr, 2, 16], [0, 8, "Init", L.init, 2, 32]];

/**
 * `tracks`: three lists of [transposition, sequence] (transposition in semitones), `sequences`: { n: Sf2Event[] } as the packer takes them
 * (but already packed here as bytes), `instruments`: { n: [ad, sr, flags, filter, pulse, wave] }, other tables as { row: [cols...] } (column values per row).
 */
export function sf2File({ tracks, sequences = {}, instruments = {}, wave = {}, pulse = {}, filter = {}, arp = {}, tempo = [5, 0x7f], cmds = {}, hr = { 0: [0x0f, 0x00] }, major = 11, minor = 0, loop = 0, tracksCount = 3, size = 0x3400 } = {}) {
  const m = new Uint8Array(0x10000);
  const ophi = L.oplo + tracksCount, seqlo = ophi + tracksCount, seqhi = seqlo + 128, ol1 = seqhi + 128, seq0 = ol1 + tracksCount * 256;
  const w = (a, v) => { m[a] = v & 255; m[a + 1] = v >> 8; };
  const text = (a, s) => { for (let i = 0; i < s.length; i++) m[a + i] = s.charCodeAt(i); m[a + s.length] = 0; return a + s.length + 1; };
  m[L.load] = 0x37; m[L.load + 1] = 0x13;
  let p = L.load + 2;
  // descriptor
  let q = p + 2;
  m[q] = 0; w(q + 1, 1860); q = text(q + 3, "Driver 11"); w(q, 0x1000); w(q + 2, 0x5f3); m[q + 4] = major; m[q + 5] = minor; m[q + 6] = 2; q += 7;
  m[p] = 1; m[p + 1] = q - p - 2; p = q;
  // driver common: init, stop, update then 15 more words
  m[p] = 2; m[p + 1] = 40; w(p + 2, 0x1000); w(p + 4, 0x1003); w(p + 6, 0x1006); p += 42;
  // tables
  q = p + 2;
  for (const [type, id, name, addr, cols, rows] of TABLES) { m[q] = type; m[q + 1] = id; m[q + 2] = 0; q = text(q + 3, name); m[q] = 1; m[q + 1] = 0; m[q + 2] = 255; m[q + 3] = 255; m[q + 4] = 255; w(q + 5, addr); w(q + 7, cols); w(q + 9, rows); m[q + 11] = 16; q += 12; }
  m[q++] = 0xff; m[p] = 3; m[p + 1] = q - p - 2; p = q;
  // instrument descriptor
  m[p] = 4; m[p + 1] = 2; m[p + 2] = 1; m[p + 3] = 0; p += 4;
  // music data
  m[p] = 5; m[p + 1] = 18; q = p + 2;
  m[q] = tracksCount; w(q + 1, L.oplo); w(q + 3, ophi); m[q + 5] = 128; w(q + 6, seqlo); w(q + 8, seqhi); w(q + 10, 256); w(q + 12, ol1); w(q + 14, 256); w(q + 16, seq0);
  p = q + 18;
  m[p++] = 0xff;
  for (let t = 0; t < tracksCount; t++) { const a = ol1 + t * 256; m[L.oplo + t] = a & 255; m[ophi + t] = a >> 8; }
  for (let n = 0; n < 128; n++) { const a = seq0 + n * 256; m[seqlo + n] = a & 255; m[seqhi + n] = a >> 8; m.set([0x80, 0x00, 0x7f], a); }
  tracks.forEach((entries, t) => {
    const out = []; let trans = 0;
    for (const [tr, seq] of entries) { if (tr !== trans || out.length === 0) { out.push(0xa0 + tr); trans = tr; } out.push(seq); }
    out.push(0xff, loop === 0 ? 0 : loop);
    m.set(out, ol1 + t * 256);
  });
  for (const [n, bytes] of Object.entries(sequences)) m.set(bytes, seq0 + Number(n) * 256);
  const cell = (addr, cols, rows, row, col, v) => { m[addr + col * rows + row] = v; };
  for (const [n, row] of Object.entries(instruments)) row.forEach((v, c) => cell(L.instr, 6, 32, Number(n), c, v));
  for (const [r, row] of Object.entries(wave)) row.forEach((v, c) => cell(L.wave, 2, 256, Number(r), c, v));
  for (const [r, row] of Object.entries(pulse)) row.forEach((v, c) => cell(L.pulse, 3, 256, Number(r), c, v));
  for (const [r, row] of Object.entries(filter)) row.forEach((v, c) => cell(L.filter, 3, 256, Number(r), c, v));
  for (const [r, row] of Object.entries(arp)) cell(L.arp, 1, 256, Number(r), 0, row);
  tempo.forEach((v, r) => cell(L.tempo, 1, 256, r, 0, v));
  for (const [r, row] of Object.entries(cmds)) row.forEach((v, c) => cell(L.cmd, 3, 64, Number(r), c, v));
  for (const [r, row] of Object.entries(hr)) row.forEach((v, c) => cell(L.hr, 2, 16, Number(r), c, v));
  cell(L.init, 2, 32, 0, 1, 0x0f);
  const end = Math.min(0x10000, L.load + size);
  const out = new Uint8Array(2 + end - L.load);
  out[0] = L.load & 255; out[1] = L.load >> 8;
  out.set(m.subarray(L.load, end), 2);
  return Buffer.from(out);
}

/** Packs a list of [instrument|null, note, command|null, tied] ticks into the sequence stream (one event per tick, no durations). */
export function seqBytes(events) {
  const out = [];
  let lastDur = -1;
  for (const [ins, note, cmd, tied] of events) {
    if (cmd != null) out.push(0xc0 | cmd);
    if (ins != null) out.push(0xa0 | ins);
    if (lastDur !== 0 || tied) { out.push(0x80 | (tied ? 0x10 : 0)); lastDur = 0; }
    out.push(note);
  }
  out.push(0x7f);
  return Uint8Array.from(out);
}

export function smallSf2(extra = {}) {
  const lead = seqBytes([[0, 0x30], [null, 0x7e], [null, 0x34], [null, 0x7e], [null, 0x37], [null, 0x7e], [null, 0x3c], [null, 0]]);
  const bass = seqBytes([[1, 0x18], [null, 0x7e], [null, 0x7e], [null, 0x7e], [null, 0x18], [null, 0x7e], [null, 0x1f], [null, 0]]);
  return sf2File({
    tracks: [[[0, 1], [0, 1]], [[0, 2], [0, 2]], [[0, 0], [0, 0]]],
    sequences: { 1: lead, 2: bass },
    instruments: { 0: [0x08, 0xa5, 0x80, 0, 1, 0], 1: [0x0a, 0x89, 0x00, 0, 0, 2] },
    wave: { 0: [0x41, 0], 1: [0x7f, 0], 2: [0x21, 0], 3: [0x7f, 2] },
    pulse: { 1: [0x88, 0x00, 0x01], 2: [0x7f, 0, 2] },
    ...extra,
  });
}
