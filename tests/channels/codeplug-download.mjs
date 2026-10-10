import assert from "node:assert/strict";
import test from "node:test";

import { DOWNLOAD_URL_LIFETIME_MS } from "../../web/js/ui/codeplug-io.ts";
import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

// Firefox and Safari read an export's blob only after the anchor's click()
// returns, so these tests check what the browser needs at that moment: the
// anchor is in the document when clicked, and its object URL is still live
// until the revoke timer fires.

const RADIO = {
  vendor: "Acme",
  model: "Alpha",
  module: "alpha",
  className: "AlphaRadio",
  key: "alpha:AlphaRadio",
  isLiveRadio: false,
};

// The runtime calls an export reaches, answering with fixed file contents.
function runtimeApi() {
  return withRadioSessions({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
    getRadioSettings: async () => ({
      supported: false,
      available: false,
      requiresImage: false,
      message: "",
      groups: [],
    }),
    normalizeRows: async () => "Location,Name\n0,Exported\n",
    exportImage: async () => ({ imageBase64: "AQID", settings: [] }),
  });
}

// Replaces the object-URL functions and the anchor's click with recorders,
// restoring them when the test ends. jsdom would otherwise try to navigate.
function recordDownloads(t, window) {
  const record = { created: [], revoked: [], clicks: [] };
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${record.created.length}`;
    record.created.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = (url) => { record.revoked.push(url); };
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function click() {
    record.clicks.push({
      href: this.getAttribute("href"),
      download: this.download,
      connected: this.isConnected,
      revokedAtClick: record.revoked.includes(this.getAttribute("href")),
    });
  };
  t.after(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    window.HTMLAnchorElement.prototype.click = anchorClick;
  });
  return record;
}

// Boots the page with the fake runtime, then installs the recorders and
// fake timers so only the export's own setTimeout is held back.
async function bootUi(t) {
  const { window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(runtimeApi());
  await ui.init(true);
  const record = recordDownloads(t, window);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { document: window.document, record };
}

// Asserts one click happened on an attached anchor with a live URL, that the
// anchor is gone afterwards, and that the URL is revoked only once the
// lifetime has passed.
async function assertDeferredRevoke(t, document, record, expected) {
  assert.equal(record.clicks.length, 1);
  const [click] = record.clicks;
  assert.equal(click.connected, true, "the anchor must be in the document when clicked");
  assert.equal(click.revokedAtClick, false);
  assert.match(click.download, expected.fileName);
  assert.equal(document.querySelector(`a[href="${click.href}"]`), null, "the anchor is removed again");

  const [{ blob }] = record.created;
  assert.equal(blob.type, expected.type);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected.bytes);

  assert.deepEqual(record.revoked, [], "the URL must outlive the click");
  t.mock.timers.tick(DOWNLOAD_URL_LIFETIME_MS - 1);
  assert.deepEqual(record.revoked, []);
  t.mock.timers.tick(1);
  assert.deepEqual(record.revoked, [click.href]);
}

test("a CSV export keeps its URL alive until the browser has read it", async (t) => {
  const { document, record } = await bootUi(t);
  await dispatch(document.querySelector("#export-csv"), "click");
  await assertDeferredRevoke(t, document, record, {
    fileName: /\.csv$/,
    type: "text/csv;charset=utf-8",
    bytes: new TextEncoder().encode("Location,Name\n0,Exported\n"),
  });
});

test("an .img export keeps its URL alive until the browser has read it", async (t) => {
  const { document, record } = await bootUi(t);
  selectRadioBySearch(document, "Acme Alpha");
  await flushMicrotasks();
  await dispatch(document.querySelector("#export-binary"), "click");
  await assertDeferredRevoke(t, document, record, {
    fileName: /\.img$/,
    type: "application/octet-stream",
    bytes: new Uint8Array([1, 2, 3]),
  });
});
