import { z } from "zod";

export const askQuestionSchema = z.object({
  question: z.string().min(1),
  sessionId: z.string(),
});

export const streamQuestionSchema =
  askQuestionSchema;