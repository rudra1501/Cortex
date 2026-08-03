import { readFile } from "node:fs/promises";

import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { getParser } from "../parsers/parser.factory.js";

export class DocumentProcessor {
  private readonly repository =
    new PrismaDocumentRepository();

  async process(documentId: string) {
    const document =
      await this.repository.findById(documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    await this.repository.update(document.id, {
      status: "PROCESSING",
      processingStartedAt: new Date(),
    });

    const buffer = await readFile(document.storagePath!);

    const parser = getParser(document.mimeType);

    const rawText = await parser.parse(buffer);

    await this.repository.update(document.id, {
      rawText,
      status: "READY",
      processedAt: new Date(),
    });
  }
}