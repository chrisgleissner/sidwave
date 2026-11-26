# 6502-toolkit

[![Codecov](https://codecov.io/gh/chrisgleissner/sidwave/graph/badge.svg?flag=6502-toolkit)](https://codecov.io/gh/chrisgleissner/sidwave)

A 6502 assembler and disassembler for Commodore 64 programs, written in TypeScript. It covers all 256 NMOS opcodes, including undocumented ones, and includes PETSCII, I/O range and PRG helpers. The disassembler is exported as `6502-toolkit/disassembler`. It is the assembler that the [`sidwave`](https://github.com/chrisgleissner/sidwave) compiler uses to build its music player, and it is also used by [c64bridge](https://github.com/chrisgleissner/c64bridge) to assemble programs for VICE and Ultimate devices.

Status: pre-release; not yet published to npm. The package was moved out of c64bridge unchanged in behaviour, and the API is not final, so the exports are not documented here yet. See the exports in `package.json` and the sources.

```sh
npm install 6502-toolkit
```

It has no dependency on a device, an MCP server or the network.

License: MIT.
