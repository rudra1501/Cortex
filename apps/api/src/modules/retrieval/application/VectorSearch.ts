import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { PgVectorRepository } from "../infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "./RetrievalStrategy.js";


export class VectorSearch implements RetrievalStrategy {
  constructor(
    private readonly repository: PgVectorRepository,
  ) { }

  async execute({
    queryEmbedding,
    userId,
    limit,
    similarityThreshold,
  }: RetrievalInput): Promise<RetrievedChunk[]> {
    console.log("[Vector] ===============================");
    console.log("[Vector] Starting Vector Search");
    console.log(`[Vector] Embedding dimensions: ${queryEmbedding.length}`);
    console.log(`[Vector] User ID: ${userId}`);
    console.log(`[Vector] Limit: ${limit}`);
    console.log(`[Vector] Similarity threshold: ${similarityThreshold}`);

    if (queryEmbedding.length !== 3072) {
      throw new Error(
        `Expected 3072 dimensions, received ${queryEmbedding.length}`,
      );
    }

    const results = await this.repository.search(
      queryEmbedding,
      userId,
      limit,
      similarityThreshold,
    );

    console.log("[VECTOR] results:", results.length);
    console.log("[VECTOR] result IDs:", results.map(r => r.chunkId));

    return results;
  }
}