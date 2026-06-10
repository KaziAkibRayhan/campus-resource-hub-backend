// backend/utils/contentExtractor.js
// Extracts the *inner* content of an uploaded resource file (text + images)
// so it can be sent to the moderation service. Supports PDF, DOCX/PPTX/XLSX
// (and their template/macro variants), legacy binary Office files
// (best-effort text only), plain images, SVG, and TXT.

// pdf-parse's bundled pdf.js expects browser globals plus
// process.getBuiltinModule (added in Node 22.3) — backfill them from
// @napi-rs/canvas so extraction works on Node >= 18.
if (typeof process.getBuiltinModule !== "function") {
  process.getBuiltinModule = (id) =>
    require(id.startsWith("node:") ? id.slice(5) : id);
}
const napiCanvas = require("@napi-rs/canvas");
globalThis.DOMMatrix ??= napiCanvas.DOMMatrix;
globalThis.ImageData ??= napiCanvas.ImageData;
globalThis.Path2D ??= napiCanvas.Path2D;

const AdmZip = require("adm-zip");
const mammoth = require("mammoth");

const MAX_TEXT_CHARS = 12000;
const MAX_IMAGES = 8;
const MAX_PDF_PAGES_RENDERED = 5;
const MIN_IMAGE_BYTES = 4 * 1024; // ignore icons/bullets
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // keep base64 under provider limits
const MAX_DECODE_BYTES = 15 * 1024 * 1024; // don't decode absurdly large media
const MAX_IMAGE_DIMENSION = 1280;
const EXTRACTION_TIMEOUT_MS = 60000;

const RASTER_MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const MODERATABLE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const decodeXmlEntities = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const stripXmlText = (xml, tagPattern) => {
  const out = [];
  let match;
  while ((match = tagPattern.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1]).trim();
    if (value) out.push(value);
    if (out.join(" ").length > MAX_TEXT_CHARS) break;
  }
  return out.join(" ");
};

// Best-effort readable-text scrape for legacy binary formats (.doc/.ppt/.xls)
const extractBinaryText = (buffer) => {
  const ascii = buffer.toString("latin1");
  const runs = ascii.match(/[\x20-\x7E]{8,}/g) || [];
  return runs.join(" ").slice(0, MAX_TEXT_CHARS);
};

// Downscale/re-encode an image so it fits provider limits. Returns a data
// URL, or null when the format can't be decoded (e.g. some AVIF/BMP files).
const normalizeImageBuffer = (buffer, mimetype) => {
  if (MODERATABLE_MIMES.has(mimetype) && buffer.length <= MAX_IMAGE_BYTES) {
    return `data:${mimetype};base64,${buffer.toString("base64")}`;
  }
  try {
    const image = new napiCanvas.Image();
    image.src = buffer;
    const scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(image.width, image.height)
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = napiCanvas.createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const jpeg = canvas.toBuffer("image/jpeg", 80);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
};

// Re-encode an oversized data URL down to provider-safe size; null if hopeless.
const fitDataUrl = (dataUrl) => {
  if (!dataUrl) return null;
  if (dataUrl.length <= MAX_IMAGE_BYTES * 1.37) return dataUrl;
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || dataUrl.length > MAX_DECODE_BYTES * 1.37) return null;
  const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
  return normalizeImageBuffer(
    Buffer.from(dataUrl.slice(comma + 1), "base64"),
    mime || "image/png"
  );
};

const extractPdf = async (buffer) => {
  const { PDFParse } = require("pdf-parse");
  const result = { texts: [], images: [], partial: false };
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    try {
      const text = await parser.getText();
      if (text?.text) result.texts.push(text.text.slice(0, MAX_TEXT_CHARS));
    } catch {
      result.partial = true;
    }

    // Full-page renders catch everything visible on the first pages,
    // including scanned pages and vector drawings.
    try {
      const shots = await parser.getScreenshot({
        first: MAX_PDF_PAGES_RENDERED,
        scale: 1.0,
      });
      for (const page of shots?.pages || []) {
        const dataUrl = fitDataUrl(page.dataUrl);
        if (dataUrl) {
          result.images.push({
            dataUrl,
            label: `pdf page ${page.pageNumber}`,
          });
        }
      }
    } catch {
      result.partial = true;
    }

    // Embedded photos across the whole document, so an image buried on
    // page 40 is still checked. Largest first — photos beat icons.
    try {
      const embedded = await parser.getImage();
      const candidates = [];
      for (const page of embedded?.pages || []) {
        if (page.pageNumber <= MAX_PDF_PAGES_RENDERED) continue; // already rendered
        for (const img of page.images || []) {
          if (!img.dataUrl) continue;
          if (img.dataUrl.length < MIN_IMAGE_BYTES * 1.3) continue;
          const dataUrl = fitDataUrl(img.dataUrl);
          if (!dataUrl) continue;
          candidates.push({
            dataUrl,
            label: `pdf embedded image (page ${page.pageNumber})`,
            size: dataUrl.length,
          });
        }
      }
      candidates.sort((a, b) => b.size - a.size);
      for (const candidate of candidates) {
        if (result.images.length >= MAX_PDF_PAGES_RENDERED + 5) break;
        result.images.push({
          dataUrl: candidate.dataUrl,
          label: candidate.label,
        });
      }
    } catch {
      result.partial = true;
    }
  } finally {
    try {
      await parser.destroy();
    } catch {
      // ignore
    }
  }

  return result;
};

