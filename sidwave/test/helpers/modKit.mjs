// Hand-built MOD files for the importer tests. Every byte is written here from the ProTracker module format description;
// no third-party module is used. Samples are synthesised: sine, square, saw, noise and decaying drums.

/** Period of a MIDI note at finetune 0 (428 = MIDI 48). */
export const periodOf = (midi) => Math.round(428 * 2 ** ((48 - midi) / 12));

const wave = (kind, length, cycle = 32) => {
  const out = new Int8Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    const ph = (i % cycle) / cycle;
    if (kind === "sine") out[i] = Math.round(100 * Math.sin(2 * Math.PI * ph));
    else if (kind === "square") out[i] = ph < 0.5 ? 100 : -100;
    else if (kind === "saw") out[i] = Math.round(200 * ph - 100);
    else if (kind === "triangle") out[i] = Math.round(ph < 0.5 ? 400 * ph - 100 : 300 - 400 * ph);
    else if (kind === "noise") { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = ((seed >> 8) & 0xff) - 128; }
    else if (kind === "hat") { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = Math.round((((seed >> 8) & 0xff) - 128) * Math.exp(-i / (length / 5))); }
    else if (kind === "kick") out[i] = Math.round(120 * Math.exp(-i / (length / 4)) * Math.sin(2 * Math.PI * i * (0.03 + 0.1 * Math.exp(-i / 200)) ));
    else if (kind === "snare") { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = Math.round((((seed >> 8) & 0xff) - 128) * Math.exp(-i / (length / 3))); }
  }
  return out;
};

export const SAMPLES = {
  sine: { name: "sine lead", data: wave("sine", 64, 32), volume: 64, loop: [0, 64] },
  square: { name: "square", data: wave("square", 64, 32), volume: 48, loop: [0, 64] },
  saw: { name: "saw bass", data: wave("saw", 64, 32), volume: 64, loop: [0, 64] },
  kick: { name: "bd", data: wave("kick", 2400), volume: 64 },
  snare: { name: "snare", data: wave("snare", 2000), volume: 56 },
  hat: { name: "hh", data: wave("hat", 600), volume: 40 },
  noise: { name: "wind", data: wave("noise", 1024), volume: 40 },
};

/**
 * Builds a MOD. `patterns[p][row]` is an array with one cell per channel: `{ note (MIDI), period, sample, fx, param }`
 * (missing fields are zero). `variant` is the signature at offset 1080 (omit for the 15-sample layout).
 */
export function buildMod({ title = "TEST MOD", variant = "M.K.", channels = 4, samples = [], orders = [0], patterns, restart = 127, finetune = {} }) {
  const fifteen = variant === null;
  const count = fifteen ? 15 : 31;
  const flt8 = variant === "FLT8";
  const stored = flt8 ? patterns.length * 2 : patterns.length;
  const blockChannels = flt8 ? 4 : channels;
  const header = fifteen ? 600 : 1084;
  const dataLength = samples.reduce((t, s) => t + (s ? s.data.length - (s.data.length % 2) : 0), 0);
  const out = new Uint8Array(header + stored * 64 * blockChannels * 4 + dataLength);
  for (let i = 0; i < Math.min(20, title.length); i++) out[i] = title.charCodeAt(i);
  for (let s = 0; s < count; s++) {
    const smp = samples[s];
    const at = 20 + s * 30;
    if (!smp) continue;
    for (let i = 0; i < Math.min(22, smp.name.length); i++) out[at + i] = smp.name.charCodeAt(i);
    const words = smp.data.length >> 1;
    out[at + 22] = words >> 8; out[at + 23] = words & 255;
    out[at + 24] = (finetune[s] ?? 0) & 15;
    out[at + 25] = smp.volume ?? 64;
    const [ls, ll] = smp.loop ?? [0, 2];
    out[at + 26] = (ls >> 1) >> 8; out[at + 27] = (ls >> 1) & 255;
    out[at + 28] = (ll >> 1) >> 8; out[at + 29] = (ll >> 1) & 255;
  }
  const la = 20 + count * 30;
  out[la] = orders.length; out[la + 1] = restart;
  for (let i = 0; i < orders.length; i++) out[la + 2 + i] = flt8 ? orders[i] * 2 : orders[i];
  if (!fifteen) for (let i = 0; i < 4; i++) out[1080 + i] = variant.charCodeAt(i);
  patterns.forEach((rows, p) => {
    for (let r = 0; r < 64; r++) {
      const row = rows[r] ?? [];
      for (let c = 0; c < channels; c++) {
        const cell = row[c] ?? {};
        const period = cell.period ?? (cell.note !== undefined ? periodOf(cell.note) : 0);
        const sample = cell.sample ?? 0;
        const block = flt8 ? c >> 2 : 0;
        const cc = flt8 ? c & 3 : c;
        const at = header + ((flt8 ? p * 2 + block : p) * 64 + r) * blockChannels * 4 + cc * 4;
        out[at] = (fifteen ? 0 : sample & 0xf0) | (period >> 8);
        out[at + 1] = period & 255;
        out[at + 2] = ((sample & 15) << 4) | ((cell.fx ?? 0) & 15);
        out[at + 3] = cell.param ?? 0;
      }
    }
  });
  let at = header + stored * 64 * blockChannels * 4;
  for (const smp of samples) {
    if (!smp) continue;
    const n = smp.data.length - (smp.data.length % 2);
    for (let i = 0; i < n; i++) out[at + i] = smp.data[i] & 255;
    at += n;
  }
  return out;
}

