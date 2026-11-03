import type { EmbeddingStrategy } from "../infrastructure/strategies/EmbeddingStrategy.js";
import { stageLog, elapsed } from "../../shared/stageLog.js";

export class EmbedQuery {
  constructor(
    private readonly embeddingStrategy: EmbeddingStrategy,
  ) {}

  async execute(query: string, requestId?: string): Promise<number[]> {
    const t0 = performance.now();
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new Error("Query cannot be empty");
    }

    const result = await this.embeddingStrategy.generateEmbedding(
      normalizedQuery,
      requestId,
    );

    stageLog(requestId, "embed.total", {
      durationMs: elapsed(t0),
    });

    return result;
  }
}
