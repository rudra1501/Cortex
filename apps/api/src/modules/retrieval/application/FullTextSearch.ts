import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { PgVectorRepository } from "../infrastructure/PgVectorRepository.js";
import type {
  RetrievalInput,
  RetrievalStrategy,
} from "./RetrievalStrategy.js";

export class FullTextSearch implements RetrievalStrategy {
  constructor(
    private readonly repository: PgVectorRepository,
  ) { }

  async execute({
    query,
    userId,
    limit,
  }: RetrievalInput): Promise<RetrievedChunk[]> {
    if (!query) {
      throw new Error("Query is required for FullTextSearch");
    }

    return this.repository.fullTextSearch(
      query,
      userId,
      limit,
    );
  }
}
