import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { RetrievalInput, RetrievalStrategy } from "./RetrievalStrategy.js";

/**
 * Default weights. Must sum to 1.0.
 * vectorWeight + ftsWeight = 1.0
 */
const VECTOR_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;

export class HybridSearch implements RetrievalStrategy {
  constructor(
    private readonly vectorSearch: RetrievalStrategy,
    private readonly fullTextSearch: RetrievalStrategy,
  ) { }

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    // Run both strategies in parallel

    console.log("[Hybrid] ===============================");
    console.log(`[Hybrid] Query: "${input.query}"`);

    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorSearch.execute(input),
      this.fullTextSearch.execute(input),
    ]);

    console.log(
      `[HYBRID] vector=${vectorResults.length}, fts=${ftsResults.length}`
    );

    // Build a map: chunkId → merged chunk with combined score
    const merged = new Map<string, RetrievedChunk>();

    for (const chunk of vectorResults) {
      merged.set(chunk.chunkId, {
        ...chunk,
        similarity: chunk.similarity * VECTOR_WEIGHT,
      });
    }


    for (const chunk of ftsResults) {
      const existing = merged.get(chunk.chunkId);
      if (existing) {
        // Chunk appeared in both result sets → add weighted FTS score
        existing.similarity += chunk.similarity * FTS_WEIGHT;
      } else {
        merged.set(chunk.chunkId, {
          ...chunk,
          similarity: chunk.similarity * FTS_WEIGHT,
        });
      }
    }

    // Sort by combined score descending, apply topK
    const results = [...merged.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);

    console.log(
      `[Hybrid] Merged: ${merged.size} | Returning: ${results.length}`,
    );

    if (results.length > 0) {
      console.log(
        `[Hybrid] Top score: ${results[0]!.similarity.toFixed(4)}`,
      );
    }

    return results;
  }
}
