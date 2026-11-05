/**
 * EvaluationRunner — core offline application orchestrator for retrieval evaluation.
 *
 * Implements Objective A: Pure Reranking Evaluation over a shared candidate pool.
 *
 * Key Invariants:
 * 1. Shared Candidate Pool:
 *    retrievalStrategy.execute is called once per query at candidateK (default 20).
 *    Both Experiment A and Experiment B evaluate the exact same candidate pool.
 *
 * 2. Candidate Pool Immutability:
 *    Experiment A evaluates an immutable baseline snapshot. A safe copy is passed
 *    to the reranker.
 *
 * 3. Permutation Validation:
 *    Reranker output is verified to be a complete, valid permutation of the original
 *    candidate pool. Missing, duplicate, or unexpected IDs trigger fallback.
 *
 * 4. Ground-Truth Telemetry:
 *    Uses reranker.rerankWithTelemetry() when available to capture exact failure
 *    classification and latency without inferring from output order.
 *
 * 5. Finalised vs. Provisional Classification:
 *    A query is finalised only when unjudgedInEvalPool, incompleteSources, and
 *    pendingReview are all false.
 */

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type { RetrievalStrategy } from "../../retrieval/application/RetrievalStrategy.js";
import type { Reranker } from "../../retrieval/application/Reranker.js";
import type { GeminiRerankResult } from "../../retrieval/application/GeminiReranker.js";

import type {
  EvaluationDataset,
} from "../domain/EvaluationDataset.js";
import type {
  EvaluationQueryRecord,
  EvaluationRunConfig,
  EvaluationRunResult,
  EvaluationScorecard,
  RankedChunk,
  RerankerTelemetry,
  AggregateMetricsGroup,
} from "../domain/EvaluationResult.js";
import {
  computeCandidateRecall,
  computeMetricStats,
  computeQueryDeltas,
  computeQueryMetrics,
  computeWinTieLoss,
} from "../domain/MetricCalculator.js";
import {
  matchCandidate,
  matchCandidatePool,
  toItemJudgment,
} from "./CandidateMatcher.js";

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

export interface EvaluatorReranker extends Reranker {
  /**
   * Optional evaluation-facing method exposing exact outcome telemetry.
   */
  rerankWithTelemetry?(
    query: string,
    candidates: RetrievedChunk[],
    requestId?: string,
  ): Promise<GeminiRerankResult>;
}

export interface EvaluationRunOptions {
  readonly dataset: EvaluationDataset;
  readonly userId: string;
  readonly similarityThreshold?: number; // Explicit override if provided
  readonly candidateK?: number; // Default: 20
  readonly topK?: number; // Default: 5
  readonly retrievalStrategyName?: "HYBRID" | "VECTOR" | "FTS"; // Default: "HYBRID"
  readonly embeddingModel?: string; // Default: "gemini-embedding-001"
  readonly rerankerModel?: string; // Default: "gemini-3.5-flash-lite"
  readonly rerankerTimeoutMs?: number; // Default: 12000
}

export type { EvaluationRunResult };

// ---------------------------------------------------------------------------
// Permutation Validator
// ---------------------------------------------------------------------------

