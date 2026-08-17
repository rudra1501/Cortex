import { prisma } from "../../../../config/database.js";

export class PrismaChatSessionRepository {
  async create(userId: string) {
    return prisma.chatSession.create({
      data: {
        userId,
      },
    });
  }

  async findById(id: string) {
    return prisma.chatSession.findUnique({
      where: {
        id,
      },
    });
  }

  async findByUserId(userId: string) {
    return prisma.chatSession.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  }
}