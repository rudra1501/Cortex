import type { FastifyReply, FastifyRequest } from "fastify";

import { updateConfigSchema } from "./retrieval-config.schema.js";

import {
  createCreateConfigUseCase,
  createGetConfigUseCase,
  createUpdateConfigUseCase,
} from "../infrastructure/retrieval-config.factory.js";

export const retrievalConfigController = {
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const createConfig = createCreateConfigUseCase();

      const config = await createConfig.execute(request.user.userId);

      return reply.status(201).send(config);
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

  async get(request: FastifyRequest, reply: FastifyReply) {
    try {
      const getConfig = createGetConfigUseCase();

      const config = await getConfig.execute(request.user.userId);

      return reply.send(config);
    } catch (error) {
      if (error instanceof Error) {
        return reply.status(404).send({
          message: error.message,
        });
      }

      return reply.status(500).send({
        message: "Internal Server Error",
      });
    }
  },

  async update(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const body = updateConfigSchema.parse(request.body);

      const updateConfig = createUpdateConfigUseCase();

      const config = await updateConfig.execute({
        id,
        userId: request.user.userId,

        ...(body.chunkSize !== undefined && {
          chunkSize: body.chunkSize,
        }),

        ...(body.chunkOverlap !== undefined && {
          chunkOverlap: body.chunkOverlap,
        }),

        ...(body.topK !== undefined && {
          topK: body.topK,
        }),

        ...(body.similarityThreshold !== undefined && {
          similarityThreshold: body.similarityThreshold,
        }),
      });

      return reply.send(config);
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
};
