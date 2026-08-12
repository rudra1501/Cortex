export interface EmbeddingStrategy {
  generateEmbedding(text: string): Promise<number[]>;
}