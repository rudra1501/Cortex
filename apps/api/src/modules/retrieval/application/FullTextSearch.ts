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

    console.log("[FTS] ===============================");
    console.log("[FTS] Starting Full-Text Search");
    console.log(`[FTS] Query: "${query}"`);
    console.log(`[FTS] User ID: ${userId}`);
    console.log(`[FTS] Limit: ${limit}`);

    const results = await this.repository.fullTextSearch(
      query,
      userId,
      limit,
    );

    console.log(`[FTS] Search completed`);
    console.log(`[FTS] Results found: ${results.length}`);

    console.log("[FTS] ===============================");

    return results;
  }
}
