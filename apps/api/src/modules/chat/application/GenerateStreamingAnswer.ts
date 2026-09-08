import type { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import type { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import type { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import { MessageRole } from "@prisma/client";

import { GeminiGenerationStrategy } from "../infrastructure/strategies/GeminiGenerationStrategy.js";
import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";
import { PrismaRetrievalConfigRepository } from "../../retrieval-config/infrastructure/prisma-retrieval-config.repository.js";
import { getRetrievalStrategy } from "../../retrieval/infrastructure/strategies/retrieval.strategy.factory.js";

type GenerateStreamingAnswerInput = {
  question: string;
  userId: string;
  sessionId: string;
};

export class GenerateStreamingAnswer {
  private readonly strategy =
    new GeminiGenerationStrategy();

  private readonly messageRepository =
    new PrismaChatMessageRepository();
  private readonly configRepository =
    new PrismaRetrievalConfigRepository();

  constructor(
    private readonly embedQuery: EmbedQuery,
    private readonly contextBuilder: ContextBuilder,
    private readonly buildPrompt: BuildPrompt,
  ) { }

  async *execute({
    question,
    userId,
    sessionId,
  }: GenerateStreamingAnswerInput) {
    await this.messageRepository.create({
      sessionId,
      role: MessageRole.USER,
      content: question,
    });

    const embedding =
      await this.embedQuery.execute(question);

    let config = await this.configRepository.findByUserId(userId);
    if (!config) {
      config = await this.configRepository.create({ userId });
    }

    const retrievalStrategy = getRetrievalStrategy(config.retrievalStrategy);

    const chunks =
      await retrievalStrategy.execute({
        queryEmbedding: embedding,
        userId,
        limit: config.topK,
        similarityThreshold: config.similarityThreshold,
      });

    const context =
      this.contextBuilder.execute(chunks);

    const prompt =
      this.buildPrompt.execute({
        question,
        context: context.context,
      });

    let assistantResponse = "";

    for await (const chunk of this.strategy.generateStream(
      prompt,
    )) {
      assistantResponse += chunk;

      yield chunk;
    }

    await this.messageRepository.create({
      sessionId,
      role: MessageRole.ASSISTANT,
      content: assistantResponse,
    });
  }
}