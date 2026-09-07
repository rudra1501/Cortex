import { readFile } from "node:fs/promises";

import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { getParser } from "../parsers/parser.factory.js";
import { FixedSizeChunker } from "../chunking/fixed-size.chunker.js";
import { PrismaChunkRepository } from "../infrastructure/prisma-chunk.repository.js";
import { getEmbeddingStrategy } from "../embeddings/embedding.strategy.factory.js";

export class DocumentProcessor {
  private readonly repository = new PrismaDocumentRepository();
  private readonly chunkRepository = new PrismaChunkRepository();

  async process(documentId: string) {
    const document = await this.repository.findById(documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    try {
      await this.repository.update(document.id, {
        status: "PROCESSING",
        processingStartedAt: new Date(),
        errorMessage: null,
      });

      const buffer = await readFile(document.storagePath!);

      const parser = getParser(document.mimeType);
      console.log("parser document type:", parser);

      const rawText = await parser.parse(buffer);

      const retrievalConfig = document.retrievalConfig;

      if (!retrievalConfig) {
        throw new Error("Document does not have a retrieval configuration");
      }

      const embeddingStrategy = getEmbeddingStrategy(
        retrievalConfig.embeddingStrategy,
      );
      console.log("Retrieval config:", {
        chunkSize: retrievalConfig.chunkSize,
        chunkOverlap: retrievalConfig.chunkOverlap,
        embeddingStrategy: retrievalConfig.embeddingStrategy,
      });

      const chunker = new FixedSizeChunker(
        retrievalConfig.chunkSize,
        retrievalConfig.chunkOverlap,
      );

      const chunks = chunker.chunk(rawText);
      console.log("Chunking config:", {
        chunkSize: retrievalConfig.chunkSize,
        chunkOverlap: retrievalConfig.chunkOverlap,
        totalChunks: chunks.length,
      });

      console.log(
        "Chunk sizes:",
        chunks.map((chunk) => chunk.content.length),
      );

      const savedChunks = await this.chunkRepository.createMany(
        document.id,
        chunks,
      );

      for (const chunk of savedChunks) {
        const embedding = await embeddingStrategy.generateEmbedding(
          chunk.content,
        );

        await this.chunkRepository.updateEmbedding(chunk.id, embedding);
      }

      await this.repository.update(document.id, {
        rawText,
        status: "READY",
        processedAt: new Date(),
      });
    } catch (error) {
      console.error("Document processing failed");
      console.error(error);

      await this.repository.update(document.id, {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    }
  }
}
