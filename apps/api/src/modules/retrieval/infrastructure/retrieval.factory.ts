import { EmbedQuery } from "../application/EmbedQuery.js";
import { GeminiEmbeddingStrategy } from "./strategies/GeminiEmbeddingStrategy.js";

export function createEmbedQueryUseCase() {
  return new EmbedQuery(
    new GeminiEmbeddingStrategy(),
  );
}