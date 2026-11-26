// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// SIDWave 1.4 sound effects: the step records, the 6502 routines of the effect engine and the cycle bound

import type { ParsedEffect } from "./sidwave.js";

/** Bytes of one step record. */
export const SIDWAVE_EFFECT_STEP_BYTES = 11;

/** Flag bits of the first byte of a step record. */
const FLAG = { freq: 0x01, pulse: 0x02, ctrl: 0x04, adsr: 0x08, filterSet: 0x10, filterOff: 0x20, first: 0x40, last: 0x80 } as const;

const WAVE_CTRL: Record<string, number> = {
  pulse: 0x40, sawtooth: 0x20, saw: 0x20, triangle: 0x10, tri: 0x10, noise: 0x80,
  "tri+pulse": 0x50, "saw+pulse": 0x60, "tri+saw": 0x30, "tri+saw+pulse": 0x70,
};

/** What a step that does not set a field gets in the first step of an effect. */
export const SIDWAVE_EFFECT_DEFAULTS = { wave: "pulse", pulse: 2048, adsr: [0, 0, 15, 0] as [number, number, number, number], gate: true } as const;

export interface EffectBuild {
  effects: ParsedEffect[];
  /** True when at least one step sets `filter: off`, which adds the route mask to the player. */
  filterOff: boolean;
  /** Frequency register values of the document's PAL and NTSC clocks for a Hz value. */
  hzToRegister: (hz: number, system: "PAL" | "NTSC") => number;
  midiToHz: (midi: number) => number;
}

/** The step records of one effect (the fields a step does not set hold the value in force from the steps before): 11 bytes each (flags, wait, PAL frequency, NTSC frequency, pulse width, control, AD, SR). */
export function effectRecords(effect: ParsedEffect, build: Pick<EffectBuild, "hzToRegister" | "midiToHz">): number[][] {
  let wave: string = SIDWAVE_EFFECT_DEFAULTS.wave;
  let gate: boolean = SIDWAVE_EFFECT_DEFAULTS.gate;
  let pulse: number = SIDWAVE_EFFECT_DEFAULTS.pulse;
  let adsr: readonly number[] = SIDWAVE_EFFECT_DEFAULTS.adsr;
  return effect.steps.map((step, k) => {
    const first = k === 0;
    const hz = step.freq === undefined ? 0 : "hz" in step.freq ? step.freq.hz : build.midiToHz(step.freq.midi);
    const pal = build.hzToRegister(hz, "PAL");
    const ntsc = build.hzToRegister(hz, "NTSC");
    if (step.wave !== undefined) wave = step.wave;
    if (step.gate !== undefined) gate = step.gate;
    if (step.pulse !== undefined) pulse = step.pulse;
    if (step.adsr !== undefined) adsr = step.adsr;
    let flags = 0;
    if (step.freq !== undefined) flags |= FLAG.freq;
    if (first || step.pulse !== undefined) flags |= FLAG.pulse;
    if (first || step.wave !== undefined || step.gate !== undefined) flags |= FLAG.ctrl;
    if (first || step.adsr !== undefined) flags |= FLAG.adsr;
    if (step.filter !== undefined) flags |= FLAG.filterSet | (step.filter === "off" ? FLAG.filterOff : 0);
    if (first) flags |= FLAG.first;
    if (k === effect.steps.length - 1) flags |= FLAG.last;
    return [flags, step.wait, pal & 255, pal >> 8, ntsc & 255, ntsc >> 8, pulse & 255, pulse >> 8,
      WAVE_CTRL[wave]! | (gate ? 1 : 0), (adsr[0] << 4) | adsr[1], (adsr[2] << 4) | adsr[3]];
  });
}

