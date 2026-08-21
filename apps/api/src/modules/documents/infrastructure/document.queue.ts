import { Queue } from "bullmq";
import { redis } from "../../../config/redis.js";

export const documentQueue = new Queue("document-ingestion", {
  connection: redis,
});
