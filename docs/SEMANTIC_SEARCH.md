# Semantic Search & Streaming AI Assistant

## What it is

All search in CRH (the header AI assistant + the Resources / Events / Clubs /
Announcements / Lost & Found list pages) is now **semantic**: queries match by
meaning, not just keywords, in Bangla, Banglish, and English. Example:
"wallet hariye geche" also finds "Small Coin Purse".

## Architecture

| Piece | File | Notes |
|---|---|---|
| Embedding model | `utils/embeddingService.js` | Local `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim) via @xenova/transformers. No API key, no cost. ~50MB downloads to `.model-cache/` on first use. |
| Vector storage | `models/Embedding.js` | ONE shared `embeddings` collection for all 5 content types (Atlas M0 allows only 3 search indexes — this uses 1). |
| Write sync | `utils/embeddingSync.js` | Mongoose plugin on the 5 models; fire-and-forget, never blocks a request. |
| Search core | `utils/semanticSearch.js` | Chain: Atlas `$vectorSearch` → in-memory cosine fallback → `null` (callers then use their old regex). Hybrid ranking keeps exact keyword matches on top. |
| LLM provider chain | `utils/aiProviderChain.js` | Groq → HuggingFace → OpenAI with 10-min cooldown on 401/403/429. |
| Streaming | `POST /api/chat/assistant/stream` | SSE: `sources` → `token`… → `done`. Non-streaming `POST /api/chat/assistant` kept as fallback. |

**Security:** the vector index carries no authorization data. Semantic results
are candidate ids only; every caller re-queries the source collection with its
own visibility filters (approved, department gating, moderator bypass), so the
vector path can never leak unapproved or foreign-department content.

## Setup / runbook

```bash
npm install                              # once
node scripts/backfill-embeddings.js      # embed existing docs (idempotent, --force to redo)
node scripts/setup-vector-indexes.js     # create the Atlas vector index (once)
```

Order matters: backfill first (the index needs the collection to exist).
The index takes ~1 minute to become queryable after creation.

Re-run the backfill any time — it skips unchanged docs and prunes orphans.
It is also the recovery path if embeddings were missed while the model was
unavailable.

## Env vars (all optional)

| Var | Default | Purpose |
|---|---|---|
| `EMBEDDING_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | HF model id |
| `TRANSFORMERS_CACHE_DIR` | `./.model-cache` | Where the ONNX model caches |
| `EMBEDDINGS_DISABLED` | unset | `1` = kill switch; everything falls back to the old regex search |
| `SEMANTIC_MIN_SCORE` | `0.3` | Minimum cosine similarity for a semantic hit |

## Failure behavior

Every failure degrades, nothing breaks:
- Model can't download (no internet) → 10-min cooldown → regex search everywhere.
- Atlas index missing/building → in-memory cosine over the same embeddings.
- LLM provider fails mid-stream after tokens were sent → answer closes out with `truncated: true` instead of switching model voices.
- All LLM providers dead → deterministic fallback answer listing top matches.
