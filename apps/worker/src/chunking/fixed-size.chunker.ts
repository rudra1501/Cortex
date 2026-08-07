import type { Chunk, Chunker } from "./chunker.js";

export class FixedSizeChunker implements Chunker {
  constructor(
    private readonly chunkSize = 1000,
    private readonly overlap = 200,
  ) {}

  chunk(text: string): Chunk[] {
    const chunks: Chunk[] = [];

    let start = 0;
    let index = 0;

    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);

      const content = text.slice(start, end);

      chunks.push({
        chunkIndex: index++,
        content,
        tokenCount: content.length, // we'll replace with real token counting later
      });

      start += this.chunkSize - this.overlap;
    }

    return chunks;
  }
}