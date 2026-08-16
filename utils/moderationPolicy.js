// Central publication rule: content is auto-publishable only after a complete,
// clean safety check. Provider outages and partial extraction always require
// human review.
const shouldHoldForReview = (
  verdict,
  { extractionPartial = false, hasModeratedVisualSample = false } = {}
) =>
  Boolean(
    verdict?.flagged ||
      verdict?.status !== "checked" ||
      (extractionPartial && !hasModeratedVisualSample)
  );

module.exports = { shouldHoldForReview };
