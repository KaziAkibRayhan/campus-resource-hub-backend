const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getResourceFileTypeIntent,
  typeMatchesRequestedCollection,
  wantsLatestRecord,
} = require("../utils/assistantQueryIntent");

test("resource file-type intent recognizes suggested prompt formats", () => {
  assert.equal(getResourceFileTypeIntent("Summarize the latest PDF resource"), "PDF");
  assert.equal(getResourceFileTypeIntent("Latest image resource-এ কী আছে?"), "IMAGE");
  assert.equal(getResourceFileTypeIntent("Show my CSE resources"), null);
});

test("latest-record intent recognizes English and Bangla phrasing", () => {
  assert.equal(wantsLatestRecord("Summarize the latest PDF resource"), true);
  assert.equal(wantsLatestRecord("সর্বশেষ PDF-এ কী আছে?"), true);
  assert.equal(wantsLatestRecord("Explain the networks PDF"), false);
});

test("explicit collection intent excludes unrelated result types", () => {
  const resourceRequest = {
    resources: true,
    clubs: false,
    announcements: false,
    events: false,
    lostFound: false,
    people: false,
  };

  assert.equal(typeMatchesRequestedCollection("resource", resourceRequest), true);
  assert.equal(typeMatchesRequestedCollection("club", resourceRequest), false);
});
