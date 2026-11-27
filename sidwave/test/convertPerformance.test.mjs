import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "../src/interchange/convert.ts";
import { FIXTURE_DIR } from "./helpers/convertMatrix.mjs";

// CPU-time budgets of the convert hub (no scripts/bench-perf.mjs exists on this branch yet). The bounds are several
// times the measured values, because CI machines are shared; the measured values are printed.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const cpu = async (fn) => { const before = process.cpuUsage(); const out = await fn(); const u = process.cpuUsage(before); return { out, seconds: (u.user + u.system) / 1e6 }; };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test("the hub adds less than 50 ms beyond its stages (detection, ScorePlan, loss grouping; the event export is counted as a stage)", async () => {
  for (const [file, to] of [[path.join(FIXTURE_DIR, "chiptune-drive.mid"), "goattracker"], [path.join(FIXTURE_DIR, "fuer-elise.sng"), "midi"], [path.join(fixtures, "sidwave-1.2/chamber_waltz.yaml"), "musicxml"]]) {
    const bytes = fs.readFileSync(file);
    await convert(bytes, { to, inputName: file }); // warm up the modules
    const overheads = [];
    for (let i = 0; i < 5; i++) overheads.push((await convert(bytes, { to, inputName: file })).timings.overheadMs);
    const m = median(overheads);
    console.log(`# hub overhead ${path.basename(file)} -> ${to}: median ${m.toFixed(1)} ms`);
    assert.ok(m < 50, `${path.basename(file)} -> ${to}: overhead ${m} ms`);
  }
});

test("a typical file converts in under 1 s of CPU time and the largest bound input in under 3 s", async () => {
  const typical = await cpu(() => convert(fs.readFileSync(path.join(fixtures, "sidwave-1.2/chamber_waltz.yaml")), { to: "midi", verify: true, inputName: "chamber_waltz.yaml" }));
  console.log(`# cpu convert chamber_waltz.yaml -> midi --verify: ${typical.seconds.toFixed(3)} s`);
  assert.ok(typical.seconds < 1, `used ${typical.seconds} s`);
  const large = await cpu(() => convert(fs.readFileSync(path.join(fixtures, "sidwave-1.2/wall_of_sid.yaml")), { to: "midi", inputName: "wall_of_sid.yaml" }));
  console.log(`# cpu convert wall_of_sid.yaml (27 voices, 4177 notes) -> midi: ${large.seconds.toFixed(3)} s`);
  assert.ok(large.seconds < 3, `used ${large.seconds} s`);
  const reduce = await cpu(() => convert(fs.readFileSync(path.join(fixtures, "sidwave-1.2/wall_of_sid.yaml")), { to: "goattracker", inputName: "wall_of_sid.yaml" }));
  console.log(`# cpu convert wall_of_sid.yaml -> goattracker (24 voices dropped): ${reduce.seconds.toFixed(3)} s`);
  assert.ok(reduce.seconds < 3, `used ${reduce.seconds} s`);
  assert.equal(reduce.out.plan.dropped.length, 24);
});
