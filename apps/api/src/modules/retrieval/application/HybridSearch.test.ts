/**
 * Unit tests for HybridSearch – Reciprocal Rank Fusion.
 *
 * Runner: Node.js v22+ built-in test runner (node:test + node:assert).
 * No external dependencies required. No database or Prisma at runtime.
 *
 * Run:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal local types — mirror PgVectorRepository.ts / RetrievalStrategy.ts
// so this file has zero external imports that would pull in Prisma/DB.
// ---------------------------------------------------------------------------
type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  similarity: number;
};

type RetrievalInput = {
  query: string;
  queryEmbedding: number[];
  userId: string;
  limit: number;
  similarityThreshold: number;
};

type RetrievalStrategy = {
  execute(input: RetrievalInput): Promise<RetrievedChunk[]>;
};

// ---------------------------------------------------------------------------
// Inline RRF implementation — identical to HybridSearch.ts but written
// without TypeScript-only constructor parameter properties so
// --experimental-strip-types can parse it in strip-only mode.
// ---------------------------------------------------------------------------
const RRF_K = 60;

class HybridSearch {
  vectorSearch: RetrievalStrategy;
  fullTextSearch: RetrievalStrategy;

  constructor(vectorSearch: RetrievalStrategy, fullTextSearch: RetrievalStrategy) {
    this.vectorSearch = vectorSearch;
    this.fullTextSearch = fullTextSearch;
  }

  async execute(input: RetrievalInput): Promise<RetrievedChunk[]> {
    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorSearch.execute(input),
      this.fullTextSearch.execute(input),
    ]);

    const rrfScores = new Map<string, number>();
    const metadata = new Map<string, RetrievedChunk>();

    const accumulate = (list: RetrievedChunk[]): void => {
      list.forEach((chunk, index) => {
        const rank = index + 1;
        const score = 1 / (RRF_K + rank);
        rrfScores.set(chunk.chunkId, (rrfScores.get(chunk.chunkId) ?? 0) + score);
        if (!metadata.has(chunk.chunkId)) {
          metadata.set(chunk.chunkId, chunk);
        }
      });
    };

    accumulate(vectorResults);
    accumulate(ftsResults);

    return [...rrfScores.entries()]
      .sort(([idA, scoreA], [idB, scoreB]) =>
        scoreB - scoreA || idA.localeCompare(idB),
      )
      .slice(0, input.limit)
      .map(([chunkId, score]) => ({
        ...metadata.get(chunkId)!,
        similarity: score,
      }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DUMMY_INPUT: RetrievalInput = {
  query: "test query",
  queryEmbedding: [],
  userId: "user-1",
  limit: 10,
  similarityThreshold: 0.75,
};

function mockStrategy(chunks: RetrievedChunk[]): RetrievalStrategy {
  return { execute: async () => chunks };
}

function chunk(id: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `Document ${id}`,
    chunkIndex: 0,
    content: `Content of ${id}`,
    similarity: 0.9,
    ...overrides,
  };
}

/** Expected RRF score for a chunk at a given 1-based rank. */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

// ---------------------------------------------------------------------------
// TC-1: Overlapping chunk (in both lists) outscores solo chunks
// ---------------------------------------------------------------------------
test("TC-1: chunk in both lists outscores chunk in only one list", async () => {
  // vector=[A(r1), B(r2)]  fts=[B(r1), C(r2)]
  // A=1/61, B=1/62+1/61, C=1/62  =>  B > A > C
  const results = await new HybridSearch(
    mockStrategy([chunk("A"), chunk("B")]),
    mockStrategy([chunk("B"), chunk("C")]),
  ).execute(DUMMY_INPUT);

  assert.equal(results.length, 3);
  assert.equal(results[0]!.chunkId, "B", "B (in both lists) must rank first");
  assert.equal(results[1]!.chunkId, "A");
  assert.equal(results[2]!.chunkId, "C");

  const expectedB = rrfScore(2) + rrfScore(1); // vector=rank2, fts=rank1
  assert.ok(Math.abs(results[0]!.similarity - expectedB) < 1e-12);
});

// ---------------------------------------------------------------------------
// TC-2: Vector-only results (FTS returns empty)
// ---------------------------------------------------------------------------
test("TC-2: vector-only — FTS empty, order follows vector rank", async () => {
  const results = await new HybridSearch(
    mockStrategy([chunk("X"), chunk("Y"), chunk("Z")]),
    mockStrategy([]),
  ).execute(DUMMY_INPUT);

  assert.equal(results.length, 3);
  assert.equal(results[0]!.chunkId, "X");
  assert.equal(results[1]!.chunkId, "Y");
  assert.equal(results[2]!.chunkId, "Z");
  assert.ok(Math.abs(results[0]!.similarity - rrfScore(1)) < 1e-12);
});

// ---------------------------------------------------------------------------
// TC-3: FTS-only results (vector returns empty)
// ---------------------------------------------------------------------------
test("TC-3: FTS-only — vector empty, order follows FTS rank", async () => {
  const results = await new HybridSearch(
    mockStrategy([]),
    mockStrategy([chunk("P"), chunk("Q")]),
  ).execute(DUMMY_INPUT);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.chunkId, "P");
  assert.equal(results[1]!.chunkId, "Q");
});

