import { GoogleGenAI } from "@google/genai";
import type { EmbeddingStrategy } from "./EmbeddingStrategy.js";
import { stageLog, elapsed } from "../../../shared/stageLog.js";

export class GeminiEmbeddingStrategy
  implements EmbeddingStrategy
{
  private readonly client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not configured",
      );
    }

    this.client = new GoogleGenAI({
      apiKey,
    });
  }

  async generateEmbedding(
    text: string,
    requestId?: string,
  ): Promise<number[]> {
    const tApi0 = performance.now();
    const response =
      await this.client.models.embedContent({
        model: "gemini-embedding-001",
        contents: text,
      });
    const apiDurationMs = elapsed(tApi0);

    const tProcess0 = performance.now();
    const values =
      response.embeddings?.[0]?.values;

    if (!values) {
      throw new Error(
        "Embedding generation returned no values",
      );
    }

    if (values.length !== 3072) {
      throw new Error(
        `Invalid embedding dimensions: expected 3072, received ${values.length}`,
      );
    }
    const processingDurationMs = elapsed(tProcess0);

    stageLog(requestId, "embed.gemini", {
      apiDurationMs,
      processingDurationMs,
      totalDurationMs: apiDurationMs + processingDurationMs,
    });

    return values;
  }
}
