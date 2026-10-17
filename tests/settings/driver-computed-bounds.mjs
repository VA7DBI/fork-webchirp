import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

// The FT1D family (ft1d.FT1Radio and every ft2d class, FT5D included) replaces
// each SmartBeacon low speed's get_max with one computed from the profile's
// high speed (chirp/chirp/drivers/ft1d.py:1778):
//
//     low_val.get_max = lambda: min(30, int(high_val.get_value()) - 1)
//
// A high speed byte outside 3..90 leaves high_val uninitialized, so the lambda
// reaches int(None). Serializing that bound used to raise out of the whole
// settings tree, and with it out of every load, download and export of the
// radio -- WEBCHIRP-FRONTEND-2G was a from-scratch FT5D binary export, whose
// zeroed map holds 0 in every high speed.
const LOW_SPEED_DECLARED_MAX = 30;
const FT5D_IMAGE = "Yaesu_FT5D_R.img";

// The debug panel is serial_log on the jsbridge module that owns it: _log_debug
// resolves the name there, so patching the flattened global would miss it.
const CAPTURE_LOG = `
_captured_log = []
_real_serial_log = jsbridge.serial_log
jsbridge.serial_log = lambda message: _captured_log.append(str(message))
`;
const RELEASE_LOG = `
jsbridge.serial_log = _real_serial_log
json.dumps(_captured_log)
`;

// Run fn with the debug panel captured, and hand back what fn returned
// together with every line the runtime logged meanwhile.
async function withCapturedLog(harness, fn) {
  await harness.runPython(CAPTURE_LOG);
  let result;
  try {
    result = await fn();
  } catch (error) {
    await harness.runPython(RELEASE_LOG);
    throw error;
  }
  return { result, log: JSON.parse(await harness.runPython(RELEASE_LOG)) };
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

// The id the FT1D-family driver gives a SmartBeacon profile's low speed
// (ft1d.py builds it from "aprs.smartbeaconing_profile[%d]"), spelled once so
// every assertion looks up the same setting the driver's lambda is attached to.
function lowSpeedId(profile) {
  return `aprs.smartbeaconing_profile[${profile}].low_speed_mph`;
}

test("a bound getter that raises falls back to the bound the value declared", async () => {
  const harness = await sharedHarness();
  const { result, log } = await withCapturedLog(harness, async () =>
    harness.runPythonJson(`
from chirp import settings as _cs

def _raises():
    raise TypeError("sibling never initialized")

# A value initializes when its RadioSetting is built, as in any driver.
_integer = _cs.RadioSettingValueInteger(2, 30, 5)
_integer.get_max = _raises
_float = _cs.RadioSettingValueFloat(0.5, 9.5, 1.0)
_float.get_min = _raises
_settings = [
    _cs.RadioSetting("probe.integer", "Integer", _integer),
    _cs.RadioSetting("probe.float", "Float", _float),
]

json.dumps({
    "integer": _serialize_setting_node(_settings[0], [])["values"][0],
    "float": _serialize_setting_node(_settings[1], [])["values"][0],
})
`),
  );

  assert.equal(result.integer.max, 30, "the integer keeps its declared maximum");
  assert.equal(result.integer.min, 2, "a getter that works is still read");
  assert.equal(result.integer.current, 5);
  assert.equal(result.float.min, 0.5, "the float keeps its declared minimum");
  assert.equal(result.float.max, 9.5);

  const integerLine = log.find((line) => line.includes("probe.integer"));
  assert.ok(integerLine, "the failure is reported in the debug panel");
  assert.match(integerLine, /get_max\(\)/);
  assert.match(integerLine, /sibling never initialized/, "with the driver's traceback");
  assert.ok(log.some((line) => line.includes("probe.float") && line.includes("get_min()")));
});

test("an FT5D binary export from scratch gets past the SmartBeacon low-speed bound", async () => {
  const harness = await sharedHarness();
  const { result: exported, log } = await withCapturedLog(harness, () =>
    harness.exportCodeplugBinary("ft2d", "FT5D", [], []),
  );

  assert.ok(exported.image.length > 0, "the export should produce an image");
  for (const profile of [0, 1, 2]) {
    const setting = findSetting(exported.settings, lowSpeedId(profile));
    assert.ok(setting, `${lowSpeedId(profile)} is still in the settings tree`);
    assert.equal(setting.values[0].max, LOW_SPEED_DECLARED_MAX);
  }
  assert.ok(
    log.some((line) => line.includes(lowSpeedId(2)) && line.includes("ft1d.py")),
    "the debug panel names the setting and the driver line that raised",
  );
});

test("an FT5D image with an out-of-range SmartBeacon high speed still loads its settings", async () => {
  const harness = await sharedHarness();
  const catalog = await readCatalog();
  const { loaded } = await loadImageFor(harness, catalog, FT5D_IMAGE);
  assert.equal(
    findSetting(loaded.settings, lowSpeedId(2)).values[0].initialized,
    true,
    "the upstream fixture's SmartBeacon profiles are all in range",
  );

  // The last profile is the one to break: the lambda is created in a loop and
  // reads high_val when called, so every profile's low speed currently asks
  // the last profile's high speed for its bound. Only the last profile's own
  // low speed is asserted on, which stays right once upstream binds each
  // lambda to its own profile.
  const corrupted = await harness.runPython(
    `
import base64
_session = resolve_session(_session_id)
_radio = _session.radio_instance()
_radio._memobj.aprs.smartbeaconing_profile[2].high_speed_mph = 0
base64.b64encode(_image_bytes_from_radio(_radio)).decode("ascii")
`,
    { _session_id: loaded.sessionId },
  );

  const { result: reloaded } = await withCapturedLog(harness, () =>
    harness.loadCodeplugBinary(Buffer.from(corrupted, "base64")),
  );
  assert.equal(reloaded.rows.length, loaded.rows.length, "the channels still load");
  const lowSpeed = findSetting(reloaded.settings, lowSpeedId(2));
  assert.ok(lowSpeed, "the settings tree is reported, not dropped");
  assert.equal(lowSpeed.values[0].max, LOW_SPEED_DECLARED_MAX);
  const highSpeed = findSetting(
    reloaded.settings,
    "aprs.smartbeaconing_profile[2].high_speed_mph",
  );
  assert.equal(highSpeed.values[0].initialized, false, "the bad byte is shown as unloaded");
});
