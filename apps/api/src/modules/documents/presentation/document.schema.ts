import { z } from "zod";

export const createDocumentSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

export type CreateDocumentBody = z.infer<typeof createDocumentSchema>;