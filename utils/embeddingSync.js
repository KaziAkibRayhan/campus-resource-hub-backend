// backend/utils/embeddingSync.js
// Keeps the shared `embeddings` collection in sync with the 5 content
// collections via a mongoose plugin. Sync is fire-and-forget: it never blocks
// or fails the user's request — a missed embedding is picked up by the next
// run of scripts/backfill-embeddings.js.

const { buildDocText, contentHash, embedText, MODEL_ID } = require("./embeddingService");

// Lazy-required inside functions: the models register this plugin at load
// time, so requiring them at module top would be circular.
let modelsByType = null;
const getModels = () => {
  if (!modelsByType) {
    const mongoose = require("mongoose");
    modelsByType = {
      resource: mongoose.model("Resource"),
      club: mongoose.model("Club"),
      announcement: mongoose.model("Announcement"),
      event: mongoose.model("Event"),
      "lost-found": mongoose.model("LostFoundItem"),
    };
  }
  return modelsByType;
};
const getEmbeddingModel = () => require("../models/Embedding");

const syncEmbedding = (type, docId) => {
  setImmediate(async () => {
    try {
      const Embedding = getEmbeddingModel();
      // Re-fetch: post-findOneAndUpdate hooks may hand us the pre-update doc.
      const doc = await getModels()[type].findById(docId).lean();
      if (!doc) {
        await Embedding.deleteOne({ sourceType: type, sourceId: docId });
        return;
      }
      const text = buildDocText(type, doc);
      if (!text.trim()) return;
      const hash = contentHash(text);
      const existing = await Embedding.findOne({ sourceType: type, sourceId: docId })
        .select("contentHash")
        .lean();
      if (existing?.contentHash === hash) return; // content unchanged
      const embedding = await embedText(text);
      if (!embedding) return; // model unavailable — backfill will catch up
      await Embedding.updateOne(
        { sourceType: type, sourceId: docId },
        { $set: { contentHash: hash, modelId: MODEL_ID, embedding } },
        { upsert: true }
      );
      require("./semanticSearch").invalidateMemoryCache();
    } catch (error) {
      console.error(`Embedding sync failed (${type} ${docId}):`, error.message);
    }
  });
};

const removeEmbedding = (type, docId) => {
  setImmediate(async () => {
    try {
      await getEmbeddingModel().deleteOne({ sourceType: type, sourceId: docId });
      require("./semanticSearch").invalidateMemoryCache();
    } catch (error) {
      console.error(`Embedding delete failed (${type} ${docId}):`, error.message);
    }
  });
};

/**
 * Usage in a model file, before mongoose.model():
 *   schema.plugin(require("../utils/embeddingSync").embeddingPlugin, { type: "resource" });
 */
const embeddingPlugin = (schema, { type }) => {
  schema.post("save", (doc) => syncEmbedding(type, doc._id));
  schema.post("findOneAndUpdate", function (doc) {
    if (doc) syncEmbedding(type, doc._id);
  });
  schema.post("findOneAndDelete", (doc) => {
    if (doc) removeEmbedding(type, doc._id);
  });
  schema.post("deleteOne", { document: true, query: false }, function () {
    removeEmbedding(type, this._id);
  });
};

module.exports = { embeddingPlugin, syncEmbedding, removeEmbedding };
