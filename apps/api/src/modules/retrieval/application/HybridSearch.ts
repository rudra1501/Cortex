import type { RetrievedChunk } from "../infrastructure/PgVectorRepository.js";
import type { RetrievalInput, RetrievalStrategy } from "./RetrievalStrategy.js";
import { stageLog, elapsed, isVerboseDebugEnabled } from "../../shared/stageLog.js";

/** Reciprocal Rank Fusion constant. Higher values reduce the impact of rank differences. */
const RRF_K = 60;

export class HybridSearch implements RetrievalStrategy {
  constructor(
    private readonly vectorSearch: RetrievalStrategy,
    private readonly fullTextSearch: RetrievalStrategy,
  ) {}

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    const debug = isVerboseDebugEnabled();

    if (debug) {
      console.log("[HYBRID] strategy: RRF, limit:", input.limit, "threshold:", input.similarityThreshold);
    }

    const tRetrieval0 = performance.now();
    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorSearch.execute(input),
      this.fullTextSearch.execute(input),
    ]);
    const combinedDurationMs = elapsed(tRetrieval0);

    stageLog(input.requestId, "retrieval.combined", {
      durationMs: combinedDurationMs,
      vectorCount: vectorResults.length,
      ftsCount: ftsResults.length,
    });

    const tRrf0 = performance.now();

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
        if (debug) {
          console.log(
            `[HYBRID] ${label} rank=${rank} chunkId=${chunk.chunkId} +score=${score.toFixed(6)} accumulated=${(prev + score).toFixed(6)}`,
          );
        }
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

    if (debug) {
      console.log("[HYBRID] merged pool (before top-K slice):");
      sorted.forEach(([chunkId, score], i) => {
        const inVector = vectorResults.some((c) => c.chunkId === chunkId);
        const inFts = ftsResults.some((c) => c.chunkId === chunkId);
        const sources = [inVector && "VECTOR", inFts && "FTS"].filter(Boolean).join("+");
        console.log(
          `[HYBRID]   #${i + 1} chunkId=${chunkId} rrfScore=${score.toFixed(6)} sources=[${sources}]`,
        );
      });
    }

    const results = sorted
      .slice(0, input.limit)
      .map(([chunkId, score]) => ({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ...metadata.get(chunkId)!,
        similarity: score, // RRF score replaces raw cosine/ts_rank value
      }));

    const rrfDurationMs = elapsed(tRrf0);

    stageLog(input.requestId, "retrieval.rrf", {
      durationMs: rrfDurationMs,
      poolCount: sorted.length,
      outputCount: results.length,
    });

    console.log(
      `[HYBRID] strategy=RRF vectorCount=${vectorResults.length} ftsCount=${ftsResults.length} mergedCount=${results.length}`,
    );

    if (debug) {
      results.forEach((chunk, i) => {
        console.log(
          `[HYBRID]   output #${i + 1} chunkId=${chunk.chunkId} rrfScore=${chunk.similarity.toFixed(6)}`,
        );
      });
    }

    return results;
  }
}
