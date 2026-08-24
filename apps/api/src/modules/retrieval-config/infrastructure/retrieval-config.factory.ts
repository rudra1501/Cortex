import { CreateConfig } from "../application/CreateConfig.js";

import { GetConfig } from "../application/GetConfig.js";

import { UpdateConfig } from "../application/UpdateConfig.js";

import { PrismaRetrievalConfigRepository } from "./prisma-retrieval-config.repository.js";

export function createCreateConfigUseCase() {
  return new CreateConfig(
    new PrismaRetrievalConfigRepository(),
  );
}

export function createGetConfigUseCase() {
  return new GetConfig(
    new PrismaRetrievalConfigRepository(),
  );
}

export function createUpdateConfigUseCase() {
  return new UpdateConfig(
    new PrismaRetrievalConfigRepository(),
  );
}