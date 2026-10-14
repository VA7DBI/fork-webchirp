// Loading a CSV hands the selected radio's session to the parser, which moves
// each channel's power onto that radio's levels (tests/channels/csv-import-power.mjs
// covers the runtime side), and the status line says how many it moved. The
// rows are applied only for the radio still selected when they land: a parse
// made for a radio the user has since left is made again for the current one.
import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, flushMicrotasks, importSampleCsv, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const RADIO = {
  vendor: "Wouxun",
  model: "KG-1000G Plus",
  module: "kguv980p",
  className: "KG1000GPlusRadio",
  key: "kguv980p:KG1000GPlusRadio",
  isLiveRadio: false,
};

const OTHER_RADIO = {
  vendor: "Baofeng",
  model: "UV-5R",
  module: "uv5r",
  className: "BaofengUV5R",
  key: "uv5r:BaofengUV5R",
  isLiveRadio: false,
};

const HEADERS = ["Location", "Name", "Power"];

// Boots the UI on a stub whose parser records which radio it was asked for and
// answers with that radio's own power label, so a test can tell whose rows
// were applied. With a radio it reports two channels moved. onParse runs
// inside the parse, before it answers, to act while it is in flight.
async function bootUi({ onParse = async () => {} } = {}) {
  const parseCalls = [];
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [RADIO, OTHER_RADIO] }),
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
      await onParse(parseCalls.length);
      const power = module ? `${module} low` : "5.0W";
      return {
        headers: HEADERS,
        rows: [
          { Location: "1", Name: "A", Power: power },
          { Location: "2", Name: "B", Power: power },
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

// The Power each channel row in the grid shows. Read from the page rather
// than globalThis.currentRows, which stays bound to the first UI a test file
// builds (web/js/ui/state.ts).
function importedPowers(document) {
  return [...document.querySelectorAll('#mem-table tbody tr[data-row-idx] td[data-column="Power"]')]
    .map((td) => td.querySelector("input, select")?.value);
}

test("a CSV loaded for a selected radio is parsed against its session and says how many powers moved", async () => {
  const { document } = installIndexPage();
  const { parseCalls } = await bootUi();
  selectRadioBySearch(document, "KG-1000G Plus");
  await flushMicrotasks();

  await importSampleCsv(document);

  assert.deepEqual(parseCalls, [[RADIO.module, RADIO.className]]);
  assert.deepEqual(importedPowers(document), ["kguv980p low", "kguv980p low"]);
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

test("a radio picked while the CSV is being parsed gets the file parsed again for it", async () => {
  const { document } = installIndexPage();
  const { parseCalls } = await bootUi({
    onParse: async (call) => {
      if (call === 1) {
        selectRadioBySearch(document, "UV-5R");
        await flushMicrotasks();
      }
    },
  });
  selectRadioBySearch(document, "KG-1000G Plus");
  await flushMicrotasks();

  await importSampleCsv(document);
  await flushMicrotasks();

  assert.deepEqual(parseCalls, [
    [RADIO.module, RADIO.className],
    [OTHER_RADIO.module, OTHER_RADIO.className],
  ]);
  assert.deepEqual(importedPowers(document), ["uv5r low", "uv5r low"], "the first radio's labels were never applied");
});

test("a radio picked while the replace-or-merge prompt is up gets the file parsed again for it", async () => {
  const { document } = installIndexPage();
  const { parseCalls } = await bootUi();
  selectRadioBySearch(document, "KG-1000G Plus");
  await flushMicrotasks();
  await importSampleCsv(document);
  assert.deepEqual(importedPowers(document), ["kguv980p low", "kguv980p low"]);

  // The editor now holds channels, so this load waits on the prompt.
  await importSampleCsv(document, "second.csv");
  assert.equal(document.querySelector("#import-choice-modal").classList.contains("hidden"), false);
  selectRadioBySearch(document, "UV-5R");
  await flushMicrotasks();
  await dispatch(document.querySelector("#import-choice-replace"), "click");
  await flushMicrotasks();

  assert.deepEqual(parseCalls.map(([module]) => module), [RADIO.module, RADIO.module, OTHER_RADIO.module]);
  assert.deepEqual(importedPowers(document), ["uv5r low", "uv5r low"]);
});
