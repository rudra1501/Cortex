import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";

export type RetrievalInput = {
  query: string;
  queryEmbedding: number[];
  userId: string;
  limit: number;
  similarityThreshold: number;
  /** Fastify request ID — forwarded to stage logs for request correlation. */
  requestId?: string | undefined;
};

export interface RetrievalStrategy {
  execute(
    input: RetrievalInput,
  ): Promise<RetrievedChunk[]>;
}
