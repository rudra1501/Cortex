import { PrismaRetrievalConfigRepository } from "../infrastructure/prisma-retrieval-config.repository.js";

type CreateConfigInput = {
  userId: string;
};

export class CreateConfig {
  constructor(
    private readonly repository: PrismaRetrievalConfigRepository,
  ) {}

  async execute(userId: string) {
    return this.repository.create({
      userId,
    });
  }
}