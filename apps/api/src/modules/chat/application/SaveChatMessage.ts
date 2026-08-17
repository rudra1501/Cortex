import { MessageRole } from "@prisma/client";

import { PrismaChatMessageRepository } from "../infrastructure/repositories/PrismaChatMessageRepository.js";

type SaveChatMessageInput = {
  sessionId: string;
  role: MessageRole;
  content: string;
};

export class SaveChatMessage {
  constructor(
    private readonly messageRepository: PrismaChatMessageRepository,
  ) {}

  async execute({
    sessionId,
    role,
    content,
  }: SaveChatMessageInput) {
    if (!content.trim()) {
      throw new Error(
        "Message content cannot be empty",
      );
    }

    return this.messageRepository.create({
      sessionId,
      role,
      content,
    });
  }
}