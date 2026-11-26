// Runs a game build on the bundled 6502 emulator: the player and data are loaded at their origins, init and play are
// called through the entry table, and every write is recorded with the play call it belongs to.
import { Cpu } from "./sidwaveEmulator.mjs";

export const isSidWrite = (address) => address >= 0xd400 && address < 0xd800;

/**
 * Returns { cpu, mem, writes, init(a, x), play(), stop() }. `writes` holds { call, address, value, port } for every write;
 * `call` counts the init, play and stop calls in order and `port` is the value of $01 at the time of the write.
 */
export function gameMachine(build, { port = 0x35, clockFlag = 1 } = {}) {
  const { memory, entryPoints } = build.contract;
  const mem = new Uint8Array(65536);
  mem[0x2a6] = clockFlag; // a player placed over $02A6 overwrites it
  mem.set(build.player, memory.player.start);
  if (build.data) mem.set(build.data, memory.data.start);
  mem[1] = port;
  const writes = [];
  let call = 0;
  const cpu = new Cpu(mem, { write(address, value) { writes.push({ call, address, value, port: mem[1] }); } });
  const run = (address, a, x) => {
    call += 1;
    if (x !== undefined) cpu.x = x;
    return cpu.call(address, a);
  };
  return {
    cpu, mem, writes, build,
    init: (a = 0, x = 0) => run(entryPoints.init, a, x),
    play: () => run(entryPoints.play, 0),
    stop: () => run(entryPoints.stop, 0),
    sfx: () => run(entryPoints.sfx, 0),
    get calls() { return call; },
  };
}

/** The SID writes of each play call (call 1 is init), as arrays of [address, value]. */
export function sidTrace(machine) {
  const calls = [];
  for (const { call, address, value } of machine.writes) {
    if (!isSidWrite(address)) continue;
    (calls[call] ??= []).push([address, value]);
  }
  return calls;
}
