import { UploadDocument } from "../application/upload-document.js";
import { ListDocuments } from "../application/list-document.js";
import { GetDocument } from "../application/get-document.js";
import { UpdateDocument } from "../application/update-document.js";
import { DeleteDocument } from "../application/delete-document.js";
import { ReprocessDocument } from "../application/reprocess-document.js";

import { PrismaDocumentRepository } from "./prisma-document.repository.js";
import { FileStorage } from "./file-storage.js";
import { DocumentQueueService } from "./document-queue.service.js";
import { GetDocumentStatus } from "../application/get-document-status.js";
import { PrismaRetrievalConfigRepository } from "../../retrieval-config/infrastructure/prisma-retrieval-config.repository.js";

export function createUploadDocumentUseCase() {
  return new UploadDocument(
    new FileStorage(),
    new PrismaDocumentRepository(),
    new DocumentQueueService(),
    new PrismaRetrievalConfigRepository(),
  );
}

export function createListDocumentsUseCase() {
  return new ListDocuments(new PrismaDocumentRepository());
}

export function createGetDocumentUseCase() {
  return new GetDocument(new PrismaDocumentRepository());
}
export function createGetDocumentStatusUseCase() {
  return new GetDocumentStatus(new PrismaDocumentRepository());
}

export function createUpdateDocumentUseCase() {
  return new UpdateDocument(new PrismaDocumentRepository());
}

export function createDeleteDocumentUseCase() {
  return new DeleteDocument(new PrismaDocumentRepository(), new FileStorage());
}

export function createReprocessDocumentUseCase() {
  return new ReprocessDocument(
    new PrismaDocumentRepository(),
    new DocumentQueueService(),
    new PrismaRetrievalConfigRepository(),
  );
}
