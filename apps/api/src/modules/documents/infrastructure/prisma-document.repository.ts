import { prisma } from "../../../config/database.js";

export class PrismaDocumentRepository {
  async create(data: { title: string; description?: string; userId: string }) {
    return prisma.document.create({
      data,
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
}
