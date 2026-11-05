/**
 * EvaluationDataset — Zod schemas and TypeScript interfaces for benchmark datasets.
 *
 * Rules:
 * - Relevance labels must be 0 (irrelevant), 1 (partially relevant), or 2 (highly relevant).
 * - textAnchor is mandatory for semantic anchoring across document re-indexing.
 * - userId is strictly forbidden in query records; it must be supplied at runtime.
 * - Pooling metadata distinguishes expected vs. completed retrieval sources.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const evaluationJudgmentSchema = z
  .object({
    /** Database chunk ID (snapshot pointer). Optional because chunk may be newly discovered. */
    chunkId: z.string().optional(),
    /** Strict unique document identifier in Postgres. */
    documentId: z.string().min(1, "documentId cannot be empty"),
    /** Display / audit document title. Not used for identity matching. */
    documentTitle: z.string().min(1, "documentTitle cannot be empty"),
    /** Chunk index within the document at time of labeling. */
    chunkIndex: z.number().int().nonnegative().optional(),
    /** Graded relevance: 0 = Irrelevant, 1 = Partially relevant, 2 = Highly relevant. */
    relevance: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    /** Distinctive text excerpt for semantic anchoring across re-chunking. */
    textAnchor: z.string().min(1, "textAnchor cannot be empty"),
    /** Optional SHA-256 hash of normalized textAnchor. */
    textHash: z.string().optional(),
    /** Optional reviewer notes or rationale. */
    notes: z.string().optional(),
  })
  .strict();

export const judgmentPoolMetadataSchema = z
  .object({
    /** ISO timestamp when the pooling and review occurred. */
    collectedAt: z.string(),
    /** Configured expected sources (e.g. ["VECTOR", "FTS", "HYBRID"]). */
    expectedPoolingSources: z
      .array(z.enum(["VECTOR", "FTS", "HYBRID"]))
      .optional(),
    /** Completed and human-reviewed pooling sources. */
    completedPoolingSources: z.array(z.enum(["VECTOR", "FTS", "HYBRID"])),
    /** Total unique candidates reviewed across completed sources. */
    uniqueCandidatesReviewed: z.number().int().nonnegative(),
    /** Number of chunks labeled rel >= 1. */
    relevantLabeled: z.number().int().nonnegative(),
  })
  .strict();

export const evaluationQuerySchema = z
  .object({
    /** Unique stable question identifier. */
    id: z.string().min(1, "Query id cannot be empty"),
    /** Question text submitted to retrieval. */
    question: z.string().min(1, "Question cannot be empty"),
    /** Optional expected answer reference for annotator context. */
    expectedAnswer: z.string().optional(),
    /** Optional category/tag for segmented analysis. */
    category: z.string().optional(),
    /** Ground truth judgments for this query. */
    judgments: z.array(evaluationJudgmentSchema),
    /** Optional pooling metadata documenting judgment collection. */
    poolMetadata: judgmentPoolMetadataSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    // Validate that there are no conflicting judgments for the same (documentId, chunkId)
    const seenChunkIds = new Map<string, number>();
    for (const [idx, j] of query.judgments.entries()) {
      if (j.chunkId !== undefined && j.chunkId.length > 0) {
        const key = `${j.documentId}::${j.chunkId}`;
        const prevIdx = seenChunkIds.get(key);
        if (prevIdx !== undefined) {
          const prevJudgment = query.judgments[prevIdx];
          if (prevJudgment && prevJudgment.relevance !== j.relevance) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Conflicting relevance judgments for chunkId "${j.chunkId}" in document "${j.documentId}" (relevance ${prevJudgment.relevance} vs ${j.relevance})`,
              path: ["judgments", idx],
            });
          }
        } else {
          seenChunkIds.set(key, idx);
        }
      }
    }
  });

export const evaluationDatasetSchema = z
  .object({
    /** Semantic version of the dataset schema/content. */
    version: z.string().min(1, "version cannot be empty"),
    /** Dataset description. */
    description: z.string(),
    /** ISO timestamp when dataset was created or updated. */
    createdAt: z.string(),
    /** List of evaluation queries. */
    queries: z.array(evaluationQuerySchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type EvaluationJudgment = z.infer<typeof evaluationJudgmentSchema>;
export type JudgmentPoolMetadata = z.infer<typeof judgmentPoolMetadataSchema>;
export type EvaluationQuery = z.infer<typeof evaluationQuerySchema>;
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Validates unknown data against the evaluationDatasetSchema.
 * Throws ZodError on failure.
 */
export function parseEvaluationDataset(data: unknown): EvaluationDataset {
  return evaluationDatasetSchema.parse(data);
}

/**
 * Parses and validates a JSON string as an EvaluationDataset.
 */
export function parseEvaluationDatasetJson(jsonString: string): EvaluationDataset {
  const parsed: unknown = JSON.parse(jsonString);
  return parseEvaluationDataset(parsed);
}

/**
 * Formats an EvaluationDataset as a human-readable JSON string.
 */
export function serializeEvaluationDataset(dataset: EvaluationDataset): string {
  // Validate before serializing to guarantee schema conformance
  const validated = evaluationDatasetSchema.parse(dataset);
  return JSON.stringify(validated, null, 2);
}
