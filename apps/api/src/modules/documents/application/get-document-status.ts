import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

type GetDocumentStatusInput = {
  id: string;
  userId: string;
};

export class GetDocumentStatus {
  constructor(private readonly documentRepository: PrismaDocumentRepository) {}

  async execute({ id, userId }: GetDocumentStatusInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    return {
      documentId: document.id,
      status: document.status,
    };
  }
}
