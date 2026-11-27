// Quality floors for the differential tests of the tracker importers. The numbers are the agreement with the real
// player or driver at a fixed alignment; they are floors below what is measured, so a regression in an importer fails.
import assert from "#test/assert";

export const median = (values) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN; };
const mean = (values) => values.reduce((s, x) => s + x, 0) / Math.max(1, values.length);

/**
 * `rows`: { name, gate: [3 or more], note: [..], both: [..] } per compared song.
 * floors: gateVoice (every voice), gateSong (mean per song), gateMedian (all voices), noteSong (mean over voices with at
 * least 50 comparable calls, per song), noteMedian (all such voices).
 */
export function assertQuality(rows, floors) {
  assert.ok(rows.length >= floors.songs, `only ${rows.length} songs were compared`);
  const gates = [], notes = [];
  for (const r of rows) {
    r.gate.forEach((g) => gates.push(g));
    r.note.forEach((n, i) => { if (r.both[i] >= 50) notes.push(n); });
  }
  console.log(`# quality: ${rows.length} songs, ${gates.length} voices, gate median ${median(gates).toFixed(3)}, note median ${median(notes).toFixed(3)} over ${notes.length} voices`);
  gates.length = 0; notes.length = 0;
  for (const r of rows) {
    r.gate.forEach((g) => gates.push(g));
    const comparable = r.note.filter((_, i) => r.both[i] >= 50);
    comparable.forEach((n) => notes.push(n));
    assert.ok(Math.min(...r.gate) >= floors.gateVoice, `${r.name}: a voice has gate agreement ${Math.min(...r.gate).toFixed(2)}, floor ${floors.gateVoice}`);
    assert.ok(mean(r.gate) >= floors.gateSong, `${r.name}: mean gate agreement ${mean(r.gate).toFixed(2)}, floor ${floors.gateSong}`);
    if (comparable.length) assert.ok(mean(comparable) >= floors.noteSong, `${r.name}: mean note agreement ${mean(comparable).toFixed(2)}, floor ${floors.noteSong}`);
  }
  assert.ok(median(gates) >= floors.gateMedian, `median gate agreement ${median(gates).toFixed(3)}, floor ${floors.gateMedian}`);
  assert.ok(median(notes) >= floors.noteMedian, `median note agreement ${median(notes).toFixed(3)}, floor ${floors.noteMedian}`);
  return { gateMedian: median(gates), noteMedian: median(notes), voices: gates.length, noteVoices: notes.length };
}
