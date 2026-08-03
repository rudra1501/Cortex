import { Worker } from "bullmq";
import { redis } from "../config/redis.js";
import { DocumentProcessor } from "../processors/document.processor.js";

const processor = new DocumentProcessor();

export const documentWorker = new Worker(
  "document-ingestion",
  async (job) => {
    await processor.process(job.data.documentId);
  },
  {
    connection: redis,
  },
);