// backend/utils/apiKeyPool.js
// One env var can hold several keys, comma or whitespace separated:
//
//   GROQ_API_KEY=gsk_first,gsk_second
//
// A key that comes back 401/402/403/429 is exhausted or rejected, so it is
// benched for ten minutes and callers move to the next key of the same
// provider before falling through to a different provider. Cooldown is keyed
// on the key itself, not the provider — one dead key must not take a working
// sibling down with it.
//
// State is per process. A serverless instance therefore re-learns which keys
// are exhausted after a cold start; that costs one failed call per key, which
// is why the window is long.

const KEY_COOLDOWN_MS = 10 * 60 * 1000;

// Statuses that mean "this key is done for now" rather than "this request was
// bad": unauthorized, payment required (a depleted free tier reports 402),
// forbidden, rate limited.
const EXHAUSTED_STATUSES = [401, 402, 403, 429];

const cooldownUntil = new Map();

/** Every key configured under the first env var that is set, in order. */
const readKeys = (...envNames) => {
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const keys = [...new Set(raw.split(/[,\s]+/).map((key) => key.trim()).filter(Boolean))];
    if (keys.length) return keys;
  }
  return [];
};

const isBenched = (key) => (cooldownUntil.get(key) || 0) > Date.now();

/** Configured keys that are not currently benched, in configured order. */
const readUsableKeys = (...envNames) => readKeys(...envNames).filter((key) => !isBenched(key));

/**
 * The key to use right now. Falls back to the first configured key when all
 * of them are benched, so a caller still attempts the request rather than
 * behaving as if nothing were configured.
 */
const firstUsableKey = (...envNames) => {
  const keys = readKeys(...envNames);
  return keys.find((key) => !isBenched(key)) || keys[0];
};

/** Bench a key after a failure. Non-quota errors leave it in rotation. */
const benchKey = (key, error, label = "api key") => {
  if (!key || !EXHAUSTED_STATUSES.includes(error?.status)) return false;
  cooldownUntil.set(key, Date.now() + KEY_COOLDOWN_MS);
  // Never log the key itself — only enough to tell which one dropped out.
  console.warn(`${label} benched for 10 min (status ${error.status})`);
  return true;
};

module.exports = {
  KEY_COOLDOWN_MS,
  EXHAUSTED_STATUSES,
  readKeys,
  readUsableKeys,
  firstUsableKey,
  benchKey,
};
