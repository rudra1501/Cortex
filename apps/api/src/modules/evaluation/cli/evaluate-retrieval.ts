/**
 * evaluate-retrieval.ts — offline evaluation CLI runner for Cortex Information Retrieval.
 *
 * Supported Modes:
 * 1. Live Evaluation:
 *    Connects to PostgreSQL, embeds queries with Gemini, retrieves candidates,
 *    and runs Gemini reranker live.
 *    Optional: --record-cache <path> captures candidate pools and reranker outputs.
 * 2. Candidate-Pool Replay:
 *    --replay-cache <path>
 *    Replays candidate pools from cache (skips embedding & PostgreSQL retrieval);
 *    calls Gemini reranker live (consumes Gemini tokens).
 * 3. Cached-Ranking Replay:
 *    --cached-ranking-replay <path>
 *    Replays candidate pools AND recorded Gemini reranker outputs from cache;
 *    zero Gemini calls, zero tokens consumed, zero database queries.
 * 4. Dry Run:
 *    --dry-run
 *    Validates CLI arguments and dataset schema locally without network/DB calls.
 *
 * Usage:
 *   npx tsx src/modules/evaluation/cli/evaluate-retrieval.ts [options]
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "../../retrieval/application/RetrievalStrategy.js";
import type { GeminiRerankResult } from "../../retrieval/application/GeminiReranker.js";
import type { EvaluationDataset } from "../domain/EvaluationDataset.js";
import { parseEvaluationDatasetJson } from "../domain/EvaluationDataset.js";
import {
  EvaluationRunner,
  type EvaluatorReranker,
} from "../application/EvaluationRunner.js";
import { JsonEvaluationReporter } from "../application/JsonEvaluationReporter.js";
import { MarkdownReporter } from "../application/MarkdownReporter.js";
import {
  computeCandidatePoolFingerprint,
  computeCorpusFingerprint,
  computeDatasetFingerprint,
  computeQueryFingerprint,
  loadCache,
  parseEvalQueryId,
  saveCache,
  toCachedCandidateChunk,
  validateCacheCompatibility,
  CacheIncompatibilityError,
  ReplayReranker,
  ReplayRetrievalStrategy,
  type CachedQueryPool,
  type CandidatePoolCacheData,
  type CorpusFingerprintItem,
} from "../infrastructure/CandidatePoolCache.js";

// ---------------------------------------------------------------------------
// Recording Test Doubles for Live Cache Capture
// ---------------------------------------------------------------------------

export class RecordingRetrievalStrategy implements RetrievalStrategy {
  public readonly recordedPools = new Map<string, readonly RetrievedChunk[]>();

  constructor(
    private readonly inner: RetrievalStrategy,
    private readonly queryIdExtractor: (requestId?: string) => string | null = parseEvalQueryId,
  ) {}

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    const chunks = await this.inner.execute(input);
    const queryId = this.queryIdExtractor(input.requestId);
    if (queryId) {
      this.recordedPools.set(queryId, chunks.map((c) => ({ ...c })));
    }
    return chunks;
  }
}

export class RecordingReranker implements EvaluatorReranker {
  public readonly recordedReranked = new Map<string, GeminiRerankResult>();

  constructor(
    private readonly inner: EvaluatorReranker,
    private readonly queryIdExtractor: (requestId?: string) => string | null = parseEvalQueryId,
  ) {}

  async rerankWithTelemetry(
    query: string,
    candidates: RetrievedChunk[],
    requestId?: string,
  ): Promise<GeminiRerankResult> {
    const res = this.inner.rerankWithTelemetry
      ? await this.inner.rerankWithTelemetry(query, candidates, requestId)
      : {
          chunks: await this.inner.rerank(query, candidates, requestId),
          telemetry: { latencyMs: 0, status: "success" as const },
        };

    const queryId = this.queryIdExtractor(requestId);
    if (queryId) {
      this.recordedReranked.set(queryId, res);
    }
    return res;
  }

  async rerank(
    query: string,
    candidates: RetrievedChunk[],
    requestId?: string,
  ): Promise<RetrievedChunk[]> {
    const res = await this.rerankWithTelemetry(query, candidates, requestId);
    return res.chunks;
  }
}

// ---------------------------------------------------------------------------
// Pre-Flight CLI Argument Validation
// ---------------------------------------------------------------------------

export interface EvaluateCliParsedValues {
  dataset?: string | undefined;
  "user-id"?: string | undefined;
  "similarity-threshold"?: string | undefined;
  "candidate-k"?: string | undefined;
  "top-k"?: string | undefined;
  strategy?: string | undefined;
  "output-dir"?: string | undefined;
  "output-json"?: string | undefined;
  "output-md"?: string | undefined;
  "record-cache"?: string | undefined;
  "replay-cache"?: string | undefined;
  "cached-ranking-replay"?: string | undefined;
  "dry-run"?: boolean | undefined;
  quiet?: boolean | undefined;
  help?: boolean | undefined;
}

export function validateEvaluationCliArgs(values: EvaluateCliParsedValues): {
  valid: true;
  candidateK: number;
  topK: number;
  similarityThreshold?: number | undefined;
  strategy: "HYBRID" | "VECTOR" | "FTS";
} | { valid: false; errors: string[] } {
  const errors: string[] = [];

  // 1. Required dataset
  if (!values.dataset) {
    errors.push("Missing required argument: --dataset <path>");
  }

  // 2. Conflicting cache modes
  const cacheModeCount = [
    Boolean(values["record-cache"]),
    Boolean(values["replay-cache"]),
    Boolean(values["cached-ranking-replay"]),
  ].filter(Boolean).length;

  if (cacheModeCount > 1) {
    errors.push(
      "Conflicting cache modes: --record-cache, --replay-cache, and --cached-ranking-replay are mutually exclusive.",
    );
  }

  // 3. User ID requirement (not required for cached-ranking-replay or dry-run)
  const isOfflineReplay = Boolean(values["cached-ranking-replay"] || values["dry-run"]);
  if (!isOfflineReplay && !values["user-id"]) {
    errors.push(
      "Missing required argument: --user-id is required for live retrieval and candidate recording.",
    );
  }

  // 4. Candidate-K and Top-K
  const candidateK = values["candidate-k"] ? Number(values["candidate-k"]) : 20;
  const topK = values["top-k"] ? Number(values["top-k"]) : 5;

  if (Number.isNaN(candidateK) || candidateK <= 0 || !Number.isInteger(candidateK)) {
    errors.push(`Invalid --candidate-k: '${values["candidate-k"]}'. Must be a positive integer.`);
  }

  if (Number.isNaN(topK) || topK <= 0 || !Number.isInteger(topK)) {
    errors.push(`Invalid --top-k: '${values["top-k"]}'. Must be a positive integer.`);
  }

  if (candidateK < topK) {
    errors.push(
      `Invalid configuration: candidateK (${candidateK}) cannot be smaller than topK (${topK}).`,
    );
  }

  // 5. Similarity threshold
  let similarityThreshold: number | undefined = undefined;
  if (values["similarity-threshold"] !== undefined) {
    const parsed = Number(values["similarity-threshold"]);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      errors.push(
        `Invalid --similarity-threshold: '${values["similarity-threshold"]}'. Must be a finite number between 0.0 and 1.0.`,
      );
    } else {
      similarityThreshold = parsed;
    }
  }

  // 6. Strategy
  const rawStrategy = values.strategy?.toUpperCase() ?? "HYBRID";
  if (!["HYBRID", "VECTOR", "FTS"].includes(rawStrategy)) {
    errors.push(
      `Invalid --strategy: '${values.strategy}'. Expected 'HYBRID', 'VECTOR', or 'FTS'.`,
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    candidateK,
    topK,
    similarityThreshold,
    strategy: rawStrategy as "HYBRID" | "VECTOR" | "FTS",
  };
}

async function createLiveReranker(): Promise<EvaluatorReranker> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is required for live reranking evaluation.",
    );
  }

  const { GoogleGenAI } = await import("@google/genai");
  const { GeminiReranker } = await import(
    "../../retrieval/application/GeminiReranker.js"
  );

  return new GeminiReranker({
    client: new GoogleGenAI({ apiKey }),
  });
}

// ---------------------------------------------------------------------------
// CLI Execution Runner
// ---------------------------------------------------------------------------

export interface CliPrismaClient {
  document: {
    findMany(args: {
      where: { userId: string; status: "READY" };
      select: {
        id: true;
        updatedAt: true;
        processedAt: true;
        chunks: {
          select: { id: true; chunkIndex: true; content: true };
          orderBy: { chunkIndex: "asc" };
        };
      };
      orderBy: { id: "asc" };
    }): Promise<CorpusFingerprintItem[]>;
  };
}

export async function runEvaluationCli(
  rawArgs: string[],
  deps?: {
    embedQuery?: { execute(query: string, requestId?: string): Promise<number[]> };
    retrievalStrategy?: RetrievalStrategy;
    reranker?: EvaluatorReranker;
    configRepository?: { findByUserId(userId: string): Promise<{ similarityThreshold?: number } | null> };
    corpusSnapshot?: CorpusFingerprintItem[];
    prismaClient?: CliPrismaClient;
  },
): Promise<number> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      dataset: { type: "string" },
      "user-id": { type: "string" },
      "similarity-threshold": { type: "string" },
      "candidate-k": { type: "string", default: "20" },
      "top-k": { type: "string", default: "5" },
      strategy: { type: "string", default: "HYBRID" },
      "output-dir": { type: "string", default: "eval-results" },
      "output-json": { type: "string" },
      "output-md": { type: "string" },
      "record-cache": { type: "string" },
      "replay-cache": { type: "string" },
      "cached-ranking-replay": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Cortex Information Retrieval Evaluation CLI

Usage:
  npx tsx src/modules/evaluation/cli/evaluate-retrieval.ts [options]

Required:
  --dataset <path>                Path to benchmark evaluation dataset JSON

Execution Modes (Mutually Exclusive):
  (default)                       Live Evaluation (PostgreSQL + Gemini embedding & reranker)
  --record-cache <path>           Live Evaluation + record candidate pool snapshot to <path>
  --replay-cache <path>           Candidate-Pool Replay (skips DB, runs live Gemini reranker)
  --cached-ranking-replay <path>  Cached-Ranking Replay (zero Gemini calls, zero DB calls)
  --dry-run                       Validate arguments and dataset locally without network/DB calls

Evaluation Options:
  --user-id <string>              Target user ID (required in live mode)
  --similarity-threshold <number> Explicit similarity threshold override [0.0 - 1.0]
  --candidate-k <number>          Candidate retrieval limit (default: 20)
  --top-k <number>                Evaluation rank cutoff (default: 5)
  --strategy <HYBRID|VECTOR|FTS>  Retrieval fusion strategy (default: HYBRID)

Output Options:
  --output-dir <path>             Directory for report artifacts (default: eval-results)
  --output-json <path>            Explicit JSON report output path
  --output-md <path>              Explicit Markdown report output path
  --quiet                         Suppress verbose logging
  --help                          Show this help message
`);
    return 0;
  }

  // 1. Pre-flight argument validation
  const validation = validateEvaluationCliArgs(values);
  if (!validation.valid) {
    for (const err of validation.errors) {
      console.error(`[EVAL ERROR] ${err}`);
    }
    return 1;
  }

  const { candidateK, topK, similarityThreshold, strategy: strategyName } = validation;
  const isQuiet = Boolean(values.quiet);
  const isDryRun = Boolean(values["dry-run"]);

  // 2. Load and validate dataset
  const datasetPath = path.resolve(values.dataset!);
  let datasetContent: string;
  try {
    datasetContent = await fs.readFile(datasetPath, "utf-8");
  } catch (err) {
    console.error(`[EVAL ERROR] Failed to read dataset file at "${datasetPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let dataset: EvaluationDataset;
  try {
    dataset = parseEvaluationDatasetJson(datasetContent);
  } catch (err) {
    console.error(`[EVAL ERROR] Dataset schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 3. Dry-Run path
  if (isDryRun) {
    console.log("[EVAL] Dry run verification successful.");
    console.log(`[EVAL] Dataset: "${dataset.version}" (${dataset.queries.length} queries).`);
    console.log(`[EVAL] Configuration: candidateK=${candidateK}, topK=${topK}, strategy=${strategyName}.`);
    console.log("[EVAL] Local verification passed. Zero database or API connections made.");
    return 0;
  }

  const datasetFingerprint = computeDatasetFingerprint(dataset);
  const requiredQueries = dataset.queries.map((q) => ({ id: q.id, question: q.question }));

  let executionMode: "live" | "candidate-pool-replay" | "cached-ranking-replay" = "live";
  let runner: EvaluationRunner;
  let recordingRetrieval: RecordingRetrievalStrategy | undefined = undefined;
  let recordingReranker: RecordingReranker | undefined = undefined;

  // 4. Branch by Mode
  try {
    if (values["cached-ranking-replay"]) {
      executionMode = "cached-ranking-replay";
      const cachePath = path.resolve(values["cached-ranking-replay"]);
      if (!isQuiet) console.log(`[EVAL] Loading cached-ranking replay from: ${cachePath}`);

      const cache = await loadCache(cachePath);
      validateCacheCompatibility(cache, {
        datasetVersion: dataset.version,
        datasetFingerprint,
        retrievalStrategy: strategyName,
        rrfK: 60,
        candidateK,
        similarityThreshold: similarityThreshold ?? 0.3,
        embeddingModel: "gemini-embedding-001",
        expectedRerankerModel: "gemini-3.5-flash-lite",
        expectedRerankerPromptVersion: "gemini-rerank-v1",
        requiredQueries,
        requireRecordedRerank: true,
      });

      const replayRetrieval = new ReplayRetrievalStrategy(cache.pools);
      const replayReranker = new ReplayReranker(cache.pools);
      const dummyEmbedder = { async execute() { return []; } };

      runner = new EvaluationRunner(dummyEmbedder, replayRetrieval, replayReranker);
    } else if (values["replay-cache"]) {
      executionMode = "candidate-pool-replay";
      const cachePath = path.resolve(values["replay-cache"]);
      if (!isQuiet) console.log(`[EVAL] Loading candidate-pool replay from: ${cachePath}`);

      const cache = await loadCache(cachePath);
      validateCacheCompatibility(cache, {
        datasetVersion: dataset.version,
        datasetFingerprint,
        retrievalStrategy: strategyName,
        rrfK: 60,
        candidateK,
        similarityThreshold: similarityThreshold ?? 0.3,
        embeddingModel: "gemini-embedding-001",
        requiredQueries,
      });

      const replayRetrieval = new ReplayRetrievalStrategy(cache.pools);
      const dummyEmbedder = { async execute() { return []; } };

      let liveReranker = deps?.reranker;
      if (!liveReranker) {
        liveReranker = await createLiveReranker();
      }

      runner = new EvaluationRunner(dummyEmbedder, replayRetrieval, liveReranker);
    } else {
      // Live Evaluation Mode
      executionMode = "live";
      const userId = values["user-id"]!;
      if (!isQuiet) console.log(`[EVAL] Initializing live retrieval evaluation for user: ${userId}`);

      let embedQuery = deps?.embedQuery;
      if (!embedQuery) {
        const { createEmbedQueryUseCase } = await import(
          "../../retrieval/infrastructure/retrieval.factory.js"
        );
        embedQuery = createEmbedQueryUseCase();
      }

      let retrievalStrategy = deps?.retrievalStrategy;
      if (!retrievalStrategy) {
        const { getRetrievalStrategy } = await import(
          "../../retrieval/infrastructure/strategies/retrieval.strategy.factory.js"
        );
        retrievalStrategy = getRetrievalStrategy(strategyName);
      }

      let reranker = deps?.reranker;
      if (!reranker) {
        reranker = await createLiveReranker();
      }

      let configRepository = deps?.configRepository;
      if (!configRepository) {
        const { PrismaRetrievalConfigRepository } = await import(
          "../../retrieval-config/infrastructure/prisma-retrieval-config.repository.js"
        );
        configRepository = new PrismaRetrievalConfigRepository();
      }

      // If recording is requested, wrap retrieval & reranker
      if (values["record-cache"]) {
        recordingRetrieval = new RecordingRetrievalStrategy(retrievalStrategy);
        recordingReranker = new RecordingReranker(reranker);
        runner = new EvaluationRunner(
          embedQuery,
          recordingRetrieval,
          recordingReranker,
          configRepository,
        );
      } else {
        runner = new EvaluationRunner(embedQuery, retrievalStrategy, reranker, configRepository);
      }
    }
  } catch (err) {
    if (err instanceof CacheIncompatibilityError) {
      console.error(`[EVAL CACHE INCOMPATIBILITY] ${err.message}`);
      return 2; // Specific exit code for cache incompatibility
    }
    console.error(`[EVAL ERROR] Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 5. Execute Evaluation Run
  if (!isQuiet) {
    console.log(
      `[EVAL] Starting evaluation in mode: ${executionMode} (${dataset.queries.length} queries)...`,
    );
  }

  let runResult;
  try {
    runResult = await runner.run({
      dataset,
      userId: values["user-id"] ?? "offline-eval-user",
      ...(similarityThreshold !== undefined ? { similarityThreshold } : {}),
      candidateK,
      topK,
      retrievalStrategyName: strategyName,
    });
  } catch (err) {
    console.error(`[EVAL ERROR] Evaluation run failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 6. Record Cache Snapshot if requested
  if (values["record-cache"] && recordingRetrieval && recordingReranker) {
    const recordCachePath = path.resolve(values["record-cache"]);
    if (!isQuiet) console.log(`[EVAL] Recording candidate pool cache to: ${recordCachePath}`);

    const allDocumentIds = new Set<string>();
    const pools: CachedQueryPool[] = [];

    for (const record of runResult.queryRecords) {
      const liveChunks = recordingRetrieval.recordedPools.get(record.queryId) ?? [];
      const rerankResult = recordingReranker.recordedReranked.get(record.queryId);

      for (const c of liveChunks) {
        allDocumentIds.add(c.documentId);
      }

      const cachedChunks = liveChunks.map((chunk, idx) =>
        toCachedCandidateChunk(chunk, idx + 1, strategyName),
      );

      const recordedRerank = rerankResult
        ? {
            chunks: rerankResult.chunks.map((chunk, idx) =>
              toCachedCandidateChunk(chunk, idx + 1, strategyName),
            ),
            telemetry: {
              latencyMs: rerankResult.telemetry.latencyMs,
              status: rerankResult.telemetry.status,
              ...(rerankResult.telemetry.failureType ? { failureType: rerankResult.telemetry.failureType } : {}),
              ...(rerankResult.telemetry.approxTokens !== undefined ? { approxTokens: rerankResult.telemetry.approxTokens } : {}),
            },
          }
        : undefined;

      pools.push({
        queryId: record.queryId,
        queryFingerprint: computeQueryFingerprint(record.question),
        chunks: cachedChunks,
        ...(recordedRerank ? { recordedRerank } : {}),
      });
    }

    let corpusSnapshot: CorpusFingerprintItem[] | undefined = deps?.corpusSnapshot;

    if (corpusSnapshot === undefined && values["user-id"]) {
      try {
        let prisma = deps?.prismaClient;
        if (!prisma) {
          const dbModule = await import("../../../config/database.js");
          prisma = dbModule.prisma;
        }

        const docs = await prisma.document.findMany({
          where: { userId: values["user-id"], status: "READY" },
          select: {
            id: true,
            updatedAt: true,
            processedAt: true,
            chunks: {
              select: { id: true, chunkIndex: true, content: true },
              orderBy: { chunkIndex: "asc" },
            },
          },
          orderBy: { id: "asc" },
        });

        corpusSnapshot = docs;
      } catch {
        console.error(
          `[EVAL ERROR] Failed to obtain complete corpus snapshot from database: database query failed. Cache recording aborted.`,
        );
        return 1;
      }
    }

    if (corpusSnapshot === undefined) {
      console.error(
        `[EVAL ERROR] Cannot record cache: complete corpus snapshot is unavailable. Cache recording aborted.`,
      );
      return 1;
    }

    // Verify consistency: candidate chunks cannot reference document IDs absent from the corpus snapshot
    const snapshotDocIds = new Set(
      corpusSnapshot.map((item) => (typeof item === "string" ? item : item.id)),
    );
    for (const candidateDocId of allDocumentIds) {
      if (!snapshotDocIds.has(candidateDocId)) {
        console.error(
          `[EVAL ERROR] Corpus snapshot inconsistency: candidate results reference document ID "${candidateDocId}" which is absent from the indexed corpus snapshot. Cache recording aborted.`,
        );
        return 1;
      }
    }

    const cacheData: CandidatePoolCacheData = {
      header: {
        cacheVersion: "1.1.0",
        datasetVersion: dataset.version,
        datasetFingerprint,
        corpusFingerprint: computeCorpusFingerprint(corpusSnapshot),
        candidatePoolFingerprint: computeCandidatePoolFingerprint(pools),
        retrievalStrategy: strategyName,
        rrfK: 60,
        candidateK,
        similarityThreshold: runResult.scorecard.runConfig.similarityThreshold,
        embeddingModel: runResult.scorecard.runConfig.embeddingModel,
        rerankerModel: runResult.scorecard.runConfig.rerankerModel,
        rerankerPromptVersion: "gemini-rerank-v1",
        recordedAt: new Date().toISOString(),
        queryCount: pools.length,
      },
      pools,
    };

    await saveCache(recordCachePath, cacheData);
    if (!isQuiet) console.log(`[EVAL] Cache recorded successfully (${pools.length} candidate pools).`);
  }

  // 7. Write Reports
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(values["output-dir"] ?? "eval-results");
  const jsonReportPath = values["output-json"]
    ? path.resolve(values["output-json"])
    : path.join(outputDir, `eval_run_${timestamp}.json`);
  const mdReportPath = values["output-md"]
    ? path.resolve(values["output-md"])
    : path.join(outputDir, `eval_run_${timestamp}.md`);

  const jsonReporter = new JsonEvaluationReporter();
  const mdReporter = new MarkdownReporter();

  await jsonReporter.writeReport(runResult, jsonReportPath, { executionMode });
  await mdReporter.writeReport(runResult, mdReportPath, executionMode);

  // 8. Console Summary Table
  const { scorecard } = runResult;
  console.log("\n========================================================");
  console.log("             CORTEX RETRIEVAL EVALUATION REPORT          ");
  console.log("========================================================");
  console.log(`Execution Mode : ${executionMode}`);
  console.log(`Total Queries  : ${scorecard.querySummary.total}`);
  console.log(`  Finalised    : ${scorecard.querySummary.finalised}`);
  console.log(`  Provisional  : ${scorecard.querySummary.provisional}`);
  console.log(`  Excluded     : ${scorecard.querySummary.excludedFromMetrics}`);
  console.log("--------------------------------------------------------");

  const targetMetrics = scorecard.finalisedMetrics ?? scorecard.allQueriesMetrics;
  const metricTypeLabel = scorecard.finalisedMetrics ? "Finalised (Certified)" : "All Queries (Provisional)";
  console.log(`Scorecard: ${metricTypeLabel}`);
  console.log(`Recall@5 (Lenient)  : Exp A = ${targetMetrics.experimentA.recall5Lenient.mean?.toFixed(4) ?? "N/A"} | Exp B = ${targetMetrics.experimentB.recall5Lenient.mean?.toFixed(4) ?? "N/A"} (Δ ${targetMetrics.deltas.recall5Lenient.mean !== null && (targetMetrics.deltas.recall5Lenient.mean ?? 0) > 0 ? "+" : ""}${targetMetrics.deltas.recall5Lenient.mean?.toFixed(4) ?? "N/A"})`);
  console.log(`MRR@5               : Exp A = ${targetMetrics.experimentA.mrr5.mean?.toFixed(4) ?? "N/A"} | Exp B = ${targetMetrics.experimentB.mrr5.mean?.toFixed(4) ?? "N/A"} (Δ ${targetMetrics.deltas.mrr5.mean !== null && (targetMetrics.deltas.mrr5.mean ?? 0) > 0 ? "+" : ""}${targetMetrics.deltas.mrr5.mean?.toFixed(4) ?? "N/A"})`);
  console.log(`nDCG@5              : Exp A = ${targetMetrics.experimentA.ndcg5.mean?.toFixed(4) ?? "N/A"} | Exp B = ${targetMetrics.experimentB.ndcg5.mean?.toFixed(4) ?? "N/A"} (Δ ${targetMetrics.deltas.ndcg5.mean !== null && (targetMetrics.deltas.ndcg5.mean ?? 0) > 0 ? "+" : ""}${targetMetrics.deltas.ndcg5.mean?.toFixed(4) ?? "N/A"})`);
  console.log(`Win / Tie / Loss    : Wins = ${targetMetrics.deltas.winTieLossNdcg.wins} | Ties = ${targetMetrics.deltas.winTieLossNdcg.ties} | Losses = ${targetMetrics.deltas.winTieLossNdcg.losses}`);
  console.log("--------------------------------------------------------");
  console.log(`JSON Report written to     : ${jsonReportPath}`);
  console.log(`Markdown Report written to : ${mdReportPath}`);
  console.log("========================================================\n");

  return 0;
}

// ---------------------------------------------------------------------------
// Entry Point Guard
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(path.join("cli", "evaluate-retrieval.ts"));

if (isMainModule) {
  runEvaluationCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error("[EVAL FATAL]", err);
      process.exit(1);
    });
}
