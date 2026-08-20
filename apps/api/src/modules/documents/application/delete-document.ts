import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { FileStorage } from "../infrastructure/file-storage.js";

type DeleteDocumentInput = {
  id: string;
  userId: string;
};

export class DeleteDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute({ id, userId }: DeleteDocumentInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    if (document.storagePath) {
      await this.fileStorage.delete(document.storagePath);
    }

    await this.documentRepository.delete(id);
  }
}
