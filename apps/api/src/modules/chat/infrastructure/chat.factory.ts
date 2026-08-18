import { GenerateAnswer } from "../application/GenerateAnswer.js";
import { GenerateResponse } from "../application/GenerateResponse.js";

import { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import { VectorSearch } from "../../retrieval/application/VectorSearch.js";
import { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import { GeminiGenerationStrategy } from "./strategies/GeminiGenerationStrategy.js";

import { GeminiEmbeddingStrategy } from "../../retrieval/infrastructure/strategies/GeminiEmbeddingStrategy.js";

import { PgVectorRepository } from "../../retrieval/infrastructure/PgVectorRepository.js";
import { PrismaChatSessionRepository } from "./repositories/PrismaChatSessionRepository.js";
import { CreateChatSession } from "../application/CreateChatSession.js";
import { PrismaChatMessageRepository } from "./repositories/PrismaChatMessageRepository.js";
import { SaveChatMessage } from "../application/SaveChatMessage.js";
import { GetChatHistory } from "../application/GetChatHistory.js";
import { GenerateStreamingAnswer } from "../application/GenerateStreamingAnswer.js";

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


export function createChatSessionUseCase() {
  return new CreateChatSession(
    new PrismaChatSessionRepository(),
  );
}

export function createSaveChatMessageUseCase() {
  return new SaveChatMessage(
    new PrismaChatMessageRepository(),
  );
}

export function createGetChatHistoryUseCase() {
  return new GetChatHistory(
    new PrismaChatMessageRepository(),
  );
}

export function createGenerateStreamingAnswerUseCase() {
  return new GenerateStreamingAnswer(
    new EmbedQuery(
      new GeminiEmbeddingStrategy(),
    ),
    
    new VectorSearch(
      new PgVectorRepository(),
    ),
    
    new ContextBuilder(),
    
    new BuildPrompt(),
  );
}

export function createChatSessionRepository() {
  return new PrismaChatSessionRepository();
}