// Shared for DOCX/PPTX/XLSX zips: pull raster images out of the media folder.
const extractZipImages = (zip, mediaPrefixes) => {
  const candidates = [];
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.toLowerCase();
    if (!mediaPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const mime = RASTER_MIME_BY_EXT[name.split(".").pop()];
    if (!mime) continue;
    const size = entry.header.size;
    if (size < MIN_IMAGE_BYTES || size > MAX_DECODE_BYTES) continue;
    candidates.push({ entry, mime, size });
  }
  candidates.sort((a, b) => b.size - a.size);

  const images = [];
  for (const { entry, mime } of candidates.slice(0, MAX_IMAGES)) {
    const dataUrl = normalizeImageBuffer(entry.getData(), mime);
    if (dataUrl) images.push({ dataUrl, label: entry.entryName });
  }
  return images;
};

const extractOfficeZip = async (buffer, kind) => {
  const result = { texts: [], images: [], partial: false };
  let zip;
  try {
    zip = new AdmZip(buffer);
    zip.getEntries();
  } catch {
    // Legacy binary format (.doc/.ppt/.xls) — text scrape only.
    const text = extractBinaryText(buffer);
    if (text) result.texts.push(text);
    result.partial = true;
    return result;
  }

  try {
    if (kind === "DOCX") {
      try {
        const { value } = await mammoth.extractRawText({ buffer });
        if (value) result.texts.push(value.slice(0, MAX_TEXT_CHARS));
      } catch {
        const entry = zip.getEntry("word/document.xml");
        if (entry) {
          result.texts.push(
            stripXmlText(
              entry.getData().toString("utf8"),
              /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
            )
          );
        } else {
          result.partial = true;
        }
      }
      result.images.push(...extractZipImages(zip, ["word/media/"]));
    } else if (kind === "PPTX") {
      const slideTexts = [];
      for (const entry of zip.getEntries()) {
        const name = entry.entryName.toLowerCase();
        if (
          /^ppt\/(slides|notesslides)\/[^/]+\.xml$/.test(name) &&
          slideTexts.join(" ").length < MAX_TEXT_CHARS
        ) {
          slideTexts.push(
            stripXmlText(
              entry.getData().toString("utf8"),
              /<a:t>([\s\S]*?)<\/a:t>/g
            )
          );
        }
      }
      const joined = slideTexts.filter(Boolean).join("\n");
      if (joined) result.texts.push(joined.slice(0, MAX_TEXT_CHARS));
      result.images.push(...extractZipImages(zip, ["ppt/media/"]));
    } else if (kind === "XLSX") {
      const entry = zip.getEntry("xl/sharedStrings.xml");
      if (entry) {
        result.texts.push(
          stripXmlText(
            entry.getData().toString("utf8"),
            /<t[^>]*>([\s\S]*?)<\/t>/g
          )
        );
      }
      result.images.push(...extractZipImages(zip, ["xl/media/"]));
    }
  } catch {
    result.partial = true;
  }

  return result;
};

const extractImageFile = async (buffer, mimetype) => {
  const result = { texts: [], images: [], partial: false };
  if (mimetype === "image/svg+xml") {
    // SVG is XML: moderate its visible text; rasterizing is unreliable.
    const xml = buffer.toString("utf8");
    result.texts.push(
      xml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, MAX_TEXT_CHARS)
    );
    const dataUrl = normalizeImageBuffer(buffer, mimetype);
    if (dataUrl) result.images.push({ dataUrl, label: "uploaded svg" });
    else result.partial = true;
    return result;
  }

  const dataUrl = normalizeImageBuffer(buffer, mimetype);
  if (dataUrl) result.images.push({ dataUrl, label: "uploaded image" });
  else result.partial = true;
  return result;
};

/**
 * @param {{buffer: Buffer, mimetype: string, originalname: string}} file
 * @param {"PDF"|"DOCX"|"PPTX"|"XLSX"|"IMAGE"} fileType
 * @returns {Promise<{texts: string[], images: {dataUrl: string, label: string}[], partial: boolean}>}
 */
const extractContent = async (file, fileType) => {
  const run = async () => {
    if (fileType === "IMAGE") {
      return extractImageFile(file.buffer, file.mimetype);
    }
    if (fileType === "PDF") {
      return extractPdf(file.buffer);
    }
    if (["DOCX", "PPTX", "XLSX"].includes(fileType)) {
      return extractOfficeZip(file.buffer, fileType);
    }
    if (file.mimetype === "text/plain") {
      return {
        texts: [file.buffer.toString("utf8").slice(0, MAX_TEXT_CHARS)],
        images: [],
        partial: false,
      };
    }
    // Unknown container (e.g. zip archives) — can't look inside cheaply.
    return { texts: [], images: [], partial: true };
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ texts: [], images: [], partial: true }),
      EXTRACTION_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    console.error("Content extraction error:", error.message);
    return { texts: [], images: [], partial: true };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { extractContent };