/** Play calls one effect lasts when nothing interrupts it. */
export function effectFrames(effect: ParsedEffect): number {
  return effect.steps.reduce((sum, step) => sum + step.wait, 0);
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

/** The 6502 routines of the effect engine. `ptr` is the player's stream pointer; `first` is the address of the first SID. */
export function effectCode(count: number, channels: number, chips: number, first: number, ended: boolean, filterOff: boolean): string {
  const sid = (offset: number) => `$${hex4(first + offset)}`;
  return `
; ---- sound effects (SIDWave 1.4) ----
; sfx: A = effect index, Y = voice 1-3 or $FF for automatic. Carry clear = started, carry set = rejected.
; It runs with interrupts disabled and restores the caller's interrupt and decimal flags, so a raster interrupt that calls play
; cannot see an effect that is half started.
sfx:
  php
  sei
  tax
  cpx #${count}
  bcc sfx_ok
sfx_reject:
  plp
  sec
  rts
sfx_ok:
${ended ? "  lda song_left\n  ora song_left+1\n  ora song_left+2\n  beq sfx_reject\n" : ""}  inx
  stx sfx_e
  dex
  lda sfx_vmask,x
  sta sfx_cand
  lda sfx_prio_t,x
  sta sfx_newp
  cpy #$FF
  beq sfx_auto
  dey
  cpy #3
  bcs sfx_reject
  lda sfx_bit,y
  and sfx_cand
  beq sfx_reject
  sta sfx_cand
sfx_auto:
  ldx #0
sfx_free:
  lda sfx_cand
  and sfx_bit,x
  beq sfx_free_next
  lda sfx_eff,x
  beq sfx_start
sfx_free_next:
  inx
  cpx #3
  bne sfx_free
  lda #16
  sta sfx_minp
  lda #$FF
  sta sfx_best
  ldx #0
sfx_scan:
  lda sfx_cand
  and sfx_bit,x
  beq sfx_scan_next
  lda sfx_prio,x
  cmp sfx_minp
  bcs sfx_scan_next
  sta sfx_minp
  stx sfx_best
sfx_scan_next:
  inx
  cpx #3
  bne sfx_scan
  ldx sfx_best
  bmi sfx_reject
  lda sfx_minp
  cmp sfx_newp
  bcc sfx_start
  ldx #0
sfx_same:
  lda sfx_cand
  and sfx_bit,x
  beq sfx_same_next
  lda sfx_eff,x
  cmp sfx_e
  beq sfx_start
sfx_same_next:
  inx
  cpx #3
  bne sfx_same
  jmp sfx_reject
sfx_start:
  lda sfx_e
  sta sfx_eff,x
  lda sfx_newp
  sta sfx_prio,x
  ldy sfx_e
  dey
  lda sfx_st_lo,y
  sta sfx_pl,x
  lda sfx_st_hi,y
  sta sfx_ph,x
  lda #1
  sta sfx_wait,x
${filterOff ? "  lda #0\n  sta sfx_foff,x\n  jsr sfx_fm_update\n" : ""}  plp
  clc
  rts

; Called at the end of every play call, after the music voices: runs the active effects.
sfx_tick:
  ldx #0
st_loop:
  lda sfx_eff,x
  beq st_next
  dec sfx_wait,x
  bne st_next
  lda sfx_ph,x
  beq st_end
  jsr sfx_step
  jmp st_next
st_end:
  jsr sfx_end
st_next:
  inx
  cpx #3
  bne st_loop
  rts

; Applies the step at (sfx_pl,sfx_ph) to voice X and advances to the next step. Preserves X.
sfx_step:
  stx sfx_v
  lda sfx_so,x
  sta sfx_off
  lda sfx_pl,x
  sta ptr
  lda sfx_ph,x
  sta ptr+1
  ldy #0
  lda (ptr),y
  sta sfx_fl
  ldy #1
  lda (ptr),y
  sta sfx_wait,x
  lda sfx_fl
  bmi ss_last
  clc
  lda sfx_pl,x
  adc #${SIDWAVE_EFFECT_STEP_BYTES}
  sta sfx_pl,x
  bcc ss_fields
  inc sfx_ph,x
  jmp ss_fields
ss_last:
  lda #0
  sta sfx_ph,x
ss_fields:
  ldx sfx_off
  lda sfx_fl
  and #$40
  beq ss_nofirst
  lda #0
  sta ${sid(4)},x
ss_nofirst:
  lda sfx_fl
  and #1
  beq ss_nofreq
  lda sfx_clock
  asl
  clc
  adc #2
  tay
  lda (ptr),y
  sta ${sid(0)},x
  iny
  lda (ptr),y
  sta ${sid(1)},x
ss_nofreq:
  lda sfx_fl
  and #2
  beq ss_nopw
  ldy #6
  lda (ptr),y
  sta ${sid(2)},x
  iny
  lda (ptr),y
  sta ${sid(3)},x
ss_nopw:
  lda sfx_fl
  and #8
  beq ss_noadsr
  ldy #9
  lda (ptr),y
  sta ${sid(5)},x
  iny
  lda (ptr),y
  sta ${sid(6)},x
ss_noadsr:
  lda sfx_fl
  and #4
  beq ss_noctrl
  ldy #8
  lda (ptr),y
  sta ${sid(4)},x
ss_noctrl:
  ldx sfx_v
${filterOff ? `  lda sfx_fl
  and #$10
  beq ss_done
  lda sfx_fl
  and #$20
  beq ss_fset
  lda sfx_bit,x
ss_fset:
  sta sfx_foff,x
  jsr sfx_fm_update
ss_done:
` : ""}  rts

; Ends the effect on voice X: copies the music's shadow registers to the SID and frees the voice. Preserves X.
sfx_end:
  stx sfx_v
  lda #0
  sta sfx_eff,x
${filterOff ? "  sta sfx_foff,x\n  jsr sfx_fm_update\n" : ""}  lda sfx_so,x
  tax
  lda sfx_shadow,x
  sta ${sid(0)},x
  lda sfx_shadow+1,x
  sta ${sid(1)},x
  lda sfx_shadow+2,x
  sta ${sid(2)},x
  lda sfx_shadow+3,x
  sta ${sid(3)},x
  lda sfx_shadow+5,x
  sta ${sid(5)},x
  lda sfx_shadow+6,x
  sta ${sid(6)},x
  lda sfx_shadow+4,x
  sta ${sid(4)},x
  ldx sfx_v
  rts

; Ends every active effect (the song ends): the SID gets the music's registers back.
sfx_stopall:
  ldx #0
sa_loop:
  lda sfx_eff,x
  beq sa_next
  jsr sfx_end
sa_next:
  inx
  cpx #3
  bne sa_loop
  rts

; Cancels every effect without touching the SID (init and stop).
sfx_reset:
  lda #0
  ldx #${channels - 1}
sr_eff:
  sta sfx_eff,x
  dex
  bpl sr_eff
  ldx #20
sr_shadow:
  sta sfx_shadow,x
  dex
  bpl sr_shadow
${filterOff ? `  ldx #2
sr_foff:
  sta sfx_foff,x
  dex
  bpl sr_foff
  lda #$FF
  ldx #${chips - 1}
sr_fm:
  sta sfx_fm,x
  dex
  bpl sr_fm
` : ""}  rts
${filterOff ? `
; The route mask of the first SID: clear the filter bit of every voice whose effect asked for filter: off.
sfx_fm_update:
  lda sfx_foff
  ora sfx_foff+1
  ora sfx_foff+2
  eor #$FF
  sta sfx_fm
  rts
` : ""}
; The music writes the owned voice's seven registers here instead of to the SID (see vr_write).
vr_sfx_shadow:
  ldy sfx_so,x
  lda f_lo
  sta sfx_shadow,y
  lda f_hi
  sta sfx_shadow+1,y
  lda v_pwlo,x
  sta sfx_shadow+2,y
  lda v_pwhi,x
  sta sfx_shadow+3,y
  lda v_ctrl,x
  sta sfx_shadow+4,y
  lda v_ad,x
  sta sfx_shadow+5,y
  lda v_sr,x
  sta sfx_shadow+6,y
  jmp vr_after_write
sfx_bit: .byte 1, 2, 4
sfx_so: .byte 0, 7, 14
`;
}

/** Read-only tables: per effect the allowed voices, priority and first step, then the step records. */
export function effectTables(build: EffectBuild, pushRows: (label: string, items: string[]) => void, line: (text: string) => void): void {
  const { effects } = build;
  line(`sfx_vmask: .byte ${effects.map((e) => e.voices.reduce((bits, v) => bits | (1 << (v - 1)), 0)).join(", ")}`);
  line(`sfx_prio_t: .byte ${effects.map((e) => e.priority).join(", ")}`);
  line(`sfx_st_lo: .byte ${effects.map((_, i) => `<sfx_data${i}`).join(", ")}`);
  line(`sfx_st_hi: .byte ${effects.map((_, i) => `>sfx_data${i}`).join(", ")}`);
  effects.forEach((effect, i) => {
    pushRows(`sfx_data${i}`, effectRecords(effect, build).flat().map((b) => `$${b.toString(16).padStart(2, "0")}`));
  });
}

/** RAM of the effect engine, one `.res` per line. */
export function effectRam(channels: number, chips: number, filterOff: boolean): string[] {
  return [
    `sfx_eff: .res ${channels}`, "sfx_pl: .res 3", "sfx_ph: .res 3", "sfx_wait: .res 3", "sfx_prio: .res 3",
    ...(filterOff ? ["sfx_foff: .res 3", `sfx_fm: .res ${chips}`] : []),
    "sfx_shadow: .res 21", "sfx_clock: .res 1", "sfx_e: .res 1", "sfx_cand: .res 1", "sfx_newp: .res 1", "sfx_minp: .res 1",
    "sfx_best: .res 1", "sfx_v: .res 1", "sfx_off: .res 1", "sfx_fl: .res 1",
  ];
}

/**
 * Upper bound of the cycles the effect engine adds to one play call. The longest path in a call is three voices that each
 * apply a step with every field set (the first step: gate-off write, frequency, pulse width, envelope, control; with
 * `filter: off` also the route mask update), plus the owned-voice check of every channel and the idle pass. Counted on the
 * emulator that is at most 285 cycles per voice without `filter: off` and 318 with it (all three voices together: 958 cycles
 * at the dearest of 100 origins). Indexed reads and taken branches can cross a page: the margin of 15 cycles per voice
 * (290 and 335 in the formula) covers the up to 15 such sites on the path, and 40 cycles cover the loop and the owned-voice
 * checks. test/sidwave14Effects.test.mjs measures both variants at many origins and checks the bound is above every
 * measurement and within 150 cycles of the worst one.
 */
export function effectCyclesBound(channels: number, filterOff: boolean): number {
  return 40 + 7 * channels + 3 * (filterOff ? 335 : 290);
}

/**
 * Upper bound of one `sfx` call: `php`/`sei`, three scan passes over the three voices (free voice, lowest priority, same
 * effect) and the start. The longest path measured at 256 consecutive origins (every third address) is 403 cycles (361 at the origin of the
 * first tests; page crossings account for the difference); the 27 cycles of margin cover the up to
 * 27 indexed reads and taken branches that may cross a page.
 */
export const SFX_CYCLES_BOUND = 430;
