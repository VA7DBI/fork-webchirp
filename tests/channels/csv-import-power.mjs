// A CSV imported into a selected radio takes that radio's power levels, the
// way desktop CHIRP's import does (import_logic._import_power): a level the
// radio does not have becomes the closest one it does, in watts. Issue #262: a
// CSV of 5W channels loaded for a Wouxun KG-1000G Plus (L 1W, M 20W, H 50W)
// kept "5.0W", and the upload preflight refused every channel for it.
import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, sharedHarness } from "../support/chirp.mjs";

const RADIO = { module: "kguv980p", className: "KG1000GPlusRadio" };

const HEADER = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip,Power,Comment";

// One channel per power, in the watt form CHIRP's CSV export writes.
function csvWithPowers(powers) {
  const lines = powers.map((power, idx) => {
    const frequency = (145.5 + idx * 0.025).toFixed(6);
    return `${idx + 1},CH${idx + 1},${frequency},,0.000000,,88.5,88.5,023,NN,FM,5.00,,${power},`;
  });
  return [HEADER, ...lines].join("\n");
}

// What the per-edit check (normalize_and_validate_rows) says about each row
// as it stands, with no edit applied: the issues a stored value raises.
async function powerIssues(harness, sessionId, rows) {
  const result = await harness.rpc("normalize_and_validate_rows", {
    session_id: sessionId,
    rows: rows.map((row) => ({ row, edits: [] })),
  });
  return result.rows.flatMap((checked) => checked.issues.filter((issue) => issue.column === "Power"));
}

test("a CSV imported into a radio takes the closest of its power levels", async (t) => {
  const harness = await sharedHarness();
  await ensureModule(harness, RADIO.module);
  const sessionId = await harness.session(RADIO.module, RADIO.className);
  const csvText = csvWithPowers(["5.0W", "50W", "15W", "1.0W"]);

  await t.test("each channel lands on the level closest in watts, under the radio's own label", async () => {
    const parsed = await harness.rpc("parse_csv", { csv_text: csvText, session_id: sessionId });
    // 5W is 4W from L and 15W from M; 15W is 5W from M; 50W and 1W are H and L
    // already, so only the first and third count as adjusted.
    assert.deepEqual(parsed.rows.map((row) => row.Power), ["L", "H", "M", "L"]);
    assert.equal(parsed.powerAdjusted, 2);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(await powerIssues(harness, sessionId, parsed.rows), []);
  });

  await t.test("with no radio selected the rows keep the CSV driver's watts", async () => {
    const parsed = await harness.rpc("parse_csv", { csv_text: csvText, session_id: "" });
    assert.deepEqual(parsed.rows.map((row) => row.Power), ["5.0W", "50W", "15W", "1.0W"]);
    assert.equal(parsed.powerAdjusted, 0);
    // What the issue's reporter saw: the radio refuses those values.
    const issues = await powerIssues(harness, sessionId, parsed.rows);
    assert.equal(issues.length, 2);
    assert.match(issues[0].message, /Power '5\.0W' is not supported by this radio/);
  });
});

test("text that names no power level is left for the per-edit check to judge", async () => {
  const harness = await sharedHarness();
  const labels = await harness.runPythonJson(
    `
_levels = [chirp_common.PowerLevel("L", watts=1.0), chirp_common.PowerLevel("H", watts=50.0)]
json.dumps([
    _closest_power_label("", _levels),
    _closest_power_label("None", _levels),
    _closest_power_label("High", _levels),
    _closest_power_label("5.0W", []),
    _closest_power_label("H", _levels),
    _closest_power_label("30W", _levels),
])
    `,
  );
  // Blank and "None" are no level chosen; "High" is no level of this radio's
  // and no wattage; a radio with no levels has nothing to choose from.
  assert.deepEqual(labels, [null, null, null, null, "H", "H"]);
});
