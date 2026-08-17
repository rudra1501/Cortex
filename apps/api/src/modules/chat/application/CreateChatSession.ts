import { PrismaChatSessionRepository } from "../infrastructure/repositories/PrismaChatSessionRepository.js";

export class CreateChatSession {
  constructor(
    private readonly sessionRepository: PrismaChatSessionRepository,
  ) {}

  async execute(userId: string) {
    return this.sessionRepository.create(userId);
  }
}