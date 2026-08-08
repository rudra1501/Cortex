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
    const createdChunks = [];

    for (const chunk of chunks) {
      const created = await prisma.chunk.create({
        data: {
          documentId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          chunkingStrategy: "fixed-size",
        },
      });

      createdChunks.push(created);
    }

    return createdChunks;
  }

  async updateEmbedding(chunkId: string, embedding: number[]) {
    const vector = `[${embedding.join(",")}]`;

    await prisma.$executeRaw`
      UPDATE "Chunk"
      SET "embedding" = ${vector}::vector
      WHERE "id" = ${chunkId}
    `;
  }
}