/** A pattern with the given per-channel note lists, one note every `step` rows starting at row 0. */
export function pattern(channelNotes, step = 4) {
  const rows = Array.from({ length: 64 }, () => []);
  channelNotes.forEach((notes, c) => {
    notes.forEach((cell, k) => {
      if (!cell) return;
      const r = k * step;
      if (r < 64) { rows[r][c] = { ...cell }; }
    });
  });
  return rows.map((row) => Array.from({ length: channelNotes.length }, (_, c) => row[c] ?? {}));
}

const C = (note, sample, extra = {}) => ({ note, sample, ...extra });

/** Four-channel song: bass (saw), lead (sine), harmony (square), drums (kick, hat, snare), two patterns, speed 6 / 125 BPM. */
export function songFourChannel() {
  const samples = [SAMPLES.saw, SAMPLES.sine, SAMPLES.square, SAMPLES.kick, SAMPLES.hat, SAMPLES.snare];
  const bass = [36, 0, 43, 0, 36, 0, 41, 0, 36, 0, 43, 0, 38, 0, 41, 0].map((n) => (n ? C(n, 1) : null));
  const lead = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72, 71, 67, 64, 60].map((n) => C(n, 2));
  const harm = [52, null, 55, null, 52, null, 57, null, 52, null, 55, null, 55, null, 52, null].map((n) => (n ? C(n, 3) : null));
  const drums = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 5].map((s, i) => C(48, s));
  const p0 = pattern([bass, lead, harm, drums], 4);
  const p1 = pattern([bass.map((c) => (c ? { ...c, note: c.note + 5 } : c)), lead.map((c) => ({ ...c, note: c.note - 2 })), harm, drums], 4);
  return buildMod({ title: "FOUR CHANNEL", samples, orders: [0, 1, 0, 1], patterns: [p0, p1] });
}

