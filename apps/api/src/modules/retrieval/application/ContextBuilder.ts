import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";

export type ContextSource = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  similarity: number;
};

export type BuiltContext = {
  sources: ContextSource[];
  context: string;
};

export class ContextBuilder {
  execute(chunks: RetrievedChunk[]): BuiltContext {
    const sources = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      similarity: chunk.similarity,
    }));

    const context = chunks
      .map(
        (chunk, index) =>
          `[Source ${index + 1}]
Document: ${chunk.documentTitle}
Chunk: ${chunk.chunkIndex}

${chunk.content}`,
      )
      .join("\n\n---\n\n");

    return {
      sources,
      context,
    };
  }
}
