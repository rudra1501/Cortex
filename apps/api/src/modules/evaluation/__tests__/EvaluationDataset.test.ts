/**
 * Unit tests for EvaluationDataset.ts
 *
 * Scope: Zod schema validation, rejection of forbidden fields (userId),
 * mandatory textAnchor enforcement, pooling metadata, and serialization.
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/EvaluationDataset.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseEvaluationDataset,
  parseEvaluationDatasetJson,
  serializeEvaluationDataset,
  type EvaluationDataset,
} from "../domain/EvaluationDataset.js";

// ===========================================================================
// Test Data Fixtures
// ===========================================================================

function createValidDataset(): EvaluationDataset {
  return {
    version: "1.0.0",
    description: "Cortex retrieval benchmark sample",
    createdAt: "2026-11-04T12:00:00.000Z",
    queries: [
      {
        id: "q_001",
        question: "What is the timeout for Gemini reranker?",
        expectedAnswer: "12,000ms (12 seconds)",
        category: "configuration",
        poolMetadata: {
          collectedAt: "2026-11-04T10:00:00.000Z",
          expectedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
          completedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
          uniqueCandidatesReviewed: 45,
          relevantLabeled: 3,
        },
        judgments: [
          {
            chunkId: "cuid_001",
            documentId: "doc_001",
            documentTitle: "Reranker Spec",
            chunkIndex: 0,
            relevance: 2,
            textAnchor: "export const RERANK_TIMEOUT_MS = 12_000;",
            notes: "Direct timeout constant",
          },
          {
            chunkId: "cuid_002",
            documentId: "doc_001",
            documentTitle: "Reranker Spec",
            chunkIndex: 1,
            relevance: 1,
            textAnchor: "Cold path latency can exceed 5s",
          },
          {
            chunkId: "cuid_003",
            documentId: "doc_002",
            documentTitle: "Other Document",
            relevance: 0,
            textAnchor: "Unrelated text excerpt",
          },
        ],
      },
    ],
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("ED-1: valid dataset passes Zod validation", () => {
  const valid = createValidDataset();
  const parsed = parseEvaluationDataset(valid);
  assert.equal(parsed.version, "1.0.0");
  assert.equal(parsed.queries.length, 1);
  assert.equal(parsed.queries[0]?.judgments.length, 3);
});

test("ED-2: query containing userId is strictly rejected", () => {
  const datasetWithUserId = createValidDataset();
  // Inject forbidden userId field into query
  (datasetWithUserId.queries[0] as unknown as Record<string, unknown>)["userId"] = "usr_eval_01";

  assert.throws(
    () => parseEvaluationDataset(datasetWithUserId),
    /unrecognized_keys|userId/i,
    "Schema must reject queries with userId",
  );
});

test("ED-3: missing mandatory textAnchor fails validation", () => {
  const datasetMissingAnchor = createValidDataset();
  // Remove textAnchor from judgment
  const judgment = datasetMissingAnchor.queries[0]?.judgments[0] as unknown as Record<string, unknown>;
  delete judgment["textAnchor"];

  assert.throws(
    () => parseEvaluationDataset(datasetMissingAnchor),
    /textAnchor|invalid_type/i,
    "Missing textAnchor must fail validation",
  );

  // Empty string textAnchor must also fail
  judgment["textAnchor"] = "";
  assert.throws(
    () => parseEvaluationDataset(datasetMissingAnchor),
    /textAnchor cannot be empty/i,
    "Empty textAnchor must fail validation",
  );
});

test("ED-4: invalid relevance values (3, -1, 1.5, '2') are rejected", () => {
  const invalidRelevances = [3, -1, 1.5, "2", null, undefined];

  for (const rel of invalidRelevances) {
    const dataset = createValidDataset();
    (dataset.queries[0]?.judgments[0] as unknown as Record<string, unknown>)["relevance"] = rel;

    assert.throws(
      () => parseEvaluationDataset(dataset),
      /relevance|invalid_union|invalid_type/i,
      `Relevance value ${String(rel)} must be rejected`,
    );
  }
});

test("ED-5: empty question or query id is rejected", () => {
  const datasetEmptyQuestion = createValidDataset();
  (datasetEmptyQuestion.queries[0] as unknown as Record<string, unknown>)["question"] = "";

  assert.throws(
    () => parseEvaluationDataset(datasetEmptyQuestion),
    /Question cannot be empty/i,
  );

  const datasetEmptyId = createValidDataset();
  (datasetEmptyId.queries[0] as unknown as Record<string, unknown>)["id"] = "";

  assert.throws(
    () => parseEvaluationDataset(datasetEmptyId),
    /Query id cannot be empty/i,
  );
});

test("ED-6: pool metadata validation distinguishes expected and completed sources", () => {
  const dataset = createValidDataset();
  const query = dataset.queries[0]!;

  // Valid optional expectedPoolingSources
  query.poolMetadata = {
    collectedAt: "2026-11-04T10:00:00.000Z",
    expectedPoolingSources: ["VECTOR", "FTS", "HYBRID"],
    completedPoolingSources: ["VECTOR", "FTS"], // Incomplete!
    uniqueCandidatesReviewed: 30,
    relevantLabeled: 2,
  };

  const parsed = parseEvaluationDataset(dataset);
  assert.deepEqual(parsed.queries[0]?.poolMetadata?.expectedPoolingSources, ["VECTOR", "FTS", "HYBRID"]);
  assert.deepEqual(parsed.queries[0]?.poolMetadata?.completedPoolingSources, ["VECTOR", "FTS"]);

  // Without expectedPoolingSources (optional)
  delete query.poolMetadata.expectedPoolingSources;
  const parsedWithoutExpected = parseEvaluationDataset(dataset);
  assert.equal(parsedWithoutExpected.queries[0]?.poolMetadata?.expectedPoolingSources, undefined);
  assert.deepEqual(parsedWithoutExpected.queries[0]?.poolMetadata?.completedPoolingSources, ["VECTOR", "FTS"]);
});

test("ED-7: conflicting duplicate judgments for the same chunkId are rejected", () => {
  const dataset = createValidDataset();
  // Add two judgments with same documentId and chunkId but conflicting relevance
  dataset.queries[0]!.judgments.push({
    chunkId: "cuid_001", // Duplicate of judgments[0]
    documentId: "doc_001",
    documentTitle: "Reranker Spec",
    relevance: 0, // Conflicting! judgments[0] has relevance 2
    textAnchor: "duplicate chunk entry with conflicting score",
  });

  assert.throws(
    () => parseEvaluationDataset(dataset),
    /Conflicting relevance judgments/i,
    "Conflicting duplicate chunkId judgments must be rejected",
  );
});

test("ED-8: JSON serialization and round-trip parsing preserves all fields", () => {
  const valid = createValidDataset();
  const serialized = serializeEvaluationDataset(valid);
  assert.equal(typeof serialized, "string");

  const roundTripped = parseEvaluationDatasetJson(serialized);
  assert.deepEqual(roundTripped, valid);
});