/** Two channels of effects (channel 1 mapped effects, channel 2 effects the importer does not map), speed and tempo changes, a jump. */
export function songEffects() {
  const samples = [SAMPLES.sine, SAMPLES.saw];
  const rows = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  const put = (r, c, cell) => { rows[r][c] = { ...rows[r][c], ...cell }; };
  put(0, 0, { note: 48, sample: 1, fx: 0, param: 0x47 });
  for (const r of [1, 2, 3]) put(r, 0, { fx: 0, param: 0x47 });
  put(4, 0, { note: 52, sample: 1, fx: 1, param: 0x04 });
  for (const r of [5, 6, 7]) put(r, 0, { fx: 1, param: 0x04 });
  put(8, 0, { note: 55, sample: 1, fx: 2, param: 0x04 });
  for (const r of [9, 10, 11]) put(r, 0, { fx: 2, param: 0x04 });
  put(12, 0, { note: 48, sample: 1 });
  put(16, 0, { note: 55, fx: 3, param: 0x10 });
  for (const r of [17, 18, 19]) put(r, 0, { fx: 3, param: 0 });
  put(20, 0, { note: 48, sample: 1, fx: 4, param: 0x46 });
  for (const r of [21, 22, 23]) put(r, 0, { fx: 4, param: 0 });
  put(24, 0, { note: 48, sample: 1, fx: 0xa, param: 0x04 });
  for (const r of [25, 26, 27]) put(r, 0, { fx: 0xa, param: 0x04 });
  put(28, 0, { note: 50, sample: 1, fx: 0xc, param: 0x20 });
  put(32, 0, { note: 52, sample: 1, fx: 0xe, param: 0x12 });
  put(36, 0, { note: 53, sample: 1, fx: 0xe, param: 0xc2 });
  put(40, 0, { note: 55, sample: 1, fx: 0xe, param: 0xd3 });
  put(44, 0, { note: 57, sample: 1 });
  put(48, 0, { note: 55, sample: 1, fx: 0xf, param: 0x04 });
  put(56, 0, { note: 53, sample: 1, fx: 0xf, param: 0x06 });
  // Channel 2: effects with no SIDWave equivalent.
  put(0, 1, { note: 36, sample: 2, fx: 7, param: 0x44 });
  put(8, 1, { note: 38, sample: 2, fx: 8, param: 0x80 });
  put(16, 1, { note: 40, sample: 2, fx: 9, param: 0x01 });
  put(24, 1, { note: 41, sample: 2, fx: 0xe, param: 0x42 });
  put(32, 1, { note: 43, sample: 2, fx: 0xe, param: 0x52 });
  put(40, 1, { note: 45, sample: 2, fx: 0xe, param: 0x93 });
  put(48, 1, { note: 47, sample: 2, fx: 0xe, param: 0xf2 });
  const p1 = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
  p1[0][0] = { note: 60, sample: 1 };
  p1[4][0] = { note: 62, sample: 1 };
  p1[8][0] = { note: 64, sample: 1, fx: 0xb, param: 0 };
  return buildMod({ title: "EFFECTS", samples, orders: [0, 1], patterns: [rows, p1] });
}

/** A short two-note song in the given layout, for the variant tests. */
export function songVariant(variant, channels, melodicSample = SAMPLES.sine) {
  const rows = Array.from({ length: 64 }, () => Array.from({ length: channels }, () => ({})));
  for (let c = 0; c < channels; c++) {
    rows[0][c] = { note: 36 + 7 * c, sample: 1 };
    rows[16][c] = { note: 40 + 7 * c, sample: 1 };
  }
  return buildMod({ title: `VARIANT ${variant}`, variant, channels, samples: [melodicSample], orders: [0], patterns: [rows] });
}

/** A large 4-channel song: `patternCount` distinct patterns of 64 rows (a note every second row), 31 samples of 4 KB, a pseudo-random score. */
export function songLarge(patternCount = 64) {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const kinds = ["sine", "square", "saw", "triangle", "noise", "kick", "snare", "hat"];
  const samples = Array.from({ length: 31 }, (_, i) => {
    const kind = kinds[i % kinds.length];
    const data = kind === "sine" || kind === "square" || kind === "saw" || kind === "triangle" ? wave(kind, 4096, 32 + (i % 5) * 8) : wave(kind, 4096);
    return { name: `s${i}`, data, volume: 40 + (i % 25), ...(["sine", "square", "saw", "triangle"].includes(kind) ? { loop: [0, 4096] } : {}) };
  });
  const patterns = [];
  for (let p = 0; p < patternCount; p++) {
    const rows = Array.from({ length: 64 }, () => [{}, {}, {}, {}]);
    for (let r = 0; r < 64; r += 2) for (let c = 0; c < 4; c++) {
      if (rnd(3) === 0) continue;
      const fx = rnd(6);
      rows[r][c] = { note: 36 + rnd(30), sample: 1 + rnd(31), ...(fx === 0 ? { fx: 0, param: 0x37 } : fx === 1 ? { fx: 4, param: 0x34 } : fx === 2 ? { fx: 0xa, param: 0x02 } : {}) };
    }
    patterns.push(rows);
  }
  return buildMod({ title: "LARGE", samples, orders: Array.from({ length: Math.min(128, patternCount) }, (_, i) => i), patterns });
}

/** The committed fixtures: file name to bytes. `test/interchangeMod.test.mjs` checks the files against these. */
export const MOD_FIXTURES = () => ({
  "four-channel.mod": songFourChannel(),
  "effects.mod": songEffects(),
  "fifteen-sample.mod": songVariant(null, 4),
  "flt8.mod": songVariant("FLT8", 8),
});
