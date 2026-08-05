import { readFile } from "node:fs/promises";

import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { getParser } from "../parsers/parser.factory.js";

export class DocumentProcessor {
  private readonly repository =
    new PrismaDocumentRepository();

  async process(documentId: string) {
    console.log("========================================");
    console.log("Starting document processing");
    console.log("Document ID:", documentId);

    const document =
      await this.repository.findById(documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    console.log("Loading document...");
    console.log("Document loaded successfully");
    console.log(document);

    try {
      console.log("Updating status to PROCESSING...");

      await this.repository.update(document.id, {
        status: "PROCESSING",
        processingStartedAt: new Date(),
        errorMessage: null,
      });

      console.log("Reading uploaded file...");

      const buffer = await readFile(document.storagePath!);

      console.log(
        `File read successfully (${buffer.length} bytes)`,
      );

      console.log(
        "Selecting parser for:",
        document.mimeType,
      );

      const parser = getParser(document.mimeType);

      console.log("Parsing document...");

      const rawText = await parser.parse(buffer);

      console.log(
        `Parsing complete. Extracted ${rawText.length} characters.`,
      );

      console.log("Raw text preview:");

      console.log(rawText.substring(0, 200));

      console.log(
        "Saving raw text and updating status...",
      );

      await this.repository.update(document.id, {
        rawText,
        status: "READY",
        processedAt: new Date(),
      });

      console.log("Status updated to READY");
      console.log(
        "Document processing completed successfully",
      );
      console.log("========================================");
    } catch (error) {
      console.error("Document processing failed");
      console.error(error);

      await this.repository.update(document.id, {
        status: "FAILED",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Unknown error",
      });

      throw error;
    }
  }
}