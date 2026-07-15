// backend/utils/embeddingService.js
// Local text-embedding service for semantic search. Runs a quantized
// multilingual MiniLM (Bangla + English) via @xenova/transformers — no API
// key, no per-request cost. The ~50MB ONNX model downloads from Hugging Face
// on first use and is cached under TRANSFORMERS_CACHE_DIR (./.model-cache).
//
// Failure philosophy: this service NEVER throws to callers. If the model
// can't initialize (no internet, low memory, EMBEDDINGS_DISABLED=1) every
// embed call returns null and callers fall back to their existing regex
// search — semantic search degrades, nothing breaks.

const crypto = require("crypto");

const MODEL_ID =
  process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const EMBEDDING_DIMENSIONS = 384;
const MAX_INPUT_CHARS = 2000;
// Mirror the moderationService circuit breaker: a failed model init (usually
// no route to huggingface.co) won't fix itself between requests.
const INIT_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

let pipelinePromise = null; // in-flight or resolved init; dedupes concurrent callers
let unavailableUntil = 0;

const initPipeline = async () => {
  // @xenova/transformers is ESM-only; this app is CommonJS.
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR || "./.model-cache";
  env.allowLocalModels = false;
  return pipeline("feature-extraction", MODEL_ID, { quantized: true });
};

const getPipeline = () => {
  if (process.env.EMBEDDINGS_DISABLED === "1") return null;
  if (Date.now() < unavailableUntil) return null;
  if (!pipelinePromise) {
    pipelinePromise = initPipeline().catch((error) => {
      console.error("Embedding model unavailable:", error.message);
      pipelinePromise = null; // allow a retry after the cooldown
      unavailableUntil = Date.now() + INIT_RETRY_COOLDOWN_MS;
      return null;
    });
  }
  return pipelinePromise;
};

/**
 * Embed one text. Returns a unit-normalized number[384], or null when the
 * model is unavailable (callers must fall back to regex search).
 */
const embedText = async (text) => {
  const clean = (text || "").trim();
  if (!clean) return null;
  const promise = getPipeline();
  const extractor = promise && (await promise);
  if (!extractor) return null;
  try {
    const output = await extractor(clean.slice(0, MAX_INPUT_CHARS), {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  } catch (error) {
    console.error("Embedding failed:", error.message);
    return null;
  }
};

/** Embed many texts sequentially (single-threaded ONNX; fine at our scale). */
const embedMany = async (texts) => {
  const vectors = [];
  for (const text of texts) {
    vectors.push(await embedText(text));
  }
  return vectors;
};

/** Vectors are pre-normalized, so cosine similarity is a plain dot product. */
const cosineSim = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/** Hash of what was embedded — changes when the doc text or model changes. */
const contentHash = (text) =>
  crypto.createHash("sha1").update(`${MODEL_ID}|${text}`).digest("hex");

// Canonical embeddable text per source type. Keep in sync with the models —
// contentHash covers these fields, so editing any of them re-embeds the doc.
const DOC_TEXT_BUILDERS = {
  resource: (doc) =>
    [
      doc.title,
      doc.description,
      doc.course && `Course: ${doc.course}`,
      doc.department && `Department: ${doc.department}`,
      doc.semester && `Semester: ${doc.semester}`,
      // Inner file text so "what's inside X" queries match semantically.
      doc.contentExcerpt && `Content: ${doc.contentExcerpt.slice(0, 1200)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  club: (doc) =>
    [doc.name, doc.description, doc.category && `Category: ${doc.category}`]
      .filter(Boolean)
      .join("\n"),
  announcement: (doc) =>
    [
      doc.title,
      (doc.content || "").slice(0, 1500),
      doc.department && `Department: ${doc.department}`,
    ]
      .filter(Boolean)
      .join("\n"),
  event: (doc) =>
    [
      doc.title,
      doc.description,
      doc.club && `Club: ${doc.club}`,
      doc.location && `Location: ${doc.location}`,
      doc.date && `Date: ${new Date(doc.date).toISOString().slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  "lost-found": (doc) =>
    [
      doc.type && doc.item ? `${doc.type} item: ${doc.item}` : doc.item,
      doc.description,
      doc.location && `Location: ${doc.location}`,
    ]
      .filter(Boolean)
      .join("\n"),
};

const SOURCE_TYPES = Object.keys(DOC_TEXT_BUILDERS);

const buildDocText = (type, doc) => {
  const builder = DOC_TEXT_BUILDERS[type];
  if (!builder) throw new Error(`Unknown embedding source type: ${type}`);
  return builder(doc);
};

module.exports = {
  MODEL_ID,
  EMBEDDING_DIMENSIONS,
  SOURCE_TYPES,
  embedText,
  embedMany,
  cosineSim,
  contentHash,
  buildDocText,
};
