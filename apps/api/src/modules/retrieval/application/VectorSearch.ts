import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { PgVectorRepository } from "../infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "./RetrievalStrategy.js";


export class VectorSearch implements RetrievalStrategy {
  constructor(
    private readonly repository: PgVectorRepository,
  ) {}

  async execute({
    queryEmbedding,
    userId,
    limit = 15,
  }: RetrievalInput): Promise<RetrievedChunk[]> {
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