const FILE_TYPE_PATTERNS = [
  ["PDF", /\bpdfs?\b|পিডিএফ/i],
  ["IMAGE", /\b(images?|pictures?|photos?)\b|ইমেজ|ছবি/i],
  ["DOCX", /\b(docx|word documents?)\b/i],
  ["PPTX", /\b(pptx?|powerpoints?|slides?)\b/i],
  ["XLSX", /\b(xlsx?|excel|spreadsheets?)\b/i],
];

const getResourceFileTypeIntent = (query = "") =>
  FILE_TYPE_PATTERNS.find(([, pattern]) => pattern.test(query))?.[0] || null;

const wantsLatestRecord = (query = "") =>
  /\b(latest|newest|most recent|recently added)\b|সর্বশেষ|নতুন(?:তম)?/i.test(query);

const typeMatchesRequestedCollection = (type, requestedCollections) => {
  if (!Object.values(requestedCollections).some(Boolean)) return true;

  return (
    (type === "resource" && requestedCollections.resources) ||
    (type === "club" && requestedCollections.clubs) ||
    (type === "announcement" && requestedCollections.announcements) ||
    (type === "event" && requestedCollections.events) ||
    (type === "lost-found" && requestedCollections.lostFound) ||
    (type === "person" && requestedCollections.people)
  );
};

module.exports = {
  getResourceFileTypeIntent,
  typeMatchesRequestedCollection,
  wantsLatestRecord,
};
