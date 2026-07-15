// backend/utils/semanticSearch.js
// Semantic (vector) search core, shared by the AI assistant and the 5 list
// endpoints. Search chain per query:
//   1. Atlas $vectorSearch on the shared `embeddings` collection (index
//      "embedding_index", readiness probed and cached)
//   2. in-memory cosine similarity over a cached load of all embeddings
//   3. null → caller falls back to its existing regex search
//
// SECURITY: results here are {type, id, score} candidates ONLY. Callers MUST
// re-query the source collections with their own visibility filters
// (approved, department gating, moderator bypass) before returning anything
// to a user — the vector index carries no authorization data.

const Embedding = require("../models/Embedding");
const { embedText, SOURCE_TYPES } = require("./embeddingService");

const VECTOR_INDEX_NAME = "embedding_index";
// Below this cosine similarity a hit is considered noise. 0.30 (not higher)
// because multilingual MiniLM scores acronym↔expansion pairs ("CSE" vs
// "Computer Science") around 0.25-0.30; exact keyword matches are re-added by
// hybridRank anyway.
const MIN_COSINE = Number(process.env.SEMANTIC_MIN_SCORE || 0.3);
const INDEX_PROBE_TTL_MS = 10 * 60 * 1000;
const MEM_CACHE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------- Atlas path

let indexProbe = { ready: false, checkedAt: 0 };

const atlasIndexReady = async () => {
  if (Date.now() - indexProbe.checkedAt < INDEX_PROBE_TTL_MS) return indexProbe.ready;
  try {
    const indexes = await Embedding.collection.listSearchIndexes().toArray();
    indexProbe = {
      ready: indexes.some(
        (i) => i.name === VECTOR_INDEX_NAME && (i.queryable ?? i.status === "READY")
      ),
      checkedAt: Date.now(),
    };
  } catch {
    // listSearchIndexes is unsupported off-Atlas (local mongod) — use memory path.
    indexProbe = { ready: false, checkedAt: Date.now() };
  }
  return indexProbe.ready;
};

const atlasSearch = async (queryVector, types, limit) => {
  const rows = await Embedding.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 10, 150),
        limit,
        filter: { sourceType: { $in: types } },
      },
    },
    { $project: { sourceType: 1, sourceId: 1, score: { $meta: "vectorSearchScore" } } },
  ]);
  return rows
    // Atlas cosine score is normalized to (cos+1)/2 — convert back to cosine.
    .map((r) => ({ type: r.sourceType, id: r.sourceId, score: 2 * r.score - 1 }))
    .filter((r) => r.score >= MIN_COSINE);
};

// ------------------------------------------------------------- memory path

let memCache = null; // { loadedAt, rows: [{sourceType, sourceId, embedding}] }

const invalidateMemoryCache = () => {
  memCache = null;
};

