import { prisma } from "../../../config/database.js";
import { stageLog, elapsed, isVerboseDebugEnabled } from "../../shared/stageLog.js";

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
    similarityThreshold: number = 0,
    requestId?: string,
  ): Promise<RetrievedChunk[]> {
    const vector = `[${queryEmbedding.join(",")}]`;
    const t0 = performance.now();

    if (isVerboseDebugEnabled()) {
      console.log("[VECTOR] limit:", limit, "threshold:", similarityThreshold, "dimensions:", queryEmbedding.length);
    }

    const results = await prisma.$queryRaw<RetrievedChunk[]>`
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
        AND 1 - (c.embedding <=> ${vector}::vector) >= ${similarityThreshold}
      ORDER BY
        c.embedding <=> ${vector}::vector
      LIMIT ${limit}
    `;

    stageLog(requestId, "db.vector", {
      durationMs: elapsed(t0),
      resultCount: results.length,
      limit,
    });

    return results;
  }

  async fullTextSearch(
    query: string,
    userId: string,
    limit: number,
    requestId?: string,
  ): Promise<RetrievedChunk[]> {
    const t0 = performance.now();

    if (isVerboseDebugEnabled()) {
      console.log("[FTS] limit:", limit);
    }

    const results = await prisma.$queryRaw<RetrievedChunk[]>`
      SELECT
        c.id AS "chunkId",
        c."documentId" AS "documentId",
        d.title AS "documentTitle",
        c."chunkIndex" AS "chunkIndex",
        c.content,
        ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) AS similarity
      FROM "Chunk" c
      INNER JOIN "Document" d
        ON d.id = c."documentId"
      WHERE
        d."userId" = ${userId}
        AND to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
      ORDER BY
        similarity DESC
      LIMIT ${limit}
    `;

    stageLog(requestId, "db.fts", {
      durationMs: elapsed(t0),
      resultCount: results.length,
      limit,
    });

    return results;
  }
}
