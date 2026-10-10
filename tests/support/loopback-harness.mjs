// Fake hardware for the serial loopback suite.
//
// Two levels of fake, both wired TX-to-RX:
//   - createEchoPort(): a Web Serial-shaped port that echoes. Used to test the
//     suite itself — that it passes on good hardware and fails on each defect
//     it claims to detect.
//   - createChipLoopbackPort(): a real chip driver (FTDI/PL2303/CH340/CP2102)
//     from web/js, driven against a fake USBDevice whose bulk OUT endpoint
//     feeds its bulk IN endpoint. This runs the drivers' actual read/write paths,
//     including FTDI's status-byte header and the packet chunking, with no
//     hardware attached.
//
// `faults` injects the defects the suite exists to catch, so the tests can
// prove each case has teeth rather than assuming it does.

import { Ch340SerialPort } from "../../web/js/ch340-webusb.ts";
import { Cp2102SerialPort } from "../../web/js/cp2102-webusb.ts";
import { FtdiSerialPort } from "../../web/js/ftdi-webusb.ts";
import { Pl2303SerialPort } from "../../web/js/pl2303-webusb.ts";
import {
  PL2303_HX_DESCRIPTOR,
  cancelledTransfer,
  deviceDescriptorBytes,
} from "./fake-usb.mjs";

// FTDI's two-byte modem/line status header, prepended to every bulk IN packet.
const FTDI_STATUS_BYTES = [0x01, 0x60];

/**
 * The wire between TX and RX: a byte queue with blocking reads.
 *
 * Supported faults:
 *   truncateWritesTo — silently drop everything past N bytes of each write
 *   duplicate        — echo every byte twice
 *   swallow          — byte values the line eats (models software flow control)
 *   wedgeAfterIdle   — stop delivering data once the line has gone quiet once
 */
function createWire({ faults = {}, idleWedgeMs = 150 } = {}) {
  let queue = [];
  let closed = false;
  let wedged = false;
  let idleTimer = null;
  const waiters = [];

  // Models the FTDI deadlock shape: traffic keeps the link healthy, but once it
  // has been quiet for longer than the threshold the read path never delivers
  // again. Rearmed on every byte, so only a real idle gap trips it.
  function armIdleWedge() {
    if (!faults.wedgeAfterIdle) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      wedged = true;
    }, idleWedgeMs);
    idleTimer.unref?.();
  }

  function settle() {
    while (waiters.length > 0 && (queue.length > 0 || closed)) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(new Uint8Array(queue.splice(0, waiter.max)));
    }
  }

  armIdleWedge();

  return {
    push(bytes) {
      if (closed || wedged) {
        return;
      }
      armIdleWedge();
      let out = Array.from(bytes);
      if (typeof faults.truncateWritesTo === "number") {
        out = out.slice(0, faults.truncateWritesTo);
      }
      if (Array.isArray(faults.swallow)) {
        out = out.filter((b) => !faults.swallow.includes(b));
      }
      if (faults.duplicate) {
        out = out.flatMap((b) => [b, b]);
      }
      queue.push(...out);
      settle();
    },

    // Up to `max` bytes, waiting for at least one. Resolves empty when the wire
    // closes or when `timeoutMs` elapses (the caller decides what that means).
    take(max, timeoutMs = null) {
      if (queue.length > 0) {
        return Promise.resolve(new Uint8Array(queue.splice(0, max)));
      }
      if (closed) {
        return Promise.resolve(new Uint8Array(0));
      }
      return new Promise((resolve) => {
        const waiter = { max, resolve, timer: null };
        if (timeoutMs !== null) {
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) {
              waiters.splice(index, 1);
            }
            resolve(new Uint8Array(0));
          }, timeoutMs);
          waiter.timer.unref?.();
        }
        waiters.push(waiter);
      });
    },

    // Drop every transfer currently waiting for bytes, without consuming any.
    // Chromium's clearHalt() cancels the transfers outstanding on the interface,
    // and a cancelled transfer takes no data with it — the bytes stay in the
    // device's FIFO for whatever transfer is queued next. Resolving `null` is
    // the signal the endpoint uses to reject that transfer as cancelled.
    cancelWaiters() {
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    },

    close() {
      closed = true;
      clearTimeout(idleTimer);
      settle();
    },

    reset() {
      closed = false;
      wedged = false;
      queue = [];
      clearTimeout(idleTimer);
      idleTimer = null;
      armIdleWedge();
    },
  };
}

