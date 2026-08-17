import { GoogleGenAI } from "@google/genai";

import type { GenerationStrategy } from "./GenerationStrategy.js";

export class GeminiGenerationStrategy implements GenerationStrategy {
  private readonly client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    this.client = new GoogleGenAI({
      apiKey,
    });
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: prompt,
    });

    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    return text;
  }

  async *generateStream(prompt: string): AsyncGenerator<string> {
    const response = await this.client.models.generateContentStream({
      model: "gemini-3.5-flash-lite",
      contents: prompt,
    });

    for await (const chunk of response) {
      const text = chunk.text;

      if (text) {
        yield text;
      }
    }
  }
}
