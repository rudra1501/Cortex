import type { EmbeddingStrategy } from "../infrastructure/strategies/EmbeddingStrategy.js";

export class EmbedQuery {
  constructor(
    private readonly embeddingStrategy: EmbeddingStrategy,
  ) {}

  async execute(query: string): Promise<number[]> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new Error("Query cannot be empty");
    }

    return this.embeddingStrategy.generateEmbedding(
      normalizedQuery,
    );
  }
}