// Backfill/refresh the shared `embeddings` collection for all content types.
//
// Usage:
//   node scripts/backfill-embeddings.js          # embed new/changed docs only
//   node scripts/backfill-embeddings.js --force  # re-embed everything
//
// Idempotent: docs whose contentHash already matches are skipped, so this is
// also the recovery path for writes that happened while the embedding model
// was unavailable. Run BEFORE scripts/setup-vector-indexes.js (the Atlas
// index needs the collection to exist).
require("dotenv").config();
const mongoose = require("mongoose");

const Resource = require("../models/Resource");
const Club = require("../models/Club");
const Announcement = require("../models/Announcement");
const Event = require("../models/Event");
const LostFoundItem = require("../models/LostFoundItem");
const Embedding = require("../models/Embedding");
const {
  buildDocText,
  contentHash,
  embedText,
  MODEL_ID,
} = require("../utils/embeddingService");

const SOURCES = [
  { type: "resource", Model: Resource },
  { type: "club", Model: Club },
  { type: "announcement", Model: Announcement },
  { type: "event", Model: Event },
  { type: "lost-found", Model: LostFoundItem },
];

const BATCH_SIZE = 16;
const force = process.argv.includes("--force");

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected. Warming up embedding model (first run downloads ~50MB)...");
    const warmup = await embedText("warmup");
    if (!warmup) {
      console.error(
        "Embedding model failed to initialize (check internet access to huggingface.co). Aborting."
      );
      process.exit(1);
    }
    console.log(`Model ready: ${MODEL_ID} (${warmup.length} dims)\n`);

    for (const { type, Model } of SOURCES) {
      const existingByIdRaw = await Embedding.find({ sourceType: type })
        .select("sourceId contentHash")
        .lean();
      const existingHash = new Map(
        existingByIdRaw.map((e) => [String(e.sourceId), e.contentHash])
      );

      let embedded = 0;
      let skipped = 0;
      let ops = [];
      const total = await Model.countDocuments();

      for await (const doc of Model.find().select("+contentExcerpt").lean().cursor()) {
        const text = buildDocText(type, doc);
        if (!text.trim()) {
          skipped++;
          continue;
        }
        const hash = contentHash(text);
        if (!force && existingHash.get(String(doc._id)) === hash) {
          skipped++;
          continue;
        }
        const embedding = await embedText(text);
        if (!embedding) {
          console.error(`  embed failed for ${type} ${doc._id}, skipping`);
          continue;
        }
        ops.push({
          updateOne: {
            filter: { sourceType: type, sourceId: doc._id },
            update: { $set: { contentHash: hash, modelId: MODEL_ID, embedding } },
            upsert: true,
          },
        });
        embedded++;
        if (ops.length >= BATCH_SIZE) {
          await Embedding.bulkWrite(ops);
          ops = [];
          process.stdout.write(`  ${type}: ${embedded + skipped}/${total}\r`);
        }
      }
      if (ops.length) await Embedding.bulkWrite(ops);

      // Prune embeddings whose source doc was deleted (deleteMany etc. bypass
      // the sync plugin — this is the cleanup path).
      const liveIds = await Model.distinct("_id");
      const pruned = await Embedding.deleteMany({
        sourceType: type,
        sourceId: { $nin: liveIds },
      });

      console.log(
        `${type}: ${embedded} embedded, ${skipped} skipped, ${pruned.deletedCount} pruned (${total} source docs)`
      );
    }

    const grandTotal = await Embedding.countDocuments();
    console.log(`\nDone. embeddings collection now holds ${grandTotal} vectors.`);
    process.exit(0);
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
})();
