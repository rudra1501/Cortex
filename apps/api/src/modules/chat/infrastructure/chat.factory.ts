import { GenerateAnswer } from "../application/GenerateAnswer.js";
import { GenerateResponse } from "../application/GenerateResponse.js";

import { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import { VectorSearch } from "../../retrieval/application/VectorSearch.js";
import { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import { GeminiGenerationStrategy } from "./strategies/GeminiGenerationStrategy.js";

import { GeminiEmbeddingStrategy } from "../../retrieval/infrastructure/strategies/GeminiEmbeddingStrategy.js";

import { PgVectorRepository } from "../../retrieval/infrastructure/PgVectorRepository.js";

export function createGenerateAnswerUseCase() {
  return new GenerateAnswer(
    new EmbedQuery(
      new GeminiEmbeddingStrategy(),
    ),

    new VectorSearch(
      new PgVectorRepository(),
    ),

    new ContextBuilder(),

    new BuildPrompt(),

    new GenerateResponse(
      new GeminiGenerationStrategy(),
    ),
  );
}