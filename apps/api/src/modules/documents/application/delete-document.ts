import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

type DeleteDocumentInput = {
  id: string;
  userId: string;
};

export class DeleteDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
  ) {}

  async execute({ id, userId }: DeleteDocumentInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    await this.documentRepository.delete(id);
  }
}