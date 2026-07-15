// backend/utils/aiProviderChain.js
// Shared chat-LLM provider chain (Groq → HuggingFace → OpenAI) with the same
// 10-minute cooldown circuit breaker moderationService uses: a key that
// 401/403/429s (the OpenAI key has no quota) is skipped for a while instead
// of paying its failure on every single assistant request.

const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;
const cooldownUntil = {};

const getAIClientConfigs = () => {
  const preferredProvider = (process.env.AI_PROVIDER || "groq").toLowerCase();
  const huggingFaceKey =
    process.env.HUGGINGFACE_API_KEY ||
    process.env.HUGGINGFACE_HUB_TOKEN ||
    process.env.HF_TOKEN;

  const configs = [
    {
      provider: "groq",
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    },
    {
      provider: "huggingface",
      apiKey: huggingFaceKey,
      baseURL: "https://router.huggingface.co/v1",
      model: process.env.HUGGINGFACE_MODEL || "openai/gpt-oss-20b",
    },
    {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: undefined,
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    },
  ].filter((config) => config.apiKey);

  return configs.sort((a, b) => {
    if (a.provider === preferredProvider) return -1;
    if (b.provider === preferredProvider) return 1;
    return 0;
  });
};

/** Provider configs minus the ones currently cooling down after auth/quota failures. */
const getAvailableProviders = () =>
  getAIClientConfigs().filter(
    (config) => (cooldownUntil[config.provider] || 0) <= Date.now()
  );

/** Call on a provider error; quota/auth failures put the provider on cooldown. */
const markProviderFailure = (provider, error) => {
  if ([401, 403, 429].includes(error?.status)) {
    cooldownUntil[provider] = Date.now() + PROVIDER_COOLDOWN_MS;
    console.warn(
      `AI provider ${provider} on cooldown for 10 min (status ${error.status})`
    );
  }
};

module.exports = { getAIClientConfigs, getAvailableProviders, markProviderFailure };
