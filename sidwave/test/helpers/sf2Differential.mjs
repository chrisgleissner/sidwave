// Differential helpers for SID Factory II: the driver inside an .sf2 file is run as a PSID and compared with the compiled score.
import { parseSf2 } from "../../src/interchange/sf2.ts";
import { writeSidFile } from "../../src/sidFile.ts";

/** PSID that runs the driver stored in the file for song `song` (0-based): stubs at $0400 switch to RAM only, then call init (A = song) and update. */
export function psidFromSf2(bytes, song = 0) {
  const sf = typeof bytes === "object" && bytes.image ? bytes : parseSf2(bytes);
  const image = Uint8Array.from(sf.image);
  const init = sf.common.init, update = sf.common.update;
  image.set([0xa9, 0x35, 0x85, 0x01, 0xa9, song, 0x4c, init & 255, init >> 8], 0x0400);
  image.set([0xa9, 0x35, 0x85, 0x01, 0x4c, update & 255, update >> 8], 0x0410);
  // Multi-SID drivers (6 or 9 tracks) write SID n at $D400 + n * $20; a PSID can name a second and a third SID.
  const sidCount = Math.floor(sf.music.tracks / 3);
  const end = Math.min(0xd000, Math.max(sf.end, 0x1000) + 16);
  return Buffer.from(writeSidFile({
    magic: "PSID", version: sidCount > 2 ? 4 : sidCount > 1 ? 3 : 2, loadAddress: 0x0400, initAddress: 0x0400, playAddress: 0x0410, songs: 1, startSong: 1, speed: 0,
    name: "sf2", author: "", released: "", clock: "PAL", ...(sidCount > 1 ? { secondSidAddress: 0xd420 } : {}), ...(sidCount > 2 ? { thirdSidAddress: 0xd440 } : {}), payload: image.subarray(0x0400, end),
  }, { strict: false }));
}
