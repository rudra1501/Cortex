import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { readFile } from "node:fs/promises";

export class DocumentProcessor {
  constructor(private readonly repository: PrismaDocumentRepository) {}

  async process(documentId: string) {
    const document = await this.repository.findById(documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    await this.repository.update(document.id, {
      status: "PROCESSING",
      processingStartedAt: new Date(),
    });

    if (!document.storagePath) {
      throw new Error("Document storage path is missing");
    }
      const buffer = await readFile(document.storagePath!);

      await this.repository.update(document.id, {
        status: "READY",
        processedAt: new Date(),
      });
  }
}
