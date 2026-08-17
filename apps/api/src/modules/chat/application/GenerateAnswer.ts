import type { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import type { VectorSearch } from "../../retrieval/application/VectorSearch.js";
import type { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import type { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import type { GenerateResponse } from "./GenerateResponse.js";
import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";
import { MessageRole } from "@prisma/client";

type GenerateAnswerInput = {
  question: string;
  userId: string;
  sessionId: string;
};

export class GenerateAnswer {
  private readonly messageRepository = new PrismaChatMessageRepository();

  constructor(
    private readonly embedQuery: EmbedQuery,
    private readonly vectorSearch: VectorSearch,
    private readonly contextBuilder: ContextBuilder,
    private readonly buildPrompt: BuildPrompt,
    private readonly generateResponse: GenerateResponse,
  ) {}

  async execute({ question, userId, sessionId }: GenerateAnswerInput) {
    await this.messageRepository.create({
      sessionId,
      role: MessageRole.USER,
      content: question,
    });

    const embedding = await this.embedQuery.execute(question);

    const chunks = await this.vectorSearch.execute({
      queryEmbedding: embedding,
      userId,
    });

    const context = this.contextBuilder.execute(chunks);

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
