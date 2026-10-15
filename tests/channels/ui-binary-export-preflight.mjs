import assert from "node:assert/strict";
import test from "node:test";

// A binary export writes the grid into the radio's image the way an upload
// writes it to the radio (_apply_rows_to_radio_instance,
// web/python/webchirp_bridge/radio_memories.py), so a value the driver refuses
// fails both. Issue #266: a channel with Mode AM, carried over from a radio
// that has it to a Wouxun KG-XS20G Plus, which has only FM and NFM, blocked
// Upload as a red cell, but Export reached the runtime and came back as
// "BINARY EXPORT ERROR RuntimeUnsupportedError" with a traceback. The export
// now runs the upload's preflight first; the runtime here is a stand-in whose
// preflight answer each test sets.
import { installIndexPage } from "../support/index-page.mjs";
import {
  channelRows,
  dispatch,
  flushMicrotasks,
  importSampleCsv,
  selectRadioBySearch,
} from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const HEADERS = ["Location", "Name", "Frequency", "Mode"];
const ROWS = [
  { Location: "305", Name: "GMRS 1", Frequency: "462.562500", Mode: "FM" },
  { Location: "306", Name: "TOWER", Frequency: "118.300000", Mode: "AM" },
];
const RADIO = {
  vendor: "Wouxun",
  model: "KG-XS20G Plus",
  module: "kg935g",
  className: "KGXS20GPlusRadio",
  key: "kg935g:KGXS20GPlusRadio",
  isLiveRadio: false,
};
const AM_REFUSED = { rowIndex: 1, column: "Mode", message: "Mode AM not supported" };

// Boots the real page against a runtime whose row preflight reports
// rowIssues, recording every export it is asked for.
async function bootUi(t, rowIssues) {
  const { window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const exports = [];
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: ROWS.map((row) => ({ ...row })), errors: [] }),
    validateRowsForUpload: async () => ({ valid: rowIssues.length === 0, issues: rowIssues, warnings: [] }),
    validateRadioSettings: async () => ({ valid: true, issues: [], settings: [], available: false }),
    exportImage: async (payload) => {
      exports.push(payload);
      return { imageBase64: "AQID", settings: [], vendor: RADIO.vendor, model: RADIO.model };
    },
  }));
  await ui.init(true);
  // A successful export saves through an object URL and revokes it a minute
  // later; neither exists in jsdom, and the timer would hold the process open.
  const { createObjectURL, revokeObjectURL } = URL;
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:test/0";
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    window.HTMLAnchorElement.prototype.click = anchorClick;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = window.document;
  selectRadioBySearch(document, "Wouxun KG-XS20G Plus");
  await flushMicrotasks();
  await importSampleCsv(document);
  return { document, exports };
}

// The grid cell for a column of the row showing rowIdx.
function cell(document, rowIdx, column) {
  const row = channelRows(document).find((tr) => tr.dataset.rowIdx === String(rowIdx));
  return row?.querySelector(`td[data-column="${column}"]`);
}

test("a value the radio refuses blocks the binary export as a highlighted cell", async (t) => {
  const { document, exports } = await bootUi(t, [AM_REFUSED]);

  await dispatch(document.querySelector("#export-binary"), "click");

  assert.equal(exports.length, 0, "the image is not built from rows the driver refuses");
  assert.equal(cell(document, 1, "Mode").classList.contains("is-invalid"), true);
  assert.equal(cell(document, 0, "Mode").classList.contains("is-invalid"), false);
  const debug = document.querySelector("#debug-output").value;
  assert.match(debug, /STATUS Export blocked: 1 invalid value\(s\) highlighted in red in channels\./);
  assert.match(debug, /PREFLIGHT INVALID channel=306 column=Mode: Mode AM not supported/);
  assert.doesNotMatch(debug, /BINARY EXPORT ERROR/);
});

test("rows the radio accepts are exported after the preflight", async (t) => {
  const { document, exports } = await bootUi(t, []);

  await dispatch(document.querySelector("#export-binary"), "click");

  assert.equal(exports.length, 1);
  assert.deepEqual(exports[0].rows.map((row) => row.Mode), ["FM", "AM"]);
  assert.match(document.querySelector("#debug-output").value, /STATUS Exported Wouxun_KG-XS20G_Plus_\d{8}\.img/);
});
