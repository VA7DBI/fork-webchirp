// A fetch the network never answered is not a bug report.
//
// The runtime's first fetch -- the CHIRP archive, the driver index -- is where
// a dropped connection or a blocked request shows up, and it used to reach
// Sentry as a runtime crash, once per flaky connection. fetch() rejects with a
// TypeError for exactly that case, so the rule is keyed on the type and the
// browser's sentence together, and a status error from fetchOk() (a missing
// file in a deploy) stays reported.
//
// Two paths carry the failure to Sentry, and both are checked: beforeSend sees
// the TypeError when an action's funnel captures it, and onRuntimeCrash sees it
// before a bootstrap failure is captured as a string -- by then beforeSend has
// nothing but the message to go on.

import assert from "node:assert/strict";
import test from "node:test";
import "../support/register-cdn-imports.mjs";

import { initOptions, initSentry, isNetworkFailure, resetSentryForTests } from "../../web/js/sentry.ts";
import { createBootstrapCrashReporter, markBootstrapFailure } from "../../web/js/runtime-bootstrap.ts";
import { installIndexPage } from "../support/index-page.mjs";

// Whether beforeSend drops the event Sentry would build for this failure.
function isDropped(error) {
  const event = { exception: { values: [{ type: error.name, value: error.message }] } };
  return initOptions().beforeSend(event, { originalException: error }) === null;
}

// A stand-in for the SDK that records what reaches captureException.
function makeSentrySdk() {
  const captured = [];
  return {
    captured,
    init() {},
    withScope(fn) {
      fn({ setTag() {} });
    },
    captureException(error) {
      captured.push(error);
    },
  };
}

test("each browser's network failure from fetch() is dropped", () => {
  const messages = [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
    // The SDK's fetch instrumentation appends the host, as in the event that
    // prompted this rule.
    "Failed to fetch (webchirp.org)",
    "Load failed (cdn.jsdelivr.net)",
  ];
  for (const message of messages) {
    const error = new TypeError(message);
    assert.equal(isNetworkFailure(error), true, message);
    assert.equal(isDropped(error), true, message);
  }
});

test("fetch failures that point at a deploy stay reported", () => {
  const kept = [
    // fetchOk() in python-sources.ts: the server answered, with an error.
    new Error("Failed to fetch https://webchirp.org/chirp/chirp-abc.zip: 404"),
    // A code-split chunk missing from the deploy, not only a dropped network.
    new TypeError("Failed to fetch dynamically imported module: https://webchirp.org/js/app.X.js"),
    // The sentence alone, without the type fetch() rejects with.
    new Error("Failed to fetch"),
    new TypeError("Cannot read properties of undefined (reading 'fetch')"),
  ];
  for (const error of kept) {
    assert.equal(isNetworkFailure(error), false, error.message);
    assert.equal(isDropped(error), false, error.message);
  }
});

test("the crash reporter hands the failure itself on with its detail", () => {
  const reported = [];
  const reportCrash = createBootstrapCrashReporter((detail, error) => reported.push([detail, error]));
  const failure = markBootstrapFailure(new TypeError("Failed to fetch"));

  assert.equal(reportCrash(failure, "TypeError: Failed to fetch\n    at fetchOk"), true);
  assert.deepEqual(reported, [["TypeError: Failed to fetch\n    at fetchOk", failure]]);
});

test("a runtime that could not be fetched is logged but not captured", async (t) => {
  const { document } = installIndexPage();
  resetSentryForTests();
  t.after(resetSentryForTests);
  const sdk = makeSentrySdk();
  await initSentry({
    location: { hostname: "webchirp.org" },
    addEventListener() {},
    removeEventListener() {},
  }, { loadSdk: async () => sdk });
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();

  ui.onRuntimeCrash("TypeError: Failed to fetch", new TypeError("Failed to fetch (webchirp.org)"));
  assert.equal(sdk.captured.length, 0);
  // The debug panel still says what happened.
  assert.match(document.querySelector("#debug-output").value, /RUNTIME CRASH TypeError: Failed to fetch/);

  // Any other bootstrap failure is still a crash worth reading.
  ui.onRuntimeCrash("RuntimeError: seeding failed", new Error("RuntimeError: seeding failed"));
  assert.equal(sdk.captured.length, 1);
  assert.equal(sdk.captured[0].message, "RuntimeError: seeding failed");
});
