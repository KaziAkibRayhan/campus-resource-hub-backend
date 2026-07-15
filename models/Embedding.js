const mongoose = require("mongoose");

// One shared collection for all content-type embeddings. A single collection
// means a single Atlas Vector Search index (M0 clusters allow only 3 search
// indexes total) and keeps the 5 source schemas free of vector payloads.
// Authorization is NEVER stored here — semantic search returns candidate ids
// and callers re-query the source collections with their visibility filters.
const embeddingSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      required: true,
      // Keep in sync with embeddingService.SOURCE_TYPES and the frontend
      // Header.jsx source-type keys.
      enum: ["resource", "club", "announcement", "event", "lost-found"],
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // sha1(modelId + "|" + docText) — write path skips re-embedding when the
    // embeddable text hasn't changed (e.g. approve/reject flips).
    contentHash: { type: String, required: true },
    modelId: { type: String, required: true },
    // Unit-normalized 384-dim vector from multilingual MiniLM.
    embedding: { type: [Number], required: true },
  },
  { timestamps: true }
);

embeddingSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });

module.exports = mongoose.model("Embedding", embeddingSchema);
