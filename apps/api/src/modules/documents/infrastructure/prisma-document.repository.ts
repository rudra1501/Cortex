import { prisma } from "../../../config/database.js";

export class PrismaDocumentRepository {
  async create(input: {
    title: string;
    description?: string;
    userId: string;
    storagePath?: string;
    mimeType: string;
  }) {
    return prisma.document.create({
      data: {
        title: input.title,
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.storagePath !== undefined && {
          storagePath: input.storagePath,
        }),
        mimeType: input.mimeType,
        userId: input.userId,
      },
    });
  }

  async findByUserId(userId: string) {
    return prisma.document.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async findById(id: string) {
    return prisma.document.findUnique({
      where: {
        id,
      },
    });
  }

  async update(
    id: string,
    data: {
      title?: string;
      description?: string;
    },
  ) {
    return prisma.document.update({
      where: {
        id,
      },
      data,
    });
  }

  async delete(id: string) {
    return prisma.document.delete({
      where: {
        id,
      },
    });
  }
}
