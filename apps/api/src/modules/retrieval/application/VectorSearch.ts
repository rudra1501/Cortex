import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { PgVectorRepository } from "../infrastructure/PgVectorRepository.js";

type VectorSearchInput = {
  queryEmbedding: number[];
  userId: string;
  limit?: number;
};

export class VectorSearch {
  constructor(
    private readonly repository: PgVectorRepository,
  ) {}

  async execute({
    queryEmbedding,
    userId,
    limit = 5,
  }: VectorSearchInput): Promise<RetrievedChunk[]> {
    if (queryEmbedding.length !== 3072) {
      throw new Error(
        `Expected 3072 dimensions, received ${queryEmbedding.length}`,
      );
    }

    return this.repository.search(
      queryEmbedding,
      userId,
      limit,
    );
  }
}