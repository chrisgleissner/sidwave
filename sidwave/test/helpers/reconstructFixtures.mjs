// Synthetic SID players for the reconstruction tests. Each player is a small 6502 program, written here as
// assembly source and assembled with 6502-toolkit. None of them is produced by SIDWave. Each one exercises a
// single feature and writes at least one register in every call, so that every player call is visible in a trace.
//
// The tables below are the single source of truth for the register values: the players read them as data, and
// the tests derive the expected register state from the same tables.
import { assemblyToPrgDetailed } from "6502-toolkit/assembler";
import { writeSidFile } from "../../src/sidFile.ts";

export const LOAD = 0x1000;

/** Frequency register values used by the pitch fixtures (hypothetical notes; only the register values matter). */
export const TABLES = {
  hardRestartNotes: [0x1167, 0x15e8],
  arpeggio: [0x1167, 0x15e8, 0x1a9c],
  vibratoBase: 0x1167,
  vibratoOffsets: [0, 6, 10, 6, 0, -6, -10, -6],
  ringVoice3: [0x0e00, 0x0e40, 0x0e90, 0x0ee0],
};

const lo = (table) => table.map((v) => `$${(v & 0xff).toString(16).padStart(2, "0")}`).join(",");
const hi = (table) => table.map((v) => `$${((v >> 8) & 0xff).toString(16).padStart(2, "0")}`).join(",");

/** Clears $D400-$D418 and zero page $FB-$FE, then the fixture-specific init code, then sets volume 15. */
function prologue(extra = "", { volume = "$0f", secondSid = false } = {}) {
  return `
        .org $1000
init:   ldx #$18
        lda #0
clr:    sta $d400,x
${secondSid ? "        sta $d420,x\n" : ""}        dex
        bpl clr
        sta $fb
        sta $fc
        sta $fd
        sta $fe
${extra}
        lda #${volume}
        sta $d418
        rts
`;
}

const vibrato = TABLES.vibratoOffsets.map((o) => TABLES.vibratoBase + o);

