import { PrismaRetrievalConfigRepository } from "../infrastructure/prisma-retrieval-config.repository.js";

type UpdateConfigInput = {
  id: string;

  userId: string;

  chunkSize?: number;

  chunkOverlap?: number;

  topK?: number;

  similarityThreshold?: number;
};

export class UpdateConfig {
  constructor(
    private readonly repository: PrismaRetrievalConfigRepository,
  ) {}

  async execute(
    input: UpdateConfigInput,
  ) {
    const config =
      await this.repository.findById(
        input.id,
      );

    if (
      !config ||
      config.userId !== input.userId
    ) {
      throw new Error(
        "Configuration not found",
      );
    }

    return this.repository.update(
      input.id,
      {
        ...(input.chunkSize !==
          undefined && {
          chunkSize: input.chunkSize,
        }),

        ...(input.chunkOverlap !==
          undefined && {
          chunkOverlap:
            input.chunkOverlap,
        }),

        ...(input.topK !== undefined && {
          topK: input.topK,
        }),

        ...(input.similarityThreshold !==
          undefined && {
          similarityThreshold:
            input.similarityThreshold,
        }),
      },
    );
  }
}