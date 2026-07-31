import type { FastifyReply, FastifyRequest } from "fastify";

import {
  uploadDocumentSchema,
  updateDocumentSchema,
} from "./document.schema.js";
import {
  createDeleteDocumentUseCase,
  createUploadDocumentUseCase,
  createGetDocumentUseCase,
  createListDocumentsUseCase,
  createUpdateDocumentUseCase,
} from "../infrastructure/document.factory.js";
import type { Multipart } from "@fastify/multipart";

function getFieldValue(field?: Multipart | Multipart[]) {
  if (!field || Array.isArray(field)) {
    return undefined;
  }

  if (field.type === "field") {
    return field.value?.toString();
  }

  return undefined;
}

export const documentController = {
  async upload(request: FastifyRequest, reply: FastifyReply) {
    try {
      const file = await request.file();

      if (!file) {
        return reply.status(400).send({
          message: "File is required",
        });
      }

      if (
        !["application/pdf", "text/markdown", "text/plain"].includes(
          file.mimetype,
        )
      ) {
        return reply.status(415).send({
          message: "Unsupported file type",
        });
      }
      const body = uploadDocumentSchema.parse({
        title: getFieldValue(file.fields.title),
        description: getFieldValue(file.fields.description),
      });

      const buffer = await file.toBuffer();

      const result = await createUploadDocumentUseCase().execute({
        title: body.title,
        ...(body.description !== undefined && {
          description: body.description,
        }),
        userId: request.user.userId,
        file: {
          filename: file.filename,
          mimetype: file.mimetype,
          buffer,
        },
      });

      return reply.status(201).send(result);
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

  async get(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const getDocument = createGetDocumentUseCase();

      const document = await getDocument.execute({
        id,
        userId: request.user.userId,
      });

      return reply.send({
        id: document.id,
        title: document.title,
        description: document.description,
        status: document.status,
        createdAt: document.createdAt,
      });
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
      const body = updateDocumentSchema.parse(request.body);

      const updateDocument = createUpdateDocumentUseCase();

      const document = await updateDocument.execute({
        id,
        userId: request.user.userId,
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
      });

      return reply.send({
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

  async delete(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const deleteDocument = createDeleteDocumentUseCase();

      await deleteDocument.execute({
        id,
        userId: request.user.userId,
      });

      return reply.status(204).send();
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
};
