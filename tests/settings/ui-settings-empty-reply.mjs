import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { domEvent, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

// Issue 97: the runtime answers `settings: []` when it could not read a
// radio's settings at all -- validate_radio_settings says so with
// `available: false`, and upload and export echo [] for a driver whose
// re-parsed image has none. An empty array is truthy, so the panel used to
// take that reply as the new tree: the settings vanished and the next write
// carried none of the user's edits.

const CATALOG = [{
  vendor: "Acme", model: "Settings", variant: "",
  module: "acme", className: "Radio", key: "acme:Radio", isLiveRadio: false,
}];

const SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [{
    kind: "group", id: "basic", label: "Basic", path: ["basic"],
    children: [{
      kind: "setting", id: "name", label: "Name", path: ["basic", "name"],
      doc: null, volatile: false, warning: null,
      values: [{ type: "string", current: "Edited", mutable: true, initialized: true, index: 0 }],
    }],
  }],
};

test("an empty or unavailable settings reply keeps the panel's tree", async () => {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const uploads = [];
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => SETTINGS,
    validateRowsForUpload: async () => ({ valid: true, issues: [], warnings: [] }),
    validateRadioSettings: async () => ({
      valid: true, issues: [], settings: [], available: false, requiresImage: false,
      message: "Radio-wide settings are unavailable until this driver's backing state is loaded.",
      error: "driver refused",
    }),
    uploadSelectedRadio: async (payload) => {
      uploads.push(payload);
      return { uploaded: true, settings: [] };
    },
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Settings");
  await flushMicrotasks();

  const settingValues = () => Array.from(
    document.querySelector("#settings-content").querySelectorAll("input"),
  ).map((input) => input.value);
  assert.deepEqual(settingValues(), ["Edited"]);

  // The click a user makes; with no port connected the button is disabled,
  // but the handler is what is under test, as in ui-channel-bulk-edit.
  document.querySelector("#radio-upload").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();

  assert.equal(uploads.length, 1, "the preflight should have let the upload through");
  assert.deepEqual(
    uploads[0].settings,
    SETTINGS.groups,
    "the upload should carry the panel's tree, not the preflight's empty reply",
  );
  assert.deepEqual(settingValues(), ["Edited"], "the upload's empty echo should not clear the panel");
});
