/**
 * Unit tests for MetricCalculator.ts
 *
 * Runner : Node.js built-in test runner via tsx.
 * Scope  : Pure deterministic metric math. No database, network, or file I/O.
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/MetricCalculator.test.ts
 *
 * Hand-verified expected values are pre-computed below each test comment.
 * Floating-point comparisons use a tight absolute tolerance of 1e-9.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeRecall,
  computeMRR,
  computeDCG,
  computeIDCG,
  computeNDCG,
  computeCandidateRecall,
  computeDelta,
  computeQueryMetrics,
  computeQueryDeltas,
  computeMetricStats,
  computeWinTieLoss,
  type ItemJudgment,
} from "../domain/MetricCalculator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOLERANCE = 1e-9;

/** Asserts two floating-point numbers are equal within TOLERANCE. */
function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE,
    `${label}: expected ${expected}, got ${actual} (diff=${Math.abs(actual - expected)})`,
  );
}

/** Convenience builder for a judged item. */
function judged(relevance: 0 | 1 | 2): ItemJudgment {
  return { status: "judged", relevance };
}

/** Convenience builder for an unjudged item. */
const UNJUDGED: ItemJudgment = { status: "unjudged" };

// ===========================================================================
// MC-1: Perfect ranking — 3 total relevant, all in top-5, optimal order
// ===========================================================================
test("MC-1: perfect ranking [2,2,1,0,0], pool [2,2,1] → Recall=1.0, nDCG=1.0", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(2), judged(2), judged(1), judged(0), judged(0),
  ];
  const pool: (0 | 1 | 2)[] = [2, 2, 1];
  const totalLenient = pool.filter((r) => r >= 1).length; // 3
  const totalStrict = pool.filter((r) => r === 2).length; // 2

  // Recall
  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 1.0, "MC-1 Recall lenient");
  assertClose(computeRecall(retrieved, totalStrict, { k: K, threshold: "strict" })!, 1.0, "MC-1 Recall strict");

  // MRR — first relevant at rank 1
  assertClose(computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: true })!, 1.0, "MC-1 MRR lenient");
  assertClose(computeMRR(retrieved, { k: K, threshold: "strict", hasRelevantJudgments: true })!, 1.0, "MC-1 MRR strict");

  // DCG, IDCG, nDCG
  const expectedDCG = 5.392789260714372;
  assertClose(computeDCG(retrieved, { k: K }), expectedDCG, "MC-1 DCG");
  assertClose(computeIDCG(pool, { k: K }), expectedDCG, "MC-1 IDCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 1.0, "MC-1 nDCG");
});

// ===========================================================================
// MC-2: Reversed ranking — same 3-relevant pool, worst possible order
// ===========================================================================
test("MC-2: reversed ranking [0,0,1,2,2], pool [2,2,1] → Recall=1.0, nDCG≈0.5475", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(0), judged(0), judged(1), judged(2), judged(2),
  ];
  const pool: (0 | 1 | 2)[] = [2, 2, 1];
  const totalLenient = 3;

  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 1.0, "MC-2 Recall");
  assertClose(computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: true })!, 1 / 3, "MC-2 MRR");
  assertClose(computeDCG(retrieved, { k: K }), 2.9525880959238044, "MC-2 DCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 0.5475066710714894, "MC-2 nDCG");
});

// ===========================================================================
// MC-3: No relevant items retrieved in top-5
// ===========================================================================
test("MC-3: no hits in top-5, pool [2,2,1] → Recall=0, MRR=0, nDCG=0", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(0), judged(0), judged(0), judged(0), judged(0),
  ];
  const pool: (0 | 1 | 2)[] = [2, 2, 1];
  const totalLenient = 3;

  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 0.0, "MC-3 Recall");
  assertClose(computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: true })!, 0, "MC-3 MRR");
  assertClose(computeDCG(retrieved, { k: K }), 0.0, "MC-3 DCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 0.0, "MC-3 nDCG");
});

