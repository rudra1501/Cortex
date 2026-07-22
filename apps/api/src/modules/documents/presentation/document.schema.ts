import { z } from "zod";

export const createDocumentSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

export const updateDocumentSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined || data.description !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

  
export type UpdateDocumentBody = z.infer<typeof updateDocumentSchema>;
export type CreateDocumentBody = z.infer<typeof createDocumentSchema>;