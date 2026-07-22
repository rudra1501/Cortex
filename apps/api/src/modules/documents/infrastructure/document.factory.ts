import { CreateDocument } from "../application/create-document.js";
import { ListDocuments } from "../application/list-document.js";
import { PrismaDocumentRepository } from "./prisma-document.repository.js";
import { GetDocument } from "../application/get-document.js";
import { UpdateDocument } from "../application/update-document.js";
import { DeleteDocument } from "../application/delete-document.js";

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

export function createGetDocumentUseCase() {
  return new GetDocument(
    new PrismaDocumentRepository(),
  );
}

export function createUpdateDocumentUseCase() {
  return new UpdateDocument(
    new PrismaDocumentRepository(),
  );
}

export function createDeleteDocumentUseCase() {
  return new DeleteDocument(
    new PrismaDocumentRepository(),
  );
}