export function validatePermutation(
  original: readonly RetrievedChunk[],
  reranked: readonly RetrievedChunk[],
): { readonly valid: boolean; readonly reason?: string } {
  if (reranked.length !== original.length) {
    return {
      valid: false,
      reason: `Length mismatch: expected ${original.length}, received ${reranked.length}`,
    };
  }

  const originalIds = new Set(original.map((c) => c.chunkId));
  const seenIds = new Set<string>();

  for (const chunk of reranked) {
    if (!originalIds.has(chunk.chunkId)) {
      return {
        valid: false,
        reason: `Unexpected chunkId "${chunk.chunkId}" in reranked output`,
      };
    }
    if (seenIds.has(chunk.chunkId)) {
      return {
        valid: false,
        reason: `Duplicate chunkId "${chunk.chunkId}" in reranked output`,
      };
    }
    seenIds.add(chunk.chunkId);
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// EvaluationRunner Class
// ---------------------------------------------------------------------------

export class EvaluationRunner {
  constructor(
    private readonly embedQuery: {
      execute(query: string, requestId?: string): Promise<number[]>;
    },
    private readonly retrievalStrategy: RetrievalStrategy,
    private readonly reranker?: EvaluatorReranker,
    private readonly configRepository?: {
      findByUserId(userId: string): Promise<{ similarityThreshold?: number } | null>;
    },
  ) {}

  /**
   * Executes offline evaluation for Objective A (Pure Reranking Evaluation).
   */
  async run(options: EvaluationRunOptions): Promise<EvaluationRunResult> {
    const candidateK = options.candidateK ?? 20;
    const topK = options.topK ?? 5;
    const retrievalStrategyName = options.retrievalStrategyName ?? "HYBRID";
    const embeddingModel = options.embeddingModel ?? "gemini-embedding-001";
    const rerankerModel = options.rerankerModel ?? "gemini-3.5-flash-lite";
    const rerankerTimeoutMs = options.rerankerTimeoutMs ?? 12_000;

    // Resolve similarity threshold: options override -> user config in DB -> 0.3
    let similarityThreshold = options.similarityThreshold;
    if (similarityThreshold === undefined && this.configRepository) {
      const config = await this.configRepository.findByUserId(options.userId);
      similarityThreshold = config?.similarityThreshold ?? 0.3;
    } else if (similarityThreshold === undefined) {
      similarityThreshold = 0.3;
    }

    const runConfig: EvaluationRunConfig = {
      runAt: new Date().toISOString(),
      datasetVersion: options.dataset.version,
      mode: "pure-reranking",
      retrievalStrategy: retrievalStrategyName,
      rrfK: 60,
      candidateK,
      topK,
      similarityThreshold,
      embeddingModel,
      rerankerModel: this.reranker ? rerankerModel : null,
      rerankerTimeoutMs: this.reranker ? rerankerTimeoutMs : null,
    };

    const queryRecords: EvaluationQueryRecord[] = [];

    // Process evaluation queries sequentially
    for (const query of options.dataset.queries) {
      const requestId = `eval_${query.id}_${Date.now()}`;

      // 1. Generate query embedding
      const queryEmbedding = await this.embedQuery.execute(query.question, requestId);

      // 2. Retrieve initial candidate pool once (shared pool invariant)
      const retrieved = await this.retrievalStrategy.execute({
        query: query.question,
        queryEmbedding,
        userId: options.userId,
        limit: candidateK,
        similarityThreshold,
        requestId,
      });

      // 3. Take an immutable snapshot for baseline Experiment A
      const baselineChunks = retrieved.map((c) => ({ ...c }));

      // 4. Match initial candidate pool against query judgments
      const matchResult = matchCandidatePool(
        baselineChunks,
        query.judgments,
        query.poolMetadata,
      );

      // 5. Compute Candidate Recall@20 (ceiling)
      const candidateRecall20 = {
        candidateRecall20Lenient: computeCandidateRecall(
          matchResult.itemJudgments,
          matchResult.totalRelevantLenient,
          { k: candidateK, threshold: "lenient" },
        ),
        candidateRecall20Strict: computeCandidateRecall(
          matchResult.itemJudgments,
          matchResult.totalRelevantStrict,
          { k: candidateK, threshold: "strict" },
        ),
      };

      // 6. Experiment A: Baseline Top-K (RRF ordering)
      const topKBaseline = matchResult.candidatePool.slice(0, topK);
      const topKChunksA: RankedChunk[] = topKBaseline.map((c, idx) => ({
        chunkId: c.chunkId,
        rank: idx + 1,
        score: c.rrfScore,
        judgment: c.judgment,
      }));

      const metricsA = computeQueryMetrics(
        topKBaseline.map((c) => toItemJudgment(c.judgment)),
        matchResult.allJudgmentRelevances,
        { topK },
      );

      // 7. Experiment B: Treatment Top-K (Gemini Reranker)
      let rerankedChunks: RetrievedChunk[] = baselineChunks;
      let telemetry: RerankerTelemetry = {
        latencyMs: 0,
        status: "skipped",
      };

      if (this.reranker) {
        // Pass a fresh shallow copy to isolate the reranker
        const candidatesToRerank = baselineChunks.map((c) => ({ ...c }));
        const tRerank0 = performance.now();

        if (this.reranker.rerankWithTelemetry) {
          const rerankResult = await this.reranker.rerankWithTelemetry(
            query.question,
            candidatesToRerank,
            requestId,
          );
          rerankedChunks = rerankResult.chunks;
          telemetry = {
            latencyMs: rerankResult.telemetry.latencyMs,
            status: rerankResult.telemetry.status,
            failureType: rerankResult.telemetry.failureType,
            approxTokens: rerankResult.telemetry.approxTokens,
          };
        } else {
          try {
            rerankedChunks = await this.reranker.rerank(
              query.question,
              candidatesToRerank,
              requestId,
            );
            telemetry = {
              latencyMs: Math.round(performance.now() - tRerank0),
              status: "success",
            };
          } catch (error) {
            telemetry = {
              latencyMs: Math.round(performance.now() - tRerank0),
              status: "fallback",
              failureType: error instanceof Error ? error.name : "unknown_error",
            };
            rerankedChunks = baselineChunks;
          }
        }

        // Validate permutation integrity
        const permCheck = validatePermutation(baselineChunks, rerankedChunks);
        if (!permCheck.valid) {
          telemetry = {
            latencyMs: telemetry.latencyMs,
            status: "fallback",
            failureType: "invalid_response",
          };
          rerankedChunks = baselineChunks;
        }
      }

      // Map original RRF ranks
      const originalRrfRankMap = new Map<string, number>();
      for (const chunk of matchResult.candidatePool) {
        originalRrfRankMap.set(chunk.chunkId, chunk.rrfRank);
      }

      const allRerankedChunks: RankedChunk[] = rerankedChunks.map((chunk, idx) => {
        const resolution = matchCandidate(chunk, query.judgments);
        return {
          chunkId: chunk.chunkId,
          rank: idx + 1,
          originalRrfRank: originalRrfRankMap.get(chunk.chunkId),
          score: chunk.similarity,
          judgment: resolution,
        };
      });

      const topKChunksB: RankedChunk[] = allRerankedChunks.slice(0, topK);

      const metricsB = computeQueryMetrics(
        topKChunksB.map((c) => toItemJudgment(c.judgment)),
        matchResult.allJudgmentRelevances,
        { topK },
      );

      // 8. Compute deltas
      const deltas = computeQueryDeltas(metricsB, metricsA);

      queryRecords.push({
        queryId: query.id,
        question: query.question,
        category: query.category,
        runConfig,
        candidatePool: matchResult.candidatePool,
        hasUnjudgedCandidates: matchResult.hasUnresolvedCandidates,
        incompletenessFlags: matchResult.incompletenessFlags,
        candidateRecall20,
        experimentA: {
          topKChunks: topKChunksA,
          metrics: metricsA,
          latencyMs: 0,
        },
        experimentB: {
          topKChunks: topKChunksB,
          allRerankedChunks,
          metrics: metricsB,
          telemetry,
        },
        deltas,
      });
    }

    // 9. Aggregate Scorecard
    const scorecard = this.aggregateScorecard(runConfig, queryRecords);

    return {
      scorecard,
      queryRecords,
    };
  }

  private aggregateScorecard(
    runConfig: EvaluationRunConfig,
    queryRecords: readonly EvaluationQueryRecord[],
  ): EvaluationScorecard {
    // Finalised only when unjudgedInEvalPool, incompleteSources, and pendingReview are ALL false
    const finalisedRecords = queryRecords.filter(
      (r) =>
        !r.incompletenessFlags.unjudgedInEvalPool &&
        !r.incompletenessFlags.incompleteSources &&
        !r.incompletenessFlags.pendingReview,
    );
    const provisionalRecords = queryRecords.filter(
      (r) =>
        r.incompletenessFlags.unjudgedInEvalPool ||
        r.incompletenessFlags.incompleteSources ||
        r.incompletenessFlags.pendingReview,
    );

    const excludedFromMetrics = queryRecords.filter(
      (r) =>
        r.experimentA.metrics.recall5Lenient === null &&
        r.experimentA.metrics.ndcg5 === null,
    ).length;

    const allQueriesMetrics = this.aggregateGroup(queryRecords);

    let finalisedMetrics:
      | {
          readonly experimentA: AggregateMetricsGroup;
          readonly experimentB: AggregateMetricsGroup;
          readonly deltas: {
            readonly recall5Lenient: ReturnType<typeof computeMetricStats>;
            readonly recall5Strict: ReturnType<typeof computeMetricStats>;
            readonly mrr5: ReturnType<typeof computeMetricStats>;
            readonly ndcg5: ReturnType<typeof computeMetricStats>;
            readonly winTieLossNdcg: ReturnType<typeof computeWinTieLoss>;
          };
        }
      | undefined = undefined;

    if (finalisedRecords.length > 0) {
      finalisedMetrics = this.aggregateGroup(finalisedRecords);
    }

    // Telemetry summary
    const latencies = queryRecords.map((r) => r.experimentB.telemetry.latencyMs);
    const latencyStats = computeMetricStats(latencies);
    const fallbackRecords = queryRecords.filter(
      (r) => r.experimentB.telemetry.status === "fallback",
    );
    const fallbackReasons: Record<string, number> = {};
    for (const r of fallbackRecords) {
      const reason = r.experimentB.telemetry.failureType ?? "unknown";
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    }

    const rerankerTelemetrySummary = {
      latencyMedianMs: latencyStats.median ?? 0,
      latencyMeanMs: latencyStats.mean !== null ? Math.round(latencyStats.mean) : 0,
      fallbackCount: fallbackRecords.length,
      fallbackRate: queryRecords.length > 0 ? fallbackRecords.length / queryRecords.length : 0,
      fallbackReasons,
    };

    return {
      runConfig,
      querySummary: {
        total: queryRecords.length,
        finalised: finalisedRecords.length,
        provisional: provisionalRecords.length,
        excludedFromMetrics,
      },
      finalisedMetrics,
      allQueriesMetrics,
      rerankerTelemetrySummary,
    };
  }

  private aggregateGroup(records: readonly EvaluationQueryRecord[]) {
    return {
      experimentA: {
        candidateRecall20Lenient: computeMetricStats(
          records.map((r) => r.candidateRecall20.candidateRecall20Lenient),
        ),
        candidateRecall20Strict: computeMetricStats(
          records.map((r) => r.candidateRecall20.candidateRecall20Strict),
        ),
        recall5Lenient: computeMetricStats(
          records.map((r) => r.experimentA.metrics.recall5Lenient),
        ),
        recall5Strict: computeMetricStats(
          records.map((r) => r.experimentA.metrics.recall5Strict),
        ),
        mrr5: computeMetricStats(records.map((r) => r.experimentA.metrics.mrr5)),
        ndcg5: computeMetricStats(records.map((r) => r.experimentA.metrics.ndcg5)),
      },
      experimentB: {
        candidateRecall20Lenient: computeMetricStats(
          records.map((r) => r.candidateRecall20.candidateRecall20Lenient),
        ),
        candidateRecall20Strict: computeMetricStats(
          records.map((r) => r.candidateRecall20.candidateRecall20Strict),
        ),
        recall5Lenient: computeMetricStats(
          records.map((r) => r.experimentB.metrics.recall5Lenient),
        ),
        recall5Strict: computeMetricStats(
          records.map((r) => r.experimentB.metrics.recall5Strict),
        ),
        mrr5: computeMetricStats(records.map((r) => r.experimentB.metrics.mrr5)),
        ndcg5: computeMetricStats(records.map((r) => r.experimentB.metrics.ndcg5)),
      },
      deltas: {
        recall5Lenient: computeMetricStats(
          records.map((r) => r.deltas.deltaRecall5Lenient),
        ),
        recall5Strict: computeMetricStats(
          records.map((r) => r.deltas.deltaRecall5Strict),
        ),
        mrr5: computeMetricStats(records.map((r) => r.deltas.deltaMrr5)),
        ndcg5: computeMetricStats(records.map((r) => r.deltas.deltaNdcg5)),
        winTieLossNdcg: computeWinTieLoss(records.map((r) => r.deltas.deltaNdcg5)),
      },
    };
  }
}
