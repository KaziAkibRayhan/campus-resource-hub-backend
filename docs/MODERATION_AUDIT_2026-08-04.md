# Content Moderation Audit - 2026-08-04

## Scope

Read-only testing against the real MongoDB resource inventory and the actual
Cloudinary file bytes. No resource records or stored files were changed.

Provider order tested:

1. Groq (`qwen/qwen3.6-27b` for vision)
2. Hugging Face (`zai-org/GLM-4.5V`)
3. OpenAI moderation
4. Fail-safe human review when no provider completes the scan

## Full storage and extraction audit

- Total real resources: 67
- Images: 29
- PDFs: 26
- DOCX: 11
- XLSX: 1
- Successful downloads and extraction: 67/67
- Download/extraction failures: 0
- Files with no extracted text or image signal: 0
- Partial extractions: 8 PDFs

All partial PDFs are held under the current policy. They cannot be
auto-published from a partial clean verdict.

## Real image AI audit

- Total real uploaded images: 29
- Complete AI verdicts: 24
- Unavailable/incomplete verdicts routed to review: 5
- Provider/runtime errors: 0
- Flagged images: 5
- Clean images: 19
- Groq verdicts: 9
- Hugging Face fallback verdicts: 15

Confirmed historical false negatives still published in the database:

- `test gola kata` - graphic violence
- `This is one way data` - graphic violence
- `This is beautifull image` - graphic violence

The current pipeline flags all three. This audit did not mutate their existing
approval state.

## Real document AI audit

The AI sample included every DOCX/XLSX plus ten real PDFs selected across recent
uploads, largest files, and long/partial documents.

- Total documents AI-tested: 22
- Complete AI verdicts: 15
- Unavailable/incomplete verdicts routed to review: 7
- Errors that escaped the review decision: 0
- Partial documents routed to review: 5
- Groq verdicts: 11
- Hugging Face verdicts: 4

The embedded-image DOCX was held when its vision scan could not complete.
Text-only DOCX and XLSX continued through the Groq text guard even while the
Groq vision model was rate-limited.

## Regression matrix

- Nude image cases protected: 10/10
- Graphic image cases protected: 10/10
- PDF cases correct: 10/10
- Unsafe cases auto-published: 0
- Publication-policy unit tests: 4/4 passing

## Bugs found and fixed during the audit

1. A partial PDF/DOC extraction could previously auto-publish.
2. A successful text verdict could hide a failed image verdict.
3. The configured Groq vision model had been retired/unavailable.
4. Reasoning-model output could contain multiple JSON objects and fail parsing.
5. A Groq vision `429` incorrectly disabled Groq text moderation too.
6. Groq retried every remaining PDF page after a quota failure.
7. OpenAI image moderation batching used two images although the active API
   accepted only one.
8. Provider failure could previously result in unsafe auto-approval.

## Remaining operational constraints

- Groq's current account limit is 200,000 vision tokens per day.
- Hugging Face availability depends on included/prepaid inference credits and
  may reject some sensitive inputs at the provider boundary.
- The OpenAI key currently returns `429`.
- These constraints no longer publish unscanned content: incomplete scans are
  sent to human review.
- Existing historically approved resources need a separate reviewed migration
  before changing their database approval state.
