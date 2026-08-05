import { FileStorage } from "../infrastructure/file-storage.js";
import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { DocumentQueueService } from "../infrastructure/document-queue.service.js";

type UploadDocumentInput = {
  title: string;
  description?: string;
  userId: string;
  file: {
    filename: string;
    mimetype: string;
    buffer: Buffer;
  };
};

export class UploadDocument {
  constructor(
    private readonly fileStorage: FileStorage,
    private readonly documentRepository: PrismaDocumentRepository,
    private readonly queueService: DocumentQueueService,
  ) {}

  async execute(input: UploadDocumentInput) {
    const storagePath = await this.fileStorage.save(input.file);

    const document = await this.documentRepository.create({
      title: input.title,
      ...(input.description !== undefined && {
        description: input.description,
      }),
      userId: input.userId,
      storagePath,
      mimeType: input.file.mimetype,
    });

    await this.queueService.enqueue(document.id);

    return {
      documentId: document.id,
      status: document.status,
    };
  }
}