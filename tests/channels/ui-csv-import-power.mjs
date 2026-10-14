// Loading a CSV hands the selected radio's session to the parser, which moves
// each channel's power onto that radio's levels (tests/channels/csv-import-power.mjs
// covers the runtime side), and the status line says how many it moved.
import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { flushMicrotasks, importSampleCsv, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const RADIO = {
  vendor: "Wouxun",
  model: "KG-1000G Plus",
  module: "kguv980p",
  className: "KG1000GPlusRadio",
  key: "kguv980p:KG1000GPlusRadio",
  isLiveRadio: false,
};

const HEADERS = ["Location", "Name", "Power"];

// Boots the UI on a stub whose parser records what it was asked for and
// reports two channels moved whenever it was given a radio.
async function bootUi() {
  const parseCalls = [];
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => ({
      supported: false,
      available: false,
      requiresImage: false,
      message: "",
      groups: [],
    }),
    // The session arrives translated back into the radio it was opened for.
    parseCsv: async ({ module, className }) => {
      parseCalls.push([module, className]);
      return {
        headers: HEADERS,
        rows: [
          { Location: "1", Name: "A", Power: module ? "L" : "5.0W" },
          { Location: "2", Name: "B", Power: module ? "M" : "15W" },
        ],
        errors: [],
        powerAdjusted: module ? 2 : 0,
      };
    },
  }));
  await ui.init(true);
  return { parseCalls };
}

// The status lines a channel load wrote, leaving out the catalog's own
// "Loaded N radio definitions".
function statusLines(document) {
  return document.querySelector("#debug-output").value.split("\n").filter((line) => /STATUS Loaded \d+ channel/.test(line));
}

test("a CSV loaded for a selected radio is parsed against its session and says how many powers moved", async () => {
  const { document } = installIndexPage();
  const { parseCalls } = await bootUi();
  selectRadioBySearch(document, "KG-1000G Plus");
  await flushMicrotasks();

  await importSampleCsv(document);

  assert.deepEqual(parseCalls, [[RADIO.module, RADIO.className]]);
  assert.deepEqual(globalThis.currentRows.map((row) => row.Power), ["L", "M"]);
  const [status] = statusLines(document);
  assert.match(status, /Loaded 2 channel\(s\)\. Power set to this radio's closest level on 2\.$/);
});

test("a CSV loaded with no radio selected is parsed without a session and reports no power change", async () => {
  const { document } = installIndexPage();
  const { parseCalls } = await bootUi();

  await importSampleCsv(document);

  assert.deepEqual(parseCalls, [[undefined, undefined]]);
  const [status] = statusLines(document);
  assert.match(status, /Loaded 2 channel\(s\)\.$/);
});
