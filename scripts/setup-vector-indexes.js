// One-time setup of the Atlas Vector Search index on the shared `embeddings`
// collection. Idempotent — safe to re-run.
//
//   node scripts/setup-vector-indexes.js
//
// Run scripts/backfill-embeddings.js FIRST: createSearchIndex fails if the
// collection doesn't exist yet. After creation the index takes ~1 minute to
// become queryable (check Atlas UI → Search & Vector Search). Only 1 of the
// M0 tier's 3 allowed search indexes is used.
require("dotenv").config();
const mongoose = require("mongoose");
const { EMBEDDING_DIMENSIONS } = require("../utils/embeddingService");

const INDEX_NAME = "embedding_index";

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const collection = mongoose.connection.db.collection("embeddings");

    const count = await collection.countDocuments();
    if (count === 0) {
      console.error(
        "The embeddings collection is empty/missing. Run scripts/backfill-embeddings.js first."
      );
      process.exit(1);
    }

    const existing = await collection
      .listSearchIndexes()
      .toArray()
      .catch(() => []);
    const found = existing.find((i) => i.name === INDEX_NAME);
    if (found) {
      console.log(
        `Index "${INDEX_NAME}" already exists (queryable: ${found.queryable ?? found.status}). Nothing to do.`
      );
      process.exit(0);
    }

    await collection.createSearchIndex({
      name: INDEX_NAME,
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: EMBEDDING_DIMENSIONS,
            similarity: "cosine",
          },
          { type: "filter", path: "sourceType" },
        ],
      },
    });
    console.log(
      `Created vector index "${INDEX_NAME}" on embeddings (${count} docs). It takes ~1 min to become queryable.`
    );
    process.exit(0);
  } catch (error) {
    console.error("Index setup failed:", error.message);
    process.exit(1);
  }
})();
