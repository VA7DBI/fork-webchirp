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
  createDeferred,
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
// The radio the AM channel came from, to switch to while a check runs.
const SOURCE_RADIO = {
  vendor: "Wouxun",
  model: "KG-1000G Plus",
  module: "kguv980p",
  className: "KG1000GPlusRadio",
  key: "kguv980p:KG1000GPlusRadio",
  isLiveRadio: false,
};
const AM_REFUSED = { rowIndex: 1, column: "Mode", message: "Mode AM not supported" };
const SQUELCH_REFUSED = { path: ["basic", "squelch"], valueIndex: 0, message: "Squelch 12 is out of range" };

// Boots the real page against a runtime whose preflight reports rowIssues and
// settingIssues, recording every export it is asked for. validateRows, when
// given, answers the row check instead, so a test can hold it in flight.
async function bootUi(t, { rowIssues = [], settingIssues = [], validateRows = null } = {}) {
  const { window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const exports = [];
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [RADIO, SOURCE_RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: ROWS.map((row) => ({ ...row })), errors: [] }),
    validateRowsForUpload: validateRows
      || (async () => ({ valid: rowIssues.length === 0, issues: rowIssues, warnings: [] })),
    validateRadioSettings: async () => ({
      valid: settingIssues.length === 0,
      issues: settingIssues,
      settings: [],
      available: true,
    }),
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
  const { document, exports } = await bootUi(t, { rowIssues: [AM_REFUSED] });

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
  const { document, exports } = await bootUi(t);

  await dispatch(document.querySelector("#export-binary"), "click");

  assert.equal(exports.length, 1);
  assert.deepEqual(exports[0].rows.map((row) => row.Mode), ["FM", "AM"]);
  assert.match(document.querySelector("#debug-output").value, /STATUS Exported Wouxun_KG-XS20G_Plus_\d{8}\.img/);
});

test("a refused radio setting is named as one, whichever view is open", async (t) => {
  const { document, exports } = await bootUi(t, { settingIssues: [SQUELCH_REFUSED] });

  await dispatch(document.querySelector("#export-binary"), "click");

  assert.equal(exports.length, 0);
  const debug = document.querySelector("#debug-output").value;
  assert.match(debug, /STATUS Export blocked: 1 invalid value\(s\) highlighted in red in radio settings\./);
  assert.match(debug, /PREFLIGHT INVALID setting=basic\.squelch value=0: Squelch 12 is out of range/);
});

test("refused channels and settings are both counted where they are", async (t) => {
  const { document, exports } = await bootUi(t, { rowIssues: [AM_REFUSED], settingIssues: [SQUELCH_REFUSED] });

  await dispatch(document.querySelector("#export-binary"), "click");

  assert.equal(exports.length, 0);
  assert.match(
    document.querySelector("#debug-output").value,
    /STATUS Export blocked: 1 invalid value\(s\) highlighted in red in channels and 1 in radio settings\./,
  );
});

test("a radio picked while the export's preflight runs cancels the export", async (t) => {
  // The check is held in flight; the user picks the radio the channels came
  // from meanwhile. The held answer is about the KG-XS20G Plus's session,
  // which that pick closed, so it is neither shown nor exported against.
  const answer = createDeferred();
  const checked = [];
  const { document, exports } = await bootUi(t, {
    validateRows: (payload) => {
      checked.push(payload.className);
      return answer.promise;
    },
  });

  const click = dispatch(document.querySelector("#export-binary"), "click");
  await flushMicrotasks();
  assert.deepEqual(checked, ["KGXS20GPlusRadio"], "the check is in flight for the first radio");
  selectRadioBySearch(document, "Wouxun KG-1000G Plus");
  await flushMicrotasks();
  answer.resolve({ valid: false, issues: [AM_REFUSED], warnings: [] });
  await click;

  assert.equal(exports.length, 0);
  assert.equal(cell(document, 1, "Mode").classList.contains("is-invalid"), false, "the stale answer is not shown");
  const debug = document.querySelector("#debug-output").value;
  assert.match(debug, /STATUS Export cancelled: the selected radio changed\./);
  assert.match(debug, /PREFLIGHT discarded: the selected radio changed while it ran\./);
  assert.doesNotMatch(debug, /PREFLIGHT INVALID/);
});
