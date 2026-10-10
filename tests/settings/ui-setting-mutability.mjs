import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const CATALOG = [{
  vendor: "Acme", model: "Mixed", variant: "",
  module: "mixed", className: "Radio", key: "mixed:Radio", isLiveRadio: false,
}];

// One setting with two values, only the second of which the driver locked:
// the shape a CHIRP RadioSetting takes when it holds a list of values.
const MIXED_SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [{
    kind: "group", id: "basic", label: "Basic", path: ["basic"],
    children: [{
      kind: "setting", id: "pair", label: "Pair", path: ["basic", "pair"],
      doc: null, volatile: false, warning: null,
      values: [
        { type: "string", current: "Open", mutable: true, index: 0 },
        { type: "string", current: "Locked", mutable: false, index: 1 },
      ],
    }],
  }],
};

test("one immutable value of a multi-value setting leaves the others editable", async () => {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => MIXED_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Mixed");
  await flushMicrotasks();

  const inputs = Array.from(document.querySelector("#settings-content").querySelectorAll("input"));
  assert.deepEqual(inputs.map((input) => input.value), ["Open", "Locked"]);
  assert.deepEqual(inputs.map((input) => input.disabled), [false, true]);
  assert.deepEqual(
    inputs.map((input) => input.closest(".settings-field-control").classList.contains("is-immutable")),
    [false, true],
  );
});
