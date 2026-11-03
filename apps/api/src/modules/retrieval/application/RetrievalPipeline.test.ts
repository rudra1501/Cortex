/**
 * Unit tests for the rerank pipeline step shared by /ask and /stream.
 *
 * Runner: Node.js built-in test runner. No database, no network.
 *
 * Run:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyReranking,
  resolveRetrievalLimit,
} from "./RetrievalPipeline.ts";
import type { Reranker } from "./Reranker.ts";

type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  similarity: number;
};

const DISABLED = {
  enableReranking: false,
  rerankCandidateK: 20,
  topK: 5,
};

const ENABLED = {
  enableReranking: true,
  rerankCandidateK: 20,
  topK: 5,
};

function chunk(id: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `Document ${id}`,
    chunkIndex: 3,
    content: `Content of ${id}`,
    similarity: 0.8,
    ...overrides,
  };
}

function chunks(count: number): RetrievedChunk[] {
  return Array.from({ length: count }, (_, i) =>
    chunk(`c${i}`, { similarity: 1 - i / 100 }),
  );
}

/** Reranker stub that records calls and reverses the candidate list. */
function reversingReranker(): Reranker & { calls: Array<{ query: string; count: number }> } {
  const calls: Array<{ query: string; count: number }> = [];

  return {
    calls,
    async rerank(query, candidates) {
      calls.push({ query, count: candidates.length });

      return [...candidates].reverse();
    },
  };
}

// ---------------------------------------------------------------------------
// GA-1 / BC-1: reranking disabled → topK candidates, reranker never called
// ---------------------------------------------------------------------------
test("GA-1/BC-1: disabled reranking fetches topK and never calls the reranker", async () => {
  const reranker = reversingReranker();
  const retrieved = chunks(5);

  assert.equal(resolveRetrievalLimit(DISABLED), DISABLED.topK);

  const finalChunks = await applyReranking("q", retrieved, DISABLED, reranker);

  assert.equal(reranker.calls.length, 0);
  assert.equal(finalChunks, retrieved);
});

// ---------------------------------------------------------------------------
// GA-2: reranking enabled → candidateK candidates, reranked, sliced to topK
// ---------------------------------------------------------------------------
test("GA-2: enabled reranking fetches candidateK, reranks, then slices to topK", async () => {
  const reranker = reversingReranker();
  const retrieved = chunks(ENABLED.rerankCandidateK);

  assert.equal(resolveRetrievalLimit(ENABLED), ENABLED.rerankCandidateK);

  const finalChunks = await applyReranking("q", retrieved, ENABLED, reranker);

  assert.equal(reranker.calls.length, 1);
  assert.equal(reranker.calls[0]?.query, "q");
  assert.equal(reranker.calls[0]?.count, 20);

  assert.equal(finalChunks.length, ENABLED.topK);
  assert.deepEqual(
    finalChunks.map((c) => c.chunkId),
    ["c19", "c18", "c17", "c16", "c15"],
  );
});

// ---------------------------------------------------------------------------
// GA-3: reranker throws → original order, sliced to topK, no error
// ---------------------------------------------------------------------------
test("GA-3: a throwing reranker falls back to the original order", async () => {
  const reranker: Reranker = {
    async rerank() {
      throw new Error("reranker exploded");
    },
  };

  const retrieved = chunks(20);

  const finalChunks = await applyReranking("q", retrieved, ENABLED, reranker);

  assert.equal(finalChunks.length, ENABLED.topK);
  assert.deepEqual(
    finalChunks.map((c) => c.chunkId),
    ["c0", "c1", "c2", "c3", "c4"],
  );
  assert.equal(finalChunks[0], retrieved[0]);
});

// ---------------------------------------------------------------------------
// GA-4: reranking enabled without a reranker instance → retrieval order
// ---------------------------------------------------------------------------
test("GA-4: enabled without a reranker falls back to the retrieval order", async () => {
  const retrieved = chunks(20);

  const finalChunks = await applyReranking("q", retrieved, ENABLED);

  assert.equal(finalChunks.length, ENABLED.topK);
  assert.deepEqual(
    finalChunks.map((c) => c.chunkId),
    ["c0", "c1", "c2", "c3", "c4"],
  );
});

// ---------------------------------------------------------------------------
// BC-2 / BC-3 / BC-4: disabled reranking preserves order, metadata, similarity
// ---------------------------------------------------------------------------
test("BC-2: disabled reranking preserves the retrieval order exactly", async () => {
  const retrieved = chunks(5);

  const finalChunks = await applyReranking("q", retrieved, DISABLED);

  assert.deepEqual(
    finalChunks.map((c) => c.chunkId),
    retrieved.map((c) => c.chunkId),
  );
});

test("BC-3: disabled reranking preserves every metadata field", async () => {
  const retrieved = chunks(5);

  const finalChunks = await applyReranking("q", retrieved, DISABLED);

  assert.equal(finalChunks.length, retrieved.length);

  for (const [index, source] of finalChunks.entries()) {
    assert.deepEqual(source, retrieved[index]);
  }
});

test("BC-4: disabled reranking preserves similarity values", async () => {
  const retrieved = chunks(5);

  const finalChunks = await applyReranking("q", retrieved, DISABLED);

  for (const [index, source] of finalChunks.entries()) {
    assert.equal(source.similarity, retrieved[index]?.similarity);
  }
});

// ---------------------------------------------------------------------------
// Candidate widening never reduces the visible result set
// ---------------------------------------------------------------------------
test("reranking still returns topK chunks when retrieval returns fewer than topK", async () => {
  const retrieved = chunks(2);

  const finalChunks = await applyReranking("q", retrieved, ENABLED, reversingReranker());

  assert.deepEqual(
    finalChunks.map((c) => c.chunkId),
    ["c1", "c0"],
  );
});

test("disabled reranking leaves an empty retrieval result untouched", async () => {
  const finalChunks = await applyReranking("q", [], DISABLED, reversingReranker());

  assert.deepEqual(finalChunks, []);
});