// ===========================================================================
// MC-4: Denominator is total relevant — not min(totalRelevant, K)
// ===========================================================================
test("MC-4: Recall denominator is totalRelevant=10, not min(10,5) → Recall=0.5", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(2), judged(2), judged(2), judged(2), judged(2),
  ];
  const pool: (0 | 1 | 2)[] = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
  const totalLenient = pool.filter((r) => r >= 1).length; // 10

  const recall = computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" });
  assertClose(recall!, 0.5, "MC-4 Recall (denominator=10 not min(10,5))");

  assertClose(computeDCG(retrieved, { k: K }), 8.845377356638178, "MC-4 DCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 1.0, "MC-4 nDCG");
});

// ===========================================================================
// MC-5: 2 total relevant, both present and retrieved in optimal order
// ===========================================================================
test("MC-5: pool [2,1] both retrieved → Recall(L)=1.0, Recall(S)=1.0, nDCG=1.0", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(2), judged(1), judged(0), judged(0), judged(0),
  ];
  const pool: (0 | 1 | 2)[] = [2, 1];
  const totalLenient = 2;
  const totalStrict = 1;

  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 1.0, "MC-5 Recall lenient");
  assertClose(computeRecall(retrieved, totalStrict, { k: K, threshold: "strict" })!, 1.0, "MC-5 Recall strict");
  assertClose(computeDCG(retrieved, { k: K }), 3.6309297535714578, "MC-5 DCG");
  assertClose(computeIDCG(pool, { k: K }), 3.6309297535714578, "MC-5 IDCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 1.0, "MC-5 nDCG");
});

// ===========================================================================
// MC-6: Zero relevant judgments → all binary/graded metrics are null
// ===========================================================================
test("MC-6: zero relevant judgments → Recall=null, MRR=null, nDCG=null", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(0), judged(0), judged(0), judged(0), judged(0),
  ];
  const pool: (0 | 1 | 2)[] = [0, 0];

  assert.equal(computeRecall(retrieved, 0, { k: K, threshold: "lenient" }), null, "MC-6 Recall lenient");
  assert.equal(computeRecall(retrieved, 0, { k: K, threshold: "strict" }), null, "MC-6 Recall strict");
  assert.equal(computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: false }), null, "MC-6 MRR");
  assertClose(computeIDCG(pool, { k: K }), 0, "MC-6 IDCG");
  assert.equal(computeNDCG(retrieved, pool, { k: K }), null, "MC-6 nDCG");
});

// ===========================================================================
// MC-7: Empty retrieved pool → Recall=0, MRR=0, nDCG=0
// ===========================================================================
test("MC-7: empty retrieved pool → Recall=0, MRR=0, nDCG=0", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [];
  const pool: (0 | 1 | 2)[] = [2, 1];
  const totalLenient = 2;

  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 0.0, "MC-7 Recall");
  assertClose(computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: true })!, 0, "MC-7 MRR");
  assertClose(computeDCG(retrieved, { k: K }), 0.0, "MC-7 DCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 0.0, "MC-7 nDCG");
});

// ===========================================================================
// MC-8: Candidate Recall@20 — denominator is totalRelevant, not min(total, K)
// ===========================================================================
test("MC-8: Candidate Recall@20 with 15 hits out of 25 total relevant → 0.60 not 0.75", () => {
  const CANDIDATE_K = 20;
  const pool: ItemJudgment[] = [
    ...Array.from({ length: 15 }, () => judged(2)),
    ...Array.from({ length: 5 }, () => judged(0)),
  ];
  const totalRelevant = 25;

  const result = computeCandidateRecall(pool, totalRelevant, {
    k: CANDIDATE_K,
    threshold: "lenient",
  });

  assertClose(result!, 0.6, "MC-8 Candidate Recall@20 = 15/25");

  const wrongCapped = 15 / Math.min(25, CANDIDATE_K);
  assert.ok(Math.abs(result! - wrongCapped) > 0.1, "MC-8 correct != wrong-capped");
});

