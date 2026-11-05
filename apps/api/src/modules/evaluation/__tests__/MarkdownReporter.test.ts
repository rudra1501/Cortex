/**
 * Unit & Integration tests for MarkdownReporter.ts
 *
 * Scope:
 * - MR-1: Executive scorecard comparison (Exp A vs Exp B metrics and deltas)
 * - MR-2: Ground-truth segregation (finalised vs provisional metrics)
 * - MR-3: Execution mode labeling (Live vs Candidate-Pool Replay vs Cached-Ranking Replay)
 * - MR-4: Win / Tie / Loss distribution rendering with win rate
 * - MR-5: Reranker telemetry breakdown (latency stats and fallback reasons)
 * - MR-6: All-provisional run graceful handling (0 finalised queries)
 * - MR-7: Null metric handling ("N/A", never "NaN" or "null")
 * - MR-8: Per-query detail table with status badges and telemetry
 * - Extra: Atomic file write to disk
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/MarkdownReporter.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  EvaluationRunResult,
  EvaluationQueryRecord,
  EvaluationScorecard,
  EvaluationRunConfig,
} from "../domain/EvaluationResult.js";
import {
  MarkdownReporter,
  formatDelta,
  formatNumber,
  formatPercent,
} from "../application/MarkdownReporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSampleRunConfig(): EvaluationRunConfig {
  return {
    runAt: "2026-11-04T12:00:00.000Z",
    datasetVersion: "1.0.0",
    mode: "pure-reranking",
    retrievalStrategy: "HYBRID",
    rrfK: 60,
    candidateK: 20,
    topK: 5,
    similarityThreshold: 0.3,
    embeddingModel: "gemini-embedding-001",
    rerankerModel: "gemini-3.5-flash-lite",
    rerankerTimeoutMs: 12000,
  };
}

function createSampleQueryRecord(overrides: Partial<EvaluationQueryRecord> = {}): EvaluationQueryRecord {
  const runConfig = createSampleRunConfig();

  return {
    queryId: "q_test_01",
    question: "What is similarity threshold in Cortex?",
    category: "core",
    runConfig,
    candidatePool: [],
    hasUnjudgedCandidates: false,
    incompletenessFlags: {
      unjudgedInEvalPool: false,
      incompleteSources: false,
      pendingReview: false,
    },
    candidateRecall20: {
      candidateRecall20Lenient: 0.85,
      candidateRecall20Strict: 0.75,
    },
    experimentA: {
      topKChunks: [],
      metrics: {
        recall5Lenient: 0.6,
        recall5Strict: 0.5,
        mrr5: 0.55,
        ndcg5: 0.62,
      },
      latencyMs: 0,
    },
    experimentB: {
      topKChunks: [],
      metrics: {
        recall5Lenient: 0.8,
        recall5Strict: 0.7,
        mrr5: 0.75,
        ndcg5: 0.78,
      },
      telemetry: {
        latencyMs: 160,
        status: "success",
        approxTokens: 60,
      },
    },
    deltas: {
      deltaRecall5Lenient: 0.2,
      deltaRecall5Strict: 0.2,
      deltaMrr5: 0.2,
      deltaNdcg5: 0.16,
    },
    ...overrides,
  };
}

function createSampleRunResult(
  queryRecords: EvaluationQueryRecord[],
  hasFinalisedMetrics = true,
): EvaluationRunResult {
  const runConfig = createSampleRunConfig();
  const finalisedCount = queryRecords.filter(
    (q) =>
      !q.incompletenessFlags.unjudgedInEvalPool &&
      !q.incompletenessFlags.incompleteSources &&
      !q.incompletenessFlags.pendingReview,
  ).length;

  const provisionalCount = queryRecords.length - finalisedCount;

  const aggregateMetrics = {
    experimentA: {
      candidateRecall20Lenient: { mean: 0.85, median: 0.85, count: queryRecords.length, excludedCount: 0 },
      candidateRecall20Strict: { mean: 0.75, median: 0.75, count: queryRecords.length, excludedCount: 0 },
      recall5Lenient: { mean: 0.6, median: 0.6, count: queryRecords.length, excludedCount: 0 },
      recall5Strict: { mean: 0.5, median: 0.5, count: queryRecords.length, excludedCount: 0 },
      mrr5: { mean: 0.55, median: 0.55, count: queryRecords.length, excludedCount: 0 },
      ndcg5: { mean: 0.62, median: 0.62, count: queryRecords.length, excludedCount: 0 },
    },
    experimentB: {
      candidateRecall20Lenient: { mean: 0.85, median: 0.85, count: queryRecords.length, excludedCount: 0 },
      candidateRecall20Strict: { mean: 0.75, median: 0.75, count: queryRecords.length, excludedCount: 0 },
      recall5Lenient: { mean: 0.8, median: 0.8, count: queryRecords.length, excludedCount: 0 },
      recall5Strict: { mean: 0.7, median: 0.7, count: queryRecords.length, excludedCount: 0 },
      mrr5: { mean: 0.75, median: 0.75, count: queryRecords.length, excludedCount: 0 },
      ndcg5: { mean: 0.78, median: 0.78, count: queryRecords.length, excludedCount: 0 },
    },
    deltas: {
      recall5Lenient: { mean: 0.2, median: 0.2, count: queryRecords.length, excludedCount: 0 },
      recall5Strict: { mean: 0.2, median: 0.2, count: queryRecords.length, excludedCount: 0 },
      mrr5: { mean: 0.2, median: 0.2, count: queryRecords.length, excludedCount: 0 },
      ndcg5: { mean: 0.16, median: 0.16, count: queryRecords.length, excludedCount: 0 },
      winTieLossNdcg: { wins: 1, ties: 0, losses: 0, excluded: 0 },
    },
  };

  const scorecard: EvaluationScorecard = {
    runConfig,
    querySummary: {
      total: queryRecords.length,
      finalised: finalisedCount,
      provisional: provisionalCount,
      excludedFromMetrics: 0,
    },
    finalisedMetrics: hasFinalisedMetrics && finalisedCount > 0 ? aggregateMetrics : undefined,
    allQueriesMetrics: aggregateMetrics,
    rerankerTelemetrySummary: {
      latencyMedianMs: 160,
      latencyMeanMs: 160,
      fallbackCount: 0,
      fallbackRate: 0,
      fallbackReasons: {},
    },
  };

  return {
    scorecard,
    queryRecords,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("MR-1: Executive Scorecard Comparison — compares Exp A vs Exp B metrics and deltas", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  // Checks table headers
  assert.ok(md.includes("Experiment A (HYBRID / RRF)"));
  assert.ok(md.includes("Experiment B (Gemini Reranker)"));
  assert.ok(md.includes("Delta (Exp B − Exp A)"));

  // Checks core metrics
  assert.ok(md.includes("Candidate Recall@20 (Lenient)"));
  assert.ok(md.includes("Candidate Recall@20 (Strict)"));
  assert.ok(md.includes("Recall@5 (Lenient)"));
  assert.ok(md.includes("Recall@5 (Strict)"));
  assert.ok(md.includes("MRR@5"));
  assert.ok(md.includes("nDCG@5"));

  // Checks delta rendering with bold positive indicator
  assert.ok(md.includes("**+0.1600**"));
});

test("MR-2: Ground-Truth Segregation — finalised metrics separated from provisional metrics", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  // Finalised section
  assert.ok(md.includes("Finalised Benchmark Scorecard (N = 1)"));

  // Provisional section carries warning banner
  assert.ok(md.includes("All-Queries Scorecard (Illustrative / Provisional) (N = 1)"));
  assert.ok(md.includes("> [!WARNING]"));
  assert.ok(md.includes("Do not use for production release gating."));
});

test("MR-3: Execution Mode Labeling — Live vs Candidate-Pool Replay vs Cached-Ranking Replay", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);
  const reporter = new MarkdownReporter();

  // Mode 1: Live
  const mdLive = reporter.generate(runResult, "live");
  assert.ok(mdLive.includes("🚀 **Live Evaluation**"));

  // Mode 2: Candidate-pool replay
  const mdPoolReplay = reporter.generate(runResult, "candidate-pool-replay");
  assert.ok(mdPoolReplay.includes("🔁 **Candidate-Pool Replay**"));
  assert.ok(mdPoolReplay.includes("skipping query embedding and database retrieval"));

  // Mode 3: Cached-ranking replay
  const mdCachedReplay = reporter.generate(runResult, "cached-ranking-replay");
  assert.ok(mdCachedReplay.includes("💾 **Cached-Ranking Replay**"));
  assert.ok(mdCachedReplay.includes("Zero Gemini API calls were made and zero tokens were consumed."));
});

test("MR-4: Win / Tie / Loss Distribution Rendering with Win Rate", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  assert.ok(md.includes("Win / Tie / Loss Distribution (nDCG@5)"));
  assert.ok(md.includes("- **Wins** (Reranker Improved): **1** (100.0%)"));
  assert.ok(md.includes("- **Ties** (Identical Quality): **0** (0.0%)"));
  assert.ok(md.includes("- **Losses** (Reranker Regressed): **0** (0.0%)"));
});

test("MR-5: Reranker Telemetry Breakdown — latency stats and fallback reasons", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  // Inject fallback in telemetry
  const resultWithFallback: EvaluationRunResult = {
    ...runResult,
    scorecard: {
      ...runResult.scorecard,
      rerankerTelemetrySummary: {
        latencyMedianMs: 160,
        latencyMeanMs: 165,
        fallbackCount: 1,
        fallbackRate: 0.5,
        fallbackReasons: { timeout: 1 },
      },
    },
  };

  const reporter = new MarkdownReporter();
  const md = reporter.generate(resultWithFallback);

  assert.ok(md.includes("## Reranker Performance & Telemetry"));
  assert.ok(md.includes("| **Median Latency** | 160 ms |"));
  assert.ok(md.includes("| **Mean Latency** | 165 ms |"));
  assert.ok(md.includes("| **Fallback Count** | 1 (50.0%) |"));
  assert.ok(md.includes("`timeout`: 1"));
});

test("MR-6: All-Provisional Run Graceful Handling — 0 finalised queries", () => {
  const provisionalRecord = createSampleQueryRecord({
    incompletenessFlags: {
      unjudgedInEvalPool: true,
      incompleteSources: false,
      pendingReview: false,
    },
  });

  const runResult = createSampleRunResult([provisionalRecord], false);
  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  // Must not throw, and displays prominent alert
  assert.ok(md.includes("> [!IMPORTANT]"));
  assert.ok(md.includes("> **No Finalised Queries**"));
});

test("MR-7: Null Metric Handling — renders 'N/A', never 'NaN' or 'null'", () => {
  // Test formatting functions directly
  assert.equal(formatNumber(null), "N/A");
  assert.equal(formatNumber(undefined), "N/A");
  assert.equal(formatNumber(NaN), "N/A");
  assert.equal(formatNumber(0.12345), "0.1235");

  assert.equal(formatDelta(null), "N/A");
  assert.equal(formatDelta(undefined), "N/A");
  assert.equal(formatDelta(NaN), "N/A");
  assert.equal(formatDelta(0.0), "0.0000");

  assert.equal(formatPercent(null), "N/A");
  assert.equal(formatPercent(undefined), "N/A");
  assert.equal(formatPercent(0.75), "75.0%");

  // Test inside rendered report
  const nullQuery = createSampleQueryRecord({
    experimentA: {
      topKChunks: [],
      metrics: { recall5Lenient: null, recall5Strict: null, mrr5: null, ndcg5: null },
      latencyMs: 0,
    },
    experimentB: {
      topKChunks: [],
      metrics: { recall5Lenient: null, recall5Strict: null, mrr5: null, ndcg5: null },
      telemetry: { latencyMs: 0, status: "skipped" },
    },
    deltas: { deltaRecall5Lenient: null, deltaRecall5Strict: null, deltaMrr5: null, deltaNdcg5: null },
  });

  const runResult = createSampleRunResult([nullQuery]);
  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  assert.ok(!md.includes("NaN"));
  assert.ok(!md.includes("null"));
  assert.ok(md.includes("N/A"));
});

test("MR-8: Per-Query Detail Table with Status Badges & Telemetry", () => {
  const finalisedRecord = createSampleQueryRecord({
    queryId: "q_fin",
    question: "Finalised question text",
    incompletenessFlags: { unjudgedInEvalPool: false, incompleteSources: false, pendingReview: false },
  });

  const provisionalRecord = createSampleQueryRecord({
    queryId: "q_prov",
    question: "Provisional question text",
    incompletenessFlags: { unjudgedInEvalPool: true, incompleteSources: false, pendingReview: false },
  });

  const runResult = createSampleRunResult([finalisedRecord, provisionalRecord]);
  const reporter = new MarkdownReporter();
  const md = reporter.generate(runResult);

  assert.ok(md.includes("## Per-Query Results"));
  assert.ok(md.includes("| `q_fin` | Finalised question text | core | ✅ Finalised |"));
  assert.ok(md.includes("| `q_prov` | Provisional question text | core | ⚠️ Provisional |"));
});

test("MR-Extra: Atomic File Write to Disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-md-reporter-test-"));
  const targetFile = path.join(tmpDir, "reports", "scorecard.md");

  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new MarkdownReporter();
  const resolvedPath = await reporter.writeReport(runResult, targetFile);

  assert.equal(resolvedPath, path.resolve(targetFile));

  const content = await fs.readFile(targetFile, "utf-8");
  assert.ok(content.startsWith("# Retrieval Quality Evaluation Report"));

  // Check no leftover temp files
  const files = await fs.readdir(path.join(tmpDir, "reports"));
  assert.deepEqual(files, ["scorecard.md"]);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
