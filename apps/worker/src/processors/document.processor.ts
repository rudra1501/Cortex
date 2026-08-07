import { readFile } from "node:fs/promises";

import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { getParser } from "../parsers/parser.factory.js";
import { FixedSizeChunker } from "../chunking/fixed-size.chunker.js";
import { PrismaChunkRepository } from "../infrastructure/prisma-chunk.repository.js";

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

      const rawText = await parser.parse(buffer);

      const chunker = new FixedSizeChunker();

      const chunks = chunker.chunk(rawText);

      console.log("Chunking completed");
      console.log("Total chunks:", chunks.length);
      const firstChunk = chunks[0];
      const secondChunk = chunks[1];

      if (firstChunk && secondChunk) {
        const end = firstChunk.content.slice(-200);
        const start = secondChunk.content.slice(0, 200);

        console.log("Overlap matches:", end === start);
      }

      await this.chunkRepository.createMany(document.id, chunks);

      console.log("Chunks saved successfully");

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
