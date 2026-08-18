import type { FastifyReply, FastifyRequest } from "fastify";

import { askQuestionSchema, streamQuestionSchema } from "./chat.schema.js";

import {
  createChatSessionRepository,
  createGenerateAnswerUseCase,
  createGenerateStreamingAnswerUseCase,
} from "../infrastructure/chat.factory.js";

export const chatController = {
  async ask(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = askQuestionSchema.parse(request.body);

      const generateAnswer = createGenerateAnswerUseCase();

      const response = await generateAnswer.execute({
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
        message: "Internal Server Error",
      });
    }
  },

  async stream(request: FastifyRequest, reply: FastifyReply) {
    const body = streamQuestionSchema.parse(request.body);

    const sessionRepository = createChatSessionRepository();

    const session = await sessionRepository.findById(body.sessionId);

    if (!session) {
      return reply.status(404).send({
        message: "Chat session not found",
      });
    }

    if (session.userId !== request.user.userId) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const generateStreamingAnswer = createGenerateStreamingAnswerUseCase();

    for await (const chunk of generateStreamingAnswer.execute({
      question: body.question,
      userId: request.user.userId,
      sessionId: body.sessionId,
    })) {
      reply.raw.write(`data: ${chunk}\n\n`);
    }

    reply.raw.end();
  },
};
