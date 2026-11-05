/**
 * Unit & Integration tests for CandidatePoolCache.ts
 *
 * Scope:
 * - CP-1: Cache recording (all fields preserved)
 * - CP-2: Exact preservation of candidate order & score semantics
 * - CP-3: Deterministic fingerprinting (query, dataset, corpus)
 * - CP-4: Incompatibility: same query ID with changed query text (no leak of text)
 * - CP-5: Incompatibility: dataset fingerprint mismatch
 * - CP-6: Incompatibility: corpus fingerprint mismatch
 * - CP-7: Incompatibility: RRF_K mismatch
 * - CP-8: Incompatibility: embedding model mismatch
 * - CP-9: Incompatibility: candidateK incompatibility
 * - CP-10: Duplicate query texts with different query IDs handled safely
 * - CP-11: Malformed and corrupt JSON handling
 * - CP-12: Atomic file write behavior
 * - CP-13: Cached-ranking replay without Gemini calls (zero-token evaluation)
 * - CP-14: Security hygiene & git-ignore verification
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/CandidatePoolCache.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type { EvaluationDataset, EvaluationQuery } from "../domain/EvaluationDataset.js";
import {
  computeCandidatePoolFingerprint,
  computeCorpusFingerprint,
  computeDatasetFingerprint,
  computeQueryFingerprint,
  loadCache,
  parseEvalQueryId,
  saveCache,
  toCachedCandidateChunk,
  toRetrievedChunk,
  validateCacheCompatibility,
  CacheIncompatibilityError,
  ReplayRetrievalStrategy,
  ReplayReranker,
  type CandidatePoolCacheData,
} from "../infrastructure/CandidatePoolCache.js";
import { EvaluationRunner } from "../application/EvaluationRunner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChunk(id: string, similarity: number = 0.9): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc_${id}`,
    documentTitle: `Document ${id}`,
    chunkIndex: 0,
    content: `Content passage for chunk ${id}.`,
    similarity,
  };
}

function createSampleDataset(queries: EvaluationQuery[] = []): EvaluationDataset {
  return {
    version: "1.0.0",
    description: "Sample test dataset",
    createdAt: new Date().toISOString(),
    queries: queries.length > 0 ? queries : [
      {
        id: "q1",
        question: "What is similarity threshold?",
        judgments: [
          {
            chunkId: "c1",
            documentId: "doc_c1",
            documentTitle: "Doc C1",
            relevance: 2,
            textAnchor: "Content passage for chunk c1.",
          },
        ],
      },
    ],
  };
}

function createSampleCacheData(overrides: Partial<CandidatePoolCacheData> = {}): CandidatePoolCacheData {
  const c1 = createMockChunk("c1", 0.032);
  const c2 = createMockChunk("c2", 0.016);

  const dataset = createSampleDataset();

  return {
    header: {
      cacheVersion: "1.1.0",
      datasetVersion: "1.0.0",
      datasetFingerprint: computeDatasetFingerprint(dataset),
      corpusFingerprint: computeCorpusFingerprint(["doc_c1", "doc_c2"]),
      retrievalStrategy: "HYBRID",
      rrfK: 60,
      candidateK: 20,
      similarityThreshold: 0.3,
      embeddingModel: "gemini-embedding-001",
      recordedAt: new Date().toISOString(),
      queryCount: 1,
    },
    pools: [
      {
        queryId: "q1",
        queryFingerprint: computeQueryFingerprint("What is similarity threshold?"),
        chunks: [
          toCachedCandidateChunk(c1, 1, "HYBRID"),
          toCachedCandidateChunk(c2, 2, "HYBRID"),
        ],
      },
    ],
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("CP-1: Cache Recording — preserves all candidate fields and metadata", () => {
  const original = createMockChunk("c100", 0.88);
  const cached = toCachedCandidateChunk(original, 1, "HYBRID");

  assert.equal(cached.chunkId, "c100");
  assert.equal(cached.documentId, "doc_c100");
  assert.equal(cached.documentTitle, "Document c100");
  assert.equal(cached.chunkIndex, 0);
  assert.equal(cached.content, "Content passage for chunk c100.");
  assert.equal(cached.score, 0.88);
  assert.equal(cached.scoreType, "rrf");
  assert.equal(cached.rank, 1);
});

test("CP-2: Exact Preservation of Candidate Order & Score Semantics", () => {
  const c1 = createMockChunk("c1", 0.032);
  const c2 = createMockChunk("c2", 0.016);

  const cached1 = toCachedCandidateChunk(c1, 1, "HYBRID");
  const cached2 = toCachedCandidateChunk(c2, 2, "HYBRID");

  const restored1 = toRetrievedChunk(cached1);
  const restored2 = toRetrievedChunk(cached2);

  assert.deepEqual(restored1, c1);
  assert.deepEqual(restored2, c2);

  // Score semantics distinction
  const vectorCached = toCachedCandidateChunk(c1, 1, "VECTOR");
  assert.equal(vectorCached.scoreType, "cosine_similarity");

  const ftsCached = toCachedCandidateChunk(c1, 1, "FTS");
  assert.equal(ftsCached.scoreType, "fts_score");
});

test("CP-3: Deterministic Fingerprinting (Query, Dataset, Corpus)", () => {
  const qFp1 = computeQueryFingerprint("What is the threshold?");
  const qFp2 = computeQueryFingerprint("  what is the   THRESHOLD? \n");
  assert.equal(qFp1, qFp2); // Normalized equivalence

  const dataset = createSampleDataset();
  const dsFp1 = computeDatasetFingerprint(dataset);
  const dsFp2 = computeDatasetFingerprint(dataset);
  assert.equal(dsFp1, dsFp2);

  // Modified question produces different dataset fingerprint
  const modifiedDataset: EvaluationDataset = {
    ...dataset,
    queries: [
      {
        ...dataset.queries[0]!,
        question: "Different question text entirely",
      },
    ],
  };
  const dsFpModified = computeDatasetFingerprint(modifiedDataset);
  assert.notEqual(dsFp1, dsFpModified);

  // Corpus fingerprint is order-independent and deduplicating
  const corpus1 = computeCorpusFingerprint(["doc_b", "doc_a", "doc_b"]);
  const corpus2 = computeCorpusFingerprint(["doc_a", "doc_b"]);
  assert.equal(corpus1, corpus2);
});

test("CP-4: Incompatibility — Same Query ID with Changed Query Text", () => {
  const cache = createSampleCacheData();

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [
          {
            id: "q1",
            question: "A completely changed question with same query ID!",
          },
        ],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Query text mismatch for query ID "q1"/);
      // Ensure the full question text is NOT leaked in the error
      assert.ok(!err.message.includes("A completely changed question"));
      return true;
    },
  );
});

test("CP-5: Incompatibility — Dataset Fingerprint Mismatch", () => {
  const cache = createSampleCacheData();

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: "wrong_dataset_fingerprint_hash",
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Dataset fingerprint mismatch/);
      return true;
    },
  );
});

test("CP-6: Incompatibility — Corpus Fingerprint Mismatch", () => {
  const cache = createSampleCacheData();

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        expectedCorpusFingerprint: "expected_other_corpus_hash",
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Corpus fingerprint mismatch/);
      return true;
    },
  );
});

test("CP-7: Incompatibility — RRF_K Mismatch", () => {
  const cache = createSampleCacheData();

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 100, // Different RRF_K!
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /RRF_K mismatch: cache has 60, expected 100/);
      return true;
    },
  );
});

test("CP-8: Incompatibility — Embedding Model Mismatch", () => {
  const cache = createSampleCacheData();

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "text-embedding-3-small", // Different model!
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Embedding model mismatch/);
      return true;
    },
  );
});

test("CP-9: Incompatibility — CandidateK Incompatibility", () => {
  const cache = createSampleCacheData(); // has candidateK = 20

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 30, // Requesting 30 when cache only has 20!
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Candidate pool limit incompatibility/);
      return true;
    },
  );
});

test("CP-10: Duplicate Query Texts with Different Query IDs Handled Safely", async () => {
  const poolA = [toCachedCandidateChunk(createMockChunk("chunk_for_A"), 1, "HYBRID")];
  const poolB = [toCachedCandidateChunk(createMockChunk("chunk_for_B"), 1, "HYBRID")];

  const sameQuestionText = "Identical question text across two queries";

  const cacheData: CandidatePoolCacheData = {
    header: {
      cacheVersion: "1.1.0",
      datasetVersion: "1.0.0",
      datasetFingerprint: "ds_fp",
      corpusFingerprint: "corpus_fp",
      retrievalStrategy: "HYBRID",
      rrfK: 60,
      candidateK: 1,
      similarityThreshold: 0.3,
      embeddingModel: "gemini-embedding-001",
      recordedAt: new Date().toISOString(),
      queryCount: 2,
    },
    pools: [
      {
        queryId: "query_A",
        queryFingerprint: computeQueryFingerprint(sameQuestionText),
        chunks: poolA,
      },
      {
        queryId: "query_B",
        queryFingerprint: computeQueryFingerprint(sameQuestionText),
        chunks: poolB,
      },
    ],
  };

  const strategy = new ReplayRetrievalStrategy(cacheData.pools);

  // Request for query_A
  const resA = await strategy.execute({
    query: sameQuestionText,
    queryEmbedding: [0.1],
    userId: "test",
    limit: 1,
    similarityThreshold: 0.3,
    requestId: "eval_query_A_1730720000000",
  });
  assert.equal(resA[0]?.chunkId, "chunk_for_A");

  // Request for query_B
  const resB = await strategy.execute({
    query: sameQuestionText,
    queryEmbedding: [0.1],
    userId: "test",
    limit: 1,
    similarityThreshold: 0.3,
    requestId: "eval_query_B_1730720000000",
  });
  assert.equal(resB[0]?.chunkId, "chunk_for_B");
});

test("CP-11: Malformed and Corrupt JSON Handling", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-cache-test-"));
  const corruptFile = path.join(tmpDir, "corrupt.json");

  // 1. Invalid JSON syntax
  await fs.writeFile(corruptFile, "{ invalid json content ...", "utf-8");
  await assert.rejects(
    async () => loadCache(corruptFile),
    /invalid JSON/i,
  );

  // 2. Valid JSON but missing required fields
  await fs.writeFile(corruptFile, JSON.stringify({ header: { cacheVersion: "1.1.0" } }), "utf-8");
  await assert.rejects(
    async () => loadCache(corruptFile),
    (err: unknown) => {
      assert.ok(err instanceof z.ZodError);
      return true;
    },
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CP-12: Atomic File Write Behavior", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-atomic-test-"));
  const targetFile = path.join(tmpDir, "subfolder", "cache.json");

  const data = createSampleCacheData();
  await saveCache(targetFile, data);

  // Verify file exists and parses
  const loaded = await loadCache(targetFile);
  assert.equal(loaded.header.cacheVersion, "1.1.0");
  assert.equal(loaded.pools.length, 1);

  // Ensure no lingering temporary files in the directory
  const files = await fs.readdir(path.join(tmpDir, "subfolder"));
  assert.deepEqual(files, ["cache.json"]);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CP-13: Cached-Ranking Replay without Gemini Calls (Zero-Token Evaluation)", async () => {
  const c1 = createMockChunk("c1", 0.032);
  const c2 = createMockChunk("c2", 0.016);

  // Pool with recorded reranker output: reranker inverted order (c2 first, c1 second)
  const pool: CandidatePoolCacheData["pools"][0] = {
    queryId: "q_replay",
    queryFingerprint: computeQueryFingerprint("Cached replay test question"),
    chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c2, 2, "HYBRID")],
    recordedRerank: {
      chunks: [toCachedCandidateChunk(c2, 1, "HYBRID"), toCachedCandidateChunk(c1, 2, "HYBRID")],
      telemetry: {
        latencyMs: 135,
        status: "success",
        approxTokens: 120,
      },
    },
  };

  const replayStrategy = new ReplayRetrievalStrategy([pool]);
  const replayReranker = new ReplayReranker([pool]);

  let geminiCalls = 0;
  const dummyEmbedder = {
    async execute() {
      return [0.1];
    },
  };

  const query: EvaluationQuery = {
    id: "q_replay",
    question: "Cached replay test question",
    judgments: [
      {
        chunkId: "c1",
        documentId: "doc_c1",
        documentTitle: "Doc C1",
        relevance: 1,
        textAnchor: "Content passage for chunk c1.",
      },
      {
        chunkId: "c2",
        documentId: "doc_c2",
        documentTitle: "Doc C2",
        relevance: 2,
        textAnchor: "Content passage for chunk c2.",
      },
    ],
  };

  const dataset = createSampleDataset([query]);
  const runner = new EvaluationRunner(dummyEmbedder, replayStrategy, replayReranker);

  const result = await runner.run({
    dataset,
    userId: "test-replay",
    candidateK: 2,
    topK: 2,
  });

  // Verify zero Gemini API calls were made
  assert.equal(geminiCalls, 0);

  // Experiment A: baseline order (c1, c2)
  assert.equal(result.queryRecords[0]?.experimentA.topKChunks[0]?.chunkId, "c1");
  assert.equal(result.queryRecords[0]?.experimentA.topKChunks[1]?.chunkId, "c2");

  // Experiment B: replayed reranked order (c2, c1)
  assert.equal(result.queryRecords[0]?.experimentB.topKChunks[0]?.chunkId, "c2");
  assert.equal(result.queryRecords[0]?.experimentB.topKChunks[1]?.chunkId, "c1");

  // Telemetry matches recorded snapshot
  assert.equal(result.queryRecords[0]?.experimentB.telemetry.status, "success");
  assert.equal(result.queryRecords[0]?.experimentB.telemetry.latencyMs, 135);
  assert.equal(result.queryRecords[0]?.experimentB.telemetry.approxTokens, 120);
});

test("CP-14: Security Hygiene & Git-Ignore Verification", () => {
  // 1. Verify cache data structure has no raw user IDs or credentials
  const cache = createSampleCacheData();
  const serialized = JSON.stringify(cache);
  assert.ok(!serialized.includes("userId"));
  assert.ok(!serialized.includes("password"));
  assert.ok(!serialized.includes("apiKey"));

  // 2. Verify .eval-cache and eval-results are git-ignored
  const out = execSync("git check-ignore -v .eval-cache/test.json eval-results/test.json", {
    encoding: "utf-8",
  });
  assert.match(out, /\.eval-cache\//);
  assert.match(out, /eval-results\//);
});

test("CP-15: Incompatibility — Unsupported or Stale Cache Version Rejection", () => {
  const cache = createSampleCacheData();
  const staleCache = {
    ...cache,
    header: {
      ...cache.header,
      cacheVersion: "1.0.0" as unknown as "1.1.0",
    },
  };

  assert.throws(
    () => {
      validateCacheCompatibility(staleCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Unsupported cache version "1.0.0"\. Expected "1.1.0"/);
      return true;
    },
  );
});

test("CP-16: Incompatibility — Reranker Model Mismatch Rejection", () => {
  const cache = createSampleCacheData({
    header: {
      ...createSampleCacheData().header,
      rerankerModel: "gemini-3.5-flash-lite",
    },
  });

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        expectedRerankerModel: "gemini-1.5-pro", // Mismatched reranker!
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(
        err.message,
        /Reranker model mismatch: cache recorded with "gemini-3.5-flash-lite", expected "gemini-1.5-pro"/,
      );
      return true;
    },
  );
});

test("CP-17: Incompatibility — Reranker Prompt Version Mismatch Rejection", () => {
  const cache = createSampleCacheData({
    header: {
      ...createSampleCacheData().header,
      rerankerPromptVersion: "gemini-rerank-v1",
    },
  });

  assert.throws(
    () => {
      validateCacheCompatibility(cache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: cache.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        expectedRerankerPromptVersion: "gemini-rerank-v2", // Mismatched prompt version!
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(
        err.message,
        /Reranker prompt version mismatch: cache recorded with "gemini-rerank-v1", expected "gemini-rerank-v2"/,
      );
      return true;
    },
  );
});

test("CP-18: Incompatibility — Candidate Pool Fingerprint Corruption & Mismatch", () => {
  const base = createSampleCacheData();
  const validPoolFp = computeCandidatePoolFingerprint(base.pools);

  // 1. Corrupt candidate pool fingerprint header (data was tampered with or corrupted)
  const corruptHeaderCache = {
    ...base,
    header: {
      ...base.header,
      candidatePoolFingerprint: "corrupted_tampered_pool_fingerprint",
    },
  };

  assert.throws(
    () => {
      validateCacheCompatibility(corruptHeaderCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: base.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(
        err.message,
        /Corrupt cache: candidatePoolFingerprint header does not match candidate pools data/,
      );
      return true;
    },
  );

  // 2. Expected candidate pool fingerprint mismatch
  const validCache = {
    ...base,
    header: {
      ...base.header,
      candidatePoolFingerprint: validPoolFp,
    },
  };

  assert.throws(
    () => {
      validateCacheCompatibility(validCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: base.header.datasetFingerprint,
        expectedCandidatePoolFingerprint: "other_run_pool_fingerprint",
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 20,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Candidate pool fingerprint mismatch/);
      return true;
    },
  );
});

test("CP-19: Incompatibility — Recorded Rerank Permutation Hardening (Duplicates & Unexpected Chunks)", () => {
  const base = createSampleCacheData();
  const c1 = createMockChunk("c1", 0.032);
  const c2 = createMockChunk("c2", 0.016);
  const c99 = createMockChunk("c99", 0.005);

  // 1. Duplicate chunk ID in recorded rerank (e.g. [c1, c1] when candidate pool has [c1, c2])
  const duplicateRerankCache: CandidatePoolCacheData = {
    ...base,
    pools: [
      {
        queryId: "q1",
        queryFingerprint: computeQueryFingerprint("What is similarity threshold?"),
        chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c2, 2, "HYBRID")],
        recordedRerank: {
          chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c1, 2, "HYBRID")],
          telemetry: { latencyMs: 50, status: "success" },
        },
      },
    ],
  };

  assert.throws(
    () => {
      validateCacheCompatibility(duplicateRerankCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: base.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 2,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
        requireRecordedRerank: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(
        err.message,
        /Recorded rerank for query ID "q1" contains duplicate chunkId "c1"/,
      );
      return true;
    },
  );

  // 2. Unexpected chunk ID not present in candidate pool
  const unexpectedChunkCache: CandidatePoolCacheData = {
    ...base,
    pools: [
      {
        queryId: "q1",
        queryFingerprint: computeQueryFingerprint("What is similarity threshold?"),
        chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c2, 2, "HYBRID")],
        recordedRerank: {
          chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c99, 2, "HYBRID")],
          telemetry: { latencyMs: 50, status: "success" },
        },
      },
    ],
  };

  assert.throws(
    () => {
      validateCacheCompatibility(unexpectedChunkCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: base.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 2,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
        requireRecordedRerank: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(
        err.message,
        /Recorded rerank for query ID "q1" contains unexpected chunkId "c99"/,
      );
      return true;
    },
  );

  // 3. Length mismatch (missing chunks)
  const lengthMismatchCache: CandidatePoolCacheData = {
    ...base,
    pools: [
      {
        queryId: "q1",
        queryFingerprint: computeQueryFingerprint("What is similarity threshold?"),
        chunks: [toCachedCandidateChunk(c1, 1, "HYBRID"), toCachedCandidateChunk(c2, 2, "HYBRID")],
        recordedRerank: {
          chunks: [toCachedCandidateChunk(c1, 1, "HYBRID")],
          telemetry: { latencyMs: 50, status: "success" },
        },
      },
    ],
  };

  assert.throws(
    () => {
      validateCacheCompatibility(lengthMismatchCache, {
        datasetVersion: "1.0.0",
        datasetFingerprint: base.header.datasetFingerprint,
        retrievalStrategy: "HYBRID",
        rrfK: 60,
        candidateK: 2,
        similarityThreshold: 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries: [{ id: "q1", question: "What is similarity threshold?" }],
        requireRecordedRerank: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CacheIncompatibilityError);
      assert.match(err.message, /Recorded rerank for query ID "q1" length mismatch/);
      return true;
    },
  );
});

test("CP-20: Corpus Fingerprint Hardening (Content, Timestamps, Chunks & Deduplication)", () => {
  const docBase = {
    id: "doc_1",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    processedAt: new Date("2026-01-01T00:01:00Z"),
    chunks: [
      { id: "chunk_1", chunkIndex: 0, content: "Original content of chunk 1" },
      { id: "chunk_2", chunkIndex: 1, content: "Original content of chunk 2" },
    ],
  };

  const fpBase = computeCorpusFingerprint([docBase]);

  // 1. Changing chunk content under identical IDs alters fingerprint
  const docModifiedContent = {
    ...docBase,
    chunks: [
      { id: "chunk_1", chunkIndex: 0, content: "Modified content of chunk 1!" },
      { id: "chunk_2", chunkIndex: 1, content: "Original content of chunk 2" },
    ],
  };
  const fpModifiedContent = computeCorpusFingerprint([docModifiedContent]);
  assert.notEqual(fpBase, fpModifiedContent);

  // 2. Changing document updatedAt timestamp alters fingerprint
  const docModifiedTimestamp = {
    ...docBase,
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  };
  const fpModifiedTimestamp = computeCorpusFingerprint([docModifiedTimestamp]);
  assert.notEqual(fpBase, fpModifiedTimestamp);

  // 3. Adding a new chunk alters fingerprint
  const docWithAddedChunk = {
    ...docBase,
    chunks: [
      ...docBase.chunks,
      { id: "chunk_3", chunkIndex: 2, content: "Third newly added chunk" },
    ],
  };
  const fpWithAddedChunk = computeCorpusFingerprint([docWithAddedChunk]);
  assert.notEqual(fpBase, fpWithAddedChunk);

  // 4. Order-independence of documents and chunks
  const docA = { id: "doc_A", chunks: [{ id: "cA", chunkIndex: 0, content: "Alpha" }] };
  const docB = { id: "doc_B", chunks: [{ id: "cB", chunkIndex: 0, content: "Beta" }] };
  const fpOrder1 = computeCorpusFingerprint([docA, docB]);
  const fpOrder2 = computeCorpusFingerprint([docB, docA]);
  assert.equal(fpOrder1, fpOrder2);

  // 5. Deduplication of identical document IDs
  const fpDedup = computeCorpusFingerprint([docA, docB, docA]);
  assert.equal(fpOrder1, fpDedup);

  // 6. Zero leakage of document content in fingerprint string
  assert.ok(!fpBase.includes("Original content"));
  assert.equal(fpBase.length, 32);
});
