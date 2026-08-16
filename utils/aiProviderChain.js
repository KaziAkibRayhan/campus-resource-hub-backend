// backend/utils/aiProviderChain.js
// Shared chat-LLM provider chain, tried in the order declared below:
//   Groq → Hugging Face → Cerebras → OpenRouter → Gemini → OpenAI
// Each provider may have several keys configured — see utils/apiKeyPool — and
// the chain is flattened to one attempt per key, so an exhausted free tier
// moves to the next key of the same provider before changing provider. A key
// that reports 401/402/403/429 is benched for ten minutes instead of paying
// its failure on every request.
//
// Every provider here speaks the OpenAI chat-completions protocol, so adding
// one is a base URL, a key variable and a default model. A provider with no
// key configured simply drops out of the chain; that is how OpenAI is
// removed, without touching this file.

const { readKeys, readUsableKeys, benchKey } = require("./apiKeyPool");

const PROVIDERS = [
  {
    provider: "groq",
    envNames: ["GROQ_API_KEY"],
    baseURL: "https://api.groq.com/openai/v1",
    model: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  {
    provider: "huggingface",
    envNames: ["HUGGINGFACE_API_KEY", "HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    baseURL: "https://router.huggingface.co/v1",
    model: () => process.env.HUGGINGFACE_MODEL || "openai/gpt-oss-20b",
  },
  {
    provider: "cerebras",
    envNames: ["CEREBRAS_API_KEY"],
    baseURL: "https://api.cerebras.ai/v1",
    // Check GET /v1/models before changing this — Cerebras serves a short,
    // shifting list and an unknown id returns 404, not a helpful message.
    model: () => process.env.CEREBRAS_MODEL || "gpt-oss-120b",
  },
  {
    provider: "openrouter",
    envNames: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    // Free model ids carry a ":free" suffix and are retired or moved to paid
    // from time to time; override with OPENROUTER_MODEL when that happens.
    // Pick one that answers directly: several free models emit their own
    // reasoning ("Here's a thinking process:") as the answer.
    model: () =>
      process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-nano-30b-a3b:free",
  },
  {
    provider: "gemini",
    envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    // Google exposes an OpenAI-compatible surface alongside its own SDK; the
    // trailing slash matters, the client appends "chat/completions" to it.
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  {
    provider: "openai",
    envNames: ["OPENAI_API_KEY"],
    baseURL: undefined,
    model: () => process.env.OPENAI_MODEL || "gpt-4.1-mini",
  },
];

// `keys` is the subset to build configs for; `allKeys` is everything the
// provider has configured, so a key keeps the same label once its siblings
// are benched ("groq key 2/2" stays that, rather than becoming "groq").
const toConfigs = (spec, keys, allKeys) =>
  keys.map((apiKey) => ({
    provider: spec.provider,
    // Which key of this provider — for logs and diagnostics, never the key.
    keyLabel:
      allKeys.length > 1
        ? `${spec.provider} key ${allKeys.indexOf(apiKey) + 1}/${allKeys.length}`
        : spec.provider,
    apiKey,
    baseURL: spec.baseURL,
    model: spec.model(),
  }));

// Preferred provider first, everything else in declared order. Ranking rather
// than comparing the two sides keeps the comparator consistent — returning -1
// for both sides when both are preferred reorders a provider's own keys.
const byPreferredFirst = (configs) => {
  const preferredProvider = (process.env.AI_PROVIDER || "groq").toLowerCase();
  const rank = (config) => (config.provider === preferredProvider ? 0 : 1);
  return configs.sort((a, b) => rank(a) - rank(b));
};

const buildChain = (selectKeys) =>
  byPreferredFirst(
    PROVIDERS.flatMap((spec) => {
      const allKeys = readKeys(...spec.envNames);
      return toConfigs(spec, selectKeys(spec, allKeys), allKeys);
    })
  );

/** Every configured (provider, key) attempt, preferred provider first. */
const getAIClientConfigs = () => buildChain((spec, allKeys) => allKeys);

/** As above, minus keys currently benched after auth/quota failures. */
const getAvailableProviders = () =>
  buildChain((spec) => readUsableKeys(...spec.envNames));

/**
 * Call on a provider error. Quota/auth failures bench that one key; the next
 * key of the same provider is tried on the next pass.
 * Accepts the config the attempt used.
 */
const markProviderFailure = (config, error) =>
  benchKey(config?.apiKey, error, `AI provider ${config?.keyLabel || config?.provider}`);

module.exports = { getAIClientConfigs, getAvailableProviders, markProviderFailure };
