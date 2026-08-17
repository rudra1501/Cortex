import { prisma } from "../../../../config/database.js";

import { MessageRole } from "@prisma/client";

export class PrismaChatMessageRepository {
  async create(data: {
    sessionId: string;
    role: MessageRole;
    content: string;
  }) {
    return prisma.chatMessage.create({
      data,
    });
  }

  async findBySessionId(sessionId: string) {
    return prisma.chatMessage.findMany({
      where: {
        sessionId,
      },
      orderBy: {
        createdAt: "asc",
      },
    });
  }
}