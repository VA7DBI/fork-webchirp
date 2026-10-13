import assert from "node:assert/strict";
import test from "node:test";
import {
  FtdiSerialPort,
  ftdiBaudFamily,
  ftdiConvertBaudrate,
  ftdiDataValue,
} from "../../web/js/ftdi-webusb.ts";
import { makeFakeUsbDevice, okTransfer } from "../support/fake-usb.mjs";
import { tick } from "../support/globals.mjs";
import {
  expectFullPipeline,
  expectOnePacketPerTransfer,
  expectStallRecovery,
} from "../support/usb-read-path.mjs";
import {
  expectShortWriteResumed,
  expectStalledWriteFails,
  expectStuckWriteFails,
} from "../support/usb-write-path.mjs";

// A fake FTDI USBDevice: a bulk pair (plus whatever endpoints the test adds),
// recording every control write, with bulk IN packets framed the way this
// chip frames them. deviceVersion is bcdDevice, which names the chip; left
// out, the device reports none, as the fakes did before the driver read it.
function makeFakeDevice({
  cancelOnClearHalt = false,
  endpoints = [
    { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
    { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
  ],
  interfaceNumber = 0,
  deviceVersion = undefined,
  serialNumber = null,
} = {}) {
  const controlCalls = [];
  const transferOutCalls = [];
  const fake = makeFakeUsbDevice({
    vendorId: 0x0403,
    productId: 0x6001,
    endpoints,
    interfaceNumber,
    cancelOnClearHalt,
    controlTransferOut: async ({ request, value, index }) => {
      controlCalls.push({ request, value, index });
      return { status: "ok" };
    },
    transferOut: async (endpointNumber, data) => {
      transferOutCalls.push({ endpointNumber, data });
      return { status: "ok" };
    },
  });
  if (deviceVersion !== undefined) {
    // Split the way Chromium splits bcdDevice: the whole high byte, then a
    // nibble each.
    fake.device.deviceVersionMajor = deviceVersion >> 8;
    fake.device.deviceVersionMinor = (deviceVersion >> 4) & 0x0f;
    fake.device.deviceVersionSubminor = deviceVersion & 0x0f;
  }
  fake.device.serialNumber = serialNumber;
  // A bulk IN packet as this chip actually sends it: two modem/line status
  // bytes, then whatever payload the wire delivered.
  const deliverPacket = (payload = []) => {
    fake.deliver(okTransfer([0x01, 0x60, ...payload]));
  };

  return { ...fake, controlCalls, transferOutCalls, deliverPacket };
}

test("FtdiSerialPort.open() purges FIFOs and sets the latency timer", async () => {
  const { device, controlCalls } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });

  // Init sequence faithful to native drivers: reset, purge RX, purge TX,
  // baud, framing, flow control, latency timer.
  assert.deepEqual(controlCalls, [
    { request: 0x00, value: 0x0000, index: 1 }, // SIO_RESET
    { request: 0x00, value: 0x0001, index: 1 }, // purge RX FIFO
    { request: 0x00, value: 0x0002, index: 1 }, // purge TX FIFO
    { request: 0x03, value: 0x4138, index: 0 }, // 9600 baud divisor
    { request: 0x04, value: 0x0008, index: 1 }, // 8N1
    { request: 0x02, value: 0x0000, index: 1 }, // no flow control
    { request: 0x09, value: 4, index: 1 }, // latency timer 4 ms
  ]);
  assert.ok(port.readable, "readable stream must be set up");
  assert.ok(port.writable, "writable stream must be set up");
});

