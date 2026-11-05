/**
 * EvaluationResult — domain types for retrieval evaluation results.
 *
 * Covers run configuration, per-query records, candidate pool data,
 * telemetry, metric summaries, and aggregate scorecards.
 */

// ---------------------------------------------------------------------------
// Run Configuration
// ---------------------------------------------------------------------------

export interface EvaluationRunConfig {
  /** ISO timestamp when the evaluation run started. */
  readonly runAt: string;
  /** Dataset semantic version or file identifier. */
  readonly datasetVersion: string;
  /** Evaluation mode. */
  readonly mode: "pure-reranking" | "production-comparison";
  /** Retrieval strategy executed for candidate retrieval. */
  readonly retrievalStrategy: "HYBRID" | "VECTOR" | "FTS";
  /** RRF constant k used in HybridSearch fusion (default 60). */
  readonly rrfK: number;
  /** Initial candidate pool limit fetched from retrieval (default 20). */
  readonly candidateK: number;
  /** Cutoff rank for final evaluation (default 5). */
  readonly topK: number;
  /**
   * Similarity threshold used in retrieval. Read from RetrievalConfig
   * (e.g. 0.3) or CLI flag. Never silently set to 0.
   */
  readonly similarityThreshold: number;
  /** Embedding model name. */
  readonly embeddingModel: string;
  /** Reranker model name (null if reranker not configured). */
  readonly rerankerModel: string | null;
  /** Reranker timeout in ms. */
  readonly rerankerTimeoutMs: number | null;
}

// ---------------------------------------------------------------------------
// Query Metric Types
// ---------------------------------------------------------------------------

export interface QueryMetrics {
  /** Recall@5 using lenient threshold (rel >= 1). Null if totalRelevant is 0. */
  readonly recall5Lenient: number | null;
  /** Recall@5 using strict threshold (rel == 2). Null if no rel=2 judgments exist. */
  readonly recall5Strict: number | null;
  /** MRR@5 using lenient threshold. Null if no relevant judgments exist in pool. */
  readonly mrr5: number | null;
  /** nDCG@5 with exponential gain. Null if IDCG@5 is 0. */
  readonly ndcg5: number | null;
}

export interface CandidatePoolMetrics {
  /** Candidate Recall@20 using lenient threshold (rel >= 1). */
  readonly candidateRecall20Lenient: number | null;
  /** Candidate Recall@20 using strict threshold (rel == 2). */
  readonly candidateRecall20Strict: number | null;
}

export interface QueryDeltas {
  /** delta = ExpB - ExpA. Null if either value is null. */
  readonly deltaRecall5Lenient: number | null;
  readonly deltaRecall5Strict: number | null;
  readonly deltaMrr5: number | null;
  readonly deltaNdcg5: number | null;
}

// ---------------------------------------------------------------------------
// Candidate & Ranked Items
// ---------------------------------------------------------------------------

export type JudgmentResolution =
  | {
      readonly status: "judged";
      readonly relevance: 0 | 1 | 2;
      readonly matchType: "exact_id" | "text_anchor_provisional";
    }
  | {
      readonly status: "unjudged";
    }
  | {
      readonly status: "ambiguous";
      readonly reason: string;
      readonly matchingJudgmentCount: number;
    };

export interface CandidateChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly chunkIndex: number;
  readonly rrfRank: number; // 1-indexed
  readonly rrfScore: number;
  readonly judgment: JudgmentResolution;
}

export interface RankedChunk {
  readonly chunkId: string;
  readonly rank: number; // 1-indexed (1..topK)
  readonly originalRrfRank?: number | undefined;
  readonly score?: number | undefined;
  readonly judgment: JudgmentResolution;
}

// ---------------------------------------------------------------------------
// Telemetry & Flags
// ---------------------------------------------------------------------------

export interface RerankerTelemetry {
  readonly latencyMs: number;
  readonly status: "success" | "fallback" | "skipped";
  readonly failureType?: string | undefined;
  readonly approxTokens?: number | undefined;
}

