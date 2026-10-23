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

type GenerateAnswerInput = {
  question: string;
  userId: string;
  sessionId: string;
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

  async execute({ question, userId, sessionId }: GenerateAnswerInput) {
    await this.messageRepository.create({
      sessionId,
      role: MessageRole.USER,
      content: question,
    });

    let config = await this.configRepository.findByUserId(userId);
    if (!config) {
      config = await this.configRepository.create({ userId });
    }

    const embedding = await this.embedQuery.execute(question);

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
    });

    const finalChunks = await applyReranking(
      question,
      chunks,
      retrievalSettings,
      this.reranker,
    );

    const context = this.contextBuilder.execute(finalChunks);

    const prompt = this.buildPrompt.execute({
      question,
      context: context.context,
    });

    const answer = await this.generateResponse.execute(prompt);

    await this.messageRepository.create({
      sessionId,
      role: MessageRole.ASSISTANT,
      content: answer,
    });

    return {
      answer,
      sources: context.sources,
    };
  }
}