test("ftdiConvertBaudrate gives hi-speed parts the 120 MHz divisor, with bit 16 in wIndex bit 8", () => {
  // The kernel's ftdi_2232h_baud_base_to_divisor() derives every one of these
  // words independently. The wIndex low byte is port A; bit 9 (0x0200) is the
  // 120 MHz / 10 clock switch, bit 8 the divisor's 17th bit.
  assert.deepEqual(ftdiConvertBaudrate(9600, "h"), { value: 0x04e2, index: 0x0201 });
  assert.deepEqual(ftdiConvertBaudrate(115200, "h"), { value: 0xc068, index: 0x0201 });
  assert.deepEqual(ftdiConvertBaudrate(14400, "h"), { value: 0x0341, index: 0x0301 });
  assert.deepEqual(ftdiConvertBaudrate(57600, "h"), { value: 0x00d0, index: 0x0301 });
  assert.deepEqual(ftdiConvertBaudrate(12000000, "h"), { value: 0x0000, index: 0x0201 });
  // Below 733 baud the 14-bit divisor cannot reach the rate from 12 MHz, so
  // libftdi falls back to 48 MHz / 16, still addressed to port A.
  assert.deepEqual(ftdiConvertBaudrate(300, "h"), { value: 0x2710, index: 0x0001 });
  assert.deepEqual(ftdiConvertBaudrate(732, "h"), { value: 0x1002, index: 0x0101 });
});

test("ftdiConvertBaudrate keeps the FT8U232AM to the four fractions it has", () => {
  // 14400 baud is a divisor of 1666 2/3. The BM family rounds it to 1666 3/8,
  // a fraction carried in the 17th bit; the AM has neither, and lands on
  // 1666 1/4 (code 2 at bits 14-15), the nearer of the two it can do.
  assert.deepEqual(ftdiConvertBaudrate(14400, "bm"), { value: 0x00d0, index: 0x0001 });
  assert.deepEqual(ftdiConvertBaudrate(14400, "am"), { value: 0x80d0, index: 0x0000 });
  // Where the BM needs no extra fraction the two agree.
  assert.deepEqual(ftdiConvertBaudrate(9600, "am"), ftdiConvertBaudrate(9600, "bm"));
  assert.deepEqual(ftdiConvertBaudrate(3000000, "am"), { value: 0x0000, index: 0x0000 });
});

test("ftdiBaudFamily reads the chip from bcdDevice as libftdi does", () => {
  const family = (deviceVersion, serialNumber = null) => ftdiBaudFamily(
    makeFakeDevice({ deviceVersion, serialNumber }).device,
  );
  assert.equal(family(0x0700), "h", "FT2232H");
  assert.equal(family(0x0800), "h", "FT4232H");
  assert.equal(family(0x0900), "h", "FT232H");
  assert.equal(family(0x3300), "h", "FT232HP, from the kernel's table");
  assert.equal(family(0x0600), "bm", "FT232R");
  assert.equal(family(0x1000), "bm", "FT-X: Chromium reports major 0x10, not BCD 10");
  assert.equal(family(0x0400), "bm", "FT232BM");
  assert.equal(family(0x0500), "bm", "FT2232C");
  assert.equal(family(0x0200, "A1B2C3"), "am", "FT8U232AM");
  // An FT232BM with no serial number reports 0x0200 as well.
  assert.equal(family(0x0200), "bm");
  assert.equal(family(0x0200, ""), "bm");
  // Unknown parts, and a device reporting no version, keep the FT232R divisor.
  assert.equal(family(0x0701), "bm");
  assert.equal(family(undefined), "bm");
});

for (const [label, deviceVersion, serialNumber, baud] of [
  ["FT232R", 0x0600, null, { value: 0x4138, index: 0x0000 }],
  ["FT232H", 0x0900, null, { value: 0x04e2, index: 0x0201 }],
  ["FT2232H", 0x0700, "FT4Z1", { value: 0x04e2, index: 0x0201 }],
]) {
  test(`FtdiSerialPort.open() programs the ${label} baud divisor`, async () => {
    // A hi-speed part reads the port from the wIndex low byte and divisor bit
    // 16 from bit 8. The FT232R layout sent it port 0, and at a rate needing
    // bit 16 put that bit where the port goes and lost it.
    const { device, controlCalls } = makeFakeDevice({ deviceVersion, serialNumber });
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 9600 });

    assert.deepEqual(
      controlCalls.filter((call) => call.request === 0x03),
      [{ request: 0x03, ...baud }],
    );
  });
}