// ===========================================================================
// MC-9: IDCG with judgment pool smaller than K
// ===========================================================================
test("MC-9: IDCG sums over min(K, pool.length) items — pool [2,1], K=5 → IDCG≈3.631", () => {
  const pool: (0 | 1 | 2)[] = [2, 1];
  assertClose(computeIDCG(pool, { k: 5 }), 3.6309297535714578, "MC-9 IDCG([2,1], k=5)");
  assertClose(computeIDCG(pool, { k: 1 }), 3.0, "MC-9 IDCG([2,1], k=1)");
});

// ===========================================================================
// MC-10: Lenient vs strict boundary — rel=2 item not retrieved
// ===========================================================================
test("MC-10: lenient/strict diverge when rel=2 item is absent from top-5", () => {
  const K = 5;
  const retrieved: ItemJudgment[] = [
    judged(1), judged(1), judged(0), judged(0), judged(0),
  ];
  const pool: (0 | 1 | 2)[] = [1, 1, 2];
  const totalLenient = pool.filter((r) => r >= 1).length; // 3
  const totalStrict = pool.filter((r) => r === 2).length;  // 1

  assertClose(computeRecall(retrieved, totalLenient, { k: K, threshold: "lenient" })!, 2 / 3, "MC-10 Recall lenient");
  assertClose(computeRecall(retrieved, totalStrict, { k: K, threshold: "strict" })!, 0.0, "MC-10 Recall strict");

  assertClose(
    computeMRR(retrieved, { k: K, threshold: "lenient", hasRelevantJudgments: true })!,
    1.0,
    "MC-10 MRR lenient",
  );
  assertClose(
    computeMRR(retrieved, { k: K, threshold: "strict", hasRelevantJudgments: true })!,
    0,
    "MC-10 MRR strict",
  );

  assertClose(computeDCG(retrieved, { k: K }), 1.6309297535714575, "MC-10 DCG");
  assertClose(computeIDCG(pool, { k: K }), 4.130929753571458, "MC-10 IDCG");
  assertClose(computeNDCG(retrieved, pool, { k: K })!, 0.39480936517049525, "MC-10 nDCG");
});

// ===========================================================================
// MC-11: Unjudged items contribute 0 gain — same as rel=0 in computation
// ===========================================================================
test("MC-11: unjudged items contribute gain 0 (same as confirmed-irrelevant in DCG)", () => {
  const K = 3;
  const pool: (0 | 1 | 2)[] = [2];
  const retrievedWithUnjudged: ItemJudgment[] = [UNJUDGED, UNJUDGED, judged(2)];
  const retrievedWithIrrelevant: ItemJudgment[] = [judged(0), judged(0), judged(2)];

  assertClose(
    computeDCG(retrievedWithUnjudged, { k: K }),
    computeDCG(retrievedWithIrrelevant, { k: K }),
    "MC-11 DCG unjudged == confirmed irrelevant",
  );

  assertClose(
    computeNDCG(retrievedWithUnjudged, pool, { k: K })!,
    computeNDCG(retrievedWithIrrelevant, pool, { k: K })!,
    "MC-11 nDCG unjudged == confirmed irrelevant",
  );
});

// ===========================================================================
// MC-12: MRR — distinction between null (undefined) and 0 (failed to rank)
// ===========================================================================
test("MC-12: MRR=null when no relevant judgments; MRR=0 when relevant exists but not in top-K", () => {
  const noRelevantPool: ItemJudgment[] = [judged(0), judged(0)];
  assert.equal(
    computeMRR(noRelevantPool, { k: 5, threshold: "lenient", hasRelevantJudgments: false }),
    null,
    "MC-12 MRR=null when hasRelevantJudgments=false",
  );

  const missedTopK: ItemJudgment[] = [judged(0), judged(0), judged(0)];
  assertClose(
    computeMRR(missedTopK, { k: 3, threshold: "lenient", hasRelevantJudgments: true })!,
    0,
    "MC-12 MRR=0 when relevant exists but absent from top-K",
  );

  const foundAtRank3: ItemJudgment[] = [judged(0), judged(0), judged(2)];
  assertClose(
    computeMRR(foundAtRank3, { k: 5, threshold: "lenient", hasRelevantJudgments: true })!,
    1 / 3,
    "MC-12 MRR=1/3 when first relevant at rank 3",
  );
});

