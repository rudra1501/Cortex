import type { PrismaRetrievalConfigRepository } from "../infrastructure/prisma-retrieval-config.repository.js";

type UpdateConfigInput = {
  id: string;

  userId: string;

  chunkSize?: number;

  chunkOverlap?: number;

  topK?: number;

  similarityThreshold?: number;

  retrievalStrategy?: any;

  embeddingStrategy?: any;

  enableReranking?: boolean;

  rerankCandidateK?: number;
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

    // Validate the state the row will be in *after* this update, not just the
    // fields present in the request body.
    const effectiveTopK =
      input.topK ?? config.topK;

    const effectiveCandidateK =
      input.rerankCandidateK ??
      config.rerankCandidateK;

    const effectiveEnableReranking =
      input.enableReranking ??
      config.enableReranking;

    if (
      effectiveEnableReranking &&
      effectiveCandidateK < effectiveTopK
    ) {
      throw new Error(
        `rerankCandidateK (${effectiveCandidateK}) must be >= topK (${effectiveTopK}) when reranking is enabled`,
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

        ...(input.retrievalStrategy !==
          undefined && {
          retrievalStrategy:
            input.retrievalStrategy,
        }),

        ...(input.embeddingStrategy !==
          undefined && {
          embeddingStrategy:
            input.embeddingStrategy,
        }),

        ...(input.enableReranking !==
          undefined && {
          enableReranking:
            input.enableReranking,
        }),

        ...(input.rerankCandidateK !==
          undefined && {
          rerankCandidateK:
            input.rerankCandidateK,
        }),
      },

      // Compare-and-set guard: the values above were validated against these
      // persisted values, so the write must not land if they changed.
      {
        topK: config.topK,

        rerankCandidateK:
          config.rerankCandidateK,

        enableReranking:
          config.enableReranking,
      },
    );
  }
}