test("ftdiDataValue encodes SIO_SET_DATA as the kernel's ftdi_set_termios does", () => {
  // Data bits in the low byte, parity at bits 8-10 (1 odd, 2 even), stop bits
  // at bits 11-12 (2 means two).
  assert.equal(ftdiDataValue({ dataBits: 8, parity: "none", stopBits: 1 }), 0x0008);
  assert.equal(ftdiDataValue({ dataBits: 8, parity: "even", stopBits: 1 }), 0x0208);
  assert.equal(ftdiDataValue({ dataBits: 7, parity: "even", stopBits: 1 }), 0x0207);
  assert.equal(ftdiDataValue({ dataBits: 8, parity: "none", stopBits: 2 }), 0x1008);
  assert.equal(ftdiDataValue({ dataBits: 8, parity: "odd", stopBits: 1 }), 0x0108);
});

for (const [label, options, value] of [
  ["8E1", { dataBits: 8, parity: "even", stopBits: 1 }, 0x0208],
  ["7E1", { dataBits: 7, parity: "even", stopBits: 1 }, 0x0207],
  ["8N2", { dataBits: 8, parity: "none", stopBits: 2 }, 0x1008],
]) {
  test(`FtdiSerialPort.open() programs ${label} through SIO_SET_DATA`, async () => {
    // Radios that need parity (tk280: even) or two stop bits (tg_uv2p) are
    // only reachable on Android through this driver, so the frame open() is
    // asked for has to be the frame on the wire.
    const { device, controlCalls } = makeFakeDevice();
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 9600, ...options });

    assert.deepEqual(
      controlCalls.filter((call) => call.request === 0x04),
      [{ request: 0x04, value, index: 1 }],
    );
  });
}

test("FtdiSerialPort.open() refuses a frame it cannot program before touching the chip", async () => {
  const { device, controlCalls } = makeFakeDevice();
  let opened = false;
  device.open = async () => { opened = true; };
  const port = new FtdiSerialPort(device);

  await assert.rejects(
    port.open({ baudRate: 9600, parity: "mark" }),
    /FTDI: cannot program parity "mark"/,
  );
  assert.equal(opened, false, "the device must not be opened for a frame it cannot carry");
  assert.deepEqual(controlCalls, []);
});

test("FtdiSerialPort declares framing, since open() programs it", () => {
  const { device } = makeFakeDevice();
  assert.equal(new FtdiSerialPort(device).capabilities.framing, true);
});

