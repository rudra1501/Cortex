import type { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import type { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";
import type { Reranker } from "../../retrieval/application/Reranker.js";
import {
  applyReranking,
  resolveRetrievalLimit,
} from "../../retrieval/application/RetrievalPipeline.js";

import type { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import type { GenerateResponse } from "./GenerateResponse.js";
import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";
import { MessageRole } from "@prisma/client";
import { PrismaRetrievalConfigRepository } from "../../retrieval-config/infrastructure/prisma-retrieval-config.repository.js";
import { getRetrievalStrategy } from "../../retrieval/infrastructure/strategies/retrieval.strategy.factory.js";
import { stageLog, elapsed } from "../../shared/stageLog.js";

type GenerateAnswerInput = {
  question: string;
  userId: string;
  sessionId: string;
  requestId?: string;
};

export class GenerateAnswer {
  private readonly messageRepository = new PrismaChatMessageRepository();
  private readonly configRepository = new PrismaRetrievalConfigRepository();

  constructor(
    private readonly embedQuery: EmbedQuery,
    private readonly contextBuilder: ContextBuilder,
    private readonly buildPrompt: BuildPrompt,
    private readonly generateResponse: GenerateResponse,
    private readonly reranker?: Reranker,
  ) {}

  async execute({ question, userId, sessionId, requestId }: GenerateAnswerInput) {
    const tRequest0 = performance.now();

    const tUserMsg0 = performance.now();
    await this.messageRepository.create({
      sessionId,
      role: MessageRole.USER,
      content: question,
    });
    stageLog(requestId, "message.user.save", {
      durationMs: elapsed(tUserMsg0),
    });

    const tConfig0 = performance.now();
    let config = await this.configRepository.findByUserId(userId);
    if (!config) {
      config = await this.configRepository.create({ userId });
    }
    stageLog(requestId, "config.load", {
      durationMs: elapsed(tConfig0),
    });

    const embedding = await this.embedQuery.execute(question, requestId);

    const retrievalStrategy = getRetrievalStrategy(config.retrievalStrategy);

    const retrievalSettings = {
      enableReranking: config.enableReranking,
      rerankCandidateK: config.rerankCandidateK,
      topK: config.topK,
    };

    const chunks = await retrievalStrategy.execute({
      query: question,
      queryEmbedding: embedding,
      userId,
      limit: resolveRetrievalLimit(retrievalSettings),
      similarityThreshold: config.similarityThreshold,
      requestId,
    });

    const finalChunks = await applyReranking(
      question,
      chunks,
      retrievalSettings,
      this.reranker,
      requestId,
    );

    const tContext0 = performance.now();
    const context = this.contextBuilder.execute(finalChunks);
    stageLog(requestId, "context.build", {
      durationMs: elapsed(tContext0),
      chunkCount: finalChunks.length,
    });

    const tPrompt0 = performance.now();
    const prompt = this.buildPrompt.execute({
      question,
      context: context.context,
    });
    stageLog(requestId, "prompt.build", {
      durationMs: elapsed(tPrompt0),
      promptChars: prompt.length,
      approxTokens: Math.ceil(prompt.length / 4),
    });

    const tGen0 = performance.now();
    const answer = await this.generateResponse.execute(prompt);
    const genDurationMs = elapsed(tGen0);
    stageLog(requestId, "generation.total", {
      durationMs: genDurationMs,
      outputChars: answer.length,
      approxTokens: Math.ceil(answer.length / 4),
    });

    const tAssistantMsg0 = performance.now();
    await this.messageRepository.create({
      sessionId,
      role: MessageRole.ASSISTANT,
      content: answer,
    });
    stageLog(requestId, "message.assistant.save", {
      durationMs: elapsed(tAssistantMsg0),
    });

    stageLog(requestId, "request.total", {
      durationMs: elapsed(tRequest0),
    });

    return {
      answer,
      sources: context.sources,
    };
  }
}
