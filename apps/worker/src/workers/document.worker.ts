import { Worker } from "bullmq";

import { redis } from "../config/redis.js";
import { DocumentProcessor } from "../processors/document.processor.js";
import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

const repository = new PrismaDocumentRepository();
const processor = new DocumentProcessor(repository);

export const documentWorker = new Worker(
  "document-ingestion",
  async (job) => {
    await processor.process(job.data.documentId);
  },
  {
    connection: redis,
  },
);