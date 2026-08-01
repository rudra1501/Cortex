import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { readFile } from "node:fs/promises";

export class DocumentProcessor {
  constructor(private readonly repository: PrismaDocumentRepository) {}

  async process(documentId: string) {
    console.log("Loading document...");

    const document = await this.repository.findById(documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    await this.repository.update(document.id, {
      status: "PROCESSING",
      processingStartedAt: new Date(),
    });

    console.log("Status updated to PROCESSING");

    if (!document.storagePath) {
      throw new Error("Document storage path is missing");
    }
      console.log("Storage path:", document.storagePath);
      console.log("Current working directory:", process.cwd());

      const buffer = await readFile(document.storagePath!);

      console.log("Successfully read file");
      console.log(`File size: ${buffer.length} bytes`);

      await this.repository.update(document.id, {
        status: "READY",
        processedAt: new Date(),
      });

      console.log("Status updated to READY");

    console.log(document);
  }
}
