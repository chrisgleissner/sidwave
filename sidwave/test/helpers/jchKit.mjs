// A hand-built JCH NewPlayer 20.G editor image: the $0F00 page with the pointer block and the version mark, and the data
// tables at fixed addresses. The player code is not included (it is third-party code), so the image parses and imports but
// does not play. Layout from the published description of the editor format.

const A = { wave: 0x1800, filter: 0x1a00, pulse: 0x1b00, inst: 0x1c00, seqLo: 0x1d00, seqHi: 0x1e00, cmd: 0x1f00, ol: [0x2000, 0x2400, 0x2800], init: 0x1100, seq: 0x2c00, name: 0x1110 };

/** `sequences[i]` is a list of [byte0, note]; `lists[v]` a list of [transposeByte, sequence]. */
export function buildJch({ tempo = 5, groove = [4, 3], instruments = [], wave = [], pulse = [], commands = [], lists, sequences, version = "20.G4", name = "HAND BUILT" } = {}) {
  const end = 0x3200;
  const mem = new Uint8Array(end);
  const w = (a, v) => { mem[a] = v & 255; mem[a + 1] = v >> 8; };
  w(0xfa4, A.name - 1); w(0xfa6, A.init); w(0xfbc, A.wave); w(0xfc0, A.filter); w(0xfc2, A.pulse); w(0xfc4, A.inst);
  w(0xfc6, A.ol[0]); w(0xfc8, A.ol[1]); w(0xfca, A.ol[2]); w(0xfcc, A.seqLo); w(0xfce, A.seqHi); w(0xfd0, A.cmd);
  for (let i = 0; i < version.length; i++) mem[0xfee + i] = version.charCodeAt(i);
  mem[A.init + 6] = tempo;
  for (let i = 0; i < name.length; i++) mem[A.name + i] = name.charCodeAt(i);
  groove.forEach((g, i) => { mem[A.filter + i] = g; });
  instruments.forEach((inst, i) => inst.forEach((b, k) => { mem[A.inst + i * 8 + k] = b; }));
  wave.forEach(([note, ctrl], i) => { mem[A.wave + i] = note; mem[A.wave + 256 + i] = ctrl; });
  pulse.forEach((b, i) => { mem[A.pulse + i] = b; });
  commands.forEach(([a, b], i) => { mem[A.cmd + i] = a; mem[A.cmd + 32 + i] = b; });
  lists.forEach((list, v) => { list.forEach(([t, s], i) => { mem[A.ol[v] + 2 * i] = t; mem[A.ol[v] + 2 * i + 1] = s; }); mem[A.ol[v] + 2 * list.length] = 0xff; });
  let at = A.seq;
  sequences.forEach((events, i) => {
    mem[A.seqLo + i] = at & 255; mem[A.seqHi + i] = at >> 8;
    for (const [b0, note] of events) { mem[at++] = b0; mem[at++] = note; }
    mem[at++] = 0x7f; mem[at++] = 0;
  });
  const out = new Uint8Array(2 + end - 0xf00);
  out[0] = 0x00; out[1] = 0x0f;
  out.set(mem.subarray(0xf00), 2);
  return out;
}

const rest = [0x80, 0x00], hold = [0x80, 0x7e];
/** Two voices: a triangle lead with an arpeggio wave table and a pulse bass with a pulse sweep, a tempo command and a vibrato. */
export function handBuilt() {
  const lead = [[0xa0, 0x24], hold, hold, hold, [0xa0, 0x28], hold, [0x90, 0x2b], hold, rest, rest, [0xc0, 0x2f], hold, [0xa0, 0x24], hold, rest, rest];
  const bass = [[0xa1, 0x0c], hold, [0xa1, 0x10], hold, [0xa1, 0x13], hold, [0xa1, 0x0c], hold, [0xc1, 0x0c], hold, [0xc2, 0x10], hold, [0xc3, 0x13], hold, rest, rest];
  return buildJch({
    tempo: 5,
    instruments: [[0x09, 0xa8, 0x80, 0, 0, 0, 0, 0x00], [0x05, 0x69, 0x80, 0, 0, 0x04, 0, 0x04]],
    wave: [[0x00, 0x11], [0x7f, 0x00], [0, 0], [0, 0], [0x00, 0x41], [0x7e, 0x00]],
    pulse: [0, 0, 0, 0, 0x08, 0x10, 0x20, 0x04],
    commands: [[0x60, 0x34], [0x90, 0x00], [0xe0, 0x04], [0x80, 0x10]],
    lists: [[[0x80, 0], [0x88, 0]], [[0x80, 1], [0x80, 1]], []],
    sequences: [lead, bass],
  });
}
