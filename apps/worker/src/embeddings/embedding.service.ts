import { GoogleGenAI } from "@google/genai";

export class EmbeddingService {
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

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.client.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
    });

    const values = response.embeddings?.[0]?.values;

    if (!values) {
      throw new Error("Embedding generation returned no values");
    }

    return values;
  }
}
