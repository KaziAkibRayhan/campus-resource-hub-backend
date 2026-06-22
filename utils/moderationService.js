// backend/utils/moderationService.js
// Decides whether extracted upload content (text + images) is safe.
// Provider chain (both are free with existing keys):
//   1. OpenAI omni-moderation-latest          — text + images, no token cost
//      (requires the OpenAI account to have billing enabled)
//   2. Groq: gpt-oss-safeguard-20b for text,
//      llama-4-scout (vision) as image safety judge
// If no provider is reachable the upload is allowed but marked "skipped"
// so admins can review it later (fail-open: an API outage must not block
// every student upload).

const OpenAI = require("openai");

// Per-category score thresholds for omni-moderation. Slightly above the
// API defaults for "sexual"/"violence" to tolerate academic content
// (anatomy diagrams, history material), near-zero for minors.
const OPENAI_THRESHOLDS = {
  sexual: 0.5,
  "sexual/minors": 0.02,
  violence: 0.78,
  "violence/graphic": 0.55,
  hate: 0.55,
  "hate/threatening": 0.35,
  harassment: 0.78,
  "harassment/threatening": 0.55,
  "self-harm": 0.55,
  "self-harm/intent": 0.45,
  "self-harm/instructions": 0.4,
  illicit: 0.8,
  "illicit/violent": 0.55,
};

const CATEGORY_LABELS = {
  sexual: "sexual or nude content",
  "sexual/minors": "sexual content involving minors",
  violence: "violent content",
  "violence/graphic": "graphic violence",
  hate: "hateful content",
  "hate/threatening": "hateful threats",
  harassment: "harassment",
  "harassment/threatening": "threatening harassment",
  "self-harm": "self-harm content",
  "self-harm/intent": "self-harm content",
  "self-harm/instructions": "self-harm instructions",
  illicit: "illicit activity",
  "illicit/violent": "violent illicit activity",
};

const SAFETY_POLICY = `You are a strict content-safety classifier for a university file-sharing platform where students share study materials.

Classify the given content as UNSAFE if it contains any of:
- "sexual or nude content": nudity, pornography, sexually explicit or suggestive material
- "sexual content involving minors": any sexualization of minors
- "graphic violence": gore, severe injuries, glorified violence
- "hateful content": hate speech, hateful symbols, harassment of groups or individuals
- "self-harm content": encouragement or instructions for self-harm or suicide
- "illicit activity": instructions for weapons, drugs, or serious crimes

Educational material (anatomy diagrams, medical or biology content, history, law, art) is SAFE.

Respond with ONLY a JSON object, no other text:
{"unsafe": true|false, "categories": ["..."]}
The categories array must use only the quoted category names above and must be empty when safe.`;

const parseJudgeVerdict = (raw) => {
  const match = (raw || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.unsafe !== "boolean") return null;
    return {
      unsafe: parsed.unsafe,
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.map(String)
        : [],
    };
  } catch {
    return null;
  }
};

const TEXT_CHUNK_CHARS = 6000;
const MAX_TEXT_CHUNKS = 6;
const IMAGES_PER_REQUEST = 2;
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;
const providerCooldownUntil = {};

const chunkTexts = (texts) => {
  const chunks = [];
  for (const text of texts) {
    const clean = (text || "").trim();
    if (!clean) continue;
    for (let i = 0; i < clean.length; i += TEXT_CHUNK_CHARS) {
      chunks.push(clean.slice(i, i + TEXT_CHUNK_CHARS));
      if (chunks.length >= MAX_TEXT_CHUNKS) return chunks;
    }
  }
  return chunks;
};

const moderateWithOpenAI = async ({ texts, images }) => {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0, // fail fast to the next provider
  });
  const model = process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";

  // One request for all text chunks, then images in small batches.
  const inputs = [];
  const textChunks = chunkTexts(texts);
  if (textChunks.length) {
    inputs.push(textChunks.map((text) => ({ type: "text", text })));
  }
  for (let i = 0; i < images.length; i += IMAGES_PER_REQUEST) {
    inputs.push(
      images.slice(i, i + IMAGES_PER_REQUEST).map((image) => ({
        type: "image_url",
        image_url: { url: image.dataUrl },
      }))
    );
  }

  const flaggedCategories = new Set();
  const responses = await Promise.all(
    inputs.map((input) => client.moderations.create({ model, input }))
  );
  for (const response of responses) {
    for (const result of response.results || []) {
      const scores = result.category_scores || {};
      for (const [category, threshold] of Object.entries(OPENAI_THRESHOLDS)) {
        const score = scores[category];
        if (typeof score === "number" && score >= threshold) {
          flaggedCategories.add(category);
        }
      }
    }
  }

  return {
    flagged: flaggedCategories.size > 0,
    categories: [...flaggedCategories].map(
      (c) => CATEGORY_LABELS[c] || c
    ),
    provider: "openai",
    status: "checked",
  };
};

