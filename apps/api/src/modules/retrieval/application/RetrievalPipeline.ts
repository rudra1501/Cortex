import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { Reranker } from "./Reranker.js";

/** The retrieval settings that affect candidate selection and ordering. */
export type RetrievalSettings = {
  enableReranking: boolean;
  rerankCandidateK: number;
  topK: number;
};

/**
 * How many candidates the retrieval strategy should fetch.
 *
 * Reranking needs a wider pool than the final answer; with reranking disabled
 * the behaviour is exactly the pre-reranking one (`topK`).
 */
export function resolveRetrievalLimit(settings: RetrievalSettings): number {
  return settings.enableReranking ? settings.rerankCandidateK : settings.topK;
}

/**
 * Applies optional reranking and the final `topK` slice.
 *
 * With reranking disabled the retrieval output is returned untouched, so the
 * VECTOR/FTS/HYBRID ordering, metadata and similarity values are preserved.
 * Reranker failures never propagate: the original order is used instead.
 */
export async function applyReranking(
  query: string,
  chunks: RetrievedChunk[],
  settings: RetrievalSettings,
  reranker?: Reranker,
): Promise<RetrievedChunk[]> {
  if (!settings.enableReranking) {
    return chunks;
  }

  let ordered = chunks;

  if (reranker) {
    try {
      ordered = await reranker.rerank(query, chunks);
    } catch (error) {
      console.log(
        `[RERANKER] fallback: ${error instanceof Error ? error.message : String(error)} — using original order`,
      );

      ordered = chunks;
    }
  } else {
    console.log(
      "[RERANKER] skipped: no reranker configured — using retrieval order",
    );
  }

  return ordered.slice(0, settings.topK);
}
