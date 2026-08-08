import { readFile } from "node:fs/promises";

import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { getParser } from "../parsers/parser.factory.js";
import { FixedSizeChunker } from "../chunking/fixed-size.chunker.js";
import { PrismaChunkRepository } from "../infrastructure/prisma-chunk.repository.js";
import { EmbeddingService } from "../embeddings/embedding.service.js";

export class DocumentProcessor {
  private readonly repository = new PrismaDocumentRepository();
  private readonly chunkRepository = new PrismaChunkRepository();
  private readonly embeddingService = new EmbeddingService();

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

      const rawText = await parser.parse(buffer);

      const chunker = new FixedSizeChunker();

      const chunks = chunker.chunk(rawText);

      const savedChunks = await this.chunkRepository.createMany(
        document.id,
        chunks,
      );

      console.log("Chunks saved successfully");

      console.log("Generating embeddings...");

      for (const chunk of savedChunks) {
        console.log(`Generating embedding for chunk ${chunk.chunkIndex}...`);

        const embedding = await this.embeddingService.generateEmbedding(
          chunk.content,
        );

        console.log(
          `Embedding generated for chunk ${chunk.chunkIndex}. Dimensions: ${embedding.length}`,
        );

        await this.chunkRepository.updateEmbedding(chunk.id, embedding);

        console.log(`Embedding saved for chunk ${chunk.chunkIndex}`);
      }

      console.log("All embeddings generated and saved");

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
