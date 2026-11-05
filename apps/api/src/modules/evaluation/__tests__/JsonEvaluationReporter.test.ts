/**
 * Unit & Integration tests for JsonEvaluationReporter.ts
 *
 * Scope:
 * - JR-1: Schema conformance & versioning (Zod validated)
 * - JR-2: Full fidelity preservation of runConfig, metrics, deltas, telemetry
 * - JR-3: Credential, user ID, and document content redaction
 * - JR-4: Provisional vs finalised query flagging (isFinalised boolean)
 * - JR-5: Null metric value preservation in serialization
 * - JR-6: Atomic file write to disk
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/JsonEvaluationReporter.test.ts
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
  JsonEvaluationReporter,
  jsonEvaluationReportSchema,
} from "../application/JsonEvaluationReporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSampleRunConfig(): EvaluationRunConfig {
  return {
    runAt: new Date().toISOString(),
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
    queryId: "q_sample_01",
    question: "How does similarity thresholding work?",
    category: "core",
    runConfig,
    candidatePool: [
      {
        chunkId: "c1",
        documentId: "doc_1",
        documentTitle: "Doc 1",
        chunkIndex: 0,
        rrfRank: 1,
        rrfScore: 0.016,
        judgment: {
          status: "judged",
          relevance: 2,
          matchType: "exact_id",
        },
      },
    ],
    hasUnjudgedCandidates: false,
    incompletenessFlags: {
      unjudgedInEvalPool: false,
      incompleteSources: false,
      pendingReview: false,
    },
    candidateRecall20: {
      candidateRecall20Lenient: 1.0,
      candidateRecall20Strict: 1.0,
    },
    experimentA: {
      topKChunks: [
        {
          chunkId: "c1",
          rank: 1,
          score: 0.016,
          judgment: {
            status: "judged",
            relevance: 2,
            matchType: "exact_id",
          },
        },
      ],
      metrics: {
        recall5Lenient: 1.0,
        recall5Strict: 1.0,
        mrr5: 1.0,
        ndcg5: 1.0,
      },
      latencyMs: 0,
    },
    experimentB: {
      topKChunks: [
        {
          chunkId: "c1",
          rank: 1,
          originalRrfRank: 1,
          score: 0.95,
          judgment: {
            status: "judged",
            relevance: 2,
            matchType: "exact_id",
          },
        },
      ],
      metrics: {
        recall5Lenient: 1.0,
        recall5Strict: 1.0,
        mrr5: 1.0,
        ndcg5: 1.0,
      },
      telemetry: {
        latencyMs: 145,
        status: "success",
        approxTokens: 55,
      },
    },
    deltas: {
      deltaRecall5Lenient: 0,
      deltaRecall5Strict: 0,
      deltaMrr5: 0,
      deltaNdcg5: 0,
    },
    ...overrides,
  };
}

function createSampleRunResult(queryRecords: EvaluationQueryRecord[]): EvaluationRunResult {
  const runConfig = createSampleRunConfig();

  const scorecard: EvaluationScorecard = {
    runConfig,
    querySummary: {
      total: queryRecords.length,
      finalised: queryRecords.filter(
        (q) =>
          !q.incompletenessFlags.unjudgedInEvalPool &&
          !q.incompletenessFlags.incompleteSources &&
          !q.incompletenessFlags.pendingReview,
      ).length,
      provisional: queryRecords.filter(
        (q) =>
          q.incompletenessFlags.unjudgedInEvalPool ||
          q.incompletenessFlags.incompleteSources ||
          q.incompletenessFlags.pendingReview,
      ).length,
      excludedFromMetrics: 0,
    },
    allQueriesMetrics: {
      experimentA: {
        candidateRecall20Lenient: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        candidateRecall20Strict: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        recall5Lenient: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        recall5Strict: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        mrr5: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        ndcg5: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
      },
      experimentB: {
        candidateRecall20Lenient: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        candidateRecall20Strict: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        recall5Lenient: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        recall5Strict: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        mrr5: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
        ndcg5: { mean: 1.0, median: 1.0, count: 1, excludedCount: 0 },
      },
      deltas: {
        recall5Lenient: { mean: 0, median: 0, count: 1, excludedCount: 0 },
        recall5Strict: { mean: 0, median: 0, count: 1, excludedCount: 0 },
        mrr5: { mean: 0, median: 0, count: 1, excludedCount: 0 },
        ndcg5: { mean: 0, median: 0, count: 1, excludedCount: 0 },
        winTieLossNdcg: { wins: 0, ties: 1, losses: 0, excluded: 0 },
      },
    },
    rerankerTelemetrySummary: {
      latencyMedianMs: 145,
      latencyMeanMs: 145,
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

test("JR-1: Schema Conformance & Versioning — valid output conforms to schemaVersion 1.0.0", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new JsonEvaluationReporter();
  const report = reporter.generate(runResult);

  assert.equal(report.schemaVersion, "1.0.0");
  assert.ok(report.reportId.startsWith("eval_report_"));
  assert.equal(report.executionMode, "live");

  // Validate with Zod schema
  const validated = jsonEvaluationReportSchema.parse(report);
  assert.equal(validated.schemaVersion, "1.0.0");
});

test("JR-2: Full Fidelity Preservation of runConfig, metrics, deltas, and telemetry", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new JsonEvaluationReporter();
  const serialized = reporter.serialize(runResult);
  const parsed = JSON.parse(serialized);

  // Assert preservation of run config
  assert.equal(parsed.runConfig.similarityThreshold, 0.3);
  assert.equal(parsed.runConfig.retrievalStrategy, "HYBRID");
  assert.equal(parsed.runConfig.rrfK, 60);

  // Assert preservation of query metrics
  assert.equal(parsed.queries[0].experimentB.metrics.ndcg5, 1.0);
  assert.equal(parsed.queries[0].experimentB.telemetry.latencyMs, 145);
  assert.equal(parsed.queries[0].experimentB.telemetry.approxTokens, 55);

  // Assert preservation of deltas
  assert.equal(parsed.queries[0].deltas.deltaNdcg5, 0);
});

test("JR-3: Credential, User ID, and Document Content Redaction", () => {
  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new JsonEvaluationReporter();
  const serialized = reporter.serialize(runResult);

  // Must not leak userId or sensitive auth variables
  assert.ok(!serialized.includes("userId"));
  assert.ok(!serialized.includes("apiKey"));
  assert.ok(!serialized.includes("password"));
  assert.ok(!serialized.includes("authorization"));

  // Reports preserve chunk metadata, but do NOT dump whole passage content
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.queries[0].experimentA.topKChunks[0].content, undefined);
  assert.equal(parsed.queries[0].experimentB.topKChunks[0].content, undefined);
});

test("JR-4: Provisional vs Finalised Query Flagging (isFinalised boolean)", () => {
  const finalisedRecord = createSampleQueryRecord({
    queryId: "q_fin",
    incompletenessFlags: {
      unjudgedInEvalPool: false,
      incompleteSources: false,
      pendingReview: false,
    },
  });

  const provisionalRecord = createSampleQueryRecord({
    queryId: "q_prov",
    incompletenessFlags: {
      unjudgedInEvalPool: true,
      incompleteSources: false,
      pendingReview: false,
    },
  });

  const runResult = createSampleRunResult([finalisedRecord, provisionalRecord]);
  const reporter = new JsonEvaluationReporter();
  const report = reporter.generate(runResult);

  assert.equal(report.queries[0]?.queryId, "q_fin");
  assert.equal(report.queries[0]?.isFinalised, true);

  assert.equal(report.queries[1]?.queryId, "q_prov");
  assert.equal(report.queries[1]?.isFinalised, false);
});

test("JR-5: Null Metric Value Preservation in Serialization", () => {
  const record = createSampleQueryRecord({
    experimentA: {
      topKChunks: [],
      metrics: {
        recall5Lenient: null,
        recall5Strict: null,
        mrr5: null,
        ndcg5: null,
      },
      latencyMs: 0,
    },
    experimentB: {
      topKChunks: [],
      metrics: {
        recall5Lenient: null,
        recall5Strict: null,
        mrr5: null,
        ndcg5: null,
      },
      telemetry: {
        latencyMs: 0,
        status: "skipped",
      },
    },
    deltas: {
      deltaRecall5Lenient: null,
      deltaRecall5Strict: null,
      deltaMrr5: null,
      deltaNdcg5: null,
    },
  });

  const runResult = createSampleRunResult([record]);
  const reporter = new JsonEvaluationReporter();
  const serialized = reporter.serialize(runResult);
  const parsed = JSON.parse(serialized);

  // Nulls must be preserved as null, not converted to 0 or dropped
  assert.equal(parsed.queries[0].experimentA.metrics.recall5Lenient, null);
  assert.equal(parsed.queries[0].experimentA.metrics.ndcg5, null);
  assert.equal(parsed.queries[0].deltas.deltaNdcg5, null);
});

test("JR-6: Atomic File Write to Disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-json-reporter-test-"));
  const targetFile = path.join(tmpDir, "nested", "run_report.json");

  const record = createSampleQueryRecord();
  const runResult = createSampleRunResult([record]);

  const reporter = new JsonEvaluationReporter();
  const resolvedPath = await reporter.writeReport(runResult, targetFile, {
    executionMode: "candidate-pool-replay",
  });

  assert.equal(resolvedPath, path.resolve(targetFile));

  const content = await fs.readFile(targetFile, "utf-8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.schemaVersion, "1.0.0");
  assert.equal(parsed.executionMode, "candidate-pool-replay");

  // Verify no dangling temporary files
  const files = await fs.readdir(path.join(tmpDir, "nested"));
  assert.deepEqual(files, ["run_report.json"]);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
