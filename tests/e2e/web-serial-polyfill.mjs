// The CDC-ACM polyfill (web-serial-polyfill on jsDelivr) is the one serial
// transport whose code is not in this repo: CdcSerialPort
// (web/js/webusb-serial.ts) wraps it, and the unit suites can only run that
// wrapper around a stand-in, because Node cannot import the CDN module. The
// wrapper declares CDC_CAPABILITIES on the polyfill's behalf; this loads the
// pinned module itself in a real browser and holds it to that declaration
// against a fake USB CDC device, recording the class requests it sends. It
// needs the network, so it lives with the browser tests rather than in
// npm test. What it cannot show is whether a given adapter's firmware honours
// the line coding it is sent: that needs hardware.
import { expect, test } from "@playwright/test";

import { WEB_SERIAL_POLYFILL_URL } from "../../web/js/cdn-urls.ts";
import { CDC_CAPABILITIES } from "../../web/js/webusb-serial.ts";

// Opens the polyfill's SerialPort over a fake USB CDC device (control
// interface 2, data interface 3) in the page, runs the given steps and
// returns every control transfer the polyfill sent, or the error it threw.
// Runs in the browser: everything it needs is passed in or built here.
async function drivePolyfill(page, { openOptions, signals = null, controlStatus = "ok" }) {
  return page.evaluate(async ({ url, openOptions, signals, controlStatus }) => {
    const { SerialPort } = await import(url);
    const transfers = [];
    const device = {
      vendorId: 0x2341,
      productId: 0x0043,
      opened: false,
      configuration: null,
      configurations: [{
        interfaces: [
          {
            interfaceNumber: 2,
            alternates: [{
              interfaceClass: 2,
              endpoints: [{ direction: "in", type: "interrupt", endpointNumber: 3, packetSize: 8 }],
            }],
          },
          {
            interfaceNumber: 3,
            alternates: [{
              interfaceClass: 10,
              endpoints: [
                { direction: "in", type: "bulk", endpointNumber: 1, packetSize: 64 },
                { direction: "out", type: "bulk", endpointNumber: 2, packetSize: 64 },
              ],
            }],
          },
        ],
      }],
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async selectConfiguration() { this.configuration = this.configurations[0]; },
      async claimInterface() {},
      async controlTransferOut(setup, data) {
        transfers.push({
          ...setup,
          data: data ? Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength)) : null,
        });
        return { status: controlStatus, bytesWritten: data ? data.byteLength : 0 };
      },
      transferIn: () => new Promise(() => {}),
      async transferOut(endpoint, data) { return { status: "ok", bytesWritten: data.byteLength }; },
    };
    const port = new SerialPort(device);
    try {
      await port.open(openOptions);
      if (signals) {
        await port.setSignals(signals);
      }
    } catch (error) {
      return { error: String(error), transfers };
    }
    return { error: null, transfers };
  }, { url: WEB_SERIAL_POLYFILL_URL, openOptions, signals, controlStatus });
}

// The SET_LINE_CODING payload for 9600 baud and a frame, per CDC PSTN 1.2
// table 17: LE32 rate, bCharFormat (0 = 1 stop bit, 2 = 2), bParityType
// (0 none, 1 odd, 2 even), bDataBits.
function lineCoding(stopFormat, parityType, dataBits) {
  return [0x80, 0x25, 0x00, 0x00, stopFormat, parityType, dataBits];
}

test.beforeEach(async ({ page }) => {
  // Any page of the site gives the module an origin to load from.
  await page.goto("./about.html");
});

test("the wrapper declares framing, signals and reopen for the polyfill", () => {
  expect(CDC_CAPABILITIES).toEqual({ framing: true, signals: true, reconfigure: "reopen" });
});

for (const [label, options, payload] of [
  ["the 8N1 default", {}, lineCoding(0, 0, 8)],
  ["8E1", { dataBits: 8, parity: "even", stopBits: 1 }, lineCoding(0, 2, 8)],
  ["7E1", { dataBits: 7, parity: "even", stopBits: 1 }, lineCoding(0, 2, 7)],
  ["8N2", { dataBits: 8, parity: "none", stopBits: 2 }, lineCoding(2, 0, 8)],
  ["8O1", { dataBits: 8, parity: "odd", stopBits: 1 }, lineCoding(0, 1, 8)],
]) {
  test(`open() sends ${label} in SET_LINE_CODING`, async ({ page }) => {
    // capabilities.framing: true promises the frame open() is asked for is
    // the one sent to the device.
    const { error, transfers } = await drivePolyfill(page, {
      openOptions: { baudRate: 9600, ...options },
    });
    expect(error).toBeNull();
    expect(transfers[0]).toEqual({
      requestType: "class", recipient: "interface", request: 0x20, value: 0, index: 2, data: payload,
    });
  });
}

test("open() asserts DTR after the line coding, and setSignals() writes the full line state", async ({ page }) => {
  // capabilities.signals: true. SET_CONTROL_LINE_STATE carries DTR in bit 0
  // and RTS in bit 1, absolute. The polyfill raises DTR by itself at open,
  // before the bridge applies the radio's own line settings.
  const { error, transfers } = await drivePolyfill(page, {
    openOptions: { baudRate: 9600 },
    signals: { dataTerminalReady: false, requestToSend: true },
  });
  expect(error).toBeNull();
  expect(transfers.slice(1)).toEqual([
    { requestType: "class", recipient: "interface", request: 0x22, value: 0x01, index: 2, data: null },
    { requestType: "class", recipient: "interface", request: 0x22, value: 0x02, index: 2, data: null },
  ]);
});

test("open() refuses a frame outside Web Serial's and a refused line coding", async ({ page }) => {
  const mark = await drivePolyfill(page, { openOptions: { baudRate: 9600, parity: "mark" } });
  expect(mark.error).toContain("invalid parity mark");
  expect(mark.transfers).toEqual([]);

  // A device that stalls SET_LINE_CODING fails the open instead of running
  // at whatever frame it had.
  const stalled = await drivePolyfill(page, {
    openOptions: { baudRate: 9600, parity: "even" },
    controlStatus: "stall",
  });
  expect(stalled.error).toContain("Error setting up device");
});
