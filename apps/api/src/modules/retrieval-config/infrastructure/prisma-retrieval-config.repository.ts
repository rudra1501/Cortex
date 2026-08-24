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
    },
  ) {
    return prisma.retrievalConfig.update({
      where: {
        id,
      },

      data,
    });
  }
}