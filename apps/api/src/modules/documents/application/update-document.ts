import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";

type UpdateDocumentInput = {
  id: string;
  userId: string;
  title?: string;
  description?: string;
};

export class UpdateDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
  ) {}

  async execute({
    id,
    userId,
    title,
    description,
  }: UpdateDocumentInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    const data = {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
    };

    return this.documentRepository.update(id, data);
  }
}