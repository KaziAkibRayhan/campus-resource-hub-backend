// Build searchable chunks for existing resource files.
// Usage:
//   node scripts/backfill-resource-knowledge.js
//   node scripts/backfill-resource-knowledge.js --vision
//   node scripts/backfill-resource-knowledge.js --vision --limit=10

require("dotenv").config();
const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const Resource = require("../models/Resource");
const { extractContent } = require("../utils/contentExtractor");
const { indexResourceKnowledge } = require("../utils/resourceKnowledge");
const { moderateContent } = require("../utils/moderationService");

const useVision = process.argv.includes("--vision");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 1) : 0;
const mimeByType = {
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  IMAGE: "image/jpeg",
};
const extByType = { PDF: "pdf", DOCX: "docx", PPTX: "pptx", XLSX: "xlsx", IMAGE: "jpg" };
const formatFromUrl = (url = "") => url.split(".").pop().split("?")[0].toLowerCase();

const download = async (resource) => {
  const direct = await fetch(resource.fileUrl);
  if (direct.ok) {
    return {
      buffer: Buffer.from(await direct.arrayBuffer()),
      mime: direct.headers.get("content-type")?.split(";")[0],
    };
  }
  const preferred = /\/image\/upload\//.test(resource.fileUrl || "") ? "image" : "raw";
  for (const resourceType of [preferred, preferred === "image" ? "raw" : "image"]) {
    const url = cloudinary.utils.private_download_url(
      resource.cloudinaryPublicId,
      formatFromUrl(resource.fileUrl),
      { resource_type: resourceType, type: "upload" }
    );
    const response = await fetch(url);
    if (response.ok) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mime: response.headers.get("content-type")?.split(";")[0],
      };
    }
  }
  throw new Error(`download failed (HTTP ${direct.status})`);
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  let query = Resource.find({ approved: true }).sort({ createdAt: -1 });
  if (limit) query = query.limit(limit);
  const resources = await query.lean();
  let indexed = 0;
  let failed = 0;

  for (const resource of resources) {
    try {
      const file = await download(resource);
      const extraction = await extractContent(
        {
          buffer: file.buffer,
          mimetype: file.mime?.startsWith("image/") ? file.mime : mimeByType[resource.fileType],
          originalname: `resource.${extByType[resource.fileType] || "bin"}`,
        },
        resource.fileType
      );
      let describeImages = useVision && extraction.images.length > 0;
      if (describeImages) {
        const safety = await moderateContent({ images: extraction.images });
        describeImages = safety.status === "checked" && !safety.flagged;
      }
      const count = await indexResourceKnowledge(resource._id, extraction, { describeImages });
      indexed += 1;
      console.log(`Indexed ${resource.title}: ${count} chunk(s), vision=${describeImages}`);
    } catch (error) {
      failed += 1;
      console.error(`Failed ${resource.title}:`, error.message);
    }
  }

  console.log(`Done: ${indexed} indexed, ${failed} failed, vision=${useVision}`);
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
