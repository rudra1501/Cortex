import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { RetrievalInput, RetrievalStrategy } from "./RetrievalStrategy.js";

/** Reciprocal Rank Fusion constant. Higher values reduce the impact of rank differences. */
const RRF_K = 60;

export class HybridSearch implements RetrievalStrategy {
  constructor(
    private readonly vectorSearch: RetrievalStrategy,
    private readonly fullTextSearch: RetrievalStrategy,
  ) {}

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    console.log("[HYBRID] strategy: RRF");
    console.log("[HYBRID] userId:", input.userId);
    console.log("[HYBRID] limit (topK):", input.limit);
    console.log("[HYBRID] RRF_K:", RRF_K);
    console.log("[HYBRID] similarityThreshold (applied by VectorSearch only):", input.similarityThreshold);

    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorSearch.execute(input),
      this.fullTextSearch.execute(input),
    ]);

    console.log("[HYBRID] vector results count:", vectorResults.length);
    console.log("[HYBRID] FTS results count:", ftsResults.length);

    /** Accumulated RRF scores keyed by chunkId. */
    const rrfScores = new Map<string, number>();
    /** Chunk metadata; first-seen source wins (vector takes priority). */
    const metadata = new Map<string, RetrievedChunk>();

    const accumulate = (list: RetrievedChunk[], label: string): void => {
      list.forEach((chunk, index) => {
        const rank = index + 1; // ranks start at 1
        const score = 1 / (RRF_K + rank);
        const prev = rrfScores.get(chunk.chunkId) ?? 0;
        rrfScores.set(chunk.chunkId, prev + score);
        console.log(
          `[HYBRID] ${label} rank=${rank} chunkId=${chunk.chunkId} +score=${score.toFixed(6)} accumulated=${(prev + score).toFixed(6)}`,
        );
        if (!metadata.has(chunk.chunkId)) {
          metadata.set(chunk.chunkId, chunk);
        }
      });
    };

    accumulate(vectorResults, "VECTOR");
    accumulate(ftsResults, "FTS");

    const sorted = [...rrfScores.entries()].sort(
      ([idA, scoreA], [idB, scoreB]) =>
        // Primary: descending score; secondary: ascending chunkId for determinism.
        scoreB - scoreA || idA.localeCompare(idB),
    );

    console.log("[HYBRID] merged pool (before top-K slice):");
    sorted.forEach(([chunkId, score], i) => {
      const inVector = vectorResults.some((c) => c.chunkId === chunkId);
      const inFts = ftsResults.some((c) => c.chunkId === chunkId);
      const sources = [inVector && "VECTOR", inFts && "FTS"].filter(Boolean).join("+");
      console.log(
        `[HYBRID]   #${i + 1} chunkId=${chunkId} rrfScore=${score.toFixed(6)} sources=[${sources}]`,
      );
    });

    const results = sorted
      .slice(0, input.limit)
      .map(([chunkId, score]) => ({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ...metadata.get(chunkId)!,
        similarity: score, // RRF score replaces raw cosine/ts_rank value
      }));

    console.log("[HYBRID] final output count:", results.length);
    results.forEach((chunk, i) => {
      console.log(
        `[HYBRID]   output #${i + 1} chunkId=${chunk.chunkId} rrfScore=${chunk.similarity.toFixed(6)} doc="${chunk.documentTitle}"`,
      );
    });

    return results;
  }
}
