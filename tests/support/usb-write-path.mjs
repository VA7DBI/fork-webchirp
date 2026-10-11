// The bulk OUT write-path checks every WebUSB chip driver has to pass. The
// four drivers share one writer (writeBulkOut in web/js/webusb-transport.ts),
// so the bodies are identical; each chip's test file keeps its own test names
// and calls in here for the mechanics, the way usb-read-path.mjs does for the
// read path. The CP210x file keeps its original copies of these cases, which
// these were taken from.
//
// Every helper takes the driver class and a fake built by the chip file's own
// makeFakeDevice (so the chip's control-transfer answers stay with the chip),
// and scripts the fake's bulk OUT endpoint itself.
import assert from "node:assert/strict";
import { bytesOf } from "./fake-usb.mjs";

// Replace the fake's bulk OUT endpoint with one that answers from `results`,
// oldest first, and records every transfer's endpoint and bytes. Past the end
// of the list every transfer is a full, successful write.
function scriptBulkOut(device, results) {
  const calls = [];
  device.transferOut = async (endpointNumber, data) => {
    const bytes = bytesOf(data);
    calls.push({ endpointNumber, bytes });
    return results.shift() || { status: "ok", bytesWritten: bytes.length };
  };
  return calls;
}

// Open the port and take its writer, with the bulk OUT endpoint scripted.
async function openWriter(Port, fake, results) {
  const calls = scriptBulkOut(fake.device, results);
  const port = new Port(fake.device);
  await port.open({ baudRate: 9600 });
  return { writer: port.writable.getWriter(), calls };
}

// WebUSB resolves a failed bulk OUT with a status rather than rejecting, so a
// write path that ignores the result reports success on a block that went
// nowhere. The write has to fail, naming how far it got, and the halt has to
// be cleared so the endpoint is usable for whatever the caller does next.
export async function expectStalledWriteFails({ Port, fake, chip, endpointNumber }) {
  const { writer } = await openWriter(Port, fake, [{ status: "stall", bytesWritten: 0 }]);
  await assert.rejects(
    writer.write(new Uint8Array([1, 2, 3, 4])),
    new RegExp(`^Error: ${chip}: bulk OUT endpoint stalled after 0 of 4 bytes$`),
  );
  assert.deepEqual(fake.clearHaltCalls, [{ direction: "out", endpoint: endpointNumber }]);
}

// `bytesWritten` can be less than the chunk. Assuming a partial write was a
// whole one drops the tail of a frame silently; the remainder has to go out
// from where the short transfer stopped, on the same endpoint.
export async function expectShortWriteResumed({ Port, fake, endpointNumber }) {
  const { writer, calls } = await openWriter(Port, fake, [{ status: "ok", bytesWritten: 2 }]);
  await writer.write(new Uint8Array([1, 2, 3, 4, 5]));
  assert.deepEqual(calls, [
    { endpointNumber, bytes: [1, 2, 3, 4, 5] },
    { endpointNumber, bytes: [3, 4, 5] },
  ], "the remainder must be written from where the short transfer stopped");
}

// A transfer that reports success but moves nothing would loop forever if
// resumed; it has to fail instead.
export async function expectStuckWriteFails({ Port, fake, chip }) {
  const { writer } = await openWriter(Port, fake, [{ status: "ok", bytesWritten: 0 }]);
  await assert.rejects(
    writer.write(new Uint8Array([1, 2, 3])),
    new RegExp(`^Error: ${chip}: bulk OUT wrote no bytes at offset 0 of 3$`),
  );
}
