// Runs inside the child process of browserLike.test.mjs. The first argument is the file URL of the package's dist directory.
const dist = process.argv[2];
if (typeof globalThis.Buffer !== "undefined") throw new Error("Buffer is still defined");
const { assemblyToPrg, assemblyToPrgDetailed } = await import(`${dist}index.js`);
const { disassemble } = await import(`${dist}disassembler.js`);
const prg = assemblyToPrg("* = $c000\nstart: lda #$01\n  sta $d020\n  jmp start\n");
const detailed = assemblyToPrgDetailed("* = $c000\n  nop\n  rts\n");
const lines = disassemble(prg.subarray(2), 0xc000, 3).map((line) => `${line.mnemonic} ${line.operand}`);
console.log(JSON.stringify({
  isUint8Array: prg instanceof Uint8Array,
  prg: Array.from(prg),
  entry: detailed.entryAddress,
  lines,
}));
