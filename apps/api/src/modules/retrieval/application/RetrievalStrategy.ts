import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";

export type RetrievalInput = {
  queryEmbedding: number[];
  userId: string;
  limit?: number;
  similarityThreshold?: number;
};

export interface RetrievalStrategy {
  execute(
    input: RetrievalInput,
  ): Promise<RetrievedChunk[]>;
}