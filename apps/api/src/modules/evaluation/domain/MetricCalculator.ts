/**
 * MetricCalculator — pure, deterministic IR evaluation metric functions.
 *
 * All functions are stateless and have no I/O side effects. They accept
 * pre-resolved judgment data and return computed metric values.
 *
 * IMPORTANT — Judged-Set Metrics
 * ───────────────────────────────
 * All metrics produced here are JUDGED-SET metrics. The judgment pool is
 * constructed by pooling candidates from VECTOR, FTS, and HYBRID retrieval
 * runs followed by human review. This pool is not exhaustive across the full
 * document corpus. Do not interpret Recall@K as corpus-wide recall.
 *
 * Unjudged items (retrieved chunks with no human label) are recorded as
 * "unjudged" by the caller and contribute zero gain in DCG, identical to
 * rel=0 in the numeric computation. Their presence DOES NOT mean the chunk
 * is confirmed irrelevant — it means the judgment set is incomplete. The
 * evaluation runner flags the query as provisional when unjudged items exist.
 *
 * Null returns
 * ─────────────
 * Several functions return `number | null`. A null value means the metric is
 * mathematically undefined for this query (e.g. no relevant judgments exist
 * in the pool). Callers MUST exclude null values from aggregate means and
 * record the exclusion count explicitly in reports.
 */

import type {
  MetricStats,
  QueryDeltas,
  QueryMetrics,
  WinTieLoss,
} from "./EvaluationResult.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Ground-truth judgment status for a single retrieved item.
 *
 * "judged"   — a human reviewer has assigned a graded relevance label.
 * "unjudged" — no ground-truth label exists. Contributes 0 gain in DCG, but
 *              causes the query to be marked provisional in the report.
 */
export type ItemJudgment =
  | { readonly status: "judged"; readonly relevance: 0 | 1 | 2 }
  | { readonly status: "unjudged" };

/**
 * Relevance threshold used for binary-relevance metrics (Recall, MRR).
 *
 * "lenient" — rel >= 1 counts as relevant (primary metric).
 * "strict"  — rel == 2 only (direct / highly relevant answers).
 */
export type RelevanceThreshold = "lenient" | "strict";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the minimum integer relevance score that counts as "relevant"
 * for the given threshold.
 */
function minRelevance(threshold: RelevanceThreshold): 1 | 2 {
  return threshold === "lenient" ? 1 : 2;
}

/**
 * Returns true when the item judgment is a confirmed relevant label that
 * meets or exceeds the threshold.
 */
function isRelevant(judgment: ItemJudgment, threshold: RelevanceThreshold): boolean {
  return (
    judgment.status === "judged" &&
    judgment.relevance >= minRelevance(threshold)
  );
}

/**
 * Returns the numeric relevance value used in DCG computation.
 * Unjudged items are treated as 0 for the purpose of gain calculation only.
 */
function gainRelevance(judgment: ItemJudgment): 0 | 1 | 2 {
  return judgment.status === "judged" ? judgment.relevance : 0;
}

// ---------------------------------------------------------------------------
// Recall@K
// ---------------------------------------------------------------------------

/**
 * Computes Recall at cutoff K.
 *
 * Standard IR definition (TREC):
 *   Recall@K = |{relevant items in top-K retrieved}| / |total relevant judgments|
 *
 * The denominator is the TOTAL count of relevant items in the judgment pool —
 * NOT min(totalRelevant, K). This correctly penalises rankings where the
 * system retrieves only K out of many more relevant items that exist.
 *
 * Returns null when totalRelevant === 0 (no relevant items exist in the judgment
 * pool for this query and threshold). Null values must be excluded from
 * aggregate means; the exclusion count must be reported.
 *
 * @param retrieved     Ordered list of retrieved items with their judgments.
 *                      Only the first `options.k` items are considered.
 * @param totalRelevant Total number of relevant items in the full judgment pool
 *                      for this query at the given threshold (including items
 *                      not retrieved). Computed by the caller from the pool.
 * @param options.k         Cutoff rank (e.g. 5 or 20).
 * @param options.threshold Binary relevance threshold ("lenient" or "strict").
 */
export function computeRecall(
  retrieved: readonly ItemJudgment[],
  totalRelevant: number,
  options: { readonly k: number; readonly threshold: RelevanceThreshold },
): number | null {
  if (totalRelevant === 0) {
    return null;
  }

  const topK = retrieved.slice(0, options.k);
  const hits = topK.filter((j) => isRelevant(j, options.threshold)).length;
  return hits / totalRelevant;
}

// ---------------------------------------------------------------------------
// MRR@K
// ---------------------------------------------------------------------------

