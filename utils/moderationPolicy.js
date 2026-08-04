// Central publication rule: content is auto-publishable only after a complete,
// clean safety check. Provider outages and partial extraction always require
// human review.
const shouldHoldForReview = (verdict, { extractionPartial = false } = {}) =>
  Boolean(
    verdict?.flagged ||
      verdict?.status !== "checked" ||
      extractionPartial
  );

module.exports = { shouldHoldForReview };