/**
 * A Web Serial-shaped port with TX jumpered to RX. `faults` is passed to the
 * wire, plus:
 *   noSignalLoopback — getSignals() does not reflect setSignals()
 *   failReopen       — the second open() throws
 */
export function createEchoPort({ packetSize = 64, faults = {}, idleWedgeMs } = {}) {
  const wire = createWire({ faults, idleWedgeMs });
  let opens = 0;
  let closedFlag = true;
  let signals = { dataTerminalReady: false, requestToSend: false };

  const port = {
    readable: null,
    writable: null,
    baudRate: 0,
    getInfo: () => ({ usbVendorId: 0xf00d, usbProductId: 0x0001 }),

    async open(options = {}) {
      opens += 1;
      if (faults.failReopen && opens > 1) {
        throw new Error("fake adapter refuses to reopen");
      }
      wire.reset();
      closedFlag = false;
      port.baudRate = Number(options.baudRate) || 9600;

      port.readable = new ReadableStream({
        pull: async (controller) => {
          for (;;) {
            if (closedFlag) {
              controller.close();
              return;
            }
            const chunk = await wire.take(packetSize, 25);
            if (chunk.length > 0) {
              controller.enqueue(chunk);
              return;
            }
          }
        },
        cancel: () => {
          closedFlag = true;
        },
      });

      port.writable = new WritableStream({
        write: async (chunk) => {
          // Real adapters deliver long writes in packet-sized pieces.
          for (let offset = 0; offset < chunk.length; offset += packetSize) {
            wire.push(chunk.slice(offset, offset + packetSize));
          }
        },
      });
    },

    async setSignals(next = {}) {
      signals = { ...signals, ...next };
    },

    async getSignals() {
      if (faults.noSignalLoopback) {
        return { clearToSend: false, dataSetReady: false, dataCarrierDetect: false, ringIndicator: false };
      }
      // RTS→CTS and DTR→DSR jumpered.
      return {
        clearToSend: Boolean(signals.requestToSend),
        dataSetReady: Boolean(signals.dataTerminalReady),
        dataCarrierDetect: Boolean(signals.dataTerminalReady),
        ringIndicator: false,
      };
    },

    async close() {
      // Web Serial rejects close() while either stream is locked, and that is
      // the check that catches a caller who closed its writer without releasing
      // the lock — close() on a writer does not release it. The chip drivers do
      // not enforce this (real ones do not either), so without modelling it
      // here a leaked lock is invisible until someone plugs in real hardware.
      if (port.readable?.locked || port.writable?.locked) {
        const error = new Error(
          "Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream",
        );
        error.name = "InvalidStateError";
        throw error;
      }
      closedFlag = true;
      wire.close();
      port.readable = null;
      port.writable = null;
    },
  };

  return port;
}

