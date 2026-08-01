import { prisma } from "./prisma.js";

export class PrismaDocumentRepository {
  async findById(id: string) {
    return prisma.document.findUnique({
      where: {
        id,
      },
    });
  }

  async update(
    id: string,
    data: {
      status?: "PROCESSING" | "READY" | "FAILED";
      rawText?: string;
      processingStartedAt?: Date;
      processedAt?: Date;
      errorMessage?: string;
    },
  ) {
    return prisma.document.update({
      where: {
        id,
      },
      data,
    });
  }
}