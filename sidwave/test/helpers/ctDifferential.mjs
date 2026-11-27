// Differential helpers for CheeseCutter: the player inside a .ct file is run as a PSID and compared with the compiled score.
import { parseCheeseCutter, CT } from "../../src/interchange/cheesecutter.ts";
import { writeSidFile } from "../../src/sidFile.ts";

/** Builds a PSID (load address $0400 with two stubs that switch to RAM, then the player at $1000 and $1003) that plays one subtune of a .ct song with the player stored in it. */
export function psidFromCt(bytes, subtune = 0) {
  const song = typeof bytes === "object" && bytes.image ? bytes : parseCheeseCutter(bytes);
  const image = Uint8Array.from(song.image);
  const O = CT.OFS, p = song.pointers;
  const speedAt = p[O.songTable] + 6;
  for (let v = 0; v < 3; v++) {
    const at = p[O.orderListVoice1 + v];
    image.set(song.orderLists[subtune][v], at);
    image[p[O.songTable] + v * 2] = at & 255;
    image[p[O.songTable] + v * 2 + 1] = at >> 8;
  }
  image[speedAt] = song.speeds[subtune];
  image[speedAt + 1] = 7;
  image[p[O.editorActive]] = 1;
  // The song data lies above $A000, where the BASIC ROM would hide it under the default memory configuration of a PSID.
  // Two stubs in low memory switch to RAM only ($01 = $35) and then call the player.
  image.set([0xa9, 0x35, 0x85, 0x01, 0xa9, 0x00, 0x4c, 0x00, 0x10], 0x0400);
  image.set([0xa9, 0x35, 0x85, 0x01, 0x4c, 0x03, 0x10], 0x0410);
  const end = Math.max(p[O.chordStarts] + 32, p[O.chordNotes] + 128) + 16;
  return Buffer.from(writeSidFile({
    magic: "PSID", version: 2, loadAddress: 0x0400, initAddress: 0x0400, playAddress: 0x0410, songs: 1, startSong: 1, speed: 0,
    name: "ct", author: "", released: "", clock: "PAL", payload: image.subarray(0x0400, Math.min(end, 0xd000)),
  }, { strict: false }));
}
