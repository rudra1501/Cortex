import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

export class ListDocuments {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
  ) {}

  async execute(userId: string) {
    return this.documentRepository.findByUserId(userId);
  }
}