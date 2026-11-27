Hand-built SID-Wizard files, assembled byte by byte from the layout in `SWM-spec.src` by `test/helpers/swmKit.mjs` (not by the library's writer):

- `hand-built.swm`: SWM1 module, two patterns (one with a packed NOP run, one with a big tempo effect), two instruments, orderlists with a loop jump.
- `hand-built.sws`: the same material as a stereo module (SWMS, six sequences per subtune).
- `hand-built.swi`: one instrument file.

Real-world modules are never committed; the tests read them from a local SID-Wizard checkout when `SIDWAVE_SIDWIZARD_DIR` or `~/.c64bridge/sidwave-standalone/research-src/anarkiwi_sid-wizard` exists.