// Endpoint layouts, matching what each driver expects to find on interface 0.
const CHIP_PROFILES = {
  ftdi: {
    vendorId: 0x0403,
    productId: 0x6015,
    packetSize: 64,
    Driver: FtdiSerialPort,
    endpoints: [
      { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 64 },
      { type: "bulk", direction: "in", endpointNumber: 2, packetSize: 64 },
    ],
  },
  pl2303: {
    vendorId: 0x067b,
    productId: 0x2303,
    packetSize: 64,
    Driver: Pl2303SerialPort,
    endpoints: [
      { type: "interrupt", direction: "in", endpointNumber: 1, packetSize: 10 },
      { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
      { type: "bulk", direction: "in", endpointNumber: 3, packetSize: 64 },
    ],
  },
  ch340: {
    vendorId: 0x1a86,
    productId: 0x7523,
    packetSize: 32,
    Driver: Ch340SerialPort,
    endpoints: [
      { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 32 },
      { type: "bulk", direction: "in", endpointNumber: 2, packetSize: 32 },
      { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
    ],
  },
  cp2102: {
    vendorId: 0x10c4,
    productId: 0xea60,
    packetSize: 64,
    Driver: Cp2102SerialPort,
    endpoints: [
      { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 64 },
      { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
    ],
  },
};

// The device descriptor shaped so detectPl2303Type() lands on HX.
function pl2303DeviceDescriptor() {
  return new DataView(deviceDescriptorBytes(PL2303_HX_DESCRIPTOR).buffer);
}

// Fold one control write into the output lines the device is driving, decoded
// from the chip's own request, so the modem status reads below can answer
// them back the way a jumpered adapter would. Writes that are not a line
// change leave them alone.
function recordLineWrite(chip, setup, lines) {
  const { request, value } = setup;
  if (chip === "ftdi" && request === 0x01) { // SIO_SET_MODEM_CTRL: mask high, bits low
    if (value & 0x0100) {
      lines.dtr = Boolean(value & 0x01);
    }
    if (value & 0x0200) {
      lines.rts = Boolean(value & 0x02);
    }
  } else if (chip === "pl2303" && setup.requestType === "class" && request === 0x22) {
    lines.dtr = Boolean(value & 0x01); // SET_CONTROL: absolute DTR|RTS
    lines.rts = Boolean(value & 0x02);
  } else if (chip === "ch340" && request === 0xa4) { // MODEM_CTRL: inverted
    lines.dtr = !(value & 0x20);
    lines.rts = !(value & 0x40);
  } else if (chip === "cp2102" && request === 0x07) { // SET_MHS: mask high, bits low
    if (value & 0x0100) {
      lines.dtr = Boolean(value & 0x01);
    }
    if (value & 0x0200) {
      lines.rts = Boolean(value & 0x02);
    }
  }
}

// The chip's own modem status reply with RTS jumpered to CTS and DTR to both
// DSR and DCD, or null when the request is not a status read.
function modemStatusReply(chip, setup, { dtr, rts }) {
  const { request, value } = setup;
  if (chip === "ftdi" && request === 0x05) { // POLL_MODEM_STATUS: CTS 0x10, DSR 0x20, DCD 0x80
    const status = 0x01 | (rts ? 0x10 : 0) | (dtr ? 0x20 | 0x80 : 0);
    return new DataView(new Uint8Array([status, 0x60]).buffer);
  }
  if (chip === "pl2303" && setup.requestType === "vendor" && request === 0x01 && value === 0x87) {
    // Control-line register, active low: CTS 0x08, DSR 0x04, DCD 0x02.
    const asserted = (rts ? 0x08 : 0) | (dtr ? 0x04 | 0x02 : 0);
    return new DataView(new Uint8Array([~asserted & 0xff]).buffer);
  }
  if (chip === "ch340" && request === 0x95 && value === 0x0706) {
    // Modem status register, inverted: CTS 0x01, DSR 0x02, DCD 0x08.
    const asserted = (rts ? 0x01 : 0) | (dtr ? 0x02 | 0x08 : 0);
    return new DataView(new Uint8Array([~asserted & 0xff, 0x00]).buffer);
  }
  if (chip === "cp2102" && request === 0x08) { // GET_MDMSTS: outputs low, inputs high
    const status = (dtr ? 0x01 : 0) | (rts ? 0x02 : 0)
      | (rts ? 0x10 : 0) | (dtr ? 0x20 | 0x80 : 0);
    return new DataView(new Uint8Array([status]).buffer);
  }
  return null;
}

function answerControlIn(chip, setup, length) {
  if (chip === "ch340") {
    if (setup.request === 0x5f) { // read version
      return new DataView(new Uint8Array([0x31, 0x00]).buffer);
    }
    if (setup.request === 0x95) { // read register (limited-prescaler probe)
      return new DataView(new Uint8Array([0x00, 0x00]).buffer);
    }
  }
  if (chip === "cp2102") {
    if (setup.request === 0xff) { // vendor-specific: part number
      return new DataView(new Uint8Array([0x02]).buffer); // CP2102
    }
    // GET_FLOW: the 16-byte block the driver reads, edits and writes back.
    // Everything else falls through to a zero-filled reply.
  }
  if (chip === "pl2303") {
    if (setup.requestType === "standard" && setup.request === 0x06) {
      return pl2303DeviceDescriptor();
    }
  }
  return new DataView(new ArrayBuffer(length));
}

/**
 * A fake USBDevice whose bulk OUT feeds its bulk IN, plus the chip driver that
 * drives it. `faults` goes to the wire, plus:
 *   noStatusHeader — FTDI only: omit the two status bytes the driver strips,
 *                    so the driver eats two payload bytes per packet
 *   stallOnce      — the first bulk IN transfer reports a stall
 * The control lines are jumpered too (RTS to CTS, DTR to DSR and DCD): each
 * chip's modem status read answers what its line writes last set.
 * `usb` is the WebUSB loss-event source handed to the driver (navigator.usb
 * when omitted), so a test can report the device unplugged.
 */
export function createChipLoopbackPort(chip, { faults = {}, latencyMs = 4, usb } = {}) {
  const profile = CHIP_PROFILES[chip];
  if (!profile) {
    throw new Error(`unknown chip: ${chip}`);
  }
  const wire = createWire({ faults });
  const controlLog = [];
  let stalled = Boolean(faults.stallOnce);
  let deviceClosed = false;
  // The output lines the driver last set. Every chip is wired as a jumpered
  // adapter: RTS to CTS, DTR to DSR and DCD.
  const lines = { dtr: false, rts: false };

  const inEndpointPacketSize = profile.endpoints
    .find((e) => e.type === "bulk" && e.direction === "in").packetSize;

  const device = {
    vendorId: profile.vendorId,
    productId: profile.productId,
    deviceClass: 0x00,
    usbVersionMajor: 1,
    usbVersionMinor: 1,
    deviceVersionMajor: 4,
    deviceVersionMinor: 0,
    configuration: {
      interfaces: [{ interfaceNumber: 0, alternate: { endpoints: profile.endpoints } }],
    },

    open: async () => {
      deviceClosed = false;
      wire.reset();
    },
    selectConfiguration: async () => {},
    claimInterface: async () => {},
    releaseInterface: async () => {},
    close: async () => {
      deviceClosed = true;
      wire.close();
    },
    clearHalt: async () => {
      stalled = false;
      // Chromium cancels every transfer outstanding on the interface before it
      // clears the endpoint. A driver that keeps its queued transfers across a
      // halt therefore ends up awaiting a cancelled one, so the fake has to
      // cancel them here or that defect goes unmodelled.
      wire.cancelWaiters();
    },

    controlTransferOut: async (setup) => {
      controlLog.push({ ...setup, direction: "out" });
      recordLineWrite(chip, setup, lines);
      return { status: "ok" };
    },
    controlTransferIn: async (setup, length) => {
      controlLog.push({ ...setup, direction: "in", length });
      const data = modemStatusReply(chip, setup, lines) || answerControlIn(chip, setup, length);
      return { status: "ok", data };
    },

    transferOut: async (endpointNumber, data) => {
      wire.push(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength ?? data.length));
      return { status: "ok", bytesWritten: data.byteLength ?? data.length };
    },

    transferIn: async (endpointNumber, packetLength) => {
      if (stalled) {
        stalled = false;
        return { status: "stall" };
      }
      if (chip === "ftdi") {
        // FTDI completes an IN transfer every latency tick whether or not
        // there is payload, carrying the status header either way.
        const headerLength = faults.noStatusHeader ? 0 : FTDI_STATUS_BYTES.length;
        const payload = await wire.take(packetLength - FTDI_STATUS_BYTES.length, latencyMs);
        if (payload === null) {
          throw cancelledTransfer();
        }
        const packet = new Uint8Array(headerLength + payload.length);
        if (headerLength) {
          packet.set(FTDI_STATUS_BYTES, 0);
        }
        packet.set(payload, headerLength);
        return { status: "ok", data: new DataView(packet.buffer) };
      }
      // CH340 and PL2303 carry raw payload and complete only when there is
      // data (or when the device goes away).
      const payload = await wire.take(packetLength);
      if (payload === null) {
        throw cancelledTransfer();
      }
      if (payload.length === 0 && deviceClosed) {
        return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
      }
      return { status: "ok", data: new DataView(payload.buffer) };
    },
  };

  return {
    port: new profile.Driver(device, { usb }),
    device,
    controlLog,
    packetSize: inEndpointPacketSize,
  };
}

export const CHIP_NAMES = Object.keys(CHIP_PROFILES);

// Suite options that keep a fake run fast: the real defaults spend 2 s per baud
// on the idle case and 1 s on the read timeout. Timeout budgets also scale with
// the baud rate, so a fake run stays at the top of the range — the wire is
// instant either way, and a failing case then costs a fraction of a second
// instead of ten.
export const FAST_SUITE_OPTIONS = {
  baudRates: [57600, 115200],
  idleMs: 60,
  readTimeoutMs: 200,
  quietMs: 40,
  signalSettleMs: 1,
  throughputBytes: 2048,
};
