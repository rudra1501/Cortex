/**
 * Unit & Integration tests for align-dataset.ts
 *
 * Scope:
 * - AL-1: Argument validation: rejects mutually exclusive --write and --in-place
 * - AL-2: Argument validation: rejects missing --user-id
 * - AL-3: Default is dry-run mode (no files modified)
 * - AL-4: Confirmed pointer verification
 * - AL-5: Stale pointer realignment for unique textAnchor match
 * - AL-6: Ambiguous and unmatched pointers remain unresolved
 * - AL-7: Strict ground-truth invariant: relevance labels are 100% preserved
 * - AL-8: --in-place creates backup first, then writes atomically
 *
 * Run:
 *   npx tsx --test src/modules/evaluation/__tests__/AlignDatasetCli.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EvaluationDataset } from "../domain/EvaluationDataset.js";
import {
  alignDataset,
  runAlignCli,
  validateAlignCliArgs,
  type ChunkProvider,
  type ChunkRecord,
} from "../cli/align-dataset.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDataset(): EvaluationDataset {
  return {
    version: "1.0.0",
    description: "Alignment test dataset",
    createdAt: new Date().toISOString(),
    queries: [
      {
        id: "q1",
        question: "How does similarity thresholding work?",
        judgments: [
          // Judgment 1: Confirmed (chunkId "c_live_1" matches content)
          {
            chunkId: "c_live_1",
            documentId: "doc_100",
            documentTitle: "Doc 100",
            chunkIndex: 0,
            relevance: 2,
            textAnchor: "Unique anchor text for chunk 1",
            notes: "Human note A",
          },
          // Judgment 2: Stale chunkId "c_stale_old" -> should realign to "c_live_2"
          {
            chunkId: "c_stale_old",
            documentId: "doc_100",
            documentTitle: "Doc 100",
            chunkIndex: 99,
            relevance: 1,
            textAnchor: "Unique anchor text for chunk 2",
            notes: "Human note B",
          },
          // Judgment 3: Ambiguous anchor -> matches multiple chunks
          {
            chunkId: "c_ambiguous_orig",
            documentId: "doc_100",
            documentTitle: "Doc 100",
            chunkIndex: 5,
            relevance: 2,
            textAnchor: "Repeated anchor text found in multiple chunks",
          },
          // Judgment 4: Unmatched anchor -> absent from DB
          {
            chunkId: "c_missing_orig",
            documentId: "doc_100",
            documentTitle: "Doc 100",
            chunkIndex: 8,
            relevance: 0,
            textAnchor: "Anchor text that does not exist anywhere",
          },
        ],
      },
    ],
  };
}

function createMockChunkProvider(): ChunkProvider {
  const chunks: ChunkRecord[] = [
    {
      id: "c_live_1",
      documentId: "doc_100",
      chunkIndex: 0,
      content: "This passage contains: Unique anchor text for chunk 1, verified.",
    },
    {
      id: "c_live_2",
      documentId: "doc_100",
      chunkIndex: 1,
      content: "This passage contains: Unique anchor text for chunk 2, newly created after re-chunking.",
    },
    {
      id: "c_ambiguous_A",
      documentId: "doc_100",
      chunkIndex: 2,
      content: "Section A: Repeated anchor text found in multiple chunks.",
    },
    {
      id: "c_ambiguous_B",
      documentId: "doc_100",
      chunkIndex: 3,
      content: "Section B: Repeated anchor text found in multiple chunks.",
    },
  ];

  return {
    async findChunks(documentId: string, userId: string): Promise<readonly ChunkRecord[]> {
      if (userId !== "user_alice") return [];
      return chunks.filter((c) => c.documentId === documentId);
    },
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test("AL-1: Argument validation rejects mutually exclusive --write and --in-place", () => {
  const result = validateAlignCliArgs({
    dataset: "dataset.json",
    "user-id": "u1",
    write: "out.json",
    "in-place": true,
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.errors[0] ?? "", /mutually exclusive/);
  }
});

test("AL-2: Argument validation rejects missing --user-id and missing --dataset", () => {
  const noUser = validateAlignCliArgs({ dataset: "dataset.json" });
  assert.equal(noUser.valid, false);

  const noDataset = validateAlignCliArgs({ "user-id": "u1" });
  assert.equal(noDataset.valid, false);
});

test("AL-3: Default is dry-run mode — no files modified when no save flags provided", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-align-dryrun-"));
  const datasetFile = path.join(tmpDir, "dataset.json");

  const originalDataset = createTestDataset();
  await fs.writeFile(datasetFile, JSON.stringify(originalDataset, null, 2), "utf-8");

  const chunkProvider = createMockChunkProvider();
  const exitCode = await runAlignCli(
    ["--dataset", datasetFile, "--user-id", "user_alice"],
    { chunkProvider },
  );

  assert.equal(exitCode, 0);

  // Assert file content was not modified
  const currentContent = await fs.readFile(datasetFile, "utf-8");
  assert.equal(currentContent, JSON.stringify(originalDataset, null, 2));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("AL-4: Confirmed pointer verification — unchanged when ID and anchor match", async () => {
  const dataset = createTestDataset();
  const provider = createMockChunkProvider();

  const summary = await alignDataset(dataset, provider, "user_alice");

  const j1 = summary.records.find((r) => r.originalChunkId === "c_live_1");
  assert.ok(j1);
  assert.equal(j1.status, "confirmed");
  assert.equal(j1.realignedChunkId, "c_live_1");
});

test("AL-5: Stale pointer realignment — updates chunkId/chunkIndex for unique anchor match", async () => {
  const dataset = createTestDataset();
  const provider = createMockChunkProvider();

  const summary = await alignDataset(dataset, provider, "user_alice");

  const j2 = summary.records.find((r) => r.originalChunkId === "c_stale_old");
  assert.ok(j2);
  assert.equal(j2.status, "realigned");
  assert.equal(j2.realignedChunkId, "c_live_2");
  assert.equal(j2.realignedChunkIndex, 1);

  // Verify in realignedDataset
  const realignedJudgment = summary.realignedDataset.queries[0]?.judgments[1];
  assert.equal(realignedJudgment?.chunkId, "c_live_2");
  assert.equal(realignedJudgment?.chunkIndex, 1);
});

test("AL-6: Ambiguous and unmatched pointers remain unresolved", async () => {
  const dataset = createTestDataset();
  const provider = createMockChunkProvider();

  const summary = await alignDataset(dataset, provider, "user_alice");

  // Ambiguous: multiple matches
  const jAmbiguous = summary.records.find((r) => r.originalChunkId === "c_ambiguous_orig");
  assert.ok(jAmbiguous);
  assert.equal(jAmbiguous.status, "ambiguous");
  assert.equal(jAmbiguous.matchingCount, 2);
  assert.equal(jAmbiguous.realignedChunkId, "c_ambiguous_orig"); // untouched

  // Unmatched: 0 matches
  const jMissing = summary.records.find((r) => r.originalChunkId === "c_missing_orig");
  assert.ok(jMissing);
  assert.equal(jMissing.status, "unmatched");
  assert.equal(jMissing.matchingCount, 0);
  assert.equal(jMissing.realignedChunkId, "c_missing_orig"); // untouched
});

test("AL-7: Strict ground-truth invariant — relevance scores, textAnchors & notes are 100% preserved", async () => {
  const dataset = createTestDataset();
  const provider = createMockChunkProvider();

  const summary = await alignDataset(dataset, provider, "user_alice");

  const origJudgments = dataset.queries[0]?.judgments ?? [];
  const realignedJudgments = summary.realignedDataset.queries[0]?.judgments ?? [];

  assert.equal(origJudgments.length, realignedJudgments.length);

  for (let i = 0; i < origJudgments.length; i++) {
    const orig = origJudgments[i]!;
    const realigned = realignedJudgments[i]!;

    // Relevance must be IDENTICAL
    assert.equal(realigned.relevance, orig.relevance, `relevance of judgment ${i} altered!`);
    // TextAnchor must be IDENTICAL
    assert.equal(realigned.textAnchor, orig.textAnchor, `textAnchor of judgment ${i} altered!`);
    // Notes must be IDENTICAL
    assert.equal(realigned.notes, orig.notes, `notes of judgment ${i} altered!`);
  }
});

test("AL-8: --in-place creates backup first, then writes atomically", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-align-inplace-"));
  const datasetFile = path.join(tmpDir, "eval_dataset.json");

  const originalDataset = createTestDataset();
  await fs.writeFile(datasetFile, JSON.stringify(originalDataset, null, 2), "utf-8");

  const chunkProvider = createMockChunkProvider();
  const exitCode = await runAlignCli(
    ["--dataset", datasetFile, "--user-id", "user_alice", "--in-place"],
    { chunkProvider },
  );

  assert.equal(exitCode, 0);

  // Assert backup file was created
  const files = await fs.readdir(tmpDir);
  const backupFile = files.find((f) => f.startsWith("eval_dataset.json.bak."));
  assert.ok(backupFile, "Backup file was not created!");

  // Verify backup matches original
  const backupContent = await fs.readFile(path.join(tmpDir, backupFile), "utf-8");
  assert.equal(backupContent, JSON.stringify(originalDataset, null, 2));

  // Verify current file is realigned
  const updatedContent = await fs.readFile(datasetFile, "utf-8");
  const parsed = JSON.parse(updatedContent);
  assert.equal(parsed.queries[0].judgments[1].chunkId, "c_live_2");

  await fs.rm(tmpDir, { recursive: true, force: true });
});
