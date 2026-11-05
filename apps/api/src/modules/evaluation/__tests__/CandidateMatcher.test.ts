/**
 * Unit tests for CandidateMatcher.ts
 *
 * Scope: Exact ID matching & precedence, strict documentId isolation,
 * collision/ambiguity handling (no auto-merge), text normalization,
 * preservation of unresolved states vs. explicit zero, and pool matching.
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/CandidateMatcher.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RetrievedChunk } from "../../retrieval/infrastructure/PgVectorRepository.js";
import type { EvaluationJudgment, JudgmentPoolMetadata } from "../domain/EvaluationDataset.js";
import {
  matchCandidate,
  toItemJudgment,
  normalizeText,
  determineIncompletenessFlags,
  matchCandidatePool,
} from "../application/CandidateMatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk_001",
    documentId: "doc_001",
    documentTitle: "Reranker Architecture Spec",
    chunkIndex: 0,
    content: "export const RERANK_TIMEOUT_MS = 12_000; Hard timeout upper bound.",
    similarity: 0.95,
    ...overrides,
  };
}

function createJudgment(overrides: Partial<EvaluationJudgment> = {}): EvaluationJudgment {
  return {
    chunkId: "chunk_001",
    documentId: "doc_001",
    documentTitle: "Reranker Architecture Spec",
    chunkIndex: 0,
    relevance: 2,
    textAnchor: "RERANK_TIMEOUT_MS = 12_000",
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("CM-1: exact chunkId match resolves to confirmed exact_id", () => {
  const chunk = createChunk({ chunkId: "cuid_abc", documentId: "doc_100" });
  const judgments = [createJudgment({ chunkId: "cuid_abc", documentId: "doc_100", relevance: 2 })];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "judged");
  if (result.status === "judged") {
    assert.equal(result.relevance, 2);
    assert.equal(result.matchType, "exact_id");
  }
});

test("CM-2: exact ID match takes precedence over heuristic text anchor", () => {
  const chunk = createChunk({
    chunkId: "cuid_exact",
    documentId: "doc_100",
    content: "Contains anchor text A and anchor text B",
  });

  const judgments: EvaluationJudgment[] = [
    // Exact ID match with relevance 2
    createJudgment({
      chunkId: "cuid_exact",
      documentId: "doc_100",
      relevance: 2,
      textAnchor: "anchor text A",
    }),
    // Another judgment in same doc that also matches content via anchor, but has different chunkId & relevance
    createJudgment({
      chunkId: "cuid_different",
      documentId: "doc_100",
      relevance: 1,
      textAnchor: "anchor text B",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  // Exact ID takes precedence
  assert.equal(result.status, "judged");
  if (result.status === "judged") {
    assert.equal(result.relevance, 2);
    assert.equal(result.matchType, "exact_id");
  }
});

test("CM-3: multiple judgments for the same chunkId resolve to ambiguous", () => {
  const chunk = createChunk({ chunkId: "cuid_duplicate", documentId: "doc_100" });
  const judgments: EvaluationJudgment[] = [
    createJudgment({ chunkId: "cuid_duplicate", documentId: "doc_100", relevance: 2 }),
    createJudgment({ chunkId: "cuid_duplicate", documentId: "doc_100", relevance: 1 }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assert.match(result.reason, /Multiple judgments/);
    assert.equal(result.matchingJudgmentCount, 2);
  }
});

test("CM-4: stale chunkId recovered via textAnchor resolves to text_anchor_provisional", () => {
  // Simulates document re-indexing: retrieved chunk has a new CUID "cuid_new_999"
  const chunk = createChunk({
    chunkId: "cuid_new_999",
    documentId: "doc_100",
    content: "export const RERANK_TIMEOUT_MS = 12_000; after re-chunking.",
  });

  const judgments: EvaluationJudgment[] = [
    createJudgment({
      chunkId: "cuid_stale_111", // Stale ID from prior indexing
      documentId: "doc_100",
      relevance: 2,
      textAnchor: "RERANK_TIMEOUT_MS = 12_000",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "judged");
  if (result.status === "judged") {
    assert.equal(result.relevance, 2);
    assert.equal(result.matchType, "text_anchor_provisional");
  }
});

test("CM-5: document isolation — matching documentTitle with different documentId does NOT match", () => {
  const chunk = createChunk({
    chunkId: "cuid_x",
    documentId: "doc_200", // Different doc!
    documentTitle: "Shared Document Title",
    content: "Unique excerpt that appears in doc_200",
  });

  const judgments: EvaluationJudgment[] = [
    createJudgment({
      chunkId: "cuid_y",
      documentId: "doc_100", // Annotation belongs to doc_100
      documentTitle: "Shared Document Title", // Identical title!
      textAnchor: "Unique excerpt that appears in doc_200",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  // Must NOT match across documents based on title!
  assert.equal(result.status, "unjudged");
});

test("CM-6: multiple anchor collisions with IDENTICAL relevance resolve to ambiguous (no auto-merge)", () => {
  const chunk = createChunk({
    chunkId: "cuid_new",
    documentId: "doc_100",
    content: "The fast brown fox jumps over the lazy dog.",
  });

  const judgments: EvaluationJudgment[] = [
    createJudgment({
      chunkId: "cuid_old_1",
      documentId: "doc_100",
      relevance: 1, // Same relevance!
      textAnchor: "fast brown fox",
    }),
    createJudgment({
      chunkId: "cuid_old_2",
      documentId: "doc_100",
      relevance: 1, // Same relevance!
      textAnchor: "lazy dog",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  // Must NOT auto-merge identical labels
  assert.equal(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assert.match(result.reason, /Multiple distinct anchor judgments/);
    assert.equal(result.matchingJudgmentCount, 2);
  }
});

test("CM-7: multiple anchor collisions with CONFLICTING relevance resolve to ambiguous", () => {
  const chunk = createChunk({
    chunkId: "cuid_new",
    documentId: "doc_100",
    content: "Architecture specification overview and details.",
  });

  const judgments: EvaluationJudgment[] = [
    createJudgment({
      chunkId: "cuid_old_1",
      documentId: "doc_100",
      relevance: 2,
      textAnchor: "specification overview",
    }),
    createJudgment({
      chunkId: "cuid_old_2",
      documentId: "doc_100",
      relevance: 0,
      textAnchor: "overview and details",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assert.equal(result.matchingJudgmentCount, 2);
  }
});

test("CM-8: unseen chunk resolves to status 'unjudged' (never explicit zero)", () => {
  const chunk = createChunk({
    chunkId: "cuid_unseen",
    documentId: "doc_100",
    content: "Completely unannotated text content.",
  });

  const judgments: EvaluationJudgment[] = [
    createJudgment({
      chunkId: "cuid_other",
      documentId: "doc_100",
      textAnchor: "Non-matching anchor",
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "unjudged");
  assert.notEqual(result.status, "judged");
});

test("CM-9: explicit relevance zero resolves to status 'judged' with relevance 0", () => {
  const chunk = createChunk({ chunkId: "cuid_zero", documentId: "doc_100" });
  const judgments = [
    createJudgment({
      chunkId: "cuid_zero",
      documentId: "doc_100",
      relevance: 0, // Human reviewed and declared irrelevant
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "judged");
  if (result.status === "judged") {
    assert.equal(result.relevance, 0);
    assert.equal(result.matchType, "exact_id");
  }
});

test("CM-10: normalizeText handles whitespace, newlines, tabs, and casing variations", () => {
  const dirty = "  Hello \t \r\n World \n\n Test  ";
  assert.equal(normalizeText(dirty), "hello world test");

  const chunk = createChunk({
    chunkId: "cuid_whitespace",
    documentId: "doc_100",
    content: "Line 1\r\n\tLine 2   with   spaces\nLine 3",
  });

  const judgments = [
    createJudgment({
      chunkId: "cuid_different",
      documentId: "doc_100",
      textAnchor: "line 2 with spaces", // Clean anchor matches dirty content
    }),
  ];

  const result = matchCandidate(chunk, judgments);
  assert.equal(result.status, "judged");
  if (result.status === "judged") {
    assert.equal(result.matchType, "text_anchor_provisional");
  }
});

test("CM-11: determineIncompletenessFlags detects missing expected pooling sources", () => {
  const cleanPool = [
    {
      chunkId: "c1",
      documentId: "d1",
      documentTitle: "Doc",
      chunkIndex: 0,
      rrfRank: 1,
      rrfScore: 0.9,
      judgment: { status: "judged" as const, relevance: 2 as const, matchType: "exact_id" as const },
    },
  ];

  // Case 1: Incomplete sources — expected 3, completed 2
  const metadataIncomplete: JudgmentPoolMetadata = {
    collectedAt: "2026-11-04T10:00:00Z",
    expectedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
    completedPoolingSources: ["VECTOR", "FTS"],
    uniqueCandidatesReviewed: 20,
    relevantLabeled: 2,
  };
  const flags1 = determineIncompletenessFlags(cleanPool, metadataIncomplete);
  assert.equal(flags1.incompleteSources, true);
  assert.equal(flags1.unjudgedInEvalPool, false);

  // Case 2: Complete sources — expected matches completed
  const metadataComplete: JudgmentPoolMetadata = {
    collectedAt: "2026-11-04T10:00:00Z",
    expectedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
    completedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
    uniqueCandidatesReviewed: 30,
    relevantLabeled: 3,
  };
  const flags2 = determineIncompletenessFlags(cleanPool, metadataComplete);
  assert.equal(flags2.incompleteSources, false);

  // Case 3: expectedPoolingSources is absent — do NOT infer incompleteness!
  const metadataNoExpected: JudgmentPoolMetadata = {
    collectedAt: "2026-11-04T10:00:00Z",
    completedPoolingSources: ["HYBRID"],
    uniqueCandidatesReviewed: 10,
    relevantLabeled: 1,
  };
  const flags3 = determineIncompletenessFlags(cleanPool, metadataNoExpected);
  assert.equal(flags3.incompleteSources, false);

  // Case 4: No metadata at all — do NOT infer incompleteness
  const flags4 = determineIncompletenessFlags(cleanPool, undefined);
  assert.equal(flags4.incompleteSources, false);
});

test("CM-12: toItemJudgment maps explicit 0 to judged(0) and unresolved states to unjudged", () => {
  // Explicit 0
  assert.deepEqual(
    toItemJudgment({ status: "judged", relevance: 0, matchType: "exact_id" }),
    { status: "judged", relevance: 0 },
  );

  // Explicit 1
  assert.deepEqual(
    toItemJudgment({ status: "judged", relevance: 1, matchType: "exact_id" }),
    { status: "judged", relevance: 1 },
  );

  // Explicit 2
  assert.deepEqual(
    toItemJudgment({ status: "judged", relevance: 2, matchType: "text_anchor_provisional" }),
    { status: "judged", relevance: 2 },
  );

  // Unjudged -> unjudged
  assert.deepEqual(toItemJudgment({ status: "unjudged" }), { status: "unjudged" });

  // Ambiguous -> unjudged
  assert.deepEqual(
    toItemJudgment({ status: "ambiguous", reason: "conflict", matchingJudgmentCount: 2 }),
    { status: "unjudged" },
  );
});

test("CM-13: matchCandidatePool correctly categorizes pool and computes counts", () => {
  const retrievedChunks: RetrievedChunk[] = [
    createChunk({ chunkId: "c1", documentId: "d1", similarity: 0.9 }), // Exact match (rel=2)
    createChunk({ chunkId: "c2", documentId: "d1", similarity: 0.8, content: "text anchor excerpt here" }), // Anchor match (rel=1)
    createChunk({ chunkId: "c3", documentId: "d1", similarity: 0.7, content: "unknown text" }), // Unjudged
  ];

  const judgments: EvaluationJudgment[] = [
    createJudgment({ chunkId: "c1", documentId: "d1", relevance: 2 }),
    createJudgment({ chunkId: "c_other", documentId: "d1", relevance: 1, textAnchor: "text anchor excerpt" }),
  ];

  const result = matchCandidatePool(retrievedChunks, judgments);

  assert.equal(result.candidatePool.length, 3);
  assert.equal(result.candidatePool[0]?.rrfRank, 1);
  assert.equal(result.candidatePool[1]?.rrfRank, 2);
  assert.equal(result.candidatePool[2]?.rrfRank, 3);

  assert.equal(result.judgedCount, 2);
  assert.equal(result.unjudgedCount, 1);
  assert.equal(result.ambiguousCount, 0);
  assert.equal(result.hasUnresolvedCandidates, true);
  assert.equal(result.hasProvisionalMatches, true);

  assert.equal(result.totalRelevantLenient, 2);
  assert.equal(result.totalRelevantStrict, 1);
  assert.deepEqual(result.allJudgmentRelevances, [2, 1]);

  assert.equal(result.incompletenessFlags.unjudgedInEvalPool, true);
  assert.equal(result.incompletenessFlags.pendingReview, true);
});
