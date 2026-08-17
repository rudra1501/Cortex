import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";

export class GetChatHistory {
  constructor(
    private readonly messageRepository: PrismaChatMessageRepository,
  ) {}

  async execute(sessionId: string) {
    return this.messageRepository.findBySessionId(
      sessionId,
    );
  }
}