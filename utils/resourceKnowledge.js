const OpenAI = require("openai");
const ResourceChunk = require("../models/ResourceChunk");
const { embedMany, embedText, cosineSim } = require("./embeddingService");
const { firstUsableKey } = require("./apiKeyPool");

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 180;
const MAX_CHUNKS = 40;
const MAX_DESCRIBED_IMAGES = 4;

const cleanText = (value = "") =>
  value.replace(/\0/g, " ").replace(/\s+/g, " ").trim();

const chunkText = (texts = []) => {
  const joined = cleanText(texts.filter(Boolean).join("\n"));
  const chunks = [];
  let start = 0;
  while (start < joined.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(joined.length, start + CHUNK_CHARS);
    if (end < joined.length) {
      const boundary = joined.lastIndexOf(" ", end);
      if (boundary > start + CHUNK_CHARS * 0.65) end = boundary;
    }
    const text = joined.slice(start, end).trim();
    if (text) chunks.push({ kind: "text", label: `Text section ${chunks.length + 1}`, text });
    if (end >= joined.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
};

const parseDescription = (raw = "") => cleanText(raw.replace(/<think>[\s\S]*?<\/think>/gi, ""));

const visionProviders = () => [
  {
    provider: "groq",
    key: firstUsableKey("GROQ_API_KEY"),
    baseURL: "https://api.groq.com/openai/v1",
    model: process.env.GROQ_VISION_GUARD_MODEL || "qwen/qwen3.6-27b",
  },
  {
    provider: "huggingface",
    key: firstUsableKey("HUGGINGFACE_API_KEY", "HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"),
    baseURL: "https://router.huggingface.co/v1",
    model: process.env.HUGGINGFACE_VISION_MODEL || "zai-org/GLM-4.5V",
  },
  {
    provider: "openai",
    key: firstUsableKey("OPENAI_API_KEY"),
    baseURL: undefined,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  },
].filter((provider) => provider.key);

const describeImage = async (image) => {
  const prompt = [
    "Describe this university resource image for semantic search and question answering.",
    "State the main subject, visible objects, diagrams, document/page topic, and important readable text.",
    "Be factual and concise (2-4 sentences). Do not guess identities or hidden context.",
  ].join(" ");
  for (const provider of visionProviders()) {
    try {
      const client = new OpenAI({ apiKey: provider.key, baseURL: provider.baseURL, maxRetries: 0 });
      const completion = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image.dataUrl } },
        ] }],
        max_tokens: 300,
        temperature: 0,
        ...(provider.provider === "groq" ? { reasoning_effort: "none" } : {}),
      });
      const description = parseDescription(completion.choices?.[0]?.message?.content || "");
      if (description) return { description, provider: provider.provider };
    } catch (error) {
      console.error(`Resource image description failed (${provider.provider}):`, error.message);
    }
  }
  return null;
};

const buildKnowledgeChunks = async (extraction = {}, { describeImages = true } = {}) => {
  const chunks = chunkText(extraction.texts || []);
  if (describeImages) {
    for (const image of (extraction.images || []).slice(0, MAX_DESCRIBED_IMAGES)) {
      const result = await describeImage(image);
      if (result?.description) {
        chunks.push({
          kind: "image-description",
          label: image.label || "Image",
          text: result.description,
          descriptionProvider: result.provider,
        });
      }
      if (chunks.length >= MAX_CHUNKS) break;
    }
  }
  return chunks.slice(0, MAX_CHUNKS);
};

const indexResourceKnowledge = async (resourceId, extraction, options = {}) => {
  const chunks = await buildKnowledgeChunks(extraction, options);
  const embeddings = await embedMany(chunks.map((chunk) => chunk.text));
  await ResourceChunk.deleteMany({ resource: resourceId });
  if (chunks.length) {
    await ResourceChunk.insertMany(chunks.map((chunk, order) => ({
      resource: resourceId,
      order,
      kind: chunk.kind,
      label: chunk.label,
      text: chunk.text,
      embedding: embeddings[order] || undefined,
    })));
  }
  const Resource = require("../models/Resource");
  await Resource.updateOne({ _id: resourceId }, { $set: {
    "knowledge.status": chunks.length ? "ready" : "empty",
    "knowledge.chunkCount": chunks.length,
    "knowledge.indexedAt": new Date(),
    "knowledge.hasImageDescriptions": chunks.some((chunk) => chunk.kind === "image-description"),
  } });
  return chunks.length;
};

const scheduleResourceKnowledge = (resourceId, extraction, options = {}) => {
  // setImmediate work is not durable in a serverless function and retains the
  // upload's extracted images/text after the HTTP response. Skip it on Vercel
  // unless explicitly enabled; the backfill script remains the safe recovery
  // path for pending resources.
  if (process.env.VERCEL && process.env.ENABLE_BACKGROUND_INDEXING !== "1") {
    console.log(`Resource knowledge indexing deferred (${resourceId})`);
    return;
  }
  setImmediate(() => indexResourceKnowledge(resourceId, extraction, options).catch(async (error) => {
    console.error(`Resource knowledge indexing failed (${resourceId}):`, error.message);
    const Resource = require("../models/Resource");
    await Resource.updateOne({ _id: resourceId }, { $set: { "knowledge.status": "failed" } }).catch(() => {});
  }));
};

const searchResourceKnowledge = async (question, visibleResourceIds, { limit = 12 } = {}) => {
  if (!visibleResourceIds.length) return [];
  const rows = await ResourceChunk.find({ resource: { $in: visibleResourceIds } })
    .select("resource order kind label text +embedding")
    .lean();
  if (!rows.length) return [];
  const queryVector = await embedText(question);
  const terms = cleanText(question).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 2);
  return rows.map((row) => {
    const haystack = row.text.toLowerCase();
    const keywordScore = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 0;
    const semanticScore = queryVector && row.embedding?.length === queryVector.length
      ? cosineSim(queryVector, row.embedding)
      : 0;
    return { ...row, score: semanticScore + keywordScore * 0.35, semanticScore, keywordScore };
  }).filter((row) => row.score >= 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

module.exports = {
  chunkText,
  buildKnowledgeChunks,
  indexResourceKnowledge,
  scheduleResourceKnowledge,
  searchResourceKnowledge,
};
