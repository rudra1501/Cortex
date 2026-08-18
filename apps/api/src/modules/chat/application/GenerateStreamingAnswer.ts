import type { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import type { VectorSearch } from "../../retrieval/application/VectorSearch.js";
import type { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import type { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import { MessageRole } from "@prisma/client";

import { GeminiGenerationStrategy } from "../infrastructure/strategies/GeminiGenerationStrategy.js";
import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";

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

  constructor(
    private readonly embedQuery: EmbedQuery,
    private readonly vectorSearch: VectorSearch,
    private readonly contextBuilder: ContextBuilder,
    private readonly buildPrompt: BuildPrompt,
  ) {}

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

    const chunks =
      await this.vectorSearch.execute({
        queryEmbedding: embedding,
        userId,
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