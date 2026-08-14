import type { EmbedQuery } from "../../retrieval/application/EmbedQuery.js";
import type { VectorSearch } from "../../retrieval/application/VectorSearch.js";
import type { ContextBuilder } from "../../retrieval/application/ContextBuilder.js";

import type { BuildPrompt } from "../../prompt/application/BuildPrompt.js";

import type { GenerateResponse } from "./GenerateResponse.js";

type GenerateAnswerInput = {
  question: string;
  userId: string;
};

export class GenerateAnswer {
  constructor(
    private readonly embedQuery: EmbedQuery,
    private readonly vectorSearch: VectorSearch,
    private readonly contextBuilder: ContextBuilder,
    private readonly buildPrompt: BuildPrompt,
    private readonly generateResponse: GenerateResponse,
  ) {}

  async execute({
    question,
    userId,
  }: GenerateAnswerInput) {
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

    const answer =
      await this.generateResponse.execute(
        prompt,
      );

    return {
      answer,
      sources: context.sources,
    };
  }
}