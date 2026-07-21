import { CreateDocument } from "../application/create-document.js";
import { ListDocuments } from "../application/list-document.js";
import { PrismaDocumentRepository } from "./prisma-document.repository.js";

export function createDocumentUseCase() {
  return new CreateDocument(
    new PrismaDocumentRepository(),
  );
}

export function createListDocumentsUseCase() {
  return new ListDocuments(
    new PrismaDocumentRepository(),
  );
}