import { prisma } from "../../../config/database.js";

export class PrismaRetrievalConfigRepository {
  async create(input: {
    userId: string;
  }) {
    return prisma.retrievalConfig.create({
      data: input,
    });
  }

  async findById(id: string) {
    return prisma.retrievalConfig.findUnique({
      where: {
        id,
      },
    });
  }

  async findByUserId(userId: string) {
    return prisma.retrievalConfig.findFirst({
      where: {
        userId,
      },
    });
  }

  async update(
    id: string,
    data: {
      chunkSize?: number;

      chunkOverlap?: number;

      topK?: number;

      similarityThreshold?: number;

      retrievalStrategy?: any;

      embeddingStrategy?: any;

      enableReranking?: boolean;

      rerankCandidateK?: number;
    },
    /**
     * Values read and validated by the caller before this write. When given,
     * the update only lands if those columns are still unchanged, so a
     * concurrent update cannot invalidate the cross-field validation. This is
     * a single-statement compare-and-set — no transaction is required.
     */
    expected?: {
      topK: number;

      rerankCandidateK: number;

      enableReranking: boolean;
    },
  ) {
    if (!expected) {
      return prisma.retrievalConfig.update({
        where: {
          id,
        },

        data,
      });
    }

    const [updated] =
      await prisma.retrievalConfig.updateManyAndReturn({
        where: {
          id,

          ...expected,
        },

        data,
      });

    if (!updated) {
      throw new Error(
        "Configuration was modified concurrently, please retry",
      );
    }

    return updated;
  }
}