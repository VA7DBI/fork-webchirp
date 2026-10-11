// An RXF <repeater> may list several <mode> elements: przemienniki.net writes
// a dual-mode repeater as <mode>FM</mode><mode>DSTAR</mode>, 368 of its 638
// UK entries (jasiek/webchirp#244). The parser keeps every one of them, and
// the directory adapter hands the query's mode selection to the row builder,
// so a D-STAR search writes the DV side of such a repeater and an FM search
// its FM side.

import assert from "node:assert/strict";
import test from "node:test";

import { buildRepeaterEndpoints } from "../../web/js/datasources.ts";
import { repeaterRecordProblem } from "../../web/js/repeater-record.ts";
import { buildRepeaterRows } from "../../web/js/repeater-rows.ts";
import { parseRxfRecords, rxfPreferredModes } from "../../web/js/rxf.ts";
import { createRepeaterAdapters } from "../../web/js/ui/repeater-sources.ts";
import { installIndexPage } from "../support/index-page.mjs";
import { makeRowHooks } from "../support/row-hooks.mjs";

installIndexPage();

// GB3AA as przemienniki.net lists it, beside a single-mode FM entry.
const BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rxf version="1.0"><perspective>repeater</perspective><repeaters>
  <repeater><qra>GB3AA</qra><id>9045206</id><mode>FM</mode><mode>DSTAR</mode><band>2M</band>
    <qrg type="rx">145.0625</qrg><qrg type="tx">145.6625</qrg>
    <location><latitude>51.59</latitude><longitude>-2.54</longitude></location></repeater>
  <repeater><qra>GB3FM</qra><id>9045208</id><mode>FM</mode><band>2M</band>
    <qrg type="rx">145.0500</qrg><qrg type="tx">145.6500</qrg>
    <location><latitude>51.60</latitude><longitude>-2.50</longitude></location></repeater>
</repeaters></rxf>`;

const hooks = () => makeRowHooks({ optionsByColumn: { Mode: ["FM", "DV"] } });

test("an entry listing several modes keeps every one of them", () => {
  const { records } = parseRxfRecords(BODY, { source: "przemienniki" });
  const [dual, single] = records;
  assert.deepEqual(dual.modes, ["FM", "D-STAR"]);
  assert.equal(dual.modeLabel, "", "a multi-mode record names no single spelling");
  assert.deepEqual(dual.raw.modes, ["FM", "DSTAR"]);
  assert.deepEqual(single.modes, ["FM"]);
  assert.equal(single.modeLabel, "FM");
  for (const record of records) {
    assert.equal(repeaterRecordProblem(record), "", record.name);
  }
});

test("the searched mode picks the side of a dual-mode repeater a row is written in", () => {
  const { records } = parseRxfRecords(BODY, { source: "przemienniki" });
  const modeOf = (preferred) => buildRepeaterRows(records.slice(0, 1), hooks(), {
    preferredModes: rxfPreferredModes(preferred),
  }).rows[0].Mode;
  assert.equal(modeOf(["dstar"]), "DV");
  assert.equal(modeOf(["fm"]), "FM");
  // A search for both keeps the selection's order.
  assert.equal(modeOf(["dstar", "fm"]), "DV");
});

test("rxfPreferredModes maps spellings in order, once each, dropping unknown ones", () => {
  assert.deepEqual(rxfPreferredModes(["dstar", "FM", "fm", "nonsense"]), ["D-STAR", "FM"]);
  assert.deepEqual(rxfPreferredModes(["nonsense"], "other"), ["other"]);
});

test("the przemienniki.net adapter answers with the query's modes as preferred", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const requested = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url) => {
      requested.push(new URL(String(url)));
      return { ok: true, status: 200, text: async () => BODY };
    },
  });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "fetch", previous);
    } else {
      delete globalThis.fetch;
    }
  });
  const ctx = { log: { setStatus() {}, logDebug() {} } };
  const adapter = createRepeaterAdapters(ctx, { endpoints: buildRepeaterEndpoints("https://api.example.test") })
    .find((candidate) => candidate.id === "przemienniki");
  const values = {
    country: "", bands: [], modes: ["dstar"], only: false, radius: 30,
    position: { latitude: 51.5072, longitude: -0.1276 },
  };
  for (const purpose of ["import", "preview"]) {
    const answer = await adapter.query(values, purpose);
    assert.deepEqual(answer.preferredModes, ["D-STAR"], purpose);
    assert.equal(answer.records.length, 2, purpose);
  }
  assert.ok(requested.every((url) => url.searchParams.get("mode") === "dstar"));
});
