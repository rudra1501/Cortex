import { ContextBuilder } from "../application/ContextBuilder.js";
import { EmbedQuery } from "../application/EmbedQuery.js";
import { VectorSearch } from "../application/VectorSearch.js";

import { PgVectorRepository } from "./PgVectorRepository.js";

import { GeminiEmbeddingStrategy } from "./strategies/GeminiEmbeddingStrategy.js";

export function createEmbedQueryUseCase() {
  return new EmbedQuery(
    new GeminiEmbeddingStrategy(),
  );
}

export function createVectorSearchUseCase() {
  return new VectorSearch(
    new PgVectorRepository(),
  );
}

export function createContextBuilderUseCase() {
  return new ContextBuilder();
}