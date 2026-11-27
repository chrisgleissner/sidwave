import test from "#test/runner";
import assert from "#test/assert";
import { classifyError } from "../src/cliCore.ts";
import { convert } from "../src/interchange/convert.ts";
import { inputs } from "./helpers/convertMatrix.mjs";
import { haveEngine } from "./helpers/trackerDifferential.mjs";

// Reconstruct at a horizon of 20 s or more (the default horizon is 180 s). Kept apart from the matrix, which has a CPU budget.
const engine = await haveEngine();
const input = inputs().find((i) => i.id === "sid:fuer-elise");

test("a .sid read by reconstruct at a 20 s horizon that yields an invalid score fails as an internal error, never as input", { skip: !engine, timeout: 120_000 }, async () => {
  try {
    await convert(input.bytes, { to: "midi", seconds: 20, inputName: "fuer-elise.sid" });
  } catch (error) {
    const report = classifyError(error);
    assert.equal(report.category, "internal", report.message);
    assert.match(report.message, /reconstruction produced an invalid score \(internal\)/);
  }
});

// Known failure: at 20 s the recovered score has a pattern of negative length ($.voices[2].patterns.P6.length: -26.56). The
// reconstruct work package (recover.ts) owns the fix; this case passes when it lands.
test("a .sid converts at a 20 s horizon", { skip: !engine, todo: "reconstruct emits a pattern with a negative length at horizons of 20 s and more (recover.ts, reconstruct work package)", timeout: 120_000 }, async () => {
  const result = await convert(input.bytes, { to: "midi", seconds: 20, inputName: "fuer-elise.sid" });
  assert.ok(result.output.length > 0);
});
