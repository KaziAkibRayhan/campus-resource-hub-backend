// Backfill Resource.contentExcerpt for files uploaded BEFORE the excerpt
// pipeline existed: downloads each file from Cloudinary, extracts its inner
// text, and saves the first 4000 chars. Run once, then re-run
// scripts/backfill-embeddings.js so the new text lands in the vectors.
//
//   node scripts/backfill-content-excerpts.js [--force]
require("dotenv").config();
const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const Resource = require("../models/Resource");
const { extractContent } = require("../utils/contentExtractor");

const force = process.argv.includes("--force");

const getFormatFromUrl = (fileUrl = "") =>
  fileUrl.split(".").pop().split("?")[0].toLowerCase();

const getCloudinaryDeliveryType = (resource) => {
  if (/\/image\/upload\//.test(resource.fileUrl || "")) return "image";
  if (/\/raw\/upload\//.test(resource.fileUrl || "")) return "raw";
  return resource.cloudinaryResourceType || "raw";
};

// Same signed-download technique the file-stream endpoint uses (Cloudinary
// blocks direct raw/PDF URLs).
const fetchResourceBuffer = async (resource) => {
  const format = getFormatFromUrl(resource.fileUrl || "");
  const deliveryType = getCloudinaryDeliveryType(resource);
  for (const resourceType of [deliveryType, deliveryType === "image" ? "raw" : "image"]) {
    const signedUrl = cloudinary.utils.private_download_url(
      resource.cloudinaryPublicId,
      format,
      { resource_type: resourceType, type: "upload" }
    );
    const upstream = await fetch(signedUrl);
    if (upstream.ok) {
      return { format, buffer: Buffer.from(await upstream.arrayBuffer()) };
    }
  }
  throw new Error("could not download from Cloudinary");
};

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const query = force ? {} : { $or: [{ contentExcerpt: { $exists: false } }, { contentExcerpt: null }, { contentExcerpt: "" }] };
    const resources = await Resource.find(query).select("+contentExcerpt").exec();
    console.log(`${resources.length} resource(s) to process${force ? " (--force)" : ""}\n`);

    let done = 0;
    let skipped = 0;
    let failed = 0;

    for (const resource of resources) {
      // Images have no extractable text (no OCR) — skip.
      if (resource.fileType === "IMAGE") {
        skipped++;
        continue;
      }
      try {
        const { format, buffer } = await fetchResourceBuffer(resource);
        const extraction = await extractContent(
          { buffer, originalname: `file.${format}`, mimetype: "" },
          resource.fileType
        );
        const excerpt = extraction.texts
          .join("\n")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 4000);
        if (!excerpt) {
          skipped++;
          console.log(`  (no text) ${resource.title}`);
          continue;
        }
        resource.contentExcerpt = excerpt;
        await resource.save(); // post-save hook re-embeds automatically
        done++;
        console.log(`  ok (${excerpt.length} chars) ${resource.title}`);
      } catch (error) {
        failed++;
        console.error(`  FAIL ${resource.title}: ${error.message}`);
      }
    }

    console.log(`\nDone: ${done} excerpted, ${skipped} skipped (images/empty), ${failed} failed.`);
    console.log("Now run: node scripts/backfill-embeddings.js");
    // Give fire-and-forget embedding syncs a moment before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
})();
