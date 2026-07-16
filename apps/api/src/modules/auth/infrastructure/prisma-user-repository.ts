import { prisma } from "../../../config/database.js";

export class PrismaUserRepository {
  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: {
        email,
      },
    });
  }

  async create(email: string, passwordHash: string) {
    return prisma.user.create({
      data: {
        email,
        password: passwordHash,
      },
    });
  }
}