# Phase 4 — LLM Reranking: Implementation Record

**Status**: Implemented, verified, disabled by default.
**Date**: 2026-10-20
**Revision**: candidate cap aligned to the reranker's 30-candidate limit; best-effort `seed` added.
**Scope**: `apps/api` (Cortex). Based on the revised Phase 4 plan (v2) plus three implementation clarifications.

---

## 1. What was built

An optional **listwise reranker** backed by Gemini structured output sits between retrieval and
context building:

```
question ──► EmbedQuery ──► RetrievalStrategy (VECTOR | FTS | HYBRID, unchanged)
                                   │
                                   ▼
                     resolveRetrievalLimit()      topK   (reranking off)
                        (enabled: rerankCandidateK)
                                   │
                                   ▼
                     applyReranking()  ──► GeminiReranker (opt-in)
                                   │            └─ failure/timeout → original order
                                   ▼
                          slice(0, topK) ──► ContextBuilder ──► prompt ──► answer / stream
```

Key properties:

- **No change** to VECTOR, FTS or HYBRID/RRF behaviour. With reranking disabled the retrieval
  output is returned untouched (same order, metadata and `similarity` values).
- **Opt-in per user**; `enableReranking` defaults to `false` for existing rows (migration default)
  and new rows (Prisma default).
- **Never fails a request**: every reranker failure mode falls back to the original retrieval order.
- **Never loses a candidate** because of the prompt cap: only the first 30 are ranked, the rest are
  appended in retrieval order, then `topK` is applied.
- **Full content preserved**: passage text is truncated to 500 chars *in the prompt only*; returned
  chunks are the original objects, unmodified and un-copied.

---

## 2. The three clarifications, as implemented

### 2.1 Candidates beyond the reranker cap are preserved

`GeminiReranker.rerank()`:

```ts
const promptCandidates = candidates.slice(0, this.maxCandidates); // 30
const remainder = candidates.slice(promptCandidates.length);
// ...on success:
return [...permutation.map((i) => promptCandidates[i]!), ...remainder];
```

- ≤30 candidates → all ranked, complete permutation required.
- >30 candidates → first 30 ranked, remainder appended in **original retrieval order**.
- Any failure → the **entire** original array is returned (same reference), so nothing is dropped.
- `topK` is applied afterwards, in `applyReranking()`.

### 2.2 Evaluation threshold is a go-live gate, not a completion criterion

- The 10% nDCG@5 target is interpreted as a **relative** lift over baseline (and no single query
  regressing >20%), used only to decide whether reranking may become the default.
- It was **not** required for this implementation, and **no evaluation was run** (no labelled query
  set exists in the repo).
- `enableReranking` therefore remains **`false` by default** regardless of any future outcome until
  a measured lift is produced.

### 2.3 Configuration updates stay consistent

Layers, with the division of responsibility kept minimal:

| Layer | Responsibility |
|---|---|
| Zod (`updateConfigSchema`) | Stateless bounds: `enableReranking: boolean`, `rerankCandidateK: int 1..30` (30 = reranker candidate cap) |
| `UpdateConfig` use case | Stateful validation of **effective** values (`input ?? persisted`) |
| Repository | Atomic single-statement write guarded on the values that were validated |

Rule enforced:

```ts
if (effectiveEnableReranking && effectiveCandidateK < effectiveTopK) {
  throw new Error(
    `rerankCandidateK (${effectiveCandidateK}) must be >= topK (${effectiveTopK}) when reranking is enabled`,
  );
}
```

This covers partial updates (e.g. raising `topK` past the persisted `rerankCandidateK`, or enabling
reranking with an already-insufficient pool), which a request-only schema cannot see.

**No transaction was introduced.** The existing repository had no transaction usage anywhere, and
under Prisma's default READ COMMITTED a read-validate-write inside `$transaction` still permits the
same lost-update race unless you move to SERIALIZABLE (plus a retry loop) or `SELECT … FOR UPDATE`
(raw SQL). The smallest correct option was a compare-and-set:

```ts
const [updated] = await prisma.retrievalConfig.updateManyAndReturn({
  where: { id, topK, rerankCandidateK, enableReranking }, // values that were validated
  data,
});

if (!updated) throw new Error("Configuration was modified concurrently, please retry");
```

One statement, no isolation-level changes, no retry machinery. `UpdateConfig` always supplies the
guard; `update()` without it keeps the previous behaviour.

---

## 3. Reranker design

`apps/api/src/modules/retrieval/application/GeminiReranker.ts`