const memorySearch = async (queryVector, types, limit) => {
  if (!memCache || Date.now() - memCache.loadedAt > MEM_CACHE_TTL_MS) {
    const rows = await Embedding.find({})
      .select("sourceType sourceId embedding")
      .lean();
    memCache = { loadedAt: Date.now(), rows };
  }
  const wanted = new Set(types);
  const scored = [];
  for (const row of memCache.rows) {
    if (!wanted.has(row.sourceType)) continue;
    let dot = 0;
    const v = row.embedding;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVector[i];
    if (dot >= MIN_COSINE) {
      scored.push({ type: row.sourceType, id: row.sourceId, score: dot });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
};

// ----------------------------------------------------------------- search

/**
 * @param {string} query
 * @param {{types?: string[], limit?: number}} options
 * @returns {Promise<Array<{type: string, id: any, score: number}>|null>}
 *   Ranked candidates (cosine score, best first), or null when the embedding
 *   model is unavailable — callers must then use their regex path.
 */
const search = async (query, { types = SOURCE_TYPES, limit = 30 } = {}) => {
  const queryVector = await embedText(query);
  if (!queryVector) return null;

  if (await atlasIndexReady()) {
    try {
      const rows = await atlasSearch(queryVector, types, limit);
      if (rows.length) return rows;
      // 0 rows may legitimately mean "nothing similar", but also occurs while
      // an index is still building — the memory pass costs ~ms and settles it.
    } catch (error) {
      console.error("$vectorSearch failed, using in-memory fallback:", error.message);
      indexProbe = { ready: false, checkedAt: Date.now() };
    }
  }
  return memorySearch(queryVector, types, limit);
};

// ------------------------------------------------------------ hybrid rank

/**
 * Merge semantic candidates with regex-matched ids so exact keyword matches
 * never disappear. Docs matched by both get a boost; keyword-only docs enter
 * at 0.5 (above most pure-semantic scores, below strong both-matches).
 */
const hybridRank = (semantic, keywordIds) => {
  const byId = new Map(
    semantic.map((s) => [String(s.id), { ...s, matchType: "semantic" }])
  );
  for (const id of keywordIds) {
    const hit = byId.get(String(id));
    if (hit) {
      hit.score += 0.25;
      hit.matchType = "both";
    } else {
      byId.set(String(id), { id, score: 0.5, matchType: "keyword" });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
};

// ------------------------------------------- list-endpoint pagination helper

/**
 * Drop-in semantic upgrade for a list endpoint's `?search=` branch.
 * Relevance order can't be expressed as a Mongo sort, so the full candidate
 * set (bounded by candidateLimit) is fetched and paginated in JS — fine at
 * this data scale, and `total`/page shape stays identical to the regex path.
 *
 * `baseQuery` must be the endpoint's FULL filter set (visibility, department,
 * status...) WITHOUT the search $or — it is re-applied over candidate ids, so
 * the vector path can never leak anything the regex path wouldn't show.
 *
 * @returns {Promise<{docs: any[], total: number}|null>} null → caller keeps
 *   its existing regex path.
 */
const semanticPaginatedFind = async (
  Model,
  {
    type,
    search: searchText,
    baseQuery = {},
    regexOr = [],
    page = 1,
    limit = 12,
    populate = [],
    select,
    candidateLimit = 150,
  }
) => {
  const semantic = await search(searchText, { types: [type], limit: candidateLimit });
  if (semantic === null) return null;

  let keywordIds = [];
  if (regexOr.length) {
    const keywordQuery =
      Object.keys(baseQuery).length > 0
        ? { $and: [baseQuery, { $or: regexOr }] }
        : { $or: regexOr };
    keywordIds = (await Model.find(keywordQuery).select("_id").lean()).map((d) =>
      String(d._id)
    );
  }

  const ranked = hybridRank(semantic, keywordIds);
  if (!ranked.length) return { docs: [], total: 0 };
  const rankIndex = new Map(ranked.map((r, i) => [String(r.id), i]));

  // The join IS the authorization step: baseQuery re-applied over candidates.
  const joinQuery =
    Object.keys(baseQuery).length > 0
      ? { $and: [baseQuery, { _id: { $in: ranked.map((r) => r.id) } }] }
      : { _id: { $in: ranked.map((r) => r.id) } };
  let queryBuilder = Model.find(joinQuery);
  if (select) queryBuilder = queryBuilder.select(select);
  for (const args of populate) queryBuilder = queryBuilder.populate(...args);
  const docs = await queryBuilder.lean();

  docs.sort(
    (a, b) => (rankIndex.get(String(a._id)) ?? 1e9) - (rankIndex.get(String(b._id)) ?? 1e9)
  );
  const start = (page - 1) * limit;
  return { docs: docs.slice(start, start + limit), total: docs.length };
};

module.exports = {
  search,
  hybridRank,
  semanticPaginatedFind,
  invalidateMemoryCache,
  VECTOR_INDEX_NAME,
};
