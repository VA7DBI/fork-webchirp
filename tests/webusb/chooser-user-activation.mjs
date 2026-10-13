import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSerialBridge } from "../../web/js/serial.ts";
import { USER_GESTURE_REQUIRED } from "../../web/js/serial-errors.ts";
import { classifyErrorKind } from "../../web/js/ui/analytics.ts";
import { queryUiElements } from "../../web/js/ui/dom.ts";
import { makeRecordingPort } from "../support/fake-serial.mjs";
import { withNavigator } from "../support/globals.mjs";
import { installIndexPage } from "../support/index-page.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";
import { createDeferred, dispatch, flushMicrotasks } from "../support/ui-interactions.mjs";

// A browser shows its port chooser only while the page holds transient user
// activation -- about five seconds after a click in Chrome. The Connect click
// used to reach the chooser only through the runtime call queue and Python,
// and on a phone whose upload was still timing out the chooser ran eleven
// seconds after the click and was refused (WEBCHIRP-FRONTEND-1W). The fake
// providers here read navigator.userActivation and refuse as Chrome does.

// What Chrome rejects a chooser with when activation is missing. Node has no
// DOMException guarantee worth relying on, so build the same observable shape.
function securityError(message) {
  const error = new Error(message);
  error.name = "SecurityError";
  return error;
}

// A WebUSB provider whose chooser behaves like navigator.usb.requestDevice:
// refused without activation, otherwise handing over the next port. Records
// every time it is asked.
function makeProvider(ports) {
  const provider = {
    asked: 0,
    async requestPort() {
      provider.asked += 1;
      if (!globalThis.navigator.userActivation.isActive) {
        throw securityError("Failed to execute 'requestDevice' on 'USB': Must be handling a user gesture to show a permission request.");
      }
      return ports.shift();
    },
  };
  return provider;
}

// The page's serial controls on an Android phone with WebUSB only, wired to a
// real BrowserSerialBridge over provider the way web/app.ts wires it, and a
// runtime whose connect waits on queue -- the runtime call queue, held by
// whatever is ahead of it -- before calling the bridge's open() as
// webserial_connect does.
async function makeConnectPage({ provider, queue = Promise.resolve() }) {
  const activation = { isActive: false, hasBeenActive: true };
  installIndexPage({
    navigator: {
      userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/154.0.0.0 Mobile Safari/537.36",
      maxTouchPoints: 5,
      usb: {},
      userActivation: activation,
    },
  });
  const bridge = new BrowserSerialBridge({ createWebUsbSerial: () => provider });
  const calls = { runtime: 0, errors: [], cancelled: [] };
  const ctx = {
    dom: queryUiElements(),
    state: {
      selectedRadio: {
        vendor: "Baofeng",
        model: "UV-5RM Plus",
        module: "baofeng_uv17Pro",
        className: "BaofengUV5RMPlus",
        baudRate: 115200,
      },
      runtimeApi: {
        async serialConnect({ baudRate }) {
          calls.runtime += 1;
          await queue;
          return bridge.open(baudRate);
        },
        serialDisconnect: async () => bridge.close(),
      },
    },
    log: {
      setStatus() {},
      logDebug() {},
      logSerial() {},
      reportActionError(action, error) {
        calls.errors.push([action, error]);
      },
      reportActionCancelled(action, message) {
        calls.cancelled.push([action, message]);
      },
    },
    actions: {},
    settings: { hasInvalidSettings: () => false },
  };
  const { createSerialActions } = await import("../../web/js/ui/serial-actions.ts");
  const serial = createSerialActions(ctx);
  serial.setSerialController({
    capability: bridge.getCapability(),
    choosePort: (transport) => bridge.choosePort(transport),
  });
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  return { activation, calls, ctx };
}

test("Connect shows the chooser inside the click, before the runtime queue releases it", async () => {
  const port = makeRecordingPort();
  const queue = createDeferred();
  const provider = makeProvider([port]);
  const { activation, calls, ctx } = await makeConnectPage({ provider, queue: queue.promise });
  const button = ctx.dom.webusbConnectToggleEl;
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);

  // The click: activation is live only while it is being handled.
  activation.isActive = true;
  const clicked = dispatch(button, "click");
  activation.isActive = false;
  // The chooser was asked for before the handler first awaited.
  assert.equal(provider.asked, 1);

  await flushMicrotasks();
  // The connect is now waiting on the runtime -- a driver import ahead of
  // it, say -- long after the click's activation lapsed, holding the port it
  // was given.
  assert.equal(calls.runtime, 1);
  assert.equal(port.opens.length, 0);

  queue.resolve();
  await clicked;

  assert.deepEqual(calls.errors, []);
  // Opened from the held port, at the radio's rate, with no second chooser.
  assert.equal(provider.asked, 1);
  assert.deepEqual(port.opens.map((options) => options.baudRate), [115200]);
  assert.equal(button.textContent, "Disconnect");
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
});

