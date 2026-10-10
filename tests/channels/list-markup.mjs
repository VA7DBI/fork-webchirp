import test from "node:test";
import assert from "node:assert/strict";

import { installIndexPage } from "../support/index-page.mjs";

// Every <li> on the app's pages must sit in a list. The HTML parser does not
// invent a <ul> around a stray <li>, so one placed straight in a <div> renders
// with the browser's default list styling and none of its container's rules --
// which is how the empty channel grid's suggestions (issue #109) looked unlike
// the rest of their card.

const PAGES = ["index.html", "about.html", "serial-test.html"];
const LIST_PARENTS = new Set(["UL", "OL", "MENU"]);

for (const name of PAGES) {
  test(`every list item in ${name} is inside a list`, () => {
    const { document } = installIndexPage({ page: name });
    const stray = [...document.querySelectorAll("li")]
      .filter((item) => !LIST_PARENTS.has(item.parentElement?.tagName ?? ""))
      .map((item) => `${item.parentElement?.tagName.toLowerCase()}: ${item.textContent?.trim().slice(0, 60)}`);
    assert.deepEqual(stray, [], `${name} has <li> elements outside a <ul>, <ol> or <menu>`);
  });
}

test("the empty channel grid lists its suggestions in one styled list", () => {
  const { document } = installIndexPage();
  const card = document.querySelector("#channel-empty-state .channel-empty-card");
  assert.ok(card, "index.html has the empty-state card");
  const lists = card.querySelectorAll("ul.channel-empty-steps");
  assert.equal(lists.length, 1);
  assert.equal(lists[0].querySelectorAll(":scope > li").length, 3);
});
