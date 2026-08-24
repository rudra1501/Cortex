import { PrismaRetrievalConfigRepository } from "../infrastructure/prisma-retrieval-config.repository.js";

export class GetConfig {
  constructor(
    private readonly repository: PrismaRetrievalConfigRepository,
  ) {}

  async execute(userId: string) {
    const config =
      await this.repository.findByUserId(
        userId,
      );

    if (!config) {
      throw new Error(
        "Configuration not found",
      );
    }

    return config;
  }
}