test("a dismissed chooser never reaches the runtime", async () => {
  const provider = {
    async requestPort() {
      const dismissed = new Error("No device selected.");
      dismissed.name = "NotFoundError";
      throw dismissed;
    },
  };
  const { activation, calls, ctx } = await makeConnectPage({ provider });

  activation.isActive = true;
  const clicked = dispatch(ctx.dom.webusbConnectToggleEl, "click");
  activation.isActive = false;
  await clicked;

  // Closing a dialog costs no wait behind the runtime queue, and no Python.
  assert.equal(calls.runtime, 0);
  assert.equal(calls.cancelled.length, 1);
  assert.deepEqual(calls.errors, []);
  assert.equal(ctx.dom.webusbConnectToggleEl.disabled, false);
});

test("an adapter unplugged while the connect waits is a disconnect, not a dismissed chooser", async () => {
  // The port is picked in the click but opened only once the runtime reaches
  // the connect. WebUSB refuses open() on a device unplugged in between with
  // NotFoundError, the name a dismissed chooser has before the bridge renames
  // it; the chip drivers keep it (WebUsbTransport._openDevice).
  const gone = new Error("CH340: could not open USB device: The device was disconnected.");
  gone.name = "NotFoundError";
  const port = makeRecordingPort({ failOpenWhen: () => gone });
  const { activation, calls, ctx } = await makeConnectPage({ provider: makeProvider([port]) });

  activation.isActive = true;
  const clicked = dispatch(ctx.dom.webusbConnectToggleEl, "click");
  activation.isActive = false;
  await clicked;

  assert.deepEqual(calls.cancelled, []);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], "Serial connect");
  assert.equal(classifyErrorKind(calls.errors[0][1]), "serial_disconnect");
  assert.equal(ctx.dom.webusbConnectToggleEl.textContent, "Connect via WebUSB (wired adapter)");
});

test("a chooser asked for after the activation lapsed is named for it, not as a denied permission", async (t) => {
  const provider = makeProvider([]);
  withNavigator(t, { usb: {}, userActivation: { isActive: false, hasBeenActive: true } });
  const bridge = new BrowserSerialBridge({ createWebUsbSerial: () => provider });
  bridge.setPreferredTransport("webusb");

  // What happened before: open() reached without a chooser picked in the click.
  const error = await bridge.open(9600).then(() => null, (thrown) => thrown);
  assert.equal(error?.name, USER_GESTURE_REQUIRED);
  assert.equal(error.cause?.name, "SecurityError");
  // The debug panel prints the message, so the browser's own sentence stays in it.
  assert.match(error.message, /Press Connect again/);
  assert.match(error.message, /Must be handling a user gesture/);
  assert.equal(classifyErrorKind(error), "user_gesture_required");
  assert.equal(bridge.port, null);

  // And the same name read off a JsException, for a chooser reached through Python.
  const crossed = runtimeCallError("JsException", `${USER_GESTURE_REQUIRED}: ${error.message}`, {
    js: { name: USER_GESTURE_REQUIRED, message: error.message },
  }, "webserial_connect");
  assert.equal(classifyErrorKind(crossed), "user_gesture_required");
});

test("a SecurityError while the click is live keeps its name and stays permission_denied", async (t) => {
  // A permissions policy that blocks WebUSB refuses the chooser with the same
  // name, inside a perfectly good click; that one is a real permission refusal.
  const refusal = securityError("Access to the feature \"usb\" is disallowed by permissions policy.");
  withNavigator(t, { usb: {}, userActivation: { isActive: true, hasBeenActive: true } });
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({
      requestPort: async () => {
        throw refusal;
      },
    }),
  });

  const error = await bridge.choosePort("webusb").then(() => null, (thrown) => thrown);
  assert.equal(error, refusal);
  assert.equal(classifyErrorKind(error), "permission_denied");
});

test("a picked port serves one open; the next connect asks again", async (t) => {
  const first = makeRecordingPort();
  const second = makeRecordingPort();
  const provider = makeProvider([first, second]);
  const activation = { isActive: true, hasBeenActive: true };
  withNavigator(t, { usb: {}, userActivation: activation });
  const bridge = new BrowserSerialBridge({ createWebUsbSerial: () => provider });

  await bridge.choosePort("webusb");
  assert.equal(provider.asked, 1);
  activation.isActive = false;
  const connected = await bridge.open(9600);
  assert.equal(connected.connected, true);
  assert.equal(bridge.port, first);
  assert.equal(provider.asked, 1);

  // Pressing Connect while the bridge still holds a live port offers nothing:
  // open() would reuse that port and ignore whatever was picked.
  activation.isActive = true;
  await bridge.choosePort("webusb");
  assert.equal(provider.asked, 1);

  await bridge.close();
  await bridge.choosePort("webusb");
  assert.equal(provider.asked, 2);
  await bridge.open(9600);
  assert.equal(bridge.port, second);
  await bridge.close();
});
