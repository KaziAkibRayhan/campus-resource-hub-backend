// backend/utils/embeddingService.js
// Local text-embedding service for semantic search. Runs a quantized
// multilingual MiniLM (Bangla + English) via @xenova/transformers — no API
// key, no per-request cost. The ~129MB model downloads from Hugging Face on
// first use and is cached under TRANSFORMERS_CACHE_DIR (./.model-cache, or
// /tmp/.model-cache on serverless).
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

// A serverless root filesystem is read-only, so ./.model-cache can never be
// written there — the ~129MB download (113MB quantized ONNX + 16MB tokenizer)
// would be repeated, and thrown away, on every retry. /tmp is writable and
// survives across invocations on a warm instance, so a container pays the
// download at most once.
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const CACHE_DIR =
  process.env.TRANSFORMERS_CACHE_DIR ||
  (IS_SERVERLESS ? "/tmp/.model-cache" : "./.model-cache");

// How long a caller may block on this service. The model is an optimization —
// a cold download must never hold an assistant request open, so on serverless
// we hand back null fast and let the init keep warming in the background.
// Off serverless (dev, backfill scripts) the first download is expected to
// take a while, so the wait is effectively unbounded.
const INIT_WAIT_MS = Number(
  process.env.EMBEDDING_INIT_WAIT_MS || (IS_SERVERLESS ? 3000 : 180000)
);
const EMBED_WAIT_MS = Number(
  process.env.EMBEDDING_WAIT_MS || (IS_SERVERLESS ? 5000 : 60000)
);

let pipelinePromise = null; // in-flight or resolved init; dedupes concurrent callers
let unavailableUntil = 0;

/**
 * Await `promise`, but give up waiting after `ms` and resolve null instead.
 * The promise itself is left running — an init that is merely slow still
 * completes and serves the next caller.
 */
const waitAtMost = async (promise, ms, label) => {
  let timer;
  const result = await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`Embedding ${label} exceeded ${ms}ms — falling back to regex search`);
        resolve(null);
      }, ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
};

const initPipeline = async () => {
  // @xenova/transformers is ESM-only; this app is CommonJS.
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = CACHE_DIR;
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
  if (!promise) return null;
  const extractor = await waitAtMost(promise, INIT_WAIT_MS, "model init");
  if (!extractor) return null;
  try {
    const output = await waitAtMost(
      extractor(clean.slice(0, MAX_INPUT_CHARS), { pooling: "mean", normalize: true }),
      EMBED_WAIT_MS,
      "inference"
    );
    if (!output) return null;
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