// ===========================================================================
// MC-13: IDCG is independent of retrieval order — depends only on the pool
// ===========================================================================
test("MC-13: IDCG is deterministic regardless of pool input order", () => {
  const pool1: (0 | 1 | 2)[] = [2, 1, 0, 2, 1];
  const pool2: (0 | 1 | 2)[] = [0, 1, 2, 1, 2];
  const pool3: (0 | 1 | 2)[] = [1, 2, 2, 0, 1];

  const idcg1 = computeIDCG(pool1, { k: 5 });
  const idcg2 = computeIDCG(pool2, { k: 5 });
  const idcg3 = computeIDCG(pool3, { k: 5 });

  assertClose(idcg1, idcg2, "MC-13 IDCG pool1==pool2");
  assertClose(idcg2, idcg3, "MC-13 IDCG pool2==pool3");
});

// ===========================================================================
// MC-14: Recall@K cutoff is respected — items beyond K are ignored
// ===========================================================================
test("MC-14: items beyond K are ignored in Recall, MRR, and DCG", () => {
  const retrieved: ItemJudgment[] = [
    judged(0), judged(0), judged(0), judged(0), judged(0),
    judged(2), judged(2), judged(2), judged(2), judged(2),
  ];
  const pool: (0 | 1 | 2)[] = [2, 2, 2, 2, 2];
  const totalLenient = 5;

  assertClose(computeRecall(retrieved, totalLenient, { k: 5, threshold: "lenient" })!, 0.0, "MC-14 Recall@5=0");
  assertClose(computeMRR(retrieved, { k: 5, threshold: "lenient", hasRelevantJudgments: true })!, 0, "MC-14 MRR@5=0");
  assertClose(computeDCG(retrieved, { k: 5 }), 0.0, "MC-14 DCG@5=0");

  assert.ok(computeRecall(retrieved, totalLenient, { k: 10, threshold: "lenient" })! > 0, "MC-14 Recall@10>0");
  assert.ok(computeDCG(retrieved, { k: 10 }) > 0, "MC-14 DCG@10>0");
});

// ===========================================================================
// MC-15: computeCandidateRecall is an alias of computeRecall
// ===========================================================================
test("MC-15: computeCandidateRecall and computeRecall return identical values", () => {
  const pool: ItemJudgment[] = [judged(2), judged(1), judged(0), judged(2)];
  const totalLenient = 3;

  const viaRecall = computeRecall(pool, totalLenient, { k: 20, threshold: "lenient" });
  const viaCandidateRecall = computeCandidateRecall(pool, totalLenient, { k: 20, threshold: "lenient" });

  assert.equal(viaRecall, viaCandidateRecall, "MC-15 computeRecall == computeCandidateRecall");
});

// ===========================================================================
// MC-16: Empty judgment pool → IDCG=0, nDCG=null
// ===========================================================================
test("MC-16: empty judgment pool → IDCG=0, nDCG=null", () => {
  const pool: (0 | 1 | 2)[] = [];
  assertClose(computeIDCG(pool, { k: 5 }), 0, "MC-16 IDCG empty pool");
  assert.equal(computeNDCG([], pool, { k: 5 }), null, "MC-16 nDCG null when IDCG=0");
});

// ===========================================================================
// MC-17: computeDelta handles numeric deltas and null propagation
// ===========================================================================
test("MC-17: computeDelta computes b - a and returns null if either operand is null", () => {
  assertClose(computeDelta(0.8, 0.5)!, 0.3, "0.8 - 0.5");
  assertClose(computeDelta(0.5, 0.8)!, -0.3, "0.5 - 0.8");
  assertClose(computeDelta(0.5, 0.5)!, 0.0, "0.5 - 0.5");
  assert.equal(computeDelta(null, 0.5), null, "null - 0.5 = null");
  assert.equal(computeDelta(0.8, null), null, "0.8 - null = null");
  assert.equal(computeDelta(null, null), null, "null - null = null");
});

