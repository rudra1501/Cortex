import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

type GetDocumentInput = {
  id: string;
  userId: string;
};

export class GetDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
  ) {}

  async execute({ id, userId }: GetDocumentInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    return document;
  }
}