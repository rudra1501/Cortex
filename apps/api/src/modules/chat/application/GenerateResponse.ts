import type { GenerationStrategy } from "../infrastructure/strategies/GenerationStrategy.js";

export class GenerateResponse {
  constructor(
    private readonly strategy: GenerationStrategy,
  ) {}

  async execute(
    prompt: string,
  ): Promise<string> {
    if (!prompt.trim()) {
      throw new Error(
        "Prompt cannot be empty",
      );
    }

    return this.strategy.generate(prompt);
  }
}