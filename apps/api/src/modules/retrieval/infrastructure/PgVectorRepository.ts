import { prisma } from "../../../config/database.js";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  similarity: number;
};

export class PgVectorRepository {
  async search(
    queryEmbedding: number[],
    userId: string,
    limit: number,
  ): Promise<RetrievedChunk[]> {
    const vector = `[${queryEmbedding.join(",")}]`;

    return prisma.$queryRaw<RetrievedChunk[]>`
      SELECT
        c.id AS "chunkId",
        c."documentId" AS "documentId",
        d.title AS "documentTitle",
        c."chunkIndex" AS "chunkIndex",
        c.content,
        1 - (c.embedding <=> ${vector}::vector)
          AS similarity
      FROM "Chunk" c
      INNER JOIN "Document" d
        ON d.id = c."documentId"
      WHERE
        d."userId" = ${userId}
        AND c.embedding IS NOT NULL
      ORDER BY
        c.embedding <=> ${vector}::vector
      LIMIT ${limit}
    `;
  }
}