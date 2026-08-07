export type Chunk = {
  chunkIndex: number;
  content: string;
  tokenCount: number;
};

export interface Chunker {
  chunk(text: string): Chunk[];
}