const moderateWithGroq = async ({ texts, images }) => {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const textModel =
    process.env.GROQ_TEXT_GUARD_MODEL || "openai/gpt-oss-safeguard-20b";
  const visionModel =
    process.env.GROQ_VISION_GUARD_MODEL ||
    "meta-llama/llama-4-scout-17b-16e-instruct";

  const flaggedCategories = new Set();
  let judged = false;
  let lastError = null;

  const applyVerdict = (verdict) => {
    if (!verdict) return;
    judged = true;
    if (verdict.unsafe) {
      for (const c of verdict.categories.length
        ? verdict.categories
        : ["unsafe content"]) {
        flaggedCategories.add(c);
      }
    }
  };

  const joinedText = chunkTexts(texts).join("\n").slice(0, TEXT_CHUNK_CHARS);
  if (joinedText) {
    try {
      const completion = await client.chat.completions.create({
        model: textModel,
        messages: [
          { role: "system", content: SAFETY_POLICY },
          { role: "user", content: joinedText },
        ],
        max_tokens: 512,
        temperature: 0,
      });
      applyVerdict(parseJudgeVerdict(completion.choices?.[0]?.message?.content));
    } catch (error) {
      // A failed text judge shouldn't discard image verdicts (and vice versa).
      // We only throw at the end if NOTHING was judged.
      lastError = error;
      console.error("Groq text judge failed:", error.message);
    }
  }

  // Vision judge: one image per request keeps Scout reliable.
  for (const image of images) {
    try {
      const completion = await client.chat.completions.create({
        model: visionModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: SAFETY_POLICY },
              { type: "image_url", image_url: { url: image.dataUrl } },
            ],
          },
        ],
        max_tokens: 256,
        temperature: 0,
      });
      applyVerdict(parseJudgeVerdict(completion.choices?.[0]?.message?.content));
    } catch (error) {
      lastError = error;
      console.error("Groq vision judge failed for an image:", error.message);
    }
  }

  if (!judged) {
    // Surface the underlying status (401/403/429) so the provider cooldown in
    // moderateContent can trip instead of paying the failure on every upload.
    if (lastError) throw lastError;
    throw new Error("Groq safety judges returned no parseable verdicts");
  }

  return {
    flagged: flaggedCategories.size > 0,
    categories: [...flaggedCategories],
    provider: "groq",
    status: "checked",
  };
};

/**
 * @param {{texts?: string[], images?: {dataUrl: string, label?: string}[]}} content
 * @returns {Promise<{flagged: boolean, categories: string[], provider: string|null, status: "checked"|"unavailable"}>}
 */
const moderateContent = async ({ texts = [], images = [] }) => {
  const hasContent =
    texts.some((t) => (t || "").trim()) || images.length > 0;
  if (!hasContent) {
    return { flagged: false, categories: [], provider: null, status: "checked" };
  }

  const providers = [];
  if (process.env.OPENAI_API_KEY) {
    providers.push({ name: "openai", run: moderateWithOpenAI });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ name: "groq", run: moderateWithGroq });
  }

  for (const provider of providers) {
    if ((providerCooldownUntil[provider.name] || 0) > Date.now()) continue;
    try {
      const started = Date.now();
      const verdict = await provider.run({ texts, images });
      console.log(
        `Moderation via ${provider.name}: ${
          verdict.flagged ? `FLAGGED [${verdict.categories.join(", ")}]` : "clean"
        } (${images.length} image(s), ${Date.now() - started}ms)`
      );
      return verdict;
    } catch (error) {
      console.error(
        `Moderation provider ${provider.name} failed:`,
        error.message
      );
      // Quota/auth failures won't fix themselves between uploads — skip the
      // provider for a while instead of paying the failure on every upload.
      if ([401, 403, 429].includes(error.status)) {
        providerCooldownUntil[provider.name] = Date.now() + PROVIDER_COOLDOWN_MS;
      }
    }
  }

  console.warn("No moderation provider available — upload marked for review.");
  return { flagged: false, categories: [], provider: null, status: "unavailable" };
};

const describeCategories = (categories = []) =>
  categories.length ? categories.join(", ") : "policy-violating content";

module.exports = { moderateContent, describeCategories };
