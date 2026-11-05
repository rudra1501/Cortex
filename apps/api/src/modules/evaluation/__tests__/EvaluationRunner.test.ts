/**
 * Unit & Integration Tests for EvaluationRunner.ts
 *
 * Scope:
 * - ER-1: Shared candidate pool (called once per query with limit=candidateK)
 * - ER-2: Baseline immutability (Experiment A isolated from reranker mutation/error)
 * - ER-3: Successful reranking with unchanged order (status: "success", not fallback)
 * - ER-4: Successful reranking with changed order (originalRrfRank tracked, deltas computed)
 * - ER-5: Timeout fallback telemetry (status: "fallback", failureType: "timeout")
 * - ER-6: API error fallback telemetry (failureType: "http_429", fallback rate tracked)
 * - ER-7: Permutation validation & rejection (duplicates, missing, unexpected IDs -> invalid_response fallback)
 * - ER-8: Missing reranker handling (status: "skipped", latency=0ms, runConfig reflects null)
 * - ER-9: Provisional text-anchor classification (pendingReview: true -> provisional, excluded from finalised)
 * - ER-10: Incomplete sources classification (missing expected sources -> provisional)
 * - ER-11: Similarity threshold preservation (CLI override -> repo config -> default 0.3, never 0)
 * - ER-12: Zero relevant judgments exclusion (null metrics, incrementing excludedCount)
 * - ER-13: Sequential execution & correlated requestIds
 * - Additional: Legacy Reranker try/catch fallback without rerankWithTelemetry
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/EvaluationRunner.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type {
  RetrievalStrategy,
  RetrievalInput,
} from "../../retrieval/application/RetrievalStrategy.js";
import type { GeminiRerankResult } from "../../retrieval/application/GeminiReranker.js";
import type {
  EvaluationDataset,
  EvaluationJudgment,
  EvaluationQuery,
} from "../domain/EvaluationDataset.js";
import {
  EvaluationRunner,
  validatePermutation,
  type EvaluatorReranker,
} from "../application/EvaluationRunner.js";

// ---------------------------------------------------------------------------
// Helpers & Test Doubles
// ---------------------------------------------------------------------------

function createMockChunk(
  id: string,
  overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc_${id}`,
    documentTitle: `Document ${id}`,
    chunkIndex: 0,
    content: `Content for chunk ${id}. Distinctive text anchor for semantic matching.`,
    similarity: 0.9,
    ...overrides,
  };
}

function createMockJudgment(
  chunkId: string,
  relevance: 0 | 1 | 2,
  overrides: Partial<EvaluationJudgment> = {},
): EvaluationJudgment {
  return {
    chunkId,
    documentId: `doc_${chunkId}`,
    documentTitle: `Document ${chunkId}`,
    chunkIndex: 0,
    relevance,
    textAnchor: `Content for chunk ${chunkId}`,
    ...overrides,
  };
}

function createMockDataset(queries: EvaluationQuery[]): EvaluationDataset {
  return {
    version: "1.0.0",
    description: "EvaluationRunner Test Dataset",
    createdAt: new Date().toISOString(),
    queries,
  };
}

interface RetrievalCallSpy {
  readonly options: RetrievalInput;
}

function createMockRetrievalStrategy(chunksToReturn: RetrievedChunk[]) {
  const calls: RetrievalCallSpy[] = [];
  const strategy: RetrievalStrategy = {
    async execute(options: RetrievalInput): Promise<RetrievedChunk[]> {
      calls.push({ options });
      return chunksToReturn;
    },
  };
  return { strategy, calls };
}

function createMockEmbedQuery() {
  const calls: Array<{ query: string; requestId?: string | undefined }> = [];
  const embedder = {
    async execute(query: string, requestId?: string | undefined): Promise<number[]> {
      calls.push({ query, ...(requestId !== undefined ? { requestId } : {}) });
      return [0.1, 0.2, 0.3];
    },
  };
  return { embedder, calls };
}

// ===========================================================================
// Permutation Validator Unit Tests
// ===========================================================================

test("validatePermutation: valid permutation returns true", () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");
  const c3 = createMockChunk("c3");

  const original = [c1, c2, c3];
  const reordered = [c3, c1, c2];

  const result = validatePermutation(original, reordered);
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("validatePermutation: detects length mismatch", () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");

  const original = [c1, c2];
  const truncated = [c1];

  const result = validatePermutation(original, truncated);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /Length mismatch/);
});

test("validatePermutation: detects duplicate chunkId", () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");

  const original = [c1, c2];
  const duplicates = [c1, c1];

  const result = validatePermutation(original, duplicates);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /Duplicate chunkId "c1"/);
});

test("validatePermutation: detects unexpected chunkId", () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");
  const cAlien = createMockChunk("alien");

  const original = [c1, c2];
  const hallucinated = [c1, cAlien];

  const result = validatePermutation(original, hallucinated);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /Unexpected chunkId "alien"/);
});

// ===========================================================================
// EvaluationRunner Tests (ER-1 through ER-13)
// ===========================================================================

test("ER-1: Shared Candidate Pool — retrieval called once per query with limit=candidateK", async () => {
  const candidateChunks = Array.from({ length: 20 }, (_, i) =>
    createMockChunk(`c_${i + 1}`, { similarity: 1 - i * 0.04 }),
  );
  const { strategy, calls } = createMockRetrievalStrategy(candidateChunks);
  const { embedder } = createMockEmbedQuery();

  let rerankerCandidatesReceived: RetrievedChunk[] = [];
  const reranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates, _reqId): Promise<GeminiRerankResult> {
      rerankerCandidatesReceived = candidates;
      return {
        chunks: candidates,
        telemetry: { latencyMs: 120, status: "success" },
      };
    },
    async rerank(_query, candidates) {
      return candidates;
    },
  };

  const query: EvaluationQuery = {
    id: "q1",
    question: "What is the similarity threshold?",
    judgments: [
      createMockJudgment("c_1", 2),
      createMockJudgment("c_2", 1),
    ],
  };

  const runner = new EvaluationRunner(embedder, strategy, reranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-456",
    candidateK: 20,
    topK: 5,
  });

  // Verify retrieval called exactly once with candidate limit
  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.options.limit, 20);
  assert.equal(firstCall.options.userId, "user-456");
  assert.equal(firstCall.options.query, "What is the similarity threshold?");

  // Verify candidate pool contains all 20 retrieved chunks
  const record = result.queryRecords[0];
  assert.ok(record);
  assert.equal(record.candidatePool.length, 20);

  // Verify Experiment A evaluates the top-5 slice
  assert.equal(record.experimentA.topKChunks.length, 5);
  assert.equal(record.experimentA.topKChunks[0]?.chunkId, "c_1");

  // Verify Experiment B received the full 20 candidates
  assert.equal(rerankerCandidatesReceived.length, 20);
});

test("ER-2: Baseline Immutability — Experiment A isolated from reranker mutation or throw", async () => {
  const c1 = createMockChunk("c1", { content: "Original content c1", similarity: 0.95 });
  const c2 = createMockChunk("c2", { content: "Original content c2", similarity: 0.85 });
  const { strategy } = createMockRetrievalStrategy([c1, c2]);
  const { embedder } = createMockEmbedQuery();

  // A buggy/malicious reranker that mutates candidate objects in place
  const mutatingReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      // Mutate elements in candidates
      if (candidates[0]) {
        candidates[0].content = "MUTATED_CONTENT";
        candidates[0].similarity = 0.01;
      }
      return {
        chunks: candidates,
        telemetry: { latencyMs: 80, status: "success" },
      };
    },
    async rerank(_query, candidates) {
      return candidates;
    },
  };

  const query: EvaluationQuery = {
    id: "q_mut",
    question: "Testing immutability",
    judgments: [createMockJudgment("c1", 2), createMockJudgment("c2", 1)],
  };

  const runner = new EvaluationRunner(embedder, strategy, mutatingReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-immut",
    candidateK: 2,
    topK: 2,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Experiment A must have original score and clean unmutated snapshot
  assert.equal(record.experimentA.topKChunks[0]?.chunkId, "c1");
  assert.equal(record.experimentA.topKChunks[0]?.score, 0.95);

  // Original candidate pool in the record must also remain uncorrupted
  assert.equal(record.candidatePool[0]?.chunkId, "c1");
});

test("ER-3: Successful Reranking with Unchanged Order — status is 'success', deltas are 0", async () => {
  const c1 = createMockChunk("c1", { similarity: 0.9 });
  const c2 = createMockChunk("c2", { similarity: 0.8 });
  const { strategy } = createMockRetrievalStrategy([c1, c2]);
  const { embedder } = createMockEmbedQuery();

  // Reranker that succeeds and keeps the exact original order
  const preservingReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      return {
        chunks: [...candidates],
        telemetry: { latencyMs: 140, status: "success" },
      };
    },
    async rerank(_query, candidates) {
      return candidates;
    },
  };

  const query: EvaluationQuery = {
    id: "q_unchanged",
    question: "Does order change?",
    judgments: [createMockJudgment("c1", 2), createMockJudgment("c2", 1)],
  };

  const runner = new EvaluationRunner(embedder, strategy, preservingReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-1",
    candidateK: 2,
    topK: 2,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Telemetry must be "success", never "fallback"
  assert.equal(record.experimentB.telemetry.status, "success");
  assert.equal(record.experimentB.telemetry.latencyMs, 140);

  // Deltas must be exactly zero
  assert.equal(record.deltas.deltaNdcg5, 0);
  assert.equal(record.deltas.deltaRecall5Lenient, 0);
  assert.equal(record.deltas.deltaMrr5, 0);

  // Scorecard must report 0 fallbacks
  assert.equal(result.scorecard.rerankerTelemetrySummary.fallbackCount, 0);
  assert.equal(result.scorecard.rerankerTelemetrySummary.fallbackRate, 0);
});

test("ER-4: Successful Reranking with Changed Order — originalRrfRank tracked and positive delta computed", async () => {
  // Baseline order: c1 (irrelevant, rel 0), c2 (highly relevant, rel 2)
  const c1 = createMockChunk("c1", { similarity: 0.95 });
  const c2 = createMockChunk("c2", { similarity: 0.80 });
  const { strategy } = createMockRetrievalStrategy([c1, c2]);
  const { embedder } = createMockEmbedQuery();

  // Reranker promotes c2 above c1
  const reorderingReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      const reordered = [candidates[1]!, candidates[0]!];
      return {
        chunks: reordered,
        telemetry: { latencyMs: 250, status: "success" },
      };
    },
    async rerank(_query, candidates) {
      return [candidates[1]!, candidates[0]!];
    },
  };

  const query: EvaluationQuery = {
    id: "q_reorder",
    question: "Reranker promotion",
    judgments: [createMockJudgment("c1", 0), createMockJudgment("c2", 2)],
  };

  const runner = new EvaluationRunner(embedder, strategy, reorderingReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-reorder",
    candidateK: 2,
    topK: 2,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Baseline Exp A: c1 at rank 1 (rel 0), c2 at rank 2 (rel 2)
  assert.equal(record.experimentA.topKChunks[0]?.chunkId, "c1");
  assert.equal(record.experimentA.topKChunks[1]?.chunkId, "c2");

  // Exp B: c2 promoted to rank 1!
  assert.equal(record.experimentB.topKChunks[0]?.chunkId, "c2");
  assert.equal(record.experimentB.topKChunks[0]?.rank, 1);
  assert.equal(record.experimentB.topKChunks[0]?.originalRrfRank, 2);

  assert.equal(record.experimentB.topKChunks[1]?.chunkId, "c1");
  assert.equal(record.experimentB.topKChunks[1]?.rank, 2);
  assert.equal(record.experimentB.topKChunks[1]?.originalRrfRank, 1);

  // nDCG and MRR should show significant improvement
  assert.ok(record.deltas.deltaNdcg5 !== null && record.deltas.deltaNdcg5 > 0);
  assert.ok(record.deltas.deltaMrr5 !== null && record.deltas.deltaMrr5 > 0);

  // Scorecard win-tie-loss should record 1 win
  assert.equal(result.scorecard.allQueriesMetrics.deltas.winTieLossNdcg.wins, 1);
});

test("ER-5: Timeout Fallback Telemetry — status is 'fallback', failureType: 'timeout', Exp B uses RRF", async () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");
  const { strategy } = createMockRetrievalStrategy([c1, c2]);
  const { embedder } = createMockEmbedQuery();

  const timeoutReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      return {
        chunks: candidates, // Fallback to original candidates
        telemetry: {
          latencyMs: 12050,
          status: "fallback",
          failureType: "timeout",
        },
      };
    },
    async rerank(_query, candidates) {
      return candidates;
    },
  };

  const query: EvaluationQuery = {
    id: "q_timeout",
    question: "Timeout scenario",
    judgments: [createMockJudgment("c1", 2), createMockJudgment("c2", 1)],
  };

  const runner = new EvaluationRunner(embedder, strategy, timeoutReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-timeout",
    candidateK: 2,
    topK: 2,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  assert.equal(record.experimentB.telemetry.status, "fallback");
  assert.equal(record.experimentB.telemetry.failureType, "timeout");
  assert.equal(record.experimentB.telemetry.latencyMs, 12050);

  // Exp B chunks match baseline order
  assert.equal(record.experimentB.topKChunks[0]?.chunkId, "c1");
  assert.equal(record.experimentB.topKChunks[1]?.chunkId, "c2");

  // Summary aggregation
  const summary = result.scorecard.rerankerTelemetrySummary;
  assert.equal(summary.fallbackCount, 1);
  assert.equal(summary.fallbackRate, 1.0);
  assert.equal(summary.fallbackReasons["timeout"], 1);
});

test("ER-6: API Error Fallback Telemetry — failureType: 'http_429' captured and aggregated", async () => {
  const c1 = createMockChunk("c1");
  const { strategy } = createMockRetrievalStrategy([c1]);
  const { embedder } = createMockEmbedQuery();

  const rateLimitedReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      return {
        chunks: candidates,
        telemetry: {
          latencyMs: 110,
          status: "fallback",
          failureType: "http_429",
          httpStatus: 429,
        },
      };
    },
    async rerank(_query, candidates) {
      return candidates;
    },
  };

  const query: EvaluationQuery = {
    id: "q_429",
    question: "Rate limited",
    judgments: [createMockJudgment("c1", 1)],
  };

  const runner = new EvaluationRunner(embedder, strategy, rateLimitedReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-429",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);
  assert.equal(record.experimentB.telemetry.status, "fallback");
  assert.equal(record.experimentB.telemetry.failureType, "http_429");

  const summary = result.scorecard.rerankerTelemetrySummary;
  assert.equal(summary.fallbackCount, 1);
  assert.equal(summary.fallbackReasons["http_429"], 1);
});

test("ER-7: Invalid Permutation Rejection — unexpected or duplicate IDs trigger fallback to RRF", async () => {
  const c1 = createMockChunk("c1");
  const c2 = createMockChunk("c2");
  const { strategy } = createMockRetrievalStrategy([c1, c2]);
  const { embedder } = createMockEmbedQuery();

  // Reranker returns duplicate chunks (c1, c1) instead of permutation of (c1, c2)
  const invalidReranker: EvaluatorReranker = {
    async rerankWithTelemetry(_query, candidates): Promise<GeminiRerankResult> {
      return {
        chunks: [candidates[0]!, candidates[0]!], // Invalid duplicate!
        telemetry: { latencyMs: 90, status: "success" }, // Reranker claims success
      };
    },
    async rerank(_query, candidates) {
      return [candidates[0]!, candidates[0]!];
    },
  };

  const query: EvaluationQuery = {
    id: "q_invalid_perm",
    question: "Permutation validation test",
    judgments: [createMockJudgment("c1", 2), createMockJudgment("c2", 1)],
  };

  const runner = new EvaluationRunner(embedder, strategy, invalidReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-perm",
    candidateK: 2,
    topK: 2,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Runner MUST override telemetry to fallback with failureType "invalid_response"
  assert.equal(record.experimentB.telemetry.status, "fallback");
  assert.equal(record.experimentB.telemetry.failureType, "invalid_response");

  // Experiment B chunks MUST fall back to original baseline order (c1, c2)
  assert.equal(record.experimentB.topKChunks[0]?.chunkId, "c1");
  assert.equal(record.experimentB.topKChunks[1]?.chunkId, "c2");

  assert.equal(result.scorecard.rerankerTelemetrySummary.fallbackReasons["invalid_response"], 1);
});

test("ER-8: Missing Reranker — status is 'skipped', latency is 0ms, runConfig reflects null", async () => {
  const c1 = createMockChunk("c1");
  const { strategy } = createMockRetrievalStrategy([c1]);
  const { embedder } = createMockEmbedQuery();

  const query: EvaluationQuery = {
    id: "q_no_reranker",
    question: "No reranker provided",
    judgments: [createMockJudgment("c1", 2)],
  };

  // Instantiate WITHOUT reranker
  const runner = new EvaluationRunner(embedder, strategy, undefined);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-none",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  assert.equal(record.experimentB.telemetry.status, "skipped");
  assert.equal(record.experimentB.telemetry.latencyMs, 0);

  // Run config reflects null reranker model
  assert.equal(result.scorecard.runConfig.rerankerModel, null);
  assert.equal(result.scorecard.runConfig.rerankerTimeoutMs, null);

  // Exp B matches Exp A exactly
  assert.equal(record.experimentB.topKChunks[0]?.chunkId, record.experimentA.topKChunks[0]?.chunkId);
});

test("ER-9: Provisional Text-Anchor Classification — pendingReview gates query out of finalisedMetrics", async () => {
  // Candidate chunk in DB with current ID "c_current"
  const cCurrent = createMockChunk("c_current", {
    documentId: "doc_100",
    content: "Deterministic text excerpt that matches judgment anchor perfectly.",
  });
  const { strategy } = createMockRetrievalStrategy([cCurrent]);
  const { embedder } = createMockEmbedQuery();

  // Judgment has obsolete chunkId "c_stale", but exact same documentId and textAnchor
  const provisionalJudgment: EvaluationJudgment = {
    chunkId: "c_stale",
    documentId: "doc_100",
    documentTitle: "Doc 100",
    relevance: 2,
    textAnchor: "Deterministic text excerpt that matches judgment anchor perfectly.",
  };

  const query: EvaluationQuery = {
    id: "q_provisional",
    question: "Provisional classification test",
    judgments: [provisionalJudgment],
  };

  const runner = new EvaluationRunner(embedder, strategy);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-prov",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // CandidateMatcher resolved via text_anchor_provisional
  assert.equal(record.candidatePool[0]?.judgment.status, "judged");
  assert.equal(
    record.candidatePool[0]?.judgment.status === "judged"
      ? record.candidatePool[0]?.judgment.matchType
      : undefined,
    "text_anchor_provisional",
  );

  // Flags must mark pendingReview = true
  assert.equal(record.incompletenessFlags.pendingReview, true);

  // Scorecard query counts
  assert.equal(result.scorecard.querySummary.total, 1);
  assert.equal(result.scorecard.querySummary.provisional, 1);
  assert.equal(result.scorecard.querySummary.finalised, 0);

  // finalisedMetrics must be undefined because no queries are finalised!
  assert.equal(result.scorecard.finalisedMetrics, undefined);

  // allQueriesMetrics must still be calculated
  assert.ok(result.scorecard.allQueriesMetrics);
  assert.equal(result.scorecard.allQueriesMetrics.experimentA.ndcg5.count, 1);
});

test("ER-10: Incomplete Sources Classification — missing expected sources gates query as provisional", async () => {
  const c1 = createMockChunk("c1");
  const { strategy } = createMockRetrievalStrategy([c1]);
  const { embedder } = createMockEmbedQuery();

  const query: EvaluationQuery = {
    id: "q_incomplete_src",
    question: "Missing sources test",
    judgments: [createMockJudgment("c1", 2)],
    poolMetadata: {
      collectedAt: new Date().toISOString(),
      expectedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
      completedPoolingSources: ["HYBRID"], // VECTOR and FTS missing!
      uniqueCandidatesReviewed: 1,
      relevantLabeled: 1,
    },
  };

  const runner = new EvaluationRunner(embedder, strategy);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-inc",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  assert.equal(record.incompletenessFlags.incompleteSources, true);
  assert.equal(result.scorecard.querySummary.provisional, 1);
  assert.equal(result.scorecard.querySummary.finalised, 0);
  assert.equal(result.scorecard.finalisedMetrics, undefined);
});

test("ER-11: Threshold Preservation — hierarchy of CLI override -> user repo -> default 0.3", async () => {
  const c1 = createMockChunk("c1");
  const { embedder } = createMockEmbedQuery();

  // Scenario 1: User repository config specifies similarityThreshold: 0.35
  {
    const { strategy, calls } = createMockRetrievalStrategy([c1]);
    const mockRepo = {
      async findByUserId(_userId: string) {
        return { similarityThreshold: 0.35 };
      },
    };

    const runner = new EvaluationRunner(embedder, strategy, undefined, mockRepo);
    const result = await runner.run({
      dataset: createMockDataset([{ id: "q1", question: "Threshold test", judgments: [] }]),
      userId: "user-repo-thresh",
    });

    assert.equal(calls[0]?.options.similarityThreshold, 0.35);
    assert.equal(result.scorecard.runConfig.similarityThreshold, 0.35);
  }

  // Scenario 2: CLI option overrides user repo config with 0.45
  {
    const { strategy, calls } = createMockRetrievalStrategy([c1]);
    const mockRepo = {
      async findByUserId(_userId: string) {
        return { similarityThreshold: 0.35 };
      },
    };

    const runner = new EvaluationRunner(embedder, strategy, undefined, mockRepo);
    const result = await runner.run({
      dataset: createMockDataset([{ id: "q1", question: "Threshold test", judgments: [] }]),
      userId: "user-override",
      similarityThreshold: 0.45,
    });

    assert.equal(calls[0]?.options.similarityThreshold, 0.45);
    assert.equal(result.scorecard.runConfig.similarityThreshold, 0.45);
  }

  // Scenario 3: Neither CLI nor repo provides threshold -> default 0.3 is used (never 0!)
  {
    const { strategy, calls } = createMockRetrievalStrategy([c1]);
    const runner = new EvaluationRunner(embedder, strategy);
    const result = await runner.run({
      dataset: createMockDataset([{ id: "q1", question: "Threshold test", judgments: [] }]),
      userId: "user-default",
    });

    assert.equal(calls[0]?.options.similarityThreshold, 0.3);
    assert.equal(result.scorecard.runConfig.similarityThreshold, 0.3);
  }
});

test("ER-12: Zero Relevant Judgments Exclusion — query excluded from aggregate quality metrics", async () => {
  const c1 = createMockChunk("c1");
  const { strategy } = createMockRetrievalStrategy([c1]);
  const { embedder } = createMockEmbedQuery();

  // Query where all judgments are relevance: 0 (no relevant items exist)
  const query: EvaluationQuery = {
    id: "q_zero_rel",
    question: "Only irrelevant items",
    judgments: [createMockJudgment("c1", 0)],
  };

  const runner = new EvaluationRunner(embedder, strategy);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-zero",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Per-query metrics must be null
  assert.equal(record.experimentA.metrics.recall5Lenient, null);
  assert.equal(record.experimentA.metrics.recall5Strict, null);
  assert.equal(record.experimentA.metrics.ndcg5, null);

  // Summary counts must increment excludedFromMetrics
  assert.equal(result.scorecard.querySummary.excludedFromMetrics, 1);

  // In aggregate metrics, count is 0 and excludedCount is 1
  assert.equal(result.scorecard.allQueriesMetrics.experimentA.recall5Lenient.count, 0);
  assert.equal(result.scorecard.allQueriesMetrics.experimentA.recall5Lenient.excludedCount, 1);
  assert.equal(result.scorecard.allQueriesMetrics.experimentA.recall5Lenient.mean, null);
});

test("ER-13: Sequential Execution — queries executed sequentially with correlated requestIds", async () => {
  const c1 = createMockChunk("c1");
  let activeExecutions = 0;
  let maxConcurrentExecutions = 0;
  const recordedRequestIds: string[] = [];

  const embedder = {
    async execute(_query: string, requestId?: string): Promise<number[]> {
      activeExecutions++;
      if (activeExecutions > maxConcurrentExecutions) {
        maxConcurrentExecutions = activeExecutions;
      }
      if (requestId) recordedRequestIds.push(requestId);
      // Small simulated async delay
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeExecutions--;
      return [0.1, 0.2];
    },
  };

  const strategy: RetrievalStrategy = {
    async execute(_options: RetrievalInput): Promise<RetrievedChunk[]> {
      return [c1];
    },
  };

  const queries: EvaluationQuery[] = [
    { id: "query_alpha", question: "First question", judgments: [createMockJudgment("c1", 1)] },
    { id: "query_beta", question: "Second question", judgments: [createMockJudgment("c1", 2)] },
    { id: "query_gamma", question: "Third question", judgments: [createMockJudgment("c1", 1)] },
  ];

  const runner = new EvaluationRunner(embedder, strategy);
  const result = await runner.run({
    dataset: createMockDataset(queries),
    userId: "user-seq",
    candidateK: 1,
    topK: 1,
  });

  // Strict sequential execution: max concurrent executions must never exceed 1
  assert.equal(maxConcurrentExecutions, 1);
  assert.equal(result.queryRecords.length, 3);

  // Verify unique correlated requestIds
  assert.equal(recordedRequestIds.length, 3);
  assert.match(recordedRequestIds[0] ?? "", /^eval_query_alpha_\d+$/);
  assert.match(recordedRequestIds[1] ?? "", /^eval_query_beta_\d+$/);
  assert.match(recordedRequestIds[2] ?? "", /^eval_query_gamma_\d+$/);
});

test("ER-Extra: Legacy Reranker without rerankWithTelemetry fallback on throwing error", async () => {
  const c1 = createMockChunk("c1");
  const { strategy } = createMockRetrievalStrategy([c1]);
  const { embedder } = createMockEmbedQuery();

  // Legacy Reranker implementing only rerank() which throws
  const legacyFailingReranker: EvaluatorReranker = {
    async rerank() {
      throw new Error("Network timeout or connection refused");
    },
  };

  const query: EvaluationQuery = {
    id: "q_legacy_fail",
    question: "Testing legacy reranker exception",
    judgments: [createMockJudgment("c1", 2)],
  };

  const runner = new EvaluationRunner(embedder, strategy, legacyFailingReranker);
  const result = await runner.run({
    dataset: createMockDataset([query]),
    userId: "user-legacy",
    candidateK: 1,
    topK: 1,
  });

  const record = result.queryRecords[0];
  assert.ok(record);

  // Caught by runner try/catch
  assert.equal(record.experimentB.telemetry.status, "fallback");
  assert.equal(record.experimentB.telemetry.failureType, "Error");
  assert.equal(record.experimentB.topKChunks[0]?.chunkId, "c1");
  assert.equal(result.scorecard.rerankerTelemetrySummary.fallbackCount, 1);
});
