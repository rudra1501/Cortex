import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

type CreateDocumentInput = {
  title: string;
  description?: string;
  userId: string;
};

export class CreateDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
  ) {}

  async execute(input: CreateDocumentInput) {
    return this.documentRepository.create(input);
  }
}