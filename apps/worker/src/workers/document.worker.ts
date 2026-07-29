import { Worker } from "bullmq";
import { redis } from "../config/redis.js";

export const documentWorker = new Worker(
  "document-ingestion",
  async (job) => {
    console.log("Received job:");
    console.log(job.name);
    console.log(job.data);
  },
  {
    connection: redis,
  },
);