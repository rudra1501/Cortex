/**
 * Unit tests for sample-eval-dataset.json
 *
 * Scope:
 * - SD-1: Conforms strictly to evaluationDatasetSchema
 * - SD-2: All document and chunk IDs are explicitly labelled placeholders
 * - SD-3: No sensitive credentials, tokens, or raw user IDs
 * - SD-4: Negative queries contain explicit relevance: 0 judgments
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/SampleDataset.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { parseEvaluationDatasetJson } from "../domain/EvaluationDataset.js";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.resolve(
  __dirname,
  "../datasets/sample-eval-dataset.json",
);

test("SD-1: Sample dataset strictly conforms to evaluationDatasetSchema", async () => {
  const content = await fs.readFile(DATASET_PATH, "utf-8");
  const dataset = parseEvaluationDatasetJson(content);

  assert.equal(dataset.version, "1.0.0-sample");
  assert.ok(dataset.description.includes("ILLUSTRATIVE SAMPLE BENCHMARK DATASET"));
  assert.equal(dataset.queries.length, 6);
});

test("SD-2: All document and chunk IDs are explicitly labelled placeholders", async () => {
  const content = await fs.readFile(DATASET_PATH, "utf-8");
  const dataset = parseEvaluationDatasetJson(content);

  for (const q of dataset.queries) {
    for (const j of q.judgments) {
      assert.ok(
        j.documentId.startsWith("doc_placeholder_"),
        `documentId "${j.documentId}" must start with doc_placeholder_`,
      );
      if (j.chunkId !== undefined) {
        assert.ok(
          j.chunkId.startsWith("chunk_placeholder_"),
          `chunkId "${j.chunkId}" must start with chunk_placeholder_`,
        );
      }
    }
  }
});

test("SD-3: Sensitive credentials, user tokens, and user IDs are strictly absent", async () => {
  const content = await fs.readFile(DATASET_PATH, "utf-8");

  assert.ok(!content.includes("userId"));
  assert.ok(!content.includes("apiKey"));
  assert.ok(!content.includes("password"));
  assert.ok(!content.includes("Bearer"));
  assert.ok(!content.includes("DATABASE_URL"));
});

test("SD-4: Negative query contains explicit relevance: 0 judgments", async () => {
  const content = await fs.readFile(DATASET_PATH, "utf-8");
  const dataset = parseEvaluationDatasetJson(content);

  const negQuery = dataset.queries.find((q) => q.id === "q_sample_negative_query");
  assert.ok(negQuery);
  assert.ok(negQuery.judgments.length >= 2);

  // Assert every judgment has explicit relevance 0
  for (const j of negQuery.judgments) {
    assert.equal(j.relevance, 0);
  }
});
