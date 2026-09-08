import { PrismaDocumentRepository } from "../infrastructure/prisma-document.repository.js";
import { DocumentQueueService } from "../infrastructure/document-queue.service.js";
import { PrismaRetrievalConfigRepository } from "../../retrieval-config/infrastructure/prisma-retrieval-config.repository.js";
import { prisma } from "../../../config/database.js";

type ReprocessDocumentInput = {
  id: string;
  userId: string;
};

export class ReprocessDocument {
  constructor(
    private readonly documentRepository: PrismaDocumentRepository,
    private readonly queueService: DocumentQueueService,
    private readonly retrievalConfigRepository: PrismaRetrievalConfigRepository,
  ) { }

  async execute({ id, userId }: ReprocessDocumentInput) {
    const document = await this.documentRepository.findById(id);

    if (!document || document.userId !== userId) {
      throw new Error("Document not found");
    }

    if (!document.storagePath) {
      throw new Error("Document has no stored file and cannot be reprocessed");
    }

    let retrievalConfig =
      await this.retrievalConfigRepository.findByUserId(userId);

    if (!retrievalConfig) {
      retrievalConfig = await this.retrievalConfigRepository.create({ userId });
    }

    await prisma.chunk.deleteMany({
      where: { documentId: id },
    });

    await prisma.document.update({
      where: { id },
      data: {
        status: "PENDING",
        rawText: null,
        processingStartedAt: null,
        processedAt: null,
        errorMessage: null,
        retrievalConfigId: retrievalConfig.id,
      },
    });

    await this.queueService.enqueue(id);

    return { documentId: id, status: "PENDING" };
  }
}
