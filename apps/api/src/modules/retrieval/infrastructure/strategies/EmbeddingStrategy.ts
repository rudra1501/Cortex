export interface EmbeddingStrategy {
  generateEmbedding(text: string, requestId?: string): Promise<number[]>;
}
