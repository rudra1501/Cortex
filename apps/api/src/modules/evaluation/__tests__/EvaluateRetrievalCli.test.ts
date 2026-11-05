/**
 * Unit & Integration tests for evaluate-retrieval.ts CLI
 *
 * Scope:
 * - CLI-1: --help flag exits 0 with usage instructions
 * - CLI-2: Missing --dataset argument exits 1
 * - CLI-3: Missing --user-id in live mode exits 1
 * - CLI-4: Conflicting cache flags rejection (record + replay, etc.)
 * - CLI-5: Invalid similarity threshold rejection (<0, >1, NaN)
 * - CLI-6: candidateK < topK rejection
 * - CLI-7: --dry-run validates locally without database or Gemini connection
 * - CLI-8: Cached-ranking replay runs end-to-end with zero Gemini calls and writes reports
 * - CLI-9: Historical replay labeling in markdown report
 * - CLI-10: Incompatible cache snapshot exits with code 2
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/EvaluateRetrievalCli.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "../../retrieval/application/RetrievalStrategy.js";
import type { EvaluatorReranker } from "../application/EvaluationRunner.js";
import {
  computeCandidatePoolFingerprint,
  computeCorpusFingerprint,
  computeDatasetFingerprint,
  computeQueryFingerprint,
  loadCache,
  saveCache,
  toCachedCandidateChunk,
  type CandidatePoolCacheData,
} from "../infrastructure/CandidatePoolCache.js";
import {
  runEvaluationCli,
  validateEvaluationCliArgs,
} from "../cli/evaluate-retrieval.js";
import { parseEvaluationDatasetJson } from "../domain/EvaluationDataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DATASET_PATH = path.resolve(
  __dirname,
  "../datasets/sample-eval-dataset.json",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChunk(id: string, similarity: number = 0.9): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc_placeholder_spec`,
    documentTitle: `Spec Document`,
    chunkIndex: 0,
    content: `Content passage for chunk ${id}.`,
    similarity,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("CLI-1: --help flag prints usage and exits with code 0", async () => {
  const exitCode = await runEvaluationCli(["--help"]);
  assert.equal(exitCode, 0);
});

test("CLI-2: Missing --dataset argument is rejected with code 1", async () => {
  const validation = validateEvaluationCliArgs({});
  assert.equal(validation.valid, false);
  if (!validation.valid) {
    assert.match(validation.errors[0] ?? "", /Missing required argument: --dataset/);
  }

  const exitCode = await runEvaluationCli([]);
  assert.equal(exitCode, 1);
});

test("CLI-3: Missing --user-id in live mode is rejected with code 1", async () => {
  const validation = validateEvaluationCliArgs({ dataset: SAMPLE_DATASET_PATH });
  assert.equal(validation.valid, false);
  if (!validation.valid) {
    assert.match(validation.errors[0] ?? "", /Missing required argument: --user-id/);
  }

  const exitCode = await runEvaluationCli(["--dataset", SAMPLE_DATASET_PATH]);
  assert.equal(exitCode, 1);
});

test("CLI-4: Conflicting cache flags are rejected", () => {
  // 1. record-cache + replay-cache
  const res1 = validateEvaluationCliArgs({
    dataset: "ds.json",
    "user-id": "u1",
    "record-cache": "cache1.json",
    "replay-cache": "cache2.json",
  });
  assert.equal(res1.valid, false);
  if (!res1.valid) {
    assert.match(res1.errors[0] ?? "", /mutually exclusive/);
  }

  // 2. replay-cache + cached-ranking-replay
  const res2 = validateEvaluationCliArgs({
    dataset: "ds.json",
    "replay-cache": "cache1.json",
    "cached-ranking-replay": "cache2.json",
  });
  assert.equal(res2.valid, false);

  // 3. record-cache + cached-ranking-replay
  const res3 = validateEvaluationCliArgs({
    dataset: "ds.json",
    "record-cache": "cache1.json",
    "cached-ranking-replay": "cache2.json",
  });
  assert.equal(res3.valid, false);
});

test("CLI-5: Invalid similarity threshold values are rejected", () => {
  const checkInvalid = (val: string) => {
    const res = validateEvaluationCliArgs({
      dataset: "ds.json",
      "user-id": "u1",
      "similarity-threshold": val,
    });
    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.match(res.errors[0] ?? "", /Invalid --similarity-threshold/);
    }
  };

  checkInvalid("-0.1");
  checkInvalid("1.5");
  checkInvalid("NaN");
  checkInvalid("Infinity");
  checkInvalid("not_a_number");
});

test("CLI-6: candidateK < topK is rejected", () => {
  const res = validateEvaluationCliArgs({
    dataset: "ds.json",
    "user-id": "u1",
    "candidate-k": "3",
    "top-k": "5",
  });

  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.match(res.errors[0] ?? "", /cannot be smaller than topK/);
  }
});

test("CLI-7: --dry-run validates locally without database or Gemini connection", async () => {
  const exitCode = await runEvaluationCli([
    "--dataset",
    SAMPLE_DATASET_PATH,
    "--dry-run",
  ]);

  assert.equal(exitCode, 0);
});

test("CLI-8: Cached-ranking replay runs end-to-end with zero Gemini calls and writes reports", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-cli-test-"));
  const cachePath = path.join(tmpDir, "replay_cache.json");
  const jsonOut = path.join(tmpDir, "report.json");
  const mdOut = path.join(tmpDir, "scorecard.md");

  // Load sample dataset to build a conforming cache
  const datasetContent = await fs.readFile(SAMPLE_DATASET_PATH, "utf-8");
  const dataset = parseEvaluationDatasetJson(datasetContent);

  const pools: CandidatePoolCacheData["pools"] = dataset.queries.map((q) => {
    const c1 = createMockChunk(`c_${q.id}_1`, 0.032);
    const c2 = createMockChunk(`c_${q.id}_2`, 0.016);
    return {
      queryId: q.id,
      queryFingerprint: computeQueryFingerprint(q.question),
      chunks: [
        toCachedCandidateChunk(c1, 1, "HYBRID"),
        toCachedCandidateChunk(c2, 2, "HYBRID"),
      ],
      recordedRerank: {
        chunks: [
          toCachedCandidateChunk(c2, 1, "HYBRID"),
          toCachedCandidateChunk(c1, 2, "HYBRID"),
        ],
        telemetry: {
          latencyMs: 140,
          status: "success",
          approxTokens: 80,
        },
      },
    };
  });

  const cacheData: CandidatePoolCacheData = {
    header: {
      cacheVersion: "1.1.0",
      datasetVersion: dataset.version,
      datasetFingerprint: computeDatasetFingerprint(dataset),
      corpusFingerprint: computeCorpusFingerprint(["doc_placeholder_spec"]),
      candidatePoolFingerprint: computeCandidatePoolFingerprint(pools),
      retrievalStrategy: "HYBRID",
      rrfK: 60,
      candidateK: 2,
      similarityThreshold: 0.3,
      embeddingModel: "gemini-embedding-001",
      rerankerModel: "gemini-3.5-flash-lite",
      rerankerPromptVersion: "gemini-rerank-v1",
      recordedAt: new Date().toISOString(),
      queryCount: pools.length,
    },
    pools,
  };

  await saveCache(cachePath, cacheData);

  const exitCode = await runEvaluationCli([
    "--dataset",
    SAMPLE_DATASET_PATH,
    "--cached-ranking-replay",
    cachePath,
    "--candidate-k",
    "2",
    "--top-k",
    "2",
    "--output-json",
    jsonOut,
    "--output-md",
    mdOut,
    "--quiet",
  ]);

  assert.equal(exitCode, 0);

  // Verify reports were generated
  const jsonReport = JSON.parse(await fs.readFile(jsonOut, "utf-8"));
  assert.equal(jsonReport.schemaVersion, "1.0.0");
  assert.equal(jsonReport.executionMode, "cached-ranking-replay");
  assert.equal(jsonReport.queries.length, dataset.queries.length);

  const mdReport = await fs.readFile(mdOut, "utf-8");
  assert.ok(mdReport.includes("Cached-Ranking Replay"));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-9: Historical replay labeling in markdown report isolates historical latency", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-cli-label-"));
  const cachePath = path.join(tmpDir, "replay_cache.json");
  const mdOut = path.join(tmpDir, "scorecard.md");

  const datasetContent = await fs.readFile(SAMPLE_DATASET_PATH, "utf-8");
  const dataset = parseEvaluationDatasetJson(datasetContent);

  const pools: CandidatePoolCacheData["pools"] = dataset.queries.map((q) => {
    const c1 = createMockChunk(`c_${q.id}_1`, 0.032);
    return {
      queryId: q.id,
      queryFingerprint: computeQueryFingerprint(q.question),
      chunks: [toCachedCandidateChunk(c1, 1, "HYBRID")],
      recordedRerank: {
        chunks: [toCachedCandidateChunk(c1, 1, "HYBRID")],
        telemetry: { latencyMs: 155, status: "success" },
      },
    };
  });

  const cacheData: CandidatePoolCacheData = {
    header: {
      cacheVersion: "1.1.0",
      datasetVersion: dataset.version,
      datasetFingerprint: computeDatasetFingerprint(dataset),
      corpusFingerprint: computeCorpusFingerprint(["doc_placeholder_spec"]),
      retrievalStrategy: "HYBRID",
      rrfK: 60,
      candidateK: 1,
      similarityThreshold: 0.3,
      embeddingModel: "gemini-embedding-001",
      rerankerModel: "gemini-3.5-flash-lite",
      rerankerPromptVersion: "gemini-rerank-v1",
      recordedAt: new Date().toISOString(),
      queryCount: pools.length,
    },
    pools,
  };

  await saveCache(cachePath, cacheData);

  const exitCode = await runEvaluationCli([
    "--dataset",
    SAMPLE_DATASET_PATH,
    "--cached-ranking-replay",
    cachePath,
    "--candidate-k",
    "1",
    "--top-k",
    "1",
    "--output-md",
    mdOut,
    "--quiet",
  ]);

  assert.equal(exitCode, 0);

  const mdReport = await fs.readFile(mdOut, "utf-8");
  assert.ok(mdReport.includes("💾 **Cached-Ranking Replay**"));
  assert.ok(mdReport.includes("Zero Gemini API calls were made and zero tokens were consumed."));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-10: Incompatible cache snapshot exits with code 2", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-incompat-"));
  const cachePath = path.join(tmpDir, "incompat_cache.json");

  // Create cache with WRONG dataset fingerprint
  const cacheData: CandidatePoolCacheData = {
    header: {
      cacheVersion: "1.1.0",
      datasetVersion: "0.9.0-old", // Mismatched version
      datasetFingerprint: "wrong_fp",
      corpusFingerprint: "corpus_fp",
      retrievalStrategy: "HYBRID",
      rrfK: 60,
      candidateK: 20,
      similarityThreshold: 0.3,
      embeddingModel: "gemini-embedding-001",
      recordedAt: new Date().toISOString(),
      queryCount: 1,
    },
    pools: [],
  };

  await saveCache(cachePath, cacheData);

  const exitCode = await runEvaluationCli([
    "--dataset",
    SAMPLE_DATASET_PATH,
    "--cached-ranking-replay",
    cachePath,
    "--quiet",
  ]);

  // Code 2 is the designated exit code for CacheIncompatibilityError
  assert.equal(exitCode, 2);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-11: Prisma snapshot failure prevents cache creation and exits non-zero", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-fail-closed-"));
  const cachePath = path.join(tmpDir, "should_not_exist.json");

  const exitCode = await runEvaluationCli(
    [
      "--dataset",
      SAMPLE_DATASET_PATH,
      "--user-id",
      "test_user",
      "--similarity-threshold",
      "0.3",
      "--record-cache",
      cachePath,
      "--quiet",
    ],
    {
      embedQuery: { async execute() { return [0.1]; } },
      retrievalStrategy: { async execute() { return [createMockChunk("c1")]; } },
      reranker: {
        async rerank(q, c) { return c; },
        async rerankWithTelemetry(q, c) {
          return { chunks: c, telemetry: { latencyMs: 5, status: "success" } };
        },
      },
      configRepository: { async findByUserId() { return { similarityThreshold: 0.3 }; } },
      prismaClient: {
        document: {
          async findMany() {
            throw new Error("P1001: Can't reach database server at db.internal:5432");
          },
        },
      },
    },
  );

  assert.equal(exitCode, 1);

  // Verify that the cache file was NEVER created
  await assert.rejects(async () => fs.access(cachePath));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-12: An empty successful corpus snapshot is handled explicitly when candidate chunks are empty", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-empty-corpus-"));
  const cachePath = path.join(tmpDir, "empty_corpus_cache.json");

  const exitCode = await runEvaluationCli(
    [
      "--dataset",
      SAMPLE_DATASET_PATH,
      "--user-id",
      "test_user",
      "--similarity-threshold",
      "0.3",
      "--record-cache",
      cachePath,
      "--quiet",
    ],
    {
      embedQuery: { async execute() { return [0.1]; } },
      retrievalStrategy: { async execute() { return []; } },
      reranker: {
        async rerank(q, c) { return c; },
        async rerankWithTelemetry(q, c) {
          return { chunks: c, telemetry: { latencyMs: 0, status: "skipped" } };
        },
      },
      configRepository: { async findByUserId() { return { similarityThreshold: 0.3 }; } },
      prismaClient: {
        document: {
          async findMany() {
            return []; // Successfully returned 0 ready documents
          },
        },
      },
    },
  );

  assert.equal(exitCode, 0);

  // Verify cache exists and has the empty corpus fingerprint
  const cache = await loadCache(cachePath);
  assert.equal(cache.header.cacheVersion, "1.1.0");
  assert.equal(cache.header.corpusFingerprint, computeCorpusFingerprint([]));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-13: An empty corpus with retrieved candidate chunks referencing missing documents is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-inconsistent-"));
  const cachePath = path.join(tmpDir, "should_not_exist.json");

  const exitCode = await runEvaluationCli(
    [
      "--dataset",
      SAMPLE_DATASET_PATH,
      "--user-id",
      "test_user",
      "--similarity-threshold",
      "0.3",
      "--record-cache",
      cachePath,
      "--quiet",
    ],
    {
      embedQuery: { async execute() { return [0.1]; } },
      retrievalStrategy: { async execute() { return [createMockChunk("c1")]; } }, // references doc_placeholder_spec
      reranker: {
        async rerank(q, c) { return c; },
        async rerankWithTelemetry(q, c) {
          return { chunks: c, telemetry: { latencyMs: 5, status: "success" } };
        },
      },
      configRepository: { async findByUserId() { return { similarityThreshold: 0.3 }; } },
      corpusSnapshot: [], // explicitly empty: doc_placeholder_spec is absent!
    },
  );

  assert.equal(exitCode, 1);

  // Verify that the cache file was NEVER created
  await assert.rejects(async () => fs.access(cachePath));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-14: An explicitly injected empty corpus snapshot is not mistaken for an absent dependency", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-explicit-empty-"));
  const cachePath = path.join(tmpDir, "explicit_empty.json");

  let prismaCalled = false;

  const exitCode = await runEvaluationCli(
    [
      "--dataset",
      SAMPLE_DATASET_PATH,
      "--user-id",
      "test_user",
      "--similarity-threshold",
      "0.3",
      "--record-cache",
      cachePath,
      "--quiet",
    ],
    {
      embedQuery: { async execute() { return [0.1]; } },
      retrievalStrategy: { async execute() { return []; } },
      reranker: {
        async rerank(q, c) { return c; },
        async rerankWithTelemetry(q, c) {
          return { chunks: c, telemetry: { latencyMs: 0, status: "skipped" } };
        },
      },
      configRepository: { async findByUserId() { return { similarityThreshold: 0.3 }; } },
      corpusSnapshot: [], // explicitly provided empty snapshot
      prismaClient: {
        document: {
          async findMany() {
            prismaCalled = true;
            throw new Error("Should not be called when corpusSnapshot is provided!");
          },
        },
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(prismaCalled, false);

  const cache = await loadCache(cachePath);
  assert.equal(cache.header.corpusFingerprint, computeCorpusFingerprint([]));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("CLI-15: A successful complete snapshot produces a valid cache v1.1.0", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-eval-complete-snap-"));
  const cachePath = path.join(tmpDir, "complete_cache.json");

  const completeSnapshot = [
    {
      id: "doc_placeholder_spec",
      updatedAt: new Date("2026-01-01T12:00:00Z"),
      processedAt: new Date("2026-01-01T12:05:00Z"),
      chunks: [
        { id: "c1", chunkIndex: 0, content: "Passage 1 content" },
        { id: "c2", chunkIndex: 1, content: "Passage 2 content" },
      ],
    },
  ];

  const exitCode = await runEvaluationCli(
    [
      "--dataset",
      SAMPLE_DATASET_PATH,
      "--user-id",
      "test_user",
      "--similarity-threshold",
      "0.3",
      "--record-cache",
      cachePath,
      "--quiet",
    ],
    {
      embedQuery: { async execute() { return [0.1]; } },
      retrievalStrategy: { async execute() { return [createMockChunk("c1")]; } },
      reranker: {
        async rerank(q, c) { return c; },
        async rerankWithTelemetry(q, c) {
          return { chunks: c, telemetry: { latencyMs: 25, status: "success" } };
        },
      },
      configRepository: { async findByUserId() { return { similarityThreshold: 0.3 }; } },
      prismaClient: {
        document: {
          async findMany() {
            return completeSnapshot;
          },
        },
      },
    },
  );

  assert.equal(exitCode, 0);

  const cache = await loadCache(cachePath);
  assert.equal(cache.header.cacheVersion, "1.1.0");
  assert.equal(cache.header.corpusFingerprint, computeCorpusFingerprint(completeSnapshot));
  assert.equal(cache.pools.length, 6);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