export const FIXTURE_DEFS = {
  hardRestart: {
    feature: "hard restart: gate off and test bit with cleared ADSR before each note, six calls per note",
    asm:
      prologue(`
        lda #$00
        sta $d402
        lda #$08
        sta $d403`) +
      `
play:   ldy $fc
        lda freqlo,y
        sta $d400
        lda freqhi,y
        sta $d401
        ldx $fb
        bne p1
        lda #$09
        sta $d405
        lda #$a0
        sta $d406
        lda #$41
        sta $d404
        jmp done
p1:     cpx #4
        bne p2
        lda #$40
        sta $d404
        jmp done
p2:     cpx #5
        bne done
        lda #$00
        sta $d405
        sta $d406
        lda #$08
        sta $d404
        lda $fc
        eor #1
        sta $fc
done:   inx
        cpx #6
        bne store
        ldx #0
store:  stx $fb
        rts
freqlo: .byte ${lo(TABLES.hardRestartNotes)}
freqhi: .byte ${hi(TABLES.hardRestartNotes)}
`,
  },
  arpeggio: {
    feature: "arpeggio: voice 1 cycles through three frequencies, one per call",
    asm:
      prologue(`
        lda #$09
        sta $d405
        lda #$f0
        sta $d406
        lda #$11
        sta $d404`) +
      `
play:   ldx $fb
        lda arplo,x
        sta $d400
        lda arphi,x
        sta $d401
        inx
        cpx #3
        bne store
        ldx #0
store:  stx $fb
        rts
arplo:  .byte ${lo(TABLES.arpeggio)}
arphi:  .byte ${hi(TABLES.arpeggio)}
`,
  },
  vibrato: {
    feature: "vibrato: voice 1 frequency follows an eight-entry triangle table around a base",
    asm:
      prologue(`
        lda #$09
        sta $d405
        lda #$f0
        sta $d406
        lda #$11
        sta $d404`) +
      `
play:   ldx $fb
        lda viblo,x
        sta $d400
        lda vibhi,x
        sta $d401
        inx
        cpx #8
        bne store
        ldx #0
store:  stx $fb
        rts
viblo:  .byte ${lo(vibrato)}
vibhi:  .byte ${hi(vibrato)}
`,
  },
  pulseSweep: {
    feature: "pulse sweep: the 12-bit pulse width of voice 1 grows by $40 per call, starting at $0200",
    asm:
      prologue(`
        lda #$02
        sta $fd
        lda #$67
        sta $d400
        lda #$11
        sta $d401
        lda #$09
        sta $d405
        lda #$f0
        sta $d406
        lda #$41
        sta $d404`) +
      `
play:   lda $fc
        sta $d402
        lda $fd
        sta $d403
        clc
        lda $fc
        adc #$40
        sta $fc
        lda $fd
        adc #0
        and #$0f
        sta $fd
        rts
`,
  },
  filterSweep: {
    feature: "filter sweep: the cutoff high byte of the low-pass filter grows by 3 per call, voice 1 routed",
    asm:
      prologue(
        `
        lda #$10
        sta $fc
        lda #$f1
        sta $d417
        lda #$67
        sta $d400
        lda #$11
        sta $d401
        lda #$09
        sta $d405
        lda #$f0
        sta $d406
        lda #$21
        sta $d404`,
        { volume: "$1f" },
      ) +
      `
play:   lda #0
        sta $d415
        lda $fc
        sta $d416
        clc
        adc #3
        sta $fc
        rts
`,
  },
  sync: {
    feature: "hard sync: voice 1 (sawtooth, sync bit, control rewritten every call) is synchronised to a fixed voice 3 while its frequency low byte steps by $18",
    asm:
      prologue(`
        lda #$0b
        sta $d40e
        lda #$04
        sta $d40f
        lda #$f0
        sta $d406
        sta $d414
        lda #$11
        sta $d412
        lda #$23
        sta $d404`) +
      `
play:   lda $fc
        clc
        adc #$18
        sta $fc
        sta $d400
        lda #$08
        sta $d401
        lda #$23
        sta $d404
        rts
`,
  },
  ring: {
    feature: "ring modulation: voice 1 (triangle, ring bit, control rewritten every call) is modulated by voice 3 whose frequency cycles through four values",
    asm:
      prologue(`
        lda #$67
        sta $d400
        lda #$11
        sta $d401
        lda #$f0
        sta $d406
        sta $d414
        lda #$11
        sta $d412
        lda #$15
        sta $d404`) +
      `
play:   lda #$15
        sta $d404
        ldx $fb
        lda ringlo,x
        sta $d40e
        lda ringhi,x
        sta $d40f
        inx
        cpx #4
        bne store
        ldx #0
store:  stx $fb
        rts
ringlo: .byte ${lo(TABLES.ringVoice3)}
ringhi: .byte ${hi(TABLES.ringVoice3)}
`,
  },
  multispeed: {
    feature: "multispeed: CIA timed, the init routine sets the CIA 1 timer to two calls per PAL frame; every call steps the frequency low byte",
    speed: 1,
    asm:
      prologue(`
        lda #$f0
        sta $d406
        lda #$11
        sta $d404
        lda #$10
        sta $d401
        lda #<9828
        sta $dc04
        lda #>9828
        sta $dc05`) +
      `
play:   inc $fb
        lda $fb
        sta $d400
        rts
`,
  },
  multispeed9: {
    feature: "nine calls per PAL frame: the call rate lies above the highest speed of the language (8), so the recovered score cannot be compiled",
    speed: 1,
    asm:
      prologue(`
        lda #$f0
        sta $d406
        lda #$11
        sta $d404
        lda #$10
        sta $d401
        lda #<2184
        sta $dc04
        lda #>2184
        sta $dc05`) +
      `
play:   inc $fb
        lda $fb
        sta $d400
        rts
`,
  },
  twoSids: {
    feature: "two SIDs: SID 1 at $D400 and SID 2 at $D420 each get a frequency write per call",
    version: 3,
    secondSidAddress: 0xd420,
    asm:
      prologue(
        `
        lda #$f0
        sta $d406
        sta $d426
        lda #$11
        sta $d404
        sta $d424
        lda #$10
        sta $d401
        lda #$20
        sta $d421`,
        { secondSid: true },
      ) +
      `
play:   inc $fb
        lda $fb
        sta $d400
        eor #$ff
        sta $d420
        rts
`,
  },
  testBit: {
    feature: "test-bit trick: in every fourth call the control register of voice 1 is written twice, first $49 (test, pulse, gate) then $41",
    asm:
      prologue(`
        lda #$08
        sta $d403
        lda #$f0
        sta $d406
        lda #$41
        sta $d404`) +
      `
play:   lda $fb
        sta $d400
        and #3
        bne skip
        lda #$49
        sta $d404
        lda #$41
        sta $d404
skip:   inc $fb
        rts
`,
  },
  nmiSampler: {
    feature: "NMI sample writer: a CIA 2 timer NMI writes a 4-bit ramp to $D418 every 246 cycles; the play routine writes the frequency of voice 1",
    asm:
      prologue(`
        lda #$f0
        sta $d406
        lda #$11
        sta $d404
        lda #<nmi
        sta $fffa
        sta $0318
        lda #>nmi
        sta $fffb
        sta $0319
        lda #<246
        sta $dd04
        lda #>246
        sta $dd05
        lda #$81
        sta $dd0d
        lda #$01
        sta $dd0e`) +
      `
play:   inc $fb
        lda $fb
        sta $d400
        lda #$10
        sta $d401
        rts
nmi:    pha
        inc $fe
        lda $fe
        and #$0f
        sta $d418
        lda $dd0d
        pla
        rti
`,
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURE_DEFS);

/** Assembles a fixture into an in-memory PSID. */
export function buildFixture(name) {
  const def = FIXTURE_DEFS[name];
  if (!def) throw new Error(`unknown fixture ${name}`);
  const result = assemblyToPrgDetailed(def.asm, { loadAddress: LOAD, fileName: `${name}.asm` });
  const prg = new Uint8Array(result.prg);
  const sid = writeSidFile({
    magic: "PSID",
    version: def.version ?? 2,
    loadAddress: LOAD,
    initAddress: result.symbols.get("init"),
    playAddress: result.symbols.get("play"),
    songs: 1,
    startSong: 1,
    speed: def.speed ?? 0,
    name: `fixture ${name}`,
    author: "SIDWave tests",
    released: "2026",
    clock: "PAL",
    sidModels: ["6581", "unknown", "unknown"],
    ...(def.secondSidAddress ? { secondSidAddress: def.secondSidAddress } : {}),
    payload: prg.subarray(2),
  });
  return { name, sid, feature: def.feature, symbols: result.symbols };
}
