import { prisma } from "./prisma.js";

export class PrismaChunkRepository {
  async createMany(
    documentId: string,
    chunks: {
      chunkIndex: number;
      content: string;
      tokenCount: number;
    }[],
  ) {
    return prisma.chunk.createMany({
      data: chunks.map((chunk) => ({
        documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        chunkingStrategy: "fixed-size",
      })),
    });
  }
}