test("FtdiSerialPort.open() ignores interrupt endpoints when selecting bulk data", async () => {
  const { device } = makeFakeDevice({
    endpoints: [
      { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
      { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
      // Keep this last: the old direction-only loop overwrote bulk IN with it.
      { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
    ],
  });
  const port = new FtdiSerialPort(device);

  await port.open({ baudRate: 9600 });

  assert.equal(port._inEndpoint, 1);
  assert.equal(port._outEndpoint, 2);
  assert.equal(port.packetSize, 64);
});

for (const [missingDirection, endpoints] of [
  ["IN", [{ type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 }]],
  ["OUT", [{ type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 }]],
]) {
  test(`FtdiSerialPort.open() rejects a missing bulk ${missingDirection} endpoint`, async () => {
    const { device, controlCalls } = makeFakeDevice({ endpoints, interfaceNumber: 7 });
    const port = new FtdiSerialPort(device);

    await assert.rejects(
      port.open({ baudRate: 9600 }),
      /FTDI: bulk IN\/OUT endpoints not found on interface 7/,
    );
    assert.deepEqual(controlCalls, [], "endpoint validation must happen before FTDI initialization");
  });
}

test("FtdiSerialPort read path survives status-only packets (the Android wedge)", async () => {
  // Regression for a read-path deadlock observed on Android (exactly two
  // bulk IN transfers completed, then silence forever): a stream pull that
  // resolved without enqueuing after a status-only packet was never
  // re-invoked, wedging all reads. An idle chip sends one such packet every
  // latency tick, so the pull must keep polling through them and resolve only
  // once real payload arrives — which is what awaiting this read() proves.
  const { device, deliverPacket } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliverPacket();
  await tick();
  deliverPacket();
  await tick();
  deliverPacket();
  await tick();
  deliverPacket([0x50, 0xbb]);

  const { value } = await read;
  assert.deepEqual(Array.from(value), [0x50, 0xbb]);
});

test("FtdiSerialPort read path recovers when clearHalt cancels the queue", async () => {
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good.
  //
  // Status-only packets must not resolve the pull either (that wedges reads).
  const fake = makeFakeDevice({ cancelOnClearHalt: true });
  await expectStallRecovery({
    Port: FtdiSerialPort,
    fake,
    endpointNumber: 1,
    payload: [0xab],
    sendPayload: fake.deliverPacket,
    sendEmpty: () => fake.deliverPacket(),
  });
});

test("FtdiSerialPort keeps a full pipeline of bulk IN transfers queued", async () => {
  // One transfer in flight leaves the endpoint unqueued for the whole round
  // trip between a transfer completing and the next being issued, and the
  // chip's RX FIFO overruns in that gap — silently, status "ok" and no error
  // anywhere. The CH340 and PL2303 drivers carry the same pipeline for the
  // same reason.
  //
  // Both halves of that fix are load-bearing and both are pinned here by the
  // call count. No reader is attached, so the only thing driving further pulls
  // is the stream's own high-water mark: 16 transfers are queued up front, and
  // each of the 15 pulls after the first replenishes exactly one. A shallower
  // depth, or the default queue of one, yields a smaller number.
  const fake = makeFakeDevice();
  await expectFullPipeline({ Port: FtdiSerialPort, fake, sendPayload: fake.deliverPacket });
});

test("FtdiSerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // This chip repeats its two status bytes at the head of every packet, so a
  // request spanning packets comes back with headers buried mid-buffer and
  // stripFtdiStatusBytes would pass all but the first pair off as payload.
  // Throughput has to come from queue depth, not from asking for more bytes.
  await expectOnePacketPerTransfer({
    Port: FtdiSerialPort,
    fake: makeFakeDevice(),
    endpointNumber: 1,
    packetSize: 64,
  });
});

test("FtdiSerialPort write path reports a stalled bulk OUT instead of losing bytes", async () => {
  // WebUSB resolves a failed bulk OUT with a status rather than rejecting, so a
  // write path that ignores the result reports success on a protocol block that
  // went nowhere: an upload truncated silently, surfacing later as a read
  // timeout, with the endpoint left halted for every retry.
  await expectStalledWriteFails({
    Port: FtdiSerialPort,
    fake: makeFakeDevice(),
    chip: "FTDI",
    endpointNumber: 2,
  });
});

test("FtdiSerialPort write path resumes a short bulk OUT transfer", async () => {
  // bytesWritten can be less than the chunk; assuming a partial write was a
  // whole one drops the tail of a frame silently.
  await expectShortWriteResumed({
    Port: FtdiSerialPort,
    fake: makeFakeDevice(),
    endpointNumber: 2,
  });
});

test("FtdiSerialPort write path gives up on a transfer that never progresses", async () => {
  await expectStuckWriteFails({
    Port: FtdiSerialPort,
    fake: makeFakeDevice(),
    chip: "FTDI",
  });
});

test("FtdiSerialPort.getSignals polls the modem status and decodes its first byte", async () => {
  // SIO_POLL_MODEM_STATUS, as the kernel's tiocmget sends it: vendor, device,
  // to port A, two bytes back. The first is the same modem status byte that
  // heads every bulk IN packet: CTS 0x10, DSR 0x20, RI 0x40, DCD (RLSD) 0x80;
  // its low nibble is always 0x01 and means nothing.
  const { device } = makeFakeDevice();
  const requests = [];
  let status = 0x01 | 0x10 | 0x40;
  device.controlTransferIn = async (setup, length) => {
    requests.push({ ...setup, length });
    return { status: "ok", data: new DataView(new Uint8Array([status, 0x60]).buffer) };
  };
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.deepEqual(await port.getSignals(), {
    clearToSend: true,
    dataSetReady: false,
    dataCarrierDetect: false,
    ringIndicator: true,
  });
  assert.deepEqual(requests, [
    { requestType: "vendor", recipient: "device", request: 0x05, value: 0, index: 1, length: 2 },
  ]);

  status = 0x01 | 0x20 | 0x80;
  assert.deepEqual(await port.getSignals(), {
    clearToSend: false,
    dataSetReady: true,
    dataCarrierDetect: true,
    ringIndicator: false,
  });
});

test("FtdiSerialPort.getSignals reports a failed status request", async () => {
  const { device } = makeFakeDevice();
  device.controlTransferIn = async () => ({ status: "stall" });
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });

  await assert.rejects(port.getSignals(), /FTDI modem status request failed: stall/);
});
