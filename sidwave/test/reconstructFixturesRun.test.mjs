// The independently written synthetic players (test/helpers/reconstructFixtures.mjs) through reconstructSid.
// None of them is produced by SIDWave, so the recovered score is compiled by the SIDWave player, which differs from a
// tune player in ways the language cannot change. The test records, per fixture, which constructs the recovery
// reports as missing; it does not require an exact match.
import test from "#test/runner";
import assert from "#test/assert";
import { buildFixture, FIXTURE_NAMES } from "./helpers/reconstructFixtures.mjs";
import { sharedEngine, verdict } from "./helpers/reconstructRoundTrip.mjs";
import { reconstructSid } from "../src/reconstruct/reconstruct.ts";

/** Per fixture: the strict verdict and unsupported kinds the recovery reports (all of them; the lists are exact sets). */
const EXPECTED = {
  hardRestart: ["state_exact", []],
  arpeggio: ["state_exact", ["pitch"]],
  vibrato: ["state_exact", ["pitch"]],
  pulseSweep: ["state_exact", []],
  filterSweep: ["state_exact", []],
  sync: ["state_exact", ["pitch"]],
  ring: ["state_exact", ["pitch"]],
  multispeed: ["different", ["instrument_budget", "wavetable"]],
  multispeed9: ["compile_failed", ["instrument_budget", "wavetable"]],
  twoSids: ["different", ["instrument_budget", "pitch"]],
  testBit: ["state_exact", ["pitch"]],
  nmiSampler: ["call_count", ["non_periodic_writes", "pitch"]],
};

for (const name of FIXTURE_NAMES) {
  test(`fixture ${name} is traced, recovered, recompiled and compared`, { timeout: 120_000 }, async () => {
    const fixture = buildFixture(name);
    const { score, report } = await reconstructSid(new Uint8Array(fixture.sid), { engine: sharedEngine(), seconds: 3 });
    assert.equal(report.horizon.seconds, 3);
    assert.ok(report.horizon.calls > 100, "the horizon holds player calls");
    assert.equal(typeof score, "string");
    assert.ok(report.fdiffState.comparedCalls > 0 || report.compile?.ok === false);
    const kinds = [...new Set(report.unsupported.map((u) => u.kind))].sort();
    assert.equal(verdict(report), EXPECTED[name][0], name);
    assert.deepEqual(kinds, EXPECTED[name][1], name);
    assert.equal(report.strictExact, false, "no fixture is a strict match");
    for (const extension of report.languageExtensions) {
      assert.ok(extension.reproducer.calls.length > 0 && extension.reproducer.calls.length <= 6, `${extension.id} reproducer`);
      assert.ok(extension.reproducer.calls.every((c) => /^[0-9a-f]{14}$/.test(c.regs)));
    }
  });
}
