; A sprite that bounces off the screen edges, with music and a sound effect on every hit (SIDWave game build).
; Assembled by build.mjs with 6502-toolkit; "music.acme" is the symbol file of sprite_bounce.yaml.
;
; A raster interrupt at line 20 runs once per frame: one frame of music, the joystick (port 2, optional) steers the
; sprite, the sprite moves, and a hit on the left or right edge starts "bounce", a hit on the top or bottom edge
; starts "thud". The sprite is visible between x = 24..320 and y = 50..229.

        !source "music.acme"             ; sidwave_init, sidwave_play, sidwave_sfx, sidwave_fx_bounce, ...

X_MIN = 24
X_MAX = 320                              ; $0140
Y_MIN = 50
Y_MAX = 229

        * = $0801
        !byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061

start:  sei
        lda #$7f
        sta $dc0d
        sta $dd0d
        lda $dc0d
        lda $dd0d
        lda #$01
        sta $d01a
        lda #20
        sta $d012
        lda $d011
        and #$7f
        sta $d011
        lda #(sprite / 64)
        sta $07f8                        ; sprite 0 pointer
        lda #1
        sta $d015                        ; sprite 0 on
        lda #7
        sta $d027                        ; yellow
        lda #66
        sta xlo
        lda #0
        sta xhi
        lda #60
        sta ypos
        lda #3
        sta dx
        lda #2
        sta dy
        lda #0
        ldx #$ff
        jsr sidwave_init
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        cli
main:   jmp main

irq:    lda #$01
        sta $d019
        jsr sidwave_play

        lda $dc00                        ; joystick port 2 steers (bit = 0 pressed): left, right, up, down
        sta joy
        and #$04
        bne not_left
        lda #$fd                         ; -3
        sta dx
not_left:
        lda joy
        and #$08
        bne not_right
        lda #3
        sta dx
not_right:
        lda joy
        and #$01
        bne not_up
        lda #$fe                         ; -2
        sta dy
not_up:
        lda joy
        and #$02
        bne not_down
        lda #2
        sta dy
not_down:

        ; x: bounce at the edges, then move (16 bit position, 8 bit signed step)
        lda dx
        bmi going_left
        lda xhi                          ; moving right: x >= X_MAX?
        cmp #>X_MAX
        bcc move_x
        bne hit_x
        lda xlo
        cmp #<X_MAX
        bcc move_x
        jmp hit_x
going_left:
        lda xhi                          ; moving left: x <= X_MIN?
        bne move_x
        lda xlo
        cmp #(X_MIN + 1)
        bcs move_x
hit_x:  lda #0
        sec
        sbc dx
        sta dx                           ; reverse
        lda #sidwave_fx_bounce
        ldy #$ff
        jsr sidwave_sfx
move_x: ldx #0
        lda dx
        bpl x_positive
        ldx #$ff
x_positive:
        clc
        lda xlo
        adc dx
        sta xlo
        txa
        adc xhi
        sta xhi

        ; y
        lda dy
        bmi going_up
        lda ypos
        cmp #Y_MAX
        bcc move_y
        jmp hit_y
going_up:
        lda ypos
        cmp #(Y_MIN + 1)
        bcs move_y
hit_y:  lda #0
        sec
        sbc dy
        sta dy
        lda #sidwave_fx_thud
        ldy #$ff
        jsr sidwave_sfx
move_y: clc
        lda ypos
        adc dy
        sta ypos

        lda xlo
        sta $d000
        lda xhi
        sta $d010
        lda ypos
        sta $d001
        jmp $ea81

joy:    !byte $ff
xlo:    !byte 0
xhi:    !byte 0
ypos:   !byte 0
dx:     !byte 0
dy:     !byte 0

!align 63, 0
sprite:                                  ; a 24 x 21 ball
        !byte $00,$7e,$00, $01,$ff,$80, $07,$ff,$e0, $0f,$ff,$f0, $1f,$ff,$f8, $3f,$ff,$fc, $3f,$ff,$fc
        !byte $7f,$ff,$fe, $7f,$ff,$fe, $7f,$ff,$fe, $7f,$ff,$fe, $7f,$ff,$fe, $7f,$ff,$fe, $7f,$ff,$fe
        !byte $3f,$ff,$fc, $3f,$ff,$fc, $1f,$ff,$f8, $0f,$ff,$f0, $07,$ff,$e0, $01,$ff,$80, $00,$7e,$00
