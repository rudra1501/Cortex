import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { askQuestionSchema } from "./chat.schema.js";

import { createGenerateAnswerUseCase } from "../infrastructure/chat.factory.js";

export const chatController = {
  async ask(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    try {
      const body =
        askQuestionSchema.parse(
          request.body,
        );

      const generateAnswer =
        createGenerateAnswerUseCase();

      const response =
        await generateAnswer.execute({
          question: body.question,
          sessionId: body.sessionId,
          userId: request.user.userId,
        });

      return reply.send(response);
    } catch (error) {
      if (error instanceof Error) {
        return reply.status(400).send({
          message: error.message,
        });
      }

      return reply.status(500).send({
        message:
          "Internal Server Error",
      });
    }
  },
};