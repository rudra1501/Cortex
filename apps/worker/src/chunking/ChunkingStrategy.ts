import type { Chunk } from "./chunker.js";

export interface ChunkingStrategy {
  chunk(text: string): Chunk[];
}