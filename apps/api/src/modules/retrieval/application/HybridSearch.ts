import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { RetrievalInput, RetrievalStrategy } from "./RetrievalStrategy.js";


const VECTOR_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;

export class HybridSearch implements RetrievalStrategy {
  constructor(
    private readonly vectorSearch: RetrievalStrategy,
    private readonly fullTextSearch: RetrievalStrategy,
  ) { }

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {

    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorSearch.execute(input),
      this.fullTextSearch.execute(input),
    ]);

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
        existing.similarity += chunk.similarity * FTS_WEIGHT;
      } else {
        merged.set(chunk.chunkId, {
          ...chunk,
          similarity: chunk.similarity * FTS_WEIGHT,
        });
      }
    }

    const results = [...merged.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);


    return results;
  }
}