export interface IncompletenessFlags {
  /** True if any candidate in the candidate pool is unjudged or ambiguous. */
  readonly unjudgedInEvalPool: boolean;
  /** True if expected pooling sources were defined and any source is missing from completed. */
  readonly incompleteSources: boolean;
  /** True if human review is pending or provisional anchor matches exist in the pool. */
  readonly pendingReview: boolean;
}

// ---------------------------------------------------------------------------
// Complete Per-Query Record
// ---------------------------------------------------------------------------

export interface EvaluationQueryRecord {
  readonly queryId: string;
  readonly question: string;
  readonly category?: string | undefined;
  readonly runConfig: EvaluationRunConfig;

  /** Full candidate pool retrieved (size <= candidateK). */
  readonly candidatePool: readonly CandidateChunk[];
  /** Convenience flag: true when any candidate in the pool is unjudged. */
  readonly hasUnjudgedCandidates: boolean;
  /** Incompleteness flags documenting judgment completeness. */
  readonly incompletenessFlags: IncompletenessFlags;

  /** Candidate pool recall (ceiling for reranking). */
  readonly candidateRecall20: CandidatePoolMetrics;

  /** Experiment A (Baseline: raw RRF top-K). */
  readonly experimentA: {
    readonly topKChunks: readonly RankedChunk[];
    readonly metrics: QueryMetrics;
    readonly latencyMs: number;
  };

  /** Experiment B (Treatment: reranked top-K). */
  readonly experimentB: {
    readonly topKChunks: readonly RankedChunk[];
    /** Complete reranked candidate pool (all candidateK items in reranked order). */
    readonly allRerankedChunks?: readonly RankedChunk[] | undefined;
    readonly metrics: QueryMetrics;
    readonly telemetry: RerankerTelemetry;
  };

  /** Per-query deltas (ExpB - ExpA). */
  readonly deltas: QueryDeltas;
}

// ---------------------------------------------------------------------------
// Aggregate Statistics & Scorecard
// ---------------------------------------------------------------------------

export interface MetricStats {
  readonly mean: number | null;
  readonly median: number | null;
  readonly count: number;
  readonly excludedCount: number;
}

export interface WinTieLoss {
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly excluded: number;
}

export interface AggregateMetricsGroup {
  readonly candidateRecall20Lenient: MetricStats;
  readonly candidateRecall20Strict: MetricStats;
  readonly recall5Lenient: MetricStats;
  readonly recall5Strict: MetricStats;
  readonly mrr5: MetricStats;
  readonly ndcg5: MetricStats;
}

export interface EvaluationScorecard {
  readonly runConfig: EvaluationRunConfig;
  readonly querySummary: {
    readonly total: number;
    readonly finalised: number;
    readonly provisional: number;
    readonly excludedFromMetrics: number;
  };
  /** Metrics computed over finalised queries only (no unjudged candidates). */
  readonly finalisedMetrics?: {
    readonly experimentA: AggregateMetricsGroup;
    readonly experimentB: AggregateMetricsGroup;
    readonly deltas: {
      readonly recall5Lenient: MetricStats;
      readonly recall5Strict: MetricStats;
      readonly mrr5: MetricStats;
      readonly ndcg5: MetricStats;
      readonly winTieLossNdcg: WinTieLoss;
    };
  } | undefined;
  /** Metrics computed over all queries (finalised + provisional). */
  readonly allQueriesMetrics: {
    readonly experimentA: AggregateMetricsGroup;
    readonly experimentB: AggregateMetricsGroup;
    readonly deltas: {
      readonly recall5Lenient: MetricStats;
      readonly recall5Strict: MetricStats;
      readonly mrr5: MetricStats;
      readonly ndcg5: MetricStats;
      readonly winTieLossNdcg: WinTieLoss;
    };
  };
  readonly rerankerTelemetrySummary: {
    readonly latencyMedianMs: number;
    readonly latencyMeanMs: number;
    readonly fallbackCount: number;
    readonly fallbackRate: number;
    readonly fallbackReasons: Readonly<Record<string, number>>;
  };
}

export interface EvaluationRunResult {
  readonly scorecard: EvaluationScorecard;
  readonly queryRecords: readonly EvaluationQueryRecord[];
}
