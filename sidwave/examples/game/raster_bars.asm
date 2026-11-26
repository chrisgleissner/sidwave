; Raster bars with music and a sound effect on the joystick fire button (SIDWave game build).
; Assembled by build.mjs with 6502-toolkit; "music.acme" is the symbol file of raster_bars.yaml.
;
; A raster interrupt at line 20 runs once per frame. It plays one frame of music, starts the effect "pew" when the
; fire button of joystick port 2 goes down, and then draws 64 lines of bars by waiting for each raster line.

        !source "music.acme"             ; sidwave_init, sidwave_play, sidwave_sfx, sidwave_fx_pew, ...

BAR_START = 100                          ; first raster line of the bars
BAR_LINES = 64

        * = $0801
        !byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00   ; 10 SYS2061

start:  sei
        lda #$7f
        sta $dc0d                        ; CIA interrupts off
        sta $dd0d
        lda $dc0d
        lda $dd0d
        lda #$01
        sta $d01a                        ; raster interrupt on
        lda #20
        sta $d012                        ; at raster line 20
        lda $d011
        and #$7f
        sta $d011
        lda #$10
        sta fire_last                    ; fire released
        lda #0
        sta phase
        lda #0                           ; A = song 0
        ldx #$ff                         ; X = $FF: PAL or NTSC from the KERNAL flag at $02A6
        jsr sidwave_init
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        cli
main:   jmp main                         ; your game goes here

irq:    lda #$01
        sta $d019                        ; acknowledge the raster interrupt
        jsr sidwave_play                 ; one frame of music; a running effect is played by the same call

        lda $dc00                        ; joystick port 2: bit 4 = fire, 0 = pressed
        and #$10
        cmp fire_last
        beq bars                         ; no change
        sta fire_last
        cmp #0
        bne bars                         ; released
        lda #sidwave_fx_pew              ; fire went down: start the effect on any voice it may use
        ldy #$ff
        jsr sidwave_sfx                  ; carry clear = started (a rejected effect is simply not heard)

bars:   ldx #0
bar:    txa
        clc
        adc #BAR_START
wait:   cmp $d012                        ; wait for the raster line
        bne wait
        txa
        clc
        adc phase
        and #$3f
        tay
        lda bar_color,y
        sta $d020
        sta $d021
        inx
        cpx #BAR_LINES
        bne bar
        lda #0
        sta $d020
        sta $d021
        inc phase
        jmp $ea81                        ; restore A, X, Y and return from the interrupt

fire_last: !byte $10
phase:     !byte 0
bar_color:
        !byte 0,6,6,14,14,3,3,13,13,1,1,13,13,3,3,14
        !byte 14,6,6,0,0,2,2,10,10,7,7,10,10,2,2,0
        !byte 0,9,9,8,8,7,7,8,8,9,9,0,0,5,5,13
        !byte 13,1,1,13,13,5,5,0,0,6,6,14,14,3,3,0
