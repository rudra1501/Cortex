import type { EmbeddingStrategy } from "./EmbeddingStrategy.js";
import { EmbeddingService } from "./embedding.service.js";

export function getEmbeddingStrategy(
  strategy: string,
): EmbeddingStrategy {
  switch (strategy) {
    case "GEMINI":
      return new EmbeddingService();

    default:
      throw new Error(
        `Unsupported embedding strategy: ${strategy}`,
      );
  }
}