// ===========================================================================
// MC-18: computeQueryMetrics and computeQueryDeltas
// ===========================================================================
test("MC-18: computeQueryMetrics calculates all metrics for a query result", () => {
  const retrievedA: ItemJudgment[] = [judged(0), judged(1), judged(0), judged(0), judged(0)];
  const retrievedB: ItemJudgment[] = [judged(2), judged(1), judged(0), judged(0), judged(0)];
  const pool: (0 | 1 | 2)[] = [2, 1]; // totalLenient=2, totalStrict=1

  const metricsA = computeQueryMetrics(retrievedA, pool, { topK: 5 });
  const metricsB = computeQueryMetrics(retrievedB, pool, { topK: 5 });

  // A has rel=1 at rank 2
  assertClose(metricsA.recall5Lenient!, 0.5, "metricsA recall5Lenient (1/2)");
  assertClose(metricsA.recall5Strict!, 0.0, "metricsA recall5Strict (0/1)");
  assertClose(metricsA.mrr5!, 0.5, "metricsA mrr5 (1/2)");
  assert.ok(metricsA.ndcg5! > 0, "metricsA ndcg5 > 0");

  // B has rel=2 at rank 1, rel=1 at rank 2 (perfect)
  assertClose(metricsB.recall5Lenient!, 1.0, "metricsB recall5Lenient");
  assertClose(metricsB.recall5Strict!, 1.0, "metricsB recall5Strict");
  assertClose(metricsB.mrr5!, 1.0, "metricsB mrr5");
  assertClose(metricsB.ndcg5!, 1.0, "metricsB ndcg5");

  // Deltas (B - A)
  const deltas = computeQueryDeltas(metricsB, metricsA);
  assertClose(deltas.deltaRecall5Lenient!, 0.5, "deltaRecall5Lenient (1.0 - 0.5)");
  assertClose(deltas.deltaRecall5Strict!, 1.0, "deltaRecall5Strict (1.0 - 0.0)");
  assertClose(deltas.deltaMrr5!, 0.5, "deltaMrr5 (1.0 - 0.5)");
  assert.ok(deltas.deltaNdcg5! > 0, "deltaNdcg5 > 0");
});

// ===========================================================================
// MC-19: computeMetricStats — mean, median, excluded counts
// ===========================================================================
test("MC-19: computeMetricStats correctly excludes null values and computes mean/median", () => {
  // Odd length
  const statsOdd = computeMetricStats([0.2, null, 0.8, 0.5, null]);
  assert.equal(statsOdd.count, 3, "valid count");
  assert.equal(statsOdd.excludedCount, 2, "excluded count");
  assertClose(statsOdd.mean!, 0.5, "mean (0.2 + 0.8 + 0.5) / 3");
  assertClose(statsOdd.median!, 0.5, "median sorted [0.2, 0.5, 0.8]");

  // Even length
  const statsEven = computeMetricStats([0.2, 0.8, 0.4, 0.6]);
  assert.equal(statsEven.count, 4);
  assert.equal(statsEven.excludedCount, 0);
  assertClose(statsEven.mean!, 0.5, "mean");
  assertClose(statsEven.median!, 0.5, "median (0.4 + 0.6) / 2");

  // All null
  const statsEmpty = computeMetricStats([null, null]);
  assert.equal(statsEmpty.mean, null);
  assert.equal(statsEmpty.median, null);
  assert.equal(statsEmpty.count, 0);
  assert.equal(statsEmpty.excludedCount, 2);
});

// ===========================================================================
// MC-20: computeWinTieLoss categorises deltas
// ===========================================================================
test("MC-20: computeWinTieLoss categorises deltas by sign with tolerance", () => {
  const deltas = [0.15, -0.05, 0.0, 1e-7, -1e-7, null, 0.2];
  const wtl = computeWinTieLoss(deltas, 1e-6);

  // 0.15 (win), 0.2 (win) -> 2 wins
  assert.equal(wtl.wins, 2, "wins");
  // -0.05 (loss) -> 1 loss
  assert.equal(wtl.losses, 1, "losses");
  // 0.0, 1e-7, -1e-7 -> 3 ties
  assert.equal(wtl.ties, 3, "ties");
  // null -> 1 excluded
  assert.equal(wtl.excluded, 1, "excluded");
});
