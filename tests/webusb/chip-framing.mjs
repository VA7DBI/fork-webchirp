import assert from "node:assert/strict";
import test from "node:test";
import { framingLabel, resolveChipFraming } from "../../web/js/webusb-transport.ts";

// resolveChipFraming() is what every WebUSB chip driver encodes its frame
// from, so its defaults and its refusals hold for all four. Each chip's own
// test file pins the control transfer that frame turns into.

test("resolveChipFraming defaults to 8N1 the way Web Serial does", () => {
  assert.deepEqual(resolveChipFraming({ baudRate: 9600 }, "CHIP"), {
    dataBits: 8, stopBits: 1, parity: "none",
  });
  assert.deepEqual(
    resolveChipFraming({ baudRate: 9600, dataBits: 7, stopBits: 2, parity: "odd" }, "CHIP"),
    { dataBits: 7, stopBits: 2, parity: "odd" },
  );
});

test("resolveChipFraming refuses a frame outside the contract by name", () => {
  // These only arrive from a caller outside the types, but programming them as
  // something else would misframe every byte with no error anywhere.
  assert.throws(
    () => resolveChipFraming({ baudRate: 9600, dataBits: 5 }, "FTDI"),
    /^Error: FTDI: cannot program 5 data bits \(7 or 8 only\)$/,
  );
  assert.throws(
    () => resolveChipFraming({ baudRate: 9600, stopBits: 1.5 }, "CH340"),
    /^Error: CH340: cannot program 1.5 stop bits \(1 or 2 only\)$/,
  );
  assert.throws(
    () => resolveChipFraming({ baudRate: 9600, parity: "mark" }, "PL2303"),
    /^Error: PL2303: cannot program parity "mark" \(none, even or odd only\)$/,
  );
});

test("framingLabel names a frame the conventional way", () => {
  assert.equal(framingLabel({ dataBits: 8, parity: "none", stopBits: 1 }), "8N1");
  assert.equal(framingLabel({ dataBits: 7, parity: "even", stopBits: 1 }), "7E1");
  assert.equal(framingLabel({ dataBits: 8, parity: "odd", stopBits: 2 }), "8O2");
});
