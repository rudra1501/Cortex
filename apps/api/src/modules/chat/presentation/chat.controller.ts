import type { FastifyReply, FastifyRequest } from "fastify";

import { askQuestionSchema, streamQuestionSchema } from "./chat.schema.js";

import { createGenerateAnswerUseCase } from "../infrastructure/chat.factory.js";
import { GeminiGenerationStrategy } from "../infrastructure/strategies/GeminiGenerationStrategy.js";

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

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const strategy = new GeminiGenerationStrategy();

    for await (const chunk of strategy.generateStream(body.question)) {
      reply.raw.write(`data: ${chunk}\n\n`);
    }

    reply.raw.write("data: [DONE]\n\n");

    reply.raw.end();
  },
};