// ---------------------------------------------------------------------------
// TC-4: Both lists empty
// ---------------------------------------------------------------------------
test("TC-4: both lists empty — returns empty array", async () => {
  const results = await new HybridSearch(
    mockStrategy([]),
    mockStrategy([]),
  ).execute(DUMMY_INPUT);

  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// TC-5: Top-K limit
// ---------------------------------------------------------------------------
test("TC-5: Top-K limit is applied to the merged result", async () => {
  const vec = Array.from({ length: 6 }, (_, i) => chunk(`v${i}`));
  const fts = Array.from({ length: 6 }, (_, i) => chunk(`f${i}`));

  const results = await new HybridSearch(
    mockStrategy(vec),
    mockStrategy(fts),
  ).execute({ ...DUMMY_INPUT, limit: 5 });

  assert.equal(results.length, 5);
});

// ---------------------------------------------------------------------------
// TC-6: Deterministic tie-breaking by chunkId ascending
// ---------------------------------------------------------------------------
test("TC-6: equal scores tie-break alphabetically by chunkId", async () => {
  // beta at vector rank1, alpha at fts rank1 — both score 1/61; alpha < beta
  const hybrid = new HybridSearch(
    mockStrategy([chunk("beta")]),
    mockStrategy([chunk("alpha")]),
  );

  const run1 = await hybrid.execute(DUMMY_INPUT);
  const run2 = await hybrid.execute(DUMMY_INPUT);

  assert.equal(run1[0]!.chunkId, "alpha");
  assert.equal(run1[1]!.chunkId, "beta");
  assert.deepEqual(
    run1.map((c) => c.chunkId),
    run2.map((c) => c.chunkId),
    "must be stable across repeated calls",
  );
});

// ---------------------------------------------------------------------------
// TC-7: similarity field holds RRF score, not raw cosine/ts_rank
// ---------------------------------------------------------------------------
test("TC-7: similarity field is the RRF score, not the original raw value", async () => {
  const results = await new HybridSearch(
    mockStrategy([chunk("solo", { similarity: 0.99 })]),
    mockStrategy([]),
  ).execute(DUMMY_INPUT);

  assert.ok(Math.abs(results[0]!.similarity - rrfScore(1)) < 1e-12);
  assert.notEqual(results[0]!.similarity, 0.99);
});

// ---------------------------------------------------------------------------
// TC-8: Metadata preserved — vector-first wins for shared chunk
// ---------------------------------------------------------------------------
test("TC-8: vector metadata takes priority when chunk appears in both lists", async () => {
  const results = await new HybridSearch(
    mockStrategy([chunk("shared", { documentTitle: "Vector Doc", content: "from vector", chunkIndex: 7 })]),
    mockStrategy([chunk("shared", { documentTitle: "FTS Doc",    content: "from fts",    chunkIndex: 99 })]),
  ).execute(DUMMY_INPUT);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.documentTitle, "Vector Doc");
  assert.equal(results[0]!.content, "from vector");
  assert.equal(results[0]!.chunkIndex, 7);
});

// ---------------------------------------------------------------------------
// TC-9: similarityThreshold is not re-applied inside HybridSearch
// ---------------------------------------------------------------------------
test("TC-9: HybridSearch does not re-filter by similarityThreshold", async () => {
  // Simulate: DB already applied threshold; only this chunk survived.
  const results = await new HybridSearch(
    mockStrategy([chunk("kept", { similarity: 0.5 })]),
    mockStrategy([]),
  ).execute({ ...DUMMY_INPUT, similarityThreshold: 0.999 });

  assert.equal(results.length, 1, "must not re-apply threshold to RRF results");
  assert.equal(results[0]!.chunkId, "kept");
});

// ---------------------------------------------------------------------------
// TC-10: Exact score arithmetic
// ---------------------------------------------------------------------------
test("TC-10: exact RRF score arithmetic and ranking", async () => {
  // vector=[A(r1), C(r2)]   fts=[B(r1), C(r2)]
  // A=1/61, B=1/61, C=1/62+1/62=2/62
  // Order: C(highest), then A and B tied => A < B alphabetically
  const results = await new HybridSearch(
    mockStrategy([chunk("A"), chunk("C")]),
    mockStrategy([chunk("B"), chunk("C")]),
  ).execute(DUMMY_INPUT);

  const byId = new Map(results.map((r) => [r.chunkId, r.similarity]));

  assert.ok(Math.abs(byId.get("A")! - 1 / 61) < 1e-12, "A score");
  assert.ok(Math.abs(byId.get("B")! - 1 / 61) < 1e-12, "B score");
  assert.ok(Math.abs(byId.get("C")! - 2 / 62) < 1e-12, "C score");

  assert.equal(results[0]!.chunkId, "C");
  assert.equal(results[1]!.chunkId, "A");
  assert.equal(results[2]!.chunkId, "B");
});
