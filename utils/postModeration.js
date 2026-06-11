// Shared content-safety gate for user posts: announcements, events, clubs,
// and lost & found. Resources keep their own deeper pipeline in
// resourceController — do not use this there.
//
// Reuses the same Groq safety judges as resources (moderationService) and the
// same file extractor, so PDFs/docs attached to announcements are scanned
// inside, not just by filename.
const { moderateContent, describeCategories } = require("./moderationService");
const { extractContent } = require("./contentExtractor");

const FILE_TYPE_BY_MIME = {
  "application/pdf": "PDF",
  "application/msword": "DOCX",
  "application/vnd.ms-word.document.macroEnabled.12": "DOCX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": "DOCX",
  "application/vnd.ms-word.template.macroEnabled.12": "DOCX",
  "application/vnd.ms-powerpoint": "PPTX",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12": "PPTX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "PPTX",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.12": "PPTX",
  "application/vnd.openxmlformats-officedocument.presentationml.template": "PPTX",
  "application/vnd.ms-powerpoint.template.macroEnabled.12": "PPTX",
  "application/vnd.ms-excel": "XLSX",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "XLSX",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12": "XLSX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-excel.template.macroEnabled.12": "XLSX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": "XLSX",
  "text/plain": "TEXT",
  "image/jpeg": "IMAGE",
  "image/jpg": "IMAGE",
  "image/pjpeg": "IMAGE",
  "image/x-citrix-jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/gif": "IMAGE",
  "image/avif": "IMAGE",
  "image/svg+xml": "IMAGE",
  "image/bmp": "IMAGE",
};

const FILE_TYPE_BY_EXTENSION = {
  pdf: "PDF",
  doc: "DOCX",
  docx: "DOCX",
  docm: "DOCX",
  dot: "DOCX",
  dotx: "DOCX",
  dotm: "DOCX",
  ppt: "PPTX",
  pptx: "PPTX",
  pptm: "PPTX",
  pps: "PPTX",
  ppsx: "PPTX",
  ppsm: "PPTX",
  pot: "PPTX",
  potx: "PPTX",
  potm: "PPTX",
  xls: "XLSX",
  xlsx: "XLSX",
  xlsm: "XLSX",
  xlsb: "XLSX",
  xlt: "XLSX",
  xltx: "XLSX",
  xltm: "XLSX",
  jpg: "IMAGE",
  jpeg: "IMAGE",
  png: "IMAGE",
  webp: "IMAGE",
  gif: "IMAGE",
  avif: "IMAGE",
  svg: "IMAGE",
  bmp: "IMAGE",
  txt: "TEXT",
};

const extractorFileType = (file = {}) => {
  const mimeType = file.mimetype || "";
  const extension = (file.originalname || "").split(".").pop()?.toLowerCase();
  return FILE_TYPE_BY_MIME[mimeType] || FILE_TYPE_BY_EXTENSION[extension] || null;
};

/**
 * Run the safety scan over a post's text fields, in-memory files (multer
 * memoryStorage buffers), and already-hosted image URLs (e.g. a Cloudinary
 * upload from CloudinaryStorage).
 *
 * Fails open like resources do: if the moderation provider is unavailable the
 * post is allowed, only flagged content is blocked.
 *
 * @param {Object} options
 * @param {string[]} [options.texts] - title/description/etc.
 * @param {Array}  [options.files] - multer files with .buffer + .mimetype
 * @param {string[]} [options.imageUrls] - public image URLs to judge
 * @returns {Promise<null | { message: string, categories: string[] }>}
 *          null when clean; rejection payload when flagged
 */
const moderatePost = async ({ texts = [], files = [], imageUrls = [] } = {}) => {
  const collectedTexts = texts.filter((text) => text && String(text).trim());
  const collectedImages = imageUrls
    .filter(Boolean)
    .map((url) => ({ dataUrl: url, label: "image" }));

  for (const file of files) {
    const fileType = extractorFileType(file);
    if (!fileType || !file.buffer) continue;

    try {
      const extraction = await extractContent(file, fileType);
      collectedTexts.push(...extraction.texts);
      collectedImages.push(...extraction.images);
    } catch (error) {
      // Extraction failure shouldn't block the post; text fields are still checked.
      console.error("Post moderation extraction error:", error.message);
    }
  }

  const verdict = await moderateContent({ texts: collectedTexts, images: collectedImages });

  if (verdict.flagged) {
    return {
      message: `Post blocked: the content appears to contain ${describeCategories(
        verdict.categories
      )}. It violates community guidelines and was not published.`,
      categories: verdict.categories,
    };
  }

  return null;
};

module.exports = { moderatePost };
