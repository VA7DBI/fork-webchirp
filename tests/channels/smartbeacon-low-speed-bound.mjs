import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, readImage, sharedHarness } from "../support/chirp.mjs";
import { withCapturedDebugLog } from "../support/debug-log-capture.mjs";

// ft1d.py and vx8.py bound each SmartBeacon profile's low speed with a lambda
// built inside the profile loop:
//
//     low_val.get_max = lambda: min(30, int(high_val.get_value()) - 1)
//
// It reads high_val when called, so every profile is bounded by the last
// profile's high speed; and when that high speed never initialized -- every
// zeroed map -- it raises on int(None), which failed a from-scratch FT5D
// binary export (Sentry WEBCHIRP-FRONTEND-2G). The fix is a workaround per
// driver module (web/python/webchirp_bridge/workarounds/ft1d.py and vx8.py,
// FINDINGS ft1d-smartbeacon-low-speed-bound); the last test shows the drivers
// still need it.

// Each upstream fixture's profiles hold high speeds of 70, 30 and 12 mph, so a
// low speed bounded by its own profile has maxima 30, 29 and 11, and one bound
// by the last profile has 11 throughout.
const OWN_PROFILE_MAXIMA = [30, 29, 11];
const LAST_PROFILE_MAXIMA = [11, 11, 11];
const DECLARED_MAXIMA = [30, 30, 30];

// The driver module and class each fixture loads as, and the memory struct the
// driver names its SmartBeacon settings after. FT5D reaches ft1d's workaround
// through FT1Radio on its MRO, VX-8GE vx8's through VX8DRadio.
const FIXTURES = [
  { image: "Yaesu_FT5D_R.img", module: "ft2d", className: "FT5D", prefix: "aprs" },
  { image: "Yaesu_VX-8DR.img", module: "vx8", className: "VX8DRadio", prefix: "aprs2" },
  { image: "Yaesu_VX-8GE.img", module: "vx8", className: "VX8GERadio", prefix: "aprs2" },
];

// The settings id the driver gives one profile's low speed.
function lowSpeedId(prefix, profile) {
  return `${prefix}.smartbeaconing_profile[${profile}].low_speed_mph`;
}

// Find one setting in a serialized settings tree by its id.
function findSetting(nodes, id) {
  for (const node of nodes || []) {
    if (node.kind === "setting" && node.id === id) {
      return node;
    }
    const found = findSetting(node.children, id);
    if (found) {
      return found;
    }
  }
  return null;
}

// The maximum the serialized settings report for each profile's low speed.
function serializedLowSpeedMaxima(settings, prefix) {
  return [0, 1, 2].map((profile) => {
    const setting = findSetting(settings, lowSpeedId(prefix, profile));
    assert.ok(setting, `${lowSpeedId(prefix, profile)} should be in the settings tree`);
    return setting.values[0].max;
  });
}

// Load an upstream fixture the way a user opens the file: the driver is
// imported first, then the image picks its class by detection.
async function loadFixture(harness, fixture) {
  await ensureModule(harness, fixture.module);
  const loaded = await harness.loadCodeplugBinary(await readImage(fixture.image));
  assert.equal(`${loaded.module}.${loaded.className}`, `${fixture.module}.${fixture.className}`);
  return loaded;
}

// A new session for the driver with no image on it, which is what the radio
// picker opens before anything is downloaded or loaded.
async function blankSession(harness, fixture) {
  await ensureModule(harness, fixture.module);
  const opened = await harness.rpc("open_session", {
    module_name: fixture.module,
    class_name: fixture.className,
  });
  return opened.sessionId;
}

const FALLBACK_LINE = /raised, showing the declared bound/;

for (const fixture of FIXTURES) {
  test(`${fixture.className}: each low speed is bounded by its own profile's high speed`, async () => {
    const harness = await sharedHarness();
    const { result: loaded, log } = await withCapturedDebugLog(harness, () =>
      loadFixture(harness, fixture),
    );
    assert.deepEqual(serializedLowSpeedMaxima(loaded.settings, fixture.prefix), OWN_PROFILE_MAXIMA);
    assert.ok(!log.some((line) => FALLBACK_LINE.test(line)), "no bound getter raised");
  });

  test(`${fixture.className}: a from-scratch binary export bounds the low speeds by their declared maximum`, async () => {
    const harness = await sharedHarness();
    const sessionId = await blankSession(harness, fixture);
    try {
      const { result: exported, log } = await withCapturedDebugLog(harness, () =>
        harness.rpc("export_image_base64", { session_id: sessionId, rows: [], settings_groups: [] }),
      );
      assert.ok(exported.imageBase64.length > 0, "the export should produce an image");
      assert.deepEqual(serializedLowSpeedMaxima(exported.settings, fixture.prefix), DECLARED_MAXIMA);
      // The workaround answers for a high speed that never initialized, so the
      // serializer's generic fallback has nothing to catch.
      assert.ok(!log.some((line) => FALLBACK_LINE.test(line)), "no bound getter raised");
    } finally {
      await harness.rpc("close_session", { session_id: sessionId });
    }
  });

  test(`${fixture.className}: without its workaround, the driver still late-binds and raises`, async () => {
    // When this fails, the pinned CHIRP binds each profile's low-speed bound to
    // its own high speed, or no longer raises for one that never initialized:
    // delete the driver's module under workarounds/, its entry in the
    // get_settings hook, this file and its FINDINGS entry.
    const harness = await sharedHarness();
    const loaded = await loadFixture(harness, fixture);
    const sessionId = await blankSession(harness, fixture);
    try {
      const driver = await harness.runPythonJson(
        `
def _driver_low_speed_maxima(_session_id):
    # The driver's own get_settings, not the hook.
    _tree = resolve_session(_session_id).radio_instance().get_settings()
    _by_name = {str(_s.get_name()): _s for _group in _tree for _s in _group.walk()}
    _maxima = []
    for _profile in range(3):
        _low = _by_name["%s.smartbeaconing_profile[%d].low_speed_mph" % (_prefix, _profile)]
        try:
            _maxima.append(_low.value.get_max())
        except TypeError as _exc:
            _maxima.append("TypeError: " + str(_exc))
    return _maxima

json.dumps({
    "image": _driver_low_speed_maxima(_image_session),
    "blank": _driver_low_speed_maxima(_blank_session),
})
`,
        { _prefix: fixture.prefix, _image_session: loaded.sessionId, _blank_session: sessionId },
      );
      assert.deepEqual(driver.image, LAST_PROFILE_MAXIMA, "every profile reads the last high speed");
      for (const maximum of driver.blank) {
        assert.match(String(maximum), /^TypeError: int\(\) argument must be/);
      }
    } finally {
      await harness.rpc("close_session", { session_id: sessionId });
    }
  });
}
