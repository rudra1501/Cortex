import type { FastifyReply, FastifyRequest } from "fastify";

import { createDocumentSchema } from "./document.schema.js";
import {
  createDocumentUseCase,
  createListDocumentsUseCase,
} from "../infrastructure/document.factory.js";

export const documentController = {
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = createDocumentSchema.parse(request.body);

      const createDocument = createDocumentUseCase();

      const input = {
        title: body.title,
        userId: request.user.userId,
        ...(body.description !== undefined && {
          description: body.description,
        }),
      };

      const document = await createDocument.execute(input);

      return reply.status(201).send({
        id: document.id,
        title: document.title,
        description: document.description,
        status: document.status,
        createdAt: document.createdAt,
      });
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

  async list(request: FastifyRequest, reply: FastifyReply) {
    try {
      const listDocuments = createListDocumentsUseCase();

      const documents = await listDocuments.execute(request.user.userId);

      return reply.send(
        documents.map((document) => ({
          id: document.id,
          title: document.title,
          description: document.description,
          status: document.status,
          createdAt: document.createdAt,
        })),
      );
    } catch {
      return reply.status(500).send({
        message: "Internal Server Error",
      });
    }
  },
};
