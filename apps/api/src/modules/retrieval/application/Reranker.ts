import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";

/**
 * Reorders already-retrieved chunks by relevance to the query.
 *
 * Contract:
 * - Returns a new array; the input array is never mutated.
 * - Contains the same chunk objects (no field is modified).
 * - On any failure the original order must be returned unchanged.
 */
export interface Reranker {
  rerank(query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]>;
}
