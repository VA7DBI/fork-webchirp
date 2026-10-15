// A channel whose Mode the selected driver lacks, against the real runtime.
//
// Issue #266: a Wouxun KG-XS20G Plus session held a channel with Mode AM,
// carried over from a radio that has AM. The kg935g driver family stores only
// a wide/narrow bit, so it offers FM and NFM alone. The upload preflight
// flagged the cell; the binary export, which ran no preflight, raised the same
// refusal with a traceback. The UI now runs the preflight before both
// (tests/channels/ui-binary-export-preflight.mjs). This pins the runtime halves
// that relies on: the preflight names the cell the export would refuse, and a
// driver that cannot build a blank radio without an image (the KG-XS20G Plus
// itself) gets no findings about that from the preflight, so the export's own
// "open an image first" refusal still reaches the user.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isPythonError } from "../../web/js/runtime-errors.ts";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { chirpImagesDir } from "../support/repo-paths.mjs";

const AM_ROW = { Location: "306", Name: "TOWER", Frequency: "118.300000", Mode: "AM" };

// The rejection a runtime call ends in, or null when it succeeds.
function rejectionOf(promise) {
  return promise.then(() => null, (error) => error);
}

test("the preflight names the Mode cell the binary export refuses", async () => {
  // No KG-XS20G image ships with CHIRP; the KG-935G Plus is the same driver
  // family and memory layout, with the same FM/NFM-only modes.
  const harness = await sharedHarness();
  await ensureModule(harness, "kg935g");
  const image = readFileSync(path.join(chirpImagesDir, "Wouxun_KG-935G_Plus.img"));
  const { sessionId, className } = await harness.rpc("load_image_base64", { image_b64: image.toString("base64") });
  assert.equal(className, "KG935GPlusRadio");

  const preflight = await harness.rpc("validate_rows_for_upload", {
    session_id: sessionId,
    rows: [{ ...AM_ROW }, { ...AM_ROW, Location: "305", Mode: "NFM" }],
  });
  assert.equal(preflight.valid, false);
  assert.deepEqual(preflight.issues, [
    { rowIndex: 0, column: "Mode", message: "Mode AM not supported" },
  ]);

  const error = await rejectionOf(
    harness.rpc("export_image_base64", { session_id: sessionId, rows: [{ ...AM_ROW }], settings_groups: [] }),
  );
  assert.ok(isPythonError(error, "RuntimeUnsupportedError"));
  assert.equal(error.message, "Channel 306: Mode AM not supported");

  const exported = await harness.rpc("export_image_base64", {
    session_id: sessionId,
    rows: [{ ...AM_ROW, Mode: "NFM" }],
    settings_groups: [],
  });
  assert.ok(exported.size > 0);
  await harness.rpc("close_session", { session_id: sessionId });
});

test("a radio with no image to check against leaves the export's own refusal to the export", async (t) => {
  // A fresh KG-XS20G Plus session: kg935g declares no image size, so with
  // nothing downloaded or opened its blank radio cannot read a memory.
  const harness = await sharedHarness();
  await ensureModule(harness, "kg935g");
  const { sessionId } = await harness.rpc("open_session", {
    module_name: "kg935g",
    class_name: "KGXS20GPlusRadio",
  });

  // The harness prints the runtime's debug panel lines to stdout.
  const logged = t.mock.method(console, "log", () => {});
  const preflight = await harness.rpc("validate_rows_for_upload", {
    session_id: sessionId,
    rows: [{ ...AM_ROW, Mode: "NFM" }],
  });
  logged.mock.restore();
  assert.deepEqual(preflight, { valid: true, issues: [], warnings: [] });
  // Nothing after the probe sees this radio, so its traceback is the only
  // record of why the driver's own checks were skipped.
  const fallback = logged.mock.calls
    .map((call) => String(call.arguments[0]))
    .find((line) => line.includes("ROW CHECK column rules only"));
  assert.ok(fallback, "the fallback to column rules is logged");
  assert.match(fallback, /Traceback \(most recent call last\)/);
  assert.match(fallback, /'NoneType' object has no attribute 'memory'/);

  const error = await rejectionOf(
    harness.rpc("export_image_base64", {
      session_id: sessionId,
      rows: [{ ...AM_ROW, Mode: "NFM" }],
      settings_groups: [],
    }),
  );
  assert.ok(isPythonError(error, "RuntimePreconditionError"));
  assert.match(error.message, /open an image file first/);
  await harness.rpc("close_session", { session_id: sessionId });
});
