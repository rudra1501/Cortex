import { z } from "zod";

/**
 * Must match `RERANK_MAX_CANDIDATES` in GeminiReranker: a larger pool would be
 * retrieved but never ranked. `UpdateConfig.test.ts` asserts the two agree.
 */
export const RERANK_CANDIDATE_K_MAX = 30;

export const updateConfigSchema = z.object({
  chunkSize: z.number().int().min(1).optional(),

  chunkOverlap: z.number().int().min(0).optional(),

  topK: z.number().int().min(1).optional(),

  similarityThreshold: z.number().min(0).max(1).optional(),

  retrievalStrategy: z.enum(["VECTOR", "FTS", "HYBRID"]).optional(),

  embeddingStrategy: z.enum(["GEMINI"]).optional(),

  enableReranking: z.boolean().optional(),

  // Ceiling matches the reranker's prompt cap: a wider pool would be retrieved
  // but never ranked, so the setting stays within what the reranker can use.
  rerankCandidateK: z
    .number()
    .int()
    .min(1, `rerankCandidateK must be between 1 and ${RERANK_CANDIDATE_K_MAX}`)
    .max(
      RERANK_CANDIDATE_K_MAX,
      `rerankCandidateK must be between 1 and ${RERANK_CANDIDATE_K_MAX}`,
    )
    .optional(),
});
