import { GenerateAnswer } from "../application/GenerateAnswer.js";
import { GenerateResponse } from "../application/GenerateResponse.js";

import { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import { GeminiGenerationStrategy } from "./strategies/GeminiGenerationStrategy.js";

import { GeminiEmbeddingStrategy } from "../../retrieval/infrastructure/strategies/GeminiEmbeddingStrategy.js";
import { PrismaChatSessionRepository } from "./repositories/PrismaChatSessionRepository.js";
import { CreateChatSession } from "../application/CreateChatSession.js";
import { PrismaChatMessageRepository } from "./repositories/PrismaChatMessageRepository.js";
import { SaveChatMessage } from "../application/SaveChatMessage.js";
import { GetChatHistory } from "../application/GetChatHistory.js";
import { GenerateStreamingAnswer } from "../application/GenerateStreamingAnswer.js";

import { GoogleGenAI } from "@google/genai";

import { GeminiReranker } from "../../retrieval/application/GeminiReranker.js";
import type { Reranker } from "../../retrieval/application/Reranker.js";

/**
 * Reranking is opt-in per user; without an API key it is simply unavailable
 * and the pipeline keeps the retrieval order.
 */
function createReranker(): Reranker | undefined {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return undefined;
  }

  return new GeminiReranker({
    client: new GoogleGenAI({ apiKey }),
  });
}

export function createGenerateAnswerUseCase() {
  return new GenerateAnswer(
    new EmbedQuery(
      new GeminiEmbeddingStrategy(),
    ),

    new ContextBuilder(),

    new BuildPrompt(),

    new GenerateResponse(
      new GeminiGenerationStrategy(),
    ),

    createReranker(),
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
    
    new ContextBuilder(),
    
    new BuildPrompt(),

    createReranker(),
  );
}

export function createChatSessionRepository() {
  return new PrismaChatSessionRepository();
}