| Aspect | Implementation |
|---|---|
| Model | `gemini-3.5-flash-lite` (same as answer generation) |
| Output mode | `responseMimeType: "application/json"` + `responseSchema {type:"ARRAY", items:{type:"INTEGER"}}` |
| Determinism attempt | `temperature: 0` |
| Seed | `seed: 0` (`RERANK_SEED`), sent in the same config as the response schema. Best-effort only — Gemini does not guarantee identical rankings |
| Timeout | 5 s `AbortController` passed as `config.abortSignal`, **plus** a `Promise.race` bound so the wait is capped even if the transport ignores the signal |
| Prompt cap | 30 candidates |
| Passage truncation | 500 chars + `…`, prompt only |
| Validation | Response must be a complete permutation of `[0..N-1]`: array, integers only, no duplicates, no out-of-range, nothing missing |
| Fallback | Any throw, timeout, empty/invalid response → original array, unchanged |
| Logging | `[RERANKER]` lines: candidate counts, cap truncation, latency, fallback reason |
| Client dependency | Narrow structural port (`RerankModelClient`), so the module imports no SDK and is testable with a fake; `GoogleGenAI` satisfies it structurally |

Prompt-injection posture: passages are declared **UNTRUSTED USER DATA** in the system instruction and
the model is told not to follow instructions inside them; the structured-output schema constrains the
response to integer indices, and the permutation check rejects anything else.

Privacy posture is unchanged: like embeddings and generation, prompt text (≤30 × 500 chars) goes to
Gemini.

---

## 4. File inventory

### Created

| File | Purpose |
|---|---|
| `apps/api/src/modules/retrieval/application/Reranker.ts` | `Reranker` port (`rerank(query, candidates)`) |
| `apps/api/src/modules/retrieval/application/GeminiReranker.ts` | Listwise Gemini reranker |
| `apps/api/src/modules/retrieval/application/RetrievalPipeline.ts` | `resolveRetrievalLimit()` + `applyReranking()` shared by `/ask` and `/stream` |
| `apps/api/src/modules/retrieval/application/GeminiReranker.test.ts` | 20 tests (permutation, fallback, timeout, cap, truncation, injection framing) |
| `apps/api/src/modules/retrieval/application/RetrievalPipeline.test.ts` | 9 tests (GA/BC: limits, slice, ordering, metadata, similarity) |
| `apps/api/src/modules/retrieval-config/application/UpdateConfig.test.ts` | 12 tests (CV: bounds, partial updates, ownership, CAS error, Zod) |
| `apps/api/prisma/migrations/20261020101618_add_reranking_config/migration.sql` | Adds both columns with defaults |

### Modified

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | `enableReranking Boolean @default(false)`, `rerankCandidateK Int @default(20)` |
| `apps/api/src/modules/retrieval-config/presentation/retrieval-config.schema.ts` | New optional fields; `rerankCandidateK` 1..30, exported as `RERANK_CANDIDATE_K_MAX` |
| `apps/api/src/modules/retrieval-config/application/UpdateConfig.ts` | Effective-value validation, new fields, CAS guard; `import type` repository |
| `apps/api/src/modules/retrieval-config/infrastructure/prisma-retrieval-config.repository.ts` | New fields; optional `expected` compare-and-set path |
| `apps/api/src/modules/retrieval-config/presentation/retrieval-config.controller.ts` | Pass-through of both fields |
| `apps/api/src/modules/chat/application/GenerateAnswer.ts` | Optional `Reranker`; widened limit; rerank + `topK` slice |
| `apps/api/src/modules/chat/application/GenerateStreamingAnswer.ts` | Same, in the streaming generator |
| `apps/api/src/modules/chat/infrastructure/chat.factory.ts` | Builds `GeminiReranker` (undefined without `GEMINI_API_KEY`) and injects into both use cases |
| `apps/api/package.json` | Test script covers all four suites |
| `apps/api/tsconfig.json` | `rewriteRelativeImportExtensions` (tests import `.ts`, as Node requires) |

### Deliberately untouched

`HybridSearch.ts`, `HybridSearch.test.ts` (zero diff), `VectorSearch.ts`, `FullTextSearch.ts`,
`RetrievalStrategy.ts`, `PgVectorRepository.ts` (incl. `RetrievedChunk`), `ContextBuilder.ts`,
`retrieval.strategy.factory.ts`.

---

## 5. API and data changes

Migration (already applied to the local database):

```sql
ALTER TABLE "RetrievalConfig"
  ADD COLUMN "enableReranking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rerankCandidateK" INTEGER NOT NULL DEFAULT 20;
```

- `GET /retrieval-config` now returns both fields (existing rows: `false` / `20`).
- `PUT /retrieval-config/:id` accepts `enableReranking`, `rerankCandidateK`.
- Response/stream contract unchanged: `{ answer, sources }`; SSE framing unchanged.
- To enable for a user:

```json
PUT /retrieval-config/<id>
{ "enableReranking": true, "rerankCandidateK": 20 }
```

Rollback: set `enableReranking: false`, or ship a follow-up migration dropping the two columns — the
existing migration is additive and backward compatible.

---

## 6. Verification performed

All commands run in `apps/api` unless noted.

| # | Command / check | Outcome |
|---|---|---|
| 1 | `npm test` | **exit 0 — 53 tests, 53 pass, 0 fail** (10 RRF unchanged + 21 reranker + 9 pipeline + 13 config) |
| 2 | `npx tsc --noEmit` | only **pre-existing** `prisma.config.ts(11,3) TS2353`; zero errors in new/changed files |
| 3 | `npx prisma migrate dev --name add_reranking_config` | migration created and applied; client regenerated |
| 4 | VECTOR / FTS / HYBRID regression | strategy files untouched (zero diff) and the 10 RRF tests pass unmodified. Live, reranking disabled: VECTOR → 5 sources, cosine similarities 0.6799→0.6551; FTS with `"skills postgresql"` → 4 sources, ts_rank values ≈0.0114; HYBRID with the same query → 5 sources with an overlapping chunk scored `sources=[VECTOR+FTS]` (rrfScore 0.0315, RRF values 0.0159–0.0315), i.e. both lists contribute and scores are still RRF, not raw |
| 5 | `/ask` + `/stream`, reranking **disabled** | 200 both; `{answer, sources}`; 5 sources in descending-similarity retrieval order; **no** `[RERANKER]` log lines; 1826 ms and 1552 ms |
| 6 | `/ask` + `/stream`, reranking **enabled** | 200 both; logs `reranking 30/50` → `appended 20 … retrieval order` → `valid permutation`; rerank latency **1236 / 1255 / 1326 ms**; `/ask` totals 2864–4108 ms; `/stream` 2569 ms (rerank completes before first token) |
| 7 | Failure fallback, real SDK | invalid key, 35 candidates → **all 35 returned**, same array reference, original order, 204 ms |
| 8 | Timeout fallback, real SDK | `timeoutMs: 1` → fallback in 5 ms, `abortSignal.aborted === true`, original order |
| 9 | Config validation over HTTP | `topK=51` with `candidateK=50` enabled → 400; `candidateK=100` → 400; `candidateK=0` → 400; `candidateK=4` while disabled → 200; then `enableReranking:true` → 400 `(4) must be >= (5)`; `candidateK=20` + enabled → 200 |
| 10 | Persistence | rejected requests left stored values untouched; accepted requests persisted (read back via API and directly from Postgres) |
| 11 | `rerankCandidateK` ceiling over HTTP | `31` → **400** `rerankCandidateK must be between 1 and 30`; `30` → **200** and persisted |
| 12 | Seed + structured output | 3 live calls with `seed: 0` and the array schema: order identical 3/3, plus a relevant ranking (pgvector chunk first). Observation only — no determinism guarantee |
| 13 | Prisma | `npx prisma validate` → schema valid; `npx prisma generate` → client regenerated; no stored `rerankCandidateK > 30`, **0** rows with reranking enabled |

Two live configurations were used:

- **Reranking runs** (`/ask`, `/stream`): `topK=5`, `similarityThreshold=0`, `rerankCandidateK=50`,
  VECTOR. 50 was permitted at the time; the cap is now 30, so the "more than 30 retrieved" append
  path is no longer reachable through configuration and is covered by unit tests (TR-14/14b/14c).
- **Strategy regression runs**: the user's original `similarityThreshold=0.45` with VECTOR, FTS and
  HYBRID, reranking disabled, so retrieval behaviour could be compared against the pre-change
  baseline.

The user's config was restored to its original values afterwards (`VECTOR`, `topK=5`,
`similarityThreshold=0.45`, `rerankCandidateK=20`, reranking off, `chunkSize=300`,
`chunkOverlap=100`) and verified directly in Postgres; the temporary server and test credentials
were removed.

Note on FTS: with the natural-language question the FTS strategy returned 0 results (its
`plainto_tsquery` AND semantics require every term, including words like "what"/"have"). That is
pre-existing behaviour, not a reranking regression — `FullTextSearch.ts` and the SQL are unchanged.

---

## 7. Deviations from the plan

| Deviation | Why |
|---|---|
| Extra file `RetrievalPipeline.ts` | Both use cases need identical limit/rerank/slice logic, and `GenerateAnswer` constructs its own Prisma repositories, so pipeline/BC cases could not otherwise be tested without a database |
| Test runner flag `--experimental-strip-types` → `--experimental-transform-types` | Strip-only mode rejects the TypeScript parameter properties already used by `UpdateConfig`; transform mode lets tests import production modules instead of restyling them |
| `tsconfig.json` gains `rewriteRelativeImportExtensions` | Tests must import `./X.ts` (the only specifier Node resolves under type stripping) |
| `updateManyAndReturn` instead of `$transaction` | Smallest correct way to make validation + write atomic (see §2.3) |
| `import type` for the config repository in `UpdateConfig` | Correct semantics, and keeps the use case testable without loading Prisma |
| Literal `RERANK_CANDIDATE_K_MAX = 30` in the Zod schema | Importing `RERANK_MAX_CANDIDATES` there adds a runtime `.js` specifier that Node's type-stripping test runner cannot resolve; `UpdateConfig.test.ts` asserts both constants are equal instead of relying on a shared import |

---

## 8. Known limitations / follow-ups

1. **Ordering is not guaranteed to be reproducible.** Before the seed was added, three identical
   calls produced two different top-1 results. With `seed: 0` a later three-call check returned the
   same order 3/3, but Gemini documents `seed` as best-effort, so this is an observation, not a
   guarantee — quality comparisons must still average repeats.
2. **The 30-candidate cap is the evaluation ceiling.** The configuration maximum now equals it, so a
   retrieval pool larger than 30 can no longer be configured (and none is stored). Raising the
   ceiling requires raising `RERANK_MAX_CANDIDATES`, which increases prompt size and latency.
3. **Latency.** ~1.0–1.3 s added per query; for `/stream` this lands before the first token. Only
   small-sample ranges were measured, not a p50/p95 distribution.
4. **No deduplication.** Near-identical chunks from duplicate documents still occupy several of the
   five source slots; reranking reorders but does not merge.
5. **Quality unproven.** No nDCG@5 evaluation was run; observed ordering on one skills query looked
   plausible (the chunk containing "Technical Skills" was promoted), but that is anecdote, not data.
6. **No HTTP-level fault injection.** Fallback was proven with the real SDK at the reranker boundary
   plus pipeline unit tests; there is no hook to force a failure through `/ask`.
7. **The retain-order guarantee holds for failures, not for rankings.** On a reranker failure all
   retrieved candidates are preserved in retrieval order; on success, candidates below the 30-cap
   are ranked and the final `topK` slice is what the model ordered. With the cap now equal to the
   configurable maximum, the two agree.

---

## 9. Pre-existing, unrelated: `prisma.config.ts` TS2353

`npx tsc --noEmit` reports exactly one error and always has, before and after this work:

```
prisma.config.ts(11,3): error TS2353: Object literal may only specify known properties,
and 'datasource' does not exist in type 'PrismaConfig'.
```

**Cause.** The file (added 2026-07-14 in `fd8b4d5`, "configure Prisma and initialize database")
passes a `datasource` key to `defineConfig`. The installed `@prisma/config@6.16.3` — the version
`prisma/config` re-exports from — declares `experimental`, `schema`, `adapter`, `studio`,
`migrations`, `tables`, `enums`, `views` and `typedSql`, and **no `datasource`**. The config file was
therefore written against a different Prisma config shape than the pinned CLI provides.

**Why it does not break anything.** Prisma transpiles the config and never typechecks it, so the extra
key is ignored at runtime; every CLI command succeeds (`prisma validate`, `prisma generate`,
`prisma migrate status/dev`). The connection URL actually in effect comes from
`schema.prisma`'s `datasource db { url = env("DATABASE_URL") }`, which is also why a missing
`datasource` in the config has no effect.

**Why it is unrelated to Phase 4.** No reranking file imports or is imported by `prisma.config.ts`;
the error reproduces on a clean checkout of the branch point. It is a Prisma configuration/version
mismatch, not a consequence of the schema or migration added here.

**Appropriate next action (not done here).** Align the file with the installed Prisma major — remove
the unsupported `datasource` block (the CLI keeps working via `schema.prisma`) or upgrade Prisma to a
version whose `PrismaConfig` includes it — as its own change with its own verification. Excluding the
file from `tsconfig.json` was deliberately avoided: it would hide a genuine version mismatch rather
than resolve it.
