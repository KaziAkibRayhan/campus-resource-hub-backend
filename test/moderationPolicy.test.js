const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldHoldForReview } = require("../utils/moderationPolicy");

test("clean and fully checked content can auto-publish", () => {
  assert.equal(
    shouldHoldForReview({ flagged: false, status: "checked" }),
    false
  );
});

test("flagged content is held", () => {
  assert.equal(
    shouldHoldForReview({ flagged: true, status: "checked" }),
    true
  );
});

test("provider-unavailable content is held", () => {
  assert.equal(
    shouldHoldForReview({ flagged: false, status: "unavailable" }),
    true
  );
});

test("partially extracted documents are held even after a clean verdict", () => {
  assert.equal(
    shouldHoldForReview(
      { flagged: false, status: "checked" },
      { extractionPartial: true }
    ),
    true
  );
});

test("a clean moderated PDF page sample can publish despite partial extraction", () => {
  assert.equal(
    shouldHoldForReview(
      { flagged: false, status: "checked" },
      { extractionPartial: true, hasModeratedVisualSample: true }
    ),
    false
  );
});

test("a visual sample never overrides a harmful verdict", () => {
  assert.equal(
    shouldHoldForReview(
      { flagged: true, status: "checked" },
      { extractionPartial: true, hasModeratedVisualSample: true }
    ),
    true
  );
});
