import { z } from "zod";

export const updateConfigSchema = z.object({
  chunkSize: z.number().int().min(1).optional(),

  chunkOverlap: z.number().int().min(0).optional(),

  topK: z.number().int().min(1).optional(),

  similarityThreshold: z.number().min(0).max(1).optional(),
});
