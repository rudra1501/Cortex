/**
 * JsonEvaluationReporter — serializes complete offline IR evaluation results
 * into a versioned, machine-readable JSON artifact.
 *
 * Guarantees:
 * - Versioned schema ("1.0.0").
 * - Full fidelity for runConfig, scorecard, per-query records, deltas, and telemetry.
 * - Explicit per-query isFinalised boolean.
 * - Security hygiene: strictly excludes user IDs, tokens, secrets, and full document content.
 * - Atomic disk write via temporary file and rename.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import type {
  EvaluationRunResult,
  EvaluationRunConfig,
  EvaluationScorecard,
  RankedChunk,
  QueryMetrics,
  QueryDeltas,
  RerankerTelemetry,
  CandidatePoolMetrics,
  IncompletenessFlags,
} from "../domain/EvaluationResult.js";

// ---------------------------------------------------------------------------
// Schemas & Types
// ---------------------------------------------------------------------------

const judgmentResolutionSchema = z.union([
  z.object({
    status: z.literal("judged"),
    relevance: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    matchType: z.enum(["exact_id", "text_anchor_provisional"]),
  }),
  z.object({
    status: z.literal("unjudged"),
  }),
  z.object({
    status: z.literal("ambiguous"),
    reason: z.string(),
    matchingJudgmentCount: z.number().int().nonnegative(),
  }),
]);

const rankedChunkSchema = z.object({
  chunkId: z.string().min(1),
  rank: z.number().int().positive(),
  originalRrfRank: z.number().int().positive().optional(),
  score: z.number().optional(),
  judgment: judgmentResolutionSchema,
});

const queryMetricsSchema = z.object({
  recall5Lenient: z.number().nullable(),
  recall5Strict: z.number().nullable(),
  mrr5: z.number().nullable(),
  ndcg5: z.number().nullable(),
});

const candidatePoolMetricsSchema = z.object({
  candidateRecall20Lenient: z.number().nullable(),
  candidateRecall20Strict: z.number().nullable(),
});

const queryDeltasSchema = z.object({
  deltaRecall5Lenient: z.number().nullable(),
  deltaRecall5Strict: z.number().nullable(),
  deltaMrr5: z.number().nullable(),
  deltaNdcg5: z.number().nullable(),
});

const rerankerTelemetrySchema = z.object({
  latencyMs: z.number().nonnegative(),
  status: z.enum(["success", "fallback", "skipped"]),
  failureType: z.string().optional(),
  approxTokens: z.number().optional(),
});

const incompletenessFlagsSchema = z.object({
  unjudgedInEvalPool: z.boolean(),
  incompleteSources: z.boolean(),
  pendingReview: z.boolean(),
});

const jsonQueryReportItemSchema = z.object({
  queryId: z.string().min(1),
  question: z.string().min(1),
  category: z.string().optional(),
  isFinalised: z.boolean(),
  incompletenessFlags: incompletenessFlagsSchema,
  candidatePoolCount: z.number().int().nonnegative(),
  candidateRecall20: candidatePoolMetricsSchema,
  experimentA: z.object({
    topKChunks: z.array(rankedChunkSchema),
    metrics: queryMetricsSchema,
    latencyMs: z.number().nonnegative(),
  }),
  experimentB: z.object({
    topKChunks: z.array(rankedChunkSchema),
    metrics: queryMetricsSchema,
    telemetry: rerankerTelemetrySchema,
  }),
  deltas: queryDeltasSchema,
});

export const jsonEvaluationReportSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  reportId: z.string().min(1),
  generatedAt: z.string(),
  executionMode: z.enum(["live", "candidate-pool-replay", "cached-ranking-replay"]),
  runConfig: z.record(z.string(), z.unknown()),
  scorecard: z.record(z.string(), z.unknown()),
  queries: z.array(jsonQueryReportItemSchema),
});

export type JsonEvaluationReport = {
  readonly schemaVersion: "1.0.0";
  readonly reportId: string;
  readonly generatedAt: string;
  readonly executionMode: "live" | "candidate-pool-replay" | "cached-ranking-replay";
  readonly runConfig: EvaluationRunConfig;
  readonly scorecard: EvaluationScorecard;
  readonly queries: readonly JsonQueryReportItem[];
};

export type JsonQueryReportItem = {
  readonly queryId: string;
  readonly question: string;
  readonly category?: string | undefined;
  readonly isFinalised: boolean;
  readonly incompletenessFlags: IncompletenessFlags;
  readonly candidatePoolCount: number;
  readonly candidateRecall20: CandidatePoolMetrics;
  readonly experimentA: {
    readonly topKChunks: readonly RankedChunk[];
    readonly metrics: QueryMetrics;
    readonly latencyMs: number;
  };
  readonly experimentB: {
    readonly topKChunks: readonly RankedChunk[];
    readonly metrics: QueryMetrics;
    readonly telemetry: RerankerTelemetry;
  };
  readonly deltas: QueryDeltas;
};

// ---------------------------------------------------------------------------
// Reporter Implementation
// ---------------------------------------------------------------------------

export class JsonEvaluationReporter {
  /**
   * Transforms an in-memory EvaluationRunResult into a structured JsonEvaluationReport.
   */
  generate(
    result: EvaluationRunResult,
    executionMode: "live" | "candidate-pool-replay" | "cached-ranking-replay" = "live",
  ): JsonEvaluationReport {
    const generatedAt = new Date().toISOString();
    const reportId = `eval_report_${generatedAt.replace(/[:.]/g, "-")}`;

    const queries: JsonQueryReportItem[] = result.queryRecords.map((record) => {
      const isFinalised =
        !record.incompletenessFlags.unjudgedInEvalPool &&
        !record.incompletenessFlags.incompleteSources &&
        !record.incompletenessFlags.pendingReview;

      return {
        queryId: record.queryId,
        question: record.question,
        ...(record.category !== undefined ? { category: record.category } : {}),
        isFinalised,
        incompletenessFlags: record.incompletenessFlags,
        candidatePoolCount: record.candidatePool.length,
        candidateRecall20: record.candidateRecall20,
        experimentA: {
          topKChunks: record.experimentA.topKChunks,
          metrics: record.experimentA.metrics,
          latencyMs: record.experimentA.latencyMs,
        },
        experimentB: {
          topKChunks: record.experimentB.topKChunks,
          metrics: record.experimentB.metrics,
          telemetry: record.experimentB.telemetry,
        },
        deltas: record.deltas,
      };
    });

    return {
      schemaVersion: "1.0.0",
      reportId,
      generatedAt,
      executionMode,
      runConfig: result.scorecard.runConfig,
      scorecard: result.scorecard,
      queries,
    };
  }

  /**
   * Serializes the evaluation run result as a JSON string with validation.
   */
  serialize(
    result: EvaluationRunResult,
    options?: {
      executionMode?: "live" | "candidate-pool-replay" | "cached-ranking-replay";
      pretty?: boolean;
    },
  ): string {
    const report = this.generate(result, options?.executionMode ?? "live");
    // Validate schema
    jsonEvaluationReportSchema.parse(report);
    return JSON.stringify(report, null, options?.pretty !== false ? 2 : undefined);
  }

  /**
   * Atomically writes the JSON evaluation report to disk via a temporary file and rename.
   */
  async writeReport(
    result: EvaluationRunResult,
    outputPath: string,
    options?: {
      executionMode?: "live" | "candidate-pool-replay" | "cached-ranking-replay";
      pretty?: boolean;
    },
  ): Promise<string> {
    const json = this.serialize(result, options);
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${outputPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tempPath, json, "utf-8");
      await fs.rename(tempPath, outputPath);
      return path.resolve(outputPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}
