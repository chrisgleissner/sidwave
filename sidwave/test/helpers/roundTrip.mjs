// Compares two imported scores voice by voice: a note of the first score matches when the second has a note of the same
// pitch on the same voice whose start and end differ by at most one video frame. `extra` counts the notes of the second
// score that match no note of the first.
import { exportEvents } from "../../src/interchange/events.ts";
import { parseSidwave } from "../../src/sidwave.ts";

export function compareVoices(yamlA, yamlB, framesPerSecond = 985248 / 19656) {
  const a = exportEvents(parseSidwave(yamlA)), b = exportEvents(parseSidwave(yamlB));
  let notes = 0, matched = 0, extra = 0;
  const unmatched = [];
  for (let v = 0; v < Math.max(a.voices.length, b.voices.length); v++) {
    const other = b.voices[v]?.notes ?? [];
    const used = new Set();
    for (const n of a.voices[v]?.notes ?? []) {
      notes++;
      const j = other.findIndex((m, k) => !used.has(k) && m.pitch === n.pitch && Math.abs(m.on.time - n.on.time) * framesPerSecond <= 1.01 && Math.abs(m.off.time - n.off.time) * framesPerSecond <= 1.01);
      if (j >= 0) { used.add(j); matched++; } else unmatched.push({ voice: v, pitch: n.pitch, on: n.on.time, off: n.off.time });
    }
    extra += other.length - used.size;
  }
  return { notes, matched, unmatched, extra };
}