/**
 * Computes Reciprocal Rank at cutoff K.
 *
 * Returns 1/rank of the first relevant item within the top-K slice, or 0 if
 * no relevant item appears in the top K. Rank is 1-indexed.
 *
 * Returns null when hasRelevantJudgments is false (no relevant items exist
 * anywhere in the judgment pool for this query at the given threshold). This
 * signals "metric undefined" rather than "system failed to rank any relevant
 * item in top K" (which is 0). Null values are excluded from MRR aggregates.
 *
 * Distinction:
 *   null   — no relevant items in the entire judgment pool (metric undefined).
 *   0      — relevant items exist in the pool but none appeared in top K.
 *   1/rank — first relevant item is at the given rank.
 *
 * @param retrieved             Ordered list of retrieved items with judgments.
 * @param options.k             Cutoff rank.
 * @param options.threshold     Binary relevance threshold.
 * @param options.hasRelevantJudgments
 *   True when at least one judgment with rel >= threshold exists in the pool.
 *   False means the metric is undefined and null is returned.
 */
export function computeMRR(
  retrieved: readonly ItemJudgment[],
  options: {
    readonly k: number;
    readonly threshold: RelevanceThreshold;
    readonly hasRelevantJudgments: boolean;
  },
): number | null {
  if (!options.hasRelevantJudgments) {
    return null;
  }

  const topK = retrieved.slice(0, options.k);
  for (const [i, item] of topK.entries()) {
    if (isRelevant(item, options.threshold)) {
      return 1 / (i + 1);
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// DCG@K
// ---------------------------------------------------------------------------

/**
 * Computes Discounted Cumulative Gain at cutoff K.
 *
 * Uses exponential gain:   gain(rel)   = 2^rel - 1
 * Position discount:       discount(i) = 1 / log₂(i + 1)   (i is 1-indexed)
 *
 * Full formula for position i (1-indexed):
 *   DCG@K = Σᵢ₌₁ᴷ (2^rel(i) - 1) / log₂(i + 1)
 *
 * Unjudged items contribute gain 0 (same as rel=0). Their presence flags the
 * query as provisional via the evaluation runner — DCG itself does not
 * distinguish unjudged from confirmed-irrelevant.
 *
 * Always returns a non-negative number (0.0 when no relevant items appear
 * in the top K or when the retrieved list is empty).
 */
export function computeDCG(
  retrieved: readonly ItemJudgment[],
  options: { readonly k: number },
): number {
  const topK = retrieved.slice(0, options.k);
  let dcg = 0;

  for (const [i, item] of topK.entries()) {
    const rel = gainRelevance(item);
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2); // log₂(rank+1), rank = i+1
  }

  return dcg;
}

// ---------------------------------------------------------------------------
// IDCG@K
// ---------------------------------------------------------------------------

/**
 * Computes Ideal Discounted Cumulative Gain at cutoff K.
 *
 * IDCG is the best possible DCG achievable at cutoff K given the known
 * judgment set. It is computed by sorting all relevance labels in the
 * judgment pool descending and computing DCG on the top-K slice.
 *
 * Uses only the min(K, pool.length) highest-relevance items. Items beyond
 * position K are ignored. Items with rel=0 contribute zero gain to IDCG
 * (and therefore do not raise the ideal ceiling).
 *
 * Returns 0 when allJudgmentRelevances is empty or all labels are 0.
 *
 * @param allJudgmentRelevances  Relevance labels for EVERY judged item in the
 *   pool for this query — including items NOT retrieved. Typically includes
 *   all items pooled from VECTOR+FTS+HYBRID runs and human-reviewed. Must
 *   not be derived from only the HYBRID candidate pool being evaluated, to
 *   avoid underestimating the ideal ceiling.
 */
export function computeIDCG(
  allJudgmentRelevances: readonly (0 | 1 | 2)[],
  options: { readonly k: number },
): number {
  // Sort descending: highest relevance first (optimal ordering).
  const sorted = [...allJudgmentRelevances].sort((a, b) => b - a);
  const topK = sorted.slice(0, options.k);

  let idcg = 0;
  for (const [i, rel] of topK.entries()) {
    idcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }

  return idcg;
}

// ---------------------------------------------------------------------------
// nDCG@K
// ---------------------------------------------------------------------------

/**
 * Computes Normalized Discounted Cumulative Gain at cutoff K.
 *
 *   nDCG@K = DCG@K / IDCG@K
 *
 * Returns null when IDCG@K === 0 (the judgment pool contains no items with
 * rel > 0, making the ideal DCG undefined). This is the same condition as
 * "no relevant items in the pool", which also returns null for Recall and MRR.
 *
 * Returns a value in [0, 1] when IDCG > 0.
 *
 * @param retrieved              Ordered list of retrieved items with judgments.
 * @param allJudgmentRelevances  All relevance labels from the full judgment pool
 *                               (see computeIDCG for the pooling requirement).
 * @param options.k              Cutoff rank.
 */
export function computeNDCG(
  retrieved: readonly ItemJudgment[],
  allJudgmentRelevances: readonly (0 | 1 | 2)[],
  options: { readonly k: number },
): number | null {
  const idcg = computeIDCG(allJudgmentRelevances, options);

  if (idcg === 0) {
    return null;
  }

  return computeDCG(retrieved, options) / idcg;
}

// ---------------------------------------------------------------------------
// Candidate Recall@K  (alias of computeRecall for the candidateK pool stage)
// ---------------------------------------------------------------------------

/**
 * Computes Candidate Recall at the candidate pool cutoff (typically K=20).
 *
 * This is structurally identical to computeRecall. It is provided as a named
 * alias to make the distinction between Stage 1 (candidate pool quality) and
 * Stage 2 (final Top-K quality) explicit at call sites.
 *
 * The result is the theoretical upper bound for any downstream reranker:
 * a chunk absent from the candidate pool cannot be promoted to the top-K
 * regardless of reranker quality.
 *
 * Uses the same standard denominator: totalRelevant from the full judgment
 * pool, NOT min(totalRelevant, candidateK).
 */
export function computeCandidateRecall(
  candidatePool: readonly ItemJudgment[],
  totalRelevant: number,
  options: { readonly k: number; readonly threshold: RelevanceThreshold },
): number | null {
  return computeRecall(candidatePool, totalRelevant, options);
}

// ---------------------------------------------------------------------------
// Delta & Aggregate Statistics
// ---------------------------------------------------------------------------

/**
 * Computes delta = b - a.
 * Returns null if either value is null (metric undefined).
 */
export function computeDelta(
  valB: number | null,
  valA: number | null,
): number | null {
  if (valB === null || valA === null) {
    return null;
  }
  return valB - valA;
}

/**
 * Computes QueryMetrics for a single retrieved list.
 */
export function computeQueryMetrics(
  retrieved: readonly ItemJudgment[],
  allJudgmentRelevances: readonly (0 | 1 | 2)[],
  options: { readonly topK: number },
): QueryMetrics {
  const totalLenient = allJudgmentRelevances.filter((r) => r >= 1).length;
  const totalStrict = allJudgmentRelevances.filter((r) => r === 2).length;

  return {
    recall5Lenient: computeRecall(retrieved, totalLenient, {
      k: options.topK,
      threshold: "lenient",
    }),
    recall5Strict: computeRecall(retrieved, totalStrict, {
      k: options.topK,
      threshold: "strict",
    }),
    mrr5: computeMRR(retrieved, {
      k: options.topK,
      threshold: "lenient",
      hasRelevantJudgments: totalLenient > 0,
    }),
    ndcg5: computeNDCG(retrieved, allJudgmentRelevances, {
      k: options.topK,
    }),
  };
}

/**
 * Computes QueryDeltas from experiment B and experiment A metrics.
 */
export function computeQueryDeltas(
  metricsB: QueryMetrics,
  metricsA: QueryMetrics,
): QueryDeltas {
  return {
    deltaRecall5Lenient: computeDelta(
      metricsB.recall5Lenient,
      metricsA.recall5Lenient,
    ),
    deltaRecall5Strict: computeDelta(
      metricsB.recall5Strict,
      metricsA.recall5Strict,
    ),
    deltaMrr5: computeDelta(metricsB.mrr5, metricsA.mrr5),
    deltaNdcg5: computeDelta(metricsB.ndcg5, metricsA.ndcg5),
  };
}

/**
 * Computes mean and median of numbers, excluding null values.
 * Tracks total count, valid count, and excluded count.
 */
export function computeMetricStats(
  values: readonly (number | null)[],
): MetricStats {
  const valid = values.filter((v): v is number => v !== null);
  const excludedCount = values.length - valid.length;

  if (valid.length === 0) {
    return {
      mean: null,
      median: null,
      count: 0,
      excludedCount,
    };
  }

  const sum = valid.reduce((acc, v) => acc + v, 0);
  const mean = sum / valid.length;

  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;

  return {
    mean,
    median,
    count: valid.length,
    excludedCount,
  };
}

/**
 * Categorises deltas into wins (delta > tol), ties (|delta| <= tol),
 * losses (delta < -tol), and excluded (null).
 */
export function computeWinTieLoss(
  deltas: readonly (number | null)[],
  tolerance = 1e-6,
): WinTieLoss {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let excluded = 0;

  for (const d of deltas) {
    if (d === null) {
      excluded++;
    } else if (d > tolerance) {
      wins++;
    } else if (d < -tolerance) {
      losses++;
    } else {
      ties++;
    }
  }

  return { wins, ties, losses